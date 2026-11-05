# S01E01 - somebody slow

Solved 2026-11-02.

**The task, in my words:** a message waits on the Challenge page. Send it to the course's API, then send a shorter version that fits the API's limit and keeps one paragraph exactly as written, then answer one question on a form.

**What decided it:** the API's real shape was in a schema behind the page (`additionalProperties: false`, a 700-character limit). Reading it beat guessing a field name. Every body was then built by script from whole paragraphs of the page copy, never retyped, and the protected paragraph was checked by SHA-256 before and after JSON encoding.

| File | What it does |
|---|---|
| `build_body.py` | builds a body from chosen whole paragraphs; asserts the protected paragraph is kept and unchanged after a JSON round trip, and the length limit |
| `tools/verify.py` | checks the page copy paragraph by paragraph against saved SHA-256 values |
| `tools/post.sh`, `tools/log_entry.py` | send a body with curl and append the exact request and reply to the log |
| `tools/send_from_browser.js` | the same send from a signed-in browser tab |

The message itself and the logs are course material and are not here.

**Kept for later:** read the contract before the first send; build bodies by script from the source.
