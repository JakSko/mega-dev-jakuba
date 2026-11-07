# S02E03 - schema first

A remote MCP server of my own, built for the MEGA.dev Challenge S02E03 "schema first" (2026-11-06/07, solved; one check refused and fixed). Four tools behind my own OAuth sign-in: notes, file links and transcription. Any agent I approve can reach it, and it stays up when my laptop is closed.

## The task, in my words

Build a remote MCP server on a public host with four tools whose names and result shapes are fixed, and let only the clients I approve use it. Then hand it to the course: the course connects as a stranger it has never met, finds the sign-in by itself, asks me for consent in my browser, and calls every tool against its declared schemas. Later it comes back to check the server is still up.

## What made it hard

- The MCP spec moves. The current revision (2026-07-28: stateless, `server/discover`) is newer than what a model remembers, so the server is built from the live spec, with the previous revision (2025-11-25) kept for older clients.
- A stranger has to sign in with no shared secret: protected resource metadata, authorization server metadata, dynamic client registration, PKCE and an audience-bound token, plus a consent page only the owner can approve.
- Tool results go into the calling agent's context. The course measured the whole result: 1,024 bytes for a short clip. The SDK's default copy of the JSON into the text block was enough to break it.
- Errors are read by a model. "unknown audio format" is not enough; the error has to name the url and say what to send instead.
- `transcribe` fetches any url it is given, so it is an SSRF risk; `upload` takes a file name, so it is a path risk.

## What I built

| Part | What it does |
|---|---|
| [`src/mega_mcp/contract.py`](src/mega_mcp/contract.py) | The schemas, written first from the brief. Tests check that what the server publishes keeps every name, type and `required`, and that real results validate against both. |
| [`src/mega_mcp/app.py`](src/mega_mcp/app.py) | The four tools on the official Python SDK: `memo_write`, `memo_search`, `upload` (public link on this host, HTML never served as HTML), `transcribe` (whisper-1, times rounded, one-line text summary so the whole result stays small, every error names the url). |
| [`src/mega_mcp/oauth.py`](src/mega_mcp/oauth.py) | My own OAuth 2.1 authorization server on the same host: dynamic registration, PKCE S256, `resource` binding, `iss` in the response, refresh rotation, a consent page that shows the client name, redirect host and scope and needs the owner password. |
| [`src/mega_mcp/netguard.py`](src/mega_mcp/netguard.py) | SSRF-safe fetch: http(s) only, no credentials in urls, every resolved address and every redirect checked against private, loopback, link-local and metadata ranges; size and time limits. |
| [`src/mega_mcp/budget.py`](src/mega_mcp/budget.py), [`guard.py`](src/mega_mcp/guard.py), [`logmw.py`](src/mega_mcp/logmw.py) | Daily cap on paid transcription calls, checked before each call; secret masking; a request log that stores note text and queries only as length and hash. |
| [`src/mega_mcp/plan_page.py`](src/mega_mcp/plan_page.py) | The plan page named as `resource_documentation`: what the tools do, how sign-in works, what data is kept, the limits. |
| [`scripts/upload_file.py`](scripts/upload_file.py) | Uploads a big file (8.5 MB in the Challenge) through the `upload` tool with the SDK client, beside the model: base64 of that file would be 11 MB of chat tool arguments. Then opens the link without a token and compares the bytes. |
| [`scripts/pick_note_a.py`](scripts/pick_note_a.py) | Reads the newest note written by another client and takes a code from it by pattern; prints only the note's shape, never its text, so no model reads it. |
| [`scripts/e2e_sdk_client.py`](scripts/e2e_sdk_client.py), [`secret_scan.py`](scripts/secret_scan.py) | End-to-end check with the official SDK client in both revisions (discovery, registration, consent, every tool, raw refusals); a secret scan over the host log, the repo and captured output that prints counts only. |

## How it was checked

- 60 tests (`pytest`): contract against the published schemas, OAuth refusals (no token, expired, reused refresh, wrong audience, made-up token), protocol headers and versions, path tricks, SSRF ranges, the daily cap, the 1,024-byte result budget, errors that name the url, a 9 MB upload through the script.
- Hosted end-to-end run with the SDK client: 43 checks, one real transcription.
- The upload link and the plan page checked like a stranger (logged out, exact bytes, markers).
- Claude Code connected through a project `.mcp.json`, signed in through the same consent page, and called each tool once.
- The course's own check: refused once (result 1,391 bytes over the 1,024 limit; an error that did not name the url), fixed with failing tests first, then passed; the course came back about 15 hours later and found the server still up.

## Run it

```bash
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt
.venv/Scripts/python -m pytest -q
PUBLIC_URL=http://127.0.0.1:8000 OWNER_PASSWORD=<12+ chars> OPENAI_API_KEY=<key> DATA_DIR=./var python main.py
```

On a host, set the same variables and mount a volume at `DATA_DIR` (notes, files and OAuth clients live in SQLite there). `scripts/local_consent_demo.py` shows the consent page locally.
