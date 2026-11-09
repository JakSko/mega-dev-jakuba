"""Fake job servers for the S02E04 tests. Fake data only; shapes guessed from the two skills.

job-1: search (scope, cursor, step) -> paged entries; read (id, fields, step); redact (text, step);
       submit (text, skillVersion, step). The archive holds a tram-3 drill; ops/live holds the
       real tram-3 entry on page 1 of 2. read returns crew only if asked, unless leak_crew=True.
job-2: transcribe (url) -> segments; memo_write (text, step); memo_search (query, step);
       submit (notes, skillVersion, step).
Every tool but transcribe needs the step token from the last reply. Both serve the skill as
`skill://<name>/SKILL.md` with skills/get and skills/list (Skills extension).
"""
from __future__ import annotations

import hashlib
import itertools
from typing import Any

import mcp_types as t
from mcp.server.extension import Extension, MethodBinding
from mcp.server.mcpserver import MCPServer

SKILL1 = "---\nname: incident-lookup\ndescription: Fake job 1 skill.\nmetadata:\n  version: \"1\"\n---\n\n# incident-lookup\n\nsearch, read, redact, submit.\n"
SKILL2 = "---\nname: voice-to-memo\ndescription: Fake job 2 skill.\nmetadata:\n  version: \"1\"\n---\n\n# voice-to-memo\n\ntranscribe, memo_write, memo_search, submit.\n"

LIVE = {"L3": {"date": "2026-11-01", "time": "23:41", "clock": "UTC", "line": "tram-3",
               "cause": "feed refresh stalled; driver Jan Kowalski reported it", "crew": "Jan Kowalski"},
        "L1": {"date": "2026-11-01", "time": "22:10", "clock": "UTC", "line": "tram-1", "cause": "door fault", "crew": "Ann Lee"},
        "L7": {"date": "2026-11-01", "time": "23:55", "clock": "UTC", "line": "tram-7", "cause": "hold", "crew": "Bo Ng"}}
ARCHIVE = {"D3": {"date": "2025-11-01", "time": "23:00", "clock": "UTC", "line": "tram-3", "cause": "drill", "crew": "X Y"}}
SEGMENTS = [{"offset": "0:05", "text": "Start of shift notes."},
            {"offset": "0:12", "text": "At 00:41 local tram-3 froze, feed refresh stalled."},
            {"offset": "0:30", "text": "Tram-1 door fault, then reset."},
            {"offset": "0:47", "text": "Tram-3 froze again at 01:10 local."}]


class GetParams(t.RequestParams):
    uri: str | None = None
    cursor: str | None = None


class Skills(Extension):
    identifier = "io.modelcontextprotocol/skills"

    def __init__(self, name: str, text: str, digest_override: str | None = None):
        self.name, self.text, self.digest_override = name, text, digest_override

    def entry(self) -> dict[str, Any]:
        data = self.text.encode()
        uri = f"skill://{self.name}/SKILL.md"
        return {"uri": uri, "frontmatter": {"name": self.name, "description": self.text.split("description: ")[1].split("\n")[0]},
                "resources": [{"uri": uri, "digest": self.digest_override or "sha256:" + hashlib.sha256(data).hexdigest(),
                               "size": len(data)}]}

    def methods(self):
        async def get(ctx, params):
            return {"resultType": "complete", "skill": self.entry(), "ttlMs": 1000, "cacheScope": "private"}

        async def lst(ctx, params):
            return {"resultType": "complete", "skills": [self.entry()], "ttlMs": 1000, "cacheScope": "private"}

        return [MethodBinding("skills/get", GetParams, get), MethodBinding("skills/list", GetParams, lst)]


class Steps:
    def __init__(self) -> None:
        self.n = itertools.count(1)
        self.current: str | None = None

    def check(self, step: str | None) -> None:
        if self.current is not None and step != self.current:
            raise ValueError("step token missing or stale: start again from step 1")

    def next(self) -> str:
        self.current = f"k-{next(self.n)}"
        return self.current


def build_job1(leak_crew: bool = False, skill_text: str = SKILL1, digest_override: str | None = None) -> MCPServer:
    s = MCPServer("fake-job-1", extensions=[Skills("incident-lookup", skill_text, digest_override)])
    st = Steps()
    submitted: list[str] = []

    @s.resource("skill://incident-lookup/SKILL.md", mime_type="text/markdown")
    def skill() -> str:
        return skill_text

    @s.tool(name="search")
    def search(scope: str = "archive", cursor: str | None = None, step: str | None = None) -> dict[str, Any]:
        st.check(step)
        src = LIVE if scope == "ops/live" else ARCHIVE
        ids = sorted(src)
        page = ids[:2] if cursor is None else ids[2:]
        out: dict[str, Any] = {"entries": [{"id": i, "line": src[i]["line"], "date": src[i]["date"]} for i in page],
                               "step": st.next()}
        if cursor is None and len(ids) > 2:
            out["nextCursor"] = "p2"
        return out

    @s.tool(name="read")
    def read(id: str, fields: list[str], step: str | None = None) -> dict[str, Any]:
        st.check(step)
        rec = {**LIVE, **ARCHIVE}[id]
        out = {f: rec[f] for f in fields if f in rec}
        if leak_crew:
            out["crew"] = rec["crew"]
        return {"record": out, "step": st.next()}

    @s.tool(name="redact")
    def redact(text: str, step: str | None = None) -> dict[str, Any]:
        st.check(step)
        return {"text": text.replace("driver Jan Kowalski", "driver [redacted]"), "step": st.next()}

    @s.tool(name="submit")
    def submit(text: str, skillVersion: str, step: str | None = None) -> dict[str, Any]:
        st.check(step)
        submitted.append(text)
        return {"accepted": True, "result": "record accepted", "receipt": f"rcpt-1-{len(submitted)}", "step": st.next()}

    s.submitted = submitted  # type: ignore[attr-defined]
    return s


def build_job2(skill_text: str = SKILL2) -> MCPServer:
    s = MCPServer("fake-job-2", extensions=[Skills("voice-to-memo", skill_text)])
    st = Steps()
    notes: list[str] = []

    @s.resource("skill://voice-to-memo/SKILL.md", mime_type="text/markdown")
    def skill() -> str:
        return skill_text

    @s.tool(name="transcribe")
    def transcribe(url: str) -> dict[str, Any]:
        st.current = None
        return {"segments": SEGMENTS, "step": st.next()}

    @s.tool(name="memo_write")
    def memo_write(text: str, step: str | None = None) -> dict[str, Any]:
        st.check(step)
        notes.append(text)
        return {"saved": True, "count": len(notes), "step": st.next()}

    @s.tool(name="memo_search")
    def memo_search(query: str | None = None, step: str | None = None) -> dict[str, Any]:
        st.check(step)
        return {"notes": [n for n in notes if not query or query in n], "step": st.next()}

    @s.tool(name="submit")
    def submit(notes_text: str, skillVersion: str, step: str | None = None) -> dict[str, Any]:
        st.check(step)
        return {"accepted": True, "result": "notes accepted", "receipt": "rcpt-2", "step": st.next()}

    return s
