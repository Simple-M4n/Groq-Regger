// Config loading and append-only result storage. Files are created on demand;
// nothing here is interactive and no secrets are printed.

import fs from 'node:fs';
import path from 'node:path';

export function loadConfig(file) {
  if (!file || !fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid config JSON in ${file}: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`config ${file} must contain a JSON object`);
  }
  return parsed;
}

function ensureParent(file) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
}

export function appendResult(file, record) {
  ensureParent(file);
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
}

export function appendKey(file, apiKey, email) {
  ensureParent(file);
  fs.appendFileSync(file, `${apiKey}\t${email}\n`, 'utf8');
}
