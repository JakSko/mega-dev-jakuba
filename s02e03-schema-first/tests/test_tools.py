"""A6 memo, A7 upload, A8 transcribe: results validated against BOTH the published
outputSchema and our contract (two validators: here jsonschema; in step 9 the SDK client)."""
import base64
import json

import httpx2 as httpx
from jsonschema import Draft202012Validator

from helpers import OAuth, call, rpc
from mega_mcp import contract


def published(server, token):
    _, b = rpc(server.mcp, "tools/list", token=token)
    return {t["name"]: t["outputSchema"] for t in b["result"]["tools"]}


def check(server, token, tool, result):
    assert result.get("isError") is not True, result
    sc = result["structuredContent"]
    Draft202012Validator(published(server, token)[tool]).validate(sc)
    Draft202012Validator(contract.OUTPUT[tool]).validate(sc)
    if tool == "transcribe":
        # transcribe: a short summary as the text block, not a second copy of the segments
        # (course check 2026-11-06: whole result must be 1024 B or less)
        texts = [c["text"] for c in result["content"] if c["type"] == "text"]
        assert len(texts) == 1 and len(texts[0]) <= 160 and "segments" in texts[0], texts
    else:
        # the same JSON as a text block (spec R5)
        assert any(c["type"] == "text" and json.loads(c["text"]) == sc for c in result["content"])
    return sc


def is_error(result, needle=""):
    assert result.get("isError") is True, result
    assert "structuredContent" not in result or result["structuredContent"] is None
    text = " ".join(c.get("text", "") for c in result["content"])
    assert needle.lower() in text.lower(), text
    return text


# ---------- A6 memo ----------

def test_a6_write_then_search(server, owner):
    t = owner["access_token"]
    w = check(server, t, "memo_write", call(server.mcp, t, "memo_write", {"text": "first pelican note"}))
    check(server, t, "memo_write", call(server.mcp, t, "memo_write", {"text": "second pelican note"}))
    s = check(server, t, "memo_search", call(server.mcp, t, "memo_search", {"query": "pelican"}))
    assert [n["text"] for n in s["notes"]][:2] == ["second pelican note", "first pelican note"]  # newest first
    assert w["id"] in [n["id"] for n in s["notes"]]
    n = s["notes"][0]
    assert n["created_at"].endswith("Z") and n["client_id"] == owner["client"].client_id


def test_a6_empty_query_lists_all_and_no_match_is_empty(server, owner):
    t = owner["access_token"]
    call(server.mcp, t, "memo_write", {"text": "zebra"})
    allnotes = check(server, t, "memo_search", call(server.mcp, t, "memo_search", {"query": ""}))
    assert allnotes["notes"][0]["text"] == "zebra"
    none = check(server, t, "memo_search", call(server.mcp, t, "memo_search", {"query": "no-such-word-xyz"}))
    assert none == {"notes": []}


def test_a6_owner_isolation(server):
    from mega_mcp.app import STATE
    tok = STATE["store"].issue_access("someone-else", "c9", ["mcp"], server.mcp, ttl=3600)
    s = call(server.mcp, tok, "memo_search", {"query": ""})
    assert s["structuredContent"] == {"notes": []}


def test_a6_bad_input_is_tool_error(server, owner):
    r = call(server.mcp, owner["access_token"], "memo_write", {"text": ""})
    assert r["isError"] is True


# ---------- A7 upload ----------

def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


WAV = b"RIFF" + (36).to_bytes(4, "little") + b"WAVEfmt " + b"\x10\x00\x00\x00\x01\x00\x01\x00" + b"\x40\x1f\x00\x00\x80\x3e\x00\x00\x02\x00\x10\x00" + b"data\x00\x00\x00\x00"


def test_a7_upload_exact_bytes_public(server, owner):
    t = owner["access_token"]
    data = b"plain text file\n" * 10
    u = check(server, t, "upload", call(server.mcp, t, "upload",
                                         {"filename": "notes.txt", "content_base64": b64(data)}))
    assert u["url"].startswith(server.base + "/files/") and u["url"].endswith(".txt")
    r = httpx.get(u["url"])  # no token: anyone can open it
    assert r.status_code == 200 and r.content == data
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["content-type"].startswith("text/plain")


def test_a7_path_tricks_stay_in_store(server, owner):
    t = owner["access_token"]
    for name in ("../../etc/passwd", "C:\\Windows\\win.ini", "/abs/path.txt"):
        u = call(server.mcp, t, "upload", {"filename": name, "content_base64": b64(b"x")})["structuredContent"]
        tail = u["url"].rsplit("/", 1)[1]
        assert ".." not in tail and "/" not in tail and "\\" not in tail
    assert httpx.get(server.base + "/files/..%2F..%2Fsecret.txt").status_code == 404
    assert httpx.get(server.base + "/files/nope.txt").status_code == 404


def test_a7_html_not_served_as_html(server, owner):
    t = owner["access_token"]
    u = call(server.mcp, t, "upload", {"filename": "x.html", "content_base64": b64(b"<script>alert(1)</script>"),
                                       "mime_type": "text/html"})["structuredContent"]
    r = httpx.get(u["url"])
    assert "html" not in r.headers["content-type"] and "javascript" not in r.headers["content-type"]


def test_a7_type_from_bytes(server, owner):
    t = owner["access_token"]
    u = call(server.mcp, t, "upload", {"filename": "recording", "content_base64": b64(WAV)})["structuredContent"]
    assert u["url"].endswith(".wav")
    assert httpx.get(u["url"]).headers["content-type"] == "audio/wav"


def test_a7_oversize_and_bad_base64(server, owner):
    t = owner["access_token"]
    big = b64(b"\0" * (contract.MAX_UPLOAD_BYTES + 1))
    is_error(call(server.mcp, t, "upload", {"filename": "big.bin", "content_base64": big}), "too large")
    is_error(call(server.mcp, t, "upload", {"filename": "a.txt", "content_base64": "!!!not base64!!!"}), "base64")


# ---------- A8 transcribe ----------

def test_a8_transcribe_own_upload(server, owner, fake_openai):
    t = owner["access_token"]
    u = call(server.mcp, t, "upload", {"filename": "voice", "content_base64": b64(WAV)})["structuredContent"]
    r = check(server, t, "transcribe", call(server.mcp, t, "transcribe", {"url": u["url"]}))
    starts = [s["start"] for s in r["segments"]]
    assert starts == sorted(starts) and all(isinstance(x, (int, float)) for x in starts)
    assert r["segments"][0]["text"] == "hello world."
    assert fake_openai.calls[-1]["filename"].endswith(".wav")


def test_a8_private_addresses_refused(server, owner):
    t = owner["access_token"]
    for url in ("http://127.0.0.1:1/a.mp3", "http://169.254.169.254/latest/meta-data", "http://10.0.0.1/a.wav",
                "file:///etc/passwd", "http://localhost/a.mp3", "ftp://example.com/a.mp3"):
        is_error(call(server.mcp, t, "transcribe", {"url": url}))


def test_a8_daily_cap(server, owner, fake_openai):
    from mega_mcp.app import STATE
    t = owner["access_token"]
    u = call(server.mcp, t, "upload", {"filename": "v.wav", "content_base64": b64(WAV)})["structuredContent"]
    budget = STATE["budget"]
    saved = budget.calls_per_day
    budget.calls_per_day = 0
    try:
        is_error(call(server.mcp, t, "transcribe", {"url": u["url"]}), "daily")
    finally:
        budget.calls_per_day = saved


def test_a8_unknown_format_refused(server, owner):
    t = owner["access_token"]
    u = call(server.mcp, t, "upload", {"filename": "data", "content_base64": b64(b"\x00\x01binary")})["structuredContent"]
    text = is_error(call(server.mcp, t, "transcribe", {"url": u["url"]}), "unknown audio format")
    assert u["url"] in text and "mp3, mp4, mpeg, mpga, m4a, wav or webm" in text, text


def test_a8_errors_name_the_url(server, owner):
    t = owner["access_token"]
    page = call(server.mcp, t, "upload", {"filename": "page.html", "content_base64": b64(b"<!doctype html><p>hi")}
                )["structuredContent"]["url"]
    for url in (page, "http://127.0.0.1:1/a.mp3", server.base + "/files/AAAAAAAAAAAAAAAAAAAAAA.mp3"):
        assert url in is_error(call(server.mcp, t, "transcribe", {"url": url}))
    long_url = "https://example.invalid/" + "a" * 1900 + ".mp3"
    text = is_error(call(server.mcp, t, "transcribe", {"url": long_url}))
    assert long_url[:150] in text and len(text) < 500, len(text)


def test_a8_result_fits_1024_bytes(server, owner, fake_openai):
    """Course check 2026-11-06: the whole tools/call result for its calibration clip must be 1024 B or less.
    Here: six float32-noisy segments (like whisper-1), measured as the whole JSON-RPC body."""
    t = owner["access_token"]
    u = call(server.mcp, t, "upload", {"filename": "v.wav", "content_base64": b64(WAV)})["structuredContent"]
    words = ["This is the calibration clip.", "It has a few short sentences.", "Each one becomes a segment.",
             "Times come back as floats.", "Some carry float noise.", "That is the end."]
    segs, start = [], 0.0
    for i, w in enumerate(words):
        end = start + 1.7999999523162842
        segs.append({"id": i, "start": start + 0.0000000953674316, "end": end, "text": " " + w})
        start = end + 0.20000000298023224
    fake_openai.next_reply = {"text": " ".join(words), "duration": start, "segments": segs}
    status, body = rpc(server.mcp, "tools/call", {"name": "transcribe", "arguments": {"url": u["url"]}}, token=t)
    assert status == 200
    size = len(json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode())
    assert size <= 1024, size
    sc = check(server, t, "transcribe", body["result"])
    assert [s["start"] for s in sc["segments"]][:2] == [0.0, 2.0]
    assert sc["segments"][0]["end"] == 1.8
