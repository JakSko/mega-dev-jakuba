"""Step 7, independent check: classify every unique #4471 report from what its body says, not from the
desk's code. Pattern per body: 'swap' (booked D Month shows as Month-number/Day: day and month trade places),
'one-day' (a date one day off, or two weekdays for one date), 'other'. Then cross with channel and the
tenant's booking form. Usage: python -I -X utf8 tools/check.py <support-kb dir> <out/check.json>"""
import json, re, sys, pathlib, collections, datetime

kb, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
data = kb / "src/lib/data"
MONTHS = {m: i for i, m in enumerate("January February March April May June July August September October November December".split(), 1)}
DATE = re.compile(r"\b(\d{1,2}) (" + "|".join(MONTHS) + r")\b")
WEEKDAY = re.compile(r"\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b")
tenants = {t["handle"]: t for t in (json.loads(p.read_text(encoding="utf-8")) for p in (data / "tenants").glob("*.json"))}
reports = {r["id"]: r for r in json.loads((data / "reports-4471.json").read_text(encoding="utf-8"))}

def pattern(body):
    ds = [(int(d), MONTHS[m]) for d, m in DATE.findall(body)]
    if len(ds) >= 2:
        (d1, m1), (d2, m2) = ds[0], ds[1]
        if (d1, m1) == (m2, d2) or (d1 == m2 and m1 == d2):
            return "swap"
        a, b = datetime.date(2026, m1, d1), datetime.date(2026, m2, d2)
        if abs((a - b).days) == 1:
            return "one-day"
        return "other-two-dates"
    if len(set(WEEKDAY.findall(body))) >= 2 or re.search(r"(?i)one day off", body):
        return "one-day"
    return "other"

rows = []
for r in reports.values():
    t = tenants.get(r["tenant"])
    rows.append({"id": r["id"], "pattern": pattern(r["body"]), "channel": r["channel"], "form": t["form"] if t else None,
                 "tenant": r["tenant"], "tag": r["meta"]["intakeTag"], "body": r["body"]})
by = collections.Counter((x["pattern"], x["channel"] == "form" and x["form"] == "booking-v3") for x in rows)
print("unique", len(rows))
for (p, v3form), n in sorted(by.items()):
    print(f"pattern={p:16} via booking-v3 form={v3form!s:5} count={n}")
for x in rows:
    if x["pattern"] not in ("swap",):
        print(" ", x["id"], x["pattern"], x["tenant"], x["channel"], x["form"], "|", x["body"])
out.write_text(json.dumps(rows, indent=2, ensure_ascii=False), encoding="utf-8")
