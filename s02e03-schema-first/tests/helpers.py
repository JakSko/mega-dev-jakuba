"""Test helpers: a real server on a random local port, an OAuth client, raw MCP requests.

The tests talk HTTP to the running server like an outside client would, so headers, auth,
discovery and the OAuth flow are exercised end to end, not mocked.
"""
from __future__ import annotations

import base64
import hashlib
import itertools
import json
import secrets
import socket
import threading
import time
from urllib.parse import parse_qs, urlencode, urlparse

import httpx2 as httpx
import uvicorn

MODERN = "2026-07-28"
LEGACY = "2025-11-25"
OWNER_PASSWORD = "test-owner-password-1234"
FAKE_OPENAI_KEY = "fake-openai-key-for-tests-0000"
REDIRECT = "http://127.0.0.1:9/callback"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Running:
    def __init__(self, app, port: int, log_lines: list[str]):
        self.app = app
        self.port = port
        self.base = f"http://127.0.0.1:{port}"
        self.mcp = self.base + "/mcp"
        self.log_lines = log_lines
        cfg = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", lifespan="on")
        self.server = uvicorn.Server(cfg)
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    def start(self):
        self.thread.start()
        deadline = time.time() + 15
        while time.time() < deadline:
            try:
                httpx.get(self.base + "/health", timeout=1)
                return self
            except Exception:
                time.sleep(0.1)
        raise RuntimeError("server did not start")

    def stop(self):
        self.server.should_exit = True
        self.thread.join(timeout=10)


def pkce() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    return verifier, challenge


class OAuth:
    """A public OAuth client: DCR, PKCE S256, RFC 8707 resource, owner consent, refresh."""

    def __init__(self, base: str, resource: str, password: str = OWNER_PASSWORD, client_name: str = "test client"):
        self.base, self.resource, self.password, self.client_name = base, resource, password, client_name
        self.http = httpx.Client(timeout=10, follow_redirects=False)
        self.client_id: str | None = None

    def register(self) -> dict:
        r = self.http.post(self.base + "/register", json={
            "client_name": self.client_name,
            "redirect_uris": [REDIRECT],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
            "application_type": "native",
        })
        r.raise_for_status()
        info = r.json()
        self.client_id = info["client_id"]
        return info

    def authorize(self, approve: bool = True, password: str | None = None, resource: str | None = "default",
                  scope: str | None = None) -> dict:
        """Runs /authorize and the owner consent page. Returns the redirect's query (code, state, iss or error)."""
        verifier, challenge = pkce()
        state = secrets.token_urlsafe(8)
        q = {"response_type": "code", "client_id": self.client_id, "redirect_uri": REDIRECT,
             "code_challenge": challenge, "code_challenge_method": "S256", "state": state}
        if resource == "default":
            q["resource"] = self.resource
        elif resource is not None:
            q["resource"] = resource
        if scope:
            q["scope"] = scope
        r = self.http.get(self.base + "/authorize?" + urlencode(q))
        if r.status_code not in (302, 303):
            return {"status": r.status_code, "body": r.text}
        login = r.headers["location"]
        if login.startswith(REDIRECT):
            return {k: v[0] for k, v in parse_qs(urlparse(login).query).items()}
        page = self.http.get(login)
        assert page.status_code == 200, page.text
        req = parse_qs(urlparse(login).query)["req"][0]
        form = {"req": req, "password": password if password is not None else self.password,
                "decision": "approve" if approve else "deny"}
        r = self.http.post(self.base + "/login", data=form)
        if r.status_code not in (302, 303):
            return {"status": r.status_code, "body": r.text}
        out = {k: v[0] for k, v in parse_qs(urlparse(r.headers["location"]).query).items()}
        out["_verifier"] = verifier
        out["_state"] = state
        out["_page"] = page.text
        return out

    def token(self, code: str, verifier: str, resource: str | None = "default") -> httpx.Response:
        data = {"grant_type": "authorization_code", "code": code, "redirect_uri": REDIRECT,
                "client_id": self.client_id, "code_verifier": verifier}
        if resource == "default":
            data["resource"] = self.resource
        elif resource:
            data["resource"] = resource
        return self.http.post(self.base + "/token", data=data)

    def refresh(self, refresh_token: str) -> httpx.Response:
        return self.http.post(self.base + "/token", data={
            "grant_type": "refresh_token", "refresh_token": refresh_token,
            "client_id": self.client_id, "resource": self.resource})

    def login(self) -> dict:
        """Full flow; returns the token response JSON."""
        if not self.client_id:
            self.register()
        a = self.authorize()
        r = self.token(a["code"], a["_verifier"])
        r.raise_for_status()
        return r.json()


_ids = itertools.count(1)


def parse_body(r: httpx.Response):
    ctype = r.headers.get("content-type", "")
    if "text/event-stream" in ctype:
        last = None
        for line in r.text.splitlines():
            if line.startswith("data:"):
                last = json.loads(line[5:].strip())
        return last
    if not r.content:
        return None
    try:
        return r.json()
    except ValueError:
        return r.text


def rpc(url: str, method: str, params: dict | None = None, token: str | None = None,
        version: str = MODERN, headers: dict | None = None, meta: bool = True, raw: bool = False):
    """One modern (2026-07-28) JSON-RPC request with the required headers and _meta."""
    p = dict(params or {})
    if meta:
        p["_meta"] = {"io.modelcontextprotocol/protocolVersion": version,
                      "io.modelcontextprotocol/clientCapabilities": {},
                      "io.modelcontextprotocol/clientInfo": {"name": "pytest", "version": "1"}}
    body = {"jsonrpc": "2.0", "id": next(_ids), "method": method, "params": p}
    h = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
         "MCP-Protocol-Version": version, "Mcp-Method": method}
    if "name" in p:
        h["Mcp-Name"] = p["name"]
    if token:
        h["Authorization"] = f"Bearer {token}"
    h.update(headers or {})
    h = {k: v for k, v in h.items() if v is not None}
    r = httpx.post(url, content=json.dumps(body), headers=h, timeout=30)
    return r if raw else (r.status_code, parse_body(r))


def call(url: str, token: str, tool: str, args: dict):
    status, body = rpc(url, "tools/call", {"name": tool, "arguments": args}, token=token)
    assert status == 200, (status, body)
    return body["result"]
