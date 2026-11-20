# S03E04 - show me when

Solved 2026-11-19. The board itself is its own public repo: [JakSko/s03e04-show-me-when](https://github.com/JakSko/s03e04-show-me-when) (the board, its tests, the deploy gate and the plan with product's change).

**The task, in my words:** build an on-call incident board from a plan and four ready issues, deploy it, record it in use, and send product a short report with evidence. Product reads it and decides what changes; build that, deploy it, record it again, and let the course's replay prove the new build.

**What decided it:** recording a person, not running a test. On the first build every new incident pushed the rows down, so a click aimed at one incident acked the one that slid under the pointer. A test clicks only once the page holds still and never showed it; a hand recording, clicking while incidents landed, did. Product then chose to hold the list and bring new incidents in through an "N new" bar, and the course's replay found every ack on the incident it aimed at.

**What I did:**

- Built the board test-first: Playwright tests against a fake API, red on the starter, green on each build, three time zones, and the click race at fixed coordinates.
- Deployed through a gate that stamps the commit into the page, runs the whole suite on the exact folder it ships and refuses a red, uncommitted or changed build, then reads the sha back from the live page.
- Sent product four options in a decision record, each with its cost and its way back, and built only what product chose, in one commit.
- Read every frame of each screen recording before it went public, and published only trimmed, masked copies.

These scripts built the evidence and the requests:

| File | What it does |
|---|---|
| `scripts/build_report.mjs` | builds a report from section text, the saved console log, git and the repo URL; turns `{{file:line}}` into links at the commit after checking the line exists; reads the receipt and the expected and acked incident from the log, never typed; checks the size and the evidence block |
| `scripts/build_claim.mjs` | builds a claim body from the report and the start reply, and prints it with the session and receipts masked |
| `scripts/video_timeline.py` | lists every moment a screen recording changes and saves those frames (PyAV + numpy) |
| `scripts/trim_mask.py` | cuts a recording to a time range, paints black boxes over private areas, drops the sound and encodes H.264 for the web |
| `scripts/run_suite.sh` | runs the suite and saves one report per commit |
| `scripts/shot_board.mjs` | takes a screenshot of the local board with the fake API, one row acked and one failed ack |

They expect the Challenge's working folder (the start reply, console logs, recordings), which stays private.
