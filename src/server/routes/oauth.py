"""OAuth 2.1 routes for the MCP endpoint: discovery documents, client registration
(DCR), the authorize step (sign in, then a consent page) and the token endpoint.
Cloud mode only: a grant acts for a signed-in person."""
import html
import json
from urllib.parse import parse_qs, quote, urlsplit

import server as _s
from server.pure import oauth

# The authorize request, carried as-is from the GET to the consent form's POST and
# validated again there.
_AUTHORIZE_PARAMS = ("response_type", "client_id", "redirect_uri", "state", "scope",
                     "code_challenge", "code_challenge_method", "resource")
# Discovery + token responses are read by browser-based clients too; no cookie is
# involved there, so any origin may read them.
_CORS = ("Access-Control-Allow-Origin", "*")


def _allowed(handler) -> bool:
    """The unauthenticated OAuth endpoints share a per-IP request budget."""
    if _s.api_rate_limit_ok("oauth:" + handler._client_ip()):
        return True
    handler._send_json(429, {"error": "slow_down", "error_description": "too many requests"})
    return False


def _send_public_json(handler, status, payload):
    body = json.dumps(payload).encode("utf-8")
    handler._send_bytes(status, body, "application/json",
                        [_CORS, ("Cache-Control", "no-store"), ("Pragma", "no-cache")])


def _redirect(handler, location):
    handler.send_response(303)
    handler.send_header("Location", location)
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()


def _render(handler, status, title, content_html, footer=""):
    body = _s.render_page(
        "oauth",
        lang=html.escape(_s.CONFIG.lang, quote=True),
        site_name=html.escape(_s.CONFIG.site_name, quote=True),
        site_prefix=html.escape(_s.CONFIG.prefix, quote=True),
        title=html.escape(title),
        content_html=content_html,
        footer=html.escape(footer),
    ).encode("utf-8")
    handler._send_bytes(status, body, "text/html; charset=utf-8", [("Cache-Control", "no-store")])


def _error_page(handler, status, message):
    _render(handler, status, _s._t("oauth_error_title"), f'<p class="err">{html.escape(message)}</p>')


def _params(source: dict) -> dict:
    return {k: (source.get(k) or [""])[0].strip() for k in _AUTHORIZE_PARAMS}


# ── discovery ────────────────────────────────────────────────────────────────

def protected_resource(handler):
    _send_public_json(handler, 200, oauth.protected_resource_metadata(handler._public_url()))


def authorization_server(handler):
    _send_public_json(handler, 200, oauth.authorization_server_metadata(handler._public_url()))


# ── dynamic client registration (RFC 7591) ──────────────────────────────────

def register(handler):
    data = handler._read_json()
    if not _allowed(handler):
        return
    data = data if isinstance(data, dict) else {}
    uris = data.get("redirect_uris")
    if (not isinstance(uris, list) or not uris or len(uris) > 10
            or not all(oauth.valid_redirect_uri(u) for u in uris)):
        _send_public_json(handler, 400, {
            "error": "invalid_redirect_uri",
            "error_description": "redirect_uris: https URLs, or http back to localhost"})
        return
    grant_types = data.get("grant_types") or ["authorization_code"]
    if (data.get("token_endpoint_auth_method", "none") != "none"
            or not isinstance(grant_types, list)
            or not set(grant_types) <= {"authorization_code", "refresh_token"}):
        _send_public_json(handler, 400, {
            "error": "invalid_client_metadata",
            "error_description": "public clients only: token_endpoint_auth_method none, "
                                 "authorization_code + refresh_token"})
        return
    raw_name = data.get("client_name") if isinstance(data.get("client_name"), str) else ""
    name = " ".join("".join(c for c in raw_name if c.isprintable()).split())[:100]
    try:
        client = _s.get_store().register_oauth_client(name or "MCP client", uris)
    except Exception as e:
        _s.registry_503(handler, "[oauth] register", e)
        return
    _send_public_json(handler, 201, {
        "client_id": client["client_id"],
        "client_id_issued_at": client["created_at"],
        "client_name": client["client_name"],
        "redirect_uris": client["redirect_uris"],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    })


# ── authorize: sign in, consent, code ───────────────────────────────────────

def _validated(handler, p: dict, base: str):
    """The authorize request `p` checked against its client, or None once the error is
    sent. An unverifiable client or redirect_uri gets an error page, never a redirect
    (that would make Atlas an open redirector); anything else goes back to the client's
    redirect_uri as an OAuth error."""
    try:
        client = oauth.resolve_client(p["client_id"])
    except oauth.ClientError as e:
        _error_page(handler, 400, _s._t("oauth_error_client").format(reason=e))
        return None
    if p["redirect_uri"] not in client["redirect_uris"]:
        _error_page(handler, 400, _s._t("oauth_error_client").format(
            reason="redirect_uri is not registered for this client"))
        return None

    def fail(error, description):
        _redirect(handler, oauth.redirect_with(p["redirect_uri"], error=error,
                                               error_description=description,
                                               state=p["state"], iss=base))

    if p["response_type"] != "code":
        return fail("unsupported_response_type", "only the authorization code flow is supported")
    if p["code_challenge_method"] != "S256" or not p["code_challenge"]:
        return fail("invalid_request", "PKCE with S256 is required")
    if p["resource"] and not oauth.same_resource(p["resource"], oauth.resource_url(base)):
        return fail("invalid_target", "this server only issues tokens for its MCP endpoint")
    try:
        scopes = oauth.parse_scope(p["scope"])
    except ValueError:
        return fail("invalid_scope", "scopes are among read, inbox and write")
    return {"params": p, "client": client, "scopes": scopes, "resource": oauth.resource_url(base)}


def _consent_page(handler, req: dict, email: str):
    client, p = req["client"], req["params"]
    hidden = "".join(f'<input type="hidden" name="{k}" value="{html.escape(p[k], quote=True)}">'
                     for k in _AUTHORIZE_PARAMS)
    csrf = _s.make_csrf_token(email, _s.current_session_epoch(email))
    scopes = "".join(
        f'<li><label><input type="checkbox" name="grant" value="{s}" checked>'
        f'<span><span class="name">{s}</span>{html.escape(_s._t("oauth_scope_" + s))}</span>'
        f'</label></li>' for s in req["scopes"])
    who = f'<b>{html.escape(client["client_name"])}</b>'
    if client.get("host") and client["host"] != client["client_name"]:
        who += f' ({html.escape(client["host"])})'
    back_to = f'<code>{html.escape(urlsplit(p["redirect_uri"]).netloc)}</code>'
    content = (
        f'<p class="intro">{_s._t("oauth_intro").format(client=who)}</p>'
        f'<p class="note">{_s._t("oauth_redirect").format(host=back_to)}</p>'
        f'<form method="post" action="/oauth/authorize">{hidden}'
        f'<input type="hidden" name="csrf_token" value="{html.escape(csrf, quote=True)}">'
        f'<p class="hint">{html.escape(_s._t("oauth_scopes_hint"))}</p>'
        f'<ul class="scopes">{scopes}</ul>'
        # Deny first in the DOM: Enter submits the first button, and that must not grant.
        f'<div class="actions"><button class="deny" name="decision" value="deny">'
        f'{html.escape(_s._t("oauth_deny"))}</button>'
        f'<button class="allow" name="decision" value="allow">{html.escape(_s._t("oauth_allow"))}'
        f'</button></div></form>')
    _render(handler, 200, _s._t("oauth_title"), content,
            footer=_s._t("oauth_signed_in_as").format(email=email))


def authorize_get(handler):
    sess = handler._session()
    if not sess:
        # Sign in first, then land back here. The client isn't resolved for an anonymous
        # visitor, so no one triggers a metadata fetch without an account.
        _redirect(handler, "/login?next=" + quote(handler.path, safe=""))
        return
    if not _allowed(handler):
        return
    base = handler._public_url()
    req = _validated(handler, _params(parse_qs(urlsplit(handler.path).query)), base)
    if req is not None:
        _consent_page(handler, req, sess["email"])


def authorize_post(handler):
    form = parse_qs(handler._read_body().decode("utf-8", "replace"))
    sess = handler._session()
    email = (sess or {}).get("email")
    origin = handler._request_origin_host()
    token = (form.get("csrf_token") or [""])[0]
    # A form POST, so the CSRF defense is the session-bound token it carries, not the
    # JSON-only check. Under Atlas's no-referrer policy a browser sends `Origin: null`
    # on a form POST (read as ""), so only a named foreign origin is refused outright.
    if (not sess or origin not in (None, "", handler.headers.get("Host", ""))
            or not _s.verify_csrf_token(email, _s.current_session_epoch(email), token)):
        _error_page(handler, 403, _s._t("oauth_error_session"))
        return
    base = handler._public_url()
    req = _validated(handler, _params(form), base)
    if req is None:
        return
    p = req["params"]
    granted = [s for s in req["scopes"] if s in form.get("grant", [])]
    if (form.get("decision") or [""])[0] != "allow" or not granted:
        _redirect(handler, oauth.redirect_with(p["redirect_uri"], error="access_denied",
                                               error_description="the person did not grant access",
                                               state=p["state"], iss=base))
        return
    code = oauth.issue_code(client_id=p["client_id"], client_name=req["client"]["client_name"],
                            redirect_uri=p["redirect_uri"], code_challenge=p["code_challenge"],
                            scopes=granted, resource=req["resource"], email=email)
    _redirect(handler, oauth.redirect_with(p["redirect_uri"], code=code, state=p["state"], iss=base))


# ── token endpoint ───────────────────────────────────────────────────────────

def _token_error(handler, error, description, status=400):
    _send_public_json(handler, status, {"error": error, "error_description": description})


def token(handler):
    form = {k: v[0] for k, v in parse_qs(handler._read_body().decode("utf-8", "replace")).items()}
    if not _allowed(handler):
        return
    store = _s.get_store()
    grant_type = form.get("grant_type")
    try:
        if grant_type == "authorization_code":
            entry = oauth.redeem_code(form.get("code", ""))
            if (entry is None or entry["client_id"] != form.get("client_id")
                    or entry["redirect_uri"] != form.get("redirect_uri")
                    or not oauth.pkce_ok(form.get("code_verifier", ""), entry["code_challenge"])):
                _token_error(handler, "invalid_grant",
                             "the code is invalid, expired, already used or not yours")
                return
            if form.get("resource") and not oauth.same_resource(form["resource"], entry["resource"]):
                _token_error(handler, "invalid_target", "the code was issued for another resource")
                return
            _, access, refresh = store.save_oauth_grant(
                entry["client_id"], entry["client_name"], entry["email"], entry["scopes"],
                entry["resource"], oauth.ACCESS_TTL, oauth.REFRESH_TTL)
            scopes = entry["scopes"]
        elif grant_type == "refresh_token":
            rotated = store.rotate_oauth_refresh(_s._hash_api_token(form.get("refresh_token", "")),
                                                 form.get("client_id", ""),
                                                 oauth.ACCESS_TTL, oauth.REFRESH_TTL)
            if rotated is None or not store.get_user_by_email(rotated[0].get("acts_as") or ""):
                _token_error(handler, "invalid_grant", "the refresh token is invalid, expired or revoked")
                return
            identity, access, refresh = rotated
            if form.get("resource") and not oauth.same_resource(form["resource"],
                                                                identity.get("oauth_resource")):
                _token_error(handler, "invalid_target", "the grant was issued for another resource")
                return
            scopes = identity["scopes"]
        else:
            _token_error(handler, "unsupported_grant_type",
                         "grant_type is authorization_code or refresh_token")
            return
    except Exception as e:
        _s.registry_503(handler, "[oauth] token", e)
        return
    _send_public_json(handler, 200, {"access_token": access, "token_type": "Bearer",
                                     "expires_in": oauth.ACCESS_TTL, "refresh_token": refresh,
                                     "scope": " ".join(scopes)})
