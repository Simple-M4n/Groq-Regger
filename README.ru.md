# groq-regger

[English](README.md) | **Русский**

Реггер аккаунтов `console.groq.com` на чистом JavaScript (Node.js 18+). Без Rust
и без сборки. Неинтерактивный: настройки — `config.json` и флаги CLI, без
промптов, TUI и чата.

Успешный прогон создаёт аккаунт Groq и записывает рабочий **API-ключ**
(`gsk_…`, значение `exposed_secret_key`) в `out/keys.txt`. Сессионные JWT,
cookie и токены magic-ссылки в результаты не попадают.

> Предыдущая Rust-версия сохранена в ветке [`rust`](../../tree/rust).

## Возможности

- Magic-link флоу Stytch B2B Discovery + PKCE (10 сетевых шагов).
- Настоящий Stytch telemetry-ID через `tools/telemetry.js` — без него Groq
  отвечает `signup_blocked`.
- Бесплатный локальный решатель Turnstile через установленный Chrome/Edge
  (`tools/turnstile.js`) с внутренними повторами.
- Временная почта: `tempmail_lol` (проверено), `mailtm` или произвольный JSON-инбокс.
- Прокси HTTP/HTTPS/SOCKS с ротацией round-robin (для HTTP и браузерных хелперов).
- Тихий вывод по умолчанию; `--verbose` включает подробную диагностику.
- В репозитории нет реальных ключей, почт и машинных путей.

## Требования

- Node.js 18+.
- Установленный Chrome или Edge (хелперы используют `playwright-core` с
  системным браузером; браузеры Playwright не скачиваются).
- Однократная установка зависимости хелперов:

```bash
cd tools
npm i
```

## Быстрый старт

```bash
cp config.example.json config.json
node groq-regger.js --selftest

node groq-regger.js --count 1
node groq-regger.js --count 10 --proxy-file proxies.txt
```

Оставляйте браузер видимым (`headless: false` по умолчанию). Headless-telemetry
часто даёт fingerprint, который Groq считает ботом (`signup_blocked`).

## Флаги CLI

```
Config / batch:
  --config FILE            альтернативный config.json (env: GROQ_REGGER_CONFIG)
  --count N                сколько аккаунтов (по умолчанию 1)
  --attempts N             попыток на аккаунт, каждый раз новая почта (по умолчанию 2)
  --out FILE               JSONL-результаты (по умолчанию out/accounts.jsonl)
  --keys-out FILE          файл ключей (по умолчанию out/keys.txt)
  --interval SEC           пауза между аккаунтами (по умолчанию 5)

Mail:
  --provider K             tempmail_lol | mailtm | api (по умолчанию tempmail_lol)
  --email ADDR             адрес для provider=api
  --email-timeout SEC      ожидание письма (по умолчанию 180)

Network:
  --proxy URL              http(s)://[user:pass@]host:port или
                           socks4:// / socks4a:// / socks5:// / socks5h://
  --proxy-type TYPE        тип для голого host:port
  --proxy-file FILE        один прокси на строку, ротация по аккаунтам
  --proxy-bypass LIST      исключения для браузера
  --insecure               не проверять TLS-сертификат

Browser helpers / timing:
  --headless               headless-хелперы (не рекомендуется)
  --headed                 принудительно видимый браузер
  --command-timeout SEC    таймаут telemetry/captcha (по умолчанию 180)
  --sitekey KEY            sitekey Turnstile
  --page-url URL           URL страницы /keys для солвера

Misc:
  --selftest               проверки сети и хелперов без регистрации
  --verbose                подробные логи
  -h, --help               справка
```

## config.json

`config.example.json` — безопасный шаблон. Основные поля:

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
  "headless": false,
  "verbose": false
}
```

`config.json`, `proxies.txt`, `out/` и `notes/` добавлены в `.gitignore`.

## Результаты

- `out/accounts.jsonl` — по одной JSON-записи на аккаунт: `email`, `password`,
  `api_key`, `org_id`, `project_id`, `created_at`.
- `out/keys.txt` — `api_key<TAB>email`, по строке на ключ.

`session_jwt`, `session_token`, cookie и токены ссылок не сохраняются.

## Почта

- `tempmail_lol` — `api.tempmail.lol`, `/generate` + `/auth/<token>`. Проверенный
  рабочий вариант.
- `mailtm` — публичный mail.tm; его домены часто в блок-листе Groq, годится
  в основном для отладки.
- `api` — любой JSON-инбокс. Укажите `apiMail.listUrl` (и опционально
  `apiMail.detailUrl`) с плейсхолдерами `{email}` / `{id}`, а адрес передайте
  через `--email` или `GROQ_EMAIL`.

## Прокси

Один прокси на строку в `proxies.txt`: `http://`, `https://`, `socks4://`,
`socks4a://`, `socks5://`, `socks5h://`, с авторизацией в виде
`type://user:pass@host:port`. Ротация — round-robin по аккаунтам. Тот же прокси
передаётся браузерным хелперам через `BROWSER_PROXY`.

## Флоу

1. `GET /signup` — прогрев сессии консоли.
2. `POST` Stytch `magic_links/email/discovery/send` с PKCE-challenge.
3. Ожидание письма «Your login request to Groq» и извлечение `?token=`.
4. `POST` `magic_links/discovery/authenticate` → `intermediate_session_token`.
5. Запуск `tools/telemetry.js` → настоящий fingerprint-ID Stytch.
6. `POST` `profile/signupb2b` → `session_jwt` + `session_token`.
7. `PUT` `user/profile` → `org_id`, `project_id`.
8. Решение Turnstile и `POST` `/api/vb-token/create` → `vb_token`.
9. `POST` `organizations/{org_id}/api_keys?project_id=…` →
   `exposed_secret_key`.

Точные endpoint'ы, заголовки и ошибки — в [HANDOFF.ru.md](HANDOFF.ru.md).

## Типовые проблемы

| Симптом | Причина / решение |
|---|---|
| `signup_blocked` | headless-telemetry или заблокированный домен почты; держите браузер видимым и используйте `tempmail_lol` |
| `CF token is required` | токен Turnstile уже использован; хелпер повторяет попытку, плюс ретрай аккаунта создаёт новую сессию |
| `page closed while waiting for a button` | Chrome упал; `tools/turnstile.js` повторяет до 3 раз |
| `timed out waiting for the login email` | проблема почтового провайдера или другой subject; увеличьте `--email-timeout` |
| `FAIL` в `--selftest` | установите `playwright-core` в `tools/` и проверьте сеть/прокси |

## Тесты

```bash
node test/groq.test.js
node groq-regger.js --selftest
```
