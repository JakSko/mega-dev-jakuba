import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readPlanFiles, readTracker } from '../src/agents/tracker.js';

// A local fake tracker: a few routes that answer like the course tracker, or don't.
let server: Server;
let base = '';
const issues = [
  { number: 11, title: 'Heartbeat drifts', state: 'closed', labels: [], by: 'rook', body: 'b', comments: [] },
  {
    number: 12,
    title: 'Digest prints null',
    state: 'open',
    labels: [],
    by: 'rook',
    body: '`owner: null` renders as `null`.',
    comments: [{ by: 'rook', body: 'back: 6 jobs, the digest shows 5.' }],
  },
];

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/ok') return res.end(JSON.stringify({ issues }));
    if (req.url === '/500') return (res.statusCode = 500), res.end('no');
    if (req.url === '/html') return res.end('<html>maintenance</html>');
    if (req.url === '/shape') return res.end(JSON.stringify({ items: [] }));
    if (req.url === '/nostate') return res.end(JSON.stringify({ issues: [{ number: 1 }] }));
    if (req.url === '/slow') return setTimeout(() => res.end(JSON.stringify({ issues })), 2000);
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('readTracker', () => {
  it('parses open and closed issues with their comments', async () => {
    const r = await readTracker(`${base}/ok`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.issues.map((i) => [i.number, i.state])).toEqual([
      [11, 'closed'],
      [12, 'open'],
    ]);
    expect(r.issues[1]!.comments[0]).toEqual({ by: 'rook', body: 'back: 6 jobs, the digest shows 5.' });
  });

  it.each([
    ['a 500', '/500', 'tracker answered 500'],
    ['HTML instead of JSON', '/html', 'tracker sent no JSON'],
    ['JSON without an issues list', '/shape', 'tracker JSON has no issues list'],
    ['an issue without a state', '/nostate', 'tracker has an issue without number or state'],
  ])('%s gives a named error, not a guess', async (_n, path, why) => {
    expect(await readTracker(`${base}${path}`)).toEqual({ ok: false, why });
  });

  it('a tracker that is down or too slow gives a named error', async () => {
    const down = await readTracker('http://127.0.0.1:9/issues', { timeoutMs: 1000 });
    expect(down.ok).toBe(false);
    if (!down.ok) expect(down.why).toMatch(/^tracker not reachable/);
    const slow = await readTracker(`${base}/slow`, { timeoutMs: 200 });
    expect(slow.ok).toBe(false);
    if (!slow.ok) expect(slow.why).toMatch(/^tracker not reachable/);
  });
});

describe('readPlanFiles', () => {
  it('reads plan.md (empty once the plan is done) and the done plans of this repo', () => {
    const p = readPlanFiles('.');
    expect(typeof p.plan).toBe('string');
    expect(p.done.map((d) => d.file)).toContain('docs/plans/done/2026-10-29-morning-digest.md');
    expect(p.done.map((d) => d.file)).toContain('docs/plans/done/2026-11-04-pulse.md');
  });
});
