"""Builds the S02E05 status log from a saved host log, grouped by course message.

Usage: python -I -X utf8 scripts/build_status_log.py <host log file> <since ISO, e.g. 2026-11-10T08:00:00>

Each course message is identified by its id (hash of the raw body); its kind comes from the
replyUrl path (".../r/<n>.<kind>.<token>": round1, round2, regress, ...). Rows: "round" is the
message (1 for the message before the window, 2 for the asks inside it):
  round1 -> 1, round2 -> 2, any other kind -> left out and listed (try 2 was refused with
  "log_shape: round" when a "regress" message was labelled 2).
Events: accepted request -> received, ping -> notified, approval approved/declined ->
owner_answered, reply with a 2xx status -> replied.
Writes out/claim-status-log.json ({"log": "<JSON lines>"}) and prints the rows per message.
"""
import json
import re
import sys
from pathlib import Path

src, since = sys.argv[1], sys.argv[2]
ROUND = {"round1": 1, "round2": 2}
kind: dict[str, str] = {}
rows = []
for line in Path(src).read_text(encoding="utf-8", errors="replace").splitlines():
    m = re.search(r'at="([^"]+)" event="([a-z ]+)" id="(m_[0-9a-f]{16})"', line)
    if not m or m.group(1) < since:
        continue
    at, ev, mid = m.groups()
    if ev == "request" and 'verdict="accepted' in line:
        u = re.search(r'replyUrl\\?":\\?"https://[^/]+/r/\d+\.([a-z0-9]+)\.', line)
        kind[mid] = u.group(1) if u else "unknown"
        rows.append((at, mid, "received"))
    elif ev == "ping" and "status=200" in line:
        rows.append((at, mid, "notified"))
    elif ev == "approval" and ('verdict="approved by the human"' in line or 'verdict="declined by the human"' in line):
        rows.append((at, mid, "owner_answered"))
    elif ev == "reply" and re.search(r"status=2\d\d", line):
        rows.append((at, mid, "replied"))

rows = sorted(set(rows))
kept, left = [], {}
for at, mid, e in rows:
    k = kind.get(mid, "unknown")
    if k in ROUND:
        kept.append({"at": at.replace("Z", "+00:00"), "round": ROUND[k], "event": e})
    else:
        left.setdefault(f"{mid} ({k})", []).append(e)

by_msg: dict[str, list[str]] = {}
for at, mid, e in rows:
    by_msg.setdefault(f"{mid} ({kind.get(mid, 'unknown')})", []).append(f"{at} {e}")
for k, v in by_msg.items():
    print(k)
    for x in v:
        print("   ", x)
print("left out:", left or "nothing")
Path("out/claim-status-log.json").write_text(json.dumps({"log": "\n".join(json.dumps(r) for r in kept)}, indent=1) + "\n", encoding="utf-8")
print(len(kept), "rows written to out/claim-status-log.json")
