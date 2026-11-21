use anyhow::{Context, Result};
use rand::seq::SliceRandom;
use reqwest::cookie::Jar;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::{Client, Proxy as ReqwestProxy};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::config::HttpCfg;

/// (user-agent, sec-ch-ua, sec-ch-ua-platform)
const UA_POOL: &[(&str, &str, &str)] = &[
    (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "\"Google Chrome\";v=\"131\", \"Chromium\";v=\"131\", \"Not_A Brand\";v=\"24\"",
        "\"Windows\"",
    ),
    (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        "\"Chromium\";v=\"130\", \"Google Chrome\";v=\"130\", \"Not_A Brand\";v=\"99\"",
        "\"Windows\"",
    ),
    (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "\"Google Chrome\";v=\"131\", \"Chromium\";v=\"131\", \"Not_A Brand\";v=\"24\"",
        "\"macOS\"",
    ),
    (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        "\"Chromium\";v=\"130\", \"Google Chrome\";v=\"130\", \"Not_A Brand\";v=\"99\"",
        "\"Linux\"",
    ),
    (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
        "\"Google Chrome\";v=\"129\", \"Chromium\";v=\"129\", \"Not_A Brand\";v=\"24\"",
        "\"Windows\"",
    ),
    (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
        "\"Google Chrome\";v=\"129\", \"Chromium\";v=\"129\", \"Not_A Brand\";v=\"24\"",
        "\"macOS\"",
    ),
];

#[derive(Debug, Clone)]
pub struct BrowserProfile {
    pub user_agent: String,
    pub ch_ua: String,
    pub platform: String,
}

#[derive(Debug, Clone)]
pub struct Proxy {
    pub url: String,
}

impl Proxy {
    pub fn parse(line: &str) -> Option<Self> {
        let s = line.trim();
        if s.is_empty() || s.starts_with('#') {
            return None;
        }
        let url = if s.contains("://") {
            s.to_string()
        } else {
            format!("http://{s}")
        };
        Some(Self { url })
    }

    pub fn label(&self) -> String {
        match url::Url::parse(&self.url) {
            Ok(u) => match u.port() {
                Some(p) => format!("{}:{}", u.host_str().unwrap_or("?"), p),
                None => u.host_str().unwrap_or("?").to_string(),
            },
            Err(_) => self.url.clone(),
        }
    }
}

pub struct ProxyPool {
    items: Vec<Proxy>,
    cursor: AtomicUsize,
}

impl ProxyPool {
    pub fn load(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self {
                items: Vec::new(),
                cursor: AtomicUsize::new(0),
            });
        }
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("read proxies {}", path.display()))?;
        let items: Vec<Proxy> = raw.lines().filter_map(Proxy::parse).collect();
        tracing::info!(count = items.len(), path = %path.display(), "proxy pool loaded");
        Ok(Self {
            items,
            cursor: AtomicUsize::new(0),
        })
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    /// Round-robin pick so concurrent workers spread over the pool.
    pub fn next(&self) -> Option<Proxy> {
        if self.items.is_empty() {
            return None;
        }
        let idx = self.cursor.fetch_add(1, Ordering::Relaxed) % self.items.len();
        Some(self.items[idx].clone())
    }
}

pub struct HttpFactory {
    cfg: HttpCfg,
}

impl HttpFactory {
    pub fn new(cfg: HttpCfg) -> Self {
        Self { cfg }
    }

    pub fn profile(&self) -> BrowserProfile {
        let mut rng = rand::thread_rng();
        if !self.cfg.user_agents.is_empty() {
            let ua = self
                .cfg
                .user_agents
                .choose(&mut rng)
                .cloned()
                .unwrap_or_else(|| UA_POOL[0].0.to_string());
            return BrowserProfile {
                user_agent: ua,
                ch_ua: UA_POOL[0].1.to_string(),
                platform: UA_POOL[0].2.to_string(),
            };
        }
        let (ua, ch, platform) = UA_POOL.choose(&mut rng).copied().unwrap_or(UA_POOL[0]);
        BrowserProfile {
            user_agent: ua.to_string(),
            ch_ua: ch.to_string(),
            platform: platform.to_string(),
        }
    }

    pub fn client(&self, proxy: Option<&Proxy>) -> Result<(Client, Arc<Jar>, BrowserProfile)> {
        let profile = self.profile();
        let jar = Arc::new(Jar::default());

        let mut headers = HeaderMap::new();
        let pairs: [(&'static str, String); 11] = [
            (
                "accept",
                "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"
                    .to_string(),
            ),
            ("accept-language", self.cfg.accept_language.clone()),
            ("accept-encoding", "gzip, deflate, br".to_string()),
            ("sec-ch-ua", profile.ch_ua.clone()),
            ("sec-ch-ua-mobile", "?0".to_string()),
            ("sec-ch-ua-platform", profile.platform.clone()),
            ("sec-fetch-dest", "empty".to_string()),
            ("sec-fetch-mode", "cors".to_string()),
            ("sec-fetch-site", "same-origin".to_string()),
            ("upgrade-insecure-requests", "1".to_string()),
            ("priority", "u=1, i".to_string()),
        ];
        for (name, value) in pairs {
            headers.insert(
                HeaderName::from_static(name),
                HeaderValue::from_bytes(value.as_bytes())
                    .with_context(|| format!("header {name}={value}"))?,
            );
        }

        let mut builder = Client::builder()
            .user_agent(&profile.user_agent)
            .cookie_provider(jar.clone())
            .default_headers(headers)
            .timeout(Duration::from_secs(self.cfg.timeout_secs.max(5)))
            .redirect(reqwest::redirect::Policy::limited(10))
            .gzip(true)
            .brotli(true)
            .pool_idle_timeout(Duration::from_secs(30));

        if let Some(p) = proxy {
            builder = builder
                .proxy(ReqwestProxy::all(p.url.as_str()).with_context(|| format!("proxy {}", p.url))?);
        }

        let client = builder.build().context("build http client")?;
        Ok((client, jar, profile))
    }
}
