"""scripts/upload_file.py against a local server: a big text file goes up and comes back byte-exact."""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import e2e_sdk_client as e2e  # noqa: E402
import upload_file  # noqa: E402
from helpers import OWNER_PASSWORD  # noqa: E402


def test_upload_script_big_text(server, tmp_path):
    data = b"lane abcdefgh\n" + b"2026-10-05T00:00:00+00:00  sched  id=x status=ok\n" * 180000   # about 9 MB
    res = asyncio.run(upload_file.run(server.base, data, "2026-10-05.log", "text/plain", tmp_path / "link.txt",
                                      consent=e2e.consent_bot(OWNER_PASSWORD, "http://127.0.0.1:9/callback")))
    assert not res["is_error"], res
    assert res["get_status"] == 200 and res["bytes_match"] is True, res
    assert res["get_type"].startswith("text/plain") and res["url"].endswith(".txt"), res
