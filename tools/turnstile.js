// Free local Turnstile helper for groq-regger (provider = "command").
//
// Uses installed Chrome/Edge via playwright-core. Logs in with the session JWT
// produced by the flow, opens /keys, clicks "Create API Key", lets Turnstile
// solve itself and prints the single-use cfToken on stdout.
//
// The UI's own /api/vb-token/create request is intercepted and aborted right
// after the token is captured, so the token stays fresh for the API call.
//
// Input (environment, set by groq-regger or inherited from its environment):
//   CAPTCHA_VARS                 JSON with recipe variables (needs session_jwt)
//   CAPTCHA_SITEKEY              sitekey from the recipe (used for diagnostics)
//   CAPTCHA_PAGE_URL             page to open (https://console.groq.com/keys)
//   CAPTCHA_ACTION               optional action (unused for Turnstile)
//   TURNSTILE_RETRIES            full browser attempts (default 3)
//   TURNSTILE_BUDGET_MS          total budget, keep below --command-timeout (default 150000)
//   TURNSTILE_NAV_TIMEOUT_MS     navigation timeout (default 60000)
//   TURNSTILE_BUTTON_TIMEOUT_MS  wait for an unlocked button (default 90000)
//   TURNSTILE_TOKEN_TIMEOUT_MS   wait for the intercepted token (default 90000)
//
// Output: exactly one line on stdout — the token. Logs go to stderr.

const { writeSync } = require('node:fs');
const { launchBrowser, createStealthContext } = require('./browser.js');

const CREATE_SEL = '[data-testid="keys-page-create-button"]';
const SUBMIT_SEL = '[data-testid="key-form-submit-button"]';
// The console renders a <div role="dialog">, not a <dialog> element, and the
// real input has data-testid="key-name-input" (confirmed in notes/keys-page.js).
const NAME_SEL = [
  '[data-testid="key-name-input"]',
  'input[name="keyName"]',
  '[role="dialog"] input[type="text"]',
  'dialog input[type="text"]',
].join(', ');
const SUBMIT_FALLBACK_SEL = '[role="dialog"] button[type="submit"]';
const VB_TOKEN_ROUTE = '**/api/vb-token/create';

function intEnv(name, fallback, min) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

const RETRIES = intEnv('TURNSTILE_RETRIES', 3, 1);
const HEADLESS = process.env.HEADLESS === '1';
const NAV_TIMEOUT_MS = intEnv('TURNSTILE_NAV_TIMEOUT_MS', 60_000, 1_000);
const BUTTON_TIMEOUT_MS = intEnv('TURNSTILE_BUTTON_TIMEOUT_MS', 90_000, 1_000);
const TOKEN_TIMEOUT_MS = intEnv('TURNSTILE_TOKEN_TIMEOUT_MS', 90_000, 1_000);
const BUDGET_MS = intEnv('TURNSTILE_BUDGET_MS', 150_000, 1_000);
const RETRY_DELAY_MS = 1_500;

function log(...a) { console.error('[turnstile]', ...a); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const remaining = (deadline) => Math.max(0, deadline - Date.now());

function budgetTimeout(deadline, preferred) {
  const left = remaining(deadline);
  if (left === 0) throw new Error('time budget exhausted');
  return Math.min(preferred, left);
}

function readVars() {
  try {
    const parsed = JSON.parse(process.env.CAPTCHA_VARS || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    log('could not parse CAPTCHA_VARS:', e.message);
    return {};
  }
}

// A deferred that never becomes an unhandled rejection: the page or browser
// can close long before anyone awaits the token (e.g. a failed navigation),
// and Node 20+ terminates the process on unhandled rejections. Without the
// no-op catch here the retry loop would never get a chance to run.
function deferred() {
  let resolve;
  let reject;
  let done = false;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return {
    promise,
    resolve(value) {
      if (done) return;
      done = true;
      resolve(value);
    },
    reject(error) {
      if (done) return;
      done = true;
      reject(error);
    },
  };
}

async function waitButtonEnabled(page, selectors, nameRe, timeout) {
  const deadline = Date.now() + timeout;
  let lastState = 'no matching button';
  while (Date.now() < deadline) {
    if (page.isClosed()) throw new Error('page closed while waiting for a button');
    try {
      const state = await page.evaluate(({ selectors, nameRe }) => {
        const re = new RegExp(nameRe, 'i');
        const buttons = Array.from(document.querySelectorAll('button'));
        const button = selectors.map((s) => buttons.find((b) => b.matches?.(s))).find(Boolean)
          || buttons.find((b) => re.test((b.textContent || '').trim()));
        if (!button) return { found: false };
        const style = window.getComputedStyle(button);
        const rect = button.getBoundingClientRect();
        return {
          found: true,
          text: (button.textContent || '').trim().slice(0, 60),
          disabled: !!button.disabled
            || button.getAttribute('aria-disabled') === 'true'
            || style.visibility === 'hidden'
            || style.display === 'none'
            || rect.width === 0
            || rect.height === 0,
        };
      }, { selectors, nameRe });
      if (state.found && !state.disabled) return;
      lastState = state.found
        ? `button "${state.text}" is disabled/hidden`
        : 'no matching button';
    } catch (e) {
      if (page.isClosed()) throw new Error('page closed while waiting for a button');
      // The execution context may have been replaced by a navigation — poll again.
      lastState = `evaluate failed: ${e.message}`;
    }
    await sleep(500);
  }
  throw new Error(`button stayed disabled (Turnstile did not solve): ${lastState}`);
}

async function dumpTurnstileState(page) {
  try {
    const info = await page.evaluate(() => ({
      url: location.href,
      frames: Array.from(document.querySelectorAll('iframe')).map((f) => f.src).filter(Boolean).slice(0, 10),
      buttons: Array.from(document.querySelectorAll('button')).slice(0, 20).map((b) => ({
        text: (b.textContent || '').trim().slice(0, 40),
        disabled: !!b.disabled,
      })),
      body: (document.body.innerText || '').slice(0, 300),
    }));
    log('page state:', JSON.stringify(info));
  } catch { /* page is gone */ }
}

async function oneAttempt(vars, pageUrl, deadline) {
  const browser = await launchBrowser({ headless: HEADLESS, log });
  let context = null;
  const token = deferred();
  let timer = null;
  try {
    browser.once?.('disconnected', () => {
      token.reject(new Error('browser disconnected before the token was captured'));
    });

    const opaque = vars.session_token || vars.cookie_stytch_session;
    const cookies = [{
      name: 'stytch_session_jwt',
      value: vars.session_jwt || vars.cookie_stytch_session_jwt,
      domain: '.groq.com',
      path: '/',
      httpOnly: false,
      secure: true,
      sameSite: 'Lax',
    }];
    if (opaque) {
      cookies.push({
        name: 'stytch_session',
        value: opaque,
        domain: '.groq.com',
        path: '/',
        httpOnly: false,
        secure: true,
        sameSite: 'Lax',
      });
    }

    context = await createStealthContext(browser);
    await context.addCookies(cookies);
    const page = await context.newPage();
    page.once?.('close', () => {
      token.reject(new Error('page closed before the token was captured'));
    });

    await page.route(VB_TOKEN_ROUTE, async (route) => {
      let captured = '';
      try {
        const body = JSON.parse(route.request().postData() || '{}');
        if (body && typeof body.cfToken === 'string') captured = body.cfToken.trim();
      } catch { /* ignore malformed bodies */ }
      if (captured) {
        log('captured cfToken from vb-token request (aborting it)');
        token.resolve(captured);
      } else {
        log('vb-token/create request had no cfToken (aborting it)');
      }
      await route.abort('aborted').catch(() => {});
    });

    const sitekey = process.env.CAPTCHA_SITEKEY ? ` (sitekey ${process.env.CAPTCHA_SITEKEY})` : '';
    log('opening', pageUrl, sitekey);
    await page.goto(pageUrl, {
      waitUntil: 'domcontentloaded',
      timeout: budgetTimeout(deadline, NAV_TIMEOUT_MS),
    });

    if (/\/signup|\/authenticate/.test(page.url())) {
      throw new Error('session is not valid: redirected to ' + page.url());
    }

    log('waiting for the create button to unlock (page Turnstile)...');
    try {
      await waitButtonEnabled(
        page,
        [CREATE_SEL],
        'create api key',
        budgetTimeout(deadline, BUTTON_TIMEOUT_MS),
      );
    } catch (e) {
      await dumpTurnstileState(page);
      throw e;
    }

    const create = page.locator(CREATE_SEL)
      .or(page.getByRole('button', { name: /create api key/i })).first();
    await create.click();
    log('dialog opened');

    const nameInput = page.locator(NAME_SEL).first();
    await nameInput.waitFor({ state: 'visible', timeout: budgetTimeout(deadline, 15_000) });
    await nameInput.fill('k-' + Date.now());

    log('waiting for the submit button to unlock (dialog Turnstile)...');
    try {
      await waitButtonEnabled(
        page,
        [SUBMIT_SEL, SUBMIT_FALLBACK_SEL],
        '^submit$',
        budgetTimeout(deadline, BUTTON_TIMEOUT_MS),
      );
    } catch (e) {
      await dumpTurnstileState(page);
      throw e;
    }

    const submit = page.locator([SUBMIT_SEL, SUBMIT_FALLBACK_SEL].join(', '))
      .or(page.getByRole('button', { name: /^submit$/i })).first();
    await submit.click();
    log('submitted, waiting for /api/vb-token/create');

    return await Promise.race([
      token.promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('timed out waiting for token')),
          budgetTimeout(deadline, TOKEN_TIMEOUT_MS),
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

function emitToken(token) {
  const clean = String(token).trim();
  if (!clean || /[\r\n]/.test(clean)) throw new Error('helper returned a malformed token');
  // writeSync guarantees the pipe is flushed before process.exit(); a plain
  // process.stdout.write() can be dropped by an immediate exit on Windows.
  writeSync(1, clean + '\n');
}

(async () => {
  const vars = readVars();
  if (!vars.session_jwt && !vars.cookie_stytch_session_jwt) {
    log('session_jwt missing in CAPTCHA_VARS');
    process.exit(1);
  }
  const pageUrl = process.env.CAPTCHA_PAGE_URL || 'https://console.groq.com/keys';
  const deadline = Date.now() + BUDGET_MS;

  let lastErr;
  for (let i = 1; i <= RETRIES; i += 1) {
    if (remaining(deadline) === 0) {
      lastErr = lastErr || new Error('time budget exhausted');
      break;
    }
    try {
      const token = await oneAttempt(vars, pageUrl, deadline);
      emitToken(token);
      process.exit(0);
    } catch (e) {
      lastErr = e;
      log(`attempt ${i}/${RETRIES} failed: ${e.message}`);
      if (i < RETRIES && remaining(deadline) > RETRY_DELAY_MS) await sleep(RETRY_DELAY_MS);
    }
  }
  log('fatal:', lastErr?.message || 'unknown error');
  process.exit(1);
})().catch((e) => {
  log('fatal:', e.message);
  process.exit(1);
});
