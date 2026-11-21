#!/usr/bin/env node
// groq-regger — non-interactive Groq registrator in pure JavaScript.
// Control surface: config.json plus CLI flags only. No prompts, no TUI.
// Successful output: a working Groq API key in out/keys.txt.

import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

import { loadConfig, appendResult, appendKey } from './lib/store.js';
import { buildMailer } from './lib/mail.js';
import { Transport } from './lib/http.js';
import { registerGroqAccount } from './lib/groq.js';
import {
  normalizeProxy,
  normalizeProxyType,
  parseProxyList,
  createRotator,
  describeProxy,
} from './lib/proxy.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const USAGE = `
groq-regger — non-interactive registrator for console.groq.com (pure JavaScript)

Usage: node groq-regger.js [options]

Every setting can be placed in config.json; CLI flags override it for one run.
Normal output is quiet; use --verbose for step-by-step diagnostics.

Config / batch:
  --config FILE            alternative config.json (env: GROQ_REGGER_CONFIG)
  --count N                accounts to register (default 1)
  --attempts N             attempts per account, fresh email each time (default 2)
  --out FILE               JSONL results (default out/accounts.jsonl)
  --keys-out FILE          key file (default out/keys.txt)
  --interval SEC           pause between accounts (default 5)

Mail:
  --provider K             tempmail_lol | mailtm | api (default tempmail_lol)
  --email ADDR             address for provider=api
  --email-timeout SEC      wait for the magic-link email (default 180)

Network:
  --proxy URL              http(s)://[user:pass@]host:port or
                           socks4:// / socks4a:// / socks5:// / socks5h://
  --proxy-type TYPE        used when --proxy is a bare host:port
  --proxy-file FILE        one proxy per line, rotated per account
  --proxy-bypass LIST      comma-separated hosts bypassing the proxy (browser)
  --insecure               skip TLS certificate verification

Browser helpers / timing:
  --headless               hidden browser: real Chrome, window off-screen (default)
  --headed                 show the browser window (overrides config)
                           TRUE_HEADLESS=1 with --headless forces Chromium headless
                           (faster, but Groq rejects its fingerprint)
  --command-timeout SEC    timeout for telemetry/captcha helpers (default 180)
  --sitekey KEY            Turnstile sitekey
  --page-url URL           /keys page URL for the Turnstile solver

Misc:
  --selftest               connectivity/helper checks, no registration
  --verbose                detailed diagnostics
  -h, --help               this help
`;

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(2);
}

function asInt(value, name, { min = 1, fallback = 0 } = {}) {
  const n = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isInteger(n) || n < min) fail(`${name} must be an integer >= ${min}`);
  return n;
}

function parseCli() {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        config: { type: 'string' },
        count: { type: 'string' },
        attempts: { type: 'string' },
        provider: { type: 'string' },
        email: { type: 'string' },
        out: { type: 'string' },
        'keys-out': { type: 'string' },
        interval: { type: 'string' },
        'email-timeout': { type: 'string' },
        'command-timeout': { type: 'string' },
        proxy: { type: 'string' },
        'proxy-type': { type: 'string' },
        'proxy-file': { type: 'string' },
        'proxy-bypass': { type: 'string' },
        insecure: { type: 'boolean' },
        headless: { type: 'boolean' },
        headed: { type: 'boolean' },
        sitekey: { type: 'string' },
        'page-url': { type: 'string' },
        selftest: { type: 'boolean' },
        verbose: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
    });
  } catch (err) {
    console.error(String(err.message || err));
    console.error(USAGE);
    process.exit(2);
  }

  const opt = parsed.values;
  if (opt.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const configFile = path.resolve(
    opt.config || process.env.GROQ_REGGER_CONFIG || path.join(ROOT, 'config.json'),
  );
  const defaults = loadConfig(fs.existsSync(configFile) ? configFile : null);
  const pick = (key, fallback) => (opt[key] !== undefined ? opt[key] : fallback);

  const provider = String(pick('provider', defaults.provider || 'tempmail_lol')).toLowerCase();
  if (!['tempmail_lol', 'mailtm', 'api'].includes(provider)) {
    fail('--provider must be tempmail_lol | mailtm | api');
  }

  let proxyType = null;
  let proxy = null;
  try {
    proxyType = opt['proxy-type']
      ? normalizeProxyType(opt['proxy-type'])
      : defaults.proxyType || null;
    proxy = normalizeProxy(pick('proxy', defaults.proxy ?? null), proxyType);
  } catch (err) {
    fail(err.message);
  }

  let proxyList = [];
  const proxyFile = opt['proxy-file'] || defaults.proxyFile || null;
  if (proxyFile) {
    try {
      proxyList = parseProxyList(fs.readFileSync(path.resolve(proxyFile), 'utf8'), proxyType);
    } catch (err) {
      fail(err.message);
    }
  }

  const headless = opt.headed
    ? false
    : opt.headless !== undefined
      ? !!opt.headless
      : !!defaults.headless;

  return {
    count: asInt(pick('count', defaults.count ?? 1), '--count'),
    attempts: asInt(pick('attempts', defaults.attempts ?? 2), '--attempts'),
    intervalMs: asInt(pick('interval', defaults.intervalSec ?? 5), '--interval', { min: 0 }) * 1000,
    timeoutMs: asInt(defaults.timeoutSec ?? 45, 'timeoutSec') * 1000,
    emailTimeoutMs: asInt(pick('email-timeout', defaults.emailTimeoutSec ?? 180), '--email-timeout') * 1000,
    commandTimeoutMs: asInt(
      pick('command-timeout', defaults.commandTimeoutSec ?? 180),
      '--command-timeout',
    ) * 1000,
    provider,
    email: opt.email || defaults.email || null,
    out: path.resolve(pick('out', defaults.out || path.join(ROOT, 'out', 'accounts.jsonl'))),
    keysOut: path.resolve(pick('keys-out', defaults.keysOut || path.join(ROOT, 'out', 'keys.txt'))),
    proxy,
    proxyType,
    proxyList,
    proxyBypass: pick('proxy-bypass', defaults.proxyBypass || null),
    insecure: opt.insecure !== undefined ? !!opt.insecure : !!defaults.insecure,
    headless,
    verbose: opt.verbose !== undefined ? !!opt.verbose : !!defaults.verbose,
    selftest: !!opt.selftest,
    sitekey: opt.sitekey || defaults.sitekey || '0x4AAAAAAA04hiaY8r8_QF1r',
    pageUrl: opt['page-url'] || defaults.pageUrl || 'https://console.groq.com/keys',
    telemetryCommand: defaults.telemetryCommand || 'node tools/telemetry.js',
    captchaCommand: defaults.captchaCommand || 'node tools/turnstile.js',
    stytchPublicToken:
      defaults.stytchPublicToken || 'public-token-live-58df57a9-a1f5-4066-bc0c-2ff942db684f',
    telemetrySubmitUrl: defaults.telemetrySubmitUrl || 'https://gste.groq.io/submit',
    tempmailBase: defaults.tempmailBase || 'https://api.tempmail.lol',
    mailtmBase: defaults.mailtmBase || 'https://api.mail.tm',
    apiMail: defaults.apiMail || {},
  };
}

async function selftest(cfg, makeMailer, log) {
  let failures = 0;
  const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures += 1;
  };

  const t = new Transport({ proxy: cfg.proxy, timeout: 20000, insecure: cfg.insecure });
  const page = await t
    .request('https://console.groq.com/signup')
    .catch((err) => ({ status: 0, text: err.message }));
  check('console.groq.com reachable', page.status === 200, `HTTP ${page.status}`);

  try {
    const mailer = makeMailer(cfg.proxy);
    const inbox = await mailer.createInbox();
    check(`mailbox via ${cfg.provider}`, !!inbox.address, inbox.address);
  } catch (err) {
    check(`mailbox via ${cfg.provider}`, false, err.message);
  }

  try {
    const require = createRequire(path.join(ROOT, 'tools', 'package.json'));
    require.resolve('playwright-core');
    check('playwright-core in tools/', true);
  } catch (err) {
    check('playwright-core in tools/', false, err.message.split('\n')[0]);
  }

  log(`selftest: ${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

async function main() {
  const cfg = parseCli();
  const log = (msg) => {
    if (cfg.verbose) console.log(`[groq] ${msg}`);
  };
  const makeMailer = (proxy) => {
    const mailer = buildMailer(cfg.provider, {
      base: cfg.provider === 'mailtm' ? cfg.mailtmBase : cfg.tempmailBase,
      listUrl: cfg.apiMail.listUrl,
      detailUrl: cfg.apiMail.detailUrl,
      proxy,
      timeout: 20000,
      insecure: cfg.insecure,
      onRetry: cfg.verbose
        ? (url, err, attempt) => log(`mail retry ${attempt} ${err.code || 'net'} ${url}`)
        : null,
    });
    return mailer;
  };

  if (cfg.selftest) {
    await selftest(cfg, makeMailer, log);
    return;
  }

  if (cfg.provider === 'api') {
    const email = cfg.email || process.env.GROQ_EMAIL;
    if (!email || !email.includes('@')) fail('provider=api requires --email or GROQ_EMAIL');
    process.env.GROQ_EMAIL = email;
  }

  const rotator = createRotator(cfg.proxyList, true);
  let ok = 0;
  let blocked = false;
  const signupBlocked = /signup_blocked|signup error/i;

  for (let i = 1; i <= cfg.count && !blocked; i += 1) {
    const accountProxy = rotator ? rotator.next() : cfg.proxy;
    log(`account ${i}/${cfg.count} via ${describeProxy(accountProxy)}`);

    let done = false;
    for (let attempt = 1; attempt <= cfg.attempts && !done; attempt += 1) {
      try {
        const mailer = makeMailer(accountProxy);
        mailer.inbox = await mailer.createInbox();
        const record = await registerGroqAccount({
          config: cfg,
          proxy: accountProxy,
          mailer,
          cwd: ROOT,
          log,
        });
        appendResult(cfg.out, record);
        appendKey(cfg.keysOut, record.api_key, record.email);
        ok += 1;
        done = true;
      } catch (err) {
        const msg = String(err.message || '');
        console.error(`error: account ${i} attempt ${attempt}: ${msg}`);
        // Two conditions make every following attempt pointless:
        //  - Groq's risk engine will not take this IP/device right now;
        //  - the mail provider returned 429 (free-tier quota).
        // Retrying immediately only burns browser launches/mail quota.
        if (signupBlocked.test(msg)) {
          blocked = true;
          console.error('stop: Groq is rate-limiting this IP/device (signup_blocked)');
          console.error('hint: wait a while, or rerun with --proxy-file proxies.txt');
          break;
        }
        if (/rate limited|HTTP 429/i.test(msg)) {
          blocked = true;
          console.error('stop: mail provider rate limit (HTTP 429)');
          console.error('hint: wait for the free quota to reset, use --proxy-file proxies.txt,');
          console.error('      or switch provider in config (mailtm / api)');
          break;
        }
      }
    }

    if (blocked) break;
    if (i < cfg.count) await new Promise((resolve) => setTimeout(resolve, cfg.intervalMs));
  }

  console.log(`summary: ${ok}/${cfg.count} API keys written to ${cfg.keysOut}`);
  process.exit(ok === cfg.count ? 0 : 1);
}

main().catch((err) => {
  console.error(`fatal: ${err.stack || err.message || err}`);
  process.exit(1);
});
