# S01E05 - answer where i asked

Two agents that wake alone, built for the MEGA.dev Challenge S01E05 "answer where i asked" (2026-11-04, solved on the second claim). This repo holds only the code written for the Challenge. The project it plugs into (the course's `rig` starter: the digest app, its plans, ADRs, run logs and docs) is not here, because the course hands it out for local work only.

## What it does

One small Node service (Hono) behind one public https address:

- `GET /.well-known/mega-pulse.json`: the owner code and the least rights per agent (pulse: `answer`, test writer: `test`).
- `POST /`: signed pings (Standard Webhooks: HMAC-SHA256 over `id.timestamp.body`, either of two signatures during a key change, at most 5 minutes old, reply and tracker on the course origin, one answer per `webhook-id`). A bad request gets 401 and costs no model call; a good one gets 202 at once, and the work runs after.
- **Pulse** (`src/agents/pulse.ts`): reads the issue tracker live, picks the facts in code, lets one model call word the answer, checks the draft in code (one open issue that the tracker shows now, nothing called shipped) and falls back to a plain answer from the facts; `pulse stopped: <what failed>` in one line when a check fails. Tracker text is passed to the model as data.
- **Test writer** (`src/agents/testwriter.ts`, `runner.ts`): one model call writes a test for the bug the ping names; the test runs on a temp copy of the code the ping carries, in a child process with a clean environment (no keys) and a time limit, and is sent only when an assertion fails on that base.
- **Reply guard** (`guard.ts`): size limits, no secret or reply token in any outgoing body; the course's words (ping bodies, replies, refused requests) are logged whole with the reply token masked.
- **Model client** (`model.ts`): any OpenAI-compatible endpoint, a daily call budget shared by both agents.

## Layout

| Path | What |
|---|---|
| `src/agents/` | the service: entry `main.ts`, settings `env.ts` |
| `test/agents.*.test.ts` | vitest tests for each part (60 with the rig repo's own tests) |
| `tools/` | `sign_ping` (test key only), `fake_course` (local tracker, replies, stub model), `run_cases` (11 local end-to-end cases), `check_secrets`, `check_lock_age` (every lockfile package at least 14 days old), `check_issues` / `close_issue` (issue files), `claim_body` |
| `railway.json`, `.railwayignore` | host config (Railway ignored the start command here; `RAILPACK_START_CMD=pnpm agents` as a service variable did the job) |

## Running it

It runs inside the rig project: copy `src/agents/`, `test/agents.*`, `tools/` into it, add the script `"agents": "tsx src/agents/main.ts"`, and move `tsx`, `typescript`, `vitest` and `@types/node` to `dependencies` (the test writer runs vitest on the host). `test/agents.pulse.test.ts` and `tools/fake_course.mjs` also expect a tracker snapshot at `test/fixtures/tracker-2026-11-04.json`, which is course data and is not in this repo.

Settings (host variables): `OWNER_CODE`, `PING_KEY` (secret), `COURSE_ORIGIN`, `MODEL_BASE_URL`, `MODEL_KEY` (secret), `PULSE_MODEL`, `TEST_MODEL`, `PULSE_REASONING`, `TEST_REASONING`, `DAILY_MODEL_CALLS`, `VAR_DIR`. No secret is in this repo.

Built in a local working copy (24 commits, one issue per branch, the plan split into ten issue files that I reviewed). The course's starter project is not here: the course hands it out for local work only.
