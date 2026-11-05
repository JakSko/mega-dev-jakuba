"""Append one sent request and its reply to log.md, after checking both against the SHA-256 the browser computed.

usage: log_entry.py <challenge_dir> <keep: all | 0,2,...> <reply_file> <body_sha> <reply_sha> <status> <sent_at> <note>
The body is rebuilt the way the browser built it: JSON.stringify({from, compactedMessage}) of page paragraphs.
"""
import hashlib
import json
import pathlib
import sys

d, keep, reply_file, body_sha, reply_sha, status, sent_at, note = sys.argv[1:9]
d = pathlib.Path(d)
sha = lambda b: hashlib.sha256(b).hexdigest()

paras = (d / "rook-message-page-copy.txt").read_text(encoding="utf-8").split("\n\n")
idx = range(len(paras)) if keep == "all" else [int(i) for i in keep.split(",")]
body = json.dumps({"from": "rook", "compactedMessage": "\n\n".join(paras[i] for i in idx)},
                  ensure_ascii=False, separators=(",", ":"))
reply = (d / reply_file).read_bytes().rstrip(b"\n")

assert sha(body.encode("utf-8")) == body_sha, "body differs from what the browser sent"
assert sha(reply) == reply_sha, "reply file differs from what the server returned"

with open(d / "log.md", "a", encoding="utf-8") as f:
    f.write(f"\n## {sent_at} POST https://hq.mega.dev/challenges/where-the-story-begins/api\n\n{note}\n\n"
            f"Sent from the signed-in built-in browser (fetch, credentials included). "
            f"Body SHA-256 {body_sha}, reply SHA-256 {reply_sha}, both verified.\n\n"
            f"Request body:\n\n```json\n{body}\n```\n\nReply (HTTP {status}):\n\n```json\n{reply.decode('utf-8')}\n```\n")
print("logged, both hashes verified")
