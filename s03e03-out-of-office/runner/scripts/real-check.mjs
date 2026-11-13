// Real-model check, local: runs the Codex adapter on a few issues against a throwaway working copy.
// Usage: node scripts/real-check.mjs <key file> <codex.js> [--build]
// Sends nothing to any tracker. The key is read from the file and never printed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeLog } from '../src/lib.mjs';
import { makeGit, runGates } from '../src/gates.mjs';
import { validateDecision } from '../src/machine.mjs';
import { makeCodexAgent } from '../src/agent-codex.mjs';

const [keyFile, codexJs, ...flags] = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));
const api = process.env.API_DIR ?? path.join(here, '..', '..', 'example-api');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 's03e03-real-'));
fs.cpSync(api, work, { recursive: true, filter: (s) => !/node_modules|\.wrangler/.test(s) });
const git = (...a) => execFileSync('git', a, { cwd: work, encoding: 'utf8' });
git('init', '-q', '-b', 'main'); git('config', 'user.name', 'runner'); git('config', 'user.email', 'runner@test.invalid'); git('config', 'core.autocrlf', 'false');
fs.appendFileSync(path.join(work, '.git', 'info', 'exclude'), '.runner/\n');
git('add', '-A'); git('commit', '-q', '-m', 'base');

const key = keyFile === '-' ? process.env.OPENAI_API_KEY : fs.readFileSync(keyFile, 'utf8').trim();
const home = fs.mkdtempSync(path.join(os.tmpdir(), 's03e03-codexhome-'));
const log = makeLog(path.join(work, '..', `${path.basename(work)}.log`), [key]);
const models = { build: process.env.MODEL_BUILD ?? 'gpt-6-astra', review: process.env.MODEL_REVIEW ?? 'gpt-6.1-sol' };
const agent = makeCodexAgent({ work, schemaDir: path.join(here, '..', 'schemas'), models, log, bin: codexJs === 'codex' ? 'codex' : [process.execPath, codexJs], env: { ...process.env, OPENAI_API_KEY: key, CODEX_HOME: home } });

const at = '2026-11-12T10:00:00.000Z';
const mk = (n, title, body, label) => ({ n, title, body, openedAt: at, labels: [label], closed: false, thread: [{ by: 'agent', at, kind: 'comment', body: `Picked up #${n}: reading it now.` }] });
const issues = JSON.parse(fs.readFileSync(path.join(here, 'dev-issues.json'), 'utf8')).map((i, k) => mk(k + 1, i.title, i.body, i.label));
const records = [];
const only = flags.find((f) => /^\d+(,\d+)*$/.test(f))?.split(',');

for (const is of issues) {
  if (only && !only.includes(String(is.n))) continue;
  const ctx = { issue: is, records, shiplog: '', followup: false, previous: null, otherIssues: issues.filter((o) => o.n !== is.n).map((o) => ({ n: o.n, title: o.title, body: o.body, openedAt: o.openedAt, closed: false, labels: o.labels, ours: 'not decided yet' })) };
  const t0 = Date.now();
  let d; let errs = [];
  try { d = await agent.triage(ctx, []); errs = validateDecision(d, { n: is.n }); } catch (e) { console.log(`#${is.n} TRIAGE FAILED: ${e.message}`); continue; }
  console.log(`\n=== #${is.n} ${is.title} (${Math.round((Date.now() - t0) / 1000)} s)`);
  console.log(JSON.stringify({ verb: d.verb, reason: d.reason, cites: d.cites, touches: d.touches, openRisks: d.openRisks, comment: d.comment, liveChecks: d.liveChecks, question: d.question, options: d.options?.map((o) => `${o.n} ${o.kind}: ${o.text}`), recommendation: d.recommendation, rulesRefused: errs }, null, 1));
  fs.writeFileSync(path.join(work, '..', `${path.basename(work)}-decision-${is.n}.json`), JSON.stringify(d, null, 1));
  if (flags.includes('--build') && d.verb === 'build' && !errs.length) {
    const g = makeGit(work); const base = g.head(); const b0 = Date.now();
    await agent.build({ issue: is, brief: d.brief, feedback: '', allowContract: false });
    const gates = runGates(work, { base, allowContract: false });
    console.log(`build ${Math.round((Date.now() - b0) / 1000)} s; files: ${g.changed().join(', ')}; gates: ${gates.ok ? 'ok' : gates.why}`);
    if (gates.ok) { const r = await agent.review({ issue: is, brief: d.brief, diff: g.diff(), touches: d.touches, allowContract: false }); console.log(`review: ${JSON.stringify(r)}`); }
    console.log(g.diff().split('\n').filter((l) => /^[+-]/.test(l)).slice(0, 60).join('\n'));
    g.reset(base);
  }
}
console.log(`\nwork copy: ${work}`);
