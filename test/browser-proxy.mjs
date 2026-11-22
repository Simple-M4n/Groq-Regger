// Browser helper proxy env mapping (no browser is launched).
// Run: node --test test/browser-proxy.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const { browserProxy } = require(path.join(ROOT, 'tools', 'browser.js'));

test('browserProxy maps URL credentials and bypass list', (t) => {
  const saved = {
    proxy: process.env.BROWSER_PROXY,
    bypass: process.env.BROWSER_PROXY_BYPASS,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  process.env.BROWSER_PROXY = 'http://user:p%40ss@proxy.example:8080';
  process.env.BROWSER_PROXY_BYPASS = 'localhost,127.0.0.1';

  assert.deepEqual(browserProxy(), {
    server: 'http://proxy.example:8080',
    username: 'user',
    password: 'p@ss',
    bypass: 'localhost,127.0.0.1',
  });

  delete process.env.BROWSER_PROXY;
  assert.equal(browserProxy(), undefined);
});
