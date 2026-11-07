"""The service: MCP resource server + our authorization server + plan page + file links, one host."""
from __future__ import annotations

import base64
import binascii
import re
import time
from collections import defaultdict, deque
from typing import Annotated, Awaitable, Callable
from urllib.parse import urlparse

import httpx2 as httpx
from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.settings import AuthSettings
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp_types import CallToolResult, TextContent
from pydantic import BaseModel, Field
from starlette.requests import Request
from starlette.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse, Response
from starlette.routing import Route

from . import contract, media, netguard, plan_page
from .budget import Budget
from .config import SCOPE, Config
from .guard import make_log
from .logmw import LogMiddleware
from .oauth import Provider, Verifier, auth_routes
from .store import Store

STATE: dict = {}   # handles for tests (store, budget)

Transcriber = Callable[[bytes, str, str], Awaitable[dict]]


# ----- output types: the SDK turns these into each tool's outputSchema (checked against contract.py) -----
class MemoWriteResult(BaseModel):
    id: str = Field(description="The new note's id.")


class Note(BaseModel):
    id: str
    text: str
    created_at: str = Field(description="UTC time the note was saved, ISO 8601 with Z.")
    client_id: str = Field(description="OAuth client id of the client that wrote the note.")


class MemoSearchResult(BaseModel):
    notes: list[Note] = Field(description="Matching notes, newest first (at most 100).")


class UploadResult(BaseModel):
    url: str = Field(description="Public link to the file, served by this server; no sign-in needed.")


class Segment(BaseModel):
    start: float = Field(ge=0, description="Start time in seconds.")
    end: float = Field(ge=0, description="End time in seconds.")
    text: str


class TranscribeResult(BaseModel):
    segments: list[Segment] = Field(description="Timestamped segments in order.")


def openai_transcriber(cfg: Config) -> Transcriber:
    async def transcribe(data: bytes, filename: str, mime: str) -> dict:
        if not cfg.openai_key:
            raise ToolError("transcription is not configured on this server")
        async with httpx.AsyncClient(timeout=cfg.transcribe_timeout) as client:
            r = await client.post(
                cfg.openai_base + "/audio/transcriptions",
                headers={"Authorization": f"Bearer {cfg.openai_key}"},
                data={"model": "whisper-1", "response_format": "verbose_json", "timestamp_granularities[]": "segment"},
                files={"file": (filename, data, mime)})
        if r.status_code != 200:
            raise ToolError(f"the transcription service answered HTTP {r.status_code}; nothing was transcribed")
        return r.json()
    return transcribe


class RateLimit:
    def __init__(self, per_minute: int):
        self.per_minute = per_minute
        self.calls: dict[str, deque] = defaultdict(deque)

    def check(self, key: str) -> None:
        now = time.time()
        q = self.calls[key]
        while q and q[0] < now - 60:
            q.popleft()
        if len(q) >= self.per_minute:
            raise ToolError("rate limit: too many tool calls this minute, try again shortly")
        q.append(now)


FILE_NAME = re.compile(r"^([A-Za-z0-9_-]{22})\.([a-z0-9]{1,5})$")


def build_app(cfg: Config, transcriber: Transcriber | None = None, log_out: Callable[[str], None] | None = None):
    store = Store(cfg.data_dir)
    budget = Budget(cfg.calls_per_day, cfg.bytes_per_day, str(cfg.data_dir / "transcribe-budget.json"))
    provider = Provider(cfg, store)
    rate = RateLimit(cfg.tool_calls_per_minute)
    transcribe_audio = transcriber or openai_transcriber(cfg)
    STATE.update(store=store, budget=budget, provider=provider, cfg=cfg)

    mcp = MCPServer(
        name="jakub-mega-tools",
        title="Jakub's MCP tools",
        version="0.1.0",
        instructions="Four tools: memo_write and memo_search for notes, upload for public file links, "
                     "transcribe for timestamped text from audio. See the plan page for limits and data kept: "
                     + cfg.public_url + "/plan",
        token_verifier=Verifier(provider),
        auth=AuthSettings(issuer_url=cfg.public_url, resource_server_url=cfg.mcp_url,
                          required_scopes=[SCOPE], validate_token_resource=True),
    )

    def caller() -> tuple[str, str]:
        tok = get_access_token()
        if tok is None or not tok.subject:
            raise ToolError("not signed in")
        rate.check(tok.client_id)
        return tok.subject, tok.client_id

    @mcp.tool(name="memo_write", title="Save a note",
              description="Saves a short text note on this server and returns its id. Notes are private to the owner "
                          "and the clients the owner approved; memo_search finds them again.")
    def memo_write(text: Annotated[str, Field(min_length=1, max_length=contract.MAX_TEXT,
                                              description="The note's text (1 to 20,000 characters).")]
                   ) -> MemoWriteResult:
        owner, client_id = caller()
        return MemoWriteResult(id=store.add_note(owner, client_id, text)["id"])

    @mcp.tool(name="memo_search", title="Find notes",
              description="Finds saved notes. Every word of the query must appear in the note (case-insensitive); an "
                          "empty query lists all notes. Returns notes newest first with id, text, created_at (UTC) and "
                          "client_id of the writer; no match returns an empty list.")
    def memo_search(query: Annotated[str, Field(max_length=contract.MAX_QUERY,
                                                description="Words to look for; empty string lists all notes.")]
                    ) -> MemoSearchResult:
        owner, _ = caller()
        return MemoSearchResult(notes=[Note(**n) for n in store.search_notes(owner, query)])

    @mcp.tool(name="upload", title="Upload a file",
              description="Stores a file on this server and returns a public link anyone can open (no sign-in), served "
                          "by this server. Send the file as base64 in content_base64 with its filename; mime_type is "
                          "optional. Up to 25 MB. An audio link from here can be passed to transcribe.")
    def upload(filename: Annotated[str, Field(min_length=1, max_length=contract.MAX_FILENAME,
                                              description="Original file name, for example talk.mp3. Used only to "
                                                          "guess the type; the stored name is server-made.")],
               content_base64: Annotated[str, Field(min_length=1, description="The file's bytes, base64-encoded.")],
               mime_type: Annotated[str | None, Field(description="Optional content type, for example audio/mpeg.")] = None,
               ) -> UploadResult:
        owner, client_id = caller()
        if len(content_base64) > (contract.MAX_UPLOAD_BYTES * 4) // 3 + 8:
            raise ToolError("the file is too large (over 25 MB)")
        try:
            data = base64.b64decode(content_base64, validate=True)
        except (binascii.Error, ValueError):
            raise ToolError("content_base64 is not valid base64")
        if len(data) > contract.MAX_UPLOAD_BYTES:
            raise ToolError("the file is too large (over 25 MB)")
        mime, ext = media.stored_type(filename, mime_type, data)
        fid = store.add_file(owner, client_id, filename, mime, ext, data)
        return UploadResult(url=f"{cfg.public_url}/files/{fid}.{ext}")

    @mcp.tool(name="transcribe", title="Transcribe audio",
              description="Turns audio at a URL into timestamped text: segments with start and end in seconds. The URL "
                          "must be a public http(s) address or a link from upload. Formats: mp3, mp4, mpeg, mpga, m4a, "
                          "wav, webm; up to 25 MB. Daily limits apply (see the plan page).")
    async def transcribe(url: Annotated[str, Field(min_length=1, max_length=2000,
                                                   description="Public http(s) URL of the audio file.")]
                         ) -> Annotated[CallToolResult, TranscribeResult]:
        caller()
        # Every error names the url and says what is wrong with it (course check 2026-11-06: unhelpful_error).
        shown = url if len(url) <= 200 else url[:200] + "..."
        own_prefix = cfg.public_url + "/files/"
        if url.startswith(own_prefix):
            m = FILE_NAME.match(url[len(own_prefix):])
            found = store.get_file(m.group(1)) if m else None
            if not found:
                raise ToolError(f"{shown}: no such uploaded file on this server")
            info, path = found
            data, ctype, path_part = path.read_bytes(), info["mime"], "." + info["ext"]
        else:
            try:
                data, ctype, final = await netguard.fetch(url, contract.MAX_UPLOAD_BYTES, cfg.fetch_timeout)
            except netguard.FetchError as e:
                raise ToolError(f"{shown}: {e}")
            path_part = urlparse(final).path
        ext = media.audio_ext(ctype, path_part, data)
        if not ext:
            ct = media.normalize(ctype) or "no content type"
            what = "is a web page" if ct in ("text/html", "application/xhtml+xml") else "is not audio"
            raise ToolError(f"{shown} {what} ({ct}): unknown audio format; send mp3, mp4, mpeg, mpga, m4a, wav or webm")
        if not data:
            raise ToolError(f"{shown}: the audio file is empty")
        if not budget.take(len(data)):
            raise ToolError("the daily transcription limit is reached; try again tomorrow (UTC)")
        raw = await transcribe_audio(data, f"audio.{ext}", media.AUDIO_EXT_MIME[ext])
        # Times rounded to 0.01 s: whisper-1 sends float32 values such as 3.5999999046325684.
        segs = [Segment(start=round(float(s["start"]), 2), end=round(float(s.get("end", s["start"])), 2),
                        text=str(s.get("text", "")).strip())
                for s in raw.get("segments") or []]
        if not segs and raw.get("text"):
            segs = [Segment(start=0.0, end=round(float(raw.get("duration") or 0.0), 2), text=str(raw["text"]).strip())]
        result = TranscribeResult(segments=sorted(segs, key=lambda s: s.start))
        # The text block is a one-line summary, not a second copy of the segments: the whole result must stay
        # small (course check 2026-11-06: 1024 B for its calibration clip). The segments are in structuredContent.
        if result.segments:
            summary = (f"{len(result.segments)} segments, {result.segments[0].start:.2f}-"
                       f"{max(s.end for s in result.segments):.2f} s; the timestamped segments are in structuredContent.")
        else:
            summary = "0 segments: no speech found; segments is empty."
        return CallToolResult(content=[TextContent(type="text", text=summary)],
                              structured_content=result.model_dump(mode="json"))

    security = TransportSecuritySettings(enable_dns_rebinding_protection=True,
                                         allowed_hosts=[cfg.host, *cfg.extra_hosts],
                                         allowed_origins=[cfg.public_url])
    # A 25 MB file is about 33.4 MB as base64 inside JSON; the SDK's default body limit is 4 MB.
    app = mcp.streamable_http_app(stateless_http=True, transport_security=security, host="0.0.0.0",
                                  max_request_body_size=36 * 1024 * 1024)

    # ----- our public routes, placed before the SDK's so ours win -----
    prm = {"resource": cfg.mcp_url, "authorization_servers": [cfg.public_url], "scopes_supported": [SCOPE],
           "bearer_methods_supported": ["header"], "resource_name": "Jakub's MCP tools",
           "resource_documentation": cfg.public_url + "/plan"}

    async def protected_resource(request: Request) -> Response:
        return JSONResponse(prm, headers={"Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*"})

    plan_html = plan_page.render(cfg)

    async def plan(request: Request) -> Response:
        return HTMLResponse(plan_html, headers={"Cache-Control": "public, max-age=300"})

    async def health(request: Request) -> Response:
        return PlainTextResponse("ok")

    async def files(request: Request) -> Response:
        m = FILE_NAME.match(request.path_params["name"])
        found = store.get_file(m.group(1)) if m else None
        if not found or found[0]["ext"] != m.group(2):
            return PlainTextResponse("not found", status_code=404)
        info, path = found
        headers = {"X-Content-Type-Options": "nosniff", "Cache-Control": "public, max-age=3600",
                   "Content-Security-Policy": "default-src 'none'; sandbox"}
        if info["mime"] == "application/octet-stream":
            headers["Content-Disposition"] = "attachment"
        return FileResponse(path, media_type=info["mime"], headers=headers)

    ours = [Route("/.well-known/oauth-protected-resource/mcp", protected_resource, methods=["GET"]),
            Route("/.well-known/oauth-protected-resource", protected_resource, methods=["GET"]),
            Route("/plan", plan, methods=["GET"]),
            Route("/health", health, methods=["GET"]),
            Route("/files/{name:str}", files, methods=["GET", "HEAD"]),
            *auth_routes(cfg, store, provider)]
    kept = [r for r in app.router.routes if not getattr(r, "path", "").startswith("/.well-known/")]
    app.router.routes[:] = ours + kept

    secrets_now = lambda: cfg.secrets()  # noqa: E731
    log = make_log(secrets_now, file=cfg.log_file, out=log_out)
    return LogMiddleware(app, log)
