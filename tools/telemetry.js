// Real Stytch device-fingerprint telemetry ID for groq-regger (step type = "command").
//
// The console calls window.GetTelemetryID(...) from Stytch telemetry.js; that
// script computes a browser fingerprint and POSTs it to gste.groq.io/submit.
// A bare UUID from an empty POST looks like a bot to the signup risk engine.
// This helper runs the genuine script in installed Chrome/Edge and prints the
// resulting ID (one line on stdout, logs on stderr).
//
// Install once:  cd tools && npm i   (or unpack playwright-core manually)
// Run manually:  node telemetry.js

const { chromium } = require('playwright-core');

const PUBLIC_TOKEN = process.env.STYTCH_PUBLIC_TOKEN
  || 'public-token-live-58df57a9-a1f5-4066-bc0c-2ff942db684f';
const SUBMIT_URL = process.env.TELEMETRY_SUBMIT_URL || 'https://gste.groq.io/submit';

function log(...a) { console.error('[telemetry]', ...a); }

async function launch() {
  const attempts = [{ channel: 'chrome' }, { channel: 'msedge' }];
  if (process.env.CHROME_PATH) attempts.unshift({ executablePath: process.env.CHROME_PATH });
  let lastErr;
  for (const opts of attempts) {
    try {
      const browser = await chromium.launch({
        headless: process.env.HEADLESS === '1',
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

(async () => {
  const browser = await launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
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
    process.stdout.write(id + '\n');
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
