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
const { execFile } = require('node:child_process');

const TRUE_HEADLESS = process.env.TRUE_HEADLESS === '1';

// An off-screen window still shows a taskbar button. On Windows hide it
// completely with ShowWindow(SW_HIDE); rendering and visibilityState stay
// normal, so the fingerprint is unchanged. Playwright 1.65 exposes no browser
// pid, so we target Chrome/Edge top-level windows that sit fully off-screen —
// only our helper windows are ever placed there.
function hideBrowserWindows() {
  if (process.platform !== 'win32') return;
  const ps = [
    `Add-Type -TypeDefinition @'`,
    `using System;`,
    `using System.Runtime.InteropServices;`,
    `public class WH {`,
    `  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }`,
    `  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);`,
    `  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);`,
    `}`,
    `'@`,
    `$n = 0`,
    `Get-Process chrome,msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } |`,
    `  ForEach-Object {`,
    `    $r = New-Object WH+RECT`,
    `    if ([WH]::GetWindowRect($_.MainWindowHandle, [ref]$r) -and $r.Right -le 0) {`,
    `      if ([WH]::ShowWindow($_.MainWindowHandle, 0)) { $n++ }`,
    `    }`,
    `  }`,
    `if ($n -gt 0) { Write-Output ("hid " + $n) }`,
  ].join('\n');
  const run = () => {
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], () => {});
  };
  setTimeout(run, 800);
  setTimeout(run, 3500);
}

function browserProxy(log = () => {}) {
  const raw = process.env.BROWSER_PROXY || '';
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    const result = { server: `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}` };
    if (u.username) result.username = decodeURIComponent(u.username);
    if (u.password) result.password = decodeURIComponent(u.password);
    if (process.env.BROWSER_PROXY_BYPASS) result.bypass = process.env.BROWSER_PROXY_BYPASS;
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
          ...(process.env.BROWSER_INSECURE === '1' ? ['--ignore-certificate-errors'] : []),
          ...(process.env.BROWSER_PROXY ? [] : ['--no-proxy-server']),
        ],
        ...opts,
      });
      log('launched', JSON.stringify(opts), hidden ? 'hidden (off-screen headed)' : (headless ? 'true-headless' : 'headed'));
      if (hidden && process.env.NO_WINDOW_HIDE !== '1') hideBrowserWindows();
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
  const ignoreHTTPSErrors = process.env.BROWSER_INSECURE === '1';
  if (!TRUE_HEADLESS) {
    return browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors });
  }
  const major = String(browser.version() || '131').split('.')[0];
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    ignoreHTTPSErrors,
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
