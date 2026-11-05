"""Move plan.md to docs/plans/done/<opened>-<plan>.md with its issue table (plan step 25).

Table shape copied from the earlier done plans: | # | Issue | Blocked by | Worker | Closed |
Sources: the issues on GitHub (titles, bodies' "Blocked by", closing comments' "worker:" line,
closedAt). An issue still open (the clean-up one, closed right after this commit) takes its
worker and close date from the arguments.

Usage (python -I -X utf8): done_plan.py --open-worker "claude-code · opus-5.5 · low" --open-closed 2026-11-04 [--dry-run]
"""
import os
import argparse
import json
import re
import subprocess
from pathlib import Path

REPO_DIR = Path(os.environ.get("REPO_DIR", "."))  # the Challenge repo checkout
REPO = "JakSko/mega-s01e04-before-i-looked"
GH = r"C:\Program Files\GitHub CLI\gh.exe"
NOTE = ("#6 was closed when the link was sent, before the reviewer had looked; it was reopened and "
        "closed again once the review was in (ADR 0003).")


def gh_json(*args):
    r = subprocess.run([GH, *args], capture_output=True, text=True, encoding="utf-8", check=True)
    return json.loads(r.stdout)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--open-worker", required=True)
    p.add_argument("--open-closed", required=True)
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args()

    plan_path = REPO_DIR / "plan.md"
    plan = plan_path.read_text(encoding="utf-8").replace("\r\n", "\n")
    fm = dict(re.findall(r"^(\w+): (.*)$", plan.split("---", 2)[1], re.M))
    assert fm["plan"] == "morning-digest" and fm["status"] == "ready", fm

    issues = gh_json("issue", "list", "-R", REPO, "--state", "all", "--label", "plan:morning-digest",
                     "--json", "number,title,state,body,closedAt,comments", "--limit", "50")
    rows = []
    for i in sorted(issues, key=lambda x: x["number"]):
        blocked = re.search(r"## Blocked by\s*\n\s*\n(.*)", i["body"]).group(1)
        refs = list(dict.fromkeys(re.findall(r"#\d+", blocked)))
        if i["state"] == "CLOSED":
            workers = [m for c in i["comments"] for m in re.findall(r"^worker: (.+)$", c["body"].replace("\r\n", "\n"), re.M)]
            worker, closed = workers[-1].strip(), i["closedAt"][:10]
        else:
            worker, closed = a.open_worker, a.open_closed
        title = i["title"].replace("|", "\\|")
        rows.append(f"| {i['number']} | {title} | {', '.join(refs) if refs else '—'} | {worker} | {closed} |")

    head, body = plan.split("---\n", 2)[1:]
    head = head.replace("status: ready\n", "status: done\n")
    head = head.replace(f"opened: {fm['opened']}\n", f"opened: {fm['opened']}\nclosed: {a.open_closed}\n")
    table = "\n".join(["## Issues", "", "| # | Issue | Blocked by | Worker | Closed |",
                       "|---|-------|-----------|--------|--------|", *rows, "", NOTE, ""])
    done = f"---\n{head}---\n{body.rstrip()}\n\n{table}"
    target = REPO_DIR / "docs" / "plans" / "done" / f"{fm['opened']}-{fm['plan']}.md"
    print(f"target: {target.relative_to(REPO_DIR)}\n")
    print(done.split("## 1.")[0][:400] + "\n...\n" + table)
    if a.dry_run:
        return
    subprocess.run(["git", "mv", "plan.md", str(target.relative_to(REPO_DIR))], cwd=REPO_DIR, check=True)
    target.write_text(done, encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
