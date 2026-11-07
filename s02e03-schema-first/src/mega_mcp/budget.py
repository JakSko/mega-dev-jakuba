"""Daily cap on paid calls, checked before the call (from agent-service store.ts `Budget`).

Two limits: number of calls and bytes of audio per UTC day (bytes are known before the call;
audio seconds only after it). State is a small JSON file
on the volume, so a redeploy does not reset the day.
"""
from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


class Budget:
    def __init__(self, calls_per_day: int, bytes_per_day: int, file: str | None,
                 today: Callable[[], str] = _today):
        self.calls_per_day = calls_per_day
        self.bytes_per_day = bytes_per_day
        self.file = Path(file) if file else None
        self.today = today
        self._mem = {"day": "", "calls": 0, "bytes": 0}
        self._lock = threading.Lock()

    def _read(self) -> dict:
        if not self.file:
            return dict(self._mem)
        try:
            return json.loads(self.file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {"day": self.today(), "calls": 0, "bytes": 0}

    def _write(self, state: dict) -> None:
        if not self.file:
            self._mem = state
            return
        self.file.parent.mkdir(parents=True, exist_ok=True)
        self.file.write_text(json.dumps(state), encoding="utf-8")

    def take(self, nbytes: int) -> bool:
        """Reserve one call of `nbytes` audio. False (and nothing changes) when over the cap."""
        with self._lock:
            s = self._read()
            day = self.today()
            calls, used = (s.get("calls", 0), s.get("bytes", 0)) if s.get("day") == day else (0, 0)
            if calls + 1 > self.calls_per_day or used + nbytes > self.bytes_per_day:
                return False
            self._write({"day": day, "calls": calls + 1, "bytes": used + nbytes})
            return True
