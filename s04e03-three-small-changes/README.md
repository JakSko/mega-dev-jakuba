# S04E03 Three small changes: a team of agents planned by files, run in a sealed box

A MEGA.dev Challenge (week 4). Everything here is a simulation: a pretend holiday-rental host, a practice payout key, made-up bookings.

## The task, in my words

A host sends three small changes to how payouts are calculated. Instead of one agent doing all three, a team does them:

- a **planner** (the one role I had to write myself) posts a plan on a shared board before any work starts: which job serves which request, which files each job may touch, which model runs it;
- a **critic** asks the host about anything unclear before code changes;
- three **workers** each build one change, an **integrator** merges them, a **reviewer** reads the result;
- then the day's payout batch runs on the merged code.

The hard part is not the code. It is keeping several model-driven agents inside their lanes, on code that came from somewhere else, without giving any of them my keys.

## What I built

| Folder | What it is |
|---|---|
| `roles/planner/` | The planner role I wrote (version 6 of 6) and the one script it may run (`desk-files.mjs`: lists tracked files, since its read tool cannot list folders). |
| `harness/` | Our team harness: the checks and runners around the course's roles. |
| `course-box/` | The sealed box all course code ran in, and the network gate that holds the model key. |

### The harness (`harness/`)

- `team-run.mjs` starts one role once: builds its start message, turns the guard on, writes a run record (git sha, role folder hash, harness hash, model) and event log lines. It refuses to start a role twice for the same job without `--again`, and fails a run whose last model call failed, even when the role exits 0 (the role launcher prints "model: ..." even when no model answered).
- `course-record.mjs` is a preload that sits outside the roles. Each role may send exactly one kind of write, once per run. The planner's plan POST is **held** until an approve file names the SHA-256 of the exact body: my yes is bound to the text, not to the intent. It survives the agent runtime replacing `globalThis.fetch` (tested against the real runtime in `course-record.pi.test.mjs`).
- `plan-check.mjs` checks a plan before I approve it: one job per request plus one merge job, no file in two jobs (the merge job included), no job may touch the team's own tools, models as chosen, asks within limits.
- `post-check.mjs` stands before every result POST: it reads the diff about to be sent, refuses paths outside the job's files, journal/output/secret paths, any value from `vars.json`, key shapes, and hidden "merge" commits; the merge job's diff needs an approve file with its exact hash.
- `desk-vars.mjs` handles secrets by script (values on stdin, never printed); worktrees get the attempt token only.
- `run-payout.mjs` runs the payout script with a key typed at a hidden prompt; the key reaches only that process and no file.
- `note-yes.mjs` writes my yes, with my words and what it covers, into the same event log.
- `redact.mjs` masks secrets by value, by field name and by shape. `rehearsal-course.mjs` is a fake board for an offline rehearsal.

### The box and the gate (`course-box/`)

- `Dockerfile`: Node 24, the agent runtime pinned, a non-root user.
- `box-up.ps1` starts the box with no capabilities, a read-only root, no host folders, no Docker socket, the harness mounted read-only, and checks every one of those settings after the start. Offline mode has no network at all.
- `gate/gate.mjs` is the only way out in run mode. The box sits on an internal Docker network with no route out. The gate holds the real model key (the box gets a dummy), passes only `POST /v1/responses` bodies it can check field by field (no server-side tools, no remote files or images, listed models, a request limit, capped output tokens), and tunnels HTTPS to listed hosts only, to the public address it checked. Its logs never hold headers, bodies or the key.
- `gate-up.ps1` (the owner types the key at a hidden prompt), `gate-down.ps1` (saves the gate log before it removes the gate), `harness-put.ps1` (writes our files into the read-only harness volume without running anything).

A detail found while building the gate: the agent runtime sends its tools **inside `input`** (an `additional_tools` item), not in the top-level `tools` field. A filter on `tools` alone would have let a server-side tool through. The gate checks both.

## How it was checked

- Unit tests: `harness/*.test.mjs` (fake course, fake roles, small git repos in temp folders) and `course-box/gate/gate.test.mjs` (33 tests, local fake servers only).
- Box checks before any course code ran: container settings, no access to host files (a control file on the host was not found from inside), no network in offline mode, and nine network tests of the gate (no direct route out, no host ports reachable, only listed names on 443, key never in the box). One paid run through the gate: 2 model requests.
- An offline rehearsal of the whole team flow on a fake board before the live attempt. It found that a role run with no model answer looked successful; `team-run.mjs` now fails such a run.

## What the debrief showed

Solved; the course accepted the claim on the first try. What went wrong first:

- **Split by file, not by request.** All three requests changed one payout calculation. My planner's early rules gave them to one job, then let the merge job list the workers' files too; the course refused that plan (a file in two jobs). The accepted plan gave each request its own new module with its own test and left the shared file to the merge job alone. `plan-check.mjs` now refuses any shared file.
- **The planner took six versions.** Its rules came from my guesses, not from the board's contract, and it had never run on the real model before the clock started. Each version is in git with its reason; every plan waited for my yes on its exact text, so one bad plan (an over-long line) never reached the course.
- **A worker stopped instead of guessing.** Its task named "the host's answers" without the file path, so it claimed its job and stopped. Restarted with a note saying where to look, it built the rule.
- **A wrong practice key parked the whole batch.** The payout script flagged every task for the owner instead of stopping. It now stops at the first refused key (in the payout script of the earlier Challenges, with a test).

What went right: the critic asked the host about the city tax before any code changed, so the three open points (a cap, the commission on it, which bookings) came from the host, not from a guess. The manual asked to check the payout key on a host the API did not name, and in the run the payout API answered one task with a redirect to another unlisted host. The key went to neither, and the redirect was not followed: that task went to the owner.

## How to run it

The tests need Node 24 and git; the Pi test needs `@earendil-works/pi-coding-agent` installed globally.

```sh
cd harness && node --test plan-check.test.mjs post-check.test.mjs team.test.mjs
cd ../course-box/gate && node --test gate.test.mjs
```

The box (Windows PowerShell, Docker Desktop):

```powershell
docker build -t course-box course-box
docker network create course-out
docker network create --internal -o com.docker.network.bridge.gateway_mode_ipv4=isolated course-in
docker volume create course-gate-code   # copy gate/gate.mjs into it, read-only for the gate
.\course-box\box-up.ps1                  # offline box
.\course-box\gate-up.ps1 -Model <model id> -MaxRequests 20 -Hosts course.example
.\course-box\box-up.ps1 -Mode gate       # a run container behind the gate
```

Course addresses in this folder are placeholders (`course.example`). The course's own role files, starter code, the host's answers and the three payout modules (they are the Challenge's answer) are not here.
