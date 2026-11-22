// Mail polling edge cases. Run: node --test test/mail.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pollForToken } from '../lib/mail.js';

const TOKEN_RE = /token=(\w+)/;

test('a transient detail error does not skip the message forever', async () => {
  let calls = 0;
  const messages = [{ id: 'm1', subject: 'Your login request to Groq' }];
  const result = await pollForToken({
    fetchMessages: async () => messages,
    loadMessage: async () => {
      calls += 1;
      if (calls === 1) throw new Error('temporary fetch failure');
      return 'Open token=late123 to continue';
    },
    subjectContains: 'login request',
    tokenRegex: TOKEN_RE,
    timeout: 200,
    interval: 1,
    log: () => {},
  });
  assert.equal(result.token, 'late123');
  assert.equal(calls, 2);
});

test('a message without a token is processed only once', async () => {
  let fetches = 0;
  let details = 0;
  const messages = [{ id: 'm2', subject: 'Your login request to Groq' }];
  await assert.rejects(
    pollForToken({
      fetchMessages: async () => {
        fetches += 1;
        return messages;
      },
      loadMessage: async () => {
        details += 1;
        return 'nothing useful here';
      },
      subjectContains: 'login request',
      tokenRegex: TOKEN_RE,
      timeout: 25,
      interval: 1,
      log: () => {},
    }),
    /timed out waiting for the Groq login email/
  );
  assert.equal(details, 1);
  assert.ok(fetches > 1);
});

test('token is decoded from HTML entities', async () => {
  const result = await pollForToken({
    fetchMessages: async () => [{ id: 'm3', subject: 'login request', body: 'Go to ?token=abc&amp;next=1' }],
    tokenRegex: TOKEN_RE,
    timeout: 100,
    interval: 1,
    log: () => {},
  });
  assert.equal(result.token, 'abc');
});
