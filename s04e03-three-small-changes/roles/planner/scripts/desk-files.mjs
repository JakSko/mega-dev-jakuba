// desk-files: lists the Host Desk's files for the planner, whose read tool cannot list a folder.
// Names only, from git (tracked files), so nothing ignored (vars.json, journal/, out/) is shown.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const top = resolve(import.meta.dirname, '../../..');
process.stdout.write(execFileSync('git', ['-C', top, 'ls-files'], { encoding: 'utf8', maxBuffer: 1 << 22 }));
