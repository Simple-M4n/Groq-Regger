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

function snapshot(file) {
  try {
    return { exists: true, size: fs.statSync(file).size };
  } catch {
    return { exists: false, size: 0 };
  }
}

function rollback(file, state) {
  try {
    if (state.exists) fs.truncateSync(file, state.size);
    else fs.unlinkSync(file);
  } catch {
    /* best effort: preserve the original write error for the caller */
  }
}

// Keep the JSONL record and the key file in sync. If the second write fails,
// restore both files to their previous size instead of leaving a key without a
// matching account (or vice versa).
export function appendAccount({ resultsFile, keysFile, record }) {
  const resultsBefore = snapshot(resultsFile);
  const keysBefore = snapshot(keysFile);
  try {
    appendResult(resultsFile, record);
    appendKey(keysFile, record.api_key, record.email);
  } catch (err) {
    rollback(resultsFile, resultsBefore);
    rollback(keysFile, keysBefore);
    throw err;
  }
}
