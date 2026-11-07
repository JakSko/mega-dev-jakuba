"""A9 plan page, A13 no secret in any response or log line, R11 whole-message log."""
import httpx2 as httpx

from helpers import FAKE_OPENAI_KEY, OWNER_PASSWORD, call


def test_a9_plan_page(server):
    r = httpx.get(server.base + "/plan")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/html")
    page = r.text.lower()
    for needle in ("memo_write", "memo_search", "upload", "transcribe",   # what the tools do
                   "sign-in", "oauth", "consent",                         # how sign-in works
                   "data", "keep", "delete",                              # what data it keeps
                   "25 mb", "daily", "2027-02-26"):                       # limits and whisper-1 end date
        assert needle in page, needle


def test_a13_no_secret_in_log_or_responses(server, owner):
    t = owner["access_token"]
    secret_note = "NOTE-CODE-7f3a9c1e5b"
    call(server.mcp, t, "memo_write", {"text": secret_note})
    call(server.mcp, t, "memo_search", {"query": "NOTE-CODE"})
    log = "\n".join(server.log_lines)
    assert log, "the whole-message log is empty"
    assert '"path": "/mcp"' in log or '"path":"/mcp"' in log
    for s in (OWNER_PASSWORD, FAKE_OPENAI_KEY, t, owner["refresh_token"], secret_note):
        assert s not in log, s[:12]
    for path in ("/plan", "/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server"):
        body = httpx.get(server.base + path).text
        assert OWNER_PASSWORD not in body and FAKE_OPENAI_KEY not in body
