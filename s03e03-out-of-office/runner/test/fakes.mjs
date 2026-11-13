// Fakes for the dry run: a tracker in the shapes of AGENTS.md, a production feed, a "live" host
// that serves the Worker from the working copy, and an owner who answers and signs.
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));
const body = (req) => new Promise((r) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => r(b)); });
const send = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

/**
 * script: { issues: [{ atMs, title, body }], owner: { '<title part>': ['9', '2'] },
 *           followups: { '<title part>': 'text' }, ownerDelayMs, signDelayMs }
 */
export async function fakeTracker(script, token = 'tracker-token-for-tests') {
  const t0 = Date.now();
  const issues = []; const records = new Map(); const ship = new Map(); const log = [];
  const iso = () => new Date().toISOString();
  const lastIssueBy = new Date(t0 + Math.max(...script.issues.map((i) => i.atMs)) + 50).toISOString();
  const pending = [...script.issues].sort((a, b) => a.atMs - b.atMs);
  const open = () => {
    while (pending.length && Date.now() - t0 >= pending[0].atMs) {
      const s = pending.shift();
      issues.push({ n: issues.length + 1, title: s.title, body: s.body, openedAt: iso(), labels: s.labels ?? ['from:product'], closed: false, thread: [] });
    }
  };
  const ownerQueue = Object.fromEntries(Object.entries(script.owner ?? {}).map(([k, v]) => [k, [...v]]));
  const followed = new Set();
  const view = (r, withHistory) => ({
    id: r.id, by: r.by, status: r.status, signedBy: r.signedBy, signedAt: r.signedAt, updatedAt: r.updatedAt, text: r.text,
    versions: r.history.map((h) => ({ at: h.at, signed: h.signed })), ...(withHistory ? { history: r.history.map((h) => ({ at: h.at, text: h.text })) } : {}),
  });

  const server = http.createServer(async (req, res) => {
    open();
    const raw = req.method === 'GET' ? '' : await body(req);
    log.push({ method: req.method, url: req.url, body: raw });
    if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { message: 'no token' });
    const json = raw ? JSON.parse(raw) : {};
    const m = (re) => re.exec(req.url);
    let x;
    if (req.method === 'GET' && req.url === '/issues') return send(res, 200, { now: iso(), lastIssueBy, issues });
    if ((x = m(/^\/issues\/(\d+)(\/\w+)?$/))) {
      const is = issues.find((i) => i.n === Number(x[1]));
      if (!is) return send(res, 404, { message: 'no such issue' });
      if (req.method === 'GET' && !x[2]) return send(res, 200, is);
      if (req.method === 'POST' && x[2] === '/comments') {
        if (typeof json.body !== 'string' || !json.body) return send(res, 400, { message: 'body is required' });
        is.thread.push({ by: 'agent', at: iso(), kind: 'comment', body: json.body });
        const key = Object.keys(ownerQueue).find((k) => is.title.includes(k));
        if (key && is.labels.includes('needs-human') && /\/answer/.test(json.body) && ownerQueue[key].length) {
          const a = ownerQueue[key].shift();
          setTimeout(() => is.thread.push({ by: 'owner', at: iso(), kind: 'comment', body: `/answer ${a}` }), script.ownerDelayMs ?? 200);
        }
        // An owner who follows the agent's recommendation, once per ask (for real-model rounds).
        const rec = /Recommendation:\s*(\d+)/.exec(json.body);
        if (script.ownerAuto && is.labels.includes('needs-human') && rec && /\/answer/.test(json.body)) {
          setTimeout(() => is.thread.push({ by: 'owner', at: iso(), kind: 'comment', body: `/answer ${rec[1]}` }), script.ownerDelayMs ?? 200);
        }
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && x[2] === '/labels') { is.labels.push(json.label); is.thread.push({ by: 'agent', at: iso(), kind: 'label', label: json.label }); return send(res, 200, { ok: true }); }
      if (req.method === 'POST' && x[2] === '/close') { is.closed = true; is.thread.push({ by: 'agent', at: iso(), kind: 'close' }); return send(res, 200, { ok: true }); }
    }
    if (req.method === 'GET' && req.url === '/records') return send(res, 200, { records: [...records.values()].map((r) => view(r)) });
    if ((x = m(/^\/records\/([\w-]+)$/))) {
      const id = x[1]; const r = records.get(id);
      if (req.method === 'GET') return r ? send(res, 200, view(r, true)) : send(res, 404, { message: 'no such record' });
      if (req.method === 'PUT') {
        if (!/^\d{4}-[a-z0-9-]+$/.test(id) || Number(id.slice(0, 4)) < 7) return send(res, 400, { message: 'id must be NNNN-slug, from 0007' });
        if (r?.by === 'course') return send(res, 403, { message: 'not your record' });
        if (r?.signedBy) return send(res, 409, { message: 'the record is signed' });
        const status = /^status:\s*(\w+)/m.exec(json.text ?? '')?.[1] ?? 'proposed';
        const rec = r ?? { id, by: 'agent', signedBy: null, signedAt: null, history: [] };
        Object.assign(rec, { status, text: json.text, updatedAt: iso() });
        rec.history.push({ at: iso(), text: json.text, signed: false });
        records.set(id, rec);
        if (status === 'accepted') setTimeout(() => { rec.signedBy = 'owner'; rec.signedAt = iso(); rec.history.at(-1).signed = true; }, script.signDelayMs ?? 600);
        return send(res, 200, { ok: true, version: rec.history.length });
      }
    }
    if (req.method === 'GET' && req.url === '/shiplog') return send(res, 200, { text: [...ship.values()].join('\n') });
    if (req.method === 'POST' && req.url === '/shiplog') {
      const n = /^#(\d+) /.exec(json.line ?? '')?.[1];
      if (!n) return send(res, 400, { message: 'a ship line starts with #<issue>' });
      ship.set(n, json.line);
      const is = issues.find((i) => i.n === Number(n));
      const key = Object.keys(script.followups ?? {}).find((k) => is?.title.includes(k));
      if (key && !followed.has(key) && / shipped /.test(json.line)) {
        followed.add(key);
        setTimeout(() => is.thread.push({ by: 'course', at: iso(), kind: 'comment', body: script.followups[key] }), 150);
      }
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { message: 'no such call' });
  });
  for (const r of script.records ?? []) records.set(r.id, { by: 'course', signedBy: 'owner', signedAt: iso(), updatedAt: iso(), history: [{ at: iso(), text: r.text, signed: true }], ...r });
  return { url: await listen(server), token, issues, records, ship, log, close: () => server.close() };
}

export async function fakeFeed(incidents) {
  const writes = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') { writes.push(`${req.method} ${req.url}`); return send(res, 403, { message: 'no' }); }
    send(res, 200, { incidents });
  });
  return { url: await listen(server), writes, close: () => server.close() };
}

/** A "live address": serves the Worker module from the working copy as it was at the last deploy. */
export async function fakeLive(work, feedUrl) {
  let worker = null; let v = 0;
  const server = http.createServer(async (req, res) => {
    if (!worker) return send(res, 503, { error: 'nothing deployed' });
    const r = await worker.fetch(new Request(`http://live.test${req.url}`, { method: req.method }), { FEED_URL: feedUrl });
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'text/plain' });
    res.end(await r.text());
  });
  const url = await listen(server);
  const deployer = {
    versions: [],
    async deploy() {
      v += 1;
      worker = (await import(`${pathToFileURL(path.join(work, 'src', 'index.js')).href}?v=${v}`)).default;
      this.versions.push(v);
      return { ok: true, versionId: `v${v}`, url, note: 'fake deploy' };
    },
  };
  return { url, deployer, close: () => server.close() };
}
