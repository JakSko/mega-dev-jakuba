"""check_result.py - objective checks on a worker's trace (spec R9). One line per check.

  python check_result.py job-1 TRACE [--result result.json] [--pending submit-args.json]
  python check_result.py job-2 TRACE [--result result.json] [--pending submit-args.json]

--pending checks planned submit arguments before the submit (the gate in R10); without it the
accepted submit in the trace is checked, and --result must carry its receipt.
Ends with RESULT: ok or RESULT: FAIL. WARN lines do not fail the run.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mcp_call import WITHHELD, accepted_submit, check_read_policy, find_key, read_trace, reply_ok  # noqa: E402

NOTE_RE = re.compile(r"^.+ @\d+:\d{2}$")
OFFSET_RE = re.compile(r"@\d+:\d{2}")


def body(reply: Any) -> Any:
    """The tool's result: structuredContent, or the JSON in the first text block (servers differ)."""
    if not isinstance(reply, dict):
        return reply
    if reply.get("structuredContent"):
        return reply["structuredContent"]
    for c in reply.get("content") or []:
        if isinstance(c, dict) and c.get("type") == "text":
            try:
                return json.loads(c["text"])
            except (ValueError, TypeError):
                return c.get("text")
    return None


def calls(entries, tool):
    return [e for e in entries if e.get("op") in ("call", "resume") and e.get("tool") == tool]


def submitted_text(args: dict[str, Any]) -> str | None:
    vals = [v for k, v in (args or {}).items() if isinstance(v, str) and k != "skillVersion" and "step" not in k.lower()]
    return max(vals, key=len) if vals else None


def crew_values(o: Any) -> list[Any]:
    found = []
    if isinstance(o, dict):
        for k, v in o.items():
            if isinstance(k, str) and k.lower() == "crew":
                found.append(v)
            else:
                found += crew_values(v)
    elif isinstance(o, list):
        for v in o:
            found += crew_values(v)
    elif isinstance(o, str) and o.lstrip().startswith(("{", "[")):
        try:
            found += crew_values(json.loads(o))
        except ValueError:
            pass
    return found


def run(job: str, entries: list[dict[str, Any]], result: dict[str, Any] | None, pending: dict[str, Any] | None) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []

    def add(ok: bool | None, msg: str) -> None:
        out.append(("ok" if ok else ("WARN" if ok is None else "FAIL"), msg))

    skill = [e for e in entries if e.get("op") == "load-skill"]
    sr = (skill[-1].get("reply") or {}) if skill else {}
    v = sr.get("verdict")
    no_manifest_only = (v == "mismatch" and sr.get("problems") == ["no skills/get entry (manifest not checked)"]
                        and sr.get("sha256") and sr.get("sha256") == sr.get("expectedSha256"))
    if no_manifest_only:
        add(None, "server has no skills/get: skill accepted on the zip sha match alone (Jakub's decision, S02E04)")
    else:
        add(v == "ok", f"skill loaded and verified against the manifest and the zip copy: {v!r}")

    sub = accepted_submit(entries)
    args = pending if pending is not None else (sub or {}).get("args")
    add(args is not None, "submit arguments found" + (" (pending)" if pending is not None else " (accepted submit)"))
    args = args or {}
    add(args.get("skillVersion") == "1", f"skillVersion is \"1\": {args.get('skillVersion')!r}")
    text = submitted_text(args)

    if job == "job-1":
        searches = calls(entries, "search")
        add(any((e.get("args") or {}).get("scope") == "ops/live" for e in searches), "search used scope ops/live")
        missing = []
        for e in searches:
            nxt = find_key(body(e.get("reply")), "nextCursor")
            if nxt and not any((x.get("args") or {}).get("cursor") == nxt for x in searches):
                missing.append(nxt)
        add(not missing, f"every result page read (unread cursors: {missing})")
        reads = calls(entries, "read")
        bad = [e.get("args") for e in reads if not e.get("refused") and check_read_policy(e.get("args") or {})]
        add(bool(reads) and not bad, f"read asked only for the five fields ({len(reads)} read calls, bad: {bad})")
        leaked = [cv for e in entries for cv in crew_values(e.get("reply")) if cv != WITHHELD]
        withheld = any(e.get("crewWithheld") for e in entries)
        add(not leaked, "no crew value in any reply in the trace")
        if withheld:
            add(None, "the server returned crew at least once; it was withheld by mcp_call.py")
        red = [e for e in calls(entries, "redact") if reply_ok(e.get("reply"))]
        rtext = find_key(body(red[-1].get("reply")), "text") if red else None
        lines = (rtext or "").splitlines()
        for f in ("date", "time", "clock"):
            add(any(line.startswith(f + ":") for line in lines), f"redact reply keeps the {f} line")
        add(rtext is not None and text == rtext, "submitted text equals the last redact reply byte for byte")
    else:
        tr = [e for e in calls(entries, "transcribe") if reply_ok(e.get("reply"))]
        segs = find_key(body(tr[-1].get("reply")), "segments") if tr else None
        add(bool(tr), f"transcribe ran; segments in the last reply: {len(segs) if isinstance(segs, list) else 'unknown'}")
        writes = [(e.get("args") or {}).get("text") for e in calls(entries, "memo_write") if reply_ok(e.get("reply"))]
        badfmt = [w for w in writes if not (isinstance(w, str) and NOTE_RE.match(w) and len(OFFSET_RE.findall(w)) == 1)]
        add(bool(writes) and not badfmt, f"every note is '<what happened> @m:ss' with one offset ({len(writes)} notes, bad: {badfmt})")
        last_w = max((i for i, e in enumerate(entries) if e.get("tool") == "memo_write"), default=-1)
        add(any(e.get("tool") == "memo_search" and i > last_w for i, e in enumerate(entries)), "memo_search ran after the last memo_write")
        sublines = (text or "").split("\n")
        add(len(sublines) == len(set(sublines)), "no duplicate lines in the submitted notes")
        uniq = list(dict.fromkeys(writes))
        add(sublines == uniq, f"submitted lines equal the memo_write texts, in order ({len(sublines)} vs {len(uniq)})")

    if pending is None:
        rc = (result or {}).get("receipt")
        add(bool(sub) and bool(rc), "an accepted submit with a receipt" + ("" if result else " (no --result given)"))
    return out


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("job", choices=["job-1", "job-2"])
    p.add_argument("trace")
    p.add_argument("--result")
    p.add_argument("--pending")
    ns = p.parse_args(argv)
    entries = read_trace(Path(ns.trace))
    result = json.loads(Path(ns.result).read_text(encoding="utf-8")) if ns.result else None
    pending = json.loads(Path(ns.pending).read_text(encoding="utf-8")) if ns.pending else None
    rows = run(ns.job, entries, result, pending)
    for state, msg in rows:
        print(f"{state:4}  {msg}")
    fail = any(s == "FAIL" for s, _ in rows)
    print("RESULT: FAIL" if fail else "RESULT: ok")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
