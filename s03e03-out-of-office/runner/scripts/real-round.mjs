// A whole round with the real model, local: the real Runner and the real Codex adapter against
// the fake tracker, feed and live address. Nothing leaves this machine except the model calls.
// Usage: node scripts/real-round.mjs <key file> <codex.js> <issues.json> [gap seconds] [out dir]
// The owner in this round follows the agent's recommendation and signs accepted records.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeLog, makeOut, makeTracker, makeState, sleep } from '../src/lib.mjs';
import { makeGit } from '../src/gates.mjs';
import { Runner } from '../src/machine.mjs';
import { makeCodexAgent } from '../src/agent-codex.mjs';
import { fakeTracker, fakeFeed, fakeLive } from '../test/fakes.mjs';

const [keyFile, codexJs, issuesFile, gap = '20', outDir] = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 's03e03-round-'));
fs.cpSync(process.env.API_DIR ?? path.join(here, '..', '..', 'example-api'), work, { recursive: true, filter: (s) => !/node_modules|\.wrangler/.test(s) });
// safe.directory: on the host the working copy is handed to another user after the first commit.
const git = (...a) => execFileSync('git', ['-c', 'safe.directory=*', ...a], { cwd: work, encoding: 'utf8' });
git('init', '-q', '-b', 'main'); git('config', 'user.name', 'runner'); git('config', 'user.email', 'runner@test.invalid'); git('config', 'core.autocrlf', 'false');
fs.appendFileSync(path.join(work, '.git', 'info', 'exclude'), '.runner/\n');
git('add', '-A'); git('commit', '-q', '-m', 'base');
fs.mkdirSync(path.join(work, '.runner'), { recursive: true });
if (process.env.RUN_UID) {
  // On the host: hand the working copy to the user that runs model-written code, as the entrypoint does.
  execFileSync('chown', ['-R', `${process.env.RUN_UID}:${process.env.RUN_GID}`, work]);
}

const data = outDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 's03e03-round-data-'));
fs.mkdirSync(data, { recursive: true });
const key = keyFile === '-' ? process.env.OPENAI_API_KEY : fs.readFileSync(keyFile, 'utf8').trim();
const issues = JSON.parse(fs.readFileSync(issuesFile, 'utf8'));
const feed = await fakeFeed([
  { id: 'INC-1042', service: 'booking-api', summary: 'Slow booking confirmations', status: 'resolved', openedAt: '2026-11-11T01:10:00.000Z' },
  { id: 'INC-1047', service: 'calendar-sync', summary: 'Calendar sync is down', status: 'open', openedAt: '2026-11-11T02:43:00.000Z' },
  { id: 'INC-1045', service: 'notifications', summary: 'Reminder emails delayed', status: 'open', openedAt: '2026-11-11T02:05:00.000Z' },
  { id: 'INC-1048', service: 'calendar-sync', summary: 'Duplicate events after sync retry', status: 'open', openedAt: '2026-11-11T02:51:00.000Z' },
]);
const tracker = await fakeTracker({
  issues: issues.map((i, k) => ({ atMs: k * Number(gap) * 1000, title: i.title, body: i.body, labels: [i.label ?? 'from:product'] })),
  ownerAuto: true, ownerDelayMs: 3000, signDelayMs: 3000,
});
const live = await fakeLive(work, feed.url);
await live.deployer.deploy();

const log = makeLog(path.join(data, 'action.log'), [key, tracker.token], { quiet: true });
const out = makeOut({ log, feedUrl: feed.url });
const notes = [];
const home = fs.mkdtempSync(path.join(os.tmpdir(), 's03e03-codexhome-'));
const models = { build: process.env.MODEL_BUILD ?? 'gpt-6-astra', review: process.env.MODEL_REVIEW ?? 'gpt-6.1-sol' };
const runner = new Runner({
  cfg: { work, liveUrl: live.url, lagMs: 500, maxModelCalls: Number(process.env.MAX_MODEL_CALLS ?? 60), retryMs: 2000 }, log, out,
  notify: async (title, message) => { notes.push(`${title}: ${message}`); console.log(`[ntfy] ${title}: ${message}`); },
  state: makeState(path.join(data, 'state.json')),
  tracker: makeTracker({ out, base: tracker.url, token: tracker.token }),
  git: makeGit(work), deployer: live.deployer,
  agent: makeCodexAgent({ work, schemaDir: path.join(here, '..', 'schemas'), models, log, bin: codexJs === 'codex' ? 'codex' : [process.execPath, codexJs], env: { ...process.env, OPENAI_API_KEY: key, ...(process.env.RUN_UID ? {} : { CODEX_HOME: home }) } }),
});

const t0 = Date.now();
const limit = Number(process.env.ROUND_LIMIT_MIN ?? 40) * 60000;
while (!notes.some((n) => n.startsWith('Round complete')) && Date.now() - t0 < limit) { await runner.cycle(); await sleep(3000); }
await runner.working;

const S = runner.S;
const report = tracker.issues.map((is) => {
  const st = S.issues[is.n] ?? {};
  const first = is.thread.find((t) => t.by === 'agent');
  return {
    n: is.n, title: is.title,
    pickupSeconds: first ? Math.round((Date.parse(first.at) - Date.parse(is.openedAt)) / 100) / 10 : null,
    line: tracker.ship.get(String(is.n)) ?? null, phase: st.phase, verb: st.decision?.verb, reason: st.decision?.reason,
    cites: st.decision?.cites, touches: st.decision?.touches, closed: is.closed, labels: is.labels,
    thread: is.thread.map((t) => `${t.by}/${t.kind}: ${(t.body ?? t.label ?? '').slice(0, 400)}`),
  };
});
const records = [...tracker.records.values()].map((r) => ({ id: r.id, status: r.status, signedBy: r.signedBy, versions: r.history.length, text: r.text }));
const summary = {
  minutes: Math.round((Date.now() - t0) / 6000) / 10, complete: notes.some((n) => n.startsWith('Round complete')), modelCalls: S.modelCalls,
  feedWrites: feed.writes, deploys: live.deployer.versions.length - 1, notes,
  gitLog: git('log', '--format=%s').trim().split('\n'),
};
fs.writeFileSync(path.join(data, 'round-report.json'), JSON.stringify({ summary, report, records }, null, 1));
console.log('\n=== SUMMARY'); console.log(JSON.stringify(summary, null, 1));
for (const r of report) console.log(`#${r.n} [pickup ${r.pickupSeconds}s] ${r.title}\n   -> ${r.line}\n   ${r.verb}: ${r.reason}`);
console.log(`\nreport: ${path.join(data, 'round-report.json')}\naction log: ${path.join(data, 'action.log')}\nwork copy: ${work}`);
tracker.close(); feed.close(); live.close();
process.exit(0);
