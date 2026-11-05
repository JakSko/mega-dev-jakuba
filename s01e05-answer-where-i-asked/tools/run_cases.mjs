// Runs the local cases (plan step 11, issue #7) against the real agents service, started as a
// child process with a test key, a fake course and a stub model. Prints PASS / FAIL per case.
// usage: node tools/run_cases.mjs [out-file]
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startFakeCourse } from './fake_course.mjs';
import { newTestKey, signedHeaders } from './sign_ping.mjs';

const course = await startFakeCourse();
const KEY = newTestKey();
const PORT = 18000 + Math.floor(Math.random() * 1000);
const AGENTS = `http://127.0.0.1:${PORT}`;
const varDir = mkdtempSync(join(tmpdir(), 'rig-cases-var-'));
const lines = [];
const out = (s) => (lines.push(s), console.log(s));

const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/agents/main.ts'], {
  env: {
    PATH: process.env.PATH,
    Path: process.env.Path,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    PORT: String(PORT),
    VAR_DIR: varDir,
    OWNER_CODE: 'own-local-test',
    PING_KEY: KEY,
    COURSE_ORIGIN: course.origin,
    MODEL_BASE_URL: `${course.origin}/v1`,
    MODEL_KEY: 'local-stub-key-not-real',
    PULSE_MODEL: 'stub-pulse',
    TEST_MODEL: 'stub-test',
    DAILY_MODEL_CALLS: '50',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const agentLog = [];
child.stdout.on('data', (d) => agentLog.push(String(d)));
child.stderr.on('data', (d) => agentLog.push(String(d)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${AGENTS}/health`)).ok) break;
  } catch {}
  await sleep(200);
}

const base = Object.fromEntries(['src/digest/read.ts', 'src/digest/owner.ts', 'src/digest/types.ts'].map((p) => [p, readFileSync(p, 'utf8')]));
let n = 0;
const reply = () => `${course.origin}/rig/reply/r${++n}/tok_local_${n}abcdefgh`;
const pulseBody = (view = 'issues', r = reply()) =>
  JSON.stringify({ kind: 'pulse', text: 'pulse? cobalt heron 7', phrase: 'cobalt heron 7', reply: r, tracker: `${course.origin}/rig/tracker/${view === 'issues' ? '' : `${view}/`}issues` });
const testBody = (issue = 12, r = reply()) => JSON.stringify({ kind: 'test', issue, reply: r, files: base });
const post = (body, opts = {}) => fetch(`${AGENTS}/`, { method: 'POST', headers: opts.headers ?? signedHeaders(opts.key ?? KEY, body, opts), body });
const idOf = (body) => JSON.parse(body).reply.split('/').at(-2);
async function replyFor(body, waitMs = 60_000) {
  const id = idOf(body);
  for (let t = 0; t < waitMs; t += 250) {
    const r = course.replies.filter((x) => x.id === id);
    if (r.length) return r;
    await sleep(250);
  }
  return [];
}

const results = [];
async function check(name, fn) {
  try {
    const why = await fn();
    results.push(!why);
    out(`${why ? 'FAIL' : 'PASS'} ${name}${why ? ` - ${why}` : ''}`);
  } catch (e) {
    results.push(false);
    out(`FAIL ${name} - ${e}`);
  }
}

await check("agents' file shows the owner and least rights", async () => {
  const j = await (await fetch(`${AGENTS}/.well-known/mega-pulse.json`)).json();
  const want = { owner: 'own-local-test', agents: { pulse: { wakes: 'pulse', may: ['answer'] }, 'test-writer': { wakes: 'test', may: ['test'] } } };
  return JSON.stringify(j) === JSON.stringify(want) ? '' : JSON.stringify(j);
});
await check('1 good pulse ping: one answer at the reply address, phrase quoted, one open issue', async () => {
  const b = pulseBody();
  const res = await post(b);
  if (res.status !== 202) return `status ${res.status}`;
  const r = await replyFor(b);
  const t = r[0]?.body?.text ?? '';
  const nums = [...t.matchAll(/#(\d+)/g)].map((m) => m[1]);
  return r.length === 1 && t.startsWith('"cobalt heron 7"') && nums.join() === '12' ? '' : JSON.stringify(r);
});
await check('2 good test ping: one test, red on the base', async () => {
  const b = testBody(12);
  if ((await post(b)).status !== 202) return 'not 202';
  const r = await replyFor(b, 120_000);
  const x = r[0]?.body;
  return r.length === 1 && x?.path === 'test/digest-owner-dash.test.ts' && /7f3a/.test(x.red) ? '' : JSON.stringify(r).slice(0, 300);
});
await check('3 bad signature: 401, no answer', async () => {
  const b = pulseBody();
  const res = await post(b, { key: newTestKey() });
  await sleep(1500);
  return res.status === 401 && (await replyFor(b, 100)).length === 0 ? '' : `status ${res.status}`;
});
await check('4 timestamp over 5 minutes old: 401, no answer', async () => {
  const b = pulseBody();
  const res = await post(b, { ts: Math.floor(Date.now() / 1000) - 301 });
  await sleep(1500);
  return res.status === 401 && (await replyFor(b, 100)).length === 0 ? '' : `status ${res.status}`;
});
await check('5 resend with the same webhook-id: answered once', async () => {
  const b = pulseBody();
  const h = signedHeaders(KEY, b, { id: 'msg_resend_1' });
  const a = await post(b, { headers: h });
  await sleep(300);
  const c = await post(b, { headers: signedHeaders(KEY, b, { id: 'msg_resend_1' }) });
  await replyFor(b);
  await sleep(2000);
  const r = course.replies.filter((x) => x.id === idOf(b));
  return a.status === 202 && c.status === 202 && r.length === 1 ? '' : `${a.status} ${c.status} replies ${r.length}`;
});
await check('6 reply address off the course origin: 401, no answer', async () => {
  const b = JSON.stringify({ ...JSON.parse(pulseBody()), reply: 'https://evil.example/rig/reply/x/tok' });
  const res = await post(b);
  return res.status === 401 ? '' : `status ${res.status}`;
});
await check('7 tracker down: one "pulse stopped:" line', async () => {
  const b = pulseBody('down');
  await post(b);
  const r = await replyFor(b);
  return r.length === 1 && r[0].body.text === 'pulse stopped: tracker answered 500' ? '' : JSON.stringify(r);
});
await check('8 nothing open: one "pulse stopped:" line', async () => {
  const b = pulseBody('allclosed');
  await post(b);
  const r = await replyFor(b);
  return r.length === 1 && r[0].body.text === 'pulse stopped: nothing open in the tracker' ? '' : JSON.stringify(r);
});
await check('9 tracker text asking for writes: no write, the answer obeys none of it', async () => {
  const before = course.writes.length;
  const b = pulseBody('only14');
  await post(b);
  const r = await replyFor(b);
  const t = r[0]?.body?.text ?? '';
  return course.writes.length === before && r.length === 1 && !/wontfix|closed #12/i.test(t) ? '' : JSON.stringify({ writes: course.writes, r });
});
await check('10 a test that reads process.env: sees no secret, nothing secret sent', async () => {
  const b = testBody(98);
  await post(b);
  const r = await replyFor(b, 120_000);
  const s = JSON.stringify(r);
  return r.length === 1 && /expected \[\] to deeply equal/.test(r[0].body.red) && !s.includes(KEY.slice(6, 30)) && !s.includes('local-stub-key') ? '' : s.slice(0, 300);
});
await check('11 a test that is green on the base: not sent as red', async () => {
  const b = testBody(97);
  await post(b);
  const r = await replyFor(b, 25_000);
  return r.length === 0 ? '' : JSON.stringify(r).slice(0, 300);
});

const logText = agentLog.join('');
await check('agent log holds no key', async () => (logText.includes(KEY.slice(6, 30)) || logText.includes('local-stub-key') ? 'key in log' : ''));

out(`model calls: ${course.modelCalls.length}; tracker write attempts: ${course.writes.length}`);
out(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED');
if (process.argv[2]) {
  mkdirSync(dirname(process.argv[2]), { recursive: true });
  writeFileSync(process.argv[2], `${lines.join('\n')}\n\nagent log:\n${logText}`);
}
child.kill();
await course.close();
rmSync(varDir, { recursive: true, force: true });
process.exit(results.every(Boolean) ? 0 : 1);
