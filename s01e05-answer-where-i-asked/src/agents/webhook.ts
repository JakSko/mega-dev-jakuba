import { createHmac, timingSafeEqual } from 'node:crypto';

// Standard Webhooks (docs/course-api.md, standardwebhooks.com): HMAC-SHA256 over
// `<id>.<timestamp>.<raw body>`, key = base64-decoded part after `whsec_`, header
// `webhook-signature: v1,<base64> [v1,<base64> ...]` (two during a key change).
export const MAX_AGE_SECONDS = 5 * 60;

export type Verdict = { ok: true } | { ok: false; why: string };

export function keyBytes(secret: string): Buffer {
  return Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
}

export function sign(secret: string, id: string, timestamp: string, body: string): string {
  return createHmac('sha256', keyBytes(secret)).update(`${id}.${timestamp}.${body}`).digest('base64');
}

export function verify(
  headers: { id?: string | null; timestamp?: string | null; signature?: string | null },
  body: string,
  secrets: string[],
  nowSeconds = Math.floor(Date.now() / 1000),
): Verdict {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return { ok: false, why: 'missing webhook headers' };
  if (id.includes('.') || !/^\d+$/.test(timestamp)) return { ok: false, why: 'bad id or timestamp' };
  const age = nowSeconds - Number(timestamp);
  if (age > MAX_AGE_SECONDS || age < -MAX_AGE_SECONDS) return { ok: false, why: 'timestamp out of range' };
  if (secrets.length === 0) return { ok: false, why: 'no ping key configured' };

  const given = signature
    .split(' ')
    .filter((s) => s.startsWith('v1,'))
    .map((s) => Buffer.from(s.slice(3), 'base64'));
  for (const secret of secrets) {
    const want = Buffer.from(sign(secret, id, timestamp, body), 'base64');
    if (given.some((g) => g.length === want.length && timingSafeEqual(g, want))) return { ok: true };
  }
  return { ok: false, why: 'signature does not match' };
}
