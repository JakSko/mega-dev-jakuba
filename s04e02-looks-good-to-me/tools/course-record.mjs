// course-record: a preload that sits outside the role. It records what a run sends to the course and what comes
// back, and limits what can leave. Load it with NODE_OPTIONS=--import=file:///.../tools/course-record.mjs.
// It limits globalThis.fetch only (the role's http tool and the model SDK use it); node:http and child processes
// that do not get NODE_OPTIONS are outside it.
//
// GUARD_MODE   first  reads to the course pass; exactly one POST to REVIEW_URL, held until a yes file exists
//              lab    nothing reaches the course: GETs come from LAB_FIXTURES, every write is held in a file
//              smoke  nothing reaches the course; this machine (loopback) is allowed
// REVIEW_URL   first, lab: the one review URL
// LAB_FIXTURES lab: JSON file { "<url path>": "<file with the saved reply body>" }
// RECORD_DIR   where records go (default journal/record, git-ignored)
// HOLD_MS      how long the held POST waits for approve-<hash> (default 30 min)
// COURSE_ORIGIN, MODEL_ORIGIN  defaults https://course.example and https://api.openai.com
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact } from '../lib/redact.mjs';

const DESK = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const MODE = env.GUARD_MODE;
if (!['first', 'lab', 'smoke'].includes(MODE)) {
  console.error('course-record: GUARD_MODE must be first, lab or smoke. Stopping, so that nothing runs unguarded.');
  process.exit(97);
}
const COURSE = new URL(env.COURSE_ORIGIN ?? 'https://course.example').origin;
const MODEL = new URL(env.MODEL_ORIGIN ?? 'https://api.openai.com').origin;
const DIR = resolve(env.RECORD_DIR ?? join(DESK, 'journal', 'record'));
const HOLD_MS = Number(env.HOLD_MS ?? 30 * 60_000);
const norm = (path) => decodeURIComponent(path).replace(/\/{2,}/g, '/').replace(/\/+$/, '').toLowerCase();
const REVIEW = env.REVIEW_URL ? new URL(env.REVIEW_URL) : null;
if (MODE !== 'smoke' && (!REVIEW || REVIEW.origin !== COURSE)) {
  console.error('course-record: REVIEW_URL (on the course origin) is needed in first and lab mode. Stopping.');
  process.exit(97);
}
mkdirSync(join(DIR, 'raw'), { recursive: true });

function secrets() {
  try {
    const raw = JSON.parse(readFileSync(env.RECORD_VARS ?? join(DESK, 'vars.json'), 'utf8'));
    return Object.entries(raw).filter(([, v]) => typeof v === 'string' && v.length >= 6 && !/^<.*>$/.test(v));
  } catch {
    return [];
  }
}
const mask = (t) => redact(t, secrets());
const record = (e) => appendFileSync(join(DIR, 'record.jsonl'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, mode: MODE, ...e }) + '\n');

record({ event: 'loaded', argv: process.argv.slice(1).map((a) => mask(a)) });

const reply = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
function blocked(method, url, why) {
  record({ event: 'blocked', method, url: mask(url), why });
  return reply(403, { blocked_by: 'course-record', why });
}

let seq = 0;
async function send(real, url, init, method, body) {
  const n = `${process.pid}-${++seq}`;
  record({ event: 'request', n, method, url: mask(url), headers: [...new Headers(init.headers).keys()], body: body === undefined ? undefined : mask(body) });
  let res;
  try {
    // redirect: manual on every hop, so that no hop leaves without passing here again.
    res = await real(url, { ...init, redirect: 'manual' });
  } catch (e) {
    record({ event: 'failed', n, error: mask(e?.cause?.message ?? e?.message ?? e) });
    throw e;
  }
  const text = await res.clone().text();
  writeFileSync(join(DIR, 'raw', `${n}.txt`), text);
  record({ event: 'reply', n, status: res.status, location: res.headers.get('location') ? mask(res.headers.get('location')) : undefined, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex'), body: mask(text) });
  return res;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The yes is bound to the hash of the exact body: approve-<hash12> sends it, deny-<hash12> stops it. */
async function approved(hash, signal) {
  const end = Date.now() + HOLD_MS;
  while (Date.now() < end && !signal?.aborted) {
    if (existsSync(join(DIR, `deny-${hash}`))) return 'denied';
    if (existsSync(join(DIR, `approve-${hash}`))) return 'yes';
    await sleep(Math.min(1000, HOLD_MS / 10));
  }
  return signal?.aborted ? 'aborted' : 'timed out';
}

let real = globalThis.fetch;
async function guarded(input, init = {}) {
  const isRequest = typeof Request !== 'undefined' && input instanceof Request;
  const url = new URL(isRequest ? input.url : String(input));
  if (url.origin === MODEL) return real(input, init); // model traffic and its key are never recorded
  const method = String(init.method ?? (isRequest ? input.method : 'GET')).toUpperCase();
  const headers = init.headers ?? (isRequest ? input.headers : undefined);
  let body = init.body ?? (isRequest && !['GET', 'HEAD'].includes(method) ? await input.clone().text() : undefined);
  if (body !== undefined && body !== null && typeof body !== 'string') return blocked(method, url.href, 'a body that is not text');
  body = body ?? undefined;
  const opts = { method, headers, body, signal: init.signal ?? (isRequest ? input.signal : undefined) };
  const reading = method === 'GET' || method === 'HEAD';

  if (url.origin !== COURSE) {
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (MODE === 'smoke' && loopback) return send(real, url.href, opts, method, body);
    return blocked(method, url.href, 'a host that is neither the course nor the model provider');
  }
  if (MODE === 'smoke') return blocked(method, url.href, 'smoke mode: nothing reaches the course');

  const isReview = method === 'POST' && norm(url.pathname) === norm(REVIEW.pathname);

  if (MODE === 'lab') {
    if (!reading) {
      const file = join(DIR, `held-${process.pid}-${++seq}.json`);
      writeFileSync(file, body ?? '');
      record({ event: 'held-lab', method, url: mask(url.href), file, review: isReview, body: mask(body ?? '') });
      return reply(200, { status: 'held', note: 'lab run: saved on this machine, not sent to the course' });
    }
    const fixtures = JSON.parse(readFileSync(env.LAB_FIXTURES, 'utf8'));
    const file = fixtures[url.pathname];
    if (!file) return blocked(method, url.href, 'lab mode: no saved reply for this path');
    record({ event: 'fixture', method, url: mask(url.href), file });
    return new Response(readFileSync(resolve(dirname(env.LAB_FIXTURES), file), 'utf8'), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  if (reading) return send(real, url.href, opts, method, body);
  if (!isReview) return blocked(method, url.href, 'the only write allowed is the POST to the review URL (a redirect of it counts as another write)');
  // Exclusive create before the send: parallel calls, a second process and a restart all find the file.
  try {
    writeFileSync(join(DIR, 'review-post.lock'), `${new Date().toISOString()} pid ${process.pid}\n`, { flag: 'wx' });
  } catch {
    return blocked(method, url.href, 'the one review POST of this run is already used');
  }
  const hash = createHash('sha256').update(body ?? '').digest('hex').slice(0, 12);
  writeFileSync(join(DIR, 'pending-review.json'), body ?? '');
  record({ event: 'held-for-yes', hash, url: mask(url.href), body: mask(body ?? '') });
  console.error(`course-record: review POST held, body hash ${hash}. It waits for approve-${hash} or deny-${hash} in ${DIR}`);
  const verdict = await approved(hash, opts.signal);
  record({ event: 'decision', hash, verdict });
  if (verdict !== 'yes') return blocked(method, url.href, `the review POST was not sent: ${verdict}. Do not send it again.`);
  return send(real, url.href, opts, method, body);
}

// Pi calls undici.install(), which assigns a new globalThis.fetch. A plain assignment of ours would be replaced
// without a word. So the guard stays what globalThis.fetch returns, and a newly assigned fetch only becomes the
// transport under it. The property cannot be redefined: such a try throws, which stops the run.
Object.defineProperty(globalThis, 'fetch', {
  configurable: false,
  enumerable: true,
  get: () => guarded,
  set(next) {
    if (next === guarded || typeof next !== 'function') return;
    real = next;
    record({ event: 'fetch-replaced', note: 'kept under the guard' });
  },
});
