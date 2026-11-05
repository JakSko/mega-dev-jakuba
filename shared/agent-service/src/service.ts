import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Log } from './guard.ts';
import { Seen } from './store.ts';
import { verify } from './webhook.ts';

// One small public service: a health check, a public rights file (least rights per agent,
// S01E05 "The file decides what it may touch"), and one authenticated event endpoint.
// Checks run in code before any work: size, sender, age, resend. A bad request gets
// 401 and costs nothing; a good one gets 202 at once and the work runs after.

export type Header = (name: string) => string | undefined;

// Who sent it, and the event's stable id. Default: Standard Webhooks (S01E05).
// For mail (S02E02): the provider's own signature check, and the Message-ID as the id.
export type Authenticate = (header: Header, raw: string) => { ok: true; id: string } | { ok: false; why: string };

export function standardWebhooks(keys: string[], now?: () => number): Authenticate {
  return (header, raw) => {
    const id = header('webhook-id');
    const v = verify({ id, timestamp: header('webhook-timestamp'), signature: header('webhook-signature') }, raw, keys, now?.());
    return v.ok ? { ok: true, id: id! } : v;
  };
}

export type Event = { id: string; raw: string; body: unknown; headers: Record<string, string | undefined> };
export type Handler = (event: Event) => Promise<void>;

export type ServiceConfig = {
  keys?: string[]; // signing keys for the default check; two during a key change
  authenticate?: Authenticate; // replaces the default check
  parse?: (raw: string) => unknown; // default JSON.parse
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
  const authenticate = cfg.authenticate ?? standardWebhooks(cfg.keys ?? [], cfg.now);
  const parse = cfg.parse ?? ((raw: string) => JSON.parse(raw));

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
    const header: Header = (k) => {
      const v = req.headers[k.toLowerCase()];
      return Array.isArray(v) ? v.join(', ') : v;
    };
    if (raw === null) {
      cfg.log({ event: 'request', verdict: 'rejected', why: 'body too large' });
      return send(413, { error: 'rejected' });
    }
    const who = authenticate(header, raw);
    if (!who.ok) {
      // Kept whole (masked): a refused request may say something worth knowing, but is never acted on.
      cfg.log({ event: 'request', verdict: 'rejected', why: who.why, userAgent: header('user-agent') ?? null, body: raw });
      return send(401, { error: 'rejected' });
    }
    const id = who.id;
    let body: unknown;
    try {
      body = parse(raw);
    } catch {
      cfg.log({ event: 'request', id, verdict: 'rejected', why: 'body does not parse', body: raw });
      return send(400, { error: 'rejected' });
    }
    const state = seen.begin(id);
    if (state !== 'new') {
      cfg.log({ event: 'request', id, verdict: state === 'done' ? 'resend, already handled' : 'resend, still running' });
      return send(202, { received: true, resend: true });
    }
    cfg.log({ event: 'request', id, verdict: 'accepted', body: raw });
    send(202, { received: true });

    const headers: Record<string, string | undefined> = {};
    for (const k of Object.keys(req.headers)) headers[k] = header(k);
    try {
      await cfg.handle({ id, raw, body, headers });
      seen.finish(id);
      cfg.log({ event: 'handled', id, verdict: 'done' });
    } catch (err) {
      seen.release(id);
      cfg.log({ event: 'handled', id, verdict: 'failed, a resend will retry', why: String((err as Error)?.message ?? err) });
    }
  });
}
