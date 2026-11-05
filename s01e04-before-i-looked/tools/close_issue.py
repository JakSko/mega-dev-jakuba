"""Close one S01E04 issue with the AGENTS.md closing comment, built from the worker's record.

Usage (python -I -X utf8):
  close_issue.py <n> --done "<one line>" --model <model> --effort <effort> --commit <sha|none> [--dry-run]

Checks before closing:
  - the issue is OPEN and carries the label plan:morning-digest;
  - a commit sha exists on origin main (GitHub API compare: main is ahead of or equal to it);
  - --done is one line.
The comment shape is exactly AGENTS.md step 4:
  done: <what changed, one line>
  worker: <harness> · <model> · <effort>
  commit: <sha or "none">
The comment text and gh's reply are saved in ../out/closing/<n>.md and <n>.json.
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

REPO = "JakSko/mega-s01e04-before-i-looked"
GH = r"C:\Program Files\GitHub CLI\gh.exe"
HARNESS = "claude-code"
LABEL = "plan:morning-digest"
OUT = Path(__file__).resolve().parent.parent / "out" / "closing"


def gh(*args: str) -> str:
    r = subprocess.run([GH, *args], capture_output=True, text=True, encoding="utf-8")
    if r.returncode != 0:
        sys.exit(f"gh {' '.join(args[:3])} failed ({r.returncode}): {r.stderr.strip()}")
    return r.stdout.strip()


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("number", type=int)
    p.add_argument("--done", required=True)
    p.add_argument("--model", required=True)
    p.add_argument("--effort", required=True)
    p.add_argument("--commit", required=True)
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args()

    if "\n" in a.done or not a.done.strip():
        sys.exit("--done must be one non-empty line")
    issue = json.loads(gh("issue", "view", str(a.number), "-R", REPO, "--json", "state,labels,title"))
    if issue["state"] != "OPEN":
        sys.exit(f"issue #{a.number} is {issue['state']}, not OPEN")
    if LABEL not in [l["name"] for l in issue["labels"]]:
        sys.exit(f"issue #{a.number} has no label {LABEL}")

    commit = a.commit
    if commit != "none":
        cmp = json.loads(gh("api", f"repos/{REPO}/compare/{commit}...main", "--jq", "{status: .status, sha: .base_commit.sha}"))
        if cmp["status"] not in ("ahead", "identical"):
            sys.exit(f"commit {commit} is not on main (compare status {cmp['status']})")
        commit = cmp["sha"][:7]

    comment = f"done: {a.done.strip()}\nworker: {HARNESS} · {a.model} · {a.effort}\ncommit: {commit}"
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"{a.number}.md").write_text(comment + "\n", encoding="utf-8", newline="\n")
    print(f"issue #{a.number} ({issue['title']}):\n{comment}")
    if a.dry_run:
        print("dry run: not closed")
        return
    gh("issue", "close", str(a.number), "-R", REPO, "-c", comment)
    after = gh("issue", "view", str(a.number), "-R", REPO, "--json", "state,stateReason,closedAt,comments,url")
    (OUT / f"{a.number}.json").write_text(after + "\n", encoding="utf-8", newline="\n")
    got = json.loads(after)
    last = got["comments"][-1]["body"].replace("\r\n", "\n").strip() if got["comments"] else ""
    print(f"state {got['state']} ({got['stateReason']}) at {got['closedAt']}; comment matches: {last == comment}")


if __name__ == "__main__":
    main()
