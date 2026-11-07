"""Secrets never leave the host: every log line passes through here.

Ported from mega-dev/tools/agent-service/src/guard.ts (S01E05): mask known secrets and
anything shaped like a key, refuse outgoing text that holds one, log whole messages as
one JSON line each (S01E05 snag 4: a lost message cannot be read again).
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

KEY_SHAPES = [
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}"),
    re.compile(r"Bearer\s+[A-Za-z0-9._~+/=-]{16,}", re.IGNORECASE),
    # our own token and code prefixes (see auth_server.py)
    re.compile(r"\b(?:mat|mrt|mac)_[A-Za-z0-9_-]{16,}"),
]
MIN_SECRET = 8


def mask(text: str, secrets: list[str]) -> str:
    out = text
    for s in secrets:
        if s and len(s) >= MIN_SECRET:
            out = out.replace(s, "<secret>")
    for p in KEY_SHAPES:
        out = p.sub("<key-shaped>", out)
    return out


def holds_secret(text: str, secrets: list[str]) -> str | None:
    for s in secrets:
        if s and len(s) >= MIN_SECRET and s in text:
            return "holds a secret"
    for p in KEY_SHAPES:
        if p.search(text):
            return "holds something shaped like a key"
    return None


Log = Callable[[dict[str, Any]], None]


def make_log(secrets: Callable[[], list[str]], file: str | None = None, cut: int = 8000,
             out: Callable[[str], None] | None = None) -> Log:
    """`secrets` is a callable so values added later (for example a course note) are masked too."""
    write = out or (lambda line: print(line, file=sys.stdout, flush=True))

    def log(entry: dict[str, Any]) -> None:
        e: dict[str, Any] = {"at": datetime.now(timezone.utc).isoformat(timespec="milliseconds"), **entry}
        for k, v in list(e.items()):
            if isinstance(v, str):
                e[k] = v[:cut]
        line = mask(json.dumps(e, ensure_ascii=False, default=str), secrets())
        write(line)
        if file:
            Path(file).parent.mkdir(parents=True, exist_ok=True)
            with open(file, "a", encoding="utf-8") as f:
                f.write(line + "\n")

    return log
