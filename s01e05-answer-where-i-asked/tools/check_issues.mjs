// Checks docs/issues/ against ADR 0004: file name <NNN>-<slug>.md, one --- pair, every key once
// and lower case, required keys, id = NNN, state open|closed, closed null iff open, values with
// ':' or '#' quoted, no tabs, a closed issue ends with a closing comment in the AGENTS.md shape.
import { readdirSync, readFileSync } from 'node:fs';

const REQ = ['id', 'title', 'state', 'labels', 'created', 'closed'];
let bad = 0;
const fail = (f, m) => { bad++; console.log(`FAIL ${f}: ${m}`); };
for (const f of readdirSync('docs/issues').sort()) {
  const m = /^(\d{3})-[a-z0-9-]+\.md$/.exec(f);
  if (!m) { fail(f, 'name is not <NNN>-<slug>.md'); continue; }
  const t = readFileSync(`docs/issues/${f}`, 'utf8');
  if (t.includes('\t')) fail(f, 'tab');
  const parts = t.split(/^---$/m);
  if (!t.startsWith('---\n') || parts.length < 3) { fail(f, 'frontmatter fences'); continue; }
  const fm = parts[1].trim().split('\n');
  const keys = {};
  for (const line of fm) {
    const k = /^([^:]+):\s?(.*)$/.exec(line);
    if (!k) { fail(f, `bad line: ${line}`); continue; }
    if (k[1] !== k[1].toLowerCase()) fail(f, `key not lower case: ${k[1]}`);
    if (k[1] in keys) fail(f, `key twice: ${k[1]}`);
    keys[k[1]] = k[2];
    const v = k[2];
    const quoted = /^".*"$/.test(v) || /^\[.*\]$/.test(v);
    if (/[:#]/.test(v) && !quoted && !['created', 'closed'].includes(k[1])) fail(f, `unquoted : or # in ${k[1]}`);
  }
  for (const r of REQ) if (!(r in keys)) fail(f, `missing ${r}`);
  if (Number(keys.id) !== Number(m[1])) fail(f, 'id does not match NNN');
  if (!['open', 'closed'].includes(keys.state)) fail(f, 'state');
  if ((keys.state === 'open') !== (keys.closed === 'null')) fail(f, 'closed must be null exactly while open');
  if (keys.state === 'closed' && !/## Closing comment\n\ndone: .+\nworker: .+ · .+ · .+\ncommit: [0-9a-f]{7,40}\n?$/.test(t)) fail(f, 'closing comment shape or sha');
  if (!/^Done when: /m.test(t)) fail(f, 'no Done when');
}
console.log(bad ? 'SOME FAILED' : 'ALL PASS');
process.exit(bad ? 1 : 0);
