"""Run rig from a checkout and check the "Done when" of issues #2-#4 on real HTTP.

Usage (python -I -X utf8):  check_digest.py <checkout> [--port 8791] [--save <file>] [--expect-marker | --expect-no-marker]

Starts `pnpm start` in <checkout> (its own .env decides LANE_MARKER), then checks:
  #2  GET /digest/2026-10-28 is 200 HTML with a table
  #3  GET /api/digest/2026-10-28 has the same jobs, in the same order, as the page table
  #4  every night on the board links to /digest/<night>, and each link renders 200
plus: no <script>, no external src/href, 404 for /digest/nope and /api/digest/nope,
and the banner marker state (never printed: only "set" / "no marker set").
--save writes the exact page bytes of /digest/2026-10-28 to a file (the preview).
The server is stopped (whole process tree) at the end.
"""
import argparse
import html
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

NIGHT = "2026-10-28"


def get(url: str) -> tuple[int, bytes, str]:
    try:
        with urllib.request.urlopen(url, timeout=10) as r:
            return r.status, r.read(), r.headers.get("content-type", "")
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers.get("content-type", "")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("checkout")
    p.add_argument("--port", type=int, default=8791)
    p.add_argument("--save")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--expect-marker", action="store_true")
    g.add_argument("--expect-no-marker", action="store_true")
    a = p.parse_args()
    base = f"http://127.0.0.1:{a.port}"

    # Same command as package.json "start" (tsx --env-file-if-exists=.env src/server.ts), run with node
    # directly because the pnpm.cmd shim does not work from cmd on this machine.
    cmd = ["node", "node_modules/tsx/dist/cli.mjs", "--env-file-if-exists=.env", "src/server.ts"]
    proc = subprocess.Popen(cmd, cwd=a.checkout, env={**__import__("os").environ, "PORT": str(a.port)},
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ok = True
    try:
        deadline = time.time() + 30
        while True:
            try:
                with urllib.request.urlopen(base + "/health", timeout=2) as r:
                    if r.status == 200:
                        break
            except Exception:
                pass
            if time.time() > deadline or proc.poll() is not None:
                sys.exit("server did not answer /health within 30 s")
            time.sleep(0.5)

        def check(name: str, cond: bool, detail: str = "") -> None:
            nonlocal ok
            ok &= cond
            print(f"{'PASS' if cond else 'FAIL'}  {name}{('  - ' + detail) if detail else ''}")

        st, page, ct = get(f"{base}/digest/{NIGHT}")
        text = page.decode("utf-8")
        check("#2 page 200 HTML with a table", st == 200 and "text/html" in ct and "<table" in text, f"{st} {ct}")
        page_jobs = [html.unescape(m) for m in re.findall(r"<tr[^>]*>\s*<td>(.*?)</td>", text, re.S)]
        st, body, ct = get(f"{base}/api/digest/{NIGHT}")
        api = json.loads(body)
        api_jobs = [r["job"] for r in api["rows"]]
        check("#3 JSON same jobs, same order as the page", st == 200 and api_jobs == page_jobs and len(api_jobs) == 5,
              f"{api_jobs}; badLines {api['badLines']}")
        st, board, _ = get(base + "/")
        links = re.findall(r'href="(/digest/[^"]+)"', board.decode("utf-8"))
        rendered = {l: get(base + l)[0] for l in links}
        check("#4 every night on the board links to a digest that renders",
              len(links) == 2 and all(s == 200 for s in rendered.values()), json.dumps(rendered))
        check("404 for /digest/nope and /api/digest/nope",
              get(base + "/digest/nope")[0] == 404 and get(base + "/api/digest/nope")[0] == 404)
        check("page has no <script> and no external src/href",
              "<script" not in text.lower() and not re.findall(r'(?:src|href)="(?:https?:)?//', text))
        marker = re.search(r'<span class="marker">(.*?)</span>', text, re.S).group(1)
        state = "no marker set" if marker == "no marker set" else "set"
        if a.expect_marker:
            check("banner carries the lane marker", state == "set", state)
        elif a.expect_no_marker:
            check('banner reads "no marker set"', state == "no marker set", state)
        else:
            print(f"INFO  banner marker: {state}")
        if a.save:
            open(a.save, "wb").write(page)
            print(f"saved {len(page)} bytes to {a.save}")
    finally:
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
    print("ALL PASS" if ok else "SOME FAILED")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
