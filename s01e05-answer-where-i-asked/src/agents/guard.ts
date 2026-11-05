import { keyBytes } from './webhook.js';

// Every outgoing body passes here (R7): size limits from docs/course-api.md, no secret and no
// reply token inside, and it goes only to the reply URL of the ping that woke the agent.
export const LIMITS = { pulse: 2000, test: 20 * 1024 } as const;

export type PulseReply = { text: string };
export type TestReply = { path: string; test: string; red: string };
export type Checked = { ok: true } | { ok: false; why: string };

// The reply token is the last part of the reply address (docs/course-api.md).
export function replyToken(reply: string): string {
  try {
    return new URL(reply).pathname.split('/').filter(Boolean).at(-1) ?? '';
  } catch {
    return '';
  }
}

export function secretsOf(env: { pingKeys: string[]; modelKey: string }, reply: string): string[] {
  const s = [...env.pingKeys, ...env.pingKeys.map((k) => keyBytes(k).toString('base64')), env.modelKey, replyToken(reply)];
  return s.filter((x) => x && x.length >= 8);
}

const PATTERNS = [/whsec_[A-Za-z0-9+/=]{8,}/, /\bsk-[A-Za-z0-9_-]{16,}/, /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/i];

export function checkReply(kind: 'pulse' | 'test', body: PulseReply | TestReply, secrets: string[]): Checked {
  const json = JSON.stringify(body);
  if (kind === 'pulse') {
    const t = (body as PulseReply).text;
    if (typeof t !== 'string' || !t.trim()) return { ok: false, why: 'empty pulse text' };
    if (t.length > LIMITS.pulse) return { ok: false, why: `pulse text over ${LIMITS.pulse} characters` };
  } else {
    const b = body as TestReply;
    if (!/^test\/[A-Za-z0-9._-]+\.test\.ts$/.test(b.path ?? '')) return { ok: false, why: 'test path is not test/<name>.test.ts' };
    if (!b.test?.trim() || !b.red?.trim()) return { ok: false, why: 'test or red is empty' };
    if (Buffer.byteLength(json) > LIMITS.test) return { ok: false, why: `test reply over ${LIMITS.test} bytes` };
  }
  for (const s of secrets) if (json.includes(s)) return { ok: false, why: 'reply holds a secret' };
  for (const p of PATTERNS) if (p.test(json)) return { ok: false, why: 'reply holds something shaped like a key' };
  return { ok: true };
}

export type Sent = {
  status: number;
  meaning: 'received' | 'already answered' | 'unknown reply address' | 'too late' | 'other';
  text?: string; // what the course said back, kept for the log
};

// The reply token in a body or URL, replaced before anything is logged.
export function maskToken(s: string, reply: string): string {
  const t = replyToken(reply);
  return t ? s.split(t).join('<reply token>') : s;
}

export async function sendReply(
  reply: string,
  body: PulseReply | TestReply,
  opts: { fetch?: typeof fetch } = {},
): Promise<Sent> {
  const f = opts.fetch ?? fetch;
  const res = await f(reply, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const meaning: Sent['meaning'] =
    res.status === 202 ? 'received' : res.status === 409 ? 'already answered' : res.status === 404 ? 'unknown reply address' : res.status === 410 ? 'too late' : 'other';
  const text = maskToken((await res.text().catch(() => '')).slice(0, 4000), reply);
  return { status: res.status, meaning, text };
}
