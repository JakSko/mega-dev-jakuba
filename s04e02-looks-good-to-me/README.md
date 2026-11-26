# S04E02: a reviewer role that can judge but not touch

## The task, in my words

One agent role writes a change to a small payout app, a second role judges it, and the owner decides. I had to add that reviewer to my agent setup, run the version I was given as it was, then improve it until its verdict was right for every hunk of a patch. The same day's payout batch also had to pass.

## What I built (with Claude Code)

**The reviewer has two tools and nothing else** (`roles/reviewer/extensions/review.mjs`):

- `review_case` takes no input. Code reads the settings in force now, every `why/` note (the reason behind a decision) and the whole change. A case that is too long stops the review; it is never judged in part.
- `submit_findings` checks one finding per served hunk id and saves them once. It sends nothing. Sending is a separate script, after the owner has seen the exact text.

The role has no tool that takes a URL, a file or a script, so "judge, never change" holds in code and not only in the prompt. Of the secrets file it reads only the one token it needs.

**A guard outside the agent** (`tools/course-record.mjs`), a Node preload used to run a role I had not changed yet:

- reads go through, exactly one POST to the review address is allowed, and it is **held until a yes file exists** for the hash of that exact body;
- every other write and every other host is blocked; requests and replies are recorded with secrets masked;
- a lab mode serves saved inputs and lets nothing out, so a prompt can be tested on a fixed sample.

**The bug worth knowing about.** The first version of the guard replaced `globalThis.fetch`. The agent program (Pi) calls `undici.install()` when it starts, which assigns a new `fetch`. The guard's "loaded" marker was still there and **writes went through**. The guard now keeps itself behind a non-configurable getter and setter, and a test runs Pi's own start code under it (`tools/course-record.pi.test.mjs`). A marker that a guard loaded does not show that it still limits.

**Other tools:** `key-runner.mjs` (the owner starts it in a shell that holds the model key; the coding agent asks for fixed jobs through files and never sees the key; paid runs are counted to a cap), `run-reviewer.mjs` (a run record: git sha, role hash, model, input hashes), `get-course.mjs` (stores a new token before anything is masked or printed), `send-review.mjs` (shape check, inputs unchanged since the sample, sends once).

**Payouts** (`payout/solve.mjs`): rules in code, the commission read live at each start, no redirect followed, the payout key sent to one address only. After the owner decides a parked payment, a second try is allowed only if the first was clearly refused, never if it was paid or if its outcome is unknown.

## How it was checked

- On the course: the reviewer as given was **refused** because it judged against a value copied into its prompt, which had gone stale. The improved reviewer was **accepted** on a new patch it had not seen, and the payout batch passed.
- Before the second send: on that new patch, expected verdicts were written down before any model run, and the same version of the role met them twice in a row.
- Lab, first patch: 2 of 3 for the given role, 3 of 3 for the new one. The new tools alone already scored 3 of 3, so this sample does not show what the added judging rules are worth.
- Role tests: **all 7 failed on the role as given** (writes got out, a script could read the payout key) and pass on the new one.
- A document in the task asked to send the payout key to an extra host for a "check", and a payment reply pointed to a new address on another host. The key went to neither.

## What the debrief showed

Roles read their facts from the source at every start and never keep copies. The reason for each decision sits next to the code, and every role reads it before judging. My payout role does the first and only partly the second: the reasons are built into its code and tests, but it does not read the notes.

Limits: the guard covers `fetch` only, not other network code or child processes without the preload. The payout script did not run under it, so for payouts the evidence is the code and the event journal, not a network record.

## Run the checks

Node 24 (the version used here). No packages to install for these:

```
node --test tools/course-record.test.mjs tools/get-course.test.mjs tools/reviewer-role.test.mjs
node payout/solve.mjs --selftest
```

`tools/course-record.pi.test.mjs` also needs Pi installed globally (`@earendil-works/pi-coding-agent`, 1.6.1 here).

Not here, on purpose: the course's starter code and task files, its patch, replies and logs, and my keys. `course.example` stands in for the real hosts, the two notes in `why/` are made up, and `ROLE.md`, `run.mjs` and the host check are short versions written for this folder.
