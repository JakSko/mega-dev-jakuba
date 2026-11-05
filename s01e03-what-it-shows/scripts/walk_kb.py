"""Step 4: walk the kb like an agent. Per page: frontmatter, age vs the kb's 180-day rule, links, components.
Also: data files and whether duplicate report ids differ. Usage: python -I tools/walk_kb.py <support-kb dir> <today YYYY-MM-DD>"""
import json, re, sys, pathlib, datetime, collections

root, today = pathlib.Path(sys.argv[1]), datetime.date.fromisoformat(sys.argv[2])
STALE = 180  # src/lib/kb/staleness.ts
for p in sorted((root / "src/routes").rglob("+page.svx")):
    t = p.read_text(encoding="utf-8")
    fm = dict(re.findall(r"^(\w+): ?(.*)$", t.split("---")[1], re.M))
    age = (today - datetime.date.fromisoformat(fm["reviewed"])).days
    links = re.findall(r"\]\((/[^)]+)\)", t)
    comps = re.findall(r"<([A-Z]\w+)", t)
    print(f"{p.relative_to(root)}\n  title={fm.get('title')} owner={fm.get('owner')} status={fm.get('status')} reviewed={fm['reviewed']} age={age}d {'STALE' if age > STALE else 'fresh'} signature={fm.get('signature', '-')}\n  links={links} components={comps}")
rep = json.loads((root / "src/lib/data/reports-4471.json").read_text(encoding="utf-8"))
by = collections.defaultdict(list)
for r in rep:
    by[r["id"]].append(r)
dups = {k: v for k, v in by.items() if len(v) > 1}
differ = {k: [sorted(f for f in v[0] if v[0][f] != x[f]) for x in v[1:]] for k, v in dups.items() if any(x != v[0] for x in v[1:])}
print(f"duplicate ids: {len(dups)} (entries {sum(len(v) for v in dups.values())}); copies that differ: {differ or 'none'}")
print("desk-notes oneDayMove present in reports:", [i in by for i in json.loads((root / "src/lib/data/desk-notes.json").read_text())["oneDayMove"]])
