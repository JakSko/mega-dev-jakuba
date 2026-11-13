// Shared parts of the runner: masked log, the one outbound wrapper, the tracker client, state.
import fs from 'node:fs';
import path from 'node:path';

const SHAPES = /(prod_admin_[0-9a-f]+|sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/-]{8,})/g;

/** A log that never holds a secret: known values and token shapes are masked. */
export function makeLog(file, secrets = [], { quiet = false } = {}) {
  const known = secrets.filter((s) => s && s.length >= 6);
  const mask = (text) => {
    let out = String(text);
    for (const s of known) out = out.split(s).join('<masked>');
    return out.replace(SHAPES, '<masked>');
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const log = (kind, data = {}) => {
    const line = mask(JSON.stringify({ at: new Date().toISOString(), kind, ...data }));
    fs.appendFileSync(file, line + '\n');
    if (!quiet && kind !== 'http') console.log(line.slice(0, 600));
  };
  log.mask = mask;
  return log;
}

/**
 * The one way out. Every outside request of the runner goes through here: it is logged whole
 * (request and reply), and a write to the production feed is refused before it is sent.
 */
export function makeOut({ log, feedUrl = '', fetchImpl = fetch, timeoutMs = 20000 }) {
  const feed = feedUrl.replace(/\/+$/, '');
  return async function out(url, { method = 'GET', headers = {}, body } = {}) {
    const u = String(url);
    if (feed && method !== 'GET' && u.startsWith(feed)) {
      log('refused', { method, url: u, why: 'the agent never writes to the production feed' });
      throw new Error('refused: the agent never writes to the production feed');
    }
    const t0 = Date.now();
    let res, text;
    try {
      res = await fetchImpl(u, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
      text = await res.text();
    } catch (err) {
      log('http', { method, url: u, error: String(err.message) });
      throw err;
    }
    log('http', {
      method, url: u, status: res.status, ms: Date.now() - t0,
      req: body === undefined ? undefined : String(body).slice(0, 8000),
      res: text.slice(0, 40000),
    });
    return { status: res.status, ok: res.ok, text, json: () => JSON.parse(text) };
  };
}

/** The tracker's calls, exactly the table in AGENTS.md. No other call exists here. */
export function makeTracker({ out, base, token }) {
  const root = base.replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const call = async (method, p, body) => {
    const r = await out(root + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!r.ok) {
      let message = '';
      try { message = r.json().message ?? ''; } catch { /* not JSON */ }
      const err = new Error(`${method} ${p} answered ${r.status}: ${message || r.text.slice(0, 200)}`);
      err.status = r.status;
      throw err;
    }
    return r.json();
  };
  return {
    issues: () => call('GET', '/issues'),
    issue: (n) => call('GET', `/issues/${n}`),
    comment: (n, body) => call('POST', `/issues/${n}/comments`, { body }),
    label: (n, label) => call('POST', `/issues/${n}/labels`, { label }),
    close: (n) => call('POST', `/issues/${n}/close`),
    records: () => call('GET', '/records'),
    record: (id) => call('GET', `/records/${id}`),
    putRecord: (id, text) => call('PUT', `/records/${id}`, { text }),
    shiplog: () => call('GET', '/shiplog'),
    ship: (line) => call('POST', '/shiplog', { line }),
  };
}

/** State on the volume. Written whole and renamed, so a crash never leaves half a file. */
export function makeState(file) {
  let s = { issues: {}, modelCalls: 0, notified: {}, lastGood: null };
  if (fs.existsSync(file)) s = { ...s, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return {
    get: () => s,
    save() {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(s, null, 1));
      fs.renameSync(tmp, file);
    },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
