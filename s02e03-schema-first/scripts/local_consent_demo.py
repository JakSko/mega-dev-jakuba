"""Local server on 127.0.0.1:8790 with a TEST owner password, plus one registered client;
prints an authorize URL to open in a browser (to test the consent page by hand). Test only."""
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlencode

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "src"), str(ROOT / "tests")]

from helpers import OAuth, Running, pkce  # noqa: E402
from mega_mcp.app import build_app  # noqa: E402
from mega_mcp.config import Config  # noqa: E402

PORT = 8790
cfg = Config(public_url=f"http://127.0.0.1:{PORT}", data_dir=Path(tempfile.mkdtemp()),
             owner_password="local-test-password-123")
run = Running(build_app(cfg, log_out=lambda line: print(line[:300], flush=True)), PORT, []).start()
c = OAuth(run.base, run.mcp, client_name="Local consent test")
c.register()
_, challenge = pkce()
q = {"response_type": "code", "client_id": c.client_id, "redirect_uri": "http://127.0.0.1:9/callback",
     "code_challenge": challenge, "code_challenge_method": "S256", "state": "abc", "resource": run.mcp}
print("AUTHORIZE_URL", run.base + "/authorize?" + urlencode(q), flush=True)
time.sleep(600)
run.stop()
