use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use regex::Regex;
use reqwest::Client;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::time::{Duration, Instant};

use crate::config::{ApiMailCfg, EmailCfg, ImapCfg};
use crate::identity::Identity;
use crate::util::{json_path, regex_capture, value_to_string};

#[derive(Debug, Clone, Default)]
pub struct MailFilter {
    pub subject_contains: Option<String>,
    pub link_regex: Option<String>,
    pub code_regex: Option<String>,
}

impl MailFilter {
    pub fn is_empty(&self) -> bool {
        self.subject_contains.is_none() && self.link_regex.is_none() && self.code_regex.is_none()
    }
}

#[derive(Debug, Clone)]
pub struct MailHit {
    pub subject: String,
    pub link: Option<String>,
    pub code: Option<String>,
}

struct Candidate {
    id: String,
    subject: String,
    body: String,
}

pub struct Mailer {
    kind: MailerKind,
    domains: Vec<String>,
    provider: String,
}

enum MailerKind {
    Imap(ImapCfg),
    MailTm { base: String, http: Client },
    TempmailLol { base: String, http: Client },
    Api { cfg: ApiMailCfg, http: Client },
}

impl Mailer {
    pub fn from_cfg(cfg: &EmailCfg) -> Result<Self> {
        let http = Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .context("build mail client")?;

        let kind = match cfg.provider.as_str() {
            "imap" => {
                if cfg.imap.host.is_empty() {
                    bail!("email.provider = imap but email.imap.host is empty");
                }
                if cfg.imap.user.is_empty() {
                    bail!("email.provider = imap but email.imap.user is empty");
                }
                MailerKind::Imap(cfg.imap.clone())
            }
            "mailtm" => {
                let base = if cfg.mailtm.base_url.trim().is_empty() {
                    "https://api.mail.tm".to_string()
                } else {
                    cfg.mailtm.base_url.trim_end_matches('/').to_string()
                };
                MailerKind::MailTm { base, http }
            }
            "tempmail_lol" => {
                let base = if cfg.tempmail_lol.base_url.trim().is_empty() {
                    "https://api.tempmail.lol".to_string()
                } else {
                    cfg.tempmail_lol.base_url.trim_end_matches('/').to_string()
                };
                MailerKind::TempmailLol { base, http }
            }
            "api" => {
                if cfg.api.list_url.trim().is_empty() {
                    bail!("email.provider = api but email.api.list_url is empty");
                }
                MailerKind::Api {
                    cfg: cfg.api.clone(),
                    http,
                }
            }
            other => bail!("unknown email provider `{other}` (imap | mailtm | tempmail_lol | api)"),
        };

        Ok(Self {
            kind,
            domains: cfg.domains.clone(),
            provider: cfg.provider.clone(),
        })
    }

    pub fn describe(&self) -> String {
        match &self.kind {
            MailerKind::Imap(c) => format!("imap {}:{} as {}", c.host, c.port, c.user),
            MailerKind::MailTm { base, .. } => format!("mail.tm ({base})"),
            MailerKind::TempmailLol { base, .. } => format!("tempmail.lol ({base})"),
            MailerKind::Api { cfg, .. } => format!("api ({})", cfg.list_url),
        }
    }

    pub async fn pick_domain(&self) -> Result<String> {
        match &self.kind {
            MailerKind::Imap(_) | MailerKind::Api { .. } => {
                if self.domains.is_empty() {
                    bail!(
                        "email.domains is empty; provider `{}` needs at least one domain",
                        self.provider
                    );
                }
                crate::util::pick_one(&self.domains)
                    .ok_or_else(|| anyhow!("no domain available"))
            }
            MailerKind::MailTm { base, http } => {
                let domains = fetch_mailtm_domains(base, http).await?;
                let usable: Vec<String> = if self.domains.is_empty() {
                    domains
                } else {
                    domains
                        .into_iter()
                        .filter(|d| self.domains.iter().any(|w| w.eq_ignore_ascii_case(d)))
                        .collect()
                };
                crate::util::pick_one(&usable)
                    .ok_or_else(|| anyhow!("mail.tm returned no usable domain"))
            }
            // The service assigns its own address on /generate; the placeholder
            // is replaced by the real one when the mailbox is opened.
            MailerKind::TempmailLol { .. } => Ok("tempmail.lol".to_string()),
        }
    }

    pub async fn list_domains(&self) -> Result<Vec<String>> {
        match &self.kind {
            MailerKind::Imap(_) | MailerKind::Api { .. } => Ok(self.domains.clone()),
            MailerKind::MailTm { base, http } => fetch_mailtm_domains(base, http).await,
            MailerKind::TempmailLol { .. } => Ok(vec!["tempmail.lol".to_string()]),
        }
    }

    pub async fn open(&self, ident: &Identity) -> Result<Inbox> {
        match &self.kind {
            MailerKind::Imap(cfg) => {
                let cfg = cfg.clone();
                let address = ident.email.clone();
                let probe = cfg.clone();
                let probe_target = address.clone();
                // Mark everything already in the mailbox as seen before the flow starts.
                let seen = match tokio::task::spawn_blocking(move || {
                    imap_uid_list(&probe, &probe_target)
                })
                .await
                {
                    Ok(Ok(uids)) => uids.into_iter().collect::<HashSet<String>>(),
                    Ok(Err(e)) => {
                        tracing::warn!("imap pre-scan failed: {e:#}");
                        HashSet::new()
                    }
                    Err(e) => {
                        tracing::warn!("imap pre-scan join failed: {e}");
                        HashSet::new()
                    }
                };

                Ok(Inbox {
                    address,
                    kind: InboxKind::Imap { cfg, seen },
                })
            }
            MailerKind::MailTm { base, http } => {
                let token = mailtm_login_or_create(base, http, ident).await?;
                Ok(Inbox {
                    address: ident.email.clone(),
                    kind: InboxKind::MailTm {
                        base: base.clone(),
                        http: http.clone(),
                        token,
                        seen: HashSet::new(),
                    },
                })
            }
            MailerKind::TempmailLol { base, http } => {
                let (address, token) = tempmail_lol_generate(base, http).await?;
                Ok(Inbox {
                    address,
                    kind: InboxKind::TempmailLol {
                        base: base.clone(),
                        http: http.clone(),
                        token,
                        seen: HashSet::new(),
                    },
                })
            }
            MailerKind::Api { cfg, http } => Ok(Inbox {
                address: ident.email.clone(),
                kind: InboxKind::Api {
                    cfg: cfg.clone(),
                    http: http.clone(),
                    seen: HashSet::new(),
                },
            }),
        }
    }
}

pub struct Inbox {
    pub address: String,
    kind: InboxKind,
}

enum InboxKind {
    Imap {
        cfg: ImapCfg,
        seen: HashSet<String>,
    },
    MailTm {
        base: String,
        http: Client,
        token: String,
        seen: HashSet<String>,
    },
    TempmailLol {
        base: String,
        http: Client,
        token: String,
        seen: HashSet<String>,
    },
    Api {
        cfg: ApiMailCfg,
        http: Client,
        seen: HashSet<String>,
    },
}

impl Inbox {
    pub async fn wait_for(&mut self, filter: &MailFilter, timeout: Duration) -> Result<MailHit> {
        if filter.is_empty() {
            bail!("email_wait step has no subject_contains/link_regex/code_regex");
        }
        let deadline = Instant::now() + timeout;
        let mut last_err: Option<String> = None;

        loop {
            match self.poll().await {
                Ok(candidates) => {
                    for cand in &candidates {
                        if let Some(hit) = match_candidate(filter, cand) {
                            return Ok(hit);
                        }
                    }
                }
                Err(e) => {
                    tracing::debug!("mail poll failed: {e:#}");
                    last_err = Some(format!("{e:#}"));
                }
            }

            if Instant::now() >= deadline {
                return match last_err {
                    Some(err) => Err(anyhow!(
                        "no matching mail for {} within {}s (last error: {err})",
                        self.address,
                        timeout.as_secs()
                    )),
                    None => Err(anyhow!(
                        "no matching mail for {} within {}s",
                        self.address,
                        timeout.as_secs()
                    )),
                };
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    }

    async fn poll(&mut self) -> Result<Vec<Candidate>> {
        match &mut self.kind {
            InboxKind::Imap { cfg, seen } => {
                let cfg = cfg.clone();
                let address = self.address.clone();
                let exclude: HashSet<String> = seen.clone();
                let result = tokio::task::spawn_blocking(move || {
                    imap_fetch_blocking(&cfg, &address, &exclude)
                })
                .await
                .context("imap task join")??;

                let fresh: Vec<Candidate> = result
                    .into_iter()
                    .filter(|c| !seen.contains(&c.id))
                    .collect();
                for c in &fresh {
                    seen.insert(c.id.clone());
                }
                Ok(fresh)
            }
            InboxKind::MailTm {
                base,
                http,
                token,
                seen,
            } => {
                let list: Value = http
                    .get(format!("{base}/messages?page=1"))
                    .bearer_auth(token.as_str())
                    .send()
                    .await
                    .context("mail.tm list transport")?
                    .json()
                    .await
                    .context("mail.tm list body")?;

                let items = list
                    .get("hydra:member")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();

                let mut out = Vec::new();
                for item in items.iter().take(10) {
                    let id = item
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    if id.is_empty() || seen.contains(&id) {
                        continue;
                    }
                    seen.insert(id.clone());

                    let subject = item
                        .get("subject")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let detail: Value = http
                        .get(format!("{base}/messages/{id}"))
                        .bearer_auth(token.as_str())
                        .send()
                        .await
                        .context("mail.tm message transport")?
                        .json()
                        .await
                        .context("mail.tm message body")?;

                    let text = detail
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let html = match detail.get("html") {
                        Some(Value::String(s)) => s.clone(),
                        Some(Value::Array(a)) => a
                            .iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join("\n"),
                        _ => String::new(),
                    };

                    out.push(Candidate {
                        id,
                        subject: decode_words(&subject),
                        body: format!("{subject}\n{text}\n{html}"),
                    });
                }
                Ok(out)
            }
            InboxKind::TempmailLol {
                base,
                http,
                token,
                seen,
            } => {
                let list: Value = http
                    .get(format!("{base}/auth/{token}"))
                    .send()
                    .await
                    .context("tempmail.lol list transport")?
                    .json()
                    .await
                    .context("tempmail.lol list body")?;

                let empty: Vec<Value> = Vec::new();
                let items = list
                    .get("email")
                    .and_then(Value::as_array)
                    .unwrap_or(&empty);

                let mut out = Vec::new();
                for item in items.iter().take(10) {
                    let id = item
                        .get("_id")
                        .and_then(value_to_string)
                        .unwrap_or_default();
                    if id.is_empty() || seen.contains(&id) {
                        continue;
                    }
                    seen.insert(id.clone());

                    let subject = item
                        .get("subject")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let body = item
                        .get("body")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let html = item
                        .get("html")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();

                    out.push(Candidate {
                        id,
                        subject: decode_words(&subject),
                        body: format!("{subject}\n{body}\n{html}"),
                    });
                }
                Ok(out)
            }
            InboxKind::Api { cfg, http, seen } => {
                let url = cfg.list_url.replace("{email}", &self.address);
                let mut req = http.get(url);
                if !cfg.token.is_empty() {
                    req = req.bearer_auth(cfg.token.as_str());
                }
                let body: Value = req
                    .send()
                    .await
                    .context("api list transport")?
                    .json()
                    .await
                    .context("api list body")?;

                let empty: Vec<Value> = Vec::new();
                let items: &[Value] = if cfg.items_path.trim().is_empty() {
                    body.as_array().map(Vec::as_slice).unwrap_or(&[])
                } else {
                    json_path(&body, &cfg.items_path)
                        .and_then(Value::as_array)
                        .map(Vec::as_slice)
                        .unwrap_or(empty.as_slice())
                };

                let mut out = Vec::new();
                for item in items.iter().take(10) {
                    let id = item
                        .get(&cfg.id_field)
                        .and_then(value_to_string)
                        .unwrap_or_else(|| format!("idx{}", out.len()));
                    if seen.contains(&id) {
                        continue;
                    }
                    seen.insert(id.clone());

                    let subject = item
                        .get(&cfg.subject_field)
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();

                    let mut text = item
                        .get(&cfg.body_field)
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();

                    if !cfg.detail_url.trim().is_empty() {
                        let detail_url = cfg.detail_url.replace("{id}", &id);
                        let mut req = http.get(detail_url);
                        if !cfg.token.is_empty() {
                            req = req.bearer_auth(cfg.token.as_str());
                        }
                        if let Ok(detail) = req.send().await {
                            if let Ok(detail_json) = detail.json::<Value>().await {
                                let detail_text = detail_json
                                    .get(&cfg.body_field)
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_string();
                                if !detail_text.is_empty() {
                                    text = detail_text;
                                }
                            }
                        }
                    }

                    out.push(Candidate {
                        id,
                        subject: decode_words(&subject),
                        body: format!("{subject}\n{text}"),
                    });
                }
                Ok(out)
            }
        }
    }
}

fn match_candidate(filter: &MailFilter, cand: &Candidate) -> Option<MailHit> {
    if let Some(needle) = &filter.subject_contains {
        let hay = cand.subject.to_lowercase();
        if !hay.contains(needle.to_lowercase().as_str()) {
            return None;
        }
    }

    let hay = sanitize(&cand.body);
    let link = filter
        .link_regex
        .as_ref()
        .and_then(|pattern| regex_capture(pattern, &hay));
    let code = filter
        .code_regex
        .as_ref()
        .and_then(|pattern| regex_capture(pattern, &hay));

    if link.is_none() && code.is_none() {
        return None;
    }

    Some(MailHit {
        subject: cand.subject.clone(),
        link,
        code,
    })
}

async fn fetch_mailtm_domains(base: &str, http: &Client) -> Result<Vec<String>> {
    let body: Value = http
        .get(format!("{base}/domains?page=1"))
        .send()
        .await
        .context("mail.tm domains transport")?
        .json()
        .await
        .context("mail.tm domains body")?;

    let items = body
        .get("hydra:member")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut out = Vec::new();
    for item in items {
        let active = item.get("isActive").and_then(Value::as_bool).unwrap_or(true);
        let private = item.get("isPrivate").and_then(Value::as_bool).unwrap_or(false);
        if !active || private {
            continue;
        }
        if let Some(domain) = item.get("domain").and_then(Value::as_str) {
            out.push(domain.to_string());
        }
    }
    Ok(out)
}

async fn tempmail_lol_generate(base: &str, http: &Client) -> Result<(String, String)> {
    let body: Value = http
        .get(format!("{base}/generate"))
        .send()
        .await
        .context("tempmail.lol generate transport")?
        .json()
        .await
        .context("tempmail.lol generate body")?;
    let address = body
        .get("address")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("tempmail.lol generate response: {body}"))?;
    let token = body
        .get("token")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("tempmail.lol generate response: {body}"))?;
    Ok((address.to_string(), token.to_string()))
}

async fn mailtm_login_or_create(base: &str, http: &Client, ident: &Identity) -> Result<String> {
    let payload = json!({ "address": ident.email, "password": ident.password });

    let create = http
        .post(format!("{base}/accounts"))
        .json(&payload)
        .send()
        .await
        .context("mail.tm signup transport")?;
    let status = create.status();
    if !status.is_success() && status.as_u16() != 422 {
        let body = create.text().await.unwrap_or_default();
        bail!("mail.tm signup failed ({status}): {body}");
    }

    // mail.tm соглашается создать ящик раньше, чем он становится доступен
    // для /token: сразу после signup логин может отдать 401. Повторяем.
    let mut last = String::new();
    for attempt in 0..8 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(400 * attempt as u64)).await;
        }
        let resp = http
            .post(format!("{base}/token"))
            .json(&json!({ "address": ident.email, "password": ident.password }))
            .send()
            .await
            .context("mail.tm token transport")?;
        let code = resp.status();
        let body = resp.text().await.context("mail.tm token body")?;
        if code.is_success() {
            let parsed: Value = serde_json::from_str(&body).context("mail.tm token json")?;
            if let Some(token) = parsed.get("token").and_then(Value::as_str) {
                return Ok(token.to_string());
            }
            last = parsed.to_string();
            continue;
        }
        last = format!("{code} {body}");
        if code.as_u16() != 401 && code.as_u16() != 429 {
            break;
        }
    }
    bail!("mail.tm token response: {last}")
}

fn imap_uid_list(cfg: &ImapCfg, address: &str) -> Result<Vec<String>> {
    let tls = native_tls::TlsConnector::builder()
        .build()
        .context("tls connector")?;
    let client = imap::connect((cfg.host.as_str(), cfg.port), cfg.host.as_str(), &tls)
        .map_err(|e| anyhow!("imap connect {}:{}: {e}", cfg.host, cfg.port))?;
    let mut session = client
        .login(&cfg.user, &cfg.password)
        .map_err(|(e, _)| anyhow!("imap login {}: {e}", cfg.user))?;
    session
        .select(&cfg.mailbox)
        .map_err(|e| anyhow!("imap select {}: {e}", cfg.mailbox))?;

    let uids = session
        .uid_search(format!("TO \"{address}\""))
        .map_err(|e| anyhow!("imap uid search: {e}"))?;
    let out: Vec<String> = uids.into_iter().map(|uid| uid.to_string()).collect();
    let _ = session.logout();
    Ok(out)
}

fn imap_fetch_blocking(
    cfg: &ImapCfg,
    address: &str,
    exclude: &HashSet<String>,
) -> Result<Vec<Candidate>> {
    let tls = native_tls::TlsConnector::builder()
        .build()
        .context("tls connector")?;
    let client = imap::connect((cfg.host.as_str(), cfg.port), cfg.host.as_str(), &tls)
        .map_err(|e| anyhow!("imap connect {}:{}: {e}", cfg.host, cfg.port))?;
    let mut session = client
        .login(&cfg.user, &cfg.password)
        .map_err(|(e, _)| anyhow!("imap login {}: {e}", cfg.user))?;
    session
        .select(&cfg.mailbox)
        .map_err(|e| anyhow!("imap select {}: {e}", cfg.mailbox))?;

    let uids = session
        .uid_search(format!("TO \"{address}\""))
        .map_err(|e| anyhow!("imap uid search: {e}"))?;

    let mut ids: Vec<String> = uids
        .into_iter()
        .map(|uid| uid.to_string())
        .filter(|uid| !exclude.contains(uid))
        .collect();
    ids.sort_unstable();

    let mut out = Vec::new();
    for uid in ids.into_iter().rev().take(20) {
        let fetched = session
            .uid_fetch(uid.as_str(), "(RFC822)")
            .map_err(|e| anyhow!("imap fetch {uid}: {e}"))?;
        for msg in fetched.iter() {
            if let Some(raw) = msg.body() {
                let text = String::from_utf8_lossy(raw).to_string();
                let (subject, body) = split_message(&text);
                out.push(Candidate {
                    id: uid.clone(),
                    subject: decode_words(&subject),
                    body: format!("{subject}\n{body}"),
                });
            }
        }
    }

    let _ = session.logout();
    Ok(out)
}

fn split_message(raw: &str) -> (String, String) {
    let (head, body) = match raw.find("\r\n\r\n") {
        Some(i) => (&raw[..i], &raw[i + 4..]),
        None => match raw.find("\n\n") {
            Some(i) => (&raw[..i], &raw[i + 2..]),
            None => ("", raw),
        },
    };

    let mut unfolded = String::with_capacity(head.len());
    for line in head.lines() {
        if line.starts_with(' ') || line.starts_with('\t') {
            unfolded.push(' ');
            unfolded.push_str(line.trim());
        } else {
            unfolded.push('\n');
            unfolded.push_str(line);
        }
    }

    let mut subject = String::new();
    for line in unfolded.lines() {
        let lower = line.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("subject:") {
            let _ = rest;
            subject = line[8..].trim().to_string();
        }
    }

    (subject, body.to_string())
}

fn decode_words(input: &str) -> String {
    let re = match Regex::new(r"=\?[^?]+\?([BbQq])\?([^?]*)\?=") {
        Ok(re) => re,
        Err(_) => return input.to_string(),
    };
    re.replace_all(input, |caps: &regex::Captures| {
        let encoding = caps[1].to_ascii_uppercase();
        let payload = &caps[2];
        if encoding == "B" {
            base64::engine::general_purpose::STANDARD
                .decode(payload)
                .ok()
                .map(|bytes| String::from_utf8_lossy(&bytes).to_string())
                .unwrap_or_else(|| payload.to_string())
        } else {
            q_decode(payload)
        }
    })
    .to_string()
}

fn q_decode(payload: &str) -> String {
    let replaced = payload.replace('_', " ");
    let bytes = replaced.as_bytes();
    let mut out = String::with_capacity(replaced.len());
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'='
            && i + 2 < bytes.len()
            && bytes[i + 1].is_ascii_hexdigit()
            && bytes[i + 2].is_ascii_hexdigit()
        {
            let hex = &replaced[i + 1..i + 3];
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                out.push(byte as char);
                i += 3;
                continue;
            }
        }
        let ch = replaced[i..].chars().next().expect("char boundary");
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// Decodes quoted-printable soft breaks / escapes and unescapes the common HTML entities.
fn sanitize(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0usize;

    while i < bytes.len() {
        if bytes[i] == b'=' {
            if i + 2 < bytes.len() && bytes[i + 1] == b'\r' && bytes[i + 2] == b'\n' {
                i += 3;
                continue;
            }
            if i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
                i += 2;
                continue;
            }
            if i + 2 < bytes.len()
                && bytes[i + 1].is_ascii_hexdigit()
                && bytes[i + 2].is_ascii_hexdigit()
            {
                if let Ok(byte) = u8::from_str_radix(&input[i + 1..i + 3], 16) {
                    out.push(byte as char);
                    i += 3;
                    continue;
                }
            }
        }
        let ch = input[i..].chars().next().expect("char boundary");
        out.push(ch);
        i += ch.len_utf8();
    }

    out.replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
}
