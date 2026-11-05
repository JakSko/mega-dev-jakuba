# S01E04 - before i looked

Solved 2026-11-04. The built service is its own public repo, started from the course template: [JakSko/mega-s01e04-before-i-looked](https://github.com/JakSko/mega-s01e04-before-i-looked). Its README is the template's; this page says what I did.

**The task, in my words:** a team hands over its repo: a small service, a plan, notes and a skill. Turn the plan into issues, let agents build it, send a reviewer a public link to an HTML copy of the page, then clean up. The reviewer looks when they get to it.

**What I did:**

- Split the plan into 7 issues (my approved shape: Source, Scope, Done when, Blocked by, label).
- Ran 5 Claude Code workers in separate git worktrees from a second session in the repo: the types first on the strongest model, then four parts in parallel on cheaper models. Each worker's result was checked from records (commits, tests), not from its report. Merged after review; 35 tests.
- Put the preview on Railway in a dedicated project, checked the link from outside byte for byte, and later re-uploaded it without the marker.
- The trap I hit: I closed the preview issue when the link was sent, before the reviewer had looked, so the course refused the claim. Reopened, waited for "seen", then closed. Since then a step that waits on someone else is done only when they confirm.

| File | What it does |
|---|---|
| `tools/issues.py` | creates the issues from the approved split (bodies from files, never on the command line) |
| `tools/close_issue.py` | closes an issue with the repo's closing comment (harness, model, effort, commit) |
| `tools/check_digest.py` | runs the service locally and checks the page and its marker state, without printing the marker |
| `tools/done_plan.py` | moves the finished plan to `docs/plans/done/` with its issue table |
| `tools/claim_body.py` | builds the claim body from the saved start reply |

Set `REPO_DIR` to the checkout before running `issues.py` or `done_plan.py`.
