// Sends held findings once . Without --send it only checks and prints the exact body.
//
// Usage: node tools/send-review.mjs <body.json> <ids.json> <review-url> <outdir> [--same old=new ...] [--send]
//   ids.json  the served hunk ids, as a JSON array
//   --same    pairs of files (patch, settings: saved sample and fresh copy) that must be byte-equal
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFindings } from '../lib/findings.mjs';
import { redact } from '../lib/redact.mjs';

const DESK = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const send = args.includes('--send');
const pairs = args.flatMap((a, i) => (a === '--same' ? [args[i + 1].split('=')] : []));
const [bodyFile, idsFile, url, outdir] = args;
if (!outdir) { console.error('Usage: see the head of this file'); process.exit(1); }
if (new URL(url).origin !== (process.env.COURSE_ORIGIN ?? 'https://course.example')) { console.error('refused: the review URL must be on the course origin'); process.exit(1); }
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

const text = readFileSync(bodyFile, 'utf8');
const problems = checkFindings(JSON.parse(text), JSON.parse(readFileSync(idsFile, 'utf8')));
for (const [a, b] of pairs) if (sha(a) !== sha(b)) problems.push(`changed since the sample: ${b} differs from ${a}`);
const vars = JSON.parse(readFileSync(join(DESK, 'vars.json'), 'utf8'));
const secrets = Object.entries(vars).filter(([, v]) => typeof v === 'string' && v.length >= 6);
if (secrets.some(([, v]) => text.includes(v))) problems.push('the body holds a secret value');
console.log(`POST ${url}\nbody sha256 ${sha(bodyFile)}\n${redact(text, secrets)}`);
if (problems.length) { console.error(`NOT SENT:\n- ${problems.join('\n- ')}`); process.exit(1); }
if (!send) { console.log('check only: add --send after the yes'); process.exit(0); }

mkdirSync(outdir, { recursive: true });
const lock = join(outdir, `sent-${sha(bodyFile).slice(0, 12)}.lock`);
if (existsSync(lock)) { console.error('NOT SENT: this body was already sent or tried; look for the reply first'); process.exit(1); }
writeFileSync(lock, new Date().toISOString(), { flag: 'wx' });
const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${vars.ATTEMPT}` }, body: text, redirect: 'manual' });
const reply = await res.text();
writeFileSync(join(outdir, `review-reply-${sha(bodyFile).slice(0, 12)}.raw`), reply);
console.log(`reply: http ${res.status}\n${redact(reply, secrets)}`);
