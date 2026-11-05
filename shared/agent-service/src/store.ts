import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Seen: one action per event id. A sender that retries keeps the id, so a resend or a
// restart never acts twice (lesson 2.1: "prevent duplicate effects"). File-backed, no database.
export class Seen {
  ids = new Set<string>();
  file: string | null;

  constructor(file: string | null = 'var/seen-ids.txt') {
    this.file = file;
    if (!file) return;
    try {
      for (const line of readFileSync(file, 'utf8').split('\n')) if (line) this.ids.add(line);
    } catch {
      // no file yet
    }
  }

  // true the first time an id is offered, false after.
  first(id: string): boolean {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, `${id}\n`);
    }
    return true;
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
