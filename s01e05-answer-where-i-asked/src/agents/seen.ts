import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Resend guard: a ping keeps its webhook-id when the course sends it again. One answer per
// id. Kept in memory and in a small file, so a restart does not answer twice (no database:
// docs/vision.md).
export class Seen {
  private ids = new Set<string>();

  constructor(private file: string | null = 'var/seen-pings.txt') {
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
