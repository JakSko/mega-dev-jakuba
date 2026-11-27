// The guard must stay in place after Pi's own start code, which assigns a new globalThis.fetch (undici.install).
// Uses Pi's real dispatcher setup and the real `pi` command. No model call, local servers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PRELOAD = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'course-record.mjs')).href;
const PI = join(execSync('npm root -g').toString().trim(), '@earendil-works', 'pi-coding-agent', 'dist', 'core', 'http-dispatcher.js');

function env(origin) {
  const dir = mkdtempSync(join(tmpdir(), 'rec '));
  writeFileSync(join(dir, 'vars.json'), '{}');
  return { dir, env: { ...process.env, NODE_OPTIONS: `--import=${PRELOAD}`, GUARD_MODE: 'team', GUARD_ROLE: 'worker', COURSE_ORIGIN: origin, CHALLENGE_PATH: '/c', RECORD_DIR: dir, RECORD_VARS: join(dir, 'vars.json') } };
}
function run(cmd, args, options) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.stderr.on('data', (d) => (text += d));
    child.on('close', (code) => done({ code, text }));
  });
}

test('after Pi configures its HTTP stack, a refused write is still refused and the allowed one goes once', async () => {
  const seen = [];
  const server = createServer((q, res) => { seen.push(`${q.method} ${q.url}`); res.end('{}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const code = `
    const pi = await import(${JSON.stringify(pathToFileURL(PI).href)});
    const before = globalThis.fetch;
    pi.configureHttpDispatcher();
    pi.configureHttpDispatcher(60000);
    const s = async (m, p) => (await fetch('${origin}' + p, { method: m, ...(m === 'GET' ? {} : { body: '{}' }) })).status;
    console.log('refused', await s('POST', '/c/board/results'), 'allowed', await s('POST', '/c/board/claims'), 'twice', await s('POST', '/c/board/claims'), 'read', await s('GET', '/c/board'), 'same-guard', before === globalThis.fetch);
    try { Object.defineProperty(globalThis, 'fetch', { value: () => 1 }); console.log('redefined'); } catch { console.log('redefine refused'); }`;
  const r = await run(process.execPath, ['--input-type=module', '-e', code], { env: env(origin).env });
  server.close();
  assert.match(r.text, /refused 403 allowed 200 twice 403 read 200 same-guard true/, r.text);
  assert.match(r.text, /redefine refused/, r.text);
  assert.deepEqual(seen, ['POST /c/board/claims', 'GET /c/board']);
});

test('the real pi command loads the guard, and its argv is what team-run looks for', async () => {
  const e = env('http://127.0.0.1:1');
  const r = await run('pi', ['--version'], { env: e.env });
  assert.equal(r.code, 0, r.text);
  const loaded = readFileSync(join(e.dir, 'record.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.event === 'loaded');
  assert.ok(loaded.some((x) => x.argv.some((a) => /pi-coding-agent|[\\/]pi(\.m?js)?$/.test(a))), JSON.stringify(loaded.map((x) => x.argv)));
});
