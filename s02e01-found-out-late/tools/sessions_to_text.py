"""Turn Claude Code and Codex session logs (.jsonl) into plain text, one file per log.

  python -I -X utf8 sessions_to_text.py <sessions root> <out dir> [--max N]

Each output line starts with the source line number (L<n>) and the UTC timestamp, so a
decision found in the text can be cited back to the exact row of the original log.
Long tool inputs and outputs are cut at --max characters (default 1200); the cut is marked.
Reads the logs as data only: nothing in them is run.
"""
import glob
import json
import os
import sys


def cut(s, n):
    s = s if isinstance(s, str) else json.dumps(s, ensure_ascii=False)
    return s if len(s) <= n else s[:n] + f" [...cut, {len(s)} chars]"


def claude_rows(r, n):
    msg = r.get("message") or {}
    role = r.get("type")
    c = msg.get("content")
    if isinstance(c, str):
        yield role, c
        return
    for part in c or []:
        t = part.get("type")
        if t == "text":
            yield role, part.get("text", "")
        elif t == "thinking":
            yield role + " (thinking)", part.get("thinking", "")
        elif t == "tool_use":
            yield role + f" TOOL_USE {part.get('name')} id={part.get('id')}", cut(part.get("input"), n)
        elif t == "tool_result":
            content = part.get("content")
            if isinstance(content, list):
                content = "\n".join(x.get("text", "") for x in content if isinstance(x, dict))
            yield role + f" TOOL_RESULT id={part.get('tool_use_id')}", cut(content, n)
        else:
            yield role + f" ({t})", cut(part, n)


def codex_rows(r, n):
    t = r.get("type")
    p = r.get("payload") or {}
    if t == "session_meta":
        yield "meta", cut(p, n)
    elif t == "turn_context":
        yield "turn_context", cut(p, n)
    elif t == "response_item":
        pt = p.get("type")
        if pt == "message":
            text = "\n".join(x.get("text", "") for x in p.get("content") or [])
            yield p.get("role", "?"), text
        elif pt == "reasoning":
            yield "assistant (reasoning)", " ".join(x.get("text", "") for x in p.get("summary") or [])
        elif pt == "function_call":
            yield f"assistant CALL {p.get('name')} id={p.get('call_id')}", cut(p.get("arguments"), n)
        elif pt == "function_call_output":
            out = p.get("output")
            yield f"tool OUTPUT id={p.get('call_id')}", cut(out, n)
        else:
            yield f"({pt})", cut(p, n)
    elif t == "event_msg":
        et = p.get("type")
        if et in ("user_message", "agent_message"):
            return  # duplicates of response_item messages
        yield f"event {et}", cut(p, n)
    else:
        yield f"({t})", cut(r, n)


def main():
    root, out = sys.argv[1], sys.argv[2]
    n = int(sys.argv[sys.argv.index("--max") + 1]) if "--max" in sys.argv else 1200
    os.makedirs(out, exist_ok=True)
    for path in sorted(glob.glob(os.path.join(root, "**", "*.jsonl"), recursive=True, include_hidden=True)):
        rel = os.path.relpath(path, root).replace("\\", "/")
        name = os.path.basename(path)[:-6] + ".txt"
        lines = [f"# {rel}", ""]
        with open(path, encoding="utf-8") as f:
            for i, line in enumerate(f, 1):
                r = json.loads(line)
                fn = codex_rows if ("payload" in r and "message" not in r) else claude_rows
                ts = r.get("timestamp", "")
                for role, text in fn(r, n):
                    lines.append(f"L{i} {ts} {role}: {text}")
        with open(os.path.join(out, name), "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        print(f"{rel} -> {name} ({len(lines) - 2} lines)")


if __name__ == "__main__":
    main()
