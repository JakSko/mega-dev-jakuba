import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { agentsFile, createAgentsApp, type Agents } from '../src/agents/app.js';
import { Seen } from '../src/agents/seen.js';
import { sign, verify } from '../src/agents/webhook.js';

// A made-up test key, never the course's.
const KEY = `whsec_${randomBytes(32).toString('base64')}`;
const OTHER = `whsec_${randomBytes(32).toString('base64')}`;
const ORIGIN = 'https://hq.mega.dev';
const NOW = 1_800_000_000;

const pulseBody = JSON.stringify({
  kind: 'pulse',
  text: 'pulse? amber fox',
  phrase: 'amber fox',
  reply: `${ORIGIN}/rig/reply/abc/tok`,
  tracker: `${ORIGIN}/rig/tracker/issues`,
});

function headers(body: string, opts: { id?: string; ts?: number; key?: string; sig?: string } = {}) {
  const id = opts.id ?? 'msg_1';
  const ts = String(opts.ts ?? NOW);
  return {
    'content-type': 'application/json',
    'webhook-id': id,
    'webhook-timestamp': ts,
    'webhook-signature': opts.sig ?? `v1,${sign(opts.key ?? KEY, id, ts, body)}`,
  };
}

function setup() {
  const calls: string[] = [];
  const agents: Agents = {
    pulse: async (p, id) => void calls.push(`pulse ${id} ${p.phrase}`),
    test: async (p, id) => void calls.push(`test ${id} ${p.issue}`),
  };
  const app = createAgentsApp({ ownerCode: 'own-test', pingKeys: [KEY], courseOrigin: ORIGIN }, agents, {
    seen: new Seen(null),
    now: () => NOW,
    log: () => {},
  });
  const tick = () => new Promise((r) => setImmediate(r));
  return { app, calls, tick };
}

describe('signature check', () => {
  it('accepts its own signature and rejects a changed body', () => {
    const h = { id: 'msg_1', timestamp: String(NOW), signature: `v1,${sign(KEY, 'msg_1', String(NOW), 'x')}` };
    expect(verify(h, 'x', [KEY], NOW).ok).toBe(true);
    expect(verify(h, 'y', [KEY], NOW).ok).toBe(false);
  });

  it('accepts either of two signatures during a key change', () => {
    const ts = String(NOW);
    const sig = `v1,${sign(OTHER, 'm', ts, 'b')} v1,${sign(KEY, 'm', ts, 'b')}`;
    expect(verify({ id: 'm', timestamp: ts, signature: sig }, 'b', [KEY], NOW).ok).toBe(true);
  });
});

describe('POST / (pings)', () => {
  it('a good pulse ping gets 202 and wakes the pulse once', async () => {
    const { app, calls, tick } = setup();
    const res = await app.request('/', { method: 'POST', headers: headers(pulseBody), body: pulseBody });
    await tick();
    expect(res.status).toBe(202);
    expect(calls).toEqual(['pulse msg_1 amber fox']);
  });

  it('a good test ping wakes the test writer', async () => {
    const { app, calls, tick } = setup();
    const body = JSON.stringify({ kind: 'test', issue: 12, reply: `${ORIGIN}/rig/reply/x/t`, files: { 'src/a.ts': 'x' } });
    const res = await app.request('/', { method: 'POST', headers: headers(body), body });
    await tick();
    expect(res.status).toBe(202);
    expect(calls).toEqual(['test msg_1 12']);
  });

  it.each([
    ['no signature', { sig: '' }],
    ['a wrong key', { key: OTHER }],
    ['a timestamp over 5 minutes old', { ts: NOW - 301 }],
    ['a timestamp from the future', { ts: NOW + 301 }],
  ])('%s gets 401 and wakes nobody', async (_name, opts) => {
    const { app, calls, tick } = setup();
    const res = await app.request('/', { method: 'POST', headers: headers(pulseBody, opts), body: pulseBody });
    await tick();
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('a reply or tracker off the course origin gets 401', async () => {
    const { app, calls, tick } = setup();
    for (const body of [
      pulseBody.replace(`${ORIGIN}/rig/reply`, 'https://evil.example/rig/reply'),
      pulseBody.replace(`${ORIGIN}/rig/tracker`, 'https://hq.mega.dev.evil.example/rig/tracker'),
      pulseBody.replace(`${ORIGIN}/rig/reply`, 'http://hq.mega.dev/rig/reply'),
    ]) {
      const res = await app.request('/', { method: 'POST', headers: headers(body), body });
      expect(res.status).toBe(401);
    }
    await tick();
    expect(calls).toEqual([]);
  });

  it('a resend with the same webhook-id is handled once', async () => {
    const { app, calls, tick } = setup();
    const h = headers(pulseBody);
    const a = await app.request('/', { method: 'POST', headers: h, body: pulseBody });
    const b = await app.request('/', { method: 'POST', headers: headers(pulseBody, { ts: NOW + 10 }), body: pulseBody });
    await tick();
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(calls).toEqual(['pulse msg_1 amber fox']);
  });
});

describe('GET /.well-known/mega-pulse.json', () => {
  it('shows the owner and the least rights', async () => {
    const { app } = setup();
    const res = await app.request('/.well-known/mega-pulse.json');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(agentsFile('own-test'));
    expect(agentsFile('own-test').agents).toEqual({
      pulse: { wakes: 'pulse', may: ['answer'] },
      'test-writer': { wakes: 'test', may: ['test'] },
    });
  });
});
