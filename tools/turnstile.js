// Free local Turnstile helper for groq-regger (provider = "command").
//
// Uses your installed Chrome/Edge via playwright-core, logs into console.groq.com
// with the session JWT produced by the recipe, opens /keys, clicks
// "Create API Key", lets Turnstile solve itself and prints the cfToken to stdout.
//
// The UI's own /api/vb-token/create request is intercepted and aborted right
// after the token is captured, so the single-use Turnstile token stays fresh
// for the recipe's API call.
//
// Input (environment, set by groq-regger):
//   CAPTCHA_VARS       JSON with recipe variables (needs session_jwt)
//   CAPTCHA_SITEKEY    sitekey from the recipe
//   CAPTCHA_PAGE_URL   page to open (https://console.groq.com/keys)
//   CAPTCHA_ACTION     optional action (unused for Turnstile)
//
// Output: exactly one line on stdout — the token. Logs go to stderr.

const { chromium } = require('playwright-core');

const CREATE_SEL = '[data-testid="keys-page-create-button"]';
const SUBMIT_SEL = '[data-testid="key-form-submit-button"]';

function log(...a) { console.error('[turnstile]', ...a); }

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
        args: ['--disable-blink-features=AutomationControlled'],
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

// Wait until a button is present, visible and not disabled.
async function waitButtonEnabled(page, selector, nameRe, timeout) {
  await page.waitForFunction(
    ({ selector, nameRe }) => {
      const re = new RegExp(nameRe, 'i');
      const buttons = Array.from(document.querySelectorAll('button'));
      const b = buttons.find((x) => x.matches?.(selector)) ||
        buttons.find((x) => re.test((x.textContent || '').trim()));
      if (!b) return false;
      const style = window.getComputedStyle(b);
      return !b.disabled && style.visibility !== 'hidden' && style.display !== 'none';
    },
    { selector, nameRe },
    { timeout, polling: 500 },
  );
}

async function dumpTurnstileState(page) {
  const info = await page.evaluate(() => ({
    frames: Array.from(document.querySelectorAll('iframe')).map((f) => f.src).filter(Boolean),
    inputs: Array.from(document.querySelectorAll('input')).map((i) => i.name || i.type).slice(0, 20),
    body: (document.body.innerText || '').slice(0, 300),
  }));
  log('page state:', JSON.stringify(info));
}

(async () => {
  const vars = readVars();
  const jwt = vars.session_jwt || vars.cookie_stytch_session_jwt;
  if (!jwt) throw new Error('session_jwt missing in CAPTCHA_VARS');

  const pageUrl = process.env.CAPTCHA_PAGE_URL || 'https://console.groq.com/keys';
  const browser = await launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  const opaque = vars.session_token || vars.cookie_stytch_session;
  const cookies = [{
    name: 'stytch_session_jwt',
    value: jwt,
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
  await context.addCookies(cookies);

  const page = await context.newPage();
  let resolveToken;
  const done = new Promise((resolve) => { resolveToken = resolve; });

  await page.route('**/api/vb-token/create', async (route) => {
    try {
      const body = JSON.parse(route.request().postData() || '{}');
      if (body.cfToken) {
        log('captured cfToken from vb-token request (aborting it)');
        resolveToken(body.cfToken);
      }
    } catch { /* ignore */ }
    await route.abort('aborted').catch(() => {});
  });

  try {
    log('opening', pageUrl);
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    if (/\/signup|\/authenticate/.test(page.url())) {
      throw new Error('session is not valid: redirected to ' + page.url());
    }

    log('waiting for the create button to unlock (page Turnstile)...');
    try {
      await waitButtonEnabled(page, CREATE_SEL, 'create api key', 90000);
    } catch {
      await dumpTurnstileState(page);
      throw new Error('Create API Key button stayed disabled (Turnstile did not solve)');
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
    } catch {
      await dumpTurnstileState(page);
      throw new Error('Submit button stayed disabled (Turnstile did not solve)');
    }

    const submit = page.locator(SUBMIT_SEL)
      .or(page.getByRole('button', { name: /^submit$/i })).first();
    await submit.click();
    log('submitted, waiting for /api/vb-token/create');

    const token = await Promise.race([
      done,
      new Promise((_, rej) => setTimeout(() => rej(new Error('timed out waiting for token')), 90000)),
    ]);
    process.stdout.write(token + '\n');
    process.exitCode = 0;
  } catch (e) {
    log('error:', e.message);
    process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
})().catch((e) => {
  log('fatal:', e.message);
  process.exit(1);
});
