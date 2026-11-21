use anyhow::{anyhow, bail, Context, Result};
use reqwest::Client;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

use crate::config::CaptchaCfg;

pub struct Solver {
    cfg: CaptchaCfg,
    http: Client,
}

impl Solver {
    pub fn new(cfg: &CaptchaCfg) -> Result<Self> {
        let http = Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .context("build solver client")?;
        Ok(Self {
            cfg: cfg.clone(),
            http,
        })
    }

    pub fn enabled(&self) -> bool {
        match self.cfg.provider.as_str() {
            "none" => false,
            "command" => !self.cfg.command.trim().is_empty(),
            _ => !self.cfg.api_key.is_empty(),
        }
    }

    pub fn describe(&self) -> String {
        if !self.enabled() {
            return "disabled".to_string();
        }
        if self.cfg.provider == "command" {
            format!("command ({})", self.cfg.command)
        } else {
            format!("{} (key …{})", self.cfg.provider, tail(&self.cfg.api_key))
        }
    }

    pub async fn solve(
        &self,
        kind: &str,
        sitekey: &str,
        page_url: &str,
        action: Option<&str>,
        vars_json: &str,
    ) -> Result<String> {
        if sitekey.trim().is_empty() {
            bail!("captcha sitekey is empty in the recipe");
        }
        if !self.enabled() {
            bail!(
                "step needs a {kind} token but captcha.provider is `{}` and it is not configured",
                self.cfg.provider
            );
        }
        let action = action.unwrap_or(&self.cfg.action);
        match self.cfg.provider.as_str() {
            "capsolver" => self.capsolver(kind, sitekey, page_url, action).await,
            "twocaptcha" => self.twocaptcha(kind, sitekey, page_url, action).await,
            "command" => {
                self.command(kind, sitekey, page_url, action, vars_json)
                    .await
            }
            other => bail!("unknown captcha provider `{other}`"),
        }
    }

    async fn command(
        &self,
        kind: &str,
        sitekey: &str,
        page_url: &str,
        action: &str,
        vars_json: &str,
    ) -> Result<String> {
        let line = self.cfg.command.trim().to_string();
        if line.is_empty() {
            bail!("captcha.provider = command but captcha.command is empty");
        }
        let timeout = Duration::from_secs(self.cfg.timeout_secs.max(30));
        let kind = kind.to_string();
        let sitekey = sitekey.to_string();
        let page_url = page_url.to_string();
        let action = action.to_string();
        let vars_json = vars_json.to_string();
        tokio::task::spawn_blocking(move || {
            run_captcha_command(&line, &kind, &sitekey, &page_url, &action, &vars_json, timeout)
        })
        .await
        .context("captcha command task panicked")?
    }

    async fn capsolver(
        &self,
        kind: &str,
        sitekey: &str,
        page_url: &str,
        action: &str,
    ) -> Result<String> {
        let mut task = json!({
            "websiteURL": page_url,
            "websiteKey": sitekey,
        });
        let task_type = match kind {
            "turnstile" => "AntiTurnstileTaskProxyLess",
            "recaptcha_v2" => "ReCaptchaV2TaskProxyLess",
            "recaptcha_v3" => "ReCaptchaV3TaskProxyLess",
            "recaptcha_v3_enterprise" => "ReCaptchaV3EnterpriseTaskProxyLess",
            "hcaptcha" => "HCaptchaTaskProxyLess",
            other => bail!("capsolver does not handle captcha kind `{other}`"),
        };
        task["type"] = json!(task_type);
        if kind.starts_with("recaptcha_v3") {
            task["pageAction"] = json!(action);
            task["minScore"] = json!(0.7);
        }

        let created: Value = self
            .http
            .post("https://api.capsolver.com/createTask")
            .json(&json!({ "clientKey": self.cfg.api_key, "task": task }))
            .send()
            .await
            .context("capsolver createTask transport")?
            .json()
            .await
            .context("capsolver createTask body")?;

        if created.get("errorId").and_then(Value::as_i64).unwrap_or(0) != 0 {
            bail!("capsolver createTask: {created}");
        }
        let task_id = created
            .get("taskId")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("capsolver createTask returned no taskId: {created}"))?
            .to_string();

        let deadline = Instant::now() + Duration::from_secs(self.cfg.timeout_secs.max(30));
        loop {
            if Instant::now() >= deadline {
                bail!("capsolver timed out on task {task_id}");
            }
            tokio::time::sleep(Duration::from_secs(self.cfg.poll_interval_secs.max(1))).await;

            let poll: Value = self
                .http
                .post("https://api.capsolver.com/getTaskResult")
                .json(&json!({ "clientKey": self.cfg.api_key, "taskId": task_id }))
                .send()
                .await
                .context("capsolver getTaskResult transport")?
                .json()
                .await
                .context("capsolver getTaskResult body")?;

            match poll.get("status").and_then(Value::as_str).unwrap_or("") {
                "ready" => {
                    let token = poll
                        .get("solution")
                        .and_then(|s| s.get("token").or_else(|| s.get("gRecaptchaResponse")))
                        .and_then(Value::as_str)
                        .ok_or_else(|| anyhow!("capsolver ready without a token: {poll}"))?;
                    return Ok(token.to_string());
                }
                "processing" => continue,
                _ => {
                    let code = poll
                        .get("errorCode")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown");
                    bail!("capsolver error {code}: {poll}");
                }
            }
        }
    }

    async fn twocaptcha(
        &self,
        kind: &str,
        sitekey: &str,
        page_url: &str,
        action: &str,
    ) -> Result<String> {
        let mut form: Vec<(&str, String)> = vec![
            ("key", self.cfg.api_key.clone()),
            ("json", "1".to_string()),
            ("pageurl", page_url.to_string()),
        ];
        match kind {
            "turnstile" => {
                form.push(("method", "turnstile".to_string()));
                form.push(("sitekey", sitekey.to_string()));
            }
            "recaptcha_v2" => {
                form.push(("method", "userrecaptcha".to_string()));
                form.push(("googlekey", sitekey.to_string()));
            }
            "recaptcha_v3" | "recaptcha_v3_enterprise" => {
                form.push(("method", "userrecaptcha".to_string()));
                form.push(("googlekey", sitekey.to_string()));
                form.push(("version", "v3".to_string()));
                form.push(("action", action.to_string()));
                form.push(("min_score", "0.7".to_string()));
                if kind == "recaptcha_v3_enterprise" {
                    form.push(("enterprise", "1".to_string()));
                }
            }
            "hcaptcha" => {
                form.push(("method", "hcaptcha".to_string()));
                form.push(("sitekey", sitekey.to_string()));
            }
            other => bail!("2captcha does not handle captcha kind `{other}`"),
        }

        let created: Value = self
            .http
            .post("https://2captcha.com/in.php")
            .form(&form)
            .send()
            .await
            .context("2captcha in.php transport")?
            .json()
            .await
            .context("2captcha in.php body")?;

        if created.get("status").and_then(Value::as_i64).unwrap_or(0) != 1 {
            bail!("2captcha in.php: {created}");
        }
        let request_id = created
            .get("request")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("2captcha in.php returned no request id: {created}"))?
            .to_string();

        let deadline = Instant::now() + Duration::from_secs(self.cfg.timeout_secs.max(30));
        loop {
            if Instant::now() >= deadline {
                bail!("2captcha timed out on request {request_id}");
            }
            tokio::time::sleep(Duration::from_secs(self.cfg.poll_interval_secs.max(1))).await;

            let poll: Value = self
                .http
                .get("https://2captcha.com/res.php")
                .query(&[
                    ("key", self.cfg.api_key.as_str()),
                    ("action", "get"),
                    ("id", request_id.as_str()),
                    ("json", "1"),
                ])
                .send()
                .await
                .context("2captcha res.php transport")?
                .json()
                .await
                .context("2captcha res.php body")?;

            if poll.get("status").and_then(Value::as_i64).unwrap_or(0) == 1 {
                let token = poll
                    .get("request")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("2captcha ready without token: {poll}"))?;
                return Ok(token.to_string());
            }
            let msg = poll.get("request").and_then(Value::as_str).unwrap_or("");
            if msg == "CAPCHA_NOT_READY" {
                continue;
            }
            bail!("2captcha error: {msg}");
        }
    }
}

fn run_captcha_command(
    line: &str,
    kind: &str,
    sitekey: &str,
    page_url: &str,
    action: &str,
    vars_json: &str,
    timeout: Duration,
) -> Result<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};

    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(line);
        c
    } else {
        let mut c = Command::new("sh");
        c.arg("-c").arg(line);
        c
    };
    cmd.env("CAPTCHA_KIND", kind)
        .env("CAPTCHA_SITEKEY", sitekey)
        .env("CAPTCHA_PAGE_URL", page_url)
        .env("CAPTCHA_ACTION", action)
        .env("CAPTCHA_VARS", vars_json)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());

    let mut child = cmd
        .spawn()
        .with_context(|| format!("spawn captcha command `{line}`"))?;
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait().context("poll captcha command")? {
            let mut out = String::new();
            if let Some(mut stdout) = child.stdout.take() {
                stdout
                    .read_to_string(&mut out)
                    .context("read captcha command stdout")?;
            }
            if !status.success() {
                bail!("captcha command exited with {status}: {line}");
            }
            let token = out
                .lines()
                .rev()
                .map(str::trim)
                .find(|l| !l.is_empty())
                .unwrap_or("")
                .to_string();
            if token.is_empty() {
                bail!("captcha command printed no token: {line}");
            }
            return Ok(token);
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            bail!("captcha command timed out after {:?}: {line}", timeout);
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

fn tail(s: &str) -> String {
    s.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect()
}
