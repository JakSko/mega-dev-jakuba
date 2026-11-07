"""End-to-end check with the OFFICIAL SDK client and the SDK's own OAuth client (plan steps 9 and 13).

The SDK client does its own discovery (401 -> protected resource metadata -> AS metadata),
Dynamic Client Registration, PKCE, the RFC 8707 resource parameter and the RFC 9207 `iss`
check, then lists and calls every tool; it validates structured results against each tool's
outputSchema itself (the second validator). Runs in `auto` mode (2026-07-28) and in `legacy`
mode (2025-11-25 initialize handshake). Then raw HTTP checks with the same token, each line
tagged with the spec criterion it proves (A1, A3, A4, A5, A6, A7, A8).

  python scripts/e2e_sdk_client.py --local
      starts the server here with a fake transcriber; a bot plays the owner on the consent page
  python scripts/e2e_sdk_client.py --url https://<host> --audio-file <wav/mp3> [--paid-transcribe]
      the owner approves in his own browser: the script prints the link and waits for the
      redirect on a local 127.0.0.1 callback. No password passes through the script.
      --paid-transcribe makes ONE real transcription call (auto mode only).

Output: one line per check, ending with RESULT: ok or RESULT: FAIL.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "src"), str(ROOT / "tests")]

import httpx2 as httpx  # noqa: E402
from jsonschema import Draft202012Validator  # noqa: E402
from mcp.client.auth import OAuthClientProvider  # noqa: E402
from mcp.client.client import Client  # noqa: E402
from mcp.client.streamable_http import streamable_http_client  # noqa: E402
from mcp.shared.auth import AuthorizationCodeResult, OAuthClientMetadata  # noqa: E402

from helpers import LEGACY, MODERN, parse_body, rpc  # noqa: E402
from mega_mcp import contract  # noqa: E402

WAV = (b"RIFF" + (36).to_bytes(4, "little") + b"WAVEfmt " + b"\x10\x00\x00\x00\x01\x00\x01\x00"
       + b"\x40\x1f\x00\x00\x80\x3e\x00\x00\x02\x00\x10\x00" + b"data\x00\x00\x00\x00")
failures: list[str] = []


def ok(cond: bool, what: str) -> None:
    print(("ok   " if cond else "FAIL ") + what, flush=True)
    if not cond:
        failures.append(what)


class MemStorage:
    def __init__(self):
        self.tokens = None
        self.client = None

    async def get_tokens(self):
        return self.tokens

    async def set_tokens(self, tokens):
        self.tokens = tokens

    async def get_client_info(self):
        return self.client

    async def set_client_info(self, info):
        self.client = info


def consent_bot(password: str, redirect: str):
    """--local only: plays the owner on our consent page."""
    box: dict = {}

    async def redirect_handler(authorize_url: str) -> None:
        async with httpx.AsyncClient(follow_redirects=False, timeout=20) as h:
            r = await h.get(authorize_url)
            login = r.headers["location"]
            page = await h.get(login)
            ok(page.status_code == 200 and "Approve access" in page.text, "[A2] consent page shown")
            req = parse_qs(urlparse(login).query)["req"][0]
            r = await h.post(urlparse(login)._replace(query="").geturl(),
                             data={"req": req, "password": password, "decision": "approve"})
            box.update({k: v[0] for k, v in parse_qs(urlparse(r.headers["location"]).query).items()})

    async def callback_handler() -> AuthorizationCodeResult:
        return AuthorizationCodeResult(code=box["code"], state=box.get("state"), iss=box.get("iss"))

    return redirect, redirect_handler, callback_handler


def consent_browser():
    """The owner approves in his own browser; the redirect lands on a local callback."""
    box: dict = {}
    got = threading.Event()

    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            q = {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}
            if urlparse(self.path).path == "/callback":
                box.update(q)
                got.set()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write("Done. You can close this tab and go back to the chat.".encode())

        def log_message(self, *a):
            pass

    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    redirect = f"http://127.0.0.1:{srv.server_address[1]}/callback"

    async def redirect_handler(authorize_url: str) -> None:
        print("OPEN THIS LINK IN YOUR BROWSER AND APPROVE:", authorize_url, flush=True)

    async def callback_handler() -> AuthorizationCodeResult:
        for _ in range(900):
            if got.is_set():
                break
            await asyncio.sleep(1)
        ok(got.is_set() and "code" in box, "[A2] owner approved in the browser; code received on the callback")
        ok(bool(box.get("iss")), "[A2] authorization response carries iss")
        return AuthorizationCodeResult(code=box.get("code", ""), state=box.get("state"), iss=box.get("iss"))

    return redirect, redirect_handler, callback_handler


async def sdk_part(base, consent, audio: bytes, audio_name: str, real_transcribe: bool, fake: bool) -> MemStorage:
    mcp_url = base + "/mcp"
    redirect, redirect_handler, callback_handler = consent
    storage = MemStorage()
    auth = OAuthClientProvider(
        server_url=mcp_url,
        client_metadata=OAuthClientMetadata(client_name="SDK e2e check (Jakub)", redirect_uris=[redirect],
                                            grant_types=["authorization_code", "refresh_token"],
                                            response_types=["code"], token_endpoint_auth_method="none"),
        storage=storage, redirect_handler=redirect_handler, callback_handler=callback_handler)

    for mode in ("auto", "legacy"):
        http = httpx.AsyncClient(auth=auth, timeout=httpx.Timeout(60.0, read=180.0))
        async with Client(streamable_http_client(mcp_url, http_client=http), mode=mode) as c:
            ok(c.protocol_version == (MODERN if mode == "auto" else LEGACY), f"[A4] [{mode}] negotiated {c.protocol_version}")
            tools = await c.list_tools()
            names = [t.name for t in tools.tools]
            ok(names == contract.TOOL_NAMES, f"[A5] [{mode}] tools/list: {names}")
            ok(all(t.output_schema for t in tools.tools), f"[A5] [{mode}] every tool declares an outputSchema")

            w = await c.call_tool("memo_write", {"text": f"e2e note from {mode} mode"})
            ok(not w.is_error and bool((w.structured_content or {}).get("id")), f"[A6] [{mode}] memo_write -> id")
            s = await c.call_tool("memo_search", {"query": f"e2e note from {mode}"})
            notes = (s.structured_content or {}).get("notes", [])
            ok(not s.is_error and bool(notes) and notes[0]["text"] == f"e2e note from {mode} mode",
               f"[A6] [{mode}] memo_search finds it, newest first (SDK validated the structured result)")

            u = await c.call_tool("upload", {"filename": audio_name, "content_base64": base64.b64encode(audio).decode()})
            url = (u.structured_content or {}).get("url", "")
            ok(not u.is_error and url.startswith(base + "/files/"),
               f"[A7] [{mode}] upload -> link on our host ({url.rsplit('/', 1)[-1] if url else '-'})")
            async with httpx.AsyncClient(timeout=20) as anon:
                g = await anon.get(url)
            ok(g.status_code == 200 and g.content == audio,
               f"[A7] [{mode}] link opens without a token, exact bytes ({len(audio)} B, {g.headers.get('content-type')})")

            if mode == "auto" and (fake or real_transcribe):
                t = await c.call_tool("transcribe", {"url": url})
                segs = (t.structured_content or {}).get("segments", [])
                starts = [x["start"] for x in segs]
                ok(not t.is_error and bool(segs) and starts == sorted(starts),
                   f"[A8] transcribe own upload -> {len(segs)} segments, starts {starts[:4]}, "
                   f"text: {' '.join(x['text'] for x in segs)[:120]!r}")
            if mode == "auto":
                bad = await c.call_tool("transcribe", {"url": "http://169.254.169.254/latest/meta-data"})
                ok(bad.is_error, "[A8] metadata address refused")
                bad = await c.call_tool("transcribe", {"url": "http://127.0.0.1:1/a.mp3"})
                ok(bad.is_error, "[A8] loopback address refused")
    return storage


def raw_part(base: str, token: str) -> None:
    mcp_url = base + "/mcp"
    # A1
    r = rpc(mcp_url, "tools/list", raw=True)
    ok(r.status_code == 401 and f'resource_metadata="{base}/.well-known/oauth-protected-resource/mcp"'
       in r.headers.get("www-authenticate", ""), "[A1] no token -> 401 naming resource_metadata")
    for path in ("/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"):
        m = httpx.get(base + path, timeout=20).json()
        ok(m.get("resource") == mcp_url and m.get("authorization_servers") == [base]
           and m.get("resource_documentation") == base + "/plan", f"[A1] PRM at {path}: resource, AS, resource_documentation")
    a = httpx.get(base + "/.well-known/oauth-authorization-server", timeout=20).json()
    ok(a.get("issuer") == base and a.get("code_challenge_methods_supported") == ["S256"]
       and a.get("authorization_response_iss_parameter_supported") is True and bool(a.get("registration_endpoint")),
       "[A2] AS metadata: issuer, S256, iss support, registration endpoint")
    # A3
    ok(rpc(mcp_url, "server/discover", raw=True).status_code == 401, "[A3] server/discover without a token -> 401")
    ok(rpc(mcp_url, "tools/list", token="mat_" + "x" * 43, raw=True).status_code == 401, "[A3] made-up token -> 401")
    h = {"Authorization": f"Bearer {token}", "MCP-Protocol-Version": MODERN, "Accept": "text/event-stream"}
    ok(httpx.get(mcp_url, headers=h, timeout=20).status_code == 405, "[A3] GET /mcp -> 405")
    ok(httpx.delete(mcp_url, headers=h, timeout=20).status_code == 405, "[A3] DELETE /mcp -> 405")
    ok(httpx.post(mcp_url + "?access_token=" + token, json={}, timeout=20).status_code == 401,
       "[A3] token in the query string -> 401")
    # A4
    s, b = rpc(mcp_url, "server/discover", token=token)
    ok(s == 200 and MODERN in b["result"]["supportedVersions"], f"[A4] server/discover -> {b['result']['supportedVersions']}")
    s, b = rpc(mcp_url, "tools/list", token=token, headers={"Mcp-Method": "tools/call"})
    ok(s == 400 and b["error"]["code"] == -32020, "[A4] header mismatch -> 400 -32020")
    s, b = rpc(mcp_url, "tools/list", token=token, version="1900-01-01")
    ok(s == 400 and b["error"]["code"] == -32022, f"[A4] unknown version -> 400 -32022, supported {b['error'].get('data', {}).get('supported')}")
    s, b = rpc(mcp_url, "tools/list", token=token, meta=False)
    ok(s == 400 and b["error"]["code"] == -32602, "[A4] missing _meta -> 400 -32602")
    s, b = rpc(mcp_url, "files/delete_all", token=token)
    ok(s == 404 and b["error"]["code"] == -32601, "[A4] unknown method -> 404 -32601")
    s, b = rpc(mcp_url, "tools/call", {"name": "delete_everything", "arguments": {}}, token=token)
    ok(b.get("result", {}).get("isError") is True and "Unknown tool" in json.dumps(b), "[A4] unknown tool -> isError 'Unknown tool' (SDK)")
    r = httpx.post(mcp_url, json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": LEGACY, "capabilities": {}, "clientInfo": {"name": "x", "version": "1"}}},
        headers={"Accept": "application/json, text/event-stream"}, timeout=20)
    ok(r.status_code == 401, "[A4] legacy initialize without a token -> 401")
    # A5
    _, b1 = rpc(mcp_url, "tools/list", token=token)
    _, b2 = rpc(mcp_url, "tools/list", token=token)
    ok(b1["result"]["tools"] == b2["result"]["tools"] and "ttlMs" in b1["result"] and "cacheScope" in b1["result"],
       "[A5] tools/list stable across two calls, with ttlMs and cacheScope")
    published = {t["name"]: t["outputSchema"] for t in b1["result"]["tools"]}
    # A6 with the second validator (jsonschema against published schema AND contract)
    s, b = rpc(mcp_url, "tools/call", {"name": "memo_search", "arguments": {"query": ""}}, token=token)
    sc = b["result"]["structuredContent"]
    Draft202012Validator(published["memo_search"]).validate(sc)
    Draft202012Validator(contract.OUTPUT["memo_search"]).validate(sc)
    n = sc["notes"][0] if sc["notes"] else {}
    ok(bool(n) and n["created_at"].endswith("Z") and bool(n["client_id"]),
       f"[A6] empty query lists all ({len(sc['notes'])}), newest has created_at and client_id; valid vs published+contract")
    s, b = rpc(mcp_url, "tools/call", {"name": "memo_search", "arguments": {"query": "no-such-word-xyz-123"}}, token=token)
    ok(b["result"]["structuredContent"] == {"notes": []}, "[A6] no match -> notes: []")
    # A7
    for name in ("../../etc/passwd", "C:\\Windows\\win.ini"):
        s, b = rpc(mcp_url, "tools/call", {"name": "upload", "arguments": {
            "filename": name, "content_base64": base64.b64encode(b"x").decode()}}, token=token)
        tail = b["result"]["structuredContent"]["url"].rsplit("/", 1)[1]
        ok(".." not in tail and "\\" not in tail, f"[A7] filename {name!r} -> stored as {tail}")
    ok(httpx.get(base + "/files/..%2F..%2Fsecret.txt", timeout=20).status_code == 404, "[A7] path trick on /files -> 404")
    s, b = rpc(mcp_url, "tools/call", {"name": "upload", "arguments": {
        "filename": "x.html", "content_base64": base64.b64encode(b"<script>alert(1)</script>").decode(),
        "mime_type": "text/html"}}, token=token)
    ct = httpx.get(b["result"]["structuredContent"]["url"], timeout=20).headers.get("content-type", "")
    ok("html" not in ct, f"[A7] HTML upload served as {ct}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--local", action="store_true")
    ap.add_argument("--url")
    ap.add_argument("--audio-file")
    ap.add_argument("--paid-transcribe", action="store_true")
    a = ap.parse_args()
    audio, audio_name = (Path(a.audio_file).read_bytes(), "check-audio") if a.audio_file else (WAV, "voice")
    if a.local:
        from conftest import FakeOpenAI
        from helpers import Running, free_port
        from mega_mcp.app import build_app
        from mega_mcp.config import Config
        password = "local-e2e-owner-password"
        port = free_port()
        cfg = Config(public_url=f"http://127.0.0.1:{port}", data_dir=Path(tempfile.mkdtemp()), owner_password=password)
        server = Running(build_app(cfg, transcriber=FakeOpenAI(), log_out=lambda line: None), port, []).start()
        try:
            st = asyncio.run(sdk_part(server.base, consent_bot(password, "http://127.0.0.1:9/callback"),
                                      audio, audio_name, False, True))
            raw_part(server.base, st.tokens.access_token)
        finally:
            server.stop()
    else:
        if not a.url:
            print("need --url or --local")
            return 2
        base = a.url.rstrip("/")
        st = asyncio.run(sdk_part(base, consent_browser(), audio, audio_name, a.paid_transcribe, False))
        if st.tokens:
            raw_part(base, st.tokens.access_token)
    print("RESULT: " + ("ok" if not failures else f"FAIL ({len(failures)})"))
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
