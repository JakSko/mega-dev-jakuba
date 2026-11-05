// Looks for secrets in files (A5). The secrets come from a file outside the repo, one per line,
// and are never printed: only the file and how many secrets it holds.
// usage: node tools/check_secrets.mjs <secrets-file> <path> [<path> ...]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [secretsFile, ...paths] = process.argv.slice(2);
if (!secretsFile || paths.length === 0) {
  console.error('usage: check_secrets.mjs <secrets-file> <path> [<path> ...]');
  process.exit(2);
}
const raw = readFileSync(secretsFile, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length >= 8);
// A whsec_ key also counts without its prefix.
const secrets = [...new Set(raw.flatMap((s) => (s.startsWith('whsec_') ? [s, s.slice(6)] : [s])))];
const SKIP = new Set(['node_modules', '.git']);
let files = 0;
let hits = 0;
const walk = (p) => {
  const st = statSync(p);
  if (st.isDirectory()) {
    for (const f of readdirSync(p)) if (!SKIP.has(f)) walk(join(p, f));
    return;
  }
  files++;
  const t = readFileSync(p, 'latin1');
  const n = secrets.filter((s) => t.includes(s)).length;
  if (n) {
    hits++;
    console.log(`HIT ${p}: ${n} secret(s)`);
  }
};
for (const p of paths) walk(p);
console.log(`${files} files, ${secrets.length} secret forms checked · ${hits ? 'SOME FOUND' : 'NONE FOUND'}`);
process.exit(hits ? 1 : 0);
