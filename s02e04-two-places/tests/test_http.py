"""End-to-end over Streamable HTTP: mcp_call.py as a subprocess, link from a file, masked output."""
from __future__ import annotations

import json
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import uvicorn

TOOLS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS))
import fake_job_server as fake  # noqa: E402


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def test_http_end_to_end(tmp_path):
    port = free_port()
    server = fake.build_job1()
    app = server.streamable_http_app(stateless_http=True)
    cfg = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
    uv = uvicorn.Server(cfg)
    th = threading.Thread(target=uv.run, daemon=True)
    th.start()
    for _ in range(100):
        if uv.started:
            break
        time.sleep(0.05)
    try:
        secret = "v1.TESTKEYTESTKEYTESTKEY"
        link_file = tmp_path / ".job-link"
        link_file.write_text(f"http://127.0.0.1:{port}/mcp?k={secret}\n")
        trace = tmp_path / "trace.jsonl"
        base = [sys.executable, str(TOOLS / "mcp_call.py"), "--worker", "W1", "--job", "job-1",
                "--link-file", str(link_file), "--trace", str(trace), "--policy", "job-1"]
        r = subprocess.run(base + ["tools"], capture_output=True, text=True, timeout=60)
        assert r.returncode == 0, r.stderr
        names = [t["name"] for t in json.loads(r.stdout)["tools"]["tools"]]
        assert {"search", "read", "redact", "submit"} <= set(names)
        r = subprocess.run(base + ["load-skill", "skill://incident-lookup/SKILL.md"], capture_output=True, text=True, timeout=60)
        assert json.loads(r.stdout)["verdict"] == "ok", r.stdout + r.stderr
        r = subprocess.run(base + ["call", "search", json.dumps({"scope": "ops/live"})], capture_output=True, text=True, timeout=60)
        assert json.loads(r.stdout)["structuredContent"]["nextCursor"] == "p2"
        alltext = trace.read_text(encoding="utf-8") + r.stdout + r.stderr
        assert secret not in alltext and str(port) not in trace.read_text(encoding="utf-8")
    finally:
        uv.should_exit = True
        th.join(timeout=10)
