// course-record (team rules, S04E03; adapted from our S04E02 guard): a preload that sits outside the roles, in the
// read-only /harness. It records what a role's Pi process sends to the course and what comes back, and limits what
// can leave. Load it with NODE_OPTIONS=--import=file:///harness/course-record.mjs (team-run.mjs does).
// It limits globalThis.fetch only (the role's http tool and the model SDK use it). Scripts that the role's code tool
// starts do not get NODE_OPTIONS: a job's result goes through post-check.mjs instead.
//
// GUARD_MODE=team  GUARD_ROLE=critic|planner|worker|integrator|reviewer
//   reads of the course pass; each role may send only its own write, once per run:
//     critic      POST /board/questions
//     planner     POST /board/plan, held until APPROVE_DIR/approve-plan-<sha256 of the body> exists
//     worker      POST /board/claims
//     integrator  POST /board/claims
//     reviewer    none
// COURSE_ORIGIN (the course origin), CHALLENGE_PATH, MODEL_ORIGIN (the gate), RECORD_DIR (outside the desk),
// RECORD_VARS (the desk's vars.json, for masking), APPROVE_DIR, HOLD_MS (30 min).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { redact } from './redact.mjs';

const WRITES = { critic: '/board/questions', planner: '/board/plan', worker: '/board/claims', integrator: '/board/claims', reviewer: null };
const env = process.env;
const ROLE = env.GUARD_ROLE ?? '';
if (env.GUARD_MODE !== 'team' || !Object.hasOwn(WRITES, ROLE) || !env.RECORD_DIR || !env.RECORD_VARS || (ROLE === 'planner' && !env.APPROVE_DIR)) {
  console.error('course-record: GUARD_MODE=team, a known GUARD_ROLE, RECORD_DIR, RECORD_VARS (and APPROVE_DIR for the planner) are needed. Stopping, so that nothing runs unguarded.');
  process.exit(97);
}
const COURSE = new URL(env.COURSE_ORIGIN ?? 'https://course.example').origin;
const MODEL = new URL(env.MODEL_ORIGIN ?? 'http://course-gate:8081').origin;
const BASE = env.CHALLENGE_PATH ?? '/challenge';
const DIR = resolve(env.RECORD_DIR);
const HOLD_MS = Number(env.HOLD_MS ?? 30 * 60_000);
const norm = (path) => decodeURIComponent(path).replace(/\/{2,}/g, '/').replace(/\/+$/, '').toLowerCase();
mkdirSync(join(DIR, 'raw'), { recursive: true });

function secrets() {
  try {
    const raw = JSON.parse(readFileSync(env.RECORD_VARS, 'utf8'));
    return Object.entries(raw).filter(([, v]) => typeof v === 'string' && v.length >= 6 && !/^<.*>$/.test(v));
  } catch {
    return [];
  }
}
const mask = (t) => redact(t, secrets());
const record = (e) => appendFileSync(join(DIR, 'record.jsonl'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, role: ROLE, ...e }) + '\n');

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
/** The yes is bound to the hash of the exact body, and lives where the role cannot write. */
async function approved(hash, signal) {
  const end = Date.now() + HOLD_MS;
  while (Date.now() < end && !signal?.aborted) {
    if (existsSync(join(env.APPROVE_DIR, `deny-plan-${hash}`))) return 'denied';
    if (existsSync(join(env.APPROVE_DIR, `approve-plan-${hash}`))) return 'yes';
    await sleep(Math.min(1000, HOLD_MS / 10));
  }
  return signal?.aborted ? 'aborted' : 'timed out';
}

let real = globalThis.fetch;
async function guarded(input, init = {}) {
  const isRequest = typeof Request !== 'undefined' && input instanceof Request;
  const url = new URL(isRequest ? input.url : String(input));
  if (url.origin === MODEL) {
    // Model traffic is never recorded, only whether each call got an answer: the roles' run.mjs exits 0 when it did not.
    try {
      const res = await real(input, init);
      record({ event: 'model', status: res.status });
      return res;
    } catch (e) {
      record({ event: 'model', status: 0 });
      throw e;
    }
  }
  const method = String(init.method ?? (isRequest ? input.method : 'GET')).toUpperCase();
  const headers = init.headers ?? (isRequest ? input.headers : undefined);
  let body = init.body ?? (isRequest && !['GET', 'HEAD'].includes(method) ? await input.clone().text() : undefined);
  if (body !== undefined && body !== null && typeof body !== 'string') return blocked(method, url.href, 'a body that is not text');
  body = body ?? undefined;
  const opts = { method, headers, body, signal: init.signal ?? (isRequest ? input.signal : undefined) };

  if (url.origin !== COURSE) return blocked(method, url.href, 'a host that is neither the course nor the model gate');
  if (method === 'GET' || method === 'HEAD') return send(real, url.href, opts, method, body);

  const own = WRITES[ROLE];
  if (!own || method !== 'POST' || url.search || norm(url.pathname) !== norm(BASE + own)) {
    return blocked(method, url.href, own ? `this role may only send POST ${own}` : 'this role sends nothing');
  }
  // Exclusive create before the send: parallel calls, a second process and a restart all find the file.
  try {
    writeFileSync(join(DIR, 'role-post.lock'), `${new Date().toISOString()} pid ${process.pid}\n`, { flag: 'wx' });
  } catch {
    return blocked(method, url.href, 'the one write of this run is already used');
  }
  if (ROLE === 'planner') {
    const hash = createHash('sha256').update(body ?? '').digest('hex');
    writeFileSync(join(DIR, 'pending-plan.json'), body ?? '');
    record({ event: 'held-for-yes', hash, url: mask(url.href), body: mask(body ?? '') });
    console.error(`course-record: the plan POST is held. Body hash ${hash}. It waits for approve-plan-${hash} (or deny-plan-${hash}).`);
    const verdict = await approved(hash, opts.signal);
    record({ event: 'decision', hash, verdict });
    if (verdict !== 'yes') return blocked(method, url.href, `the plan was not sent: ${verdict}. Do not send it again.`);
  }
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
