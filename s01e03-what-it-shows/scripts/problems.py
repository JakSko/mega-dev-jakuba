"""Step 9: the problem table. Desk groups (out/groups.json) plus the body check (out/check.json): the desk's
one-day-move reports (desk-notes.json) form their own problem, and, as the desk counts them ("counted where
they're filed, footnoted under it", causes.ts readAs), they also stay counted under 'parser' (claim 1 hint).
Usage: python -I -X utf8 tools/problems.py <support-kb dir>  -> out/problems.json"""
import json, sys, pathlib, collections

kb = pathlib.Path(sys.argv[1])
groups = {g["cause"]: g for g in json.load(open("out/groups.json", encoding="utf-8"))["groups"]}
rows = {r["id"]: r for r in json.load(open("out/check.json", encoding="utf-8"))}
reports = {r["id"]: r for r in json.loads((kb / "src/lib/data/reports-4471.json").read_text(encoding="utf-8"))}
one_day = set(json.loads((kb / "src/lib/data/desk-notes.json").read_text())["oneDayMove"])
sets = {"parser": set(groups["parser"]["ids"]), "hint": set(groups["hint"]["ids"]), "one-day": one_day}
assert set.union(*sets.values()) == set(reports) and not (sets["parser"] & sets["hint"]) and one_day <= sets["parser"]

def stats(ids):
    rs = [reports[i] for i in ids]
    days = sorted(r["receivedAt"][:10] for r in rs)
    return {"count": len(rs), "tenants": sorted({r["tenant"] for r in rs}),
            "channels": dict(collections.Counter(r["channel"] for r in rs)),
            "taggedAs": dict(collections.Counter(r["meta"]["intakeTag"] for r in rs)),
            "patterns": dict(collections.Counter(rows[i]["pattern"] for i in ids)),
            "firstSeen": days[0], "lastSeen": days[-1], "ids": sorted(ids)}

problems = {k: stats(v) for k, v in sets.items()}
json.dump(problems, open("out/problems.json", "w", encoding="utf-8"), indent=2, ensure_ascii=False)
for k, p in problems.items():
    print(k, p["count"], len(p["tenants"]), "tenants", p["channels"], p["taggedAs"], p["patterns"], p["firstSeen"], "->", p["lastSeen"])
print("unique", len(set.union(*sets.values())), "one-day also under parser", len(one_day & sets["parser"]))
