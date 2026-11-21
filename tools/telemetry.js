// Real Stytch device-fingerprint telemetry ID for groq-regger (step type = "command").
//
// The console calls window.GetTelemetryID(...) from Stytch telemetry.js; the
// script computes a browser fingerprint and POSTs it to gste.groq.io/submit.
// A bare UUID from an empty POST looks like a bot to the signup risk engine.
// This helper runs the genuine script in installed Chrome/Edge and prints the
// resulting ID (one line on stdout, logs on stderr).
//
// Install once:  cd tools && npm i   (or unpack playwright-core manually)
// Run manually:  node telemetry.js
//
// Environment:
//   HEADLESS=1              run browser headless (default: visible window)
//   STYTCH_PUBLIC_TOKEN     override public token
//   TELEMETRY_SUBMIT_URL    override submit endpoint
//   TELEMETRY_RETRIES       browser attempts (default 3)

const { chromium } = require('playwright-core');

const PUBLIC_TOKEN = process.env.STYTCH_PUBLIC_TOKEN
  || 'public-token-live-58df57a9-a1f5-4066-bc0c-2ff942db684f';
const SUBMIT_URL = process.env.TELEMETRY_SUBMIT_URL || 'https://gste.groq.io/submit';
const RETRIES = Math.max(1, Number.parseInt(process.env.TELEMETRY_RETRIES || '3', 10) || 3);
const HEADLESS = process.env.HEADLESS === '1';

function log(...a) { console.error('[telemetry]', ...a); }
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

async function launch() {
  const attempts = [{ channel: 'chrome' }, { channel: 'msedge' }];
  if (process.env.CHROME_PATH) attempts.unshift({ executablePath: process.env.CHROME_PATH });
  let lastErr;
  for (const opts of attempts) {
    try {
      const browser = await chromium.launch({
        headless: HEADLESS,
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

async function oneAttempt() {
  const browser = await launch();
  let context = null;
  try {
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    log('opening https://console.groq.com/signup');
    await page.goto('https://console.groq.com/signup', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    if (typeof (await page.evaluate(() => window.GetTelemetryID)) !== 'function') {
      log('window.GetTelemetryID missing, injecting telemetry.js');
      await page.addScriptTag({ url: 'https://api.stytchb2b.groq.com/telemetry.js' });
    }
    await page.waitForFunction(() => typeof window.GetTelemetryID === 'function', null, {
      timeout: 60000,
    });

    log('computing fingerprint...');
    const id = await page.evaluate(
      async (cfg) => window.GetTelemetryID(cfg),
      { publicToken: PUBLIC_TOKEN, submitURL: SUBMIT_URL },
    );
    if (!id || typeof id !== 'string') throw new Error('GetTelemetryID returned ' + id);
    return id;
  } finally {
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

(async () => {
  let lastErr;
  for (let i = 1; i <= RETRIES; i += 1) {
    try {
      const id = await oneAttempt();
      process.stdout.write(id + '\n');
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
