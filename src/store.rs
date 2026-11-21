use anyhow::{Context, Result};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize)]
pub struct Record {
    pub ts: String,
    pub status: String,
    pub email: String,
    pub password: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy: Option<String>,
    pub duration_ms: u128,
    #[serde(skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub vars: BTreeMap<String, String>,
}

pub struct Store {
    file: Mutex<tokio::fs::File>,
    keys_file: Mutex<tokio::fs::File>,
    path: PathBuf,
    keys_path: PathBuf,
}

impl Store {
    pub async fn open(dir: &Path, stem: &str) -> Result<Self> {
        tokio::fs::create_dir_all(dir)
            .await
            .with_context(|| format!("create {}", dir.display()))?;
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
        let path = dir.join(format!("{stem}-{stamp}.jsonl"));
        let keys_path = dir.join(format!("{stem}-{stamp}.keys.txt"));

        let file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await
            .with_context(|| format!("open {}", path.display()))?;
        let keys_file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&keys_path)
            .await
            .with_context(|| format!("open {}", keys_path.display()))?;

        Ok(Self {
            file: Mutex::new(file),
            keys_file: Mutex::new(keys_file),
            path,
            keys_path,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn keys_path(&self) -> &Path {
        &self.keys_path
    }

    pub async fn append(&self, record: &Record) -> Result<()> {
        let mut line = serde_json::to_string(record)?;
        line.push('\n');
        {
            let mut guard = self.file.lock().await;
            guard.write_all(line.as_bytes()).await?;
            guard.flush().await?;
        }
        if let Some(key) = &record.api_key {
            let mut guard = self.keys_file.lock().await;
            guard
                .write_all(format!("{key}\t{}\n", record.email).as_bytes())
                .await?;
            guard.flush().await?;
        }
        Ok(())
    }
}
