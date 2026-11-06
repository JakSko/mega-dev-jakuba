// Entry point: a worker with no public port. Polling is the source of truth (spec R2);
// the WebSocket only makes a new mail start sooner.
import { join } from 'node:path';
import { AgentMail } from './agentmail.ts';
import { OpenAIChat } from './model.ts';
import { fetchPage } from './fetch_page.ts';
import { Seen, Budget } from './store.ts';
import { makeLog } from './guard.ts';
import { MailAgent } from './agent.ts';

const env = process.env;
function need(name: string): string {
  // Trimmed: a value piped in from PowerShell can carry a trailing newline.
  const v = env[name]?.trim();
  if (!v) {
    console.error(`missing setting ${name}`);
    process.exit(1);
  }
  return v;
}

const amKey = need('AGENTMAIL_API_KEY');
const modelKey = need('MODEL_KEY');
const inbox = need('INBOX_ID').toLowerCase();
const allowed = (env.ALLOWED_SENDERS ?? 'rook@mail.mega.dev').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const pollSeconds = Number(env.POLL_SECONDS ?? 30);
const varDir = env.VAR_DIR ?? 'var';
const secrets = [amKey, modelKey];
const log = makeLog({ secrets, file: env.LOG_FILE ?? null });

const agent = new MailAgent({
  mail: new AgentMail({ key: amKey, inboxId: inbox }),
  model: new OpenAIChat({ key: modelKey, model: env.MODEL ?? 'gpt-6.1-terra', reasoningEffort: env.REASONING_EFFORT ?? 'none' }),
  fetchPage: (url) => fetchPage(url),
  seen: new Seen(join(varDir, 'seen-ids.txt')),
  budget: new Budget(Number(env.DAILY_MODEL_CALLS ?? 200), join(varDir, 'model-calls.json')),
  log,
  cfg: { allowed, own: inbox, secrets, maxTurns: 8, maxFetches: 5, deadlineMs: 5 * 60_000, maxAttempts: 3 },
});

log({ event: 'start', inbox, allowed_senders: allowed.length, poll_seconds: pollSeconds, model: env.MODEL ?? 'gpt-6.1-terra', node: process.version });

const tick = (why: string) => {
  agent.pollOnce().catch((e) => log({ event: 'poll-error', why, error: String((e as Error).message ?? e) }));
};
setInterval(() => tick('timer'), pollSeconds * 1000);
setInterval(() => log({ event: 'alive', model_calls_left_today: agent.d.budget.left() }), 10 * 60_000);
tick('start');

// WebSocket: wss://ws.agentmail.to/v0?api_key=..., subscribe per inbox (asyncapi.json, read 2026-11-06).
// The URL holds the key: it is never logged (makeLog masks `api_key=` too).
let delay = 1000;
function connect() {
  const ws = new WebSocket(`wss://ws.agentmail.to/v0?api_key=${encodeURIComponent(amKey)}`);
  ws.onopen = () => {
    delay = 1000;
    ws.send(JSON.stringify({ type: 'subscribe', inbox_ids: [inbox], event_types: ['message.received'] }));
  };
  ws.onmessage = (ev) => {
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (d.type === 'subscribed') log({ event: 'ws-subscribed' });
    else if (d.type === 'error') log({ event: 'ws-error', detail: JSON.stringify(d).slice(0, 500) });
    else if (String(d.event_type ?? '').startsWith('message.received')) {
      log({ event: 'ws-event', event_type: d.event_type });
      tick('ws');
    }
  };
  ws.onerror = () => {};
  ws.onclose = (ev) => {
    log({ event: 'ws-closed', code: ev.code, retry_ms: delay });
    setTimeout(connect, delay);
    delay = Math.min(delay * 2, 60_000);
  };
}
connect();

process.on('SIGTERM', () => {
  log({ event: 'stop', why: 'SIGTERM' });
  process.exit(0);
});
