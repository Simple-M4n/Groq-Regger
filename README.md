# groq-regger

**English** | [Русский](README.ru.md)

An account registrator for `console.groq.com` written in Rust. This is not a
one-off script tied to the current markup, but a flow engine: registration steps
are described in a TOML recipe, while the code handles HTTP steps, email
waiting, captcha solving, proxy rotation and result export. When the service
changes its routes, you edit the recipe — not the code.

The result of a successful run is a working **Groq API key**
(`exposed_secret_key`, i.e. `gsk_…`), not a session token or cookie.

## Contents

```
src/
  main.rs      CLI: run / check / gen / domains
  config.rs    config.toml (run, http, captcha, email)
  recipe.rs    TOML flow recipe + static validation of substitutions
  flow.rs      step executor: http, email_wait, sleep; extract rules
  runner.rs    worker pool, retries, jitter, result writer
  http.rs      reqwest client: UA profile, cookie jar, proxy
  captcha.rs   capsolver / 2captcha (Turnstile, reCAPTCHA v2/v3, hCaptcha)
  email.rs     email receiving: IMAP catch-all, mail.tm, arbitrary JSON API
  identity.rs  name / login / password generation
  store.rs     JSONL results + separate key file
  util.rs      {{var}} templates, JSON paths, regex extraction
recipes/
  groq.toml    the Groq flow itself
tools/
  telemetry.js  real Stytch telemetry ID
  turnstile.js  local Turnstile solver via Chrome
```

## Build

```bash
cargo build --release
# binary: target/release/groq-regger(.exe)
```

Minimal profile: `rustup toolchain install stable`. On Windows without MSVC,
use the GNU host (`rustup-init --default-host x86_64-pc-windows-gnu`) with
mingw-w64 `gcc` in PATH.

## Quick start

```bash
cp config.example.toml config.toml     # fill in email / captcha / proxies
cp proxies.example.txt proxies.txt     # optional

groq-regger check                      # validate recipe and environment
groq-regger run -n 1 --dry-run         # render steps without network calls
groq-regger run -n 10 -c 4             # 10 registrations, 4 in parallel
```

`run` writes:

- `out/groq-<stamp>.jsonl` — one line per attempt: email, password, api_key,
  proxy, duration and all flow variables;
- `out/groq-<stamp>.keys.txt` — `key<TAB>email` for successful runs only.

## Recipe: the step model

```toml
[[step]]
name   = "signup"          # label in logs
type   = "http"            # http (default) | email_wait | sleep
method = "POST"
path   = "/api/auth/sign-up/email"   # relative to meta.base_url or a full URL
headers = { referer = "https://console.groq.com/signup" }
json   = { email = "{{email}}", password = "{{password}}" }
expect_status   = [200, 201, 204]    # any 2xx by default
capture_cookies = true               # split cookies into {{cookie_<name>}}
extract = { api_key = "json:$.key" }

[[step]]
name             = "wait-verify-mail"
type             = "email_wait"
subject_contains = "verify"
link_regex       = '''https?://[^"'\s<>]+verify[^"'\s<>]*'''
timeout_secs     = 180
save_as          = "verify_link"
```

Substitutions: `{{first_name}} {{last_name}} {{email}} {{local_part}} {{password}}
{{uuid}} {{ts}} {{proxy}} {{captcha}}` plus everything previous steps put there
via `extract` / `save_as` / `capture_cookies`.

`extract` rules:

| Rule | Meaning |
|---|---|
| `json:$.a.b[0].c` | path in the JSON response |
| `regex:...` | first capture group (or the whole match) in the body |
| `header:x-csrf` | response header |
| `cookie:name` | cookie from the shared jar |
| `status` / `url` / `raw` | status code, URL, whole body |

Captcha in an HTTP step: `captcha = "turnstile"`, `sitekey = "0x…"`, optional
`page_url` and `captcha_var` (where to put the token; default `{{captcha}}`).

The `meta.success_var` variable (default `api_key`) is what goes into the
result's `api_key` and into `.keys.txt`.

## Email

- `imap` — catch-all domain. Messages already in the mailbox are marked as seen
  by UID on open, then only new ones are read; MIME is decoded (QP,
  encoded-word), links and codes are extracted with regex from the body.
- `mailtm` — public mail.tm: the domain comes from the API, mailbox is created
  on the fly. For Groq-like services public domains are usually blocklisted, so
  this mode is for debugging the flow, not for volume.
- `tempmail_lol` — `api.tempmail.lol`: the address is issued by the service on
  `/generate`, reading via `/auth/<token>`. Domains like `*.roomsranked.com`
  pass Groq registration (verified), but the service has no uptime guarantees.
- `api` — any HTTP-JSON inbox (your own service, mailhook, 1secmail-compatible):
  `list_url` with `{email}`, optional `detail_url` with `{id}`, configurable
  fields.

## Captcha

Built-in solvers: `capsolver` (AntiTurnstileTaskProxyLess / ReCaptchaV2|V3 /
HCaptcha), `twocaptcha` and `command`. The key is in `[captcha] api_key`.

`provider = "none"` — a flow without a captcha: a step with `captcha = …` and no
solver fails with a clear error, but with `captcha_optional = true` (used for the
Turnstile on key creation) it first tries the request without a token.

### Free Turnstile via your own browser

`provider = "command"` runs an external program and takes the token from the
last non-empty stdout line. The program receives env variables `CAPTCHA_KIND`,
`CAPTCHA_SITEKEY`, `CAPTCHA_PAGE_URL`, `CAPTCHA_ACTION` and `CAPTCHA_VARS` (JSON
with all recipe variables, including `session_jwt`).

```powershell
cd tools
npm i                 # playwright-core, no browser download
```

```toml
[captcha]
provider = "command"
command  = "node tools/turnstile.js"
```

`tools/turnstile.js` opens an installed Chrome/Edge (non-headless), sets the
`stytch_session_jwt` and `stytch_session` cookies, goes to `/keys`, clicks
«Create API Key», waits for Turnstile to pass and prints `cfToken`. The UI
request to `/api/vb-token/create` is intercepted and cancelled so the one-shot
token is not burned before the recipe uses it. If the browser is not in PATH,
set `CHROME_PATH`.

### Real telemetry ID (required)

An empty `POST https://gste.groq.io/submit` returns a UUID, but without a
fingerprint — `signupb2b` then answers `400 code=signup_blocked`. The
`get-telemetry-id` step has `type = "command"` and runs `node tools/telemetry.js`:
the script opens `console.groq.com/signup` in Chrome and calls the real
`window.GetTelemetryID` from Stytch telemetry.js. With such an ID registration
passes (verified).

## Behaviour and limits

- `run.concurrency` workers, `run.delay_ms_min/max` jitter before each attempt.
- `run.max_attempts` — attempts per registration, each with a fresh email and
  (when available) the next proxy from the pool.
- 429 and 5xx are marked retryable; recipe errors (unexpected status, empty
  extract) are retried too, but the reason is written to the log and to the
  record's `error` field.
- Proxies: one proxy per line, `http://` / `socks5://`, round-robin.

## Limitations

The Groq flow is a **magic link** flow (Stytch B2B Discovery): email → the
«Your login request to Groq» message → token from the link → exchange for an
intermediate session → registration in `api.groq.com/platform/v1` → API key.
There is no password and no captcha on the login form.

All network paths and field names were checked against the console bundle, the
Stytch bootstrap response and a live run. The `discovery/authenticate` response
is wrapped in `data` (`$.data.intermediate_session_token`). The only captcha in
the chain is Turnstile on key creation (`/keys`); it is solved by the free
`command` provider.

Verified end-to-end: `run -n 1` creates an account and a working key
(`GET /openai/v1/models` → 200). A public email domain may be blocklisted by
Groq — then you get `signup_blocked`; `tempmail.lol` currently passes.
