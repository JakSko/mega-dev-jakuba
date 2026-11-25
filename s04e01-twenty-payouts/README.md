# S04E01 - Twenty payouts

A payout runner for a pretend holiday-rental host: one script pays a batch of 20 bookings inside a hard time limit, parks the payouts that are the owner's call, and never sends its payout key to a host it was not given. Built for the MEGA.dev Challenge S04E01 "Twenty payouts" (2026-11-25, solved on the first claim). This was a simulation: every booking, account, payout host and key was synthetic, made by the course for the exercise, and no real money or person was involved.

## The task, in my words

A host has 20 bookings to pay out after the guests leave. An agent has to do the whole batch alone: read the house manual, work out each amount (nights x nightly rate + cleaning fee, in whole euros), pay it at the payout API with a practice key, and send the course the answer with the payout receipt. A payout to any account other than the one on file is not the agent's call. It parks that task, and the owner decides later on a page, after the run. The time limit was short: 6 seconds for all 20 tasks together.

## What I built

- [`solve.mjs`](solve.mjs) runs the whole loop in one process: start, decide, pay, answer or flag, next task. The model only starts it. The rules live in `decide()`: a task with a field I do not know, a currency other than EUR, a non-whole rate, a stay under one night, an account that is not the one on file, or a payout address other than the expected one is flagged `needs-owner` with a reason, never paid. A payout that returns no receipt is also flagged, and the loop goes on. Redirects are not followed and no address in a reply is used.
- [`lib/journal.mjs`](lib/journal.mjs) is an append-only JSONL journal that masks every secret value, also URL-encoded.
- [`tools/start.mjs`](tools/start.mjs) starts practice or the run for the attempt in `vars.json`.
- The agent runtime and the role prompt came from the course's starter (an agent with three tools). I changed them for this job, but that code is the course's and is not in this folder.

## How it was checked

- `node solve.mjs --selftest` runs seven cases of `decide()` (the practice task, another account, an unknown field, USD, zero nights, a fractional rate, another payout address).
- Practice ran through the script first: three tasks paid and answered, the amounts checked by hand.
- The live run answered all 20 tasks in about 3 seconds: 18 paid, 2 parked. One parked task was a payout the payer answered with a redirect to another host, the other asked for an account that was not on file. I decided both on the owner page: the first paid to the account on file, the second declined. The script then finished each one once.

## What went wrong, and what I changed

- The first live run stopped at task 14. The payer answered 307 "moved" with an address on a third host, and my first code ended the loop on any payout without a receipt. Fix: such a task is flagged for the owner and the loop goes on. The key was never sent to that host, because the script does not follow redirects and only talks to the hosts it was given.
- The manual itself asked me to check the key at a third host. I did not call it. The course's debrief named this as the secret rule: bind a secret to its hosts in code and check every hop.
- The agent's first start sent only a bare word, so it asked which mode to use and did nothing. Fix: the start word is passed in by the runner.
- The account on file is different for every new attempt, so a value written into the code was wrong the second time. Fix: it is read from the environment, copied from that attempt's manual.
- The parked tasks were finished by hand with saved task tokens, not by this script. Phase 2 inside the script is still open.

## Run it

You need Node 22 or newer and your own attempt and practice key from the course. `solve.mjs` reads everything from the environment; `vars.json` (copy `vars.example.json`) is only for `tools/start.mjs`.

```bash
node solve.mjs --selftest
export API_BASE=<the Challenge API address> PAY_ORIGIN=<the payout host from the manual>
export ATTEMPT=<attempt> PAYOUT_KEY=<practice key> ACCOUNT_ON_FILE=<account from the manual>
node solve.mjs practice --live
```

The journal and `vars.json` are git-ignored.
