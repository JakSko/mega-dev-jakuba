import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Secrets never leave the host: every outgoing body and every log line passes through here.

// S02E02: AgentMail keys start with `am_` (docs: knowledge-base/getting-api-key); the
// WebSocket URL carries the key as `api_key=`.
const KEY_SHAPES = [
  /whsec_[A-Za-z0-9+/=]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bam_[A-Za-z0-9_-]{16,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /api_key=[^&\s"]+/gi,
];

// Replaces each known secret (and anything shaped like a key) with a placeholder.
export function mask(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join('<secret>');
  for (const p of KEY_SHAPES) out = out.replace(p, '<key-shaped>');
  return out;
}

// For outgoing bodies: refuse to send rather than mask, so a leak is a visible failure.
export function holdsSecret(text: string, secrets: string[]): string | null {
  for (const s of secrets) if (s && s.length >= 8 && text.includes(s)) return 'body holds a secret';
  for (const p of KEY_SHAPES) {
    p.lastIndex = 0;
    if (p.test(text)) return 'body holds something shaped like a key';
  }
  return null;
}

// The other side's messages are logged whole from the first deploy (S01E05 snag 4: a lost
// ping cannot be read again). One JSON line per event to stdout (the host log) and,
// when LOG_FILE is set, to a file. Bodies are cut at `cut` characters and masked.
export type Log = (entry: Record<string, unknown>) => void;

export function makeLog(opts: { secrets: string[]; file?: string | null; cut?: number; out?: (line: string) => void }): Log {
  const cut = opts.cut ?? 8000;
  const out = opts.out ?? ((line: string) => console.log(line));
  return (entry) => {
    const e: Record<string, unknown> = { at: new Date().toISOString(), ...entry };
    for (const k of Object.keys(e)) if (typeof e[k] === 'string') e[k] = (e[k] as string).slice(0, cut);
    const line = mask(JSON.stringify(e), opts.secrets);
    out(line);
    if (opts.file) {
      mkdirSync(dirname(opts.file), { recursive: true });
      appendFileSync(opts.file, line + '\n');
    }
  };
}
