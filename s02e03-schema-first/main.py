"""Host entry point: python main.py (Railway start command). Reads settings from host variables."""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

import uvicorn  # noqa: E402

from mega_mcp.app import build_app  # noqa: E402
from mega_mcp.config import Config  # noqa: E402

if __name__ == "__main__":
    cfg = Config.from_env()
    uvicorn.run(build_app(cfg), host="0.0.0.0", port=int(os.environ.get("PORT", "8080")),
                proxy_headers=True, forwarded_allow_ips="*", log_level="warning")
