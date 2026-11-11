"""Turn a findings file into the requirements list, and refuse a list that breaks the rules.

  python -I -X utf8 build_list.py <findings.json> <list.json> [--folder DIR] [--records feed.json]

findings.json (written by the agent after reading every source):
  {"tag_re": "R-[A-Z0-9]{3}",
   "found":    [{"tag", "says", "owner"?, "source": {"file", "at"?, "region"?}}],
   "conflicts": [{"tag", "with", "ownerQuestion"}],      # each side of a pair has its own entry
   "unreadable": [{"file", "why"}]}
A tag named in "conflicts" goes there with its source; every other found tag goes to "accepted".

Checks (exit 1 on any): every tag matches the pattern and appears once; a file source exists in
--folder (a link starts with https://); `at` is a number >= 0; a region has 0-1 fractions inside
the image (x+w <= 1, y+h <= 1) and a page >= 1 when given; `with` is another found tag or a record
id in --records; the owner question names both sides. Prints a summary with links shortened.
Writes only list.json.
"""
import argparse
import json
import os
import re
import sys


def short(f):
    return f.split("?")[0] + ("?…" if "?" in f else "")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("findings")
    ap.add_argument("out")
    ap.add_argument("--folder", default=None)
    ap.add_argument("--records", default=None)
    a = ap.parse_args()
    F = json.load(open(a.findings, encoding="utf-8"))
    tag_re = re.compile(F.get("tag_re", r"R-[A-Z0-9]{3}"))
    errors = []
    found = {}
    for f in F["found"]:
        t = f["tag"]
        if not tag_re.fullmatch(t):
            errors.append(f"{t}: not a tag")
        if t in found:
            errors.append(f"{t}: found twice")
        found[t] = f
        s = f["source"]
        file = s.get("file", "")
        if not file:
            errors.append(f"{t}: no file")
        elif not file.startswith("https://") and a.folder and not os.path.isfile(os.path.join(a.folder, file)):
            errors.append(f"{t}: {file} not in {a.folder}")
        if "at" in s and not (isinstance(s["at"], (int, float)) and s["at"] >= 0):
            errors.append(f"{t}: bad at")
        r = s.get("region")
        if r is not None:
            ok = all(isinstance(r.get(k), (int, float)) and 0 <= r[k] <= 1 for k in "xywh")
            ok = ok and r["x"] + r["w"] <= 1.0001 and r["y"] + r["h"] <= 1.0001 and r["w"] > 0 and r["h"] > 0
            if "page" in r:
                ok = ok and isinstance(r["page"], int) and r["page"] >= 1
            if not ok:
                errors.append(f"{t}: bad region {r}")
    records = set()
    if a.records:
        records = {str(x["id"]) for x in json.load(open(a.records, encoding="utf-8"))["incidents"]}
    conflicts, in_conflict = [], set()
    for c in F["conflicts"]:
        t, w, q = c["tag"], str(c["with"]), c["ownerQuestion"]
        if t not in found:
            errors.append(f"conflict {t}: tag not found")
            continue
        if t in in_conflict:
            errors.append(f"conflict {t}: listed twice")
        in_conflict.add(t)
        if w not in found and w not in records:
            errors.append(f"conflict {t}: with {w} is neither a found tag nor a record id")
        if t not in q or w not in q:
            errors.append(f"conflict {t}: ownerQuestion does not name both {t} and {w}")
        conflicts.append({"tag": t, "with": w, "ownerQuestion": q, "source": found[t]["source"]})
    accepted = [{"tag": t, "source": f["source"]} for t, f in found.items() if t not in in_conflict]
    lst = {"accepted": accepted, "conflicts": conflicts}
    if F.get("unreadable"):
        lst["unreadable"] = F["unreadable"]
    print(f"found {len(found)} tags: accepted {len(accepted)}, conflicts {len(conflicts)}, unreadable {len(F.get('unreadable', []))}")
    for e in accepted + conflicts:
        s = e["source"]
        print(f"  {e['tag']:6} {short(s['file'])}" + (f" at {s['at']}" if "at" in s else "") + (f" region {s['region']}" if "region" in s else "") + (f"  WITH {e['with']}" if "with" in e else ""))
    if errors:
        print("ERRORS:\n  " + "\n  ".join(errors))
        sys.exit(1)
    json.dump(lst, open(a.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"written {a.out}: result ok")


if __name__ == "__main__":
    main()
