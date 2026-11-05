import { serve } from '@hono/node-server';
import { join } from 'node:path';
import { createAgentsApp, defaultLog } from './app.js';
import { agentsEnv } from './env.js';
import { secretsOf, sendReply } from './guard.js';
import { Budget, openAiChat } from './model.js';
import { makePulse } from './pulse.js';
import { Seen } from './seen.js';
import { makeTestWriter } from './testwriter.js';
import { readPlanFiles, readTracker, type Issue } from './tracker.js';

// The host's entry point: the two agents that wake alone (plan.md §1, §5) behind one address.
const env = agentsEnv();
const varDir = process.env.VAR_DIR?.trim() || 'var';
const log = defaultLog;
const budget = new Budget(env.dailyModelCalls, join(varDir, 'model-calls.json'));
// One key and one budget for both agents (README); each agent has its own reasoning effort.
const chatWith = (reasoning?: string) =>
  env.modelKey ? openAiChat({ baseUrl: env.modelBaseUrl, key: env.modelKey, budget, reasoning }) : null;
const pulseChat = chatWith(process.env.PULSE_REASONING?.trim() || undefined);
const testChat = chatWith(process.env.TEST_REASONING?.trim() || undefined);
const secrets = (reply: string) => secretsOf(env, reply);

async function readIssue(n: number): Promise<Issue | null> {
  const r = await readTracker(`${env.courseOrigin}/rig/tracker/issues`);
  return r.ok ? (r.issues.find((i) => i.number === n) ?? null) : null;
}

const app = createAgentsApp(
  env,
  {
    pulse: makePulse({
      readTracker: (url) => readTracker(url),
      planFiles: () => readPlanFiles(env.repoDir),
      chat: pulseChat,
      model: env.pulseModel,
      send: (reply, body) => sendReply(reply, body),
      secrets,
      log,
    }),
    test: makeTestWriter({
      repoDir: env.repoDir,
      chat: testChat,
      model: env.testModel,
      readIssue,
      send: (reply, body) => sendReply(reply, body),
      secrets,
      log,
    }),
  },
  { seen: new Seen(join(varDir, 'seen-pings.txt')), log },
);

const port = Number(process.env.PORT ?? 8788);
serve({ fetch: app.fetch, port }, () => {
  log({ event: 'agents up', port, model: pulseChat ? 'set' : 'none', pulseModel: env.pulseModel, testModel: env.testModel, pingKeys: env.pingKeys.length, origin: env.courseOrigin });
});
