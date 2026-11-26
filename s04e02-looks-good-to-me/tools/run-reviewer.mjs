// Starts the reviewer through its own run.mjs, under the guard, and writes a run record . It changes
// nothing in roles/reviewer/.
//
// Usage: node tools/run-reviewer.mjs first|lab [--rehearse] [--patch <saved>] [--settings <saved>]
//   first     reads pass; the one review POST is held until approve-<hash> exists in the run folder
//   lab       the saved patch and settings are served; nothing reaches the course (needs --patch, --settings)
//   --rehearse  the same start line with every model key removed: no model call. Checks that the guard loads in Pi.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { userInfo } from 'node:os';

const DESK = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROLE = join(DESK, 'roles', 'reviewer');
const CHALLENGE = process.env.CHALLENGE_URL ?? 'https://course.example/challenge';
const MODEL = 'openai/gpt-6.2-sol';
const [mode, ...rest] = process.argv.slice(2);
const opt = (name) => (rest.includes(name) ? resolve(rest[rest.indexOf(name) + 1]) : null);
const rehearse = rest.includes('--rehearse');
const stop = (why) => { console.error(`not started: ${why}`); process.exit(1); };
if (!['first', 'lab'].includes(mode)) stop('mode must be first or lab');
if (!rehearse && !process.env.OPENAI_API_KEY) stop('OPENAI_API_KEY is not set in this terminal');

const sha = (data) => createHash('sha256').update(data).digest('hex');
const files = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)])).sort();
const roleHash = sha(files(ROLE).map((f) => `${relative(ROLE, f).replace(/\\/g, '/')} ${sha(readFileSync(f, 'utf8').replace(/\r\n/g, '\n'))}`).join('\n'));
// The role as given: scripts got every var and run outside the guard, so the given role runs with no script at all.
const scripts = existsSync(join(ROLE, 'scripts')) ? files(join(ROLE, 'scripts')).map((f) => relative(join(ROLE, 'scripts'), f)) : [];
if (mode === 'first' && scripts.some((f) => f !== 'README.md')) stop(`scripts/ holds more than README.md: ${scripts.join(', ')}`);
const vars = JSON.parse(readFileSync(join(DESK, 'vars.json'), 'utf8'));
if (!vars.ATTEMPT) stop('no ATTEMPT in vars.json');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = join(DESK, 'journal', `run-${stamp}-${mode}${rehearse ? '-rehearsal' : ''}`);
mkdirSync(dir, { recursive: true });
const git = (...a) => execFileSync('git', a, { cwd: DESK }).toString().trim();
const saved = {};
for (const name of ['patch', 'settings']) {
  const file = opt(`--${name}`);
  if (file) saved[name] = { file, sha256: sha(readFileSync(file)) };
}
if (mode === 'lab') {
  if (!saved.patch || !saved.settings) stop('lab needs --patch and --settings');
  writeFileSync(join(dir, 'fixtures.json'), JSON.stringify({ [`${new URL(CHALLENGE).pathname}/patch`]: saved.patch.file, [`${new URL(CHALLENGE).pathname}/settings`]: saved.settings.file }));
}
const run = {
  started: new Date().toISOString(), mode, rehearse, initiator: `${userInfo().username} (terminal)`,
  gitSha: git('rev-parse', 'HEAD'), roleDirty: git('status', '--porcelain', 'roles/reviewer') !== '', roleHash,
  model: MODEL, thinking: process.env.THINKING ?? 'Pi default (run.mjs of the role as given has no thinking option)',
  tools: [...readFileSync(join(ROLE, 'run.mjs'), 'utf8').matchAll(/'-e',\s*'([^']+)'/g)].map((m) => m[1]), attemptHash: sha(vars.ATTEMPT).slice(0, 16), saved,
};
writeFileSync(join(dir, 'run.json'), JSON.stringify(run, null, 2));

const env = {
  ...process.env, MODEL, GUARD_MODE: mode, REVIEW_URL: `${CHALLENGE}/review`, RECORD_DIR: dir,
  LAB_FIXTURES: join(dir, 'fixtures.json'),
  REVIEW_OUT: dir,
  NODE_OPTIONS: `--import=${pathToFileURL(join(DESK, 'tools', 'course-record.mjs')).href}`,
};
if (rehearse) {
  for (const k of Object.keys(env)) if (/API_KEY$/i.test(k)) delete env[k];
}
console.log(`run folder: ${relative(DESK, dir)}`);
const out = createWriteStream(join(dir, 'pi-output.txt'));
const child = spawn(process.execPath, [join(ROLE, 'run.mjs')], { cwd: DESK, env, stdio: ['ignore', 'pipe', 'pipe'] });
for (const [from, to] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
  from.on('data', (d) => { to.write(d); out.write(d); });
}
child.on('close', (code) => {
  let events = [];
  try { events = readFileSync(join(dir, 'record.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch {}
  const inPi = events.some((e) => e.event === 'loaded' && e.argv?.some((a) => /pi-coding-agent/.test(a)));
  const count = (ev) => events.filter((e) => e.event === ev).length;
  const reviewSent = events.some((e) => e.event === 'request' && e.method === 'POST' && /\/review$/.test(e.url));
  const result = { ended: new Date().toISOString(), exit: code, guardInPi: inPi, requests: count('request'), blocked: count('blocked'), heldForYes: count('held-for-yes'), heldInLab: count('held-lab'), reviewSent };
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ ...run, result }, null, 2));
  out.end();
  console.log(`\nrun ended: exit ${code}; guard in Pi: ${inPi ? 'yes' : 'NO'}; course requests ${result.requests}, blocked ${result.blocked}, review sent: ${reviewSent ? 'yes' : 'no'}`);
  process.exit(code ?? 1);
});
