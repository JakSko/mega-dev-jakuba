#!/usr/bin/env node
// Builds the claim-challenge answer from the files (plan step 12), never by retyping.
//
//   node build_claim.mjs --issues <doc/issues dir> --skill <SKILL.md> --skill-path <path as sent> --session <file> --out <json>
//
// answer = { session, tracker: { kind: "md", files: [{ path: "doc/issues/<name>", text }] }, skill: { name, path, text } }
// Prints: file count, byte size of the answer as JSON (limit 256 KB), sha256 of the issue texts in name order
// (equal to `cat doc/issues/*.md | sha256sum`), sha256 of the skill text. Writes the full answer to --out and a copy
// with the session masked next to it (<out>.masked.json). Sends nothing.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const [issues, skillFile, skillPath, sessionFile, out] = ['issues', 'skill', 'skill-path', 'session', 'out'].map(arg);
if (!issues || !skillFile || !skillPath || !sessionFile || !out) {
  console.error('usage: node build_claim.mjs --issues <dir> --skill <SKILL.md> --skill-path <path> --session <file> --out <json>');
  process.exit(2);
}
const names = readdirSync(issues).filter((f) => f.endsWith('.md')).sort();
const files = names.map((f) => ({ path: `doc/issues/${f}`, text: readFileSync(join(issues, f), 'utf8') }));
const skillText = readFileSync(skillFile, 'utf8');
const session = readFileSync(sessionFile, 'utf8').trim();
const answer = { session, tracker: { kind: 'md', files }, skill: { name: 'triage', path: skillPath, text: skillText } };
const json = JSON.stringify(answer);
const bytes = Buffer.byteLength(json, 'utf8');
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
writeFileSync(out, json);
writeFileSync(out.replace(/\.json$/, '') + '.masked.json', JSON.stringify({ ...answer, session: `${session.slice(0, 3)}...MASKED` }, null, 2));
console.log(`files: ${files.length}`);
console.log(`answer bytes: ${bytes} of 262144 (${bytes <= 262144 ? 'ok' : 'TOO BIG'})`);
console.log(`tracker sha256: ${sha(files.map((f) => f.text).join(''))}`);
console.log(`skill sha256: ${sha(skillText)} (${Buffer.byteLength(skillText, 'utf8')} bytes)`);
process.exitCode = bytes <= 262144 ? 0 : 1;
