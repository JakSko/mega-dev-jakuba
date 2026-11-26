// Tests against a fake course on this machine. Each case runs a child node with the preload, as a run does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PRELOAD = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'course-record.mjs')).href;

function fake(handler) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body });
      (handler ?? ((_q, r) => r.end('{"ok":true,"attempt":"newattemptvalue123456"}')))(req, res);
    });
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ server, seen, origin: `http://127.0.0.1:${server.address().port}` })));
}

function run(code, env) {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, NODE_OPTIONS: `--import=${PRELOAD}`, ...env },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => done({ code, out, err }));
  });
}

function setup(origin, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rec '));
  const vars = join(dir, 'vars.json');
  writeFileSync(vars, JSON.stringify({ ATTEMPT: 'secret-attempt-111', PAYOUT_KEY: 'secret-payout-222' }));
  return { dir, env: { GUARD_MODE: 'first', COURSE_ORIGIN: origin, MODEL_ORIGIN: 'http://127.0.0.1:9', REVIEW_URL: `${origin}/c/review`, RECORD_DIR: dir, RECORD_VARS: vars, HOLD_MS: '1500', ...extra } };
}
const records = (dir) => readFileSync(join(dir, 'record.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

const CALL = `
const call = async (method, url, body) => { const r = await fetch(url, { method, body, headers: { authorization: 'Bearer secret-attempt-111' } }); console.log(method, new URL(url).pathname, r.status); };
const O = process.env.COURSE_ORIGIN;
`;
const approveSoon = `
import { readFileSync, writeFileSync } from 'node:fs';
const yes = setInterval(() => { try { const h = readFileSync(process.env.RECORD_DIR + '/record.jsonl','utf8').match(/"event":"held-for-yes","hash":"(\\w+)"/)?.[1]; if (h) { writeFileSync(process.env.RECORD_DIR + '/approve-' + h, ''); clearInterval(yes); } } catch {} }, 50);
yes.unref();
`;

test('no GUARD_MODE: the process stops', async () => {
  const r = await run('console.log("ran")', { GUARD_MODE: '' });
  assert.equal(r.code, 97);
  assert.ok(!r.out.includes('ran'));
});

test('first: reads pass; the review POST goes only after the yes, and only once, also in parallel and after a restart', async () => {
  const f = await fake();
  const { dir, env } = setup(f.origin);
  const r = await run(`${approveSoon}${CALL}
    await call('GET', O + '/c/patch');
    await Promise.all([call('POST', O + '/c/review', '{"findings":[1]}'), call('POST', O + '/c/review', '{"findings":[2]}'), call('POST', O + '//C/Review/?x=1', '{}')]);`, env);
  assert.equal(r.code, 0, r.err);
  const again = await run(`${CALL} await call('POST', O + '/c/review', '{"findings":[3]}');`, env);
  assert.match(again.out, /POST \/c\/review 403/);
  assert.equal(f.seen.filter((s) => s.method === 'POST').length, 1);
  assert.equal(f.seen.filter((s) => s.method === 'GET').length, 1);
  assert.ok(records(dir).some((e) => e.event === 'loaded'));
  f.server.close();
});

test('first: without a yes nothing is sent; a deny stops it too', async () => {
  const f = await fake();
  const a = setup(f.origin);
  const r = await run(`${CALL} await call('POST', O + '/c/review', '{"findings":[]}');`, a.env);
  assert.match(r.out, /POST \/c\/review 403/);
  assert.equal(f.seen.length, 0);
  assert.ok(records(a.dir).some((e) => e.event === 'decision' && e.verdict === 'timed out'));
  f.server.close();
});

test('first: PUT, PATCH, DELETE, other paths and other hosts are blocked, reads of other hosts too', async () => {
  const f = await fake();
  const other = await fake();
  const { env } = setup(f.origin);
  const r = await run(`${CALL}
    for (const m of ['PUT','PATCH','DELETE']) await call(m, O + '/c/review', '{}');
    await call('POST', O + '/c/claim', '{}');
    await call('GET', '${other.origin}/leak?x=1');
    await call('POST', '${other.origin}/leak', '{}');`, env);
  assert.equal(r.code, 0, r.err);
  assert.equal((r.out.match(/ 403/g) ?? []).length, 6, r.out);
  assert.equal(f.seen.length + other.seen.length, 0);
  f.server.close();
  other.server.close();
});

test('first: a redirected review POST is not sent on', async () => {
  const f = await fake((req, res) => {
    res.writeHead(307, { location: '/c/elsewhere' });
    res.end();
  });
  const { env } = setup(f.origin);
  const r = await run(`${approveSoon}${CALL}
    const res = await fetch(O + '/c/review', { method: 'POST', body: '{}' }); console.log('status', res.status);`, env);
  assert.match(r.out, /status 307/);
  assert.deepEqual(f.seen.map((s) => s.url), ['/c/review']);
  f.server.close();
});

test('records are masked: vars values, a new attempt by field name, token shapes, the auth header', async () => {
  const f = await fake((_q, res) => res.end(JSON.stringify({ attempt: 'newattemptvalue123456', note: 'v1.eyJzdWIiOiIxNTIz.BXLRJVZzyIuguSZB', echo: 'secret-payout-222' })));
  const { dir, env } = setup(f.origin);
  await run(`${CALL} await call('GET', O + '/c/manual?a=secret-attempt-111');`, env);
  const text = readFileSync(join(dir, 'record.jsonl'), 'utf8');
  for (const secret of ['secret-attempt-111', 'secret-payout-222', 'newattemptvalue123456', 'eyJzdWIiOiIxNTIz']) assert.ok(!text.includes(secret), secret);
  assert.ok(readdirSync(join(dir, 'raw')).length === 1);
  f.server.close();
});

test('lab: saved replies are served, writes are held, nothing reaches the course', async () => {
  const f = await fake();
  const { dir, env } = setup(f.origin, { GUARD_MODE: 'lab' });
  writeFileSync(join(dir, 'patch.json'), '{"hunks":[]}');
  writeFileSync(join(dir, 'fixtures.json'), JSON.stringify({ '/c/patch': 'patch.json' }));
  const r = await run(`${CALL}
    console.log(await (await fetch(O + '/c/patch')).text());
    await call('GET', O + '/c/unknown');
    await call('POST', O + '/c/review', '{"findings":[]}');`, { ...env, LAB_FIXTURES: join(dir, 'fixtures.json') });
  assert.match(r.out, /\{"hunks":\[\]\}/);
  assert.match(r.out, /unknown 403/);
  assert.match(r.out, /review 200/);
  assert.equal(f.seen.length, 0);
  assert.equal(readdirSync(dir).filter((n) => n.startsWith('held-')).length, 1);
  f.server.close();
});

test('smoke: loopback passes, the course does not; model traffic is not recorded', async () => {
  const f = await fake();
  const local = await fake();
  const model = await fake();
  const { dir, env } = setup(f.origin, { GUARD_MODE: 'smoke', COURSE_ORIGIN: 'https://course.example', REVIEW_URL: '', MODEL_ORIGIN: model.origin });
  const r = await run(`${CALL}
    await call('GET', '${local.origin}/ping');
    await call('GET', 'https://course.example/challenges/x');
    await call('POST', '${model.origin}/v1/responses', '{"input":"model-only-text"}');`, env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /ping 200/);
  assert.match(r.out, /challenges\/x 403/);
  assert.match(r.out, /responses 200/);
  assert.ok(!readFileSync(join(dir, 'record.jsonl'), 'utf8').includes('model-only-text'));
  for (const s of [f, local, model]) s.server.close();
});
