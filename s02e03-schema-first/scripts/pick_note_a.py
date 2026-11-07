"""Read the newest note written by a client other than ours (the course) and extract its code (plan step 22).

The note's text is not printed: it is saved whole to --out-dir/noteA-note.json, and only its shape is
printed (letters -> a/A, digits -> 9), so no model reads the text itself. The code is taken by pattern:
the last run of 6+ letters/digits that sits after a ':' or '=' or on its own, saved to noteA.txt.

  python scripts/pick_note_a.py --url https://<host> --out-dir <private dir> --link-file <path> \
      --own-client <client_id> [--own-client ...]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
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

CODE = re.compile(r"(?:^|[:=\s])([A-Za-z0-9_-]{6,})\s*$")


def shape(text: str) -> str:
    return re.sub(r"[0-9]", "9", re.sub(r"[A-Z]", "A", re.sub(r"[a-z]", "a", text)))


async def notes(base: str, link_file: Path) -> tuple[list[dict], str]:
    redirect, _, callback_handler = e2e.consent_browser()
    me: dict = {}

    async def redirect_handler(authorize_url: str) -> None:
        link_file.write_text(authorize_url + "\n", encoding="utf-8")
        print(f"SIGN-IN LINK WRITTEN TO {link_file} - open it in your browser and approve", flush=True)

    storage = e2e.MemStorage()
    auth = OAuthClientProvider(
        server_url=base + "/mcp",
        client_metadata=OAuthClientMetadata(client_name="noteA reader (Jakub)", redirect_uris=[redirect],
                                            grant_types=["authorization_code", "refresh_token"],
                                            response_types=["code"], token_endpoint_auth_method="none"),
        storage=storage, redirect_handler=redirect_handler, callback_handler=callback_handler)
    http = httpx.AsyncClient(auth=auth, timeout=httpx.Timeout(60.0, read=120.0))
    async with Client(streamable_http_client(base + "/mcp", http_client=http), mode="auto") as c:
        r = await c.call_tool("memo_search", {"query": ""})
    me["client_id"] = storage.client.client_id if storage.client else ""
    return (r.structured_content or {}).get("notes", []), me["client_id"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--link-file", required=True)
    ap.add_argument("--own-client", action="append", default=[])
    ap.add_argument("--since", default="", help="only notes created at or after this UTC ISO time")
    a = ap.parse_args()
    out = Path(a.out_dir)
    all_notes, mine = asyncio.run(notes(a.url.rstrip("/"), Path(a.link_file)))
    own = set(a.own_client) | {mine}
    print(f"{len(all_notes)} notes; writers: " + ", ".join(sorted({n['client_id'][:8] for n in all_notes})), flush=True)
    for n in all_notes[:8]:
        print(f"  {n['created_at']}  client {n['client_id'][:8]}  {'own ' if n['client_id'] in own else 'OTHER'}  "
              f"len {len(n['text'])}  shape {shape(n['text'])[:80]!r}", flush=True)
    other = [n for n in all_notes if n["client_id"] not in own and n["created_at"] >= a.since]   # newest first
    if not other:
        print("RESULT: FAIL - no note from another client")
        return 1
    newest = other[0]
    (out / "noteA-note.json").write_text(json.dumps(newest, indent=2) + "\n", encoding="utf-8")
    m = CODE.search(newest["text"].strip())
    if not m:
        print("RESULT: FAIL - no code pattern in the newest course note; see noteA-note.json")
        return 1
    (out / "noteA.txt").write_text(m.group(1), encoding="utf-8")
    print(f"newest course note {newest['id']} at {newest['created_at']} from client {newest['client_id'][:8]}; "
          f"code shape {shape(m.group(1))!r} ({len(m.group(1))} chars) saved to noteA.txt")
    print("RESULT: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
