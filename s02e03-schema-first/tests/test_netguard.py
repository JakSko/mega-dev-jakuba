"""A8 SSRF guard and cut input, without the network: a fake resolver and a mock transport."""
import anyio
import httpx2 as httpx
import pytest

from mega_mcp import netguard

PUBLIC_IP = "93.184.216.34"


def resolver(table):
    def r(host, port, *a, **k):
        ip = table[host]
        return [(2, 1, 6, "", (ip, port))]
    return r


def run(coro):
    return anyio.run(lambda: coro)


@pytest.mark.parametrize("ip", ["127.0.0.1", "10.1.2.3", "192.168.1.1", "169.254.169.254", "0.0.0.0", "::1", "fc00::1"])
def test_private_targets_refused(ip):
    with pytest.raises(netguard.FetchError):
        netguard.check_target("http://h.example/a.mp3", resolver({"h.example": ip}))


def test_public_target_ok():
    netguard.check_target("https://h.example/a.mp3", resolver({"h.example": PUBLIC_IP}))


def test_redirect_to_private_refused():
    def handler(req):
        if req.url.host == "pub.example":
            return httpx.Response(302, headers={"location": "http://inside.example/x"})
        return httpx.Response(200, content=b"secret")
    res = resolver({"pub.example": PUBLIC_IP, "inside.example": "10.0.0.5"})
    with pytest.raises(netguard.FetchError):
        anyio.run(netguard.fetch, "http://pub.example/a.mp3", 1000, 5, res, httpx.MockTransport(handler))


def test_oversize_refused():
    def handler(req):
        return httpx.Response(200, content=b"x" * 2000, headers={"content-type": "audio/mpeg"})
    with pytest.raises(netguard.FetchError, match="large"):
        anyio.run(netguard.fetch, "http://pub.example/a.mp3", 1000, 5,
                  resolver({"pub.example": PUBLIC_IP}), httpx.MockTransport(handler))


def test_short_body_refused():
    def handler(req):
        return httpx.Response(200, content=b"x" * 10, headers={"content-length": "500", "content-type": "audio/mpeg"})
    with pytest.raises(netguard.FetchError):
        anyio.run(netguard.fetch, "http://pub.example/a.mp3", 1000, 5,
                  resolver({"pub.example": PUBLIC_IP}), httpx.MockTransport(handler))


def test_ok_fetch_returns_bytes_and_type():
    def handler(req):
        return httpx.Response(200, content=b"ID3abc", headers={"content-type": "audio/mpeg"})
    data, ctype, final = anyio.run(netguard.fetch, "http://pub.example/a", 1000, 5,
                                   resolver({"pub.example": PUBLIC_IP}), httpx.MockTransport(handler))
    assert data == b"ID3abc" and ctype == "audio/mpeg"
