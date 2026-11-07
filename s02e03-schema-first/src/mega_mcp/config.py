"""Settings from host variables. Secrets come only from the environment, never from files in the repo."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

SCOPE = "mcp"


@dataclass
class Config:
    public_url: str                      # https://<host>, no trailing slash; issuer and base of every link
    data_dir: Path                       # the volume: SQLite file and uploaded files
    owner_password: str                  # Jakub signs in with it on the consent page
    openai_key: str | None = None
    openai_base: str = "https://api.openai.com/v1"
    calls_per_day: int = 40              # paid transcription calls per UTC day
    bytes_per_day: int = 200 * 1024 * 1024
    access_ttl: int = 3600               # 1 hour: outlasts the course's whole check (spec R4)
    refresh_ttl: int = 30 * 24 * 3600
    code_ttl: int = 300
    fetch_timeout: float = 30.0
    transcribe_timeout: float = 120.0
    tool_calls_per_minute: int = 60
    log_file: str | None = None
    extra_hosts: list[str] = field(default_factory=list)

    def __post_init__(self):
        self.public_url = self.public_url.rstrip("/")
        self.data_dir = Path(self.data_dir)
        if len(self.owner_password) < 12:
            raise ValueError("OWNER_PASSWORD must have at least 12 characters")

    @property
    def mcp_url(self) -> str:
        return self.public_url + "/mcp"

    @property
    def host(self) -> str:
        return urlparse(self.public_url).netloc

    @classmethod
    def from_env(cls) -> "Config":
        e = os.environ
        return cls(
            public_url=e["PUBLIC_URL"],
            data_dir=Path(e.get("DATA_DIR", "/data")),
            owner_password=e["OWNER_PASSWORD"],
            openai_key=e.get("OPENAI_API_KEY") or None,
            calls_per_day=int(e.get("TRANSCRIBE_CALLS_PER_DAY", "40")),
            bytes_per_day=int(e.get("TRANSCRIBE_BYTES_PER_DAY", str(200 * 1024 * 1024))),
            log_file=e.get("LOG_FILE") or None,
        )

    def secrets(self) -> list[str]:
        return [s for s in (self.owner_password, self.openai_key) if s]
