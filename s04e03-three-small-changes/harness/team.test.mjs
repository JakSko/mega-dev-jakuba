// Tests for the team tools: course-record (team rules), desk-vars, team-run, run-payout. Fake course and fake roles
// only. Run in course-box: node --test team.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PRELOAD = pathToFileURL(join(HERE, 'course-record.mjs')).href;
const ATTEMPT = 'attempt-value-1234567890';
const sha = (s) => createHash('sha256').update(s).digest('hex');

function put(root, rel, text) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}
function node(args, { env = {}, input, cwd } = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.stdin.end(input ?? '');
    child.on('close', (code) => done({ code, out }));
  });
}
function fakeCourse() {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      seen.push(`${req.method} ${req.url}`);
      res.end('{"ok":true}');
    });
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ server, seen, origin: `http://127.0.0.1:${server.address().port}` })));
}
const CALL = "const O=process.env.COURSE_ORIGIN+'/c'; const call=async(m,p,b)=>{const r=await fetch(O+p,{method:m,body:b,headers:{authorization:'Bearer " + ATTEMPT + "'}}); console.log(m,p,r.status)};";

function guardEnv(origin, role, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'g-'));
  const approve = join(dir, 'approve');
  mkdirSync(approve);
  writeFileSync(join(dir, 'vars.json'), JSON.stringify({ ATTEMPT }));
  return {
    dir, approve,
    env: { NODE_OPTIONS: `--import=${PRELOAD}`, GUARD_MODE: 'team', GUARD_ROLE: role, COURSE_ORIGIN: origin, CHALLENGE_PATH: '/c', MODEL_ORIGIN: 'http://127.0.0.1:9', RECORD_DIR: join(dir, 'rec'), RECORD_VARS: join(dir, 'vars.json'), APPROVE_DIR: approve, HOLD_MS: '1500', ...extra },
  };
}
const script = (code, env) => node(['--input-type=module', '-e', `${CALL}${code}`], { env });

test('guard: no role or an unknown role stops the process', async () => {
  for (const role of ['', 'owner']) {
    const g = guardEnv('http://127.0.0.1:1', role);
    const r = await script('console.log("ran")', g.env);
    assert.equal(r.code, 97, r.out);
  }
});

test('guard: each role may send only its own write, once; reads pass; the reviewer writes nothing', async () => {
  const f = await fakeCourse();
  const allowed = { critic: '/board/questions', worker: '/board/claims', integrator: '/board/claims' };
  for (const [role, path] of Object.entries(allowed)) {
    f.seen.length = 0;
    const other = path === '/board/claims' ? '/board/questions' : '/board/claims';
    const g = guardEnv(f.origin, role);
    const r = await script(`await call('GET','/board'); await call('POST','${other}','{}'); await call('POST','/board/results','{}'); await call('POST','${path}?x=1','{}'); await call('POST','${path}','{}'); await call('POST','${path}','{}');`, g.env);
    assert.deepEqual(f.seen, ['GET /c/board', `POST /c${path}`], `${role}: ${r.out}`);
  }
  f.seen.length = 0;
  const g = guardEnv(f.origin, 'reviewer');
  await script("await call('POST','/review','{}'); await call('POST','/board/claims','{}');", g.env);
  assert.deepEqual(f.seen, []);
  f.server.close();
});

test('guard: the plan POST is held until an approve file names its body hash; without it nothing is sent', async () => {
  const f = await fakeCourse();
  const body = '{"jobs":[]}';
  const no = guardEnv(f.origin, 'planner');
  const refused = await script(`await call('POST','/board/plan','${body}');`, no.env);
  assert.match(refused.out, /403/);
  assert.deepEqual(f.seen, []);
  const yes = guardEnv(f.origin, 'planner', { HOLD_MS: '5000' });
  writeFileSync(join(yes.approve, `approve-plan-${sha(body)}`), '');
  const sent = await script(`await call('POST','/board/plan','${body}');`, yes.env);
  assert.match(sent.out, /POST \/board\/plan 200/);
  assert.deepEqual(f.seen, ['POST /c/board/plan']);
  assert.equal(readFileSync(join(yes.dir, 'rec', 'pending-plan.json'), 'utf8'), body);
  f.server.close();
});

test('guard: another host is refused and the attempt is masked in the records', async () => {
  const f = await fakeCourse();
  const g = guardEnv(f.origin, 'worker');
  const r = await script("const x = await fetch('http://example.invalid/'); console.log('other', x.status); await call('GET','/board');", g.env);
  assert.match(r.out, /other 403/);
  assert.ok(!readFileSync(join(g.dir, 'rec', 'record.jsonl'), 'utf8').includes(ATTEMPT));
  f.server.close();
});

/** A desk like the real one: base/host-desk with a commit, base/out beside it. */
function desk() {
  const base = mkdtempSync(join(tmpdir(), 'd-'));
  const top = join(base, 'host-desk');
  mkdirSync(top);
  const git = (...a) => execFileSync('git', ['-C', top, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t.invalid');
  git('config', 'user.name', 't');
  put(top, '.gitignore', 'vars.json\njournal/\n');
  put(top, 'roles/worker/ROLE.md', '# worker\n');
  // A fake role: shows its message and whether it was started under the guard, then prints a model line.
  put(top, 'roles/worker/run.mjs', "console.log('msg:', process.argv.slice(2).join(' ')); console.log('guard:', process.env.GUARD_MODE, process.env.GUARD_ROLE); console.log('model: fake-model-1');\n");
  put(top, 'roles/payout-runner/scripts/solve.mjs', "console.log('args:', process.argv.slice(2).join(' ')); console.log('env:', Object.keys(process.env).filter((k) => /KEY|ATTEMPT|ACCOUNT|TICKET|NODE_OPTIONS/.test(k)).sort().join(',')); console.log('key-ok:', process.env.PAYOUT_KEY === 'practice-key-123456');\n");
  git('add', '-A');
  git('commit', '-qm', 'setup');
  writeFileSync(join(top, 'vars.json'), JSON.stringify({ TICKET: 'ticket-value-123456', ATTEMPT }));
  return { base, top, out: join(base, 'out'), git, vars: () => JSON.parse(readFileSync(join(top, 'vars.json'), 'utf8')) };
}
const tool = (name, args, opts) => node([join(HERE, name), ...args], opts);

test('desk-vars: put takes the value from stdin and never prints it; remove removes it', async () => {
  const d = desk();
  const r = await tool('desk-vars.mjs', ['put', d.top, 'TICKET'], { input: 'new-ticket-abcdef\n' });
  assert.equal(r.code, 0, r.out);
  assert.equal(d.vars().TICKET, 'new-ticket-abcdef');
  assert.ok(!r.out.includes('new-ticket-abcdef'));
  assert.notEqual((await tool('desk-vars.mjs', ['put', d.top, 'PAYOUT_KEY'], { input: 'x-123456789\n' })).code, 0);
  assert.equal((await tool('desk-vars.mjs', ['remove', d.top, 'TICKET'])).code, 0);
  assert.equal(d.vars().TICKET, undefined);
});

test('desk-vars: the account is taken only from the manual of this attempt, and only when there is exactly one', async () => {
  const d = desk();
  const manual = join(d.base, 'manual.raw');
  writeFileSync(manual, JSON.stringify({ attempt: 'another-attempt', manual: 'pay acct_aaaa1111' }));
  assert.match((await tool('desk-vars.mjs', ['account', d.top, manual])).out, /not the manual of this attempt/);
  writeFileSync(manual, JSON.stringify({ attempt: ATTEMPT, manual: 'acct_aaaa1111 or acct_bbbb2222' }));
  assert.match((await tool('desk-vars.mjs', ['account', d.top, manual])).out, /exactly one/);
  writeFileSync(manual, JSON.stringify({ attempt: ATTEMPT, manual: 'on file: acct_aaaa1111. Again acct_aaaa1111' }));
  const ok = await tool('desk-vars.mjs', ['account', d.top, manual]);
  assert.equal(ok.code, 0, ok.out);
  assert.ok(!ok.out.includes('acct_aaaa1111'));
  assert.equal(readFileSync(join(d.out, 'account-on-file'), 'utf8').trim(), 'acct_aaaa1111');
  assert.equal(d.vars().ACCOUNT_ON_FILE, undefined);
});

test('desk-vars: a worktree needs a committed desk and gets ATTEMPT only; copies are removed before the payout', async () => {
  const d = desk();
  put(d.top, 'loose.txt', 'x');
  assert.match((await tool('desk-vars.mjs', ['worktree', d.top, 'w-1'])).out, /not committed/);
  d.git('add', '-A');
  d.git('commit', '-qm', 'more');
  const r = await tool('desk-vars.mjs', ['worktree', d.top, 'w-1']);
  assert.equal(r.code, 0, r.out);
  const copy = join(d.base, 'host-desk-w-1', 'vars.json');
  assert.deepEqual(JSON.parse(readFileSync(copy, 'utf8')), { ATTEMPT });
  assert.notEqual((await tool('desk-vars.mjs', ['worktree', d.top, '../evil'])).code, 0);
  assert.equal((await tool('desk-vars.mjs', ['clean-copies', d.top])).code, 0);
  assert.ok(!existsSync(copy));
  assert.ok(existsSync(join(d.top, 'vars.json')));
});

test('team-run: builds the start message, turns the guard on, writes a run record and events, and refuses a repeat', async () => {
  const d = desk();
  // The fake role does not load Pi, so the test says so; a real run must show the guard loaded in Pi.
  const env = { MODEL: 'openai/some-model', TEAM_RUN_TEST: '1' };
  const r = await tool('team-run.mjs', ['worker', d.top, '--job', 'w-1'], { env });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /msg: Job w-1/);
  assert.match(r.out, /guard: team worker/);
  const runs = readdirSync(join(d.out, 'runs'));
  const rec = JSON.parse(readFileSync(join(d.out, 'runs', runs[0], 'run.json'), 'utf8'));
  assert.equal(rec.model, 'openai/some-model');
  assert.equal(rec.modelPrinted, 'fake-model-1');
  assert.equal(rec.exit, 0);
  assert.match(rec.gitSha, /^[0-9a-f]{40}$/);
  assert.match(rec.roleHash, /^[0-9a-f]{64}$/);
  const events = readFileSync(join(d.out, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => `${e.event} ${e.role} ${e.job}`), ['role-start worker w-1', 'role-end worker w-1']);
  assert.match((await tool('team-run.mjs', ['worker', d.top, '--job', 'w-1'], { env })).out, /already ran/);
  assert.equal((await tool('team-run.mjs', ['worker', d.top, '--job', 'w-1', '--again'], { env })).code, 0);
  assert.notEqual((await tool('team-run.mjs', ['worker', d.top], { env })).code, 0);
  assert.notEqual((await tool('team-run.mjs', ['worker', d.top, '--job', 'w 1; x'], { env })).code, 0);
  assert.notEqual((await tool('team-run.mjs', ['worker', d.top, '--job', 'w-2'], { env: { MODEL: '' } })).code, 0);
});

test('team-run: a run whose last model call failed is marked and fails, even when the role exits 0', async () => {
  const model = createServer((req, res) => {
    res.statusCode = req.url.includes('fail') ? 500 : 200;
    res.end('secret model reply');
  });
  await new Promise((r) => model.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${model.address().port}`;
  for (const [paths, ok] of [[['ok'], true], [['ok', 'fail'], false], [['fail', 'ok'], true], [['dead'], false]]) {
    const d = desk();
    const calls = paths.map((p) => (p === 'dead' ? "await fetch('http://127.0.0.1:9/x').catch(() => {});" : `await fetch('${origin}/${p}');`)).join(' ');
    put(d.top, 'roles/worker/run.mjs', `${calls} console.log('model: asked-for-model');\n`);
    const r = await tool('team-run.mjs', ['worker', d.top, '--job', 'w-1'], { env: { MODEL: 'openai/some-model', TEAM_RUN_TEST: '1', MODEL_ORIGIN: origin === '' ? '' : (paths[0] === 'dead' ? 'http://127.0.0.1:9' : origin) } });
    assert.equal(r.code === 0, ok, `${paths}: ${r.out}`);
    if (!ok) assert.match(r.out, /model call failed/);
    const runs = join(d.out, 'runs');
    assert.ok(!readFileSync(join(runs, readdirSync(runs)[0], 'record.jsonl'), 'utf8').includes('secret model reply'));
  }
  model.close();
});

test('team-run: a run that did not load the guard in Pi is marked and fails', async () => {
  const d = desk();
  const r = await tool('team-run.mjs', ['worker', d.top, '--job', 'w-1'], { env: { MODEL: 'openai/some-model' } });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /guard did not load in Pi/);
});

test('run-payout: the key reaches only the payout process and no file; it refuses worktree copies and a stale account', async () => {
  const d = desk();
  const env = { RUN_PAYOUT_TEST: '1' };
  const input = 'practice-key-123456\n';
  assert.match((await tool('run-payout.mjs', [d.top, 'practice'], { env, input })).out, /account on file/);
  mkdirSync(d.out, { recursive: true });
  writeFileSync(join(d.out, 'account-on-file'), 'acct_aaaa1111\n');
  writeFileSync(join(d.out, 'account-on-file.attempt'), sha('old-attempt') + '\n');
  assert.match((await tool('run-payout.mjs', [d.top, 'practice'], { env, input })).out, /another attempt/);
  writeFileSync(join(d.out, 'account-on-file.attempt'), sha(ATTEMPT) + '\n');
  await tool('desk-vars.mjs', ['worktree', d.top, 'w-1']);
  assert.match((await tool('run-payout.mjs', [d.top, 'practice'], { env, input })).out, /worktree/);
  await tool('desk-vars.mjs', ['clean-copies', d.top]);
  const r = await tool('run-payout.mjs', [d.top, 'practice'], { env: { ...env, NODE_OPTIONS: '', HOST_SECRET_KEY: 'zzz-should-not-pass' }, input });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /args: practice --live/);
  assert.match(r.out, /env: ACCOUNT_ON_FILE,ATTEMPT,PAYOUT_KEY\n/);
  assert.match(r.out, /key-ok: true/);
  assert.ok(!r.out.includes('practice-key-123456'));
  assert.ok(!readFileSync(join(d.top, 'vars.json'), 'utf8').includes('practice-key'));
  assert.ok(!readFileSync(join(d.out, 'events.jsonl'), 'utf8').includes('practice-key'));
  assert.notEqual((await tool('run-payout.mjs', [d.top, 'delete-all'], { env, input })).code, 0);
  const notTerminal = await tool('run-payout.mjs', [d.top, 'practice'], { input });
  assert.match(notTerminal.out, /own terminal/);
});

const eventsOf = (d) => readFileSync(join(d.out, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('team-run: the event log gets each board POST with its time and status, the plan hold and decision, and merge commits', async () => {
  const f = await fakeCourse();
  const d = desk();
  // The fake role claims (sent), asks a question (not its write: refused), and makes a merge commit.
  put(d.top, 'roles/worker/run.mjs', `import { execFileSync } from 'node:child_process';
const O = process.env.COURSE_ORIGIN + '/c';
await fetch(O + '/board', { method: 'GET' });
await fetch(O + '/board/claims', { method: 'POST', body: '{}', headers: { authorization: 'Bearer ${ATTEMPT}' } });
await fetch(O + '/board/questions', { method: 'POST', body: '{}' });
execFileSync('git', ['commit', '--allow-empty', '-qm', 'merge w-9']);
console.log('model: fake-model-1');
`);
  d.git('commit', '-qam', 'fake role');
  const r = await tool('team-run.mjs', ['worker', d.top, '--job', 'w-1'], { env: { MODEL: 'openai/some-model', TEAM_RUN_TEST: '1', COURSE_ORIGIN: f.origin, CHALLENGE_PATH: '/c', MODEL_ORIGIN: 'http://127.0.0.1:9' } });
  assert.equal(r.code, 0, r.out);
  const events = eventsOf(d);
  const post = events.filter((e) => e.event === 'board-post');
  assert.deepEqual(post.map((e) => `${e.method} ${e.path} ${e.status} ${e.role} ${e.job}`), ['POST /c/board/claims 200 worker w-1']);
  assert.ok(Date.parse(post[0].at) <= Date.parse(events.find((e) => e.event === 'role-end').at));
  assert.deepEqual(events.filter((e) => e.event === 'refusal').map((e) => `${e.method} ${e.path}`), ['POST /c/board/questions']);
  assert.deepEqual(events.filter((e) => e.event === 'merge').map((e) => e.merged), ['w-9']);
  assert.ok(!readFileSync(join(d.out, 'events.jsonl'), 'utf8').includes(ATTEMPT));

  const p = desk();
  const body = '{"jobs":[]}';
  put(p.top, 'roles/planner/run.mjs', `await fetch(process.env.COURSE_ORIGIN + '/c/board/plan', { method: 'POST', body: '${body}' }); console.log('model: fake-model-1');\n`);
  p.git('add', '-A');
  p.git('commit', '-qm', 'planner');
  const held = await tool('team-run.mjs', ['planner', p.top, '--models', 'worker=openai/x'], { env: { MODEL: 'openai/some-model', TEAM_RUN_TEST: '1', COURSE_ORIGIN: f.origin, CHALLENGE_PATH: '/c', MODEL_ORIGIN: 'http://127.0.0.1:9', HOLD_MS: '500' } });
  assert.equal(held.code, 0, held.out);
  assert.deepEqual(eventsOf(p).filter((e) => e.event.startsWith('plan-')).map((e) => `${e.event} ${e.bodySha} ${e.verdict ?? ''}`.trim()), [`plan-hold ${sha(body)}`, `plan-decision ${sha(body)} timed out`]);
  f.server.close();
});

test('note-yes: the owner yes goes into the event log with what it covers; secrets are masked', async () => {
  const d = desk();
  const r = await tool('note-yes.mjs', [d.top, '--covers', 'claim and result, job w-1', '--words', `Tak ${ATTEMPT}`]);
  assert.equal(r.code, 0, r.out);
  const [e] = eventsOf(d);
  assert.equal(`${e.event} ${e.role} ${e.covers}`, 'yes owner claim and result, job w-1');
  assert.ok(!JSON.stringify(e).includes(ATTEMPT));
  assert.notEqual((await tool('note-yes.mjs', [d.top, '--covers', 'x'])).code, 0);
});

test('team-run: --note adds a plain note to the start message and refuses odd characters', async () => {
  const d = desk();
  const env = { MODEL: 'openai/some-model', TEAM_RUN_TEST: '1' };
  const r = await tool('team-run.mjs', ['worker', d.top, '--job', 'w-1', '--note', 'You already claimed it: see roles/planner/answers.md.'], { env });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /msg: Job w-1\. You already claimed it: see roles\/planner\/answers\.md\./);
  const bad = await tool('team-run.mjs', ['worker', d.top, '--job', 'w-2', '--note', 'a "quoted" $thing'], { env });
  assert.notEqual(bad.code, 0);
  assert.match(bad.out, /note may hold/);
});
