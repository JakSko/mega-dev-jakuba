"""scan_main.py - did the main session touch a job link, a job tool or the clip? (spec A3)

  python scan_main.py --transcript MAIN_SESSION.jsonl --reply REPLY_JSON [--out FILE]

Lists every tool call of the main session whose input names a job link (its key part), the
`/mcp/job/` path, the clip, or runs mcp_call.py against a link. Allowed: the Write that saved
the start-challenge reply, prep_links.py, and test runs against the fake server. Prints no link.
Ends with RESULT: ok (only allowed hits) or RESULT: REVIEW (hits a human must look at).
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


def keys_from_reply(reply: Path) -> dict[str, str]:
    d = json.loads(reply.read_text(encoding="utf-8"))
    out = {f"{j} link": v["url"].rstrip("/").rsplit("/", 1)[-1] for j, v in d["jobs"].items()}
    clip = d["jobs"].get("job-2", {}).get("clip")
    if clip:
        out["clip"] = clip.rsplit("/", 1)[-1]
    return out


def tool_uses(transcript: Path):
    for n, line in enumerate(transcript.read_text(encoding="utf-8").splitlines(), 1):
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        msg = rec.get("message") or {}
        if msg.get("role") != "assistant":
            continue
        for part in msg.get("content") or []:
            if isinstance(part, dict) and part.get("type") == "tool_use":
                yield n, rec.get("timestamp"), part.get("name"), json.dumps(part.get("input"), ensure_ascii=False)


FETCH = re.compile(r"\b(curl|wget|Invoke-WebRequest|iwr|urlopen|httpx|requests\.get)\b|mcp_call\.py[^\n]*--link-(file|env)")


def allowed(name: str, text: str) -> bool:
    """Writing or editing a file that names a link is not a call; running a fetch is."""
    if name in ("Write", "Edit", "Read", "Grep", "Glob"):
        return True
    if name in ("Bash", "PowerShell"):
        if "pytest" in text or "prep_links.py" in text or "scan_main.py" in text:
            return True
        return not FETCH.search(text)
    return False  # WebFetch, browser, MCP tools: always a human look


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--transcript", required=True)
    p.add_argument("--reply", required=True)
    p.add_argument("--out")
    ns = p.parse_args(argv)
    keys = keys_from_reply(Path(ns.reply))
    rows, review = [], 0
    for n, ts, name, text in tool_uses(Path(ns.transcript)):
        hits = [label for label, k in keys.items() if k and k in text]
        if "/mcp/job/" in text:
            hits.append("/mcp/job/ path")
        if re.search(r"mcp_call\.py[^\n]*--link-(file|env)", text):
            hits.append("mcp_call.py with a link")
        if not hits:
            continue
        ok = allowed(name, text)
        review += not ok
        rows.append(f"line {n} {ts} {name}: {', '.join(sorted(set(hits)))} -> {'allowed' if ok else 'REVIEW'}")
    rows.append(f"tool calls with a hit: {len(rows)}, to review: {review}")
    rows.append("RESULT: ok" if not review else "RESULT: REVIEW")
    text = "\n".join(rows)
    print(text)
    if ns.out:
        Path(ns.out).write_text(text + "\n", encoding="utf-8")
    return 0 if not review else 1


if __name__ == "__main__":
    sys.exit(main())
