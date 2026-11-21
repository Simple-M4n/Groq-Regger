import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeProxy, parseProxyList, createRotator } from '../lib/proxy.js';
import { appendKey, appendResult, loadConfig } from '../lib/store.js';

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log(`PASS  ${name}`);
};

check('proxy normalization covers http/https/socks', () => {
  assert.equal(normalizeProxy('proxy.example:3128'), 'http://proxy.example:3128');
  assert.equal(normalizeProxy('socks5://user:pass@host.example:1080'), 'socks5://user:pass@host.example:1080');
  assert.equal(normalizeProxy('none'), null);
});

check('proxy list rotation', () => {
  const list = parseProxyList('http://a:80\n# comment\nsocks5://b:1080');
  assert.equal(list.length, 2);
  const r = createRotator(list, false);
  assert.equal(r.next(), list[0]);
  assert.equal(r.next(), list[1]);
  assert.equal(r.next(), list[0]);
});

check('config loader rejects invalid values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'groq-regger-test-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{"count": 3}', 'utf8');
  assert.deepEqual(loadConfig(file), { count: 3 });
  fs.writeFileSync(file, '[]', 'utf8');
  assert.throws(() => loadConfig(file), /must contain a JSON object/);
});

check('result and key append', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'groq-regger-test-'));
  const results = path.join(dir, 'out', 'accounts.jsonl');
  const keys = path.join(dir, 'out', 'keys.txt');
  appendResult(results, { status: 'ok', api_key: 'gsk_test', email: 'a@example.tld' });
  appendKey(keys, 'gsk_test', 'a@example.tld');
  assert.equal(fs.readFileSync(results, 'utf8').trim().split('\n').length, 1);
  assert.equal(fs.readFileSync(keys, 'utf8').trim(), 'gsk_test\ta@example.tld');
});

console.log(`${passed} checks passed`);
