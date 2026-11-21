// Shared browser launcher for the local helpers.
//
// "Hidden" mode (the default for --headless) runs a REAL headed browser but
// moves its window far off-screen. To Groq/Stytch/Turnstile this is a normal
// Chrome instance (real WebGL, real fonts, real screen), so the fingerprint is
// accepted; on the desktop no window is visible.
//
// Set TRUE_HEADLESS=1 to use Chromium's actual headless mode instead (faster,
// but Groq currently rejects its fingerprint with signup_blocked).

const { chromium } = require('playwright-core');

const TRUE_HEADLESS = process.env.TRUE_HEADLESS === '1';

function browserProxy(log = () => {}) {
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

async function launchBrowser({ headless, log = () => {} } = {}) {
  const hidden = !!headless && !TRUE_HEADLESS;
  const attempts = [{ channel: 'chrome' }, { channel: 'msedge' }];
  if (process.env.CHROME_PATH) attempts.unshift({ executablePath: process.env.CHROME_PATH });
  let lastErr;
  for (const opts of attempts) {
    try {
      const browser = await chromium.launch({
        headless: !!headless && TRUE_HEADLESS,
        proxy: browserProxy(log),
        ignoreDefaultArgs: headless && TRUE_HEADLESS
          ? ['--enable-automation', '--headless']
          : ['--enable-automation'],
        args: [
          '--disable-blink-features=AutomationControlled',
          ...(hidden
            ? [
              '--window-position=-2400,-2400',
              '--window-size=1280,900',
              '--disable-background-timer-throttling',
              '--disable-renderer-backgrounding',
              '--disable-backgrounding-occluded-windows',
            ]
            : []),
          ...(headless && TRUE_HEADLESS ? ['--headless=new'] : []),
          ...(process.env.BROWSER_PROXY ? [] : ['--no-proxy-server']),
        ],
        ...opts,
      });
      log('launched', JSON.stringify(opts), hidden ? 'hidden (off-screen headed)' : (headless ? 'true-headless' : 'headed'));
      return browser;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('no Chrome/Edge found; set CHROME_PATH');
}

async function createStealthContext(browser) {
  // A plain context gave a valid fingerprint before; aggressive spoofing
  // (fake UA/plugins) is itself a bot signal, so keep headful/hidden pristine.
  if (!TRUE_HEADLESS) {
    return browser.newContext({ viewport: { width: 1280, height: 900 } });
  }
  const major = String(browser.version() || '131').split('.')[0];
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 `
      + `(KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
  });
  await context.addInitScript(() => {
    try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch { /* ignore */ }
    try { if (!window.chrome) window.chrome = { runtime: {} }; } catch { /* ignore */ }
  });
  return context;
}

module.exports = { launchBrowser, createStealthContext, browserProxy };
