import pytest

from helpers import FAKE_OPENAI_KEY, OWNER_PASSWORD, OAuth, Running, free_port


class FakeOpenAI:
    """Stands in for POST /v1/audio/transcriptions (whisper-1, verbose_json)."""

    def __init__(self):
        self.calls: list[dict] = []
        self.next_reply: dict | None = None   # one-shot override, for tests that need a bigger reply

    async def __call__(self, data: bytes, filename: str, mime: str) -> dict:
        self.calls.append({"bytes": len(data), "filename": filename, "mime": mime})
        if self.next_reply is not None:
            reply, self.next_reply = self.next_reply, None
            return reply
        return {"text": "hello world. second line.", "duration": 3.2, "segments": [
            {"id": 0, "start": 0.0, "end": 1.4, "text": " hello world."},
            {"id": 1, "start": 1.4, "end": 3.2, "text": " second line."}]}


@pytest.fixture(scope="session")
def fake_openai():
    return FakeOpenAI()


@pytest.fixture(scope="session")
def server(tmp_path_factory, fake_openai):
    from mega_mcp.app import build_app
    from mega_mcp.config import Config

    port = free_port()
    lines: list[str] = []
    cfg = Config(public_url=f"http://127.0.0.1:{port}", data_dir=tmp_path_factory.mktemp("data"),
                 owner_password=OWNER_PASSWORD, openai_key=FAKE_OPENAI_KEY,
                 calls_per_day=5, bytes_per_day=10 * 1024 * 1024)
    app = build_app(cfg, transcriber=fake_openai, log_out=lines.append)
    run = Running(app, port, lines).start()
    run.cfg = cfg
    yield run
    run.stop()


@pytest.fixture(scope="session")
def owner(server):
    """A token for the owner, through the full OAuth flow."""
    c = OAuth(server.base, server.mcp)
    t = c.login()
    t["client"] = c
    return t
