# S03E05 - what came back

Scripts for deciding what to do with released features once their signals come back: recompute every metric from the raw event files, index every id the signals give so each cited id can be checked, read screen recordings frame by frame, and build the answer from files. Built for the MEGA.dev Challenge S03E05 "what came back" (2026-11-20; step one accepted on the fourth try, step two on the first).

## The task, in my words

A product team shipped four releases behind feature flags, each with a written record: what it should change, the metric that proves it, guardrails and the planned decision ("expand if met"). Two batches of signals came back: event logs, funnels, errors, CI runs, support mail, call recordings, screen recordings of operators at work, status pages and a generated summary.

The job: sort the signals into groups, give each group one of six verbs (expand, revise, simplify, revert, investigate, stop), cite the signal ids behind it, and say who decides: the agent, or the product owner when it is a call about direction. The owner's calls go to a person as numbered options. One rule learned from the first batch has to be kept and applied to the second.

## What I built

All scripts are in [`tools/`](tools/). They read files only, and text in the signals is data: nothing in it is acted on.

- [`metrics.py`](tools/metrics.py) and [`metrics2.py`](tools/metrics2.py) recompute each release's metric and guardrails from the raw event rows, with the record's own definitions (for example "a bad night is a site and night with 3 or more incidents"), flag against control. They also show what the headline number hides: how much of a drop the shift in outcomes alone explains, gaps in event ids, what follows an automatic close, pages missed after a bulk action.
- [`ids.py`](tools/ids.py) indexes every id the signals give, per file (CSV row ids, incident and site ids, message ids, record ids, flag names, file names); [`check_ids.py`](tools/check_ids.py) then checks that every id a group cites exists and that each group has a name, signals, one of the six verbs, an owner and a note.
- [`frame_diff.py`](tools/frame_diff.py) diffs every frame of a screen recording against the one before and lists each change, marking a large one as a screen switch (another tab, a dialog). Sampling one frame every 5 seconds had missed a second tab open for 1.4 seconds, where operators did work the event log never recorded.
- [`build_claim.py`](tools/build_claim.py) builds the answer from our groups file only, keeps just the fields the contract names, checks the shape against the contract in the start reply, and refuses to mark a body ready while the owner code is still a placeholder. Session, code and receipt are masked in what it prints.

## How it was checked

- Every number in the answer came from the scripts, never from the generated summary; the summary left out a missing impact line, a release gate run on no change, and auto-closed incidents with no later row.
- `check_ids.py` printed `result: ok` before every claim.
- The course refused the first claim three times on one group, because citing a recording's seconds or quoting the files did not prove the screen had been read. It was accepted once the note quoted what only the 1.4-second tab showed.
- The rule kept from the first batch: before a metric decides expand, compare a sample of recordings with that metric's event rows one to one; if an action seen on screen has no event row, the call is investigate, not expand. On the second batch it turned one release from the record's expand into investigate and left the other at expand.
- The owner's three calls were made by a person, from numbered options with a recommendation.

## Run it

```bash
python -I -X utf8 tools/ids.py <signals dir> ids.json
python -I -X utf8 tools/metrics.py <first batch dir> metrics-1.json [<ci run id> ...]
python -I -X utf8 tools/metrics2.py <second batch dir> metrics-2.json
python -I -X utf8 tools/check_ids.py groups.json ids.json
<python with PyAV and numpy> -I -X utf8 tools/frame_diff.py <recording.mp4> [...]
python -I -X utf8 tools/build_claim.py --step 1 --groups groups.json --session <file> --contract <start reply.json> --out claim.json [--owner-code-file <file>]
```

`metrics.py` and `metrics2.py` expect the file layout and column names of the Challenge's packs (`signals/events.csv` and the like). Only `frame_diff.py` needs packages (`av`, `numpy`); the rest use the Python standard library.

The Challenge's own files (the signals, the release records, the groups, the claims and the course's replies) are not here.
