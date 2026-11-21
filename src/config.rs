use anyhow::{Context, Result};
use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct Settings {
    pub run: RunCfg,
    pub http: HttpCfg,
    pub captcha: CaptchaCfg,
    pub email: EmailCfg,
}

impl Settings {
    pub fn load(path: &Path) -> Result<Self> {
        if !path.exists() {
            tracing::warn!("{} not found, falling back to defaults", path.display());
            return Ok(Self::default());
        }
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("read {}", path.display()))?;
        toml::from_str(&raw).with_context(|| format!("parse {}", path.display()))
    }

    /// Resolve a possibly relative path against the directory holding the config file.
    pub fn resolve(&self, base: &Path, rel: &str) -> PathBuf {
        let p = PathBuf::from(rel);
        if p.is_absolute() {
            p
        } else {
            base.join(p)
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct RunCfg {
    pub recipe: String,
    pub out_dir: String,
    pub concurrency: usize,
    pub delay_ms_min: u64,
    pub delay_ms_max: u64,
    pub max_attempts: u32,
    pub proxies_file: String,
}

impl Default for RunCfg {
    fn default() -> Self {
        Self {
            recipe: "recipes/groq.toml".to_string(),
            out_dir: "out".to_string(),
            concurrency: 4,
            delay_ms_min: 700,
            delay_ms_max: 2400,
            max_attempts: 2,
            proxies_file: "proxies.txt".to_string(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct HttpCfg {
    pub timeout_secs: u64,
    pub accept_language: String,
    /// Optional UA override; empty means the built-in Chrome pool.
    pub user_agents: Vec<String>,
}

impl Default for HttpCfg {
    fn default() -> Self {
        Self {
            timeout_secs: 45,
            accept_language: "en-US,en;q=0.9".to_string(),
            user_agents: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct CaptchaCfg {
    /// capsolver | twocaptcha | command | none
    pub provider: String,
    pub api_key: String,
    /// For provider = "command": external program that prints the token to stdout.
    /// Gets CAPTCHA_KIND / CAPTCHA_SITEKEY / CAPTCHA_PAGE_URL / CAPTCHA_ACTION /
    /// CAPTCHA_VARS (JSON with all recipe variables, incl. session_jwt).
    pub command: String,
    /// Fallback page URL when a step does not set one.
    pub page_url: String,
    /// reCAPTCHA v3 action.
    pub action: String,
    pub poll_interval_secs: u64,
    pub timeout_secs: u64,
}

impl Default for CaptchaCfg {
    fn default() -> Self {
        Self {
            provider: "none".to_string(),
            api_key: String::new(),
            command: "node tools/turnstile.js".to_string(),
            page_url: String::new(),
            action: "verify".to_string(),
            poll_interval_secs: 3,
            timeout_secs: 180,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct EmailCfg {
    /// imap | mailtm | api
    pub provider: String,
    /// Domains used for imap/api providers; also filters mail.tm domains when non-empty.
    pub domains: Vec<String>,
    pub imap: ImapCfg,
    pub mailtm: MailTmCfg,
    pub tempmail_lol: TempmailLolCfg,
    pub api: ApiMailCfg,
}

impl Default for EmailCfg {
    fn default() -> Self {
        Self {
            provider: "mailtm".to_string(),
            domains: Vec::new(),
            imap: ImapCfg::default(),
            mailtm: MailTmCfg::default(),
            tempmail_lol: TempmailLolCfg::default(),
            api: ApiMailCfg::default(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct ImapCfg {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    pub mailbox: String,
}

impl Default for ImapCfg {
    fn default() -> Self {
        Self {
            host: String::new(),
            port: 993,
            user: String::new(),
            password: String::new(),
            mailbox: "INBOX".to_string(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct MailTmCfg {
    /// Optional alternative API base (mail.tm clones share the shape).
    pub base_url: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct TempmailLolCfg {
    /// Optional alternative API base.
    pub base_url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct ApiMailCfg {
    /// GET endpoint, `{email}` is substituted with the recipient address.
    pub list_url: String,
    /// Optional GET endpoint for a single message, `{id}` is substituted.
    pub detail_url: String,
    pub token: String,
    /// Dot path to the array inside the list response; empty means the root.
    pub items_path: String,
    pub id_field: String,
    pub subject_field: String,
    pub body_field: String,
    pub poll_interval_secs: u64,
}

impl Default for ApiMailCfg {
    fn default() -> Self {
        Self {
            list_url: String::new(),
            detail_url: String::new(),
            token: String::new(),
            items_path: String::new(),
            id_field: "id".to_string(),
            subject_field: "subject".to_string(),
            body_field: "text".to_string(),
            poll_interval_secs: 3,
        }
    }
}
