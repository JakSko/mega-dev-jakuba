// Checks every package in pnpm-lock.yaml against the npm registry: released at least
// MIN_DAYS before today. Prints one line per package and ends with ALL PASS or SOME FAILED.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const MIN_DAYS = 14;
const lock = readFileSync('pnpm-lock.yaml', 'utf8');
// The lockfile may hold several YAML documents (pnpm itself as packageManager, then the project).
const sections = lock.split(/^---\s*$/m).map((doc) => doc.split(/^packages:\s*$/m)[1]?.split(/^snapshots:\s*$/m)[0] ?? '');
const keys = [
  ...new Map(
    sections
      .flatMap((s) => [...s.matchAll(/^  '?((?:@[^/@\s]+\/)?[^@\s']+)@([^:'(\s]+)'?:/gm)])
      .map((m) => [`${m[1]}@${m[2]}`, [m[1], m[2]]]),
  ).values(),
];
const cut = Date.now() - MIN_DAYS * 86400e3;
let bad = 0;
for (const [name, version] of keys) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const out = execFileSync(npm, ['view', `${name}@${version}`, 'time', '--json'], { encoding: 'utf8', shell: true });
  const at = JSON.parse(out)[version];
  const ok = at && Date.parse(at) <= cut;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}@${version} ${at ?? 'no time'}`);
}
console.log(`${keys.length} packages · ${bad ? 'SOME FAILED' : 'ALL PASS'}`);
process.exit(bad ? 1 : 0);
