import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { holdsSecret, makeLog, mask } from '../src/guard.ts';
import { createService, type Authenticate, type Event } from '../src/service.ts';
import { Budget, Seen } from '../src/store.ts';
import { sign, verify } from '../src/webhook.ts';

const KEY = 'whsec_' + Buffer.from('a test key that is long enough').toString('base64');
const OTHER = 'whsec_' + Buffer.from('some other key, also long enough').toString('base64');
const NOW = 1_800_000_000;

test('verify: good, wrong key, too old, missing headers, rotated key', () => {
  const body = '{"x":1}';
  const sig = `v1,${sign(KEY, 'msg_1', String(NOW), body)}`;
  assert.deepEqual(verify({ id: 'msg_1', timestamp: String(NOW), signature: sig }, body, [KEY], NOW), { ok: true });
  assert.equal(verify({ id: 'msg_1', timestamp: String(NOW), signature: sig }, body, [OTHER], NOW).ok, false);
  assert.equal(verify({ id: 'msg_1', timestamp: String(NOW), signature: sig }, body, [KEY], NOW + 301).ok, false);
  assert.equal(verify({ id: 'msg_1', timestamp: null, signature: sig }, body, [KEY], NOW).ok, false);
  assert.equal(verify({ id: 'msg_1', timestamp: String(NOW), signature: sig }, body + ' ', [KEY], NOW).ok, false);
  assert.deepEqual(verify({ id: 'msg_1', timestamp: String(NOW), signature: sig }, body, [OTHER, KEY], NOW), { ok: true });
});

test('guard: mask and holdsSecret catch known secrets and key shapes', () => {
  assert.equal(mask(`k=${KEY}`, [KEY]), 'k=<secret>');
  assert.match(mask('token sk-abcdefghijklmnop1234', []), /<key-shaped>/);
  assert.equal(holdsSecret('plain text', [KEY]), null);
  assert.ok(holdsSecret(`oops ${KEY}`, [KEY]));
  assert.ok(holdsSecret('Bearer abcdefghijklmnopqrstuvwxyz', []));
});

test('budget and seen', () => {
  const b = new Budget(2, null, () => '2026-11-05');
  assert.equal(b.take(), true);
  assert.equal(b.take(), true);
  assert.equal(b.take(), false);
  const s = new Seen(null);
  assert.equal(s.begin('a'), 'new');
  assert.equal(s.begin('a'), 'running');
  s.release('a');
  assert.equal(s.begin('a'), 'new', 'a failed id is free again');
  s.finish('a');
  assert.equal(s.begin('a'), 'done');
});

async function start(handled: Event[], lines: string[], opts: { failFirst?: boolean; authenticate?: Authenticate } = {}) {
  let calls = 0;
  const server = createService({
    keys: [KEY],
    authenticate: opts.authenticate,
    rights: { owner: 'test', agents: { a: { may: ['answer'] } } },
    handle: async (e) => {
      calls++;
      if (opts.failFirst && calls === 1) throw new Error('crash before the reply');
      handled.push(e);
    },
    log: makeLog({ secrets: [KEY], out: (l) => lines.push(l) }),
    seen: new Seen(null),
    now: () => NOW,
  });
  await new Promise<void>((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, url };
}

function signed(id: string, body: string, key = KEY) {
  return { 'webhook-id': id, 'webhook-timestamp': String(NOW), 'webhook-signature': `v1,${sign(key, id, String(NOW), body)}`, 'content-type': 'application/json' };
}

test('service: health, rights, signed event once, resend, refused request logged whole', async () => {
  const handled: Event[] = [];
  const lines: string[] = [];
  const { server, url } = await start(handled, lines);
  try {
    assert.equal((await fetch(`${url}/health`)).status, 200);
    assert.deepEqual(await (await fetch(`${url}/.well-known/agent-rights.json`)).json(), { owner: 'test', agents: { a: { may: ['answer'] } } });

    const body = JSON.stringify({ ask: 'status?' });
    assert.equal((await fetch(url, { method: 'POST', headers: signed('m1', body), body })).status, 202);
    const again = await fetch(url, { method: 'POST', headers: signed('m1', body), body });
    assert.equal(again.status, 202);
    assert.deepEqual(await again.json(), { received: true, resend: true });

    const bad = JSON.stringify({ ask: 'from a stranger' });
    assert.equal((await fetch(url, { method: 'POST', headers: signed('m2', bad, OTHER), body: bad })).status, 401);

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(handled.length, 1, 'only the first signed event is handled');
    assert.deepEqual(handled[0].body, { ask: 'status?' });
    assert.ok(lines.some((l) => l.includes('from a stranger') && l.includes('rejected')), 'refused body is in the log');
    assert.ok(lines.every((l) => !l.includes(KEY)), 'no secret in the log');
  } finally {
    server.close();
  }
});

test('service: work that fails is retried on resend, then done once', async () => {
  const handled: Event[] = [];
  const lines: string[] = [];
  const { server, url } = await start(handled, lines, { failFirst: true });
  try {
    const body = JSON.stringify({ ask: 'status?' });
    const post = () => fetch(url, { method: 'POST', headers: signed('m9', body), body });
    assert.equal((await post()).status, 202);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(handled.length, 0, 'first try failed');
    assert.ok(lines.some((l) => l.includes('a resend will retry')));
    assert.equal((await post()).status, 202);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(handled.length, 1, 'resend handled after the failure');
    const third = await post();
    assert.deepEqual(await third.json(), { received: true, resend: true });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(handled.length, 1, 'no second effect once done');
  } finally {
    server.close();
  }
});

test('service: a custom sender check replaces Standard Webhooks (mail shape)', async () => {
  const handled: Event[] = [];
  const lines: string[] = [];
  const authenticate: Authenticate = (header) =>
    header('x-provider-token') === 'expected-token-123' && header('message-id')
      ? { ok: true, id: header('message-id')! }
      : { ok: false, why: 'unknown sender' };
  const { server, url } = await start(handled, lines, { authenticate });
  try {
    const body = JSON.stringify({ from: 'someone@example.com', text: 'hello' });
    const ok = await fetch(url, { method: 'POST', headers: { 'x-provider-token': 'expected-token-123', 'message-id': '<a1@example.com>' }, body });
    assert.equal(ok.status, 202);
    const bad = await fetch(url, { method: 'POST', headers: { 'message-id': '<a2@example.com>' }, body });
    assert.equal(bad.status, 401);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(handled.length, 1);
    assert.equal(handled[0].id, '<a1@example.com>');
  } finally {
    server.close();
  }
});
