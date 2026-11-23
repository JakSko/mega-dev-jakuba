"""Check that every signal id cited in a groups file exists in the batch's id index (spec R2).

Usage: python -I -X utf8 check_ids.py <groups.json> <ids.json>

Also checks each group's shape: name, signals (non-empty), verb in the six, who in agent/owner, note.
Prints `result: ok` or each problem. Reads files only.
"""
import json
import sys

VERBS = {"expand", "revise", "simplify", "revert", "investigate", "stop"}


def main(groups_path, ids_path):
    groups = json.load(open(groups_path, encoding="utf-8"))["groups"]
    ids = json.load(open(ids_path, encoding="utf-8"))
    problems, cited = [], 0
    for n, g in enumerate(groups, 1):
        tag = f"group {n} '{g.get('name', '?')}'"
        for k in ("name", "note"):
            if not str(g.get(k, "")).strip():
                problems.append(f"{tag}: empty {k}")
        if g.get("verb") not in VERBS:
            problems.append(f"{tag}: verb {g.get('verb')!r} not one of {sorted(VERBS)}")
        if g.get("who") not in ("agent", "owner"):
            problems.append(f"{tag}: who {g.get('who')!r} not agent/owner")
        if not g.get("signals"):
            problems.append(f"{tag}: no signals")
        for s in g.get("signals", []):
            cited += 1
            if s not in ids:
                problems.append(f"{tag}: id {s!r} not in {ids_path}")
        if len(set(g.get("signals", []))) != len(g.get("signals", [])):
            problems.append(f"{tag}: an id is cited twice")
    print(f"groups: {len(groups)}, cited ids: {cited}, owner groups: {sum(g.get('who') == 'owner' for g in groups)}")
    for p in problems:
        print("  " + p)
    print("result: ok" if not problems else f"result: FAIL ({len(problems)} problems)")
    return 1 if problems else 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1], sys.argv[2]))
