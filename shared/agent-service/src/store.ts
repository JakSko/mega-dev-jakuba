import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Seen: one action per event id. A sender that retries keeps the id, so a resend never acts
// twice (lesson 2.1: "prevent duplicate effects"). An id is `done` only after the work
// succeeded; if the work fails or the process dies first, the id is free again and a resend
// is handled (at-least-once, not at-most-once). Only done ids go to the file.
// Not covered: work that already made its outside effect and then crashed before `finish`.
// For that, pass the event id to the outside service as its idempotency key.
// On a host, `file` must sit on a volume that survives deploys (Railway: mount one on VAR_DIR).
export type SeenState = 'new' | 'running' | 'done';

export class Seen {
  done = new Set<string>();
  running = new Set<string>();
  file: string | null;

  constructor(file: string | null = 'var/seen-ids.txt') {
    this.file = file;
    if (!file) return;
    try {
      for (const line of readFileSync(file, 'utf8').split('\n')) if (line) this.done.add(line);
    } catch {
      // no file yet
    }
  }

  // Claims an id for work. 'new' means the caller now owns it and must call finish or release.
  begin(id: string): SeenState {
    if (this.done.has(id)) return 'done';
    if (this.running.has(id)) return 'running';
    this.running.add(id);
    return 'new';
  }

  finish(id: string): void {
    this.running.delete(id);
    if (this.done.has(id)) return;
    this.done.add(id);
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, `${id}\n`);
    }
  }

  // The work failed: free the id so a resend can try again.
  release(id: string): void {
    this.running.delete(id);
  }
}

// Budget: a daily cap on model calls shared by every agent on one key. Every wake spends
// money, so the cap is checked before the call, not after (S01E05 debrief, "Anyone can wake it").
export class Budget {
  perDay: number;
  file: string | null;
  today: () => string;
  mem = { day: '', used: 0 };

  constructor(perDay: number, file: string | null = 'var/model-calls.json', today = () => new Date().toISOString().slice(0, 10)) {
    this.perDay = perDay;
    this.file = file;
    this.today = today;
  }

  read(): { day: string; used: number } {
    if (!this.file) return this.mem;
    try {
      return JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return { day: this.today(), used: 0 };
    }
  }

  take(): boolean {
    const s = this.read();
    const day = this.today();
    const used = s.day === day ? s.used : 0;
    if (used >= this.perDay) return false;
    const next = { day, used: used + 1 };
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(next));
    } else this.mem = next;
    return true;
  }

  left(): number {
    const s = this.read();
    return this.perDay - (s.day === this.today() ? s.used : 0);
  }
}
