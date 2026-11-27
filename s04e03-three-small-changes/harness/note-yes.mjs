// The owner's yes, written into the team's event log: what it covers and the owner's own words.
//   node /harness/note-yes.mjs <desk> --covers "<the posts or the step>" --words "<what the owner wrote in chat>"
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { redact } from './redact.mjs';

const [deskArg, ...rest] = process.argv.slice(2);
const opt = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);
const covers = opt('--covers');
const words = opt('--words');
if (!deskArg || !covers || !words) {
  console.error('usage: note-yes.mjs <desk> --covers <text> --words <text>');
  process.exit(1);
}
const desk = resolve(deskArg);
let secrets = [];
try {
  secrets = Object.entries(JSON.parse(readFileSync(join(desk, 'vars.json'), 'utf8'))).filter(([, v]) => typeof v === 'string' && v.length >= 6);
} catch {
  // no vars.json yet
}
const out = join(dirname(desk), 'out');
mkdirSync(out, { recursive: true });
const line = { at: new Date().toISOString(), role: 'owner', event: 'yes', covers: redact(covers, secrets), words: redact(words, secrets) };
appendFileSync(join(out, 'events.jsonl'), JSON.stringify(line) + '\n');
console.log(`yes noted for: ${line.covers}`);
