// CLI validation without network access. Run: node --test test/cli.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const runCli = (...args) =>
  spawnSync(process.execPath, ['groq-regger.js', ...args], { cwd: ROOT, encoding: 'utf8' });

for (const args of [
  ['--count', '3abc'],
  ['--count', '2.5'],
  ['--count', '1e3'],
  ['--attempts', 'nope'],
  ['--email-timeout', '0'],
  ['--command-timeout', 'abc'],
  ['--interval=-1'],
]) {
  test(`${args.join(' ')} is rejected`, () => {
    const r = runCli(...args);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /must be an integer >= \d+/);
  });
}

test('--help exits 0 and documents the proxy/insecure flags', () => {
  const r = runCli('--help');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--proxy-bypass/);
  assert.match(r.stdout, /--insecure/);
});
