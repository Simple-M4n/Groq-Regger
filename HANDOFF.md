# HANDOFF — groq-regger (JavaScript)

**English** | [Русский](HANDOFF.ru.md)

Project: `groq-regger`, `main` branch (pure JavaScript).
The previous Rust implementation is kept in the `rust` branch.

Goal: a non-interactive registrator for `console.groq.com` that outputs a
working Groq **API key** (`gsk_…`), not a token or cookie.

---

## 1. Environment

- Node.js 20+ (tested on Node 26; required by `playwright-core` 1.65). No Rust,
  no build step.
- Helper dependency: `playwright-core` in `tools/` (`cd tools; npm i`).
  Playwright browsers are not downloaded; installed Chrome/Edge is used.
- Hidden browser is the default: `headless: true`. This is a **headed** Chrome
  with `--window-position=-2400,-2400`, so no window is visible but the
  fingerprint is byte-for-byte identical to a visible browser (verified with a
  signal-by-signal comparison); on Windows the off-screen window is additionally
  hidden from the taskbar with `ShowWindow(SW_HIDE)`. Real Chromium headless
  (`TRUE_HEADLESS=1`) has a different fingerprint and gets `signup_blocked`.
- If `npm.ps1` is blocked by PowerShell policy, run npm via its CLI script, e.g.
  `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" i`.

## 2. Verified Groq flow

1. `GET https://console.groq.com/signup` — no captcha.
2. `POST https://api.stytchb2b.groq.com/sdk/v1/b2b/magic_links/email/discovery/send`
   — `email_address`, `discovery_redirect_url`, `pkce_code_challenge`.
   Basic auth uses the public Stytch token twice (`token:token`); headers include
   `x-sdk-parent-host` and a generated `x-sdk-client` blob.
3. Email from `noreply@groq.com` «Your login request to Groq», token in `?token=`.
4. `POST .../b2b/magic_links/discovery/authenticate` with
   `discovery_magic_links_token` + `pkce_code_verifier`
   → `$.data.intermediate_session_token`.
5. `tools/telemetry.js` runs the real `window.GetTelemetryID` from Stytch
   telemetry.js in Chrome/Edge and prints a 36-char ID. An empty POST to
   `gste.groq.io/submit` gives a UUID without a fingerprint → `signup_blocked`.
6. `POST https://api.groq.com/platform/v1/user/profile/signupb2b`
   with `x-stytch-telemetry-id` → `session_jwt` + `session_token`.
7. `PUT https://api.groq.com/platform/v1/user/profile` (Bearer)
   → `$.user.orgs.data[0].id` and `.projects.data[0].id`.
8. Turnstile (sitekey `0x4AAAAAAA04hiaY8r8_QF1r`, page `/keys`) is solved by
   `tools/turnstile.js`; `POST https://console.groq.com/api/vb-token/create`
   with `{cfToken}` → `vb_token`. The UI's own request is intercepted and
   aborted so the one-shot token is not consumed.
9. `POST https://api.groq.com/platform/v1/organizations/{org_id}/api_keys?project_id=…`
   with `{name, cf_token, vb_token}` → `exposed_secret_key`.

## 3. Architecture

```
groq-regger.js      CLI: config + flags, account loop, result writing
lib/http.js         node:http/https transport with HTTP(S)/SOCKS proxy support
lib/proxy.js        proxy normalization, list parsing, rotation
lib/mail.js         tempmail_lol | mailtm | api providers, magic-token extraction
lib/identity.js     names / login / password / UUID generation
lib/commands.js     external command runner, telemetry + Turnstile wrappers
lib/groq.js         10-step flow, produces only the API key in the record
lib/store.js        append-only JSONL + key file
tools/*.js          browser helpers (CommonJS, use tools/node_modules)
test/*.mjs          unit checks (run: npm test / npm run test:unit)
```

Records intentionally omit `session_jwt`, `session_token`, cookies and
magic-link tokens. Only `api_key`, email/password and org ids are stored locally.

## 4. Config

Copy `config.example.json` to `config.json`. Key fields:

```json
{
  "provider": "tempmail_lol",
  "attempts": 2,
  "emailTimeoutSec": 180,
  "commandTimeoutSec": 180,
  "captchaCommand": "node tools/turnstile.js",
  "telemetryCommand": "node tools/telemetry.js",
  "proxyFile": null,
  "headless": true,
  "verbose": false
}
```

CLI flags override config values. Proxies are rotated per account and passed to
browser helpers via `BROWSER_PROXY`, with `BROWSER_PROXY_BYPASS` and
`BROWSER_INSECURE` forwarding `proxyBypass` / `insecure`. Numeric flags are
strict integers. `appendAccount()` writes the JSONL record and key file as one
operation with rollback on failure.

## 5. Turnstile reliability

`tools/turnstile.js` retries the **entire browser session** up to
`TURNSTILE_RETRIES` times (default 3). Button waiting is a manual polling loop
that survives execution-context replacements and detects a closed page early.
The token is captured from the intercepted `/api/vb-token/create` request; the
request is then aborted so the token stays single-use and fresh for step 9.

Account-level `--attempts` (default 2) creates a fresh email and session on
each retry.

## 6. Acceptance

```bash
npm test                              # browser-free unit checks
node groq-regger.js --selftest        # network/mailbox/module check (creates a mailbox)
node groq-regger.js --count 1 --attempts 1 --verbose
node groq-regger.js --count 10 --proxy-file proxies.txt
```

Success: `summary: 1/1 API keys written to .../out/keys.txt`, one line
`gsk_…<TAB>email` in `out/keys.txt`, and a matching record in
`out/accounts.jsonl`. A key can be checked with:

```
GET https://api.groq.com/openai/v1/models
Authorization: Bearer <key>
```

## 7. Don't break

- Keep `exposed_secret_key` as the success value; never emit a session token.
- Keep `headless: true` (off-screen headed Chrome); true headless breaks signup.
- The batch is fail-fast: `signup_blocked` or a mail HTTP 429 stops the run
  instead of looping over attempts — do not turn it back into a retry loop.
- The hidden window is moved off-screen and hidden from the taskbar on Windows
  (no-op elsewhere); after `ShowWindow(SW_HIDE)` the fingerprint must stay
  identical to a visible browser.
- If `signup_blocked` appears even in `--headed` mode, the IP/device is
  rate-limited by Groq after several signups — wait or use proxies.
- Keep secrets and machine paths out of tracked files (`out/`, `config.json`,
  `proxies.txt` are ignored).
- Keep the stdout contract of the tools: token/ID on the last stdout line,
  diagnostics on stderr.
