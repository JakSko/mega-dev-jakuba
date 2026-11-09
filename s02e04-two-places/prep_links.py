"""prep_links.py - puts each job link where only its worker reads it (spec C5). Prints no link.

  python prep_links.py w1    REPLY_JSON W1_DIR        -> W1_DIR/.job-link (job-1 link only)
  python prep_links.py jakub REPLY_JSON OUT_FILE      -> OUT_FILE (job-2 link, for Jakub to paste
                                                         into the cloud environment variable JOB_LINK)
  python prep_links.py remove W1_DIR                   -> deletes W1_DIR/.job-link
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path


def link(reply: Path, job: str) -> str:
    return json.loads(reply.read_text(encoding="utf-8"))["jobs"][job]["url"]


def main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[0] == "remove":
        p = Path(argv[1]) / ".job-link"
        existed = p.exists()
        p.unlink(missing_ok=True)
        print(f"removed {p}: {existed}")
        return 0
    if len(argv) != 3 or argv[0] not in ("w1", "jakub"):
        print(__doc__)
        return 2
    mode, reply, dest = argv[0], Path(argv[1]), Path(argv[2])
    job = "job-1" if mode == "w1" else "job-2"
    value = link(reply, job)
    target = dest / ".job-link" if mode == "w1" else dest
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(value + "\n", encoding="utf-8")
    print(f"wrote the {job} link to {target} ({len(value)} chars, sha256 {hashlib.sha256(value.encode()).hexdigest()[:12]})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
