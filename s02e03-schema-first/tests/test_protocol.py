"""A4 protocol, A5 tools/list."""
import json

import httpx2 as httpx
from jsonschema import Draft202012Validator

from helpers import LEGACY, MODERN, rpc
from mega_mcp import contract


def test_a4_discover(server, owner):
    status, body = rpc(server.mcp, "server/discover", token=owner["access_token"])
    assert status == 200, body
    res = body["result"]
    assert MODERN in res["supportedVersions"]
    assert "tools" in res["capabilities"]
    assert res["resultType"] == "complete"


def test_a4_header_mismatch(server, owner):
    status, body = rpc(server.mcp, "tools/list", token=owner["access_token"], headers={"Mcp-Method": "tools/call"})
    assert status == 400 and body["error"]["code"] == -32020


def test_a4_unknown_version(server, owner):
    status, body = rpc(server.mcp, "tools/list", token=owner["access_token"], version="1900-01-01")
    assert status == 400 and body["error"]["code"] == -32022
    assert MODERN in body["error"]["data"]["supported"]


def test_a4_missing_meta(server, owner):
    status, body = rpc(server.mcp, "tools/list", token=owner["access_token"], meta=False)
    assert status == 400 and body["error"]["code"] == -32602


def test_a4_unknown_tool(server, owner):
    status, body = rpc(server.mcp, "tools/call", {"name": "delete_everything", "arguments": {}},
                       token=owner["access_token"])
    # MCP 2026-07-28 tools.md: unknown tool is a protocol error -32602; accept the SDK's tool-error form too
    if "error" in body:
        assert body["error"]["code"] == -32602
    else:
        assert body["result"]["isError"] is True and "Unknown tool" in json.dumps(body)


def test_a4_unknown_method(server, owner):
    status, body = rpc(server.mcp, "files/delete_all", token=owner["access_token"])
    assert status == 404
    assert body["error"]["code"] == -32601


def test_a4_declared_but_empty_capabilities(server, owner):
    # The SDK declares resources and prompts; a declared capability answers with an empty list (no extra data exposed)
    _, d = rpc(server.mcp, "server/discover", token=owner["access_token"])
    caps = d["result"]["capabilities"]
    for method, cap, key in (("resources/list", "resources", "resources"), ("prompts/list", "prompts", "prompts")):
        status, body = rpc(server.mcp, method, token=owner["access_token"])
        if cap in caps:
            assert status == 200 and body["result"][key] == []
        else:
            assert body["error"]["code"] == -32601


def legacy_session(url, token):
    h = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    init = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": LEGACY, "capabilities": {}, "clientInfo": {"name": "legacy", "version": "1"}}}
    r = httpx.post(url, json=init, headers=h, timeout=10)
    return r, h


def test_a4_legacy_client_with_token(server, owner):
    from helpers import parse_body
    r, h = legacy_session(server.mcp, owner["access_token"])
    assert r.status_code == 200, r.text
    assert parse_body(r)["result"]["protocolVersion"] == LEGACY
    h["MCP-Protocol-Version"] = LEGACY
    r = httpx.post(server.mcp, json={"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}, headers=h)
    names = [t["name"] for t in parse_body(r)["result"]["tools"]]
    assert names == contract.TOOL_NAMES


def test_a4_legacy_client_without_token(server):
    r, _ = legacy_session(server.mcp, "")
    assert r.status_code == 401


# ---------- A5 ----------

def test_a5_tools_list_stable_and_cacheable(server, owner):
    s1, b1 = rpc(server.mcp, "tools/list", token=owner["access_token"])
    s2, b2 = rpc(server.mcp, "tools/list", token=owner["access_token"])
    r1, r2 = b1["result"], b2["result"]
    assert [t["name"] for t in r1["tools"]] == contract.TOOL_NAMES
    assert r1["tools"] == r2["tools"]
    assert isinstance(r1["ttlMs"], int) and r1["cacheScope"] in ("public", "private")
    for t in r1["tools"]:
        assert t["description"] and len(t["description"]) > 40
        Draft202012Validator.check_schema(t["inputSchema"])
        Draft202012Validator.check_schema(t["outputSchema"])


def test_a5_published_schemas_keep_the_contract(server, owner):
    _, b = rpc(server.mcp, "tools/list", token=owner["access_token"])
    tools = {t["name"]: t for t in b["result"]["tools"]}
    for name in contract.TOOL_NAMES:
        pub_in = tools[name]["inputSchema"]
        want = contract.INPUT[name]
        assert set(want["required"]) == set(pub_in.get("required", [])), name
        for prop, spec in want["properties"].items():
            assert prop in pub_in["properties"], (name, prop)
        pub_out = tools[name]["outputSchema"]
        assert set(contract.OUTPUT[name]["required"]) <= set(pub_out.get("required", [])), name
