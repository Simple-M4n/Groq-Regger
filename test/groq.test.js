// Proxy/config/storage regressions. Run: node --test test/groq.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeProxy, parseProxyList, createRotator } from '../lib/proxy.js';
import { appendKey, appendResult, loadConfig } from '../lib/store.js';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'groq-regger-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('proxy normalization covers http/https/socks', () => {
  assert.equal(normalizeProxy('proxy.example:3128'), 'http://proxy.example:3128');
  assert.equal(normalizeProxy('socks5://user:pass@host.example:1080'), 'socks5://user:pass@host.example:1080');
  assert.equal(normalizeProxy('none'), null);
});

test('proxy list rotation', () => {
  const list = parseProxyList('http://a:80\n# comment\nsocks5://b:1080');
  assert.equal(list.length, 2);
  const r = createRotator(list, false);
  assert.equal(r.next(), list[0]);
  assert.equal(r.next(), list[1]);
  assert.equal(r.next(), list[0]);
});

test('config loader rejects invalid values', (t) => {
  const file = path.join(tempDir(t), 'config.json');
  fs.writeFileSync(file, '\uFEFF{"count": 3}\n', 'utf8');
  assert.deepEqual(loadConfig(file), { count: 3 });
  fs.writeFileSync(file, '[]', 'utf8');
  assert.throws(() => loadConfig(file), /must contain a JSON object/);
  fs.writeFileSync(file, '{bad', 'utf8');
  assert.throws(() => loadConfig(file), /invalid config JSON/);
});

test('result and key append', (t) => {
  const dir = tempDir(t);
  const results = path.join(dir, 'out', 'accounts.jsonl');
  const keys = path.join(dir, 'out', 'keys.txt');
  appendResult(results, { status: 'ok', api_key: 'gsk_test', email: 'a@example.tld' });
  appendKey(keys, 'gsk_test', 'a@example.tld');
  assert.equal(fs.readFileSync(results, 'utf8').trim().split('\n').length, 1);
  assert.equal(fs.readFileSync(keys, 'utf8').trim(), 'gsk_test\ta@example.tld');
});
