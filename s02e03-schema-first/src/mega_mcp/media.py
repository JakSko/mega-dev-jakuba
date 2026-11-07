"""File types: what we store and serve (upload, spec R7) and what OpenAI accepts (transcribe, R8)."""
from __future__ import annotations

import mimetypes

# OpenAI speech-to-text, read 2026-11-06: "Supported input formats are mp3, mp4, mpeg, mpga, m4a, wav, and webm."
AUDIO_EXT_MIME = {"mp3": "audio/mpeg", "mp4": "audio/mp4", "mpeg": "audio/mpeg", "mpga": "audio/mpeg",
                  "m4a": "audio/mp4", "wav": "audio/wav", "webm": "audio/webm"}
AUDIO_MIME_EXT = {"audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mpga": "mp3", "audio/wav": "wav", "audio/x-wav": "wav",
                  "audio/wave": "wav", "audio/vnd.wave": "wav", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/m4a": "m4a",
                  "video/mp4": "mp4", "audio/webm": "webm", "video/webm": "webm"}

# Types we serve as they are. Anything else (HTML, SVG, scripts, XML ...) is served as a download.
SAFE_SERVE = {"text/plain", "text/csv", "text/markdown", "application/pdf", "application/json", "image/png", "image/jpeg",
              "image/gif", "image/webp", "audio/mpeg", "audio/wav", "audio/mp4", "audio/webm", "audio/ogg", "audio/flac",
              "video/mp4", "video/webm", "application/octet-stream"}
EXT_FOR = {"text/plain": "txt", "text/csv": "csv", "text/markdown": "md", "application/pdf": "pdf", "application/json": "json",
           "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "audio/mpeg": "mp3",
           "audio/wav": "wav", "audio/mp4": "m4a", "audio/webm": "webm", "audio/ogg": "ogg", "audio/flac": "flac",
           "video/mp4": "mp4", "video/webm": "webm", "application/octet-stream": "bin"}
NORMALIZE = {"audio/x-wav": "audio/wav", "audio/wave": "audio/wav", "audio/vnd.wave": "audio/wav", "audio/mp3": "audio/mpeg",
             "audio/x-m4a": "audio/mp4", "audio/m4a": "audio/mp4", "image/jpg": "image/jpeg"}


def sniff(data: bytes) -> str | None:
    if data[:3] == b"ID3" or data[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"):
        return "audio/mpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "audio/wav"
    if data[4:8] == b"ftyp":
        return "audio/mp4"
    if data[:4] == b"\x1aE\xdf\xa3":
        return "audio/webm"
    if data[:4] == b"OggS":
        return "audio/ogg"
    if data[:4] == b"fLaC":
        return "audio/flac"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:5] == b"%PDF-":
        return "application/pdf"
    return None


def normalize(mime: str | None) -> str | None:
    if not mime:
        return None
    m = mime.split(";")[0].strip().lower()
    return NORMALIZE.get(m, m)


def stored_type(filename: str, declared: str | None, data: bytes) -> tuple[str, str]:
    """(mime, ext) to store and serve with. Order: declared type, file name, first bytes."""
    guessed = mimetypes.guess_type("x" + _suffix(filename))[0]
    for cand in (normalize(declared), normalize(guessed), sniff(data)):
        if cand and cand in SAFE_SERVE and cand != "application/octet-stream":
            return cand, EXT_FOR[cand]
        if cand and cand not in SAFE_SERVE:
            return "application/octet-stream", "bin"   # never serve HTML/SVG/script from our origin
    return "application/octet-stream", "bin"


def _suffix(filename: str) -> str:
    base = filename.replace("\\", "/").rsplit("/", 1)[-1]
    return "." + base.rsplit(".", 1)[1].lower() if "." in base else ""


def audio_ext(content_type: str | None, url_path: str, data: bytes) -> str | None:
    """The format to tell OpenAI: content type, else the URL's extension, else the first bytes."""
    ct = normalize(content_type)
    if ct in AUDIO_MIME_EXT:
        return AUDIO_MIME_EXT[ct]
    ext = _suffix(url_path).lstrip(".")
    if ext in AUDIO_EXT_MIME:
        return ext
    s = sniff(data)
    return AUDIO_MIME_EXT.get(s or "")
