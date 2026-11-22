// Helper command contract and secret redaction. Run: node --test test/commands.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { redactSecrets, runCommand } from '../lib/commands.js';

function helperScript(t, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'groq-commands-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'helper.js');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

test('redactSecrets masks known secrets', () => {
  assert.equal(redactSecrets('abc super-secret-value def', ['super-secret-value']), 'abc <redacted> def');
  assert.equal(redactSecrets('keep short', ['short']), 'keep short');
});

test('runCommand uses the last stdout line and redacts secrets in it', async (t) => {
  const file = helperScript(t, [
    "console.error('diagnostic on stderr');",
    "console.log('noise super-secret-value');",
    "console.log('final super-secret-value');",
  ].join('\n'));
  const result = await runCommand(`node ${JSON.stringify(file)}`, {
    cwd: path.dirname(file),
    timeoutMs: 5000,
    secrets: ['super-secret-value'],
  });
  assert.equal(result, 'final <redacted>');
});

test('runCommand reports and redacts helper errors', async (t) => {
  const file = helperScript(t, "console.error('failed with super-secret-value'); process.exit(3);");
  await assert.rejects(
    runCommand(`node ${JSON.stringify(file)}`, {
      cwd: path.dirname(file),
      timeoutMs: 5000,
      secrets: ['super-secret-value'],
    }),
    /failed with <redacted>/
  );
});
