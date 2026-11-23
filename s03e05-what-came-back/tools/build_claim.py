"""Build a claim-challenge body from our groups file, the session file and the receipts (spec R12).

Usage:
  python -I -X utf8 build_claim.py --step 1 --groups <groups.json> --session <session.txt> --contract <start reply.json>
        --out <claim.json> [--owner-code-file <file>]
  python -I -X utf8 build_claim.py --step 2 ... --receipt-file <batchReceipt file> [--with-rule]

Takes only our groups file (never pack text) as content. Keeps from each group only the fields the
contract names (name, signals, verb, who, confidence, note); fields starting with "_" stay local.
Checks the body against the submit shape in the start reply. Without an owner code file the body
gets a placeholder and is marked NOT READY: it must never be sent like that.
Writes the exact body to --out and prints it with the session, code and receipt masked.
"""
import argparse
import json
import sys

VERBS = {"expand", "revise", "simplify", "revert", "investigate", "stop"}
PLACEHOLDER = "OWNER-CODE-PENDING"
GROUP_KEYS = ("name", "signals", "verb", "who", "confidence", "note")


def mask(s):
    s = str(s)
    return s[:6] + "..." + s[-4:] if len(s) > 12 else "***"


def read_one(path):
    with open(path, encoding="utf-8") as f:
        v = f.read().strip()
    if not v or "\n" in v:
        sys.exit(f"ERROR: {path} must hold one value on one line")
    return v


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--step", type=int, required=True, choices=(1, 2))
    ap.add_argument("--groups", required=True)
    ap.add_argument("--session", required=True)
    ap.add_argument("--contract", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--owner-code-file")
    ap.add_argument("--receipt-file")
    ap.add_argument("--with-rule", action="store_true")
    a = ap.parse_args()

    contract = json.load(open(a.contract, encoding="utf-8"))["submit"][f"step{a.step}"]["answer"]
    src = json.load(open(a.groups, encoding="utf-8"))
    groups = []
    for g in src["groups"]:
        groups.append({k: g[k] for k in GROUP_KEYS if k in g})

    body = {"session": read_one(a.session), "step": a.step, "groups": groups}
    ready = True
    if a.step == 1:
        body["pick"] = src["pick"]
        if a.owner_code_file:
            body["ownerCode"] = read_one(a.owner_code_file)
        else:
            body["ownerCode"] = PLACEHOLDER
            ready = False
        body["rule"] = src["rule"]
    else:
        if not a.receipt_file:
            sys.exit("ERROR: step 2 needs --receipt-file (the batchReceipt from the accepted step 1)")
        body = {"session": body["session"], "step": 2, "batchReceipt": read_one(a.receipt_file), "groups": groups}
        if a.with_rule:
            body["rule"] = src["rule"]

    # shape check against the contract
    problems = []
    want = {k.rstrip("?") for k in contract}
    required = {k for k in contract if not k.endswith("?")}
    for k in required:
        if k not in body:
            problems.append(f"missing field {k}")
    for k in body:
        if k not in want:
            problems.append(f"field {k} is not in the contract")
    gwant = {k.rstrip("?") for k in contract["groups"][0]}
    for n, g in enumerate(groups, 1):
        for k in g:
            if k not in gwant:
                problems.append(f"group {n}: field {k} not in the contract")
        for k in ("name", "signals", "verb", "who", "note"):
            if not g.get(k):
                problems.append(f"group {n}: empty {k}")
        if g.get("verb") not in VERBS:
            problems.append(f"group {n}: verb {g.get('verb')!r}")
        if g.get("who") not in ("agent", "owner"):
            problems.append(f"group {n}: who {g.get('who')!r}")
    if a.step == 1 and not str(body.get("rule", "")).strip():
        problems.append("empty rule")
    if a.step == 1 and not str(body.get("pick", "")).strip():
        problems.append("empty pick")

    with open(a.out, "w", encoding="utf-8", newline="\n") as f:
        json.dump(body, f, indent=2, ensure_ascii=False)
    shown = dict(body)
    shown["session"] = mask(body["session"])
    if "ownerCode" in shown and shown["ownerCode"] != PLACEHOLDER:
        shown["ownerCode"] = mask(shown["ownerCode"])
    if "batchReceipt" in shown:
        shown["batchReceipt"] = mask(shown["batchReceipt"])
    print(json.dumps(shown, indent=2, ensure_ascii=False))
    print(f"bytes: {len(json.dumps(body, ensure_ascii=False).encode('utf-8'))}")
    for p in problems:
        print("  " + p)
    print("shape: ok" if not problems else f"shape: FAIL ({len(problems)})")
    print("READY to send" if ready and not problems else "NOT READY: placeholder or shape problem, do not send")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
