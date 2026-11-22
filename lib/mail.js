// Non-interactive temporary-mail providers for the Groq magic-link flow.
// Supported: tempmail_lol (verified working), mailtm, api (JSON inbox).

import { randomBytes } from 'node:crypto';
import { Transport, sleep } from './http.js';

const LETTERS = 'abcdefghijklmnopqrstuvwxyz0123456789';

// Rejection sampling avoids the bias of `byte % alphabet.length`.
function randomString(alphabet, len) {
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;
  let out = '';
  while (out.length < len) {
    for (const byte of randomBytes(Math.max(1, (len - out.length) * 2))) {
      if (byte >= limit) continue;
      out += alphabet[byte % alphabet.length];
      if (out.length === len) break;
    }
  }
  return out;
}

function randStr(len) {
  return randomString(LETTERS, len);
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).join('\n');
  if (typeof value === 'object') {
    return [value.body, value.html, value.text, value.content, value.subject]
      .map(textOf)
      .filter(Boolean)
      .join('\n');
  }
  return String(value);
}

export async function pollForToken({ fetchMessages, loadMessage, subjectContains, tokenRegex, timeout, interval, log }) {
  const deadline = Date.now() + timeout;
  const seen = new Set();

  while (Date.now() < deadline) {
    let messages = [];
    try {
      messages = (await fetchMessages()) || [];
    } catch (err) {
      log(`mail poll error: ${err.message}`);
    }

    for (const msg of messages) {
      const id = msg.id || msg._id || '';
      if (id && seen.has(id)) continue;

      const subject = String(msg.subject || '');
      if (subjectContains && !subject.toLowerCase().includes(String(subjectContains).toLowerCase())) continue;

      let content = textOf(msg);
      let detailLoaded = true;
      if ((!content || !tokenRegex.test(content)) && loadMessage) {
        try {
          content += `\n${textOf(await loadMessage(msg))}`;
        } catch (err) {
          // A transient detail error must not mark this message as processed:
          // the body may appear on a later poll.
          detailLoaded = false;
          log(`mail detail error: ${err.message}`);
        }
      }

      const match = decodeEntities(content).match(tokenRegex);
      if (match) {
        return { token: match[1], subject, from: String(msg.from || '') };
      }
      if (detailLoaded && id) seen.add(id);
    }

    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    log(`waiting for Groq login mail... ${left}s left`);
    await sleep(interval);
  }
  throw new Error('timed out waiting for the Groq login email');
}

// ── tempmail.lol (v1 API used by the verified Rust flow) ───────────

export class TempMailLolProvider {
  constructor({ base = 'https://api.tempmail.lol', proxy = null, timeout = 20000, insecure = false, onRetry = null } = {}) {
    this.name = 'tempmail_lol';
    this.base = String(base).replace(/\/+$/, '');
    this.t = new Transport({ proxy, timeout, insecure, onRetry });
  }

  async createInbox() {
    const res = await this.t.json(`${this.base}/generate`);
    if (res.status >= 400 || !res.data?.address || !res.data?.token) {
      throw new Error(`tempmail.lol generate HTTP ${res.status}: ${res.text.slice(0, 160)}`);
    }
    return { address: res.data.address, token: res.data.token };
  }

  waitForLoginToken(inbox, options = {}) {
    const { log = () => {}, timeout = 180000, interval = 4000, subjectContains, tokenRegex } = options;
    return pollForToken({
      log,
      timeout,
      interval,
      subjectContains,
      tokenRegex,
      fetchMessages: async () => {
        const res = await this.t.json(`${this.base}/auth/${encodeURIComponent(inbox.token)}`);
        if (res.status >= 400) throw new Error(`tempmail.lol inbox HTTP ${res.status}`);
        return res.data?.email || [];
      },
    });
  }
}

// ── mail.tm (useful for debugging, often blocklisted by Groq) ──────

export class MailTmProvider {
  constructor({ base = 'https://api.mail.tm', proxy = null, timeout = 20000, insecure = false, onRetry = null } = {}) {
    this.name = 'mailtm';
    this.base = String(base).replace(/\/+$/, '');
    this.t = new Transport({ proxy, timeout, insecure, onRetry });
    this._domain = null;
  }

  async _domainName() {
    if (this._domain) return this._domain;
    const res = await this.t.json(`${this.base}/domains`);
    if (res.status >= 400) throw new Error(`mail.tm domains HTTP ${res.status}`);
    const domains = res.data?.['hydra:member'] || [];
    const domain = domains.find((d) => d.isActive && !d.isPrivate) || domains.find((d) => d.isActive);
    if (!domain) throw new Error('mail.tm: no active domain');
    this._domain = domain.domain;
    return this._domain;
  }

  async createInbox() {
    const domain = await this._domainName();
    const address = `${randStr(12)}@${domain}`;
    const password = randomBytes(9).toString('base64url');
    const payload = JSON.stringify({ address, password });
    const headers = { 'Content-Type': 'application/json' };

    const acc = await this.t.json(`${this.base}/accounts`, { method: 'POST', headers, body: payload });
    if (acc.status >= 400) throw new Error(`mail.tm account HTTP ${acc.status}`);
    const tok = await this.t.json(`${this.base}/token`, { method: 'POST', headers, body: payload });
    if (tok.status >= 400 || !tok.data?.token) throw new Error(`mail.tm token HTTP ${tok.status}`);
    return { address, token: tok.data.token };
  }

  waitForLoginToken(inbox, options = {}) {
    const { log = () => {}, timeout = 180000, interval = 4000, subjectContains, tokenRegex } = options;
    const auth = { Authorization: `Bearer ${inbox.token}` };
    return pollForToken({
      log,
      timeout,
      interval,
      subjectContains,
      tokenRegex,
      fetchMessages: async () => {
        const res = await this.t.json(`${this.base}/messages?page=1`, { headers: auth });
        if (res.status === 401) throw new Error('mail.tm: inbox session rejected');
        if (res.status >= 400) throw new Error(`mail.tm messages HTTP ${res.status}`);
        return (res.data?.['hydra:member'] || []).map((m) => ({
          id: m.id,
          subject: m.subject || '',
          from: `${m.from?.address || ''} ${m.from?.name || ''}`.trim(),
        }));
      },
      loadMessage: async (msg) => {
        const res = await this.t.json(`${this.base}/messages/${encodeURIComponent(msg.id)}`, { headers: auth });
        return res.data || {};
      },
    });
  }
}

// ── generic JSON inbox ─────────────────────────────────────────────

export class ApiMailProvider {
  constructor({ listUrl, detailUrl = '', proxy = null, timeout = 20000, insecure = false, onRetry = null } = {}) {
    if (!listUrl) throw new Error('email provider "api" requires apiMail.listUrl');
    this.name = 'api';
    this.listUrl = listUrl;
    this.detailUrl = detailUrl;
    this.t = new Transport({ proxy, timeout, insecure, onRetry });
  }

  async createInbox() {
    const address = process.env.GROQ_EMAIL || '';
    if (!address.includes('@')) throw new Error('email provider "api" requires GROQ_EMAIL with the target address');
    return { address };
  }

  waitForLoginToken(inbox, options = {}) {
    const { log = () => {}, timeout = 180000, interval = 4000, subjectContains, tokenRegex } = options;
    return pollForToken({
      log,
      timeout,
      interval,
      subjectContains,
      tokenRegex,
      fetchMessages: async () => {
        const url = this.listUrl.replace('{email}', encodeURIComponent(inbox.address));
        const res = await this.t.json(url);
        if (res.status >= 400) throw new Error(`api inbox HTTP ${res.status}`);
        const d = res.data;
        const list = Array.isArray(d) ? d : d?.results || d?.messages || d?.email || d?.mails || [];
        return list;
      },
      loadMessage: this.detailUrl
        ? async (msg) => {
          const url = this.detailUrl.replace('{email}', encodeURIComponent(inbox.address)).replace('{id}', encodeURIComponent(msg.id || ''));
          const res = await this.t.json(url);
          return res.data || {};
        }
        : null,
    });
  }
}

export function buildMailer(kind, opts = {}) {
  switch (String(kind || 'tempmail_lol').toLowerCase()) {
    case 'tempmail_lol':
    case 'tempmail':
    case 'tempmail.lol':
      return new TempMailLolProvider(opts);
    case 'mailtm':
    case 'mail.tm':
      return new MailTmProvider(opts);
    case 'api':
      return new ApiMailProvider(opts);
    default:
      throw new Error(`unknown email provider "${kind}" (tempmail_lol | mailtm | api)`);
  }
}
