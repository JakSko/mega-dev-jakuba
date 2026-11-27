// One run of one role: the guard on, the start message built here, a run record and event log lines in <base>/out.
//   MODEL=openai/<id> node /harness/team-run.mjs critic     <desk> --request r1
//   MODEL=openai/<id> node /harness/team-run.mjs planner    <desk> --models "worker=openai/<id>,integrator=openai/<id>"
//   MODEL=openai/<id> node /harness/team-run.mjs worker     <worktree> --job <id>
//   MODEL=openai/<id> node /harness/team-run.mjs integrator <desk> --job <id>
//   MODEL=openai/<id> node /harness/team-run.mjs reviewer   <desk>
// A role that already ran for the same job or request is not started again without --again.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { redact } from './redact.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const stop = (why) => {
  console.error(`not started: ${why}`);
  process.exit(1);
};
const sha = (data) => createHash('sha256').update(data).digest('hex');
const files = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? (n === 'out' || n === 'data' ? [] : files(join(dir, n))) : [join(dir, n)])).sort();
const folderHash = (dir) => sha(files(dir).map((f) => `${relative(dir, f).replace(/\\/g, '/')} ${sha(readFileSync(f))}`).join('\n'));

const [role, deskArg, ...rest] = process.argv.slice(2);
const again = rest.includes('--again');
const opt = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);
const MODEL = process.env.MODEL ?? '';
if (!deskArg) stop('usage: team-run.mjs <role> <desk> [--job <id> | --request r1|r2|r3 | --models <list>] [--again]');
if (!/^[\w./:@-]+$/.test(MODEL)) stop('set MODEL to the model chosen for this run');

let message = null;
let key = 'run';
if (role === 'critic') {
  key = opt('--request');
  if (!/^r[123]$/.test(key ?? '')) stop('critic needs --request r1, r2 or r3');
  message = `Request ${key}`;
} else if (role === 'worker' || role === 'integrator') {
  key = opt('--job');
  if (!ID.test(key ?? '')) stop(`${role} needs --job <id> (letters, digits, - and _)`);
  message = `Job ${key}`;
} else if (role === 'planner') {
  const models = opt('--models');
  if (!/^[\w./:@=, -]+$/.test(models ?? '')) stop('planner needs --models "role=model,..."');
  message = `Start. The model each job is started with, by role: ${models}`;
} else if (role !== 'reviewer') stop(`unknown role ${role}`);

// A short note from us after the start message, such as where a fact lives. It is kept in the run record.
const note = opt('--note');
if (note !== undefined) {
  if (message === null || !/^[A-Za-z0-9 .,:;'/()_-]{1,600}$/.test(note)) stop("a note may hold letters, digits, spaces and . , : ; ' / ( ) _ - only");
  message = `${message}. ${note}`;
}

const desk = resolve(deskArg);
const base = dirname(desk);
const out = join(base, 'out');
const roleDir = join(desk, 'roles', role);
if (!existsSync(join(roleDir, 'run.mjs'))) stop(`no ${role} role in ${desk}`);
const runs = join(out, 'runs');
mkdirSync(runs, { recursive: true });
const earlier = readdirSync(runs).some((n) => {
  try {
    const r = JSON.parse(readFileSync(join(runs, n, 'run.json'), 'utf8'));
    return r.role === role && r.key === key;
  } catch {
    return false;
  }
});
if (earlier && !again) stop(`${role} already ran for ${key}: read the board first; --again starts it once more (it may claim, ask, post or merge again)`);

const git = (...a) => execFileSync('git', ['-C', desk, ...a], { encoding: 'utf8' }).trim();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = join(runs, `${stamp}-${role}-${key}`);
mkdirSync(dir);
const run = {
  started: new Date().toISOString(), role, key, desk, message, model: MODEL,
  gitSha: git('rev-parse', 'HEAD'), roleDirty: git('status', '--porcelain', '--', `roles/${role}`) !== '',
  roleHash: folderHash(roleDir), harnessHash: folderHash(HERE),
};
const save = () => writeFileSync(join(dir, 'run.json'), JSON.stringify(run, null, 2));
const event = (e) => appendFileSync(join(out, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), role, job: key, run: basename(dir), ...e }) + '\n');
save();
event({ event: 'role-start', model: MODEL, gitSha: run.gitSha });

const secrets = () => {
  try {
    return Object.entries(JSON.parse(readFileSync(join(desk, 'vars.json'), 'utf8'))).filter(([, v]) => typeof v === 'string' && v.length >= 6);
  } catch {
    return [];
  }
};
const env = {
  ...process.env, MODEL,
  NODE_OPTIONS: `--import=${pathToFileURL(join(HERE, 'course-record.mjs')).href}`,
  GUARD_MODE: 'team', GUARD_ROLE: role, RECORD_DIR: dir, RECORD_VARS: join(desk, 'vars.json'),
  APPROVE_DIR: join(HERE, 'data', basename(base)),
  ...(role === 'reviewer' ? { REVIEW_OUT: dir } : {}),
};
let text = '';
const child = spawn(process.execPath, [join(roleDir, 'run.mjs'), ...(message ? [message] : [])], { cwd: desk, env, stdio: ['ignore', 'pipe', 'pipe'] });
const take = (to) => (d) => {
  const safe = redact(String(d), secrets());
  text += safe;
  to.write(safe);
};
child.stdout.on('data', take(process.stdout));
child.stderr.on('data', take(process.stderr));
child.on('close', (code) => {
  writeFileSync(join(dir, 'output.txt'), text);
  let records = [];
  try {
    records = readFileSync(join(dir, 'record.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {}
  const guardInPi = records.some((r) => r.event === 'loaded' && r.argv?.some((a) => /pi-coding-agent|[\\/]pi(\.m?js)?$/.test(a)));
  const writes = records.filter((r) => r.event === 'request' && !['GET', 'HEAD'].includes(r.method)).map((r) => `${r.method} ${new URL(r.url).pathname}`);
  Object.assign(run, {
    ended: new Date().toISOString(), exit: code, modelPrinted: [...text.matchAll(/^model: (.+)$/gm)].at(-1)?.[1] ?? null,
    guardInPi, writes, blocked: records.filter((r) => r.event === 'blocked').length,
  });
  // The last model call tells how the run ended; a run with no model call at all did no work.
  const calls = records.filter((r) => r.event === 'model');
  const answered = (c) => c.status >= 200 && c.status < 300;
  run.modelCalls = { total: calls.length, failed: calls.filter((c) => !answered(c)).length };
  const modelFailed = calls.length ? !answered(calls.at(-1)) : process.env.TEAM_RUN_TEST !== '1';
  run.modelFailed = modelFailed;
  save();
  // Each act gets its own line with the time it happened: board POSTs, refusals, the plan hold, merge commits.
  for (const r of records) {
    if (r.event === 'request' && !['GET', 'HEAD'].includes(r.method)) {
      const back = records.find((x) => x.n === r.n && x.pid === r.pid && (x.event === 'reply' || x.event === 'failed'));
      event({ at: r.at, event: 'board-post', method: r.method, path: new URL(r.url).pathname, status: back?.status ?? 'unknown' });
    } else if (r.event === 'blocked') event({ at: r.at, event: 'refusal', method: r.method, path: URL.canParse(r.url) ? new URL(r.url).pathname : r.url, why: r.why });
    else if (r.event === 'held-for-yes') event({ at: r.at, event: 'plan-hold', bodySha: r.hash });
    else if (r.event === 'decision') event({ at: r.at, event: 'plan-decision', bodySha: r.hash, verdict: r.verdict });
  }
  for (const line of git('log', '--reverse', '--format=%H%x09%cI%x09%s', `${run.gitSha}..HEAD`).split('\n')) {
    const [commit, at, subject] = line.split('\t');
    if (/^merge \S+$/.test(subject ?? '')) event({ at, event: 'merge', merged: subject.slice(6), commit });
  }
  event({ event: 'role-end', exit: code, modelPrinted: run.modelPrinted, guardInPi, writes, blocked: run.blocked, modelCalls: run.modelCalls, modelFailed });
  console.log(`run record: ${join(dir, 'run.json')}`);
  if (!guardInPi && process.env.TEAM_RUN_TEST !== '1') {
    console.error('team-run: the guard did not load in Pi. Treat this run as unguarded: stop and read it.');
    process.exit(2);
  }
  if (modelFailed) {
    console.error(`team-run: model call failed or none was made (${run.modelCalls.total} calls, ${run.modelCalls.failed} failed). Treat the run as failed, whatever the role's exit code and model line say.`);
    process.exit(3);
  }
  process.exit(code ?? 1);
});
