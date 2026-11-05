import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Log } from './guard.ts';
import { Seen } from './store.ts';
import { verify } from './webhook.ts';

// One small public service: a health check, a public rights file (least rights per agent,
// S01E05 "The file decides what it may touch"), and one signed event endpoint.
// Checks run in code before any work: size, signature, age, resend. A bad request gets
// 401 and costs nothing; a good one gets 202 at once and the work runs after.

export type Event = { id: string; raw: string; body: unknown; headers: Record<string, string | undefined> };
export type Handler = (event: Event) => Promise<void>;

export type ServiceConfig = {
  keys: string[]; // signing keys; two during a key change
  rights: unknown; // the public rights file, served as JSON
  rightsPath?: string; // default /.well-known/agent-rights.json
  eventPath?: string; // default /
  handle: Handler;
  log: Log;
  seen?: Seen;
  maxBodyBytes?: number;
  now?: () => number; // seconds, for tests
};

function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        resolve(null);
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createService(cfg: ServiceConfig): Server {
  const seen = cfg.seen ?? new Seen();
  const rightsPath = cfg.rightsPath ?? '/.well-known/agent-rights.json';
  const eventPath = cfg.eventPath ?? '/';
  const limit = cfg.maxBodyBytes ?? 1024 * 1024;

  return createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const path = new URL(req.url ?? '/', 'http://local').pathname;

    if (req.method === 'GET' && path === '/health') return send(200, { ok: true });
    if (req.method === 'GET' && path === rightsPath) return send(200, cfg.rights);
    if (req.method !== 'POST' || path !== eventPath) return send(404, { error: 'not found' });

    const raw = await readBody(req, limit);
    const h = (k: string) => (req.headers[k] as string | undefined) ?? undefined;
    const id = h('webhook-id') ?? null;
    if (raw === null) {
      cfg.log({ event: 'request', id, verdict: 'rejected', why: 'body too large' });
      return send(413, { error: 'rejected' });
    }
    const v = verify({ id, timestamp: h('webhook-timestamp'), signature: h('webhook-signature') }, raw, cfg.keys, cfg.now?.());
    if (!v.ok) {
      // Kept whole (masked): a refused request may say something worth knowing, but is never acted on.
      cfg.log({ event: 'request', id, verdict: 'rejected', why: v.why, userAgent: h('user-agent') ?? null, body: raw });
      return send(401, { error: 'rejected' });
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      cfg.log({ event: 'request', id, verdict: 'rejected', why: 'body is not JSON', body: raw });
      return send(400, { error: 'rejected' });
    }
    if (!seen.first(id!)) {
      cfg.log({ event: 'request', id, verdict: 'resend, already handled' });
      return send(202, { received: true, resend: true });
    }
    cfg.log({ event: 'request', id, verdict: 'accepted', body: raw });
    send(202, { received: true });

    const headers: Record<string, string | undefined> = {};
    for (const [k, val] of Object.entries(req.headers)) headers[k] = Array.isArray(val) ? val.join(', ') : val;
    try {
      await cfg.handle({ id: id!, raw, body, headers });
      cfg.log({ event: 'handled', id, verdict: 'done' });
    } catch (err) {
      cfg.log({ event: 'handled', id, verdict: 'failed', why: String((err as Error)?.message ?? err) });
    }
  });
}
