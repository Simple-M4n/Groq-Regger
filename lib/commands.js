// External command helpers. Only the last non-empty stdout line is used as the
// result, so tools can write diagnostics to stderr without polluting the flow.

import { exec } from 'node:child_process';

export function redactSecrets(text, secrets = []) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (secret && typeof secret === 'string' && secret.length >= 8) {
      out = out.split(secret).join('<redacted>');
    }
  }
  return out;
}

export function runCommand(command, { cwd, env = {}, timeoutMs = 180000, secrets = [] } = {}) {
  return new Promise((resolve, reject) => {
    exec(
      command,
      {
        cwd,
        env: { ...process.env, ...env },
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = redactSecrets(stderr || stdout || err.message, secrets).trim();
          reject(new Error(`command failed: ${command}${detail ? ` — ${detail.slice(0, 400)}` : ''}`));
          return;
        }
        const lines = String(stdout || '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        if (!lines.length) {
          reject(new Error(`command returned no output: ${command}`));
          return;
        }
        // The successful line can contain a token that appears in `secrets`
        // too; redact it before it reaches logs or the API calls.
        resolve(redactSecrets(lines[lines.length - 1], secrets));
      },
    );
  });
}

export function telemetryId(config, { cwd, timeoutMs, log }) {
  log('running telemetry helper');
  return runCommand(config.telemetryCommand, {
    cwd,
    timeoutMs,
    env: {
      HEADLESS: config.headless ? '1' : '0',
      BROWSER_PROXY: config.proxy || '',
      BROWSER_PROXY_BYPASS: config.proxyBypass || '',
      BROWSER_INSECURE: config.insecure ? '1' : '0',
      STYTCH_PUBLIC_TOKEN: config.stytchPublicToken,
      TELEMETRY_SUBMIT_URL: config.telemetrySubmitUrl,
    },
  });
}

export function solveTurnstile(config, vars, { cwd, timeoutMs, log }) {
  log('solving Turnstile via local browser helper');
  return runCommand(config.captchaCommand, {
    cwd,
    timeoutMs,
    env: {
      HEADLESS: config.headless ? '1' : '0',
      BROWSER_PROXY: config.proxy || '',
      BROWSER_PROXY_BYPASS: config.proxyBypass || '',
      BROWSER_INSECURE: config.insecure ? '1' : '0',
      CAPTCHA_KIND: 'turnstile',
      CAPTCHA_SITEKEY: config.sitekey,
      CAPTCHA_PAGE_URL: config.pageUrl,
      CAPTCHA_ACTION: 'verify',
      CAPTCHA_VARS: JSON.stringify(vars),
    },
    secrets: [vars.session_jwt, vars.session_token],
  });
}
