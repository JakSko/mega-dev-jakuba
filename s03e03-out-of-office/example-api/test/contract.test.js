// Baseline contract tests for contract/api.md. Run: npm test (node --test, no dependencies).
// The Worker is called directly; the feed is a stub on globalThis.fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const FEED = 'https://feed.test/incidents';
const FIELDS = ['id', 'openedAt', 'service', 'status', 'summary'];
const inc = (id, openedAt, extra = {}) => ({
  id, service: 'booking-api', summary: 's', status: 'open', openedAt, ...extra,
});

function withFeed(handler, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input?.url ?? input), method: init.method ?? input?.method ?? 'GET' });
    return handler();
  };
  return fn(calls).finally(() => { globalThis.fetch = real; });
}

const get = (path, env = { FEED_URL: FEED }) =>
  worker.fetch(new Request(`https://api.test${path}`), env);

const isJson = (res) => /^application\/json/.test(res.headers.get('content-type') ?? '');

test('GET /incidents answers 200 JSON with an incidents array', () =>
  withFeed(() => Response.json({ incidents: [inc('INC-2', '2026-11-11T03:00:00.000Z'), inc('INC-1', '2026-11-11T02:00:00.000Z')] }), async () => {
    const res = await get('/incidents');
    assert.equal(res.status, 200);
    assert.ok(isJson(res));
    const body = await res.json();
    assert.deepEqual(Object.keys(body), ['incidents']);
    assert.equal(body.incidents.length, 2);
    for (const i of body.incidents) assert.deepEqual(Object.keys(i).sort(), FIELDS);
  }));

test('the feed is only read: one GET, no write', () =>
  withFeed(() => Response.json({ incidents: [] }), async (calls) => {
    await get('/incidents');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].url, FEED);
  }));

test('anything else answers 404 {"error":"not found"}', () =>
  withFeed(() => Response.json({ incidents: [] }), async (calls) => {
    for (const [path, method] of [['/nope', 'GET'], ['/', 'GET'], ['/incidentsx', 'GET'], ['/incidents/', 'GET'], ['/incidents', 'POST'], ['/incidents/INC-1', 'DELETE']]) {
      const res = await worker.fetch(new Request(`https://api.test${path}`, { method }), { FEED_URL: FEED });
      assert.equal(res.status, 404, `${method} ${path}`);
      assert.ok(isJson(res));
      assert.deepEqual(await res.json(), { error: 'not found' });
    }
    assert.equal(calls.length, 0, 'a 404 never touches the feed');
  }));

test('all answers are JSON: the feed fails', () =>
  withFeed(() => new Response('upstream down', { status: 500 }), async () => {
    const res = await get('/incidents');
    assert.ok(res.status >= 500);
    assert.ok(isJson(res));
    assert.equal(typeof (await res.json()).error, 'string');
  }));

test('all answers are JSON: the feed answers something that is not JSON', () =>
  withFeed(() => new Response('<html>', { status: 200 }), async () => {
    const res = await get('/incidents');
    assert.ok(res.status >= 500);
    assert.ok(isJson(res));
    assert.equal(typeof (await res.json()).error, 'string');
  }));

test('all answers are JSON: FEED_URL is not set', () =>
  withFeed(() => { throw new Error('must not be called'); }, async () => {
    const res = await get('/incidents', {});
    assert.ok(res.status >= 500);
    assert.ok(isJson(res));
    assert.equal(typeof (await res.json()).error, 'string');
  }));

test('an error answer never leaks the feed address', () =>
  withFeed(() => new Response('x', { status: 500 }), async () => {
    const res = await get('/incidents');
    assert.ok(!(await res.text()).includes('feed.test'));
  }));

// Contract lines the starter does not keep yet. Left as todo on purpose: the agent
// turns each into a real test, red first, when an issue names it.
test('contract: newest first', { todo: 'starter passes the feed order through' }, () =>
  withFeed(() => Response.json({ incidents: [inc('INC-1', '2026-11-11T02:00:00.000Z'), inc('INC-2', '2026-11-11T03:00:00.000Z')] }), async () => {
    const body = await (await get('/incidents')).json();
    assert.deepEqual(body.incidents.map((i) => i.id), ['INC-2', 'INC-1']);
  }));

test('contract: exactly these fields', { todo: 'starter passes extra feed fields through' }, () =>
  withFeed(() => Response.json({ incidents: [inc('INC-1', '2026-11-11T02:00:00.000Z', { internalNote: 'x' })] }), async () => {
    const body = await (await get('/incidents')).json();
    assert.deepEqual(Object.keys(body.incidents[0]).sort(), FIELDS);
  }));
