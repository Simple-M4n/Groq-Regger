// Append helpers and rollback behaviour. Run: node --test test/store.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { appendAccount, appendKey, appendResult } from '../lib/store.js';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'groq-store-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const record = { status: 'ok', api_key: 'gsk_test', email: 'a@example.tld' };

test('appendAccount writes both outputs', (t) => {
  const dir = tempDir(t);
  const results = path.join(dir, 'out', 'accounts.jsonl');
  const keys = path.join(dir, 'out', 'keys.txt');
  appendAccount({ resultsFile: results, keysFile: keys, record });
  assert.deepEqual(JSON.parse(fs.readFileSync(results, 'utf8').trim()), record);
  assert.equal(fs.readFileSync(keys, 'utf8'), 'gsk_test\ta@example.tld\n');
});

test('appendAccount restores previous files when the key write fails', (t) => {
  const dir = tempDir(t);
  const results = path.join(dir, 'out', 'accounts.jsonl');
  const keysDir = path.join(dir, 'keys-dir');
  fs.mkdirSync(path.dirname(results), { recursive: true });
  fs.mkdirSync(keysDir);
  fs.writeFileSync(results, 'previous\n', 'utf8');

  assert.throws(() => appendAccount({ resultsFile: results, keysFile: keysDir, record }));
  assert.equal(fs.readFileSync(results, 'utf8'), 'previous\n');
});

test('appendAccount removes a newly created result file on failure', (t) => {
  const dir = tempDir(t);
  const results = path.join(dir, 'out', 'accounts.jsonl');
  const keysDir = path.join(dir, 'keys-dir');
  fs.mkdirSync(keysDir);

  assert.throws(() => appendAccount({ resultsFile: results, keysFile: keysDir, record }));
  assert.equal(fs.existsSync(results), false);
});
