"""Upload one local file through our MCP server's `upload` tool, with the official SDK client.

For files too big to pass through a chat tool call (base64 of 8 MB is 11 MB of arguments).
The owner approves on our consent page in his own browser; the redirect lands on a local
127.0.0.1 callback. No password passes through the script. The sign-in link is written to
--link-file (not printed), so it can be opened from there.

  python scripts/upload_file.py --url https://<host> --file <path> --name <filename> \
      --mime text/plain --link-file <path> --out <result.json>

Then it opens the returned link WITHOUT a token and compares the bytes.
Output: the upload url, sizes and sha256, and RESULT: ok or RESULT: FAIL.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "scripts"), str(ROOT / "src"), str(ROOT / "tests")]

import httpx2 as httpx  # noqa: E402
from mcp.client.auth import OAuthClientProvider  # noqa: E402
from mcp.client.client import Client  # noqa: E402
from mcp.client.streamable_http import streamable_http_client  # noqa: E402
from mcp.shared.auth import OAuthClientMetadata  # noqa: E402

import e2e_sdk_client as e2e  # noqa: E402


async def run(base: str, data: bytes, name: str, mime: str | None, link_file: Path, consent=None) -> dict:
    if consent is None:   # the owner in his browser; tests pass e2e.consent_bot instead
        redirect, _, callback_handler = e2e.consent_browser()

        async def redirect_handler(authorize_url: str) -> None:
            link_file.write_text(authorize_url + "\n", encoding="utf-8")
            print(f"SIGN-IN LINK WRITTEN TO {link_file} - open it in your browser and approve", flush=True)
    else:
        redirect, redirect_handler, callback_handler = consent

    auth = OAuthClientProvider(
        server_url=base + "/mcp",
        client_metadata=OAuthClientMetadata(client_name="upload script (Jakub)", redirect_uris=[redirect],
                                            grant_types=["authorization_code", "refresh_token"],
                                            response_types=["code"], token_endpoint_auth_method="none"),
        storage=e2e.MemStorage(), redirect_handler=redirect_handler, callback_handler=callback_handler)
    http = httpx.AsyncClient(auth=auth, timeout=httpx.Timeout(60.0, read=300.0, write=300.0))
    async with Client(streamable_http_client(base + "/mcp", http_client=http), mode="auto") as c:
        args = {"filename": name, "content_base64": base64.b64encode(data).decode()}
        if mime:
            args["mime_type"] = mime
        r = await c.call_tool("upload", args)
    url = (r.structured_content or {}).get("url", "")
    out = {"is_error": bool(r.is_error), "url": url, "protocol": "auto",
           "error_text": " ".join(getattr(x, "text", "") for x in r.content)[:300] if r.is_error else ""}
    if url:
        async with httpx.AsyncClient(timeout=120) as anon:   # no token: a stranger's view
            g = await anon.get(url)
        out.update(get_status=g.status_code, get_type=g.headers.get("content-type"), get_bytes=len(g.content),
                   bytes_match=g.content == data, get_sha256=hashlib.sha256(g.content).hexdigest())
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--file", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--mime")
    ap.add_argument("--link-file", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    data = Path(a.file).read_bytes()
    print(f"file {a.file}: {len(data)} B, sha256 {hashlib.sha256(data).hexdigest()}", flush=True)
    res = asyncio.run(run(a.url.rstrip("/"), data, a.name, a.mime, Path(a.link_file)))
    res.update(sent_bytes=len(data), sent_sha256=hashlib.sha256(data).hexdigest())
    Path(a.out).write_text(json.dumps(res, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(res, indent=2), flush=True)
    good = (not res["is_error"] and res.get("get_status") == 200 and res.get("bytes_match") is True and not e2e.failures)
    print("RESULT: ok" if good else "RESULT: FAIL", flush=True)
    return 0 if good else 1


if __name__ == "__main__":
    sys.exit(main())
