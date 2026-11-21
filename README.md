# groq-regger

**English** | [Русский](README.ru.md)

Pure JavaScript (Node.js 18+) registrator for `console.groq.com`. No Rust, no
build step. Non-interactive by design: configuration comes from `config.json`
plus CLI flags — no prompts, no TUI, no chat.

A successful run creates a Groq account and writes a working **API key**
(`gsk_…`, taken from `exposed_secret_key`) to `out/keys.txt`. Session JWTs,
cookies and magic-link tokens are never written to the result files.

> The previous Rust implementation is preserved in the [`rust`](../../tree/rust)
> branch for reference.

## Features

- Stytch B2B Discovery magic-link flow with PKCE (10 network steps).
- Real Stytch telemetry ID via `tools/telemetry.js` — required to avoid
  `signup_blocked`.
- Free local Turnstile solver via installed Chrome/Edge (`tools/turnstile.js`),
  with internal retries.
- Temporary mail: `tempmail_lol` (verified), `mailtm`, or a generic JSON inbox.
- HTTP/HTTPS/SOCKS proxies with round-robin rotation (HTTP API and browsers).
- Hidden browser by default: real Chrome window placed off-screen (no visible
  window, but a genuine browser fingerprint).
- Quiet normal output; `--verbose` enables step-by-step diagnostics.
- No real credentials, keys or machine paths in this repository.

## Requirements

- Node.js 18 or newer.
- Chrome or Edge installed (the telemetry and Turnstile helpers use
  `playwright-core` with the installed browser; Playwright browsers are not
  downloaded).
- Install the helper dependency once:

```bash
cd tools
npm i
```

## Quick start

```bash
cp config.example.json config.json
node groq-regger.js --selftest

node groq-regger.js --count 1
node groq-regger.js --count 10 --proxy-file proxies.txt
```

The browser is hidden by default (`headless: true`): a real headed Chrome is
launched with its window moved far off-screen, so nothing pops up on the
desktop but the fingerprint is identical to a normal browser. Use `--headed` if
you want to see it. `TRUE_HEADLESS=1` forces Chromium's real headless mode, but
Groq currently rejects its fingerprint with `signup_blocked`.

## CLI options

```
Config / batch:
  --config FILE            alternative config.json (env: GROQ_REGGER_CONFIG)
  --count N                accounts to register (default 1)
  --attempts N             attempts per account, fresh email each time (default 2)
  --out FILE               JSONL results (default out/accounts.jsonl)
  --keys-out FILE          key file (default out/keys.txt)
  --interval SEC           pause between accounts (default 5)

Mail:
  --provider K             tempmail_lol | mailtm | api (default tempmail_lol)
  --email ADDR             address for provider=api
  --email-timeout SEC      wait for the login email (default 180)

Network:
  --proxy URL              http(s)://[user:pass@]host:port or
                           socks4:// / socks4a:// / socks5:// / socks5h://
  --proxy-type TYPE        used when --proxy is a bare host:port
  --proxy-file FILE        one proxy per line, rotated per account
  --proxy-bypass LIST      comma-separated bypass hosts (browser)
  --insecure               skip TLS certificate verification

Browser helpers / timing:
  --headless               hide browser window (default; real Chrome off-screen)
  --headed                 show browser window
  --command-timeout SEC    telemetry/captcha helper timeout (default 180)
  --sitekey KEY            Turnstile sitekey
  --page-url URL           /keys page URL for the solver

Misc:
  --selftest               connectivity/helper checks, no registration
  --verbose                detailed diagnostics
  -h, --help               this help
```

## config.json

`config.example.json` is the safe template. Important fields:

```json
{
  "count": 1,
  "attempts": 2,
  "provider": "tempmail_lol",
  "out": "out/accounts.jsonl",
  "keysOut": "out/keys.txt",
  "emailTimeoutSec": 180,
  "commandTimeoutSec": 180,
  "captchaCommand": "node tools/turnstile.js",
  "telemetryCommand": "node tools/telemetry.js",
  "proxyFile": null,
  "headless": true,
  "verbose": false
}
```

`config.json`, `proxies.txt`, `out/` and `notes/` are gitignored.

## Output

- `out/accounts.jsonl` — one JSON object per successful account: `email`,
  `password`, `api_key`, `org_id`, `project_id`, `created_at`.
- `out/keys.txt` — `api_key<TAB>email`, one line per key.

No `session_jwt`, `session_token`, cookies or magic-link tokens are stored.

## Email providers

- `tempmail_lol` — `api.tempmail.lol`, `/generate` + `/auth/<token>`. This is
  the verified working option.
- `mailtm` — public mail.tm; its domains are often blocklisted by Groq, so it
  is mainly useful for debugging.
- `api` — any JSON inbox. Set `apiMail.listUrl` (and optionally
  `apiMail.detailUrl`) with `{email}` / `{id}` placeholders, and pass the target
  address via `--email` or `GROQ_EMAIL`.

## Proxies

One proxy per line in `proxies.txt`; `http://`, `https://`, `socks4://`,
`socks4a://`, `socks5://` and `socks5h://` are supported, with credentials in
`type://user:pass@host:port`. Proxies rotate round-robin per account. The same
proxy is passed to the browser helpers through `BROWSER_PROXY`.

## Flow

1. `GET /signup` — warm up the console session.
2. `POST` Stytch `magic_links/email/discovery/send` with a PKCE challenge.
3. Wait for the «Your login request to Groq» email and extract `?token=`.
4. `POST` `magic_links/discovery/authenticate` → `intermediate_session_token`.
5. Run `tools/telemetry.js` → real Stytch fingerprint ID.
6. `POST` `profile/signupb2b` → `session_jwt` + `session_token`.
7. `PUT` `user/profile` → `org_id`, `project_id`.
8. Solve Turnstile and `POST` `/api/vb-token/create` → `vb_token`.
9. `POST` `organizations/{org_id}/api_keys?project_id=…` →
   `exposed_secret_key`.

See [HANDOFF.md](HANDOFF.md) for exact endpoints, headers and failure modes.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `signup_blocked` | Groq risk engine; hidden mode has the same fingerprint as visible, but repeated signups from one IP get rate-limited — use `--proxy-file proxies.txt` and `tempmail_lol` |
| `CF token is required` | Turnstile token was consumed; the helper retries automatically, an account retry also starts a fresh session |
| `page closed while waiting for a button` | Chrome crashed; `tools/turnstile.js` retries up to 3 times |
| `timed out waiting for the login email` | mail provider issue or wrong subject; increase `--email-timeout` |
| `PASS/Fail` in `--selftest` | install `playwright-core` in `tools/` and check network/proxy |

## Tests

```bash
node test/groq.test.js
node groq-regger.js --selftest
```
