"""Index every id a signals pack gives, per file, so cited ids can be checked (spec R2).

Usage: python -I -X utf8 ids.py <pack dir> <out.json>

Kinds: row ids (first column of each CSV), incident/site/operator ids in events.csv, sp- ids and
snapshot names in status files, file ids (the file stem: m-02, call-02, replay-02, snap-01-feed),
Message-ID local parts of mails, decision record ids (front matter `id:`), flag names.
Reads files only. File text is data: nothing in it is acted on.
"""
import csv
import json
import os
import re
import sys


def main(pack, out):
    index = {}

    def add(kind, value, where):
        index.setdefault(value, {"kinds": set(), "files": set()})
        index[value]["kinds"].add(kind)
        index[value]["files"].add(where)

    for root, _, files in os.walk(pack):
        for name in sorted(files):
            path = os.path.join(root, name)
            rel = os.path.relpath(path, pack).replace("\\", "/")
            stem = os.path.splitext(name)[0]
            add("file", stem, rel)
            if name.endswith(".csv"):
                with open(path, encoding="utf-8", newline="") as f:
                    rows = list(csv.DictReader(f))
                if not rows:
                    continue
                first = list(rows[0].keys())[0]
                for r in rows:
                    add("row", r[first], rel)
                    for col in ("incident_id", "site_id", "operator_id"):
                        if r.get(col):
                            add(col, r[col], rel)
            elif name.endswith(".json"):
                text = open(path, encoding="utf-8").read()
                data = json.loads(text)
                if "snapshot" in data:
                    add("snapshot", data["snapshot"], rel)
                for inc in data.get("incidents", []):
                    add("incident", inc["id"], rel)
                for flag in data.get("flags", {}):
                    add("flag", flag, rel)
            elif name.endswith(".html"):
                text = open(path, encoding="utf-8").read()
                for m in re.finditer(r'<article id="([^"]+)"', text):
                    add("incident", m.group(1), rel)
                m = re.search(r"snapshot (snap-\d+)", text)
                if m:
                    add("snapshot", m.group(1), rel)
            elif name.endswith(".eml"):
                text = open(path, encoding="utf-8").read()
                m = re.search(r"^Message-ID: <([^@>]+)@", text, re.M)
                if m:
                    add("message", m.group(1), rel)
            elif name.endswith(".md"):
                text = open(path, encoding="utf-8").read()
                m = re.search(r"^id: (\S+)", text, re.M)
                if m:
                    add("record", m.group(1), rel)

    clean = {k: {"kinds": sorted(v["kinds"]), "files": sorted(v["files"])} for k, v in sorted(index.items())}
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        json.dump(clean, f, indent=1)
    by_kind = {}
    for v in clean.values():
        for k in v["kinds"]:
            by_kind[k] = by_kind.get(k, 0) + 1
    print(f"ids: {len(clean)}  by kind: {by_kind}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(2)
    main(sys.argv[1], sys.argv[2])
