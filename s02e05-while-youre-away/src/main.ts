import { loadPolicy } from './acts.ts';
import { createApp, PENDING } from './app.ts';
import { makeLog } from './guard.ts';

// Entry point on the host. Everything comes from host variables; secrets only from the host's
// variable store. Start: `node src/main.ts` (Node 23.6+ runs .ts).
//
// SIGNING_KEY   the course's signingKey, or "pending" until the register reply (spec R12)
// OWNER_CODE    the code only Jakub has (typed by him into the host variables)
// NTFY_TOPIC    the phone ping topic (random); NTFY_URL default https://ntfy.sh
// PUBLIC_URL    https://<host> for the approve link
// VAR_DIR       on a volume (state survives deploys); POLICY_FILE default policy.json
// TEST_MODE=1   enables the /_test/ sink for the end-to-end test only

const env = process.env;
const key = env.SIGNING_KEY?.trim() || PENDING;
const ownerCode = env.OWNER_CODE?.trim() ?? '';
const topic = env.NTFY_TOPIC?.trim() ?? '';
const varDir = env.VAR_DIR ?? 'var';
const secrets = [key === PENDING ? '' : key, ownerCode, topic].filter((s) => s.length >= 8);
const log = makeLog({ secrets, file: env.LOG_FILE ?? `${varDir}/events.jsonl` });

if (ownerCode.length < 8) throw new Error('OWNER_CODE missing or shorter than 8 characters');
if (!env.PUBLIC_URL?.startsWith('https://') && env.TEST_MODE !== '1') throw new Error('PUBLIC_URL must be https://');

const app = createApp({
  key,
  policy: loadPolicy(env.POLICY_FILE ?? 'policy.json'),
  publicUrl: env.PUBLIC_URL ?? 'http://localhost',
  ownerCode,
  ntfy: topic ? { url: env.NTFY_URL ?? 'https://ntfy.sh', topic } : null,
  varDir,
  log,
  testMode: env.TEST_MODE === '1',
  allowHttpReply: env.TEST_MODE === '1' && env.ALLOW_HTTP_REPLY === '1',
});

const port = Number(env.PORT ?? 3000);
app.server.listen(port, async () => {
  // Lengths, never values (traps.md: an env var cut on paste).
  log({ event: 'start', port, key: key === PENDING ? 'pending' : `set (${key.length} chars)`, ownerCode: `${ownerCode.length} chars`, ntfyTopic: topic ? `${topic.length} chars` : 'none', testMode: env.TEST_MODE === '1', held: app.agent.held.size, actsDone: app.agent.done.length });
  if (key !== PENDING) {
    const r = await app.drain();
    log({ event: 'key set', storedHandled: r.handled, storedRejected: r.rejected });
  }
});
