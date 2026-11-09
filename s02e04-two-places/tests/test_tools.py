"""Tests for mcp_call.py, check_result.py and build_claim_body.py against fake job servers."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build_claim_body  # noqa: E402
import check_result  # noqa: E402
import fake_job_server as fake  # noqa: E402
import mcp_call  # noqa: E402

FIELDS = ["date", "time", "clock", "line", "cause"]


class Worker:
    """Plays a worker: one mcp_call per step, step token carried by hand."""

    def __init__(self, server, tmp: Path, job: str, policy: str = "none"):
        self.server, self.job, self.policy = server, job, policy
        self.trace = tmp / f"trace-{job}.jsonl"
        self.step = None

    def run(self, capsys, *rest, approved=None, extra=()):
        argv = ["--worker", "T", "--job", self.job, "--trace", str(self.trace), "--policy", self.policy]
        if approved:
            argv += ["--approved-sha", approved]
        code = mcp_call.main(argv + list(rest) + list(extra), server=self.server)
        out = json.loads(capsys.readouterr().out)
        return code, out

    def call(self, capsys, tool, args, approved=None):
        if self.step and tool != "transcribe":
            args = {**args, "step": self.step}
        code, out = self.run(capsys, "call", tool, json.dumps(args), approved=approved)
        sc = out.get("structuredContent") if isinstance(out, dict) else None
        if sc and sc.get("step"):
            self.step = sc["step"]
        return code, out, args

    def sha(self, args):
        return mcp_call.args_sha(args)


def skill_copy(tmp: Path, text: str) -> Path:
    p = tmp / "SKILL.md"
    p.write_bytes(text.encode())
    return p


def job1_happy(capsys, tmp, server=None):
    w = Worker(server or fake.build_job1(), tmp, "job-1", policy="job-1")
    code, out = w.run(capsys, "load-skill", "skill://incident-lookup/SKILL.md", extra=["--zip-copy", str(skill_copy(tmp, fake.SKILL1))])
    assert code == 0 and out["verdict"] == "ok", out
    _, out, _ = w.call(capsys, "search", {"scope": "ops/live"})
    assert out["structuredContent"]["nextCursor"] == "p2"
    w.call(capsys, "search", {"scope": "ops/live", "cursor": "p2"})
    _, out, _ = w.call(capsys, "read", {"id": "L3", "fields": FIELDS})
    rec = out["structuredContent"]["record"]
    text = "\n".join(f"{k}: {rec[k]}" for k in FIELDS)
    _, out, _ = w.call(capsys, "redact", {"text": text})
    red = out["structuredContent"]["text"]
    sub = {"text": red, "skillVersion": "1", "step": w.step}
    return w, sub


def test_load_skill_detects_zip_and_manifest_mismatch(capsys, tmp_path):
    w = Worker(fake.build_job1(), tmp_path, "job-1")
    code, out = w.run(capsys, "load-skill", "skill://incident-lookup/SKILL.md", extra=["--zip-copy", str(skill_copy(tmp_path, fake.SKILL1 + "x"))])
    assert out["verdict"] == "mismatch" and "served bytes differ from the zip copy" in out["problems"]
    w2 = Worker(fake.build_job1(digest_override="sha256:00"), tmp_path, "job-1")
    code, out = w2.run(capsys, "load-skill", "skill://incident-lookup/SKILL.md")
    assert any("digest" in p for p in out["problems"])


def test_read_with_crew_is_refused_before_any_call(capsys, tmp_path):
    w = Worker(fake.build_job1(), tmp_path, "job-1", policy="job-1")
    code, out, _ = w.call(capsys, "read", {"id": "L3", "fields": FIELDS + ["crew"]})
    assert code == 3 and "exactly the fields" in out["refused"]
    entry = mcp_call.read_trace(w.trace)[-1]
    assert entry["refused"] and "reply" not in entry


def test_crew_leaked_by_server_is_withheld(capsys, tmp_path):
    w = Worker(fake.build_job1(leak_crew=True), tmp_path, "job-1", policy="job-1")
    w.call(capsys, "search", {"scope": "ops/live"})
    code, out, _ = w.call(capsys, "read", {"id": "L3", "fields": FIELDS})
    assert "Jan Kowalski" not in json.dumps(out) or out["structuredContent"]["record"]["crew"] == mcp_call.WITHHELD
    assert out["structuredContent"]["record"]["crew"] == mcp_call.WITHHELD
    assert mcp_call.read_trace(w.trace)[-1]["crewWithheld"] is True
    assert "\"crew\": \"Jan Kowalski\"" not in w.trace.read_text(encoding="utf-8")


def test_submit_gate_and_no_second_submit(capsys, tmp_path):
    w, sub = job1_happy(capsys, tmp_path)
    code, out, _ = w.call(capsys, "submit", {k: v for k, v in sub.items() if k != "step"})
    assert code == 3 and "--approved-sha" in out["refused"]
    code, out, _ = w.call(capsys, "submit", {k: v for k, v in sub.items() if k != "step"}, approved="0" * 64)
    assert code == 3
    good = sub
    code, out, _ = w.call(capsys, "submit", {k: v for k, v in good.items() if k != "step"}, approved=w.sha(good))
    assert code == 0 and out["structuredContent"]["receipt"] == "rcpt-1-1"
    code, out, args = w.call(capsys, "submit", {k: v for k, v in good.items() if k != "step"}, approved="x")
    assert code == 3 and "no second submit" in out["refused"]
    assert w.server.submitted == [good["text"]]


def test_link_is_masked_everywhere(tmp_path):
    link = "https://jobs.example/k/SECRETSECRETSECRETSECRET"
    m = mcp_call.Masker(link, "<job-1 link>")
    o = m.obj({"err": f"failed {link}", "tail": "SECRETSECRETSECRETSECRET"})
    assert "SECRET" not in json.dumps(o)


def test_link_only_from_file_or_env(tmp_path, monkeypatch):
    f = tmp_path / ".job-link"
    f.write_text("https://x/k/abc\n")
    ns = mcp_call.build_parser().parse_args(["--worker", "W", "--job", "job-1", "--trace", "t", "--link-file", str(f), "tools"])
    assert mcp_call.get_link(ns) == "https://x/k/abc"
    monkeypatch.setenv("JOB_LINK", "https://y/l")
    ns = mcp_call.build_parser().parse_args(["--worker", "W", "--job", "job-2", "--trace", "t", "--link-env", "JOB_LINK", "tools"])
    assert mcp_call.get_link(ns) == "https://y/l"


def test_job1_check_result_pending_then_done(capsys, tmp_path):
    w, sub = job1_happy(capsys, tmp_path)
    pend = tmp_path / "pending.json"
    pend.write_text(json.dumps(sub))
    rows = check_result.run("job-1", mcp_call.read_trace(w.trace), None, sub)
    assert all(s != "FAIL" for s, _ in rows), rows
    w.call(capsys, "submit", {k: v for k, v in sub.items() if k != "step"}, approved=w.sha(sub))
    res = mcp_call.summarize(mcp_call.read_trace(w.trace), "job-1", "T")
    assert res["state"] == "done" and res["receipt"] == "rcpt-1-1"
    assert all(c.get("args", {}) is None or c["args"].get("step") in (None, "<step>") for c in res["calls"])
    rows = check_result.run("job-1", mcp_call.read_trace(w.trace), res, None)
    assert all(s != "FAIL" for s, _ in rows), rows


def test_job1_check_result_catches_changed_text_and_archive_scope(capsys, tmp_path):
    w, sub = job1_happy(capsys, tmp_path)
    bad = {**sub, "text": sub["text"] + " "}
    rows = check_result.run("job-1", mcp_call.read_trace(w.trace), None, bad)
    assert ("FAIL", "submitted text equals the last redact reply byte for byte") in rows
    w2 = Worker(fake.build_job1(), tmp_path / "b", "job-1", policy="job-1")
    w2.call(capsys, "search", {"scope": "archive"})
    rows = check_result.run("job-1", mcp_call.read_trace(w2.trace), None, sub)
    assert ("FAIL", "search used scope ops/live") in rows


def job2_run(capsys, tmp, notes):
    w = Worker(fake.build_job2(), tmp, "job-2")
    w.run(capsys, "load-skill", "skill://voice-to-memo/SKILL.md", extra=["--zip-copy", str(skill_copy(tmp, fake.SKILL2))])
    w.call(capsys, "transcribe", {"url": "https://example/clip.mp3"})
    for n in notes:
        w.call(capsys, "memo_write", {"text": n})
    w.call(capsys, "memo_search", {})
    return w


def test_job2_happy_and_format_checks(capsys, tmp_path):
    notes = ["tram-3 froze, feed refresh stalled, at 00:41 local @0:12", "tram-1 door fault @0:30",
             "tram-1 reset @0:30", "tram-3 froze again at 01:10 local @0:47"]
    w = job2_run(capsys, tmp_path, notes)
    sub = {"notes_text": "\n".join(notes), "skillVersion": "1", "step": w.step}
    rows = check_result.run("job-2", mcp_call.read_trace(w.trace), None, sub)
    assert all(s != "FAIL" for s, _ in rows), rows
    code, out, _ = w.call(capsys, "submit", {k: v for k, v in sub.items() if k != "step"}, approved=w.sha(sub))
    assert code == 0
    res = mcp_call.summarize(mcp_call.read_trace(w.trace), "job-2", "T")
    assert res["receipt"] == "rcpt-2"


def test_job2_catches_bad_note_and_duplicates(capsys, tmp_path):
    w = job2_run(capsys, tmp_path, ["tram-3 froze @0:12 and @0:13", "tram-1 fault @0:30", "tram-1 fault @0:30"])
    sub = {"notes_text": "tram-3 froze @0:12 and @0:13\ntram-1 fault @0:30\ntram-1 fault @0:30", "skillVersion": "1"}
    rows = dict((m, s) for s, m in check_result.run("job-2", mcp_call.read_trace(w.trace), None, sub))
    assert any(s == "FAIL" and m.startswith("every note is") for m, s in rows.items())
    assert rows["no duplicate lines in the submitted notes"] == "FAIL"


def test_build_claim_body(tmp_path):
    r1 = {"job": "job-1", "state": "done", "receipt": "R1"}
    r2 = {"job": "job-2", "state": "done", "receipt": "R2"}
    body = build_claim_body.build("u", r1, r2, "tram-3 froze @0:12")
    assert body == {"uuid": "u", "receipts": {"job-1": "R1", "job-2": "R2"}, "answer": {"merge": "tram-3 froze @0:12"}}
    with pytest.raises(SystemExit):
        build_claim_body.build("u", r2, r1, "x")
    with pytest.raises(SystemExit):
        build_claim_body.build("u", {**r1, "state": "waiting"}, r2, "x")
