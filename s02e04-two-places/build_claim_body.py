"""build_claim_body.py - the claim-challenge body from both result files (spec R7).

  python build_claim_body.py --uuid UUID --job1 private/job-1/result.json --job2 private/job-2/result.json
                             --merge-file out/merge.txt --out out/claim-body.json

merge.txt holds the merge value exactly (one trailing newline is dropped). The receipts are
copied from each result file as they are; the printout masks them.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def build(uuid: str, r1: dict, r2: dict, merge: str) -> dict:
    for want, r in (("job-1", r1), ("job-2", r2)):
        if r.get("job") != want:
            raise SystemExit(f"result file for {want} says job {r.get('job')!r}")
        if r.get("state") != "done" or not r.get("receipt"):
            raise SystemExit(f"{want}: state {r.get('state')!r}, receipt present: {bool(r.get('receipt'))}")
    if not merge.strip():
        raise SystemExit("empty merge value")
    return {"uuid": uuid, "receipts": {"job-1": r1["receipt"], "job-2": r2["receipt"]}, "answer": {"merge": merge}}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    for a in ("--uuid", "--job1", "--job2", "--merge-file", "--out"):
        p.add_argument(a, required=True)
    ns = p.parse_args(argv)
    r1 = json.loads(Path(ns.job1).read_text(encoding="utf-8"))
    r2 = json.loads(Path(ns.job2).read_text(encoding="utf-8"))
    merge = Path(ns.merge_file).read_text(encoding="utf-8")
    if merge.endswith("\n"):
        merge = merge[:-1]
    body = build(ns.uuid, r1, r2, merge)
    Path(ns.out).parent.mkdir(parents=True, exist_ok=True)
    Path(ns.out).write_text(json.dumps(body, ensure_ascii=False, indent=2), encoding="utf-8")
    shown = {**body, "receipts": {k: f"<{k} receipt, {len(str(v))} chars>" for k, v in body["receipts"].items()}}
    print(json.dumps(shown, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
