// The two pings the course sends (docs/course-api.md).
export type PulsePing = { kind: 'pulse'; text: string; phrase: string; reply: string; tracker: string };
export type TestPing = { kind: 'test'; issue: number; reply: string; files: Record<string, string> };
export type Ping = PulsePing | TestPing;

export type Parsed = { ok: true; ping: Ping } | { ok: false; why: string };

export function onOrigin(url: unknown, origin: string): boolean {
  if (typeof url !== 'string') return false;
  try {
    // The origin carries the scheme: with COURSE_ORIGIN=https://hq.mega.dev only https on that
    // exact host passes (a local fake course on http://127.0.0.1 is its own origin).
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

// Parse only after the signature holds. `reply` and `tracker` must be on the course origin.
export function parsePing(raw: string, origin: string): Parsed {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(raw);
  } catch {
    return { ok: false, why: 'body is not JSON' };
  }
  if (!onOrigin(j.reply, origin)) return { ok: false, why: 'reply is not on the course origin' };
  if (j.kind === 'pulse') {
    if (!onOrigin(j.tracker, origin)) return { ok: false, why: 'tracker is not on the course origin' };
    return {
      ok: true,
      ping: {
        kind: 'pulse',
        text: typeof j.text === 'string' ? j.text : '',
        phrase: typeof j.phrase === 'string' ? j.phrase : '',
        reply: j.reply as string,
        tracker: j.tracker as string,
      },
    };
  }
  if (j.kind === 'test') {
    const files = j.files && typeof j.files === 'object' ? (j.files as Record<string, unknown>) : {};
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(files)) if (typeof v === 'string') clean[k] = v;
    return { ok: true, ping: { kind: 'test', issue: Number(j.issue), reply: j.reply as string, files: clean } };
  }
  return { ok: false, why: 'unknown kind' };
}
