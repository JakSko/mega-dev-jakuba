"""Our own OAuth 2.1 authorization server (spec R4, Q2 decided by Jakub: own server, same host).

Built on the SDK's handlers (`create_auth_routes`: /authorize, /token, /register with PKCE
S256 checks) plus what the SDK leaves to us: the owner sign-in and consent page, codes and
tokens bound to our resource, refresh rotation, `iss` in the authorization response, and
metadata that advertises it. One owner (Jakub); every client acts on his behalf after his
consent.
"""
from __future__ import annotations

import html
import time
from collections import defaultdict, deque
from urllib.parse import urlparse

from mcp.server.auth.provider import (
    AccessToken,
    AuthorizationCode,
    AuthorizationParams,
    AuthorizeError,
    RefreshToken,
    TokenError,
    construct_redirect_uri,
)
from mcp.server.auth.routes import build_metadata, create_auth_routes
from mcp.server.auth.settings import ClientRegistrationOptions, RevocationOptions
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken
from pydantic import AnyHttpUrl
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from starlette.routing import Route

from .config import SCOPE, Config
from .store import Store

OWNER = "owner"


def canonical(uri: str | None) -> str | None:
    if uri is None:
        return None
    p = urlparse(uri)
    return f"{p.scheme.lower()}://{p.netloc.lower()}{p.path.rstrip('/')}"


class Provider:
    """Implements mcp.server.auth.provider.OAuthAuthorizationServerProvider."""

    def __init__(self, cfg: Config, store: Store):
        self.cfg, self.store = cfg, store

    # --- clients (DCR) ---
    async def get_client(self, client_id: str) -> OAuthClientInformationFull | None:
        raw = self.store.get_client(client_id)
        return OAuthClientInformationFull.model_validate_json(raw) if raw else None

    async def register_client(self, client_info: OAuthClientInformationFull) -> None:
        self.store.save_client(client_info.client_id, client_info.model_dump_json())

    # --- authorize: park the request, send the browser to the owner's consent page ---
    async def authorize(self, client: OAuthClientInformationFull, params: AuthorizationParams) -> str:
        if params.resource is not None and canonical(params.resource) not in (
                canonical(self.cfg.mcp_url), canonical(self.cfg.public_url)):
            raise AuthorizeError(error="invalid_target", error_description="tokens here are only for " + self.cfg.mcp_url)
        pid = self.store.add_pending(client.client_id, {
            "state": params.state,
            "scopes": params.scopes or [SCOPE],
            "code_challenge": params.code_challenge,
            "redirect_uri": str(params.redirect_uri),
            "redirect_uri_provided_explicitly": params.redirect_uri_provided_explicitly,
        })
        return f"{self.cfg.public_url}/login?req={pid}"

    # --- codes ---
    async def load_authorization_code(self, client: OAuthClientInformationFull, authorization_code: str):
        d = self.store.get_code(authorization_code)
        if not d or d["client_id"] != client.client_id:
            return None
        d["code"] = authorization_code
        return AuthorizationCode(**d)

    async def exchange_authorization_code(self, client: OAuthClientInformationFull,
                                          authorization_code: AuthorizationCode) -> OAuthToken:
        self.store.drop_code(authorization_code.code)   # single use
        return self._pair(client.client_id, authorization_code.scopes, authorization_code.subject or OWNER)

    def _pair(self, client_id: str, scopes: list[str], subject: str) -> OAuthToken:
        res = self.cfg.mcp_url
        access = self.store.issue_access(subject, client_id, scopes, res, self.cfg.access_ttl)
        refresh = self.store.issue_refresh(subject, client_id, scopes, res, self.cfg.refresh_ttl)
        return OAuthToken(access_token=access, token_type="Bearer", expires_in=self.cfg.access_ttl,
                          scope=" ".join(scopes), refresh_token=refresh)

    # --- refresh with rotation ---
    async def load_refresh_token(self, client: OAuthClientInformationFull, refresh_token: str):
        t = self.store.get_token(refresh_token, "refresh")
        if not t or t["client_id"] != client.client_id or t["expires_at"] < time.time():
            return None
        return RefreshToken(token=refresh_token, client_id=t["client_id"], scopes=t["scopes"],
                            expires_at=t["expires_at"], resource=t["resource"], subject=t["subject"])

    async def exchange_refresh_token(self, client: OAuthClientInformationFull, refresh_token: RefreshToken,
                                     scopes: list[str]) -> OAuthToken:
        self.store.drop_token(refresh_token.token)      # rotation: the old one is spent
        return self._pair(client.client_id, scopes or refresh_token.scopes, refresh_token.subject or OWNER)

    # --- access tokens ---
    async def load_access_token(self, token: str) -> AccessToken | None:
        t = self.store.get_token(token, "access")
        if not t or t["expires_at"] < time.time():
            return None
        return AccessToken(token=token, client_id=t["client_id"], scopes=t["scopes"], expires_at=t["expires_at"],
                           resource=t["resource"], subject=t["subject"])

    async def revoke_token(self, token, token_type_hint=None) -> None:
        self.store.drop_token(token.token)

    async def exchange_identity_assertion(self, client, params):
        raise TokenError(error="unsupported_grant_type", error_description="not supported")


class Verifier:
    """TokenVerifier for the MCP endpoint: only our own unexpired access tokens."""

    def __init__(self, provider: Provider):
        self.provider = provider

    async def verify_token(self, token: str) -> AccessToken | None:
        return await self.provider.load_access_token(token)


class LoginLimiter:
    """At most 5 wrong passwords per 15 minutes (per address and in total)."""

    def __init__(self, limit: int = 5, window: float = 900):
        self.limit, self.window = limit, window
        self.fails: dict[str, deque] = defaultdict(deque)

    def blocked(self, key: str) -> bool:
        now = time.time()
        for k in (key, "*"):
            q = self.fails[k]
            while q and q[0] < now - self.window:
                q.popleft()
        return len(self.fails[key]) >= self.limit or len(self.fails["*"]) >= self.limit * 4

    def fail(self, key: str) -> None:
        now = time.time()
        self.fails[key].append(now)
        self.fails["*"].append(now)


PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Approve access - Jakub's MCP tools</title><style>body{{font:16px system-ui;max-width:34em;margin:2em auto;padding:0 1em}}
code{{background:#eee;padding:0 .3em}}.err{{color:#a00}}button{{font-size:1em;padding:.4em 1em;margin-right:.5em}}</style></head>
<body><h1>Approve access</h1>{error}
<p><b>{client}</b> asks to use this MCP server (<code>{resource}</code>) on your behalf.</p>
<p>After approval it is sent back to <code>{redirect_host}</code>.</p>
<p>Access asked for: <code>{scopes}</code> - the four tools memo_write, memo_search, upload and transcribe. Nothing else.</p>
<form method="post" action="/login"><input type="hidden" name="req" value="{req}">
<p><label>Owner password <input type="password" name="password" autocomplete="current-password" required></label></p>
<button name="decision" value="approve">Approve</button><button name="decision" value="deny" formnovalidate>Deny</button></form>
<p><a href="/plan">What this server does and what data it keeps</a></p></body></html>"""


def auth_routes(cfg: Config, store: Store, provider: Provider) -> list[Route]:
    issuer = AnyHttpUrl(cfg.public_url)
    reg = ClientRegistrationOptions(enabled=True, valid_scopes=[SCOPE], default_scopes=[SCOPE])
    sdk_routes = create_auth_routes(provider=provider, issuer_url=issuer, client_registration_options=reg,
                                    revocation_options=RevocationOptions(enabled=False))
    meta = build_metadata(issuer, None, reg, RevocationOptions(enabled=False)).model_dump(mode="json", exclude_none=True)
    meta["issuer"] = cfg.public_url                     # exact string, no trailing slash (RFC 8414/9207)
    meta["authorization_response_iss_parameter_supported"] = True
    meta["token_endpoint_auth_methods_supported"] = ["none", "client_secret_post", "client_secret_basic"]
    limiter = LoginLimiter()

    async def as_metadata(request: Request) -> Response:
        return JSONResponse(meta, headers={"Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*"})

    async def login(request: Request) -> Response:
        if request.method == "GET":
            pid = request.query_params.get("req", "")
            return await consent_page(pid)
        form = await request.form()
        pid = str(form.get("req", ""))
        pend = store.get_pending(pid)
        if not pend:
            return HTMLResponse("This sign-in request expired or is unknown. Start again from the app.", status_code=400)
        client_id, p = pend
        who = request.client.host if request.client else "?"
        if form.get("decision") == "deny":
            store.drop_pending(pid)
            return RedirectResponse(construct_redirect_uri(p["redirect_uri"], error="access_denied", state=p["state"],
                                                           iss=cfg.public_url), status_code=302)
        if limiter.blocked(who):
            return await consent_page(pid, "Too many wrong passwords. Wait 15 minutes.", 429)
        if form.get("password") != cfg.owner_password:
            limiter.fail(who)
            return await consent_page(pid, "Wrong password.", 401)
        store.drop_pending(pid)
        code = store.add_code({
            "scopes": p["scopes"], "client_id": client_id, "code_challenge": p["code_challenge"],
            "redirect_uri": p["redirect_uri"], "redirect_uri_provided_explicitly": p["redirect_uri_provided_explicitly"],
            "resource": cfg.mcp_url, "subject": OWNER}, cfg.code_ttl)
        return RedirectResponse(construct_redirect_uri(p["redirect_uri"], code=code, state=p["state"], iss=cfg.public_url),
                                status_code=302)

    async def consent_page(pid: str, error: str = "", status: int = 200) -> Response:
        pend = store.get_pending(pid)
        if not pend:
            return HTMLResponse("This sign-in request expired or is unknown. Start again from the app.", status_code=400)
        client_id, p = pend
        client = await provider.get_client(client_id)
        name = (client.client_name if client and client.client_name else client_id)
        body = PAGE.format(error=f'<p class="err">{html.escape(error)}</p>' if error else "",
                           client=html.escape(name), resource=html.escape(cfg.mcp_url),
                           redirect_host=html.escape(urlparse(p["redirect_uri"]).netloc or p["redirect_uri"]),
                           scopes=html.escape(" ".join(p["scopes"])), req=html.escape(pid))
        return HTMLResponse(body, status_code=status, headers={
            "Cache-Control": "no-store", "X-Frame-Options": "DENY",
            # No form-action: Chrome applies it to the redirect after the POST (to the client's callback,
            # another origin) and blocked the whole submission (seen live 2026-11-06, S02E03 step 13).
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'"})

    routes = [Route("/.well-known/oauth-authorization-server", as_metadata, methods=["GET"]),
              Route("/login", login, methods=["GET", "POST"])]
    routes += [r for r in sdk_routes if r.path != "/.well-known/oauth-authorization-server"]
    return routes
