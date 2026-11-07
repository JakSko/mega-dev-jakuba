"""Secret scan (spec A13, plan steps 15 and 23). Prints counts only, never a secret.

Looks for: the host's real secrets (OWNER_PASSWORD, OPENAI_API_KEY, read from Railway into
memory and never printed), OpenAI key shapes, and our unmasked token/code shapes
(mat_/mrt_/mac_ followed by 20+ characters) in:
  - the host log (railway logs, last N lines),
  - every file tracked in this repo,
  - the given extra files or folders (captured responses, evidence).

  python scripts/secret_scan.py [--lines 2000] [--extra-values-file F] <paths...>
--extra-values-file: a local file with more values to look for, one per line (for example
`note` and `noteA` from private/), also never printed.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

SHAPES = {
    "openai key shape": re.compile(r"\bsk-[A-Za-z0-9_-]{20,}"),
    "unmasked access token": re.compile(r"\bmat_[A-Za-z0-9_-]{20,}"),
    "unmasked refresh token": re.compile(r"\bmrt_[A-Za-z0-9_-]{20,}"),
    "unmasked auth code": re.compile(r"\bmac_[A-Za-z0-9_-]{20,}"),
}


def railway(*args: str) -> str:
    return subprocess.run(["railway", *args], capture_output=True, text=True, encoding="utf-8",
                          errors="replace", shell=sys.platform == "win32").stdout


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--lines", type=int, default=2000)
    ap.add_argument("--extra-values-file")
    ap.add_argument("paths", nargs="*")
    a = ap.parse_args()

    vars_ = json.loads(railway("variable", "list", "--service", "mcp", "--json") or "{}")
    values = {"OWNER_PASSWORD": vars_.get("OWNER_PASSWORD", ""), "OPENAI_API_KEY": vars_.get("OPENAI_API_KEY", "")}
    if a.extra_values_file:
        for i, line in enumerate(Path(a.extra_values_file).read_text(encoding="utf-8").splitlines()):
            if len(line.strip()) >= 6:
                values[f"extra value {i + 1}"] = line.strip()
    values = {k: v for k, v in values.items() if len(v) >= 6}

    sources: dict[str, str] = {"host log": railway("logs", "--service", "mcp", "--lines", str(a.lines))}
    tracked = subprocess.run(["git", "ls-files"], capture_output=True, text=True).stdout.split()
    for f in tracked:
        sources[f"repo:{f}"] = Path(f).read_text(encoding="utf-8", errors="replace")
    for p in a.paths:
        pp = Path(p)
        for f in ([pp] if pp.is_file() else [x for x in pp.rglob("*") if x.is_file()]):
            if f.suffix.lower() in (".wav", ".mp3", ".png", ".jpg"):
                continue
            sources[str(f)] = f.read_text(encoding="utf-8", errors="replace")

    hits = 0
    print(f"secret scan: {len(values)} known values, {len(SHAPES)} shapes, {len(sources)} sources "
          f"(host log {len(sources['host log'].splitlines())} lines)")
    for name, text in sources.items():
        for k, v in values.items():
            if v in text:
                hits += 1
                print(f"HIT  {k} in {name}")
        for k, rx in SHAPES.items():
            n = len(rx.findall(text))
            if n:
                hits += n
                print(f"HIT  {k} x{n} in {name}")
    print("RESULT: clean" if hits == 0 else f"RESULT: {hits} hits")
    return 0 if hits == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
