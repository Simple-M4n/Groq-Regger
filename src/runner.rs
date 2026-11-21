use anyhow::Result;
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Semaphore;

use crate::captcha::Solver;
use crate::config::Settings;
use crate::email::Mailer;
use crate::flow::{self, FlowCtx};
use crate::http::{HttpFactory, ProxyPool};
use crate::identity::{self, Identity};
use crate::recipe::Recipe;
use crate::store::{Record, Store};
use crate::util::{generate_pkce, generate_stytch_client_header, jitter_ms};

pub struct Runner {
    pub cfg: Settings,
    pub recipe: Recipe,
    pub store: Arc<Store>,
    pub proxies: Arc<ProxyPool>,
    pub http: Arc<HttpFactory>,
    pub solver: Arc<Solver>,
    pub mailer: Arc<Mailer>,
    pub dry_run: bool,
}

#[derive(Debug, Default)]
pub struct Summary {
    pub ok: usize,
    pub failed: usize,
}

struct AttemptError {
    ident: Option<Identity>,
    proxy: Option<String>,
    msg: String,
    retryable: bool,
    vars: BTreeMap<String, String>,
}

impl AttemptError {
    fn new(ident: Option<Identity>, proxy: Option<String>, msg: String, retryable: bool) -> Self {
        Self {
            ident,
            proxy,
            msg,
            retryable,
            vars: BTreeMap::new(),
        }
    }
}

fn kept_vars(vars: &HashMap<String, String>) -> BTreeMap<String, String> {
    let mut kept = BTreeMap::new();
    for (key, value) in vars {
        if matches!(key.as_str(), "password" | "captcha") {
            continue;
        }
        kept.insert(key.clone(), value.clone());
    }
    kept
}

impl Runner {
    pub async fn run(self: Arc<Self>, count: usize) -> Result<Summary> {
        let concurrency = self.cfg.run.concurrency.max(1);
        let semaphore = Arc::new(Semaphore::new(concurrency));
        tracing::info!(
            "dispatching {count} job(s) at concurrency {concurrency}{}",
            if self.dry_run { " [dry-run]" } else { "" }
        );

        let mut handles = Vec::with_capacity(count);
        for idx in 0..count {
            let me = Arc::clone(&self);
            let permit_pool = Arc::clone(&semaphore);
            handles.push(tokio::spawn(async move {
                let _permit = permit_pool.acquire_owned().await.expect("semaphore open");
                me.one(idx).await
            }));
        }

        let mut summary = Summary::default();
        for handle in handles {
            match handle.await {
                Ok(record) => {
                    if record.status == "ok" {
                        summary.ok += 1;
                    } else {
                        summary.failed += 1;
                    }
                    self.store.append(&record).await?;
                }
                Err(e) => {
                    summary.failed += 1;
                    tracing::error!("worker panicked: {e}");
                }
            }
        }
        Ok(summary)
    }

    async fn one(&self, idx: usize) -> Record {
        let started = Instant::now();
        let attempts = self.cfg.run.max_attempts.max(1);
        let mut last: Option<AttemptError> = None;

        for attempt in 1..=attempts {
            let jitter = jitter_ms(self.cfg.run.delay_ms_min, self.cfg.run.delay_ms_max);
            tokio::time::sleep(Duration::from_millis(jitter)).await;

            if let Some(prev) = &last {
                tracing::warn!(
                    "job {idx}: retry {attempt}/{attempts} after: {}",
                    prev.msg
                );
            }

            match self.attempt().await {
                Ok(record) => {
                    tracing::info!(
                        "job {idx}: OK {} {}",
                        record.email,
                        record.api_key.as_deref().unwrap_or("-")
                    );
                    return record;
                }
                Err(err) => {
                    tracing::warn!(
                        "job {idx}: attempt {attempt}/{attempts} failed ({}): {}",
                        if err.retryable { "retryable" } else { "fatal" },
                        err.msg
                    );
                    last = Some(err);
                }
            }
        }

        let err = last.expect("at least one attempt");
        Record {
            ts: chrono::Local::now().to_rfc3339(),
            status: "failed".to_string(),
            email: err.ident.as_ref().map(|i| i.email.clone()).unwrap_or_default(),
            password: err
                .ident
                .as_ref()
                .map(|i| i.password.clone())
                .unwrap_or_default(),
            api_key: None,
            error: Some(err.msg),
            proxy: err.proxy,
            duration_ms: started.elapsed().as_millis(),
            vars: err.vars,
        }
    }

    async fn attempt(&self) -> std::result::Result<Record, AttemptError> {
        let started = Instant::now();

        let domain = self.mailer.pick_domain().await.map_err(|e| {
            AttemptError::new(None, None, format!("pick domain: {e:#}"), true)
        })?;
        let mut ident = identity::generate(&domain);

        let proxy = self.proxies.next();
        let proxy_label = proxy.as_ref().map(|p| p.label());

        let (client, jar, _profile) = self
            .http
            .client(proxy.as_ref())
            .map_err(|e| {
                AttemptError::new(
                    Some(ident.clone()),
                    proxy_label.clone(),
                    format!("http client: {e:#}"),
                    true,
                )
            })?;

        let mut vars: HashMap<String, String> = HashMap::new();
        for (key, value) in ident.vars() {
            vars.insert(key.to_string(), value);
        }
        vars.insert("uuid".to_string(), uuid::Uuid::new_v4().to_string());
        vars.insert(
            "ts".to_string(),
            chrono::Utc::now().timestamp().to_string(),
        );
        if let Some(label) = &proxy_label {
            vars.insert("proxy".to_string(), label.clone());
        }

        let (pkce_verifier, pkce_challenge) = generate_pkce();
        let stytch_client_header = generate_stytch_client_header();
        vars.insert("pkce_verifier".to_string(), pkce_verifier);
        vars.insert("pkce_challenge".to_string(), pkce_challenge);
        vars.insert("stytch_client_header".to_string(), stytch_client_header);

        let mut ctx = FlowCtx::new(
            self.recipe.meta.base_url.clone(),
            self.recipe.meta.default_headers.clone(),
            client,
            jar,
            vars,
            self.dry_run,
        );

        let mut inbox = if self.dry_run {
            None
        } else {
            Some(self.mailer.open(&ident).await.map_err(|e| {
                AttemptError::new(
                    Some(ident.clone()),
                    proxy_label.clone(),
                    format!("open mailbox: {e:#}"),
                    true,
                )
            })?)
        };

        // Some providers (tempmail.lol) assign the address themselves.
        if let Some(mailbox) = inbox.as_ref() {
            if mailbox.address != ident.email {
                ident.local_part = mailbox
                    .address
                    .split('@')
                    .next()
                    .unwrap_or_default()
                    .to_string();
                ident.email = mailbox.address.clone();
                ctx.vars.insert("email".to_string(), ident.email.clone());
                ctx.vars.insert("local_part".to_string(), ident.local_part.clone());
            }
        }

        flow::execute(&self.recipe, &mut ctx, inbox.as_mut(), &self.solver)
            .await
            .map_err(|e| {
                let retryable = e
                    .downcast_ref::<flow::StepFailure>()
                    .map(|f| f.retryable)
                    .unwrap_or(true);
                let mut err = AttemptError::new(
                    Some(ident.clone()),
                    proxy_label.clone(),
                    format!("{e:#}"),
                    retryable,
                );
                err.vars = kept_vars(&ctx.vars);
                err
            })?;

        let api_key = ctx.vars.get(self.recipe.success_var()).cloned();
        let kept = kept_vars(&ctx.vars);

        Ok(Record {
            ts: chrono::Local::now().to_rfc3339(),
            status: "ok".to_string(),
            email: ident.email.clone(),
            password: ident.password.clone(),
            api_key,
            error: None,
            proxy: proxy_label,
            duration_ms: started.elapsed().as_millis(),
            vars: kept,
        })
    }
}
