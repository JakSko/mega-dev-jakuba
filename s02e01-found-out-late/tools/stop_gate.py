"""Stop gate: before the agent may stop, look at the live sources again.

Claude Code runs this as a `Stop` command hook (course check-lane "loop", S02E01). It reads the
hook's JSON on stdin (session_id, stop_hook_active), then for every watch in watch.json:
fetches the live source with curl and compares its sha256 with the accepted baseline, after
replacing signed-link tokens (v1.<payload>.<sig>), which the course issues fresh on every fetch.

  - all unchanged (or no watch.json, or no watches) -> prints nothing, exit 0: the agent stops
  - a source changed -> prints {"decision": "block", "reason": "..."}: the agent looks again
  - guard: if stop_hook_active is true and nothing changed since the last block, or after
    MAX_BLOCKS blocks in one session, it lets the agent stop (never an endless loop)
  - a fetch error does not block (the reason is kept in the state file), so a dead network
    never traps the agent

  python -I -X utf8 stop_gate.py                 hook mode (stdin JSON)
  python -I -X utf8 stop_gate.py --status        show each watch: baseline vs live
  python -I -X utf8 stop_gate.py --accept NAME   set NAME's baseline to the live body (after a
                                                 person has seen the change)

watch.json (git-ignored; paths only, never a token):
  {"watches": [{"name": "...", "url_file": "<abs path to a JSON file holding the url>",
                "url_key": ["sessions", "url"], "baseline": "<abs path to the accepted body>"}]}
Each fetch is one GET to the source. Sends nothing else; writes only state/ and, on --accept,
the baseline file.
"""
import hashlib
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WATCH = os.path.join(HERE, "watch.json")
STATE = os.path.join(HERE, "state")
MAX_BLOCKS = 3


TOKEN = re.compile(rb"v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+")


def sha(b):
    return hashlib.sha256(b).hexdigest()


def norm(b):
    """Signed links are issued fresh on every fetch; compare the body without their tokens."""
    return TOKEN.sub(b"v1.<token>", b)


def load_watches():
    try:
        with open(WATCH, encoding="utf-8") as f:
            return json.load(f).get("watches", [])
    except FileNotFoundError:
        return []


def url_of(w):
    with open(w["url_file"], encoding="utf-8") as f:
        v = json.load(f)
    for k in w["url_key"]:
        v = v[k]
    return v


def fetch(url):
    r = subprocess.run(["curl", "-sS", "-L", "--max-time", "15", "-f", url], capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.decode("utf-8", "replace").strip()[:200] or f"curl exit {r.returncode}")
    return r.stdout


def baseline(w):
    try:
        with open(w["baseline"], "rb") as f:
            return f.read()
    except FileNotFoundError:
        return b""


def check():
    """Return (changed names, errors, live bodies by name)."""
    changed, errors, live = [], [], {}
    for w in load_watches():
        try:
            body = fetch(url_of(w))
        except Exception as e:  # noqa: BLE001 - any fetch failure lets the agent stop
            errors.append(f"{w['name']}: {e}")
            continue
        live[w["name"]] = body
        if sha(norm(body)) != sha(norm(baseline(w))):
            changed.append(w["name"])
    return changed, errors, live


def state_path(session_id):
    os.makedirs(STATE, exist_ok=True)
    safe = "".join(c for c in (session_id or "unknown") if c.isalnum() or c in "-_")[:80]
    return os.path.join(STATE, safe + ".json")


def hook():
    try:
        data = json.load(sys.stdin)
    except Exception:  # noqa: BLE001
        data = {}
    sp = state_path(data.get("session_id"))
    try:
        with open(sp, encoding="utf-8") as f:
            st = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        st = {"blocks": 0, "last": ""}
    changed, errors, live = check()
    st["errors"] = errors
    key = sha(json.dumps(sorted((n, sha(norm(live[n]))) for n in changed)).encode())
    decision = None
    if changed:
        if data.get("stop_hook_active") and key == st.get("last"):
            pass  # already sent back for this same change: let it stop
        elif st.get("blocks", 0) >= MAX_BLOCKS:
            pass  # guard: a few rounds at most
        else:
            st["blocks"] = st.get("blocks", 0) + 1
            st["last"] = key
            decision = {
                "decision": "block",
                "reason": "stop gate: a live source changed since its accepted baseline: "
                + ", ".join(changed)
                + ". Read it again, tell the human what changed, and run "
                "`python -I -X utf8 mega-dev/tools/stop-gate/stop_gate.py --accept <name>` only after they have seen it.",
            }
    with open(sp, "w", encoding="utf-8") as f:
        json.dump(st, f)
    if decision:
        print(json.dumps(decision))
    return 0


def main():
    if "--status" in sys.argv:
        changed, errors, live = check()
        for w in load_watches():
            n = w["name"]
            b = baseline(w)
            l = live.get(n)
            print(f"{n}: baseline {sha(norm(b))[:12] if b else 'none'} ({len(b)} B), live "
                  + (f"{sha(norm(l))[:12]} ({len(l)} B)" if l is not None else "fetch failed")
                  + ("  CHANGED" if n in changed else ""))
        for e in errors:
            print("error:", e)
        return 0
    if "--accept" in sys.argv:
        name = sys.argv[sys.argv.index("--accept") + 1]
        for w in load_watches():
            if w["name"] == name:
                body = fetch(url_of(w))
                os.makedirs(os.path.dirname(w["baseline"]), exist_ok=True)
                with open(w["baseline"], "wb") as f:
                    f.write(body)
                print(f"{name}: baseline set to {sha(body)[:12]} ({len(body)} B)")
                return 0
        print(f"no watch named {name!r}")
        return 1
    return hook()


if __name__ == "__main__":
    sys.exit(main())
