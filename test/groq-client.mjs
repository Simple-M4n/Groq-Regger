// Stytch auth header construction (config override must actually be used).
// Run: node --test test/groq-client.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stytchHeaders } from '../lib/groq.js';

test('stytchHeaders uses the supplied public token for Basic auth', () => {
  const token = 'public-token-test-123';
  const headers = stytchHeaders(token);
  assert.equal(
    headers.authorization,
    `Basic ${Buffer.from(`${token}:${token}`).toString('base64')}`
  );
  assert.equal(headers.origin, 'https://console.groq.com');
  const blob = JSON.parse(Buffer.from(headers['x-sdk-client'], 'base64').toString('utf8'));
  assert.equal(blob.app.identifier, 'console.groq.com');
  assert.ok(blob.event_id && blob.client_sent_at);
});

test('stytchHeaders has a usable default token', () => {
  const headers = stytchHeaders();
  assert.match(headers.authorization, /^Basic /);
  assert.notEqual(headers.authorization, 'Basic ');
});
