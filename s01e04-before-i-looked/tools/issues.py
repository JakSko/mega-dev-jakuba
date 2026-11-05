"""Build and (on --create) publish the S01E04 issues from the approved split.

Sources (never retyped):
  - ../issues-split.md: "The split" table (title, section, scope, done when) and the
    "Decisions" table (add to scope, blocked by with {s1}-style placeholders).
  - the Challenge repo's plan.md: every "Done when" must appear in it word for word.

Usage (run with python -I -X utf8):
  issues.py --dry-run    writes out/issues/<section>.md and out/issues/manifest.json, creates nothing
  issues.py --create     creates the label, then the issues in table order, with gh;
                         numbers come from gh's output and fill the next bodies' placeholders;
                         writes out/issues/created.json
"""
import os
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CH = HERE.parent
SPLIT = CH / "issues-split.md"
REPO_DIR = Path(os.environ.get("REPO_DIR", "."))  # the Challenge repo checkout
REPO = "JakSko/mega-s01e04-before-i-looked"
GH = r"C:\Program Files\GitHub CLI\gh.exe"
LABEL = "plan:morning-digest"
LABEL_DESC = "Issues split from plan.md (morning digest)"
OUT = CH / "out" / "issues"


def cells(line: str) -> list[str]:
    parts = re.split(r"(?<!\\)\|", line.strip())[1:-1]
    return [p.strip().replace("\\|", "|") for p in parts]


def section_rows(text: str, heading: str, ncols: int) -> list[list[str]]:
    block = text.split(heading, 1)[1].split("\n## ", 1)[0]
    rows = []
    for line in block.splitlines():
        if line.startswith("|") and not re.match(r"^\|\s*[-#]|^\|\s*Section", line):
            c = cells(line)
            if len(c) == ncols and c[0] and c[0] not in ("#", "Section"):
                rows.append(c)
    return rows


def plan_done_when(plan: str, sec: str) -> str:
    """The 'Done when:' sentence of one plan section (## 1. / ### 2a.), whitespace joined."""
    m = re.search(rf"^#+ {re.escape(sec)}\. .*?$(.*?)(?=^#+ |\Z)", plan, re.S | re.M)
    assert m, f"section {sec} not found in plan.md"
    d = re.search(r"Done when: (.*?)(?:\n\s*\n|\Z)", m.group(1), re.S)
    assert d, f"no Done when in section {sec}"
    return " ".join(d.group(1).split())


def key(section: str) -> str:
    return "s" + section.replace("§", "").strip()


def build() -> list[dict]:
    text = SPLIT.read_text(encoding="utf-8")
    plan = (REPO_DIR / "plan.md").read_text(encoding="utf-8")

    split = section_rows(text, "## The split", 7)
    dec = {r[0]: r for r in section_rows(text, "## Decisions", 3)}
    assert len(split) == 7, f"expected 7 issues, got {len(split)}"
    issues = []
    for n, title, section, scope, done, _blocked, model in split:
        sec = section.replace("§", "").strip()
        assert sec in dec, f"no decision row for section {sec}"
        plan_done = plan_done_when(plan, sec)
        assert " ".join(done.split()).lower() == plan_done.lower(), f"§ {sec}: table Done when differs from plan.md"
        done = plan_done  # the plan's own words, exactly
        body = (
            f"Source: plan.md § {sec}\n\n"
            f"## Scope\n\n{scope}\n\n{dec[sec][1]}\n\n"
            f"## Done when\n\n{done}\n\n"
            f"## Blocked by\n\n{dec[sec][2]}\n"
        )
        issues.append({"order": int(n), "section": sec, "key": key(section), "title": title,
                       "model": model, "body_template": body})
    return issues


def fill(body: str, numbers: dict) -> str:
    def sub(m):
        k = m.group(1)
        if k not in numbers:
            raise KeyError(f"placeholder {{{k}}} has no issue number yet")
        return str(numbers[k])
    return re.sub(r"\{(s[0-9a-z]+)\}", sub, body)


def gh(*args: str) -> str:
    r = subprocess.run([GH, *args], capture_output=True, text=True, encoding="utf-8", cwd=REPO_DIR)
    if r.returncode != 0:
        sys.exit(f"gh {' '.join(args[:3])} failed ({r.returncode}): {r.stderr.strip()}")
    return r.stdout.strip()


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "--dry-run"
    issues = build()
    OUT.mkdir(parents=True, exist_ok=True)
    if mode == "--dry-run":
        # Show bodies with the numbers they will get in a repo with no issues or PRs yet (1..7).
        guess = {i["key"]: i["order"] for i in issues}
        manifest = []
        for i in issues:
            body = fill(i["body_template"], guess)
            f = OUT / f"{i['order']}-s{i['section']}.md"
            f.write_text(body, encoding="utf-8", newline="\n")
            manifest.append({"order": i["order"], "section": i["section"], "title": i["title"],
                             "label": LABEL, "model": i["model"], "body_file": f.name})
        (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
                                           encoding="utf-8", newline="\n")
        print(f"dry run: {len(issues)} bodies in {OUT}; every Done when taken word for word from plan.md")
        return
    if mode != "--create":
        sys.exit("usage: issues.py --dry-run | --create")
    existing = json.loads(gh("issue", "list", "-R", REPO, "--state", "all", "--json", "number"))
    if existing:
        sys.exit(f"repo already has issues {existing}; stop, nothing created")
    labels = json.loads(gh("label", "list", "-R", REPO, "--json", "name"))
    if LABEL not in [l["name"] for l in labels]:
        gh("label", "create", LABEL, "-R", REPO, "--description", LABEL_DESC, "--color", "5319e7")
    numbers, created = {}, []
    for i in issues:
        body = fill(i["body_template"], numbers)
        f = OUT / f"{i['order']}-s{i['section']}.created.md"
        f.write_text(body, encoding="utf-8", newline="\n")
        url = gh("issue", "create", "-R", REPO, "--title", i["title"], "--label", LABEL, "--body-file", str(f))
        m = re.search(r"/issues/(\d+)$", url)
        if not m:
            sys.exit(f"could not read an issue number from gh output: {url!r}")
        numbers[i["key"]] = int(m.group(1))
        created.append({"section": i["section"], "number": int(m.group(1)), "url": url, "title": i["title"]})
        print(f"§ {i['section']} -> {url}")
    (OUT / "created.json").write_text(json.dumps(created, indent=2, ensure_ascii=False) + "\n",
                                      encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
