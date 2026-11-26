// The guard must stay in place after Pi's own start code. Pi calls undici.install(), which assigns a new
// globalThis.fetch. This test runs Pi's real dispatcher setup under the preload. No model call, local servers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PRELOAD = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'course-record.mjs')).href;
const PI = join(execSync('npm root -g').toString().trim(), '@earendil-works', 'pi-coding-agent', 'dist', 'core', 'http-dispatcher.js');

test('after Pi configures its HTTP stack, a blocked write is still blocked', async () => {
  let hits = 0;
  const server = createServer((_q, res) => { hits++; res.end('{}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), 'rec '));
  const code = `
    const pi = await import(${JSON.stringify(pathToFileURL(PI).href)});
    const before = globalThis.fetch;
    pi.configureHttpDispatcher();
    pi.configureHttpDispatcher(60000);
    const w = await fetch('${origin}/c/claim', { method: 'POST', body: '{}' });
    const r = await fetch('${origin}/c/patch');
    console.log('write', w.status, 'read', r.status, 'same-guard', before === globalThis.fetch);
    try { Object.defineProperty(globalThis, 'fetch', { value: () => 1 }); console.log('redefined'); } catch { console.log('redefine refused'); }`;
  const out = await new Promise((done) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, NODE_OPTIONS: `--import=${PRELOAD}`, GUARD_MODE: 'first', COURSE_ORIGIN: origin, REVIEW_URL: `${origin}/c/review`, RECORD_DIR: dir, RECORD_VARS: join(dir, 'none.json') },
    });
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.stderr.on('data', (d) => (text += d));
    child.on('close', () => done(text));
  });
  server.close();
  assert.match(out, /write 403 read 200 same-guard true/, out);
  assert.match(out, /redefine refused/, out);
  assert.equal(hits, 1, 'only the read reached the server');
});
