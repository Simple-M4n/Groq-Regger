// Free local Turnstile helper for groq-regger (provider = "command").
//
// Uses installed Chrome/Edge via playwright-core. Logs in with the session JWT
// produced by the flow, opens /keys, clicks "Create API Key", lets Turnstile
// solve itself and prints the single-use cfToken on stdout.
//
// The UI's own /api/vb-token/create request is intercepted and aborted right
// after the token is captured, so the token stays fresh for the API call.
//
// Input (environment, set by groq-regger):
//   CAPTCHA_VARS        JSON with recipe variables (needs session_jwt)
//   CAPTCHA_SITEKEY     sitekey from the recipe
//   CAPTCHA_PAGE_URL    page to open (https://console.groq.com/keys)
//   CAPTCHA_ACTION      optional action (unused for Turnstile)
//   TURNSTILE_RETRIES   how many full browser attempts (default 3)
//
// Output: exactly one line on stdout — the token. Logs go to stderr.

const { chromium } = require('playwright-core');

const CREATE_SEL = '[data-testid="keys-page-create-button"]';
const SUBMIT_SEL = '[data-testid="key-form-submit-button"]';
const RETRIES = Math.max(1, Number.parseInt(process.env.TURNSTILE_RETRIES || '3', 10) || 3);

function log(...a) { console.error('[turnstile]', ...a); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function browserProxy() {
  const raw = process.env.BROWSER_PROXY || '';
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    const result = { server: `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}` };
    if (u.username) result.username = decodeURIComponent(u.username);
    if (u.password) result.password = decodeURIComponent(u.password);
    return result;
  } catch (e) {
    log('invalid BROWSER_PROXY:', e.message);
    return undefined;
  }
}

function readVars() {
  try { return JSON.parse(process.env.CAPTCHA_VARS || '{}'); } catch { return {}; }
}

async function launch() {
  const attempts = [{ channel: 'chrome' }, { channel: 'msedge' }];
  if (process.env.CHROME_PATH) attempts.unshift({ executablePath: process.env.CHROME_PATH });
  let lastErr;
  for (const opts of attempts) {
    try {
      const browser = await chromium.launch({
        headless: false,
        proxy: browserProxy(),
        args: [
          '--disable-blink-features=AutomationControlled',
          ...(process.env.BROWSER_PROXY ? [] : ['--no-proxy-server']),
        ],
        ...opts,
      });
      log('launched', JSON.stringify(opts));
      return browser;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('no Chrome/Edge found; set CHROME_PATH');
}

async function waitButtonEnabled(page, selector, nameRe, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (page.isClosed()) throw new Error('page closed while waiting for a button');
    try {
      const ok = await page.evaluate(
        ({ selector, nameRe }) => {
          const re = new RegExp(nameRe, 'i');
          const buttons = Array.from(document.querySelectorAll('button'));
          const b = buttons.find((x) => x.matches?.(selector))
            || buttons.find((x) => re.test((x.textContent || '').trim()));
          if (!b) return false;
          const style = window.getComputedStyle(b);
          return !b.disabled && style.visibility !== 'hidden' && style.display !== 'none';
        },
        { selector, nameRe },
      );
      if (ok) return;
    } catch (e) {
      if (page.isClosed()) throw new Error('page closed while waiting for a button');
      // Execution context was replaced by a navigation — just poll again.
    }
    await sleep(500);
  }
  throw new Error('button stayed disabled (Turnstile did not solve)');
}

async function dumpTurnstileState(page) {
  try {
    const info = await page.evaluate(() => ({
      frames: Array.from(document.querySelectorAll('iframe')).map((f) => f.src).filter(Boolean),
      inputs: Array.from(document.querySelectorAll('input')).map((i) => i.name || i.type).slice(0, 20),
      body: (document.body.innerText || '').slice(0, 300),
    }));
    log('page state:', JSON.stringify(info));
  } catch { /* page is gone */ }
}

async function oneAttempt(vars, pageUrl) {
  const browser = await launch();
  let context = null;
  try {
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

    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies(cookies);
    const page = await context.newPage();

    let resolveToken;
    let rejectToken;
    const tokenPromise = new Promise((resolve, reject) => {
      resolveToken = resolve;
      rejectToken = reject;
    });
    let captured = false;

    await page.route('**/api/vb-token/create', async (route) => {
      try {
        const body = JSON.parse(route.request().postData() || '{}');
        if (body.cfToken && !captured) {
          captured = true;
          log('captured cfToken from vb-token request (aborting it)');
          resolveToken(body.cfToken);
        }
      } catch { /* ignore */ }
      await route.abort('aborted').catch(() => {});
    });
    page.once('close', () => {
      if (!captured) rejectToken(new Error('page closed before the token was captured'));
    });

    log('opening', pageUrl);
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    if (/\/signup|\/authenticate/.test(page.url())) {
      throw new Error('session is not valid: redirected to ' + page.url());
    }

    log('waiting for the create button to unlock (page Turnstile)...');
    try {
      await waitButtonEnabled(page, CREATE_SEL, 'create api key', 90000);
    } catch (e) {
      await dumpTurnstileState(page);
      throw e;
    }

    const create = page.locator(CREATE_SEL)
      .or(page.getByRole('button', { name: /create api key/i })).first();
    await create.click();
    log('dialog opened');

    const nameInput = page.locator('input[name="keyName"]')
      .or(page.locator('dialog input[type="text"]')).first();
    await nameInput.waitFor({ state: 'visible', timeout: 15000 });
    await nameInput.fill('k-' + Date.now());

    log('waiting for the submit button to unlock (dialog Turnstile)...');
    try {
      await waitButtonEnabled(page, SUBMIT_SEL, '^submit$', 90000);
    } catch (e) {
      await dumpTurnstileState(page);
      throw e;
    }

    const submit = page.locator(SUBMIT_SEL)
      .or(page.getByRole('button', { name: /^submit$/i })).first();
    await submit.click();
    log('submitted, waiting for /api/vb-token/create');

    return await Promise.race([
      tokenPromise,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('timed out waiting for token')),
        90000,
      )),
    ]);
  } finally {
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

(async () => {
  const vars = readVars();
  if (!vars.session_jwt && !vars.cookie_stytch_session_jwt) {
    log('session_jwt missing in CAPTCHA_VARS');
    process.exit(1);
  }
  const pageUrl = process.env.CAPTCHA_PAGE_URL || 'https://console.groq.com/keys';

  let lastErr;
  for (let i = 1; i <= RETRIES; i += 1) {
    try {
      const token = await oneAttempt(vars, pageUrl);
      process.stdout.write(token + '\n');
      process.exit(0);
    } catch (e) {
      lastErr = e;
      log(`attempt ${i}/${RETRIES} failed: ${e.message}`);
      if (i < RETRIES) await sleep(1500);
    }
  }
  log('fatal:', lastErr?.message || 'unknown error');
  process.exit(1);
})().catch((e) => {
  log('fatal:', e.message);
  process.exit(1);
});
