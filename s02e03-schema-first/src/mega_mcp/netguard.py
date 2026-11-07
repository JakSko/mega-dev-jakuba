"""Fetch a stranger's URL safely (SSRF guard, spec R8).

Only http(s); every hop (the first URL and each redirect) is resolved and all of its
addresses must be public; at most 3 redirects; size cap while streaming; a body shorter
than its Content-Length, or a broken stream, is an error, never a short result.
"""
from __future__ import annotations

import ipaddress
import socket
from typing import Callable
from urllib.parse import urljoin, urlparse

import httpx2 as httpx

Resolver = Callable[..., list]
MAX_REDIRECTS = 3


class FetchError(Exception):
    pass


def check_target(url: str, resolve: Resolver = socket.getaddrinfo) -> None:
    p = urlparse(url)
    if p.scheme not in ("http", "https"):
        raise FetchError("only http and https URLs can be fetched")
    if not p.hostname:
        raise FetchError("the URL has no host")
    if p.username or p.password:
        raise FetchError("URLs with credentials are not fetched")
    port = p.port or (443 if p.scheme == "https" else 80)
    try:
        infos = resolve(p.hostname, port, type=socket.SOCK_STREAM)
    except (socket.gaierror, KeyError, OSError):
        raise FetchError("the host name does not resolve")
    if not infos:
        raise FetchError("the host name does not resolve")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if not ip.is_global or ip.is_multicast:
            raise FetchError("the URL points to a private or local address; only public addresses are fetched")


async def fetch(url: str, max_bytes: int, timeout: float, resolve: Resolver = socket.getaddrinfo,
                transport: httpx.AsyncBaseTransport | None = None) -> tuple[bytes, str, str]:
    """Returns (body, content type, final URL)."""
    async with httpx.AsyncClient(follow_redirects=False, timeout=timeout, transport=transport,
                                 headers={"User-Agent": "mega-mcp-transcribe/1"}) as client:
        current = url
        for _ in range(MAX_REDIRECTS + 1):
            check_target(current, resolve)
            try:
                async with client.stream("GET", current) as r:
                    if r.status_code in (301, 302, 303, 307, 308) and "location" in r.headers:
                        current = urljoin(current, r.headers["location"])
                        continue
                    if r.status_code != 200:
                        raise FetchError(f"the URL answered HTTP {r.status_code}")
                    declared = r.headers.get("content-length")
                    if declared and declared.isdigit() and int(declared) > max_bytes:
                        raise FetchError(f"the file is too large (over {max_bytes // (1024 * 1024)} MB)")
                    chunks, size = [], 0
                    async for chunk in r.aiter_bytes():
                        size += len(chunk)
                        if size > max_bytes:
                            raise FetchError(f"the file is too large (over {max_bytes // (1024 * 1024)} MB)")
                        chunks.append(chunk)
                    data = b"".join(chunks)
                    if declared and declared.isdigit() and len(data) != int(declared):
                        raise FetchError("the download was cut short; nothing was transcribed")
                    return data, r.headers.get("content-type", "").split(";")[0].strip().lower(), current
            except FetchError:
                raise
            except httpx.TimeoutException:
                raise FetchError("the download timed out")
            except httpx.HTTPError as e:
                raise FetchError(f"the download failed ({type(e).__name__}); nothing was transcribed")
        raise FetchError("too many redirects")
