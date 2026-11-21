# groq-regger

Реггер аккаунтов под console.groq.com на Rust. Не «одноразовый скрипт под текущую
вёрстку», а движок флоу: шаги регистрации описаны в TOML-рецепте, код умеет
HTTP-шаги, ожидание письма, решение капчи, прокси-ротацию и выгрузку результатов.
Меняются маршруты у сервиса — правится рецепт, не код.

## Состав

```
src/
  main.rs      CLI: run / check / gen / domains
  config.rs    config.toml (run, http, captcha, email)
  recipe.rs    TOML-рецепт флоу + статическая валидация подстановок
  flow.rs      исполнитель шагов: http, email_wait, sleep; extract-правила
  runner.rs    пул воркеров, ретраи, джиттер, запись результатов
  http.rs      сборка reqwest-клиента: UA-профиль, cookie jar, прокси
  captcha.rs   capsolver / 2captcha (Turnstile, reCAPTCHA v2/v3, hCaptcha)
  email.rs     приём почты: IMAP catch-all, mail.tm, произвольный JSON API
  identity.rs  генерация имени/логина/пароля
  store.rs     JSONL-результаты + отдельный файл ключей
  util.rs      шаблоны {{var}}, JSON-пути, regex-извлечение
recipes/
  groq.toml    сам флоу Groq
tools/
  telemetry.js  настоящий Stytch telemetry-id
  turnstile.js  локальный решатель Turnstile через Chrome
```

## Сборка

```bash
cargo build --release
# бинарник: target/release/groq-regger(.exe)
```

Минимальный профиль: `rustup toolchain install stable`. Под Windows без MSVC
ставится GNU-хост (`rustup-init --default-host x86_64-pc-windows-gnu`) при
наличии mingw-w64 `gcc` в PATH.

## Быстрый старт

```bash
cp config.example.toml config.toml     # заполнить почту/капчу/прокси
cp proxies.example.txt proxies.txt     # опционально

groq-regger check                      # валидация рецепта и окружения
groq-regger run -n 1 --dry-run         # рендер шагов без сети
groq-regger run -n 10 -c 4             # 10 регистраций, 4 параллельно
```

`run` пишет:

- `out/groq-<stamp>.jsonl` — по строке на попытку: email, пароль, api_key,
  прокси, длительность, все переменные флоу;
- `out/groq-<stamp>.keys.txt` — `ключ<TAB>email` только для успешных.

## Рецепт: модель шагов

```toml
[[step]]
name   = "signup"          # метка в логах
type   = "http"            # http (по умолчанию) | email_wait | sleep
method = "POST"
path   = "/api/auth/sign-up/email"   # относительный к meta.base_url либо полный URL
headers = { referer = "https://console.groq.com/signup" }
json   = { email = "{{email}}", password = "{{password}}" }
expect_status   = [200, 201, 204]    # по умолчанию любой 2xx
capture_cookies = true               # разложить cookie в {{cookie_<name>}}
extract = { api_key = "json:$.key" }

[[step]]
name             = "wait-verify-mail"
type             = "email_wait"
subject_contains = "verify"
link_regex       = '''https?://[^"'\s<>]+verify[^"'\s<>]*'''
timeout_secs     = 180
save_as          = "verify_link"
```

Подстановки: `{{first_name}} {{last_name}} {{email}} {{local_part}} {{password}}
{{uuid}} {{ts}} {{proxy}} {{captcha}}` плюс всё, что положили предыдущие шаги
через `extract` / `save_as` / `capture_cookies`.

Правила `extract`:

| Правило | Смысл |
|---|---|
| `json:$.a.b[0].c` | путь в JSON-ответе |
| `regex:...` | первая группа (или весь матч) в теле |
| `header:x-csrf` | заголовок ответа |
| `cookie:name` | cookie из общего jar |
| `status` / `url` / `raw` | код, URL, тело целиком |

Капча в HTTP-шаге: `captcha = "turnstile"`, `sitekey = "0x…"`, опционально
`page_url` и `captcha_var` (куда положить токен, по умолчанию `{{captcha}}`).

Переменная `meta.success_var` (по умолчанию `api_key`) — то, что попадёт в
`api_key` результата и в `.keys.txt`.

## Почта

- `imap` — catch-all домен. При открытии ящика уже лежащие письма
  помечаются как seen по UID, дальше читаются только новые; MIME декодируется
  (QP, encoded-word), ссылки и коды достаются regex-ом из тела.
- `mailtm` — публичный mail.tm: домен берётся из API, ящик создаётся на лету.
  Для Groq-подобных сервисов публичные домены обычно в блок-листах, так что это
  режим для отладки флоу, не для объёма.
- `tempmail_lol` — `api.tempmail.lol`: адрес выдаёт сам сервис на `/generate`,
  чтение через `/auth/<token>`. Домены вида `*.roomsranked.com` проходят
  регистрацию Groq (проверено), но сервис без гарантий uptime.
- `api` — любой HTTP-JSON-инбокс (свой сервис, mailhook, 1secmail-совместимый):
  `list_url` c `{email}`, опциональный `detail_url` c `{id}`, поля настраиваются.

## Капча

Встроены `capsolver` (AntiTurnstileTaskProxyLess / ReCaptchaV2|V3 / HCaptcha),
`twocaptcha` и `command`. Ключ — в `[captcha] api_key`.

`provider = "none"` — флоу без капчи: шаг с `captcha = …` без солвера падает с
внятной ошибкой, но при `captcha_optional = true` (так помечен Turnstile на
создании ключа) сначала пробует запрос без токена.

### Бесплатный Turnstile через свой браузер

`provider = "command"` запускает внешнюю программу и берёт токен из последней
непустой строки stdout. Программе передаются env-переменные `CAPTCHA_KIND`,
`CAPTCHA_SITEKEY`, `CAPTCHA_PAGE_URL`, `CAPTCHA_ACTION` и `CAPTCHA_VARS` (JSON
со всеми переменными рецепта, включая `session_jwt`).

```powershell
cd tools
npm i                 # playwright-core, без скачивания браузеров
```

```toml
[captcha]
provider = "command"
command  = "node tools/turnstile.js"
```

`tools/turnstile.js` открывает установленный Chrome/Edge (не headless), ставит
cookie `stytch_session_jwt` и `stytch_session`, заходит на `/keys`, жмёт
«Create API Key», ждёт прохождения Turnstile и печатает `cfToken`. Запрос UI к
`/api/vb-token/create` перехватывается и отменяется, чтобы одноразовый токен не
сгорел до вызова из рецепта. Если браузера нет в PATH — задай `CHROME_PATH`.

### Настоящий telemetry-id (обязательно)

Пустой `POST https://gste.groq.io/submit` возвращает UUID, но без fingerprint —
на `signupb2b` Groq отвечает `400 code=signup_blocked`. Шаг `get-telemetry-id`
имеет `type = "command"` и запускает `node tools/telemetry.js`: скрипт открывает
`console.groq.com/signup` в Chrome и вызывает настоящий `window.GetTelemetryID`
из Stytch telemetry.js. С таким ID регистрация проходит (проверено).

## Поведение и лимиты

- `run.concurrency` воркеров, `run.delay_ms_min/max` джиттер перед каждой попыткой.
- `run.max_attempts` — попыток на одну регистрацию, каждая с новой почтой и
  (при наличии) следующим прокси из пула.
- 429 и 5xx помечаются retryable; ошибки рецепта (неожиданный статус, пустой
  extract) тоже ретраятся, но причина пишется в лог и в `error` записи.
- Прокси: одна строка — один прокси, `http://` / `socks5://`, round-robin.

## Ограничения

Флоу Groq — **magic link** (Stytch B2B Discovery): email → письмо «Your login
request to Groq» → токен из ссылки → обмен на intermediate session → регистрация
в `api.groq.com/platform/v1` → API-ключ. Пароля и капчи на форме входа нет.

Все сетевые пути и имена полей сверены с бандлом консоли, bootstrap-ответом
Stytch и живым прогоном. Ответ `discovery/authenticate` завёрнут в `data`
(`$.data.intermediate_session_token`). Единственная капча в цепочке — Turnstile
на создании ключа (`/keys`); она решается бесплатным `command`-провайдером.

Проверено end-to-end: `run -n 1` создаёт аккаунт и рабочий ключ
(`GET /openai/v1/models` → 200). Публичный домен почты может быть в блок-листе
Groq — тогда `signup_blocked`; `tempmail.lol` сейчас проходит.
