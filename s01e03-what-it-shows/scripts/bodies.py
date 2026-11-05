"""Step 11: build one GitHub issue body per problem from out/problems.json and the export. Nothing typed by hand:
counts, tenants, dates, ids and quotes come from the data. Usage: python -I -X utf8 tools/bodies.py <support-kb dir>
-> out/issues/<key>.md and out/issues/titles.json"""
import json, sys, pathlib

kb = pathlib.Path(sys.argv[1])
P = json.load(open("out/problems.json", encoding="utf-8"))
reports = {r["id"]: r for r in json.loads((kb / "src/lib/data/reports-4471.json").read_text(encoding="utf-8"))}
TOTAL = len(reports)
REPO = "https://github.com/JakSko/mega-s01e03-what-it-shows"
out = pathlib.Path("out/issues"); out.mkdir(parents=True, exist_ok=True)

SPEC = {
    "parser": {
        "title": "Shared date parser reads day-first dates month first",
        "cause": "The shared parser reads every date month first. All tenants in `#4471` write the day first, so a booking for 5 June comes out as 6 May: day and month trade places.",
        "how": "The desk's own rule (`src/lib/kb/causes.ts`, `causeOf`): a day-first tenant's report that did not come through the booking-v3 form. Each body names the booked date and the shown date, and they are the same two numbers swapped.",
        "fix": "Parse dates in the tenant's locale order (`dayFirst(locale)`), not month first.",
        "samples": 4,
        "note": "Counted the desk's way, as exported: {n} of these reports the desk read as a one-day move (`desk-notes.json`). They are counted here, where the desk files them, and footnoted: they are also issue #3.",
    },
    "hint": {
        "title": "booking-v3 form hints MM/DD/YYYY to day-first tenants",
        "cause": "The booking-v3 form prints `MM/DD/YYYY` under its date field. Its people type the month first, as the hint tells them, and the form reads the date the tenant's way, day first. A different bug from the parser: fixing the parser leaves these wrong.",
        "how": "The desk's own rule (`causeOf`): a report from a day-first tenant on booking-v3 that came in through the form. The rendered `#4471` kb page already marks this group \"not this ticket — no ticket of its own\". Bodies read like the parser reports; only channel and form tell them apart.",
        "fix": "Show the tenant's own order under the date field (`DD/MM/YYYY` for day-first locales), or read what the hint asks for.",
        "samples": 4,
    },
    "one-day": {
        "title": "Dates move one day early (time zones)",
        "cause": "The date comes out one day early, not swapped: the weekday is off by one, invitees in two time zones get two different days, or one month only is off by a day. This looks like a date handled as a UTC time and shifted by the time zone.",
        "how": "The desk itself read these reports as a one-day move (`src/lib/data/desk-notes.json`) but filed them under the parser by tenant. Their bodies hold no day-month swap. R-41236 has no dates; it is here on the desk's reading only.",
        "fix": "Store and send booking dates as calendar dates (or with the tenant's time zone), never as a midnight UTC time.",
        "samples": 5,
    },
}

def body(key):
    p, s = P[key], SPEC[key]
    tags = " · ".join(f"`{k}` ×{v}" for k, v in sorted(p["taggedAs"].items(), key=lambda kv: -kv[1]))
    chans = " · ".join(f"{k} {v}" for k, v in sorted(p["channels"].items(), key=lambda kv: -kv[1]))
    lines = [
        f"**Reports covered: {p['count']}** of the {TOTAL} unique reports merged into support ticket `#4471`.",
        "",
    ] + ([s["note"].format(n=len(set(p["ids"]) & set(P["one-day"]["ids"]))), ""] if "note" in s else []) + [
        f"kb page about all three problems: [the .svx]({REPO}/blob/main/support-kb/src/routes/kb/incidents/4471/split/+page.svx) · [as the desk sees it]({REPO}/blob/main/rendered/kb/incidents/4471/split.html)",
        "",
        "## Cause", s["cause"], "",
        "## How it was found", s["how"], "",
        "## Scope",
        f"- Tenants: {len(p['tenants'])} ({', '.join(p['tenants'])})",
        f"- Channels: {chans}",
        f"- First and last seen: {p['firstSeen']} → {p['lastSeen']}",
        f"- Intake tagged them as: {tags} (intake guesses from the browser; the tag does not decide the cause)",
        "",
        "## Likely fix", s["fix"], "",
        "## Sample reports",
    ]
    others = set() if key == "one-day" else set(P["one-day"]["ids"])  # samples show this problem only
    for i in [i for i in p["ids"] if i not in others][: s["samples"]]:
        r = reports[i]
        lines.append(f"- {i} · {r['tenant']} · {r['channel']} · {r['receivedAt'][:10]}: \"{r['body']}\"")
    lines += ["", f"<details><summary>All {p['count']} report ids</summary>", "", ", ".join(p["ids"]), "", "</details>", "",
              "Source: the support kb export of 2026-10-04 (`src/lib/data/reports-4471.json`), counted by unique id."]
    return "\n".join(lines) + "\n"

titles = {}
for key in ("parser", "hint", "one-day"):
    titles[key] = f"{SPEC[key]['title']} ({P[key]['count']} reports)"
    (out / f"{key}.md").write_text(body(key), encoding="utf-8")
json.dump(titles, open(out / "titles.json", "w", encoding="utf-8"), indent=2, ensure_ascii=False)
assert set().union(*(P[k]["ids"] for k in titles)) == set(reports)
for k, t in titles.items():
    print(k, "|", t, "|", len((out / f"{k}.md").read_text(encoding="utf-8")), "chars")
