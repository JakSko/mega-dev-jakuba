// Closes one issue file the ADR 0004 way: state and closed changed in place in the frontmatter,
// then the AGENTS.md closing comment under its own heading at the end.
// usage: node tools/close_issue.mjs <id> "<done line>" "<harness> · <model> · <effort>" <sha>
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const [id, done, worker, sha] = process.argv.slice(2);
if (!id || !done || !worker || !/^[0-9a-f]{7,40}$/.test(sha ?? '')) {
  console.error('usage: close_issue.mjs <id> "<done>" "<harness> · <model> · <effort>" <sha>');
  process.exit(2);
}
const nnn = String(Number(id)).padStart(3, '0');
const file = readdirSync('docs/issues').find((f) => f.startsWith(`${nnn}-`));
if (!file) throw new Error(`no issue ${nnn}`);
const path = `docs/issues/${file}`;
let t = readFileSync(path, 'utf8');
if (/^state: closed$/m.test(t)) throw new Error(`${file} is already closed`);
const d = new Date();
const off = -d.getTimezoneOffset();
const pad = (n) => String(Math.abs(n)).padStart(2, '0');
const local = new Date(d.getTime() + off * 60e3).toISOString().slice(0, 19);
const stamp = `${local}${off >= 0 ? '+' : '-'}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
t = t.replace(/^state: open$/m, 'state: closed').replace(/^closed: null$/m, `closed: ${stamp}`);
t = `${t.trimEnd()}\n\n## Closing comment\n\ndone: ${done}\nworker: ${worker}\ncommit: ${sha}\n`;
writeFileSync(path, t);
console.log(`closed ${file} at ${stamp}`);
