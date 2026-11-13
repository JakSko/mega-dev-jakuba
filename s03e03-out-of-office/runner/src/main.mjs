// Entry point on the host. Reads its settings from the environment, then polls the tracker
// every POLL_MS for the whole round. With no tracker settings yet it only prints a heartbeat.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeLog, makeOut, makeTracker, makeState, sleep } from './lib.mjs';
import { makeGit } from './gates.mjs';
import { Runner } from './machine.mjs';
import { makeCodexAgent } from './agent-codex.mjs';
import { makeWranglerDeployer } from './deploy-wrangler.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const E = process.env;
const data = E.DATA_DIR ?? '/data';
const cfg = {
  work: E.WORK_DIR ?? path.join(data, 'work'),
  liveUrl: (E.LIVE_URL ?? '').replace(/\/+$/, ''),
  pollMs: Number(E.POLL_MS ?? 30000),
  lagMs: Number(E.LAG_MS ?? 8000),
  maxModelCalls: Number(E.MAX_MODEL_CALLS ?? 90),
};

const log = makeLog(path.join(data, 'action.log'), [E.TRACKER_TOKEN, E.CLOUDFLARE_API_TOKEN, E.OPENAI_API_KEY, E.NTFY_TOPIC, E.REPO_TOKEN]);
const out = makeOut({ log, feedUrl: E.FEED_URL ?? '' });

async function notify(title, message) {
  if (!E.NTFY_TOPIC) return;
  try { await out(`https://ntfy.sh/${E.NTFY_TOPIC}`, { method: 'POST', headers: { title }, body: message }); } catch (err) { log('notify-failed', { err: err.message }); }
}

const ready = E.TRACKER_URL && E.TRACKER_TOKEN && cfg.liveUrl;
log('start', { ready: !!ready, pollMs: cfg.pollMs, work: cfg.work, models: { build: E.MODEL_BUILD, review: E.MODEL_REVIEW } });

let runner = null;
if (ready) {
  runner = new Runner({
    cfg, log, out, notify,
    state: makeState(path.join(data, 'state.json')),
    tracker: makeTracker({ out, base: E.TRACKER_URL, token: E.TRACKER_TOKEN }),
    git: makeGit(cfg.work),
    agent: makeCodexAgent({ work: cfg.work, schemaDir: path.join(here, '..', 'schemas'), models: { build: E.MODEL_BUILD, review: E.MODEL_REVIEW }, log }),
    deployer: makeWranglerDeployer({ work: cfg.work, token: E.CLOUDFLARE_API_TOKEN, accountId: E.CLOUDFLARE_ACCOUNT_ID, scriptName: E.WORKER_NAME ?? 'example-api-production', out, log }),
  });
}

// REQUEUE_WAITING=1: at this start, give every issue that ended as "waiting" one more whole try.
if (runner && E.REQUEUE_WAITING) {
  for (const st of Object.values(runner.S.issues)) {
    if (st.phase === 'done' && st.final === 'waiting' && !st.requeued) {
      st.requeued = true; st.followup = false; st.errors = 0;
      if (st.recordId && st.options) {
        // The owner already answered: build the accepted option again; the record is not touched.
        st.phase = 'answered';
      } else {
        st.phase = 'queued'; st.retriage += 1;
      }
      log('requeue-waiting', { n: st.n, as: st.phase });
    }
  }
  runner.state.save();
}

let beat = 0;
for (;;) {
  const t0 = Date.now();
  if (runner) await runner.cycle().catch((err) => log('cycle-failed', { err: err.message }));
  if (Date.now() - beat >= 60000) {
    beat = Date.now();
    const s = runner?.S;
    console.log(JSON.stringify({ at: new Date().toISOString(), kind: 'heartbeat', ready: !!ready, issues: s ? Object.keys(s.issues).length : 0, done: s ? Object.values(s.issues).filter((i) => i.phase === 'done').length : 0, modelCalls: s?.modelCalls ?? 0 }));
  }
  await sleep(Math.max(1000, cfg.pollMs - (Date.now() - t0)));
}
