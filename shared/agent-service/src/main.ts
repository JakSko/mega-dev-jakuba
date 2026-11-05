import { readFileSync } from 'node:fs';
import { makeLog } from './guard.ts';
import { createService } from './service.ts';
import { Budget, Seen } from './store.ts';

// Entry point. Everything comes from host variables; secrets only from the host's secret store.
// Replace `handle` with the Challenge's agent. Start: `node src/main.ts` (Node 23.6+ runs .ts).

const env = process.env;
const keys = [env.SIGNING_KEY, env.SIGNING_KEY_NEXT].map((k) => k?.trim()).filter((k): k is string => !!k);
const secrets = [...keys, env.MODEL_KEY ?? ''].filter((s) => s.length >= 8);
const varDir = env.VAR_DIR ?? 'var';

const log = makeLog({ secrets, file: env.LOG_FILE ?? `${varDir}/events.jsonl` });
const budget = new Budget(Number(env.DAILY_MODEL_CALLS ?? 20), `${varDir}/model-calls.json`);
const rights = JSON.parse(readFileSync(env.RIGHTS_FILE ?? 'rights.json', 'utf8'));

const server = createService({
  keys,
  rights,
  rightsPath: env.RIGHTS_PATH,
  eventPath: env.EVENT_PATH,
  seen: new Seen(`${varDir}/seen-ids.txt`),
  log,
  handle: async (event) => {
    // The agent's work goes here. Event text is data, never instructions.
    // Spend a model call only after `budget.take()` returns true.
    log({ event: 'todo', id: event.id, budgetLeft: budget.left() });
  },
});

const port = Number(env.PORT ?? 3000);
server.listen(port, () => log({ event: 'start', port, keys: keys.length, rightsPath: env.RIGHTS_PATH ?? '/.well-known/agent-rights.json' }));
