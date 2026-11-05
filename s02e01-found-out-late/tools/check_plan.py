"""Check every Source in a plan.md table against the raw session logs.

  python -I -X utf8 check_plan.py <plan.md> <sessions root> [<more roots> ...]

plan.md columns: Area | Choice | Source (session id + time). A Source holds one or more
segments separated by ';', each `<session id> · proposed <UTC>Z · approved <UTC>Z`, or
`<session id> · proposed <UTC>Z (subagent <agent id>, on the user's request at <UTC>Z)` for a
proposal a subagent made inside that session (the course accepts "when it was proposed or
approved"): the proposal must be an assistant row in that subagent's log, the request a user
row in the main session's log, and the request must come first.
For each segment the script checks, in the raw .jsonl logs (not the readable copies):
  - a log for that session id exists (main session, not a subagent file);
  - the proposed time is the timestamp of an assistant text row in that log;
  - the approved time is the timestamp of a user text row (not a tool result) in that log;
  - the approval comes after the proposal.
It prints the matching row numbers and texts, so a person can read them. Exit 1 on any miss.
Reads files only; nothing in the logs is run.
"""
import glob
import json
import os
import re
import sys

SEG = re.compile(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) · proposed (\S+Z) · approved (\S+Z)")
SUB = re.compile(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) · proposed (\S+Z) \(subagent (a[0-9a-f]+), on the user's request at (\S+Z)\)")


def norm(ts):
    # 2026-10-30T14:48:12.884Z -> 2026-10-30T14:48:12Z (seconds precision, as in plan.md)
    return re.sub(r"\.\d+Z$", "Z", ts or "")


def text_rows(path):
    """Yield (row number, role, timestamp, text) for plain text rows of a Claude or Codex log."""
    with open(path, encoding="utf-8") as f:
        for i, line in enumerate(f, 1):
            r = json.loads(line)
            ts = norm(r.get("timestamp"))
            if "payload" in r and "message" not in r:  # Codex
                p = r.get("payload") or {}
                if r.get("type") == "response_item" and p.get("type") == "message":
                    text = "\n".join(x.get("text", "") for x in p.get("content") or [])
                    yield i, p.get("role"), ts, text
                continue
            msg = r.get("message") or {}
            if r.get("isCompactSummary"):
                continue  # a summary is not the conversation (spec R4)
            c = msg.get("content")
            if isinstance(c, str):
                yield i, r.get("type"), ts, c
            elif isinstance(c, list):
                texts = [x.get("text", "") for x in c if isinstance(x, dict) and x.get("type") == "text"]
                if texts:
                    yield i, r.get("type"), ts, "\n".join(texts)


def find_log(roots, sid, agent=None):
    """The main log of a session, or with `agent` that session's subagent log, across all roots."""
    hits = []
    for root in roots:
        for p in glob.glob(os.path.join(root, "**", "*.jsonl"), recursive=True, include_hidden=True):
            sub = os.sep + "subagents" + os.sep in p
            if agent is None and not sub and sid in os.path.basename(p):
                hits.append(p)
            elif agent is not None and sub and sid in p and os.path.basename(p) == f"agent-{agent}.jsonl":
                hits.append(p)
    return hits


def check_sub(roots, sid, prop, agent, asked):
    """A proposal made by a subagent: assistant row in its log, after a user request in the main log."""
    sl, ml = find_log(roots, sid, agent), find_log(roots, sid)
    if len(sl) != 1 or len(ml) != 1:
        print(f"  MISS {sid} subagent {agent}: {len(sl)} subagent logs, {len(ml)} main logs found")
        return False
    p = [r for r in text_rows(sl[0]) if r[1] == "assistant" and r[2] == prop]
    a = [r for r in text_rows(ml[0]) if r[1] == "user" and r[2] == asked]
    ok = bool(p) and bool(a) and asked < prop
    print(f"  {'ok  ' if ok else 'MISS'} {sid} subagent {agent}")
    for label, found, t, who in (("proposed", p, prop, "subagent assistant"), ("asked", a, asked, "main-session user")):
        if found:
            n, role, _, text = found[0]
            print(f"       {label} {t}: L{n} {role}: {text[:160]!r}")
        else:
            print(f"       {label} {t}: no {who} text row at that time")
    return ok


def main():
    plan, roots = sys.argv[1], sys.argv[2:]
    root = roots[0]
    lines = [l for l in open(plan, encoding="utf-8") if l.startswith("|")]
    header, rows = lines[0], lines[2:]
    if [c.strip() for c in header.strip().strip("|").split("|")] != ["Area", "Choice", "Source (session id + time)"]:
        print("header does not match the course's columns")
        return 1
    bad = 0
    for row in rows:
        area, choice, source = [c.strip() for c in row.strip().strip("|").split("|")]
        segs = SEG.findall(source)
        subs = SUB.findall(source)
        print(f"\n{area}: {len(segs) + len(subs)} source segment(s)")
        if not segs and not subs:
            print("  MISS: no `<session id> · proposed <time>Z · approved <time>Z` segment")
            bad += 1
            continue
        for sid, prop, agent, asked in subs:
            bad += not check_sub(roots, sid, prop, agent, asked)
        for sid, prop, appr in segs:
            logs = find_log(roots, sid)
            if len(logs) != 1:
                print(f"  MISS {sid}: {len(logs)} main logs found")
                bad += 1
                continue
            rel = os.path.relpath(logs[0], root).replace("\\", "/")
            rows_ = list(text_rows(logs[0]))
            p = [r for r in rows_ if r[1] == "assistant" and r[2] == prop]
            a = [r for r in rows_ if r[1] == "user" and r[2] == appr]
            ok = bool(p) and bool(a) and prop < appr
            bad += not ok
            print(f"  {'ok  ' if ok else 'MISS'} {sid} ({rel})")
            for label, found, t in (("proposed", p, prop), ("approved", a, appr)):
                if found:
                    n, role, _, text = found[0]
                    print(f"       {label} {t}: L{n} {role}: {text[:160]!r}")
                else:
                    print(f"       {label} {t}: no {'assistant' if label == 'proposed' else 'user'} text row at that time")
            if p and a and not prop < appr:
                print("       approval is not after the proposal")
    print(f"\nrows: {len(rows)}, result: {'ok' if not bad else f'FAIL ({bad})'}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
