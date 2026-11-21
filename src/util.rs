use rand::seq::SliceRandom;
use rand::Rng;
use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;

/// Replaces every `{{name}}` with `vars[name]`; unknown keys render as an empty string.
pub fn render_tpl(tpl: &str, vars: &HashMap<String, String>) -> String {
    let mut out = String::with_capacity(tpl.len() + 16);
    let mut i = 0usize;
    while i < tpl.len() {
        if tpl[i..].starts_with("{{") {
            if let Some(end) = tpl[i + 2..].find("}}") {
                let key = tpl[i + 2..i + 2 + end].trim();
                if let Some(v) = vars.get(key) {
                    out.push_str(v);
                }
                i = i + 2 + end + 2;
                continue;
            }
        }
        let ch = tpl[i..].chars().next().expect("char boundary");
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// Walks a JSON value and renders every string through `render_tpl`.
pub fn render_json(v: &Value, vars: &HashMap<String, String>) -> Value {
    match v {
        Value::String(s) => Value::String(render_tpl(s, vars)),
        Value::Array(a) => Value::Array(a.iter().map(|x| render_json(x, vars)).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, val)| (k.clone(), render_json(val, vars)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// Minimal `$.a.b[0].c` style lookup.
pub fn json_path<'a>(root: &'a Value, path: &str) -> Option<&'a Value> {
    let trimmed = path.trim();
    let body = trimmed.strip_prefix('$').unwrap_or(trimmed);
    let body = body.strip_prefix('.').unwrap_or(body);
    if body.is_empty() {
        return Some(root);
    }

    let mut cur = root;
    for segment in body.split('.') {
        let mut name = segment;
        let mut indexes: Vec<usize> = Vec::new();

        if let Some(open) = segment.find('[') {
            name = &segment[..open];
            let mut rest = &segment[open..];
            while let Some(tail) = rest.strip_prefix('[') {
                let close = tail.find(']')?;
                indexes.push(tail[..close].parse().ok()?);
                rest = &tail[close + 1..];
            }
        }

        if !name.is_empty() {
            cur = cur.get(name)?;
        }
        for idx in indexes {
            cur = cur.get(idx)?;
        }
    }
    Some(cur)
}

pub fn value_to_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// First capture group when present, otherwise the whole match.
pub fn regex_capture(pattern: &str, hay: &str) -> Option<String> {
    let re = match Regex::new(pattern) {
        Ok(re) => re,
        Err(e) => {
            tracing::warn!("bad regex `{pattern}`: {e}");
            return None;
        }
    };
    let caps = re.captures(hay)?;
    match caps.get(1) {
        Some(m) => Some(m.as_str().to_string()),
        None => caps.get(0).map(|m| m.as_str().to_string()),
    }
}

pub fn jitter_ms(min: u64, max: u64) -> u64 {
    if max <= min {
        return min;
    }
    rand::thread_rng().gen_range(min..=max)
}

pub fn pick_one<T: Clone>(items: &[T]) -> Option<T> {
    items.choose(&mut rand::thread_rng()).cloned()
}

pub fn generate_pkce() -> (String, String) {
    use base64::prelude::*;
    use rand::RngCore;
    use ring::digest::{digest, SHA256};

    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let verifier = BASE64_URL_SAFE_NO_PAD.encode(bytes);

    let hash = digest(&SHA256, verifier.as_bytes());
    let challenge = BASE64_URL_SAFE_NO_PAD.encode(hash.as_ref());

    (verifier, challenge)
}

pub fn generate_stytch_client_header() -> String {
    use base64::prelude::*;
    let blob = serde_json::json!({
        "event_id": format!("event-id-{}", uuid::Uuid::new_v4()),
        "app_session_id": format!("app-session-id-{}", uuid::Uuid::new_v4()),
        "persistent_id": format!("persistent-id-{}", uuid::Uuid::new_v4()),
        "client_sent_at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "timezone": "UTC",
        "app": { "identifier": "console.groq.com" },
        "sdk": { "identifier": "Stytch.js Javascript SDK", "version": "5.43.0" }
    });
    BASE64_STANDARD.encode(blob.to_string().as_bytes())
}
