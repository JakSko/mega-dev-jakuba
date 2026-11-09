# S02E04 - two places

Two workers in two places, one main agent that only joins their results. Built for the MEGA.dev Challenge S02E04 "two places" (2026-11-09, solved on the first claim, no try refused).

## The task, in my words

The course handed out two jobs, each with its own MCP link and its own skill. One job had to run on my machine and the other somewhere else, each in a worker of its own. The main agent was not allowed to do either job: it had to take both results, join them and send one answer. The join asked for one note from job 2 that matches the moment in job 1's record, and the two jobs wrote their times on different clocks.

## How it ran

| Part | Where | What it did |
|---|---|---|
| W1, job 1 | a separate Claude Code session on my laptop, in its own folder with only its own link | looked up one record, read only the allowed fields, redacted a name, handed it in |
| W2, job 2 | a Claude Code cloud session on a private repo (deleted after the claim) | transcribed a voice memo through the job's tool, wrote one note per finding, handed them in |
| Main agent | this machine | wrote the briefs and the tools, never called a job tool, checked each worker from its trace, converted the clocks and sent the joined answer |

Each worker stopped before its submit and showed the exact text; it could submit only with the sha256 of the text I approved. The cloud worker brought its status, trace and result home as commits on a branch of the private repo. The join: a record time of 22:50 US Eastern on 31 October is daylight time (UTC-4), so 02:50 UTC and 03:50 central European time; a note with the same digits in the other clock would have been the wrong answer.

## What made it hard

- The job link is the key. It had to reach only its own worker: a file in W1's folder, an environment variable for W2, never a prompt, a commit or a log.
- The cloud harness re-signs HTTPS through a proxy. The MCP client ignored its certificate bundle and failed with a bare exception group until the client built its own TLS context from `SSL_CERT_FILE` and printed the real cause.
- Both job servers serve the skill as a resource but do not implement `skills/get`, so there is no manifest to verify against. The served bytes were checked against the downloaded copy instead.
- The job servers return results as JSON inside a text block, not as `structuredContent`, so the checks read both shapes.

## What I built

| File | What it does |
|---|---|
| [`mcp_call.py`](mcp_call.py) | One MCP client for every worker (official Python SDK). The link comes only from a file or an environment variable and is masked in every output. Rules in code: a submit needs `--approved-sha` equal to the sha256 of its arguments, a second submit after an accepted one is refused, and for job 1 a read that asks for more than the allowed fields is refused and any `crew` value in a reply is withheld. Loads a skill with `skills/get` and `resources/read` and checks size, digest and frontmatter, plus the bytes against a local copy. Trusts the CA bundle from the environment and unwraps errors to their cause. Every request and reply goes to a trace file. |
| [`check_result.py`](check_result.py) | Objective checks on a worker's trace, before and after the submit: scope, every result page read, only the allowed fields, no crew value, the submitted text equal to the redaction, one offset per note, no duplicates, a receipt. |
| [`build_claim_body.py`](build_claim_body.py) | The final answer built from both result files, so receipts cannot be swapped or retyped. |
| [`prep_links.py`](prep_links.py) | Puts each job link where only its worker reads it, and removes it afterwards; prints no link. |
| [`scan_main.py`](scan_main.py) | Reads the main session's transcript and lists every tool call that touched a job link or fetched the job's media, to show the main agent did no job. |
| [`fake_job_server.py`](fake_job_server.py) | Two fake job servers with made-up data, step tokens and the Skills extension, for the tests. |
| [`briefs/`](briefs/) | The two worker briefs as used, with course-specific details replaced by placeholders: turns, a status file, stop rules, the way home. |

## How it was checked

- 14 tests (`pytest`): the skill check (digest and copy mismatch), the crew rule before any call and on a leaking server, the submit gate and no second submit, link masking, both jobs end to end against the fake servers, the claim body, a real Streamable HTTP run as a subprocess, and HTTPS through a private CA that works only with `SSL_CERT_FILE`.
- On the real jobs: both submits accepted with receipts, both `check_result.py` runs `RESULT: ok`, the main session scan found no job call, and the course accepted the joined answer on the first claim.

## Run it

```
pip install -r requirements.txt
python -m pytest -q tests
python mcp_call.py --help
```

A worker call looks like `python mcp_call.py --worker W1 --job job-1 --link-file .job-link --trace out/trace-job-1.jsonl --policy job-1 call search '{"scope": "..."}'`.

## Not included

The course's task text, skills, links, receipts, transcripts and logs stay private.
