import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Authenticate, Header } from './service.ts';

// The course's sender check (brief, `https.signature`): every POST carries x-course-timestamp and
// x-course-signature = "sha256=" + hex HMAC-SHA256 of "<timestamp>.<raw body>", keyed with the
// signingKey as given. Checked on the raw bytes, before any work.

export const MAX_AGE_MS = 5 * 60 * 1000;
export const PENDING = 'pending';

export type Verdict = { ok: true; id: string } | { ok: false; why: string };

// The body has no id field (spec Q4): the id is a hash of the raw body, so a resend of the same
// message (same body) maps to the same id even when its timestamp and signature are new.
export function messageId(raw: string): string {
  return 'm_' + createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

export function courseSign(key: string, timestamp: string, raw: string): string {
  return 'sha256=' + createHmac('sha256', key).update(`${timestamp}.${raw}`).digest('hex');
}

// Seconds, milliseconds or an ISO date: the brief does not say which, so all three are read
// and the raw header is logged on the first live message.
export function timestampMs(ts: string): number {
  if (/^\d+$/.test(ts)) {
    const n = Number(ts);
    return n < 1e12 ? n * 1000 : n;
  }
  return Date.parse(ts);
}

export function verifyCourse(key: string | null, timestamp: string | undefined, signature: string | undefined, raw: string, atMs: number): Verdict {
  if (!key || key === PENDING) return { ok: false, why: 'key pending' };
  if (!timestamp || !signature) return { ok: false, why: 'missing x-course headers' };
  const t = timestampMs(timestamp);
  if (Number.isNaN(t)) return { ok: false, why: 'bad timestamp' };
  if (Math.abs(atMs - t) > MAX_AGE_MS) return { ok: false, why: 'timestamp out of range' };
  const want = Buffer.from(courseSign(key, timestamp, raw));
  const given = Buffer.from(signature.trim());
  if (given.length !== want.length || !timingSafeEqual(given, want)) return { ok: false, why: 'signature does not match' };
  return { ok: true, id: messageId(raw) };
}

export function courseAuth(key: () => string | null, now: () => number = Date.now): Authenticate {
  return (header: Header, raw: string) => verifyCourse(key(), header('x-course-timestamp'), header('x-course-signature'), raw, now());
}

// Key handoff (spec R12): the signingKey arrives only in the register reply, and the course may
// write before it is on the host. While the key is pending, each POST is stored whole and gets
// 202; nothing is done. When the host starts with the real key, the stored ones are checked
// against the time they arrived, and only valid ones are handled.
export type Stored = { receivedAt: number; timestamp?: string; signature?: string; raw: string };

export class PendingQueue {
  file: string | null;
  mem: Stored[] = [];

  constructor(file: string | null) {
    this.file = file;
  }

  add(s: Stored): void {
    if (!this.file) {
      this.mem.push(s);
      return;
    }
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, JSON.stringify(s) + '\n');
  }

  // Returns everything stored and moves the file aside, so a restart does not handle it twice
  // (the Seen store also guards each id).
  drain(): Stored[] {
    if (!this.file) {
      const out = this.mem;
      this.mem = [];
      return out;
    }
    if (!existsSync(this.file)) return [];
    const items = readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Stored);
    renameSync(this.file, `${this.file}.drained-${Date.now()}`);
    return items;
  }
}
