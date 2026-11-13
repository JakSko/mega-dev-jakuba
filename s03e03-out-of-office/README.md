# S03E03 - out of office

An agent that works a product's issue tracker alone while the owner is away: it picks up each issue within seconds, decides it from a triage skill, builds and ships what it may, asks the owner only what is the owner's to decide, and keeps a ship log. Built for the MEGA.dev Challenge S03E03 "out of office" (2026-11-13, solved on the first claim).

## The task, in my words

A small incidents API of a scheduling product comes as a starter. For about twenty minutes, product and support open issues on a tracker while the owner is away. The agent must run on a host by itself, pick up every issue within five minutes, ship each accepted change to a live https address, write a decision record and ask the owner when a call is theirs, and post one ship line per issue. The owner only answers questions and signs records; nobody touches the code by hand.

The round had six issues: three additive reads, one change the owner had to decide (with an unsigned "do not build" note already among the records), one export an accepted record already forbade, and a stranger asking for a debug route that prints the settings.

## What I built

### The idea: the model decides, code acts

No model call can run a command. Triage, build and review each get the files they need inside the prompt and answer JSON that a schema and code rules check. A deterministic runner does every outside effect. So an issue's text has nothing to talk into action, and the same setup runs on any host.

### `runner/` - the runner (Node, no dependencies)

- [`src/machine.mjs`](runner/src/machine.mjs): the state machine. Pickup with a comment and a read-back, never waiting for a model. One issue builds at a time, oldest first. Decision rules in code: a change to what an existing answer carries needs the owner, anything that writes to production data is declined, an accepted and signed record is not asked again, every decision cites a rule. The ask flow (decision record, label, numbered options, the owner's `/answer <n>`, accepted record, request to sign). Build with three tries and the gate output fed back, a separate review, deploy, live check twice, rollback, ship line with a read-back. Each outside step is done once, even across a restart.
- [`src/gates.mjs`](runner/src/gates.mjs): gates before any deploy. Only allowed paths; documents may only grow without the owner's answer; no token value anywhere; no write request in product code; a test must change; all tests; and the contract tests as they were before the change must still pass.
- [`src/lib.mjs`](runner/src/lib.mjs): the one way out (every request logged whole, any write to the production feed refused), the tracker client, a masked log, state on a volume.
- [`src/agent-codex.mjs`](runner/src/agent-codex.mjs): three calls to the Codex CLI, headless. The build call returns whole files as JSON; the runner checks each path and writes them. Model-written code and its tests run as a separate unix user with none of the runner's secrets.
- [`src/deploy-wrangler.mjs`](runner/src/deploy-wrangler.mjs): deploy with the API's own pinned wrangler, then ask Cloudflare which version is active.
- [`schemas/`](runner/schemas/): the JSON shapes of a decision, a build and a review.

### `example-api/.agents/skills/triage/` - the skill

[`SKILL.md`](example-api/.agents/skills/triage/SKILL.md) is my triage skill from S03E02, grown to run alone on a live tracker: one issue in, one decision out (build, decline, ask, close, or nothing new). It says what to read first, the questions in order, when a call is the owner's, how to write the decision record, and what a live check must prove. It names files of the real project (how work lands, research, a record template) that are not in this folder.

### `example-api/` - a stand-in API

The Challenge's starter is not mine to publish, so a small example Worker stands in for it: one call that reads incidents from a feed, a short contract, [`PRIMITIVES.md`](example-api/PRIMITIVES.md) (what the API is made of and who decides a change to each part) and the baseline contract tests.

### Rehearsal and host

- [`runner/test/`](runner/test/): a fake tracker, feed, live address and owner, and a whole scripted round: an additive ship, a declined production write, an ask with a bad answer then a valid one, a duplicate, a rollback after a failed live check, and a build that tries to write to the feed and is stopped by a gate.
- [`runner/scripts/real-round.mjs`](runner/scripts/real-round.mjs): the same round with the real model against the fakes. [`real-check.mjs`](runner/scripts/real-check.mjs) runs single issues.
- [`Dockerfile`](Dockerfile) and [`entrypoint.sh`](entrypoint.sh): the host image, with switches for a one-time rehearsal on the host itself.
- [`runner/scripts/after-open.sh`](runner/scripts/after-open.sh): hands the round's addresses and token to the Worker and the host through stdin.

## How it was checked

- 4 runner tests (the scripted round has about 40 assertions) and 7 contract tests, each proven able to fail by breaking the code on purpose.
- A real-model round on 8 held-out issues written by a fresh agent that never saw the skill or the runner: all 8 decided as their author expected, in 6.6 minutes and 12 model calls.
- A rehearsal on the host itself, through the same path as the round.
- The round: 6 issues, each picked up in 7 to 14 seconds; 4 shipped and read from outside on the live address, 2 declined; 2 asks answered and signed by the owner; no write to production. The course accepted the first claim.

## What went wrong, and what I changed

- The coding CLI's sandbox blocked every command on Windows and could not start in the host container. Instead of switching it off, the model stopped running commands at all. The course's debrief named this the right call.
- The first live check asked for an example id from the contract that the real feed did not have, so a good change was rolled back. Fix during the round: the agent gets a sample of the live answer and builds its checks from it.
- A gate banned the admin token's name and write requests even in tests, so tests that prove a refusal were refused. Fix during the round: that ban applies to product code only.
- The agent asked the owner about an export that an accepted record already forbade. The skill said to follow accepted records; the model asked anyway. Fix after the round: a rule in code. The decision names the record that already decides the issue, and the runner refuses an ask or a build against an accepted, signed record. An unsigned record stays evidence, so that call still goes to the owner.
- "Round complete" was pushed while one issue was still waiting. Fix after the round: "delivered" is a named set of outcomes (shipped, declined, closed).

Both fixes during the round were changes to the runner, approved by me; the API code was changed by the agent only.

## Run it

```bash
cd example-api && node --test          # the contract tests
cd runner && node --test               # the runner tests, with a whole scripted round
```

With a model key and the Codex CLI:

```bash
node runner/scripts/real-round.mjs <key file> <path to codex.js or "codex"> runner/scripts/dev-issues.json 20
```

On a host, the runner reads its settings from the environment: `TRACKER_URL`, `TRACKER_TOKEN`, `FEED_URL`, `LIVE_URL`, `OPENAI_API_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `WORKER_NAME`, `MODEL_BUILD`, `MODEL_REVIEW`, `NTFY_TOPIC`. Without the tracker values it only prints a heartbeat.

The Challenge's own files (the starter API, its rules and research, the issues, records and replies of the round) are not here.
