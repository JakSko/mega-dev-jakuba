import { Hono } from 'hono';
import type { AgentsEnv } from './env.js';
import { maskToken } from './guard.js';
import { parsePing, type PulsePing, type TestPing } from './pings.js';
import { Seen } from './seen.js';
import { verify } from './webhook.js';

export type Agents = {
  pulse: (ping: PulsePing, id: string) => Promise<void>;
  test: (ping: TestPing, id: string) => Promise<void>;
};

export const MAX_BODY_BYTES = 2 * 1024 * 1024;

// What the course reads to know the host is ours and what each agent may do (docs/course-api.md).
// Least rights: the pulse only answers, the test writer only sends tests (ADR 0005, 0006).
export function agentsFile(ownerCode: string) {
  return {
    owner: ownerCode,
    agents: {
      pulse: { wakes: 'pulse', may: ['answer'] },
      'test-writer': { wakes: 'test', may: ['test'] },
    },
  };
}

export type Log = (entry: Record<string, unknown>) => void;
export const defaultLog: Log = (e) => console.log(JSON.stringify({ at: new Date().toISOString(), ...e }));

export function createAgentsApp(
  env: Pick<AgentsEnv, 'ownerCode' | 'pingKeys' | 'courseOrigin'>,
  agents: Agents,
  opts: { seen?: Seen; now?: () => number; log?: Log } = {},
) {
  const seen = opts.seen ?? new Seen();
  const log = opts.log ?? defaultLog;
  const app = new Hono();

  app.get('/.well-known/mega-pulse.json', (c) => c.json(agentsFile(env.ownerCode)));
  app.get('/health', (c) => c.json({ ok: true }));

  app.post('/', async (c) => {
    const raw = await c.req.text();
    const id = c.req.header('webhook-id') ?? null;
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
      log({ event: 'ping', id, verdict: 'rejected', why: 'body too large' });
      return c.json({ error: 'rejected' }, 413);
    }
    const v = verify(
      { id, timestamp: c.req.header('webhook-timestamp'), signature: c.req.header('webhook-signature') },
      raw,
      env.pingKeys,
      opts.now ? opts.now() : undefined,
    );
    // A rejected request is kept whole too (cut at 4000 characters, any reply token masked):
    // it may say something worth knowing, but it is never acted on.
    const rejected = (why: string) => {
      let reply = '';
      try {
        reply = String((JSON.parse(raw) as { reply?: unknown }).reply ?? '');
      } catch {
        reply = '';
      }
      log({ event: 'ping', id, verdict: 'rejected', why });
      log({
        event: 'rejected body',
        id,
        userAgent: c.req.header('user-agent') ?? null,
        timestamp: c.req.header('webhook-timestamp') ?? null,
        signatures: (c.req.header('webhook-signature') ?? '').split(' ').filter(Boolean).length,
        body: maskToken(raw.slice(0, 4000), reply),
      });
      return c.json({ error: 'rejected' }, 401);
    };
    if (!v.ok) return rejected(v.why);
    const p = parsePing(raw, env.courseOrigin);
    if (!p.ok) return rejected(p.why);
    if (!seen.first(id!)) {
      log({ event: 'ping', id, kind: p.ping.kind, verdict: 'resend, already handled' });
      return c.json({ received: true, resend: true }, 202);
    }
    log({ event: 'ping', id, kind: p.ping.kind, verdict: 'accepted' });
    // The course's own words, kept whole for later (reply token masked).
    log({ event: 'ping body', id, userAgent: c.req.header('user-agent') ?? null, body: maskToken(raw, p.ping.reply) });
    // Answer the course at once (it times out slow receivers); the work runs after.
    const ping = p.ping;
    setImmediate(() => {
      const run = ping.kind === 'pulse' ? agents.pulse(ping, id!) : agents.test(ping, id!);
      run.catch((e: unknown) => log({ event: 'agent error', id, kind: ping.kind, error: String(e).slice(0, 300) }));
    });
    return c.json({ received: true }, 202);
  });

  return app;
}
