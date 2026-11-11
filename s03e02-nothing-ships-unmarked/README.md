# S03E02 - nothing ships unmarked

A triage skill for an issue tracker: raw requests in, a marked tracker out. Every open issue ends up either ready for an agent to ship alone or marked as a question for a person, and every decision cites the written rule behind it. Built for the MEGA.dev Challenge S03E02 "nothing ships unmarked" (2026-11-11, solved on the second try).

## The task, in my words

A scheduling product (booking pages, team calendars, reminders, exports) gets requests from support, clients, product, analytics and finance. A small kit pulls its backlog and three request channels (support desk, team chat, client mail) into a tracker of Markdown files, one per issue, but marks nothing. The product's specs say what an agent may do alone and what needs a person, with an id for every rule.

The job: triage every request so that each one sits in exactly one issue, work that is not needed is closed with a reason (duplicate, obsolete, against the spec, not planned), and every open issue carries one of two marks. An `agent-ready` issue is a brief an agent can ship without asking: intent, checkable acceptance with at least one "must not" case, boundaries, and the autonomy line that allows it. A `needs-human` issue is a question a person can answer: options, a recommendation and the fact it rests on. The tracker goes in together with the text of my own triage skill.

## What I built

### `triage/` - the skill

[`triage/SKILL.md`](triage/SKILL.md) gives each rule as a principle with its reason, so it also covers cases it does not name. Every request goes through six questions, in order:

1. Is it already answered by an issue? Then it joins that issue's sources (a ticket filed before a shipped fix joins the done issue).
2. Was it withdrawn or replaced by the same side? Then one closed issue, citing the withdrawal.
3. Does it break a product rule? Then it is closed as against the spec, naming the rule and a way to meet the need inside it, whoever asked.
4. Do two inputs pull in opposite directions, or does a change touch something a client relies on? Then one `needs-human` question with both sides. Triage never picks a side.
5. May an agent do it alone? Only when an "agent may" line covers it and no "needs a human" line touches it.
6. `needs-human` needs a fact with an id: a human-list line, two opposing inputs, or a fact no request or rule gives. "No rule sets this" is not such a fact. A feature no rule forbids is `agent-ready` as the narrowest additive change.

Plus dependencies (`blocked-by` when a migration must land first, whatever the urgency), the issue bodies, and a decision table for a person to review.

[`triage/scripts/check_tracker.mjs`](triage/scripts/check_tracker.mjs) checks the bookkeeping, never the judgment: every request in exactly one issue, one mark on every open issue, origin labels, close reasons and their cited ids, body sections, every cited id exists, link targets exist, no `blocked-by` cycle. `--self-test` runs one good tracker and 22 broken ones; each break must be named.

### `scripts/` - around the skill

- [`poll.sh`](scripts/poll.sh) runs the kit's collector with its saved cursor until every channel returns nothing new, within a set number of runs. Requests kept arriving: 14 after two runs, 21 after four.
- [`fetch-logger.mjs`](scripts/fetch-logger.mjs) is a Node preload that saves every API reply exactly, with the session token cut from the saved URL, so the log holds what really came back.
- [`build_claim.mjs`](scripts/build_claim.mjs) builds the answer from the files, never by retyping: tracker files and skill text, byte size against the limit, and hashes to prove the sent tracker is the skill's output.

## How it was checked

- The checker's self-test (1 green, 22 red), a red run on the raw collector output (32 open issues without a mark), then `result: ok` on the triaged tracker.
- The triage ran in a fresh agent session that got only `SKILL.md` and the kit, so the skill text alone had to be enough.
- The first claim was refused with "needs-human: 1 extra": 15-minute slots had gone to a person only because no rule sets slot length. Rule 6 was narrowed, only the four `needs-human` issues were decided again, and the second claim was accepted: 21 requests carried by 17 issues, 8 merged, 19 `agent-ready`, 3 `needs-human`, 1 closed as against the spec, 1 not planned.
- The course's debrief: "A request is not an issue", "Loud is not right", "The inbox keeps going", "Someone relies on it" and "Urgent is not first" went right the first time; "Not everything is a question" went wrong first.

## Run it

```bash
node triage/scripts/check_tracker.mjs --self-test
node triage/scripts/check_tracker.mjs --issues <tracker>/doc/issues --api <folder with run*/ API replies> --specs <tracker>/specs
SCHED_API=<api url> bash scripts/poll.sh 1 10 60
node scripts/build_claim.mjs --issues <tracker>/doc/issues --skill triage/SKILL.md --skill-path .claude/skills/triage/SKILL.md --session <file> --out answer.json
```

To use the skill in Claude Code, put the `triage/` folder where the harness loads project skills (`.claude/skills/triage/`), preferably as a link to one source folder rather than a copy.

The Challenge's own files (the tracker kit, its specs, the requests, the triaged issues and the course's replies) are not here.
