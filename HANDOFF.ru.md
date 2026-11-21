# HANDOFF — groq-regger (Rust)

[English](HANDOFF.md) | **Русский**

Проект: `groq-regger` (этот репозиторий)
Задача: реггер аккаунтов `console.groq.com` с выпуском рабочего Groq API-ключа.

Состояние: **готово и проверено end-to-end**. `run -n 1` создаёт аккаунт и
ключ; ключ проверен запросом `GET https://api.groq.com/openai/v1/models`
(`Authorization: Bearer <key>` → 200, 11 моделей).

---

## 1. Окружение

- Rust 1.100.0, хост `x86_64-pc-windows-gnu`.
- cargo НЕ в PATH по умолчанию. Перед сборкой:
  `$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"`
- Сборка: `cargo build --release` (из корня репозитория)
- Бинарник: `target\release\groq-regger.exe`
- Проверки: `groq-regger check` · `gen -n 3` · `run -n 1 --dry-run`
- Node.js 18+ и установленный Chrome/Edge. Зависимость tools — `playwright-core`
  (`cd tools; npm i`), браузеры Playwright скачивать не нужно.

## 2. Реальный флоу Groq (проверено живым прогоном)

1. `GET console.groq.com/signup` — без капчи.
2. `POST api.stytchb2b.groq.com/sdk/v1/b2b/magic_links/email/discovery/send`
   (`email_address`, `discovery_redirect_url`, `pkce_code_challenge`).
3. Письмо `noreply@groq.com` «Your login request to Groq», токен в `?token=`.
4. `POST .../b2b/magic_links/discovery/authenticate`
   (`discovery_magic_links_token`, `pkce_code_verifier`).
   **Ответ завёрнут:** `$.data.intermediate_session_token`.
5. `POST gste.groq.io/submit` — нужен **настоящий fingerprint-ID** из Stytch
   telemetry.js. Пустой POST даёт UUID без fingerprint → `signup_blocked`.
6. `POST api.groq.com/platform/v1/user/profile/signupb2b`
   (`x-stytch-telemetry-id`) → `session_jwt` + `session_token`.
7. `PUT api.groq.com/platform/v1/user/profile` (Bearer) → `org_id`, `project_id`.
8. `POST console.groq.com/api/vb-token/create` (`cfToken`) → `vb_token`.
   Здесь единственная капча — Cloudflare Turnstile, sitekey
   `0x4AAAAAAA04hiaY8r8_QF1r`, page `/keys`.
9. `POST api.groq.com/platform/v1/organizations/{org_id}/api_keys?project_id=…`
   (`name`, `cf_token`, `vb_token`) → `exposed_secret_key`.

## 3. Архитектура

```
src/main.rs      CLI: run / check / gen / domains
src/config.rs    config.toml → Settings
src/recipe.rs    TOML-рецепт (Step/Meta) + статическая валидация подстановок
src/flow.rs      шаги: http | email_wait | sleep | command; extract-правила
src/runner.rs    воркеры, ретраи, джиттер, Record (vars пишутся и при ошибке)
src/http.rs      reqwest: Chrome UA/заголовки, cookie Jar, прокси
src/captcha.rs   capsolver / 2captcha / command / none
src/email.rs     imap | mailtm | tempmail_lol | api
src/identity.rs  имя/логин/пароль
src/store.rs     out/<name>-<stamp>.jsonl + .keys.txt
src/util.rs      {{var}}, JSON-пути, regex, PKCE, Stytch-заголовок
tools/turnstile.js  бесплатный Turnstile через Chrome (provider = command)
tools/telemetry.js  настоящий Stytch fingerprint-ID (шаг type = command)
```

### Рецепт

```toml
[[step]]
type = "http"            # по умолчанию
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
type = "command"         # последняя непустая строка stdout → save_as
command = "node tools/telemetry.js"
save_as = "telemetry_id"
timeout_secs = 120
```

`extract`: `json:$.a.b[0]`, `regex:...`, `header:x`, `cookie:name`,
`status`, `url`, `raw`.

Переменные: `{{email}} {{password}} {{first_name}} {{last_name}} {{local_part}}
{{uuid}} {{ts}} {{proxy}} {{captcha}} {{pkce_verifier}} {{pkce_challenge}}
{{stytch_client_header}}` + все `extract`/`save_as`/`cookie_*`.
Команде передаются env `STEP_NAME` и `STEP_VARS` (JSON всех переменных).

## 4. Текущий рецепт (10 шагов)

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

## 5. Почему это работает (не сломать)

- **Telemetry.** `gste.groq.io/submit` с пустым телом → `signup_blocked`.
  ID должен быть получен настоящим `window.GetTelemetryID` из
  `api.stytchb2b.groq.com/telemetry.js` в реальном браузере. Это делает
  `tools/telemetry.js`.
- **Turnstile-хелпер.** Ставит оба cookie: `stytch_session_jwt` и
  `stytch_session` (значение — `session_token`), **не httpOnly** (Stytch SDK
  читает их через `document.cookie`). Открывает `/keys`, ждёт разблокировки
  кнопки, вводит имя, жмёт Submit. Запрос UI к `/api/vb-token/create`
  перехватывается через `page.route` и **отменяется** после получения
  `cfToken`, иначе одноразовый токен сгорает и рецепту достаётся ошибка
  «CF token is required»/duplicate.
- **Почта.** `tempmail_lol` (`api.tempmail.lol`) выдаёт адрес на `/generate`,
  чтение `/auth/<token>`. Домены `*.roomsranked.com`, `*.marchslurp.com`
  проходят Groq. `mail.tm` (`fldubai.com`) — `signup_blocked`.
  Для объёма лучше свой catch-all IMAP.

## 6. Конфиг (рабочий)

```toml
[email]
provider = "tempmail_lol"   # imap | mailtm | tempmail_lol | api

[captcha]
provider = "command"
command  = "node tools/turnstile.js"
```

`mailtm` и `tempmail_lol` адрес назначают сами; runner подменяет `{{email}}`
и `{{local_part}}` после открытия ящика. Для `imap`/`api` работает
`email.domains`.

## 7. Запуск и приёмка

```powershell
cd groq-regger
.\target\release\groq-regger.exe check
$env:RUST_LOG="info,groq_regger=debug"
.\target\release\groq-regger.exe run -n 1 -c 1
```

Успех: в `out/groq-<stamp>.jsonl` запись `"status":"ok"` с `api_key`, в
`.keys.txt` строка `key<TAB>email`, ключ отвечает 200 на
`https://api.groq.com/openai/v1/models`.

## 8. Типовые ошибки

| Симптом | Причина / лечение |
|---|---|
| `signup_blocked` | пустой telemetry-ID или заблокированный домен почты |
| `CF token is required` | Turnstile не решён / токен уже использован |
| страница логина в Chrome | не выставлен `stytch_session` или cookie httpOnly |
| `extract intermediate_session_token ... nothing` | забыт префикс `$.data.` |
| `mail.tm 429/401` | лимит IP; ждать или `tempmail_lol` |

## 9. Не ломать

- поля `Step`/`Meta` и имена шагов в рецепте;
- `check` → `validation: ok`;
- `--dry-run` не ходит в сеть (command/captcha подставляют заглушки);
- IMAP UID — строками;
- секреты не коммитить: `.keys.txt` и `out/*.jsonl` содержат ключи.
