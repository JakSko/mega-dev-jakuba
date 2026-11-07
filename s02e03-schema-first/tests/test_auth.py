"""A1 discovery, A2 authorization server, A3 refusals."""
import time

import httpx2 as httpx

from helpers import MODERN, OAuth, rpc


# ---------- A1: discovery without a token ----------

def test_a1_no_token_401_names_resource_metadata(server):
    r = rpc(server.mcp, "tools/list", raw=True)
    assert r.status_code == 401
    www = r.headers["www-authenticate"]
    assert www.startswith("Bearer")
    assert f'resource_metadata="{server.base}/.well-known/oauth-protected-resource/mcp"' in www


def test_a1_prm_at_both_paths(server):
    for path in ("/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"):
        r = httpx.get(server.base + path)
        assert r.status_code == 200, path
        m = r.json()
        assert m["resource"] == server.mcp
        assert m["authorization_servers"] == [server.base]
        assert m["resource_documentation"] == server.base + "/plan"
        assert m["scopes_supported"] == ["mcp"]
        assert m["bearer_methods_supported"] == ["header"]


def test_a1_public_routes_only(server):
    assert httpx.get(server.base + "/plan").status_code == 200
    assert httpx.get(server.base + "/.well-known/oauth-authorization-server").status_code == 200
    # server/discover is an MCP request: it needs a token too
    assert rpc(server.mcp, "server/discover", raw=True).status_code == 401


# ---------- A2: authorization server ----------

def test_a2_as_metadata(server):
    m = httpx.get(server.base + "/.well-known/oauth-authorization-server").json()
    assert m["issuer"] == server.base
    assert m["code_challenge_methods_supported"] == ["S256"]
    assert m["registration_endpoint"] == server.base + "/register"
    assert set(m["grant_types_supported"]) >= {"authorization_code", "refresh_token"}
    assert m["scopes_supported"] == ["mcp"]
    assert m["authorization_response_iss_parameter_supported"] is True
    assert "none" in m["token_endpoint_auth_methods_supported"]


def test_a2_full_flow_and_iss(server):
    c = OAuth(server.base, server.mcp, client_name="Flow Test Client")
    c.register()
    a = c.authorize()
    assert a["iss"] == server.base
    assert a["state"] == a["_state"]
    assert "Flow Test Client" in a["_page"] and "127.0.0.1" in a["_page"]  # consent names client and redirect host
    r = c.token(a["code"], a["_verifier"])
    assert r.status_code == 200, r.text
    t = r.json()
    assert t["token_type"].lower() == "bearer"
    assert t["expires_in"] >= 3600
    assert t["refresh_token"]
    status, body = rpc(server.mcp, "tools/list", token=t["access_token"])
    assert status == 200 and len(body["result"]["tools"]) == 4


def test_a2_wrong_password_and_deny(server):
    c = OAuth(server.base, server.mcp)
    c.register()
    bad = c.authorize(password="wrong-password")
    assert bad.get("status") == 401 or "code" not in bad
    denied = c.authorize(approve=False)
    assert denied["error"] == "access_denied" and denied["iss"] == server.base


def test_a2_code_single_use_and_pkce(server):
    c = OAuth(server.base, server.mcp)
    c.register()
    a = c.authorize()
    assert c.token(a["code"], "wrong-verifier-" + "x" * 40).status_code == 400
    a = c.authorize()
    assert c.token(a["code"], a["_verifier"]).status_code == 200
    assert c.token(a["code"], a["_verifier"]).status_code == 400  # reused


def test_a2_foreign_resource_refused(server):
    c = OAuth(server.base, server.mcp)
    c.register()
    a = c.authorize(resource="https://other.example/mcp")
    assert "code" not in a


def test_a2_no_scope_gets_default(server):
    c = OAuth(server.base, server.mcp)
    c.register()
    a = c.authorize(scope=None)
    t = c.token(a["code"], a["_verifier"]).json()
    assert t.get("scope", "mcp") == "mcp"


def test_a2_refresh_rotates(server):
    c = OAuth(server.base, server.mcp)
    t = c.login()
    r1 = c.refresh(t["refresh_token"])
    assert r1.status_code == 200, r1.text
    new = r1.json()
    assert new["refresh_token"] != t["refresh_token"]
    assert rpc(server.mcp, "tools/list", token=new["access_token"])[0] == 200
    # A3: the old refresh token is spent
    assert c.refresh(t["refresh_token"]).status_code == 400


# ---------- A3: refusals ----------

def test_a3_made_up_and_expired_tokens(server):
    assert rpc(server.mcp, "tools/list", token="mat_" + "x" * 40, raw=True).status_code == 401
    from mega_mcp.app import STATE
    tok = STATE["store"].issue_access("someone", "c1", ["mcp"], server.mcp, ttl=-1)
    assert rpc(server.mcp, "tools/list", token=tok, raw=True).status_code == 401


def test_a3_wrong_audience_token(server):
    from mega_mcp.app import STATE
    tok = STATE["store"].issue_access("owner", "c1", ["mcp"], "https://other.example/mcp", ttl=3600)
    assert rpc(server.mcp, "tools/list", token=tok, raw=True).status_code == 401


def test_a3_get_and_delete_on_mcp(server, owner):
    h = {"Authorization": f"Bearer {owner['access_token']}", "MCP-Protocol-Version": MODERN,
         "Accept": "text/event-stream"}
    assert httpx.get(server.mcp, headers=h).status_code == 405
    assert httpx.delete(server.mcp, headers=h).status_code == 405


def test_a3_token_not_in_query(server, owner):
    r = httpx.post(server.mcp + "?access_token=" + owner["access_token"], json={})
    assert r.status_code == 401


def test_a2_consent_page_csp_allows_the_redirect(server):
    # Regression (step 13, 2026-11-06): `form-action 'self'` made Chrome block the Approve POST,
    # because the answer redirects to the client's callback on another origin.
    c = OAuth(server.base, server.mcp)
    c.register()
    from helpers import pkce, REDIRECT
    from urllib.parse import urlencode
    _, ch = pkce()
    r = c.http.get(server.base + "/authorize?" + urlencode({
        "response_type": "code", "client_id": c.client_id, "redirect_uri": REDIRECT, "code_challenge": ch,
        "code_challenge_method": "S256", "state": "s", "resource": server.mcp}))
    page = c.http.get(r.headers["location"])
    csp = page.headers["content-security-policy"]
    assert "form-action" not in csp and "frame-ancestors 'none'" in csp
