"""Whole-message log (spec R11): every request and reply, one JSON line each, from the first deploy.

Masked before writing: secrets and key shapes (guard.mask), and the values of fields that can
carry a token, a password, a code, a note or a file (replaced by length + short SHA-256, so a
line can still be matched to a known value without holding it).
"""
from __future__ import annotations

import hashlib
import json
from urllib.parse import parse_qsl, urlencode

from .guard import Log

REDACT = {"text", "query", "content_base64", "password", "access_token", "refresh_token", "code", "code_verifier",
          "client_secret", "note", "noteA"}
CUT = 8000


NO_HASH = {"password", "client_secret"}   # a short hash of a password would allow guessing it offline


def tag(value: str, key: str = "") -> str:
    if key in NO_HASH:
        return "<redacted>"
    return f"<{len(value)} chars sha256:{hashlib.sha256(value.encode()).hexdigest()[:10]}>"


def scrub(obj):
    if isinstance(obj, dict):
        return {k: (tag(v, k) if k in REDACT and isinstance(v, str) else scrub(v)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [scrub(v) for v in obj]
    return obj


def scrub_text(raw: bytes, ctype: str) -> str:
    text = raw[: CUT * 4].decode("utf-8", "replace")
    if "json" in ctype:
        try:
            return json.dumps(scrub(json.loads(text)), ensure_ascii=False)
        except ValueError:
            pass
    if "x-www-form-urlencoded" in ctype:
        pairs = [(k, tag(v, k) if k in REDACT else v) for k, v in parse_qsl(text, keep_blank_values=True)]
        return urlencode(pairs)
    if "event-stream" in ctype:
        out = []
        for line in text.splitlines():
            if line.startswith("data:"):
                try:
                    out.append("data: " + json.dumps(scrub(json.loads(line[5:].strip())), ensure_ascii=False))
                    continue
                except ValueError:
                    pass
            out.append(line)
        return "\n".join(out)
    return text


SKIP_BODY_PATHS = ("/files/",)


class LogMiddleware:
    def __init__(self, app, log: Log):
        self.app, self.log = app, log

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        path = scope.get("path", "")
        headers = {k.decode().lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        req_chunks: list[bytes] = []
        resp = {"status": None, "headers": {}, "body": bytearray()}

        async def recv():
            msg = await receive()
            if msg["type"] == "http.request" and sum(map(len, req_chunks)) < CUT * 8:
                req_chunks.append(msg.get("body", b""))
            return msg

        async def snd(msg):
            if msg["type"] == "http.response.start":
                resp["status"] = msg["status"]
                resp["headers"] = {k.decode().lower(): v.decode("latin-1") for k, v in msg.get("headers", [])}
            elif msg["type"] == "http.response.body" and len(resp["body"]) < CUT * 4:
                resp["body"] += msg.get("body", b"")
            await send(msg)

        try:
            await self.app(scope, recv, snd)
        finally:
            skip = path.startswith(SKIP_BODY_PATHS)
            q = scope.get("query_string", b"").decode("latin-1")
            entry = {
                "method": scope.get("method"), "path": path,
                "query": scrub_text(q.encode(), "x-www-form-urlencoded") if q else "",
                "client": (scope.get("client") or ["?"])[0],
                "forwarded_for": headers.get("x-forwarded-for", ""),
                "user_agent": headers.get("user-agent", ""), "origin": headers.get("origin", ""),
                "mcp_version": headers.get("mcp-protocol-version", ""), "mcp_method": headers.get("mcp-method", ""),
                "mcp_name": headers.get("mcp-name", ""), "auth": "bearer" if headers.get("authorization") else "none",
                "status": resp["status"], "location": resp["headers"].get("location", ""),
                "www_authenticate": resp["headers"].get("www-authenticate", ""),
                "request": "" if skip else scrub_text(b"".join(req_chunks), headers.get("content-type", "")),
                "response": "" if skip else scrub_text(bytes(resp["body"]), resp["headers"].get("content-type", "")),
            }
            if entry["location"]:
                base, _, qs = entry["location"].partition("?")
                entry["location"] = base + ("?" + scrub_text(qs.encode(), "x-www-form-urlencoded") if qs else "")
            self.log(entry)
