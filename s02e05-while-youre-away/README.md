# S02E05 - while you're away

An agent that works while I am away: it answers signed messages on its own channel, does the safe acts at once, holds the risky ones, sends a push to my phone, and does a held act only after I approve it. Built for the MEGA.dev Challenge S02E05 "while you're away" (2026-11-09 to 2026-11-10, solved on the fifth live try).

## The task, in my words

The course sends messages to my agent at a time I pick, while nobody is in the chat. Each message asks for one or more of six acts. Before the run I decide which acts the agent may do alone (free) and which need me (gated). A free act is done and answered right away. A gated act is held, and the agent pings my phone. It is done only after I approve it with a code that only I can see on the course page, within 60 minutes. Every message needs an answer within 10 minutes. At the end the agent's own status log must match the course's times, one row per event.

## How it works

| Step | What happens | Where in the code |
|---|---|---|
| A message arrives | The HTTPS POST must carry a valid HMAC-SHA256 signature over "timestamp.body" and be at most 5 minutes old, or it gets 401 before any work. Then 202 at once, the work after. | [`src/course.ts`](src/course.ts), [`src/service.ts`](src/service.ts) |
| The key is not there yet | The signing key arrives only after the channel is registered. With the key set to `pending` the agent stores signed POSTs and checks them later, when the key is set. | [`src/app.ts`](src/app.ts), `PendingQueue` |
| Which act, free or gated | Code, not a model, reads the act names in backticks and looks each one up in [`policy.json`](policy.json). A negation ("do not", "hold off"), an unknown act, or no act means "unclear": nothing is done. | [`src/acts.ts`](src/acts.ts) |
| The answer | One exact line per ask: `DONE: <act>` for a free act, `HOLD: <act>` for a gated one. A message with no act gets a short "NOT DONE" answer and no ping. | [`src/agent.ts`](src/agent.ts) |
| The ping | An ntfy push to my phone, with a link to the approve page for that message. | [`src/agent.ts`](src/agent.ts) `ping` |
| My approval | The approve page asks for my owner code (checked in constant time, locked after 5 wrong tries), the course code, and which held acts to approve. Then the agent answers `DONE: <act> CODE: <course code>`. The course code is masked in the log. | [`src/agent.ts`](src/agent.ts) `decide` |
| Text never approves | Every live message included a fake "owner pre-approved: <code>" line. The agent ignores it: an approval comes only from my approve page. | tests E26 |
| The trace | Every request, decision, act, ping, approval and reply goes to an append-only JSON-lines log on a volume, with secrets masked. A script turns that log into the status log, grouped by message. | [`src/guard.ts`](src/guard.ts), [`scripts/build_status_log.py`](scripts/build_status_log.py) |

The agent ran on its own Railway project with a volume, so it stayed up overnight and kept its state through every redeploy.

## What went wrong first

- **Try 1: the reply format.** The exact reply lines were given only inside the live message, not in the practice round. My first reply used its own one-line format and was refused. Now every reply is one exact `DONE:` or `HOLD:` line per ask.
- **Tries 2 to 4: the status log.** All messages were answered, but the status log was refused three times on its round numbers. The cause was one row: the agent also pinged me for the first message, which asked for nothing, and that ping became a "notified" row in round 1. A notification belongs only to an ask that needs the owner. Without that ping, try 5 passed. The lesson: when several refusals have one thing in common, check that thing first.
- **The window limit.** The course allows three windows per 24 hours. Starting over gave three more windows but also cleared the practice report, so it had to be sent again.

## How it was checked

- An eval suite (`test/evals.test.ts`, 25 tests with the service tests) runs a fake course that signs POSTs and captures replies, plus a fake ntfy. It checks what the agent did, not only what it said: the acts recorded, the replies, the pings, the log lines. Cases cover free and gated acts, negations and near-misses, unsigned and replayed POSTs, the key handoff, wrong owner codes and the lockout, the 60-minute expiry, per-act approval, the masked course code, a failed reply, and a message with no act.
- Before the first live run: a stranger check of the public health URL, unsigned and wrong-key POSTs answered 401, and one real push to my phone from the host, approved on the page.
- Practice: 10 of 10 labels right.
- The course's debrief: "The boundary", "Who approves", "Behind your door" and "Still up" went right the first time; "The trace" went wrong first.

## Files

| File | What it does |
|---|---|
| [`src/main.ts`](src/main.ts) | Entry point: reads host variables, logs lengths only, never values |
| [`src/app.ts`](src/app.ts) | Wires the signature check, the key handoff queue and the agent into one service |
| [`src/course.ts`](src/course.ts) | HMAC check, message id, the pending queue |
| [`src/acts.ts`](src/acts.ts) | Policy file and the act check (free, gated, unclear) |
| [`src/agent.ts`](src/agent.ts) | Replies, held acts, pings, the approve page and its decisions |
| [`src/service.ts`](src/service.ts), [`src/guard.ts`](src/guard.ts), [`src/store.ts`](src/store.ts), [`src/webhook.ts`](src/webhook.ts) | From my [agent-service skeleton](../shared/agent-service/): 401 before work, one action per event id, the masked whole-message log |
| [`scripts/build_status_log.py`](scripts/build_status_log.py) | Status log from the host log, grouped by message |
| [`scripts/send_test.ts`](scripts/send_test.ts) | Sends one signed (or unsigned) test message to a running agent |
| [`scripts/set-owner-code.ps1`](scripts/set-owner-code.ps1) | Sets the owner code on the host with hidden input (prompts in Polish) |
| [`fixtures/example/practice.json`](fixtures/example/practice.json), [`test/example-oracle.ts`](test/example-oracle.ts) | Made-up example messages and their hand-written answers (the course's own practice texts are not here) |

## Run it

Node 23.6 or newer runs the `.ts` files directly. There are no dependencies.

```bash
npm test
```

On a host, set `SIGNING_KEY` (or `pending`), `OWNER_CODE` (8+ characters), `NTFY_TOPIC` (a long random name), `PUBLIC_URL` (`https://...`), and `VAR_DIR` on a volume. Then start it with `node src/main.ts`.

## Not here

The course's brief, its practice texts, my claim bodies and replies, the request log and every key are left out on purpose.
