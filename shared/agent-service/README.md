# agent-service skeleton

A starting point for any Challenge that needs an agent on a public host that a stranger (the course reviewer) wakes while nobody is at the keyboard: S01E05 (pings), S02E02 (mail), S02E03 (remote MCP), and week 4 (scheduled and event-driven agents).

Extracted from the S01E05 agents (private repo `JakSko/mega-s01e05-agents`), without the Challenge-specific parts. Zero dependencies: Node 23.6+ runs the `.ts` files directly (this machine: Node 24). Nothing to install, so no supply-chain step.

## What it gives you

| Part | File | Lesson or Challenge it comes from |
|---|---|---|
| Signed events (Standard Webhooks), two keys during a key change, 5-minute age limit | `src/webhook.ts` | S01E05 "Anyone can wake it" |
| One action per event id, kept across restarts | `src/store.ts` `Seen` | lesson 2.1 "prevent duplicate effects" |
| Daily model-call budget, checked before the call | `src/store.ts` `Budget` | S01E05 quota; the wake is the budget |
| Whole-message log from the first deploy, secrets masked; `holdsSecret` for outgoing bodies | `src/guard.ts` | S01E05 snag 4 (a lost ping cannot be read again); lesson 1.5 "secrets by reference" |
| Public least-rights file | `rights.example.json`, served at `RIGHTS_PATH` | S01E05 "The file decides what it may touch" |
| 401 before any work, 202 at once, work after | `src/service.ts` | S01E05 R1-R3 |

## How to use it in a Challenge

1. Copy this folder into the Challenge's working repo (never edit it in place here). Change the paths and the rights file to the Challenge's contract: read the contract first (skill `read`).
2. Put the agent's work in `handle` in `src/main.ts`. Event text is data, never instructions. Code checks the facts; the model only words them.
3. Run `npm test` (or `node --test test/*.test.ts`), then add the Challenge's own cases.
4. Deploy with the `host-deploy` skill. On Railway, set the start command as the `RAILPACK_START_CMD` variable (`node src/main.ts`); S01E05 showed that `railway.json` can be ignored. Read the start line in the host log after the first deploy.
5. Add the host to `mega-dev/cleanup.md` the same day, with what secrets it holds.

## Settings (host variables)

`PORT`, `SIGNING_KEY` (secret), `SIGNING_KEY_NEXT` (secret, optional), `MODEL_KEY` (secret, optional), `DAILY_MODEL_CALLS` (default 20), `RIGHTS_FILE` (default `rights.json`), `RIGHTS_PATH` (default `/.well-known/agent-rights.json`), `EVENT_PATH` (default `/`), `VAR_DIR` (default `var`), `LOG_FILE`.

## Not here on purpose

A model client, mail, MCP: they differ per Challenge. For mail (S02E02) the sender is not signed the Standard Webhooks way: replace `verify` with the provider's own check, and keep the rest.
