import type { Server } from 'node:http';
import type { Policy } from './acts.ts';
import { Agent } from './agent.ts';
import { courseAuth, PENDING, PendingQueue, verifyCourse } from './course.ts';
import type { Log } from './guard.ts';
import { createService } from './service.ts';
import { Seen } from './store.ts';

// Wires the course check, the key handoff queue and the agent into one service. Used by
// main.ts on the host and by the tests (memory state, fake clock, fake fetch).

export type AppConfig = {
  key: string | null; // the signingKey, or "pending" until the register reply
  policy: Policy;
  publicUrl: string;
  ownerCode: string;
  ntfy: { url: string; topic: string } | null;
  varDir: string | null;
  log: Log;
  now?: () => number;
  fetch?: typeof fetch;
  heldMs?: number;
  allowHttpReply?: boolean;
  testMode?: boolean;
  eventPath?: string;
};

export type App = { server: Server; agent: Agent; seen: Seen; queue: PendingQueue; setKey: (k: string) => void; drain: () => Promise<{ handled: number; rejected: number }> };

export function createApp(cfg: AppConfig): App {
  let key = cfg.key;
  const now = cfg.now ?? Date.now;
  const v = cfg.varDir;
  const agent = new Agent({
    policy: cfg.policy,
    publicUrl: cfg.publicUrl,
    ownerCode: cfg.ownerCode,
    ntfy: cfg.ntfy,
    varDir: v,
    log: cfg.log,
    now,
    fetch: cfg.fetch,
    heldMs: cfg.heldMs,
    allowHttpReply: cfg.allowHttpReply,
    testMode: cfg.testMode,
  });
  const seen = new Seen(v ? `${v}/seen-ids.txt` : null);
  const queue = new PendingQueue(v ? `${v}/pending.jsonl` : null);

  const server = createService({
    authenticate: courseAuth(() => key, now),
    rights: { owner: 'jaksko', challenge: 'S02E05 while you are away', channel: 'https', policy: cfg.policy, approval: 'gated acts need the owner code on the approve page' },
    eventPath: cfg.eventPath ?? '/',
    seen,
    log: cfg.log,
    route: agent.route,
    onPending: (h, raw) => queue.add({ receivedAt: now(), timestamp: h('x-course-timestamp'), signature: h('x-course-signature'), raw }),
    handle: (e) => agent.handle(e),
  });

  // After the real key is set: check each stored POST against the time it arrived, handle valid ones once.
  const drain = async () => {
    let handled = 0;
    let rejected = 0;
    for (const s of queue.drain()) {
      const r = verifyCourse(key, s.timestamp, s.signature, s.raw, s.receivedAt);
      if (!r.ok) {
        rejected++;
        cfg.log({ event: 'request', verdict: 'rejected after key set', why: r.why, body: s.raw });
        continue;
      }
      if (seen.begin(r.id) !== 'new') {
        cfg.log({ event: 'request', id: r.id, verdict: 'stored resend, already handled' });
        continue;
      }
      let body: unknown;
      try {
        body = JSON.parse(s.raw);
      } catch {
        seen.release(r.id);
        rejected++;
        cfg.log({ event: 'request', id: r.id, verdict: 'rejected after key set', why: 'body does not parse' });
        continue;
      }
      cfg.log({ event: 'request', id: r.id, verdict: 'accepted after key set', receivedAt: new Date(s.receivedAt).toISOString(), timestampHeader: s.timestamp ?? null });
      try {
        await agent.handle({ id: r.id, raw: s.raw, body, headers: {} });
        seen.finish(r.id);
        handled++;
      } catch (err) {
        seen.release(r.id);
        cfg.log({ event: 'handled', id: r.id, verdict: 'failed', why: String((err as Error)?.message ?? err) });
      }
    }
    return { handled, rejected };
  };

  return {
    server,
    agent,
    seen,
    queue,
    setKey: (k: string) => {
      key = k;
    },
    drain,
  };
}

export { PENDING };
