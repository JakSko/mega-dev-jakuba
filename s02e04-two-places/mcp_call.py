"""mcp_call.py - one MCP client for the S02E04 workers (W1 local, W2 cloud).

A worker runs one operation per call; the client keeps no state between calls except the
trace file. Every request and reply is appended, whole, to the trace (one JSON line each).
The job link is a key: it is read from a file (--link-file) or an environment variable
(--link-env), never from argv, and it is masked in every output and trace line.

Rules enforced in code (spec R4, R10, R11):
  --policy job-1   `read` must ask for exactly the fields date, time, clock, line, cause;
                   any `crew` value in a reply is withheld from the output and the trace.
  submit           refused unless --approved-sha equals the sha256 of the canonical JSON of
                   its arguments (`sha` op prints it), and refused after an accepted submit
                   already in the trace.

Operations:
  tools                         list tools (name, description, input schema) and resources
  skills-list                   skills/list (Skills extension)
  load-skill URI [--zip-copy P | --expect-sha H]
                                skills/get + resources/read; verifies size, sha256 digest and
                                frontmatter against the manifest, and the bytes against the zip
                                copy (a file or its sha256); --save writes the served text
  sha TOOL JSON                 prints the sha256 that --approved-sha must carry (no call)
  call TOOL JSON                tools/call; an input-required result is printed, not answered
  resume TOOL JSON --request-state S --input-responses FILE
  whereami                      hostname and egress address (one GET to api.ipify.org)
  summarize --out result.json   builds the result file from the trace (no call)

Exit codes: 0 ok, 2 usage, 3 refused by a rule, 4 the server returned an error.
"""
from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import hashlib
import json
import os
import re
import socket
import sys
import urllib.request
from pathlib import Path
from typing import Any

JOB1_FIELDS = ["date", "time", "clock", "line", "cause"]
WITHHELD = "<withheld: crew>"


# ---------- pure helpers (tested without a server) ----------

def canon(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def args_sha(args: dict[str, Any]) -> str:
    return hashlib.sha256(canon(args).encode("utf-8")).hexdigest()


class Masker:
    """Replaces the link, and the key part of its path, with a label."""

    def __init__(self, link: str | None, label: str):
        self.secrets: list[str] = []
        if link:
            self.secrets.append(link)
            tail = link.rstrip("/").rsplit("/", 1)[-1]
            if len(tail) >= 16:
                self.secrets.append(tail)
        self.label = label

    def text(self, s: str) -> str:
        for sec in self.secrets:
            s = s.replace(sec, self.label)
        return s

    def obj(self, o: Any) -> Any:
        return json.loads(self.text(json.dumps(o, ensure_ascii=False)))


def withhold_crew(o: Any) -> tuple[Any, bool]:
    """Replace the value of every key named crew (any case) with a label."""
    seen = False

    def walk(x: Any) -> Any:
        nonlocal seen
        if isinstance(x, dict):
            out = {}
            for k, v in x.items():
                if isinstance(k, str) and k.lower() == "crew":
                    seen = True
                    out[k] = WITHHELD
                else:
                    out[k] = walk(v)
            return out
        if isinstance(x, list):
            return [walk(v) for v in x]
        if isinstance(x, str) and x.lstrip().startswith(("{", "[")):
            try:
                parsed = json.loads(x)
            except ValueError:
                return x
            new = walk(parsed)
            return json.dumps(new, ensure_ascii=False, indent=2) if new != parsed else x
        return x

    return walk(o), seen


def check_read_policy(args: dict[str, Any]) -> str | None:
    fields = args.get("fields")
    if not isinstance(fields, list) or sorted(fields) != sorted(JOB1_FIELDS) or len(fields) != len(set(fields)):
        return f"read must ask for exactly the fields {JOB1_FIELDS}; got {fields!r}"
    if "crew" in canon(args).lower():
        return "read arguments mention crew"
    return None


def read_trace(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def reply_ok(reply: Any) -> bool:
    return isinstance(reply, dict) and not reply.get("isError") and "inputRequests" not in reply


def accepted_submit(entries: list[dict[str, Any]]) -> dict[str, Any] | None:
    for e in entries:
        if e.get("op") in ("call", "resume") and e.get("tool") == "submit" and reply_ok(e.get("reply")):
            return e
    return None


def find_key(o: Any, name: str) -> Any:
    """First value of a key (any case) in nested dicts/lists, also inside JSON text."""
    if isinstance(o, dict):
        for k, v in o.items():
            if isinstance(k, str) and k.lower() == name.lower():
                return v
        for v in o.values():
            r = find_key(v, name)
            if r is not None:
                return r
    elif isinstance(o, list):
        for v in o:
            r = find_key(v, name)
            if r is not None:
                return r
    elif isinstance(o, str) and o.lstrip().startswith(("{", "[")):
        try:
            return find_key(json.loads(o), name)
        except ValueError:
            return None
    return None


def frontmatter(text: str) -> dict[str, str]:
    m = re.match(r"^---\r?\n(.*?)\r?\n---\r?\n", text, re.S)
    out: dict[str, str] = {}
    if not m:
        return out
    for line in m.group(1).splitlines():
        mm = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", line)
        if mm and mm.group(2):
            out[mm.group(1)] = mm.group(2).strip().strip('"')
    return out


def mask_steps(o: Any) -> Any:
    if isinstance(o, dict):
        return {k: ("<step>" if isinstance(k, str) and "step" in k.lower() and "skill" not in k.lower()
                    and isinstance(v, str) else mask_steps(v)) for k, v in o.items()}
    if isinstance(o, list):
        return [mask_steps(v) for v in o]
    return o


def summarize(entries: list[dict[str, Any]], job: str, worker: str) -> dict[str, Any]:
    sub = accepted_submit(entries)
    last_submit = next((e for e in reversed(entries) if e.get("tool") == "submit"), None)
    skill = next((e for e in reversed(entries) if e.get("op") == "load-skill"), None)
    where = next((e for e in reversed(entries) if e.get("op") == "whereami"), None)
    waiting = next((e for e in reversed(entries) if isinstance(e.get("reply"), dict) and "inputRequests" in e["reply"]), None)
    if sub:
        state = "done"
    elif last_submit and not reply_ok(last_submit.get("reply")):
        state = "failed"
    elif waiting:
        state = "waiting"
    else:
        state = "working"
    submitted = (sub or last_submit or {}).get("args")
    return {
        "job": job,
        "worker": worker,
        "skillVersion": (submitted or {}).get("skillVersion"),
        "skillCheck": (skill or {}).get("reply"),
        "host": (where or {}).get("reply"),
        "mcpRevision": next((e.get("protocol") for e in entries if e.get("protocol")), None),
        "calls": [mask_steps({k: e.get(k) for k in ("time", "op", "tool", "args", "reply", "error", "refused")})
                  for e in entries],
        "submitted": submitted,
        "submitReply": (sub or last_submit or {}).get("reply"),
        "receipt": find_key((sub or {}).get("reply"), "receipt") if sub else None,
        "state": state,
    }


# ---------- MCP side ----------

def dump(m: Any) -> Any:
    return m.model_dump(mode="json", by_alias=True, exclude_none=True) if hasattr(m, "model_dump") else m


CA_ENV = ("SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "NODE_EXTRA_CA_CERTS")


def ssl_context() -> tuple[Any, list[str]]:
    """System trust plus any CA bundle named by the usual env vars (a TLS-intercepting proxy)."""
    import ssl
    ctx = ssl.create_default_context()
    loaded = []
    for var in CA_ENV:
        path = os.environ.get(var)
        if path and Path(path).is_file():
            ctx.load_verify_locations(cafile=path)
            loaded.append(var)
    return ctx, loaded


def describe(e: BaseException) -> str:
    """The real cause: unwraps exception groups and chained causes."""
    if isinstance(e, BaseExceptionGroup):
        return "; ".join(describe(x) for x in e.exceptions)
    msg = f"{type(e).__name__}: {e}"
    cause = e.__cause__ or e.__context__
    return msg + (f" <- {describe(cause)}" if cause is not None and cause is not e else "")


def _client(server: Any):
    from mcp.client.client import Client
    if isinstance(server, str):
        import httpx2
        from mcp.client.streamable_http import streamable_http_client
        ctx, _ = ssl_context()
        http = httpx2.AsyncClient(timeout=httpx2.Timeout(60.0, read=300.0), verify=ctx)
        return Client(streamable_http_client(server, http_client=http))
    return Client(server)


def _protocol(c: Any) -> str | None:
    for obj in (c, getattr(c, "session", None)):
        for name in ("protocol_version", "negotiated_protocol_version", "_protocol_version"):
            v = getattr(obj, name, None)
            if isinstance(v, str):
                return v
    return None


async def _skills_request(c: Any, method: str, params: dict[str, Any]) -> Any:
    import mcp_types as t
    from pydantic import TypeAdapter

    class P(t.RequestParams):
        uri: str | None = None
        cursor: str | None = None

    return await c.session.send_request(t.Request(method=method, params=P(**params)), TypeAdapter(dict))


async def mcp_op(server: Any, op: str, ns: argparse.Namespace, args: dict[str, Any] | None) -> tuple[dict[str, Any], Any]:
    """Runs one MCP operation; returns (trace fields, reply)."""
    async with _client(server) as c:
        extra = {"protocol": _protocol(c)}
        if op == "tools":
            tools = dump(await c.list_tools())
            try:
                res = dump(await c.list_resources())
            except Exception as e:  # resources may be absent
                res = {"error": str(e)}
            return extra, {"tools": tools, "resources": res}
        if op == "skills-list":
            return extra, await _skills_request(c, "skills/list", {})
        if op == "load-skill":
            return extra, await _load_skill(c, ns)
        if op in ("call", "resume"):
            kw: dict[str, Any] = {"allow_input_required": True}
            if op == "resume":
                kw["request_state"] = ns.request_state
                kw["input_responses"] = json.loads(Path(ns.input_responses).read_text(encoding="utf-8"))
            return extra, dump(await c.session.call_tool(ns.tool, args or {}, **kw))
    raise ValueError(op)


async def _load_skill(c: Any, ns: argparse.Namespace) -> dict[str, Any]:
    uri = ns.uri
    out: dict[str, Any] = {"uri": uri}
    try:
        entry = await _skills_request(c, "skills/get", {"uri": uri})
        out["entry"] = entry
    except Exception as e:
        entry = None
        out["skillsGetError"] = str(e)
    rr = dump(await c.read_resource(uri))
    text = next((x.get("text") for x in rr.get("contents", []) if x.get("uri") == uri), None)
    if text is None:
        out["verdict"] = "no text for the uri in resources/read"
        return out
    data = text.encode("utf-8")
    out["size"] = len(data)
    out["sha256"] = hashlib.sha256(data).hexdigest()
    problems = []
    skill = (entry or {}).get("skill") if isinstance(entry, dict) else None
    if skill:
        man = skill.get("resources")
        item = next((r for r in man if r.get("uri") == uri), None) if isinstance(man, list) else None
        if item is None:
            problems.append("SKILL.md not in the manifest")
        else:
            if item.get("size") != len(data):
                problems.append(f"size {len(data)} != manifest {item.get('size')}")
            if item.get("digest") != "sha256:" + out["sha256"]:
                problems.append(f"digest != manifest {item.get('digest')}")
        fm, efm = frontmatter(text), skill.get("frontmatter") or {}
        for k in ("name", "description"):
            if k in efm and str(efm[k]).strip() != fm.get(k, ""):
                problems.append(f"frontmatter {k} differs from the entry")
    else:
        problems.append("no skills/get entry (manifest not checked)")
    if ns.expect_sha:
        out["expectedSha256"] = ns.expect_sha
        if ns.expect_sha != out["sha256"]:
            problems.append("served bytes differ from the zip copy (expected sha256)")
    if ns.zip_copy:
        local = Path(ns.zip_copy).read_bytes()
        out["zipCopySha256"] = hashlib.sha256(local).hexdigest()
        if local != data:
            problems.append("served bytes differ from the zip copy")
    if ns.save:
        Path(ns.save).write_bytes(data)
    out["problems"] = problems
    out["verdict"] = "ok" if not problems else "mismatch"
    return out


def whereami() -> dict[str, Any]:
    with urllib.request.urlopen("https://api.ipify.org?format=json", timeout=20) as r:
        ip = json.loads(r.read().decode())["ip"]
    return {"hostname": socket.gethostname(), "egress": ip}


# ---------- CLI ----------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--worker", required=True)
    p.add_argument("--job", required=True, choices=["job-1", "job-2"])
    p.add_argument("--link-file")
    p.add_argument("--link-env")
    p.add_argument("--trace", required=True)
    p.add_argument("--policy", choices=["job-1", "none"], default="none")
    p.add_argument("--approved-sha")
    p.add_argument("op", choices=["tools", "skills-list", "load-skill", "sha", "call", "resume", "whereami", "summarize"])
    p.add_argument("rest", nargs="*")
    p.add_argument("--zip-copy")
    p.add_argument("--expect-sha", help="sha256 of the zip copy of SKILL.md (no course text needed on the worker)")
    p.add_argument("--save")
    p.add_argument("--request-state")
    p.add_argument("--input-responses")
    p.add_argument("--out")
    return p


def get_link(ns: argparse.Namespace) -> str | None:
    if ns.link_file:
        return Path(ns.link_file).read_text(encoding="utf-8").strip()
    if ns.link_env:
        return os.environ.get(ns.link_env, "").strip() or None
    return None


def main(argv: list[str] | None = None, server: Any = None) -> int:
    ns = build_parser().parse_args(argv)
    trace = Path(ns.trace)
    link = get_link(ns)
    masker = Masker(link, f"<{ns.job} link>")
    target = server if server is not None else link
    args: dict[str, Any] | None = None
    ns.tool = ns.uri = None
    if ns.op in ("call", "resume", "sha"):
        if len(ns.rest) != 2:
            print("usage: call|resume|sha TOOL JSON", file=sys.stderr)
            return 2
        ns.tool, args = ns.rest[0], json.loads(ns.rest[1])
    elif ns.op == "load-skill":
        if len(ns.rest) != 1:
            print("usage: load-skill URI", file=sys.stderr)
            return 2
        ns.uri = ns.rest[0]

    def emit(obj: Any, code: int) -> int:
        print(json.dumps(masker.obj(obj), ensure_ascii=False, indent=2))
        return code

    if ns.op == "sha":
        return emit({"tool": ns.tool, "sha256": args_sha(args or {})}, 0)
    if ns.op == "summarize":
        res = summarize(read_trace(trace), ns.job, ns.worker)
        if ns.out:
            Path(ns.out).write_text(json.dumps(masker.obj(res), ensure_ascii=False, indent=2), encoding="utf-8")
        return emit({"state": res["state"], "receipt": "<present>" if res["receipt"] else None}, 0)

    entry: dict[str, Any] = {"time": dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds"),
                             "worker": ns.worker, "job": ns.job, "op": ns.op, "tool": ns.tool,
                             "uri": ns.uri, "args": args}

    def log(e: dict[str, Any]) -> None:
        trace.parent.mkdir(parents=True, exist_ok=True)
        with trace.open("a", encoding="utf-8") as f:
            f.write(json.dumps(masker.obj(e), ensure_ascii=False) + "\n")

    # rules before any network call
    refused = None
    if ns.op in ("call", "resume"):
        if ns.policy == "job-1" and ns.tool == "read":
            refused = check_read_policy(args or {})
        if ns.tool == "submit" and refused is None:
            if accepted_submit(read_trace(trace)):
                refused = "a submit was already accepted in this trace; no second submit (R11)"
            elif ns.approved_sha != args_sha(args or {}):
                refused = f"submit needs --approved-sha {args_sha(args or {})} (Jakub's yes on these exact arguments, R10)"
    if refused:
        entry["refused"] = refused
        log(entry)
        return emit({"refused": refused}, 3)

    if ns.op == "whereami":
        try:
            entry["reply"] = whereami()
        except Exception as e:
            entry["error"] = describe(e)
        log(entry)
        return emit(entry.get("reply") or {"error": entry.get("error")}, 0 if "reply" in entry else 4)

    if target is None:
        print("no link: pass --link-file or --link-env", file=sys.stderr)
        return 2
    try:
        extra, reply = asyncio.run(mcp_op(target, ns.op, ns, args))
    except Exception as e:  # the course's error goes back whole, masked
        entry["error"] = describe(e)
        log(entry)
        return emit({"error": entry["error"]}, 4)
    entry.update(extra)
    if ns.policy == "job-1":
        reply, seen = withhold_crew(reply)
        if seen:
            entry["crewWithheld"] = True
    entry["reply"] = reply
    log(entry)
    code = 4 if isinstance(reply, dict) and reply.get("isError") else 0
    return emit(reply, code)


if __name__ == "__main__":
    sys.exit(main())
