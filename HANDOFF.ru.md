# HANDOFF — groq-regger (JavaScript)

[English](HANDOFF.md) | **Русский**

Проект: `groq-regger`, ветка `main` (чистый JavaScript).
Предыдущая Rust-реализация сохранена в ветке `rust`.

Задача: неинтерактивный реггер `console.groq.com`, который выдаёт рабочий
**API-ключ Groq** (`gsk_…`), а не токен или cookie.

---

## 1. Окружение

- Node.js 18+ (проверено на Node 26). Rust и сборка не нужны.
- Зависимость хелперов: `playwright-core` в `tools/` (`cd tools; npm i`).
  Браузеры Playwright не скачиваются — используется установленный Chrome/Edge.
- Скрытый браузер включён по умолчанию: `headless: true`. Это **обычный** Chrome
  с `--window-position=-2400,-2400`: окно не видно, но все сигналы fingerprint
  совпадают с видимым браузером (проверено посегментно), а на Windows окно
  дополнительно прячется из панели задач через `ShowWindow(SW_HIDE)`. Настоящий
  headless Chromium (`TRUE_HEADLESS=1`) даёт другой fingerprint и
  `signup_blocked`.
- Если PowerShell блокирует `npm.ps1`, запускайте npm через CLI-скрипт, например
  `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" i`.

## 2. Проверенный флоу Groq

1. `GET https://console.groq.com/signup` — без капчи.
2. `POST https://api.stytchb2b.groq.com/sdk/v1/b2b/magic_links/email/discovery/send`
   — `email_address`, `discovery_redirect_url`, `pkce_code_challenge`.
   Basic Auth — публичный токен Stytch дважды (`token:token`), плюс заголовки
   `x-sdk-parent-host` и сгенерированный `x-sdk-client`.
3. Письмо от `noreply@groq.com` «Your login request to Groq», токен в `?token=`.
4. `POST .../b2b/magic_links/discovery/authenticate` с
   `discovery_magic_links_token` + `pkce_code_verifier`
   → `$.data.intermediate_session_token`.
5. `tools/telemetry.js` запускает настоящий `window.GetTelemetryID` из Stytch
   telemetry.js в Chrome/Edge и печатает 36-символьный ID. Пустой POST на
   `gste.groq.io/submit` даёт UUID без fingerprint → `signup_blocked`.
6. `POST https://api.groq.com/platform/v1/user/profile/signupb2b`
   с `x-stytch-telemetry-id` → `session_jwt` + `session_token`.
7. `PUT https://api.groq.com/platform/v1/user/profile` (Bearer)
   → `$.user.orgs.data[0].id` и `.projects.data[0].id`.
8. Turnstile (sitekey `0x4AAAAAAA04hiaY8r8_QF1r`, страница `/keys`) решается
   `tools/turnstile.js`; `POST https://console.groq.com/api/vb-token/create`
   с `{cfToken}` → `vb_token`. Собственный запрос UI перехватывается и
   отменяется, чтобы одноразовый токен не сгорел.
9. `POST https://api.groq.com/platform/v1/organizations/{org_id}/api_keys?project_id=…`
   с `{name, cf_token, vb_token}` → `exposed_secret_key`.

## 3. Архитектура

```
groq-regger.js      CLI: конфиг + флаги, цикл по аккаунтам, запись результатов
lib/http.js         HTTP/HTTPS-транспорт + прокси HTTP(S)/SOCKS
lib/proxy.js        нормализация прокси, список, ротация
lib/mail.js         провайдеры tempmail_lol | mailtm | api, извлечение токена
lib/identity.js     имена / логин / пароль / UUID
lib/commands.js     запуск внешних команд, обёртки telemetry и Turnstile
lib/groq.js         10 шагов флоу; в результате только API-ключ
lib/store.js        дописывание JSONL и файла ключей
tools/*.js          браузерные хелперы (CommonJS, tools/node_modules)
test/groq.test.js   юнит-проверки (node test/groq.test.js)
```

В записи намеренно нет `session_jwt`, `session_token`, cookie и токенов ссылки.
Сохраняются только `api_key`, почта/пароль и id организации.

## 4. Конфиг

Скопируйте `config.example.json` в `config.json`. Основные поля:

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

Флаги CLI перекрывают значения конфига. Прокси ротируются по аккаунтам и
передаются браузерным хелперам через `BROWSER_PROXY`.

## 5. Надёжность Turnstile

`tools/turnstile.js` повторяет **весь сеанс браузера** до
`TURNSTILE_RETRIES` раз (по умолчанию 3). Ожидание кнопок — ручной цикл опроса,
который переживает замену execution context и рано замечает закрытую страницу.
Токен перехватывается из запроса `/api/vb-token/create`, после чего запрос
отменяется — токен остаётся одноразовым и свежим для шага 9.

Ретрай на уровне аккаунта (`--attempts`, по умолчанию 2) создаёт новую почту и
новую сессию.

## 6. Приёмка

```bash
node groq-regger.js --selftest
node groq-regger.js --count 1 --attempts 1 --verbose
node groq-regger.js --count 10 --proxy-file proxies.txt
```

Успех: `summary: 1/1 API keys written to .../out/keys.txt`, строка
`gsk_…<TAB>email` в `out/keys.txt` и соответствующая запись в
`out/accounts.jsonl`. Ключ проверяется запросом:

```
GET https://api.groq.com/openai/v1/models
Authorization: Bearer <key>
```

## 7. Не ломать

- `exposed_secret_key` должен оставаться успешным результатом; никогда не
  выдавать сессионный токен.
- `headless: true` = обычный Chrome с окном вне экрана; настоящий headless
  ломает регистрацию.
- Прогон fail-fast: `signup_blocked` или HTTP 429 от почты сразу останавливает
  запуск, а не крутит попытки — не превращать обратно в цикл ретраев.
- Скрытое окно уходит за экран и прячется из панели задач на Windows (на других
  ОС — без изменений); после `ShowWindow(SW_HIDE)` fingerprint обязан оставаться
  идентичным видимому браузеру.
- Если `signup_blocked` появляется даже в `--headed`, IP/устройство временно
  ограничено Groq после нескольких регистраций — подождите или используйте
  прокси.
- Не коммитить секреты и машинные пути (`out/`, `config.json`, `proxies.txt`
  в `.gitignore`).
- Хелперы должны печатать токен/ID последней строкой stdout, диагностику —
  в stderr.
