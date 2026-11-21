use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::Path;

#[derive(Debug, Clone, Deserialize)]
pub struct Recipe {
    pub meta: Meta,
    #[serde(default, rename = "step")]
    pub steps: Vec<Step>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Meta {
    pub name: String,
    pub base_url: String,
    #[serde(default)]
    pub default_headers: HashMap<String, String>,
    /// Variable holding the artefact worth keeping (e.g. an API key).
    #[serde(default)]
    pub success_var: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct Step {
    #[serde(rename = "type")]
    pub kind: String,
    pub name: Option<String>,
    pub note: Option<String>,

    // http
    pub method: Option<String>,
    pub path: Option<String>,
    pub headers: HashMap<String, String>,
    pub body: Option<String>,
    pub json: Option<Value>,
    pub expect_status: Option<Vec<u16>>,
    pub extract: HashMap<String, String>,
    pub capture_cookies: bool,

    // captcha
    pub captcha: Option<String>,
    pub captcha_action: Option<String>,
    /// Continue without a token when no captcha provider is configured
    /// (the service may not actually enforce it).
    pub captcha_optional: bool,
    pub sitekey: Option<String>,
    pub page_url: Option<String>,
    pub captcha_var: Option<String>,

    // email
    pub subject_contains: Option<String>,
    pub link_regex: Option<String>,
    pub code_regex: Option<String>,
    pub timeout_secs: Option<u64>,

    // misc
    pub ms: Option<u64>,
    pub save_as: Option<String>,
    /// For type = "command": shell line whose last stdout line becomes `save_as`.
    pub command: Option<String>,
}

impl Step {
    pub fn kind(&self) -> &str {
        if self.kind.trim().is_empty() {
            "http"
        } else {
            self.kind.trim()
        }
    }

    pub fn label(&self, index: usize) -> String {
        self.name
            .clone()
            .unwrap_or_else(|| format!("step{}", index + 1))
    }
}

impl Recipe {
    pub fn load(path: &Path) -> Result<Self> {
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("read recipe {}", path.display()))?;
        let recipe: Recipe = toml::from_str(&raw)
            .with_context(|| format!("parse recipe {}", path.display()))?;
        Ok(recipe)
    }

    pub fn success_var(&self) -> &str {
        self.meta.success_var.as_deref().unwrap_or("api_key")
    }
}

/// Static sanity checks; returns human-readable findings, empty means clean.
pub fn validate(recipe: &Recipe) -> Vec<String> {
    let mut issues = Vec::new();

    if !recipe.meta.base_url.starts_with("http") {
        issues.push(format!(
            "meta.base_url `{}` does not look like an absolute URL",
            recipe.meta.base_url
        ));
    }
    if recipe.steps.is_empty() {
        issues.push("recipe has no [[step]] entries".to_string());
    }

    let mut known: HashSet<String> = [
        "email",
        "password",
        "first_name",
        "last_name",
        "local_part",
        "uuid",
        "ts",
        "proxy",
        "captcha",
        "sitekey",
        "page_url",
        "pkce_verifier",
        "pkce_challenge",
        "stytch_client_header",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();

    if let Some(var) = &recipe.meta.success_var {
        known.insert(var.clone());
    }

    for (idx, step) in recipe.steps.iter().enumerate() {
        let label = step.label(idx);
        match step.kind() {
            "http" => {
                if step.path.is_none() && step.json.is_none() {
                    issues.push(format!("[{label}] http step has no `path`"));
                }
                if let Some(method) = &step.method {
                    let m = method.to_uppercase();
                    if !matches!(
                        m.as_str(),
                        "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"
                    ) {
                        issues.push(format!("[{label}] unsupported method `{method}`"));
                    }
                }
                if step.captcha.is_some() && step.sitekey.is_none() {
                    issues.push(format!(
                        "[{label}] captcha step has no `sitekey` (set it on the step or in vars)"
                    ));
                }
                if let Some(var) = &step.captcha_var {
                    known.insert(var.clone());
                }
                for template in step.headers.values() {
                    check_placeholders(template, &known, &label, &mut issues);
                }
                if let Some(body) = &step.body {
                    check_placeholders(body, &known, &label, &mut issues);
                }
                if let Some(json) = &step.json {
                    collect_json_templates(json, &mut |s| {
                        check_placeholders(s, &known, &label, &mut issues)
                    });
                }
                for (var, rule) in &step.extract {
                    if !rule.contains(':') && !matches!(rule.as_str(), "status" | "url" | "raw") {
                        issues.push(format!(
                            "[{label}] extract `{var}` rule `{rule}` looks malformed (expected `json:$.x` / `regex:…` / `header:…` / `cookie:…`)"
                        ));
                    }
                    known.insert(var.clone());
                }
            }
            "email_wait" => {
                if step.link_regex.is_none() && step.code_regex.is_none() {
                    issues.push(format!(
                        "[{label}] email_wait needs `link_regex` or `code_regex`"
                    ));
                }
                known.insert(step.save_as.clone().unwrap_or_else(|| "verify_link".into()));
            }
            "sleep" => {
                if step.ms.is_none() {
                    issues.push(format!("[{label}] sleep step has no `ms`"));
                }
            }
            "command" => {
                if step.command.as_deref().unwrap_or("").trim().is_empty() {
                    issues.push(format!("[{label}] command step has no `command`"));
                }
                if step.save_as.as_deref().unwrap_or("").trim().is_empty() {
                    issues.push(format!("[{label}] command step has no `save_as`"));
                } else {
                    known.insert(step.save_as.clone().unwrap());
                }
            }
            other => issues.push(format!("[{label}] unknown step type `{other}`")),
        }
        if let Some(path) = &step.path {
            check_placeholders(path, &known, &label, &mut issues);
        }
    }

    issues
}

fn collect_json_templates(value: &Value, f: &mut dyn FnMut(&str)) {
    match value {
        Value::String(s) => f(s),
        Value::Array(items) => {
            for item in items {
                collect_json_templates(item, f);
            }
        }
        Value::Object(map) => {
            for item in map.values() {
                collect_json_templates(item, f);
            }
        }
        _ => {}
    }
}

fn check_placeholders(
    template: &str,
    known: &HashSet<String>,
    label: &str,
    issues: &mut Vec<String>,
) {
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else { break };
        let name = after[..end].trim().to_string();
        if !known.contains(&name) {
            issues.push(format!("[{label}] unresolved placeholder `{{{{{name}}}}}`"));
        }
        rest = &after[end + 2..];
    }
}
