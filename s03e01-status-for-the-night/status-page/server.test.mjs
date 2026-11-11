import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { handler } from './server.mjs';

const FEED = {
  updatedAt: '2026-11-11T12:27:00Z',
  incidents: [
    { id: '1001', line: 'tram 3', opened: '2026-10-03T22:40:00Z', closed: '2026-10-03T22:58:00Z', what: 'timetable push late', author: 'on-call' },
    { id: '1006', line: 'bus 21', opened: '2026-10-05T03:40:00Z', closed: '2026-10-05T03:58:00Z', what: 'position gaps', author: 'night shift' },
    { id: '1007', line: 'scheduler', opened: '2026-10-05T03:51:00Z', closed: '2026-10-05T04:04:00Z', what: 'schedule rebuild', author: '—' },
    { id: '1004', line: 'night bus N9', opened: '2026-10-05T01:05:00Z', closed: '2026-10-05T01:12:00Z', what: 'roster sync retries', author: 'night shift' },
  ],
};

async function serve(feedHandler) {
  const feed = http.createServer(feedHandler);
  await new Promise((r) => feed.listen(0, r));
  const app = http.createServer(handler(`http://127.0.0.1:${feed.address().port}/feed`));
  await new Promise((r) => app.listen(0, r));
  const base = `http://127.0.0.1:${app.address().port}`;
  return { base, close: () => { app.close(); feed.close(); } };
}
const okFeed = (body = FEED) => (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

test('page: heading, banner, boards line, footer, no scripts or cookies (R-Z5L R-M9Z R-X2M R-H4L)', async () => {
  const s = await serve(okFeed());
  const r = await fetch(s.base + '/');
  const h = await r.text();
  assert.equal(r.status, 200);
  assert.match(h, /<h1>status for the night<\/h1>/);
  assert.match(h, /<title>status for the night<\/title>/);
  assert.match(h, /class="banner"[^>]*>Some services had problems overnight\.</);
  assert.match(h, /\.banner\{background:#F5A623/);
  assert.match(h, />read by tram 3 boards</);
  assert.match(h, /<footer>all times UTC<\/footer>/);
  assert.doesNotMatch(h, /<script/i);
  assert.equal(r.headers.get('set-cookie'), null);
  s.close();
});

test('incidents newest first by opened, dates day first, 24 h UTC, who ran it as in the feed (R-M3H R-L3K R-X5K)', async () => {
  const s = await serve(okFeed());
  const h = await (await fetch(s.base + '/')).text();
  const ids = [...h.matchAll(/data-id="(\d+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['1007', '1006', '1004', '1001']);
  assert.match(h, /<tr data-id="1001"><td>03\/10<\/td><td>22:40<\/td><td>22:58<\/td><td>tram 3<\/td><td>timetable push late<\/td><td>on-call<\/td>/);
  assert.match(h, /<tr data-id="1007"><td>05\/10<\/td><td>03:51<\/td><td>04:04<\/td><td>scheduler<\/td><td>schedule rebuild<\/td><td>—<\/td>/);
  s.close();
});

test('every line has its own row, tram 3 included even with no incident (R-Z2K)', async () => {
  const s = await serve(okFeed({ ...FEED, incidents: FEED.incidents.filter((i) => i.line !== 'tram 3') }));
  const h = await (await fetch(s.base + '/')).text();
  const lines = h.split('<table id="lines">')[1].split('</table>')[0];
  for (const l of ['tram 3', 'bus 21', 'scheduler', 'night bus N9']) assert.match(lines, new RegExp(`<td>${l}</td>`));
  assert.match(lines, /<td>tram 3<\/td><td>no incident<\/td>/);
  s.close();
});

test('status.json: feed updatedAt, same rows as the page, CORS *, max-age <= 60, JSON type (R-K8L R-H8X R-K4M R-L5Z)', async () => {
  const s = await serve(okFeed());
  const r = await fetch(s.base + '/status.json');
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.updatedAt, FEED.updatedAt);
  assert.match(j.updatedAt, /Z$/);
  assert.deepEqual(j.incidents.map((i) => i.id), ['1007', '1006', '1004', '1001']);
  assert.deepEqual(Object.keys(j.incidents[0]), ['id', 'line', 'opened', 'closed', 'what', 'author']);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.match(r.headers.get('content-type'), /^application\/json/);
  const age = Number(/max-age=(\d+)/.exec(r.headers.get('cache-control'))[1]);
  assert.ok(age <= 60);
  s.close();
});

test('preflight OPTIONS answers with CORS (spec R15)', async () => {
  const s = await serve(okFeed());
  const r = await fetch(s.base + '/status.json', { method: 'OPTIONS', headers: { origin: 'https://board.example', 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-probe' } });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.match(r.headers.get('access-control-allow-methods'), /GET/);
  assert.match(r.headers.get('access-control-allow-headers'), /x-probe/);
  s.close();
});

test('feed read live on every request (R-K8L): a new updatedAt shows at once', async () => {
  let n = 0;
  const s = await serve((req, res) => { n += 1; res.end(JSON.stringify({ ...FEED, updatedAt: `2026-11-11T12:2${n}:00Z` })); });
  const a = await (await fetch(s.base + '/status.json')).json();
  const b = await (await fetch(s.base + '/status.json')).json();
  assert.notEqual(a.updatedAt, b.updatedAt);
  assert.equal(n, 2);
  s.close();
});

test('feed down: 502 on page and JSON, no stored copy (spec R14)', async () => {
  const s = await serve((req, res) => { res.writeHead(500); res.end('boom'); });
  const p = await fetch(s.base + '/');
  assert.equal(p.status, 502);
  assert.match(await p.text(), /could not be read/);
  const j = await fetch(s.base + '/status.json');
  assert.equal(j.status, 502);
  assert.equal(j.headers.get('cache-control'), 'no-store');
  s.close();
});

test('unknown path 404, POST 405', async () => {
  const s = await serve(okFeed());
  assert.equal((await fetch(s.base + '/x')).status, 404);
  assert.equal((await fetch(s.base + '/', { method: 'POST' })).status, 405);
  s.close();
});
