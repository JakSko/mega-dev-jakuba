// Night status page for sched-prod (MEGA.dev S03E01 "status for the night").
// Built from the accepted requirements list; every rule names its tag.
// No dependencies, no cookies, no scripts, no tracking. Reads the ops feed live on every request.
import http from 'node:http';

export const FEED_URL = process.env.FEED_URL || ''; // the ops feed (JSON: updatedAt, incidents)
const FEED_TIMEOUT_MS = 8000;
const MAX_AGE = 30; // R-L5Z: Cache-Control max-age 60 s or less

export const BANNER = 'Some services had problems overnight.'; // R-M9Z: exactly this one
export const AMBER = '#F5A623'; // R-M9Z: the screenshot's amber (sampled)
export const HEADING = 'status for the night'; // R-Z5L: exact words
export const BOARDS = 'read by tram 3 boards'; // R-X2M
export const FOOTER = 'all times UTC'; // R-H4L

// R-K8L: read live, never a copy (no cache in front of the feed read)
export async function readFeed(url = FEED_URL) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FEED_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: 'no-store', headers: { accept: 'application/json', 'cache-control': 'no-cache' } });
    if (!r.ok) throw new Error(`feed answered HTTP ${r.status}`);
    const j = await r.json();
    if (typeof j.updatedAt !== 'string' || !Array.isArray(j.incidents)) throw new Error('feed shape: no updatedAt or incidents');
    return j;
  } finally {
    clearTimeout(t);
  }
}

// R-M3H, spec R12: newest first by opened, ties by id
export function newestFirst(incidents) {
  return [...incidents].sort((a, b) => (b.opened > a.opened ? 1 : b.opened < a.opened ? -1 : String(b.id).localeCompare(String(a.id), 'en', { numeric: true })));
}

// R-L3K (product's answer: day first, 05/10); times 24 h HH:MM in UTC (R-H4L)
export function dayMonth(iso) {
  const d = new Date(iso);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
export function hhmm(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

// R-H8X: updatedAt in UTC ending in Z (R-K8L: the feed's own value, passed through)
export function statusJson(feed) {
  if (!/Z$/.test(feed.updatedAt)) throw new Error(`feed updatedAt not UTC Z: ${feed.updatedAt}`);
  return { updatedAt: feed.updatedAt, incidents: newestFirst(feed.incidents) }; // spec R13: feed field names as they are
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// R-Z2K: every line gets its own row, tram 3 included
export function lines(incidents) {
  const by = new Map([['tram 3', null]]);
  for (const i of newestFirst(incidents)) if (!by.get(i.line)) by.set(i.line, i);
  return [...by.entries()];
}

export function page(status) {
  const inc = status.incidents;
  const lineRows = lines(inc).map(([line, last]) => `<tr><td>${esc(line)}</td><td>${last ? esc(last.what) : 'no incident'}</td><td>${last ? `${dayMonth(last.opened)} ${hhmm(last.opened)}` : ''}</td></tr>`).join('\n');
  const incRows = inc.map((i) => `<tr data-id="${esc(i.id)}"><td>${dayMonth(i.opened)}</td><td>${hhmm(i.opened)}</td><td>${hhmm(i.closed)}</td><td>${esc(i.line)}</td><td>${esc(i.what)}</td><td>${esc(i.author)}</td></tr>`).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${HEADING}</title>
<style>
body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1d1d1b;background:#fff}
.banner{background:${AMBER};color:#1d1d1b;padding:14px 24px;font-weight:600}
main{max-width:860px;margin:0 auto;padding:16px 24px}
h1{font-size:28px;margin:16px 0 4px}
h2{font-size:18px;margin:28px 0 8px}
.boards{color:#555;margin:0 0 8px}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #e6e6e6;vertical-align:top}
th{color:#777;font-weight:500}
footer{max-width:860px;margin:24px auto;padding:0 24px 24px;color:#555}
</style>
</head>
<body>
<div class="banner" role="status">${BANNER}</div>
<main>
<h1>${HEADING}</h1>
<p class="boards">${BOARDS}</p>
<h2>Lines</h2>
<table id="lines">
<thead><tr><th>line</th><th>last incident</th><th>opened</th></tr></thead>
<tbody>
${lineRows}
</tbody>
</table>
<h2>Incidents, newest first</h2>
<table id="incidents">
<thead><tr><th>date</th><th>opened</th><th>closed</th><th>line</th><th>what</th><th>who ran it</th></tr></thead>
<tbody>
${incRows}
</tbody>
</table>
<p><a href="status.json">status.json</a> · data updated ${esc(status.updatedAt)}</p>
</main>
<footer>${FOOTER}</footer>
</body>
</html>
`;
}

const CORS = { 'access-control-allow-origin': '*' }; // R-K4M

export function handler(feedUrl = FEED_URL) {
  return async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    const send = (code, type, body, extra = {}) => {
      res.writeHead(code, { 'content-type': type, 'x-content-type-options': 'nosniff', ...extra });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (path === '/status.json' && req.method === 'OPTIONS') { // spec R15: preflight
      res.writeHead(204, { ...CORS, 'access-control-allow-methods': 'GET, HEAD, OPTIONS', 'access-control-allow-headers': req.headers['access-control-request-headers'] || '*', 'access-control-max-age': '600' });
      return res.end();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'text/plain; charset=utf-8', 'method not allowed', { allow: 'GET, HEAD, OPTIONS' });
    if (path !== '/' && path !== '/status.json') return send(404, 'text/plain; charset=utf-8', 'not found');
    let status;
    try {
      status = statusJson(await readFeed(feedUrl));
    } catch (e) { // spec R14: say so, never a stored copy
      const msg = `the ops feed could not be read: ${e.message}`;
      if (path === '/status.json') return send(502, 'application/json; charset=utf-8', JSON.stringify({ error: msg }), { ...CORS, 'cache-control': 'no-store' });
      return send(502, 'text/html; charset=utf-8', `<!doctype html><title>${HEADING}</title><h1>${HEADING}</h1><p>${esc(msg)}</p><footer>${FOOTER}</footer>`, { 'cache-control': 'no-store' });
    }
    const cache = { 'cache-control': `public, max-age=${MAX_AGE}` }; // R-L5Z
    if (path === '/status.json') return send(200, 'application/json; charset=utf-8', JSON.stringify(status), { ...CORS, ...cache });
    return send(200, 'text/html; charset=utf-8', page(status), cache);
  };
}

export function start(port = Number(process.env.PORT || 8080)) {
  if (!FEED_URL) throw new Error('set FEED_URL to the ops feed (https://...)');
  const srv = http.createServer(handler());
  srv.listen(port, () => console.log(`listening on ${port}, feed ${FEED_URL.replace(/[^/]+$/, '<id>')}`));
  return srv;
}
