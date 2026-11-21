use anyhow::{anyhow, bail, Context, Result};
use reqwest::cookie::{CookieStore, Jar};
use reqwest::header::{HeaderName, HeaderValue};
use reqwest::{Client, Method};
use serde_json::Value;
use std::collections::HashMap;
use std::fmt;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use crate::captcha::Solver;
use crate::email::{Inbox, MailFilter};
use crate::recipe::{Recipe, Step};
use crate::util::{json_path, regex_capture, render_json, render_tpl, value_to_string};

#[derive(Debug)]
pub struct StepFailure {
    pub msg: String,
    pub retryable: bool,
}

impl StepFailure {
    pub fn fatal(msg: impl Into<String>) -> Self {
        Self {
            msg: msg.into(),
            retryable: false,
        }
    }

    pub fn retry(msg: impl Into<String>) -> Self {
        Self {
            msg: msg.into(),
            retryable: true,
        }
    }
}

impl fmt::Display for StepFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.msg)
    }
}

impl std::error::Error for StepFailure {}

pub struct FlowCtx {
    pub vars: HashMap<String, String>,
    pub base_url: String,
    pub default_headers: HashMap<String, String>,
    pub client: Client,
    pub jar: Arc<Jar>,
    pub dry_run: bool,
    pub last_status: u16,
    pub last_body: String,
}

impl FlowCtx {
    pub fn new(
        base_url: String,
        default_headers: HashMap<String, String>,
        client: Client,
        jar: Arc<Jar>,
        vars: HashMap<String, String>,
        dry_run: bool,
    ) -> Self {
        Self {
            vars,
            base_url,
            default_headers,
            client,
            jar,
            dry_run,
            last_status: 0,
            last_body: String::new(),
        }
    }

    pub fn origin(&self) -> String {
        url::Url::parse(&self.base_url)
            .ok()
            .map(|u| format!("{}://{}", u.scheme(), u.host_str().unwrap_or_default()))
            .unwrap_or_default()
    }

    pub fn render(&self, template: &str) -> String {
        render_tpl(template, &self.vars)
    }
}

pub async fn execute(
    recipe: &Recipe,
    ctx: &mut FlowCtx,
    inbox: Option<&mut Inbox>,
    solver: &Solver,
) -> Result<()> {
    let mut inbox = inbox;
    for (idx, step) in recipe.steps.iter().enumerate() {
        let label = step.label(idx);
        if let Some(note) = &step.note {
            tracing::debug!("[{label}] {note}");
        }
        match step.kind() {
            "http" => http_step(step, &label, ctx, solver).await?,
            "email_wait" => email_step(step, &label, ctx, &mut inbox).await?,
            "sleep" => {
                let ms = step.ms.unwrap_or(500);
                tracing::debug!("[{label}] sleep {ms}ms");
                tokio::time::sleep(Duration::from_millis(ms)).await;
            }
            "command" => command_step(step, &label, ctx).await?,
            other => bail!("[{label}] unknown step type `{other}`"),
        }
    }
    Ok(())
}

async fn command_step(step: &Step, label: &str, ctx: &mut FlowCtx) -> Result<()> {
    let line = step
        .command
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| anyhow!("[{label}] command step has no `command`"))?;
    let save = step
        .save_as
        .clone()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| anyhow!("[{label}] command step has no `save_as`"))?;

    tracing::info!("[{label}] command: {line}");
    if ctx.dry_run {
        tracing::warn!("[{label}] dry-run: command not executed, substituting a placeholder");
        ctx.vars.insert(save, "DRY_RUN_VALUE".to_string());
        return Ok(());
    }

    let vars_json = serde_json::to_string(&ctx.vars).unwrap_or_else(|_| "{}".to_string());
    let mut cmd = if cfg!(windows) {
        let mut c = tokio::process::Command::new("cmd");
        c.arg("/C").arg(line);
        c
    } else {
        let mut c = tokio::process::Command::new("sh");
        c.arg("-c").arg(line);
        c
    };
    cmd.env("STEP_NAME", label)
        .env("STEP_VARS", vars_json)
        .stdin(std::process::Stdio::null());

    let wait = Duration::from_secs(step.timeout_secs.unwrap_or(120));
    let output = tokio::time::timeout(wait, cmd.output())
        .await
        .map_err(|_| anyhow!("[{label}] command timed out after {wait:?}: {line}"))?
        .with_context(|| format!("[{label}] spawn command `{line}`"))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        bail!(
            "[{label}] command exited with {}: {}",
            output.status,
            truncate(err.trim(), 400)
        );
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let value = stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .to_string();
    if value.is_empty() {
        bail!("[{label}] command printed nothing: {line}");
    }
    tracing::debug!("[{label}] {save} = {}", truncate(&value, 60));
    ctx.vars.insert(save, value);
    Ok(())
}

async fn http_step(step: &Step, label: &str, ctx: &mut FlowCtx, solver: &Solver) -> Result<()> {
    if let Some(kind) = &step.captcha {
        let sitekey = step
            .sitekey
            .clone()
            .or_else(|| ctx.vars.get("sitekey").cloned())
            .unwrap_or_default();
        let page = step
            .page_url
            .clone()
            .or_else(|| ctx.vars.get("page_url").cloned())
            .unwrap_or_else(|| ctx.base_url.clone());
        tracing::info!("[{label}] solving {kind} for {page}");
        let var = step
            .captcha_var
            .clone()
            .unwrap_or_else(|| "captcha".to_string());
        if ctx.dry_run {
            tracing::warn!("[{label}] dry-run: captcha not solved, substituting a placeholder token");
            ctx.vars.insert(var, "DRY_RUN_TOKEN".to_string());
        } else if !solver.enabled() && step.captcha_optional {
            tracing::warn!(
                "[{label}] captcha provider is off and the step is optional: trying without a token"
            );
            ctx.vars.insert(var, String::new());
        } else {
            let token = solver
                .solve(
                    kind,
                    &sitekey,
                    &page,
                    step.captcha_action.as_deref(),
                    &serde_json::to_string(&ctx.vars).unwrap_or_else(|_| "{}".to_string()),
                )
                .await
                .map_err(|e| StepFailure::fatal(format!("[{label}] captcha: {e:#}")))?;
            ctx.vars.insert(var, token);
        }
    }

    let method_str = step.method.as_deref().unwrap_or("GET").to_uppercase();
    let method = Method::from_str(&method_str)
        .map_err(|_| anyhow!("[{label}] unsupported method `{method_str}`"))?;

    let path = ctx.render(step.path.as_deref().unwrap_or("/"));
    let url = if path.starts_with("http://") || path.starts_with("https://") {
        path.clone()
    } else if path.starts_with('/') {
        format!("{}{}", ctx.base_url.trim_end_matches('/'), path)
    } else {
        format!("{}/{}", ctx.base_url.trim_end_matches('/'), path)
    };

    let mut headers: HashMap<String, String> = ctx
        .default_headers
        .iter()
        .map(|(name, value)| (name.to_ascii_lowercase(), value.clone()))
        .collect();
    for (name, value) in &step.headers {
        headers.insert(name.to_ascii_lowercase(), ctx.render(value));
    }
    let origin = ctx.origin();
    headers.entry("origin".to_string()).or_insert(origin);
    headers
        .entry("referer".to_string())
        .or_insert_with(|| ctx.base_url.clone());

    let body = if let Some(json) = &step.json {
        let rendered = render_json(json, &ctx.vars);
        Some(
            serde_json::to_string(&rendered)
                .map_err(|e| anyhow!("[{label}] serialize json body: {e}"))?,
        )
    } else {
        step.body.as_ref().map(|raw| ctx.render(raw))
    };
    if body.is_some() && !headers.contains_key("content-type") {
        headers.insert("content-type".to_string(), "application/json".to_string());
    }

    if ctx.dry_run {
        tracing::info!("[{label}] DRY-RUN {method_str} {url}");
        for (name, value) in &headers {
            tracing::info!("[{label}]   {name}: {}", truncate(value, 200));
        }
        if let Some(b) = &body {
            tracing::info!("[{label}]   body: {}", truncate(b, 400));
        }
        ctx.last_status = 0;
        ctx.last_body.clear();
        return Ok(());
    }

    let mut request = ctx.client.request(method, url.as_str());
    for (name, value) in &headers {
        let header_name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| anyhow!("[{label}] invalid header name `{name}`"))?;
        let header_value = HeaderValue::from_bytes(value.as_bytes())
            .map_err(|_| anyhow!("[{label}] invalid header value for `{name}`"))?;
        request = request.header(header_name, header_value);
    }
    if let Some(b) = body {
        request = request.body(b);
    }

    let response = request
        .send()
        .await
        .map_err(|e| StepFailure::retry(format!("[{label}] transport error: {e}")))?;

    let status = response.status();
    let code = status.as_u16();
    let mut response_headers: HashMap<String, String> = HashMap::new();
    for (name, value) in response.headers().iter() {
        response_headers.insert(
            name.as_str().to_ascii_lowercase(),
            value.to_str().unwrap_or_default().to_string(),
        );
    }
    let text = response.text().await.unwrap_or_default();

    ctx.last_status = code;
    ctx.last_body = text.clone();
    tracing::info!(
        "[{label}] {method_str} {url} -> {code} ({} bytes)",
        text.len()
    );
    tracing::debug!("[{label}] response: {}", truncate(&text, 900));

    let accepted = match &step.expect_status {
        Some(list) => list.contains(&code),
        None => status.is_success(),
    };
    if !accepted {
        let retryable = code == 429 || code >= 500;
        let msg = format!(
            "[{label}] unexpected status {code}: {}",
            truncate(&text, 400)
        );
        return Err(if retryable {
            anyhow::Error::new(StepFailure::retry(msg))
        } else {
            anyhow::Error::new(StepFailure::fatal(msg))
        });
    }

    for (var, rule) in &step.extract {
        let value = apply_rule(rule, code, &text, &response_headers, &ctx.jar, &url)
            .ok_or_else(|| {
                StepFailure::fatal(format!("[{label}] extract `{var}` with `{rule}` produced nothing"))
            })?;
        tracing::debug!("[{label}] {var} = {}", truncate(&value, 60));
        ctx.vars.insert(var.clone(), value);
    }

    if step.capture_cookies {
        if let Ok(parsed) = url::Url::parse(&url) {
            if let Some(header) = ctx.jar.cookies(&parsed) {
                if let Ok(raw) = header.to_str() {
                    for pair in raw.split(';') {
                        if let Some((name, value)) = pair.trim().split_once('=') {
                            ctx.vars
                                .insert(format!("cookie_{}", name.trim()), value.trim().to_string());
                        }
                    }
                }
            }
        }
    }

    ctx.vars.insert("last_status".to_string(), code.to_string());
    Ok(())
}

async fn email_step(
    step: &Step,
    label: &str,
    ctx: &mut FlowCtx,
    inbox: &mut Option<&mut Inbox>,
) -> Result<()> {
    let Some(inbox) = inbox.as_deref_mut() else {
        tracing::info!("[{label}] DRY-RUN email_wait (no mailbox attached)");
        return Ok(());
    };

    if ctx.dry_run {
        tracing::info!("[{label}] DRY-RUN email_wait (skipped)");
        return Ok(());
    }

    let filter = MailFilter {
        subject_contains: step.subject_contains.clone(),
        link_regex: step.link_regex.clone(),
        code_regex: step.code_regex.clone(),
    };
    let timeout = Duration::from_secs(step.timeout_secs.unwrap_or(120));

    tracing::info!(
        "[{label}] waiting up to {}s for mail at {}",
        timeout.as_secs(),
        inbox.address
    );
    let hit = inbox
        .wait_for(&filter, timeout)
        .await
        .map_err(|e| StepFailure::retry(format!("[{label}] {e:#}")))?;

    let value = hit
        .link
        .clone()
        .or_else(|| hit.code.clone())
        .ok_or_else(|| {
            StepFailure::fatal(format!(
                "[{label}] mail `{}` contained no link or code matching the filters",
                hit.subject
            ))
        })?;

    let var = step
        .save_as
        .clone()
        .unwrap_or_else(|| "verify_link".to_string());
    tracing::info!(
        "[{label}] mail `{}` -> {var} = {}",
        hit.subject,
        truncate(&value, 100)
    );
    ctx.vars.insert(var, value);
    Ok(())
}

fn apply_rule(
    rule: &str,
    status: u16,
    body: &str,
    headers: &HashMap<String, String>,
    jar: &Arc<Jar>,
    url: &str,
) -> Option<String> {
    let (kind, arg) = match rule.split_once(':') {
        Some((k, a)) => (k.trim(), a.trim()),
        None => (rule.trim(), ""),
    };

    match kind {
        "json" => {
            let parsed: Value = serde_json::from_str(body).ok()?;
            json_path(&parsed, arg).and_then(value_to_string)
        }
        "regex" => regex_capture(arg, body),
        "header" => headers.get(&arg.to_ascii_lowercase()).cloned(),
        "cookie" => {
            let parsed = url::Url::parse(url).ok()?;
            let header = jar.cookies(&parsed)?;
            let raw = header.to_str().ok()?;
            raw.split(';')
                .filter_map(|pair| pair.trim().split_once('='))
                .find(|(name, _)| name.trim() == arg)
                .map(|(_, value)| value.trim().to_string())
        }
        "status" => Some(status.to_string()),
        "url" => Some(url.to_string()),
        "raw" => Some(body.to_string()),
        _ => None,
    }
}

pub fn truncate(input: &str, limit: usize) -> String {
    if input.chars().count() <= limit {
        return input.to_string();
    }
    let cut: String = input.chars().take(limit).collect();
    format!("{cut}…")
}
