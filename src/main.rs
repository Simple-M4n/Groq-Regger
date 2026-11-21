mod captcha;
mod config;
mod email;
mod flow;
mod http;
mod identity;
mod recipe;
mod runner;
mod store;
mod util;

use anyhow::Result;
use clap::{Parser, Subcommand};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::captcha::Solver;
use crate::config::Settings;
use crate::email::Mailer;
use crate::http::{HttpFactory, ProxyPool};
use crate::recipe::Recipe;
use crate::runner::Runner;
use crate::store::Store;

#[derive(Parser, Debug)]
#[command(
    name = "groq-regger",
    version,
    about = "Recipe-driven account registrator (Groq console flow)"
)]
struct Cli {
    #[arg(long, global = true, default_value = "config.toml")]
    config: PathBuf,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand, Debug)]
enum Cmd {
    /// Execute the recipe `count` times
    Run {
        #[arg(short = 'n', long, default_value_t = 1)]
        count: usize,
        /// Override run.concurrency
        #[arg(short = 'c', long)]
        concurrency: Option<usize>,
        /// Render every step, hit nothing but the captcha solver
        #[arg(long)]
        dry_run: bool,
    },
    /// Validate the recipe and print the resolved configuration
    Check,
    /// Print generated identities
    Gen {
        #[arg(short = 'n', long, default_value_t = 5)]
        count: usize,
        #[arg(long)]
        domain: Option<String>,
    },
    /// List domains offered by the configured mail provider
    Domains,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                tracing_subscriber::EnvFilter::new("info,reqwest=warn,hyper=warn,rustls=warn")
            }),
        )
        .with_target(false)
        .init();

    let cli = Cli::parse();
    let cfg_path = cli.config.clone();
    let base_dir = cfg_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));

    let mut cfg = Settings::load(&cfg_path)?;
    let recipe_path = cfg.resolve(&base_dir, &cfg.run.recipe.clone());
    let recipe = Recipe::load(&recipe_path)?;

    match cli.cmd {
        Cmd::Check => {
            println!("recipe      : {} ({})", recipe.meta.name, recipe_path.display());
            println!("base_url    : {}", recipe.meta.base_url);
            println!("success_var : {}", recipe.success_var());
            println!("steps       : {}", recipe.steps.len());
            for (idx, step) in recipe.steps.iter().enumerate() {
                println!(
                    "  {:>2}. [{}] {:<22} {}",
                    idx + 1,
                    step.kind(),
                    step.label(idx),
                    step.note.clone().unwrap_or_default()
                );
            }

            let proxies = ProxyPool::load(&cfg.resolve(&base_dir, &cfg.run.proxies_file))?;
            println!("proxies     : {}", proxies.len());
            println!("concurrency : {}", cfg.run.concurrency);
            println!("attempts    : {}", cfg.run.max_attempts);

            let solver = Solver::new(&cfg.captcha)?;
            println!("captcha     : {}", solver.describe());

            let mailer = Mailer::from_cfg(&cfg.email)?;
            println!("mail        : {}", mailer.describe());

            let issues = recipe::validate(&recipe);
            if issues.is_empty() {
                println!("validation  : ok");
            } else {
                println!("validation  : {} finding(s)", issues.len());
                for issue in issues {
                    println!("  - {issue}");
                }
            }
        }
        Cmd::Gen { count, domain } => {
            let domain = domain.unwrap_or_else(|| {
                cfg.email
                    .domains
                    .first()
                    .cloned()
                    .unwrap_or_else(|| "example.com".to_string())
            });
            for _ in 0..count {
                let ident = identity::generate(&domain);
                println!(
                    "{}\t{}\t{} {}",
                    ident.email, ident.password, ident.first_name, ident.last_name
                );
            }
        }
        Cmd::Domains => {
            let mailer = Mailer::from_cfg(&cfg.email)?;
            let domains = mailer.list_domains().await?;
            if domains.is_empty() {
                println!("no domains returned");
            }
            for domain in domains {
                println!("{domain}");
            }
        }
        Cmd::Run {
            count,
            concurrency,
            dry_run,
        } => {
            if let Some(value) = concurrency {
                cfg.run.concurrency = value.max(1);
            }

            let issues = recipe::validate(&recipe);
            for issue in &issues {
                tracing::warn!("recipe: {issue}");
            }

            let proxies = Arc::new(ProxyPool::load(
                &cfg.resolve(&base_dir, &cfg.run.proxies_file),
            )?);
            let out_dir = cfg.resolve(&base_dir, &cfg.run.out_dir.clone());
            let store = Arc::new(Store::open(&out_dir, &recipe.meta.name).await?);
            let solver = Arc::new(Solver::new(&cfg.captcha)?);
            let mailer = Arc::new(Mailer::from_cfg(&cfg.email)?);
            let http = Arc::new(HttpFactory::new(cfg.http.clone()));

            tracing::info!(
                "mail: {} | captcha: {} | proxies: {}",
                mailer.describe(),
                solver.describe(),
                proxies.len()
            );

            let runner = Arc::new(Runner {
                cfg: cfg.clone(),
                recipe,
                store: Arc::clone(&store),
                proxies,
                http,
                solver,
                mailer,
                dry_run,
            });

            let summary = Runner::run(Arc::clone(&runner), count).await?;

            println!();
            println!("ok     : {}", summary.ok);
            println!("failed : {}", summary.failed);
            println!("results: {}", store.path().display());
            println!("keys   : {}", store.keys_path().display());
        }
    }

    Ok(())
}
