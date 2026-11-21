# HANDOFF — groq-regger (Rust)

**English** | [Русский](HANDOFF.ru.md)

Project: `groq-regger` (this repository).
Goal: a registrator for `console.groq.com` accounts that issues a working Groq
API key (not a token or cookie).

Status: **done and verified end-to-end**. `run -n 1` creates an account and a
key; the key was verified with `GET https://api.groq.com/openai/v1/models`
(`Authorization: Bearer <key>` → 200, 11 models).

---

## 1. Environment

- Rust 1.100.0, host `x86_64-pc-windows-gnu`.
- `cargo` is NOT in PATH by default. Before building:
  `$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"`
- Build: `cargo build --release` (from the repository root).
- Binary: `target\release\groq-regger.exe`.
- Checks: `groq-regger check` · `gen -n 3` · `run -n 1 --dry-run`.
- Node.js 18+ and an installed Chrome/Edge. Tools dependency — `playwright-core`
  (`cd tools; npm i`); no need to download Playwright browsers.

## 2. Real Groq flow (verified in a live run)

1. `GET console.groq.com/signup` — no captcha.
2. `POST api.stytchb2b.groq.com/sdk/v1/b2b/magic_links/email/discovery/send`
   (`email_address`, `discovery_redirect_url`, `pkce_code_challenge`).
3. Email from `noreply@groq.com` «Your login request to Groq», token in `?token=`.
4. `POST .../b2b/magic_links/discovery/authenticate`
   (`discovery_magic_links_token`, `pkce_code_verifier`).
   **The response is wrapped:** `$.data.intermediate_session_token`.
5. `POST gste.groq.io/submit` — a **real fingerprint ID** from Stytch
   telemetry.js is required. An empty POST gives a UUID without a fingerprint →
   `signup_blocked`.
6. `POST api.groq.com/platform/v1/user/profile/signupb2b`
   (`x-stytch-telemetry-id`) → `session_jwt` + `session_token`.
7. `PUT api.groq.com/platform/v1/user/profile` (Bearer) → `org_id`, `project_id`.
8. `POST console.groq.com/api/vb-token/create` (`cfToken`) → `vb_token`.
   This is the only captcha in the chain — Cloudflare Turnstile, sitekey
   `0x4AAAAAAA04hiaY8r8_QF1r`, page `/keys`.
9. `POST api.groq.com/platform/v1/organizations/{org_id}/api_keys?project_id=…`
   (`name`, `cf_token`, `vb_token`) → `exposed_secret_key` (the API key).

## 3. Architecture

```
src/main.rs      CLI: run / check / gen / domains
src/config.rs    config.toml → Settings
src/recipe.rs    TOML recipe (Step/Meta) + static validation of substitutions
src/flow.rs      steps: http | email_wait | sleep | command; extract rules
src/runner.rs    workers, retries, jitter, Record (vars written even on error)
src/http.rs      reqwest: Chrome UA/headers, cookie jar, proxy
src/captcha.rs   capsolver / 2captcha / command / none
src/email.rs     imap | mailtm | tempmail_lol | api
src/identity.rs  name / login / password
src/store.rs     out/<name>-<stamp>.jsonl + .keys.txt
src/util.rs      {{var}}, JSON paths, regex, PKCE, Stytch header
tools/turnstile.js  free Turnstile via Chrome (provider = command)
tools/telemetry.js  real Stytch fingerprint ID (step type = command)
```

### Recipe

```toml
[[step]]
type = "http"            # default
method = "POST"
path = "/api/..."
headers = { ... }
json = { email = "{{email}}" }
expect_status = [200]
capture_cookies = true
extract = { api_key = "json:$.key" }
captcha = "turnstile"
sitekey = "0x..."
captcha_var = "cf_token"
captcha_optional = true

[[step]]
type = "email_wait"
subject_contains = "login request"
link_regex = '''[?&]token=([^"'\s&<>]+)'''
timeout_secs = 180
save_as = "login_token"

[[step]]
type = "sleep"
ms = 1500

[[step]]
type = "command"         # last non-empty stdout line → save_as
command = "node tools/telemetry.js"
save_as = "telemetry_id"
timeout_secs = 120
```

`extract`: `json:$.a.b[0]`, `regex:...`, `header:x`, `cookie:name`,
`status`, `url`, `raw`.

Variables: `{{email}} {{password}} {{first_name}} {{last_name}} {{local_part}}
{{uuid}} {{ts}} {{proxy}} {{captcha}} {{pkce_verifier}} {{pkce_challenge}}
{{stytch_client_header}}` plus all `extract` / `save_as` / `cookie_*` values.
A command receives env `STEP_NAME` and `STEP_VARS` (JSON with all variables).

## 4. Current recipe (10 steps)

```
 1 login-page          GET  /signup
 2 request-magic-link  POST Stytch discovery/send
 3 settle              sleep 1500
 4 wait-login-mail     email_wait → login_token
 5 authenticate-token  POST discovery/authenticate → $.data.intermediate_session_token
 6 get-telemetry-id    command: node tools/telemetry.js → telemetry_id
 7 signup-b2b          POST signupb2b → session_jwt, session_token
 8 get-org             PUT user/profile → org_id, project_id
 9 create-vb-token     POST /api/vb-token/create {cfToken} → vb_token
10 create-key          POST organizations/{org_id}/api_keys?... → exposed_secret_key
```

## 5. Why it works (don't break this)

- **Telemetry.** `gste.groq.io/submit` with an empty body → `signup_blocked`.
  The ID must come from a real `window.GetTelemetryID` call in
  `api.stytchb2b.groq.com/telemetry.js` inside a real browser. That is what
  `tools/telemetry.js` does.
- **Turnstile helper.** Sets both cookies: `stytch_session_jwt` and
  `stytch_session` (value = `session_token`), **not httpOnly** (the Stytch SDK
  reads them via `document.cookie`). Opens `/keys`, waits for the button to be
  enabled, enters the name, clicks Submit. The UI request to
  `/api/vb-token/create` is intercepted via `page.route` and **cancelled** after
  reading `cfToken`, otherwise the one-shot token is burned and the recipe gets
  «CF token is required» / duplicate errors.
- **Email.** `tempmail_lol` (`api.tempmail.lol`) issues an address on `/generate`,
  reads via `/auth/<token>`. Domains `*.roomsranked.com`, `*.marchslurp.com`
  pass Groq. `mail.tm` (`fldubai.com`) → `signup_blocked`.
  For volume, a catch-all IMAP of your own is better.

## 6. Config (working)

```toml
[email]
provider = "tempmail_lol"   # imap | mailtm | tempmail_lol | api

[captcha]
provider = "command"
command  = "node tools/turnstile.js"
```

`mailtm` and `tempmail_lol` assign the address themselves; the runner overrides
`{{email}}` and `{{local_part}}` after opening the mailbox. For `imap`/`api`,
`email.domains` is used.

## 7. Run and acceptance

```powershell
cd groq-regger
.\target\release\groq-regger.exe check
$env:RUST_LOG="info,groq_regger=debug"
.\target\release\groq-regger.exe run -n 1 -c 1
```

Success: an `"status":"ok"` record with `api_key` in
`out/groq-<stamp>.jsonl`, a `key<TAB>email` line in `.keys.txt`, and the key
returning 200 from `https://api.groq.com/openai/v1/models`.

## 8. Typical errors

| Symptom | Cause / fix |
|---|---|
| `signup_blocked` | empty telemetry ID or a blocklisted email domain |
| `CF token is required` | Turnstile not solved / token already used |
| login page in Chrome | `stytch_session` not set or cookie is httpOnly |
| `extract intermediate_session_token ... nothing` | missing `$.data.` prefix |
| `mail.tm 429/401` | IP limit; wait or use `tempmail_lol` |

## 9. Don't break

- `Step`/`Meta` fields and step names in the recipe;
- `check` → `validation: ok`;
- `--dry-run` makes no network calls (command/captcha use stubs);
- IMAP UIDs as strings;
- never commit secrets: `.keys.txt` and `out/*.jsonl` contain keys.
