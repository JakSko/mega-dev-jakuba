# S02E01 - found out late

Tools built for the MEGA.dev Challenge S02E01 "found out late" (2026-11-05, solved on the fifth build). This folder holds only my own tools. The course's starter project, the teams' session logs, the plan I sent and the store files are not here: they are course material or the Challenge's answer.

## The task, in my words

Two teams had rebuilt a nightly job for a shop, each with a different coding agent (Claude Code and Codex), and left their agent sessions behind. The repo held a plan "as handed over". The job: find out what was actually decided, write a plan where every row cites the session and the time it was decided, have the course check the plan, then build the store it describes on my own machine.

## What made it hard

- The handed-over plan was older than a later decision that replaced part of it, and its own time stamp named the wrong time zone.
- One agent's context summary dropped a decision and added one nobody approved; another agent claimed a config change that no command in its log made.
- Some work ran in subagent threads, filed under the session that started them; one thread had no parent session at all.
- New sessions appeared **after** the plan was checked in. A later session changed only the image and the port, so it could be cited for those two values and nothing else.

## What I built

| Tool | What it does |
|---|---|
| [`tools/sessions_to_text.py`](tools/sessions_to_text.py) | Turns Claude Code and Codex session logs (`.jsonl`) into plain text, one file per log. Every line keeps the source row number and its UTC time stamp, so a finding can be cited back to the exact row. |
| [`tools/check_plan.py`](tools/check_plan.py) | Checks every row of a plan table (`Area \| Choice \| Source`) against the raw logs: the session exists, the proposal is an assistant row at that exact time, the approval is a user row after it. Also handles a proposal made by a subagent on the user's request. Prints the matching rows so a person can read them. |
| [`tools/stop_gate.py`](tools/stop_gate.py) | A stop hook for Claude Code: before the agent is allowed to stop, it re-reads each watched live source and compares it with the last version a person accepted. If it changed, it blocks the stop with a reason, so the agent looks again. It ignores signed-link tokens that change on every fetch, and it lets the agent stop after a few rounds or when the network fails. |

## How it was checked

- `check_plan.py` passed on every plan I sent (up to 7 rows) and failed on a test plan with one time off by a second.
- The stop gate was tested on four cases (changed source, the same change on the second stop, unchanged source, no watch list) and then caught a real late session during the solve by itself.
- The store was checked with the course's own verify script and a nonce the course issued.

## What the course's debrief showed

Four builds were refused before the fifth was accepted. Two refusals came from bundling several values into one plan row (the course checks one row per value), one from not re-reading the sessions after the check-in, and one from citing a late session for a choice it did not make. The re-read is what the stop gate now does on every stop.

## Running it

Python 3.11+, no dependencies. A made-up example is in [`example/`](example/) (not course data):

```bash
python -I -X utf8 tools/sessions_to_text.py example/sessions out/
python -I -X utf8 tools/check_plan.py example/plan.md example/sessions
```

The stop gate as a project hook, in `.claude/settings.json`:

```json
{"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "python -I -X utf8 \"/path/to/stop_gate.py\"", "timeout": 30}]}]}}
```

It reads `watch.json` next to the script (see [`example/watch.example.json`](example/watch.example.json); keep the real one out of git, it points at private files) and keeps per-session state in `state/`. `--status` shows each watch, `--accept NAME` records the live version as seen.
