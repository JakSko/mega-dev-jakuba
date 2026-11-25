// Starts practice or run for the attempt in vars.json. Usage: node tools/start.mjs practice|run <outfile>
import { readFileSync, writeFileSync } from 'node:fs';
import { log, mask } from '../lib/journal.mjs';
const [mode, out] = process.argv.slice(2);
if (!['practice', 'run'].includes(mode)) { console.error('mode must be practice or run'); process.exit(1); }
const vars = JSON.parse(readFileSync(new URL('../vars.json', import.meta.url), 'utf8'));
if (!process.env.API_BASE) { console.error('Set API_BASE (the Challenge API address).'); process.exit(1); }
const url = `${process.env.API_BASE}/${mode}`;
log({ tool: 'start', req: { method: 'POST', url, body: { attempt: '{{ATTEMPT}}' } } });
const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ attempt: vars.ATTEMPT }), redirect: 'manual' });
const text = await res.text();
log({ tool: 'start', res: { status: res.status, bytes: text.length, body: text } });
writeFileSync(out, text);
console.log(`${res.status} ${res.headers.get('content-type')} ${text.length} bytes -> ${out}`);
