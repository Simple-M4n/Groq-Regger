// Groq console registration flow — magic link (Stytch B2B Discovery + PKCE).
// Produces a working API key (exposed_secret_key), never a session token/cookie.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Transport, sleep } from './http.js';
import { makeIdentity } from './identity.js';
import { telemetryId, solveTurnstile, redactSecrets } from './commands.js';

const STYTCH_PUBLIC_TOKEN = 'public-token-live-58df57a9-a1f5-4066-bc0c-2ff942db684f';
const STYTCH_BASIC = `Basic ${Buffer.from(`${STYTCH_PUBLIC_TOKEN}:${STYTCH_PUBLIC_TOKEN}`).toString('base64')}`;
const SEND_URL = 'https://api.stytchb2b.groq.com/sdk/v1/b2b/magic_links/email/discovery/send';
const AUTH_URL = 'https://api.stytchb2b.groq.com/sdk/v1/b2b/magic_links/discovery/authenticate';
const SIGNUP_URL = 'https://api.groq.com/platform/v1/user/profile/signupb2b';
const PROFILE_URL = 'https://api.groq.com/platform/v1/user/profile';
const VB_TOKEN_URL = 'https://console.groq.com/api/vb-token/create';
const KEYS_URL = 'https://api.groq.com/platform/v1/organizations';
const LOGIN_PAGE = 'https://console.groq.com/signup';
const REDIRECT_URL = 'https://console.groq.com/authenticate';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const LOGIN_TOKEN_RE = /[?&]token=([^"'\s&<>]+)/;

function browserHeaders(extra = {}) {
  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': UA,
    ...extra,
  };
}

function stytchHeaders() {
  const blob = {
    event_id: `event-id-${randomUUID()}`,
    app_session_id: `app-session-id-${randomUUID()}`,
    persistent_id: `persistent-id-${randomUUID()}`,
    client_sent_at: new Date().toISOString(),
    timezone: 'UTC',
    app: { identifier: 'console.groq.com' },
    sdk: { identifier: 'Stytch.js Javascript SDK', version: '5.43.0' },
  };
  return {
    authorization: STYTCH_BASIC,
    'x-sdk-parent-host': 'https://console.groq.com',
    'x-sdk-client': Buffer.from(JSON.stringify(blob)).toString('base64'),
    origin: 'https://console.groq.com',
    referer: 'https://console.groq.com/',
  };
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function required(value, name, secrets = []) {
  if (value == null || value === '') throw new Error(`missing ${name} in Groq response`);
  return value;
}

async function jsonStep(transport, step, url, { method = 'POST', headers = {}, body, expect = [200], secrets = [] } = {}) {
  const res = await transport.json(url, {
    method,
    headers: browserHeaders({ 'content-type': 'application/json', ...headers }),
    body: body == null ? null : JSON.stringify(body),
  });
  if (!expect.includes(res.status)) {
    const detail = redactSecrets(res.text.slice(0, 220), secrets);
    throw new Error(`${step}: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
  }
  return res.data || {};
}

/**
 * Register one Groq account and return a record containing the API key.
 * `log` receives only safe diagnostic strings; secrets are never logged.
 */
export async function registerGroqAccount({
  config,
  proxy = null,
  mailer,
  cwd,
  log = () => {},
}) {
  const transport = new Transport({
    proxy,
    timeout: config.timeoutMs,
    insecure: config.insecure,
    onRetry: config.verbose
      ? (url, err, attempt, backoff) => log(`retry ${attempt} ${err.code || 'net'} after ${backoff}ms: ${url}`)
      : null,
  });

  const identity = makeIdentity();
  const { verifier, challenge } = pkce();

  log('step 1/10: warming console session');
  const page = await transport.request(LOGIN_PAGE, {
    headers: browserHeaders({
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'sec-fetch-dest': 'document',
      'upgrade-insecure-requests': '1',
    }),
  });
  if (page.status !== 200) throw new Error(`login-page: HTTP ${page.status}`);

  log(`step 2/10: requesting magic link for ${mailer.inbox.address}`);
  await jsonStep(transport, 'request-magic-link', SEND_URL, {
    headers: stytchHeaders(),
    body: {
      email_address: mailer.inbox.address,
      discovery_redirect_url: REDIRECT_URL,
      pkce_code_challenge: challenge,
    },
  });

  await sleep(1500);

  log('step 3/10: waiting for login email');
  const mail = await mailer.waitForLoginToken(mailer.inbox, {
    subjectContains: 'login request',
    tokenRegex: LOGIN_TOKEN_RE,
    timeout: config.emailTimeoutMs,
    log,
  });
  const loginToken = required(mail.token, 'login_token');

  log('step 4/10: exchanging magic-link token');
  const auth = await jsonStep(transport, 'authenticate-token', AUTH_URL, {
    headers: stytchHeaders(),
    body: {
      discovery_magic_links_token: loginToken,
      pkce_code_verifier: verifier,
    },
    secrets: [loginToken],
  });
  const intermediate = required(auth?.data?.intermediate_session_token, 'intermediate_session_token', [loginToken]);

  log('step 5/10: obtaining telemetry id');
  const telemetry = await telemetryId(config, { cwd, timeoutMs: config.commandTimeoutMs, log });

  log('step 6/10: registering account');
  const signup = await jsonStep(transport, 'signup-b2b', SIGNUP_URL, {
    headers: {
      'x-stytch-telemetry-id': telemetry,
      origin: 'https://console.groq.com',
      referer: 'https://console.groq.com/',
    },
    body: { intermediate_session_token: intermediate },
    expect: [200, 201],
    secrets: [intermediate, telemetry],
  });
  const sessionJwt = required(signup.session_jwt, 'session_jwt', [intermediate]);
  const sessionToken = required(signup.session_token, 'session_token', [intermediate]);

  log('step 7/10: resolving organization');
  const profile = await jsonStep(transport, 'get-org', PROFILE_URL, {
    method: 'PUT',
    headers: { authorization: `Bearer ${sessionJwt}` },
    secrets: [sessionJwt],
  });
  const org = profile?.user?.orgs?.data?.[0];
  const orgId = required(org?.id, 'org_id', [sessionJwt]);
  const projectId = required(org?.projects?.data?.[0]?.id, 'project_id', [sessionJwt]);

  log('step 8/10: solving Turnstile');
  const cfToken = await solveTurnstile(
    config,
    { ...identity, session_jwt: sessionJwt, session_token: sessionToken },
    { cwd, timeoutMs: config.commandTimeoutMs, log },
  );

  log('step 9/10: creating verification token');
  const vb = await jsonStep(transport, 'create-vb-token', VB_TOKEN_URL, {
    headers: {
      referer: 'https://console.groq.com/keys',
      cookie: `stytch_session_jwt=${sessionJwt}`,
    },
    body: { cfToken },
    secrets: [sessionJwt, cfToken],
  });
  const vbToken = required(vb.vb_token, 'vb_token', [sessionJwt, cfToken]);

  log('step 10/10: creating API key');
  const keyUrl = `${KEYS_URL}/${encodeURIComponent(orgId)}/api_keys?project_id=${encodeURIComponent(projectId)}`;
  const keyRes = await jsonStep(transport, 'create-key', keyUrl, {
    headers: {
      authorization: `Bearer ${sessionJwt}`,
      'groq-organization': orgId,
      origin: 'https://console.groq.com',
      referer: 'https://console.groq.com/keys',
    },
    body: { name: `k-${identity.uuid}`, cf_token: cfToken, vb_token: vbToken },
    expect: [200, 201],
    secrets: [sessionJwt, cfToken, vbToken],
  });
  const apiKey = required(keyRes.exposed_secret_key, 'exposed_secret_key', [sessionJwt, cfToken, vbToken]);

  return {
    status: 'ok',
    created_at: new Date().toISOString(),
    email: mailer.inbox.address,
    password: identity.password,
    api_key: apiKey,
    org_id: orgId,
    project_id: projectId,
  };
}
