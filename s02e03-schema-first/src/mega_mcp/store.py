"""SQLite on the volume: OAuth clients, pending consents, codes, tokens, notes, file records.

Tokens and codes are stored as SHA-256 hashes, so a copy of the database holds no usable token.
"""
from __future__ import annotations

import hashlib
import json
import secrets
import sqlite3
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS clients (client_id TEXT PRIMARY KEY, info TEXT NOT NULL, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS pending (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, params TEXT NOT NULL, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS codes (hash TEXT PRIMARY KEY, data TEXT NOT NULL, expires_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, kind TEXT NOT NULL, subject TEXT NOT NULL, client_id TEXT NOT NULL,
    scopes TEXT NOT NULL, resource TEXT, expires_at INTEGER NOT NULL, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, owner TEXT NOT NULL, client_id TEXT NOT NULL, text TEXT NOT NULL,
    created_at TEXT NOT NULL, seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, owner TEXT NOT NULL, client_id TEXT NOT NULL, filename TEXT NOT NULL,
    mime TEXT NOT NULL, ext TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS notes_owner ON notes(owner, seq);
"""


def h(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


class Store:
    MAX_CLIENTS = 500

    def __init__(self, data_dir: Path):
        data_dir.mkdir(parents=True, exist_ok=True)
        (data_dir / "files").mkdir(exist_ok=True)
        self.files_dir = data_dir / "files"
        self.db = sqlite3.connect(data_dir / "mega.sqlite3", check_same_thread=False, isolation_level=None)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(SCHEMA)
        self.lock = threading.Lock()

    def q(self, sql: str, args: tuple = ()) -> list[tuple]:
        with self.lock:
            return self.db.execute(sql, args).fetchall()

    # ----- clients -----
    def save_client(self, client_id: str, info_json: str) -> None:
        if self.q("SELECT COUNT(*) FROM clients")[0][0] >= self.MAX_CLIENTS:
            raise ValueError("too many registered clients")
        self.q("INSERT OR REPLACE INTO clients VALUES (?,?,?)", (client_id, info_json, time.time()))

    def get_client(self, client_id: str) -> str | None:
        rows = self.q("SELECT info FROM clients WHERE client_id=?", (client_id,))
        return rows[0][0] if rows else None

    # ----- pending consents -----
    def add_pending(self, client_id: str, params: dict) -> str:
        pid = secrets.token_urlsafe(24)
        self.q("DELETE FROM pending WHERE created_at < ?", (time.time() - 900,))
        self.q("INSERT INTO pending VALUES (?,?,?,?)", (pid, client_id, json.dumps(params), time.time()))
        return pid

    def get_pending(self, pid: str) -> tuple[str, dict] | None:
        rows = self.q("SELECT client_id, params, created_at FROM pending WHERE id=?", (pid,))
        if not rows or rows[0][2] < time.time() - 900:
            return None
        return rows[0][0], json.loads(rows[0][1])

    def drop_pending(self, pid: str) -> None:
        self.q("DELETE FROM pending WHERE id=?", (pid,))

    # ----- codes (single use) -----
    def add_code(self, data: dict, ttl: int) -> str:
        code = "mac_" + secrets.token_urlsafe(32)
        self.q("INSERT INTO codes VALUES (?,?,?)", (h(code), json.dumps(data), time.time() + ttl))
        return code

    def get_code(self, code: str) -> dict | None:
        rows = self.q("SELECT data, expires_at FROM codes WHERE hash=?", (h(code),))
        if not rows:
            return None
        d = json.loads(rows[0][0])
        d["expires_at"] = rows[0][1]
        return d

    def drop_code(self, code: str) -> None:
        self.q("DELETE FROM codes WHERE hash=?", (h(code),))

    # ----- tokens -----
    def _issue(self, kind: str, prefix: str, subject: str, client_id: str, scopes: list[str], resource: str | None,
               ttl: int) -> str:
        tok = prefix + secrets.token_urlsafe(32)
        self.q("INSERT INTO tokens VALUES (?,?,?,?,?,?,?,?)",
               (h(tok), kind, subject, client_id, " ".join(scopes), resource, int(time.time()) + ttl, time.time()))
        return tok

    def issue_access(self, subject: str, client_id: str, scopes: list[str], resource: str | None, ttl: int) -> str:
        return self._issue("access", "mat_", subject, client_id, scopes, resource, ttl)

    def issue_refresh(self, subject: str, client_id: str, scopes: list[str], resource: str | None, ttl: int) -> str:
        return self._issue("refresh", "mrt_", subject, client_id, scopes, resource, ttl)

    def get_token(self, tok: str, kind: str) -> dict | None:
        rows = self.q("SELECT subject, client_id, scopes, resource, expires_at FROM tokens WHERE hash=? AND kind=?",
                      (h(tok), kind))
        if not rows:
            return None
        s, c, sc, r, e = rows[0]
        return {"subject": s, "client_id": c, "scopes": sc.split() if sc else [], "resource": r, "expires_at": e}

    def drop_token(self, tok: str) -> None:
        self.q("DELETE FROM tokens WHERE hash=?", (h(tok),))

    # ----- notes -----
    def add_note(self, owner: str, client_id: str, text: str) -> dict:
        nid = "n_" + secrets.token_urlsafe(12)
        created = utc_now()
        with self.lock:
            seq = (self.db.execute("SELECT COALESCE(MAX(seq),0)+1 FROM notes").fetchone()[0])
            self.db.execute("INSERT INTO notes VALUES (?,?,?,?,?,?)", (nid, owner, client_id, text, created, seq))
        return {"id": nid, "text": text, "created_at": created, "client_id": client_id}

    def search_notes(self, owner: str, query: str, limit: int = 100) -> list[dict]:
        if query.strip():
            words = query.lower().split()
            rows = self.q("SELECT id, text, created_at, client_id FROM notes WHERE owner=? ORDER BY seq DESC", (owner,))
            hits = [r for r in rows if all(w in r[1].lower() for w in words)]
        else:
            hits = self.q("SELECT id, text, created_at, client_id FROM notes WHERE owner=? ORDER BY seq DESC LIMIT ?",
                          (owner, limit))
        return [{"id": i, "text": t, "created_at": c, "client_id": cl} for i, t, c, cl in hits[:limit]]

    # ----- files -----
    def add_file(self, owner: str, client_id: str, filename: str, mime: str, ext: str, data: bytes) -> str:
        fid = secrets.token_urlsafe(16)
        (self.files_dir / fid).write_bytes(data)
        self.q("INSERT INTO files VALUES (?,?,?,?,?,?,?,?)",
               (fid, owner, client_id, filename, mime, ext, len(data), utc_now()))
        return fid

    def get_file(self, fid: str) -> tuple[dict, Path] | None:
        rows = self.q("SELECT mime, ext, size FROM files WHERE id=?", (fid,))
        if not rows:
            return None
        path = (self.files_dir / fid).resolve()
        if path.parent != self.files_dir.resolve() or not path.is_file():
            return None
        return {"mime": rows[0][0], "ext": rows[0][1], "size": rows[0][2]}, path
