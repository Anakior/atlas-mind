"""Invitation routes: the accept page (where an invited user sets their OWN
password) and its submit endpoint.

C1 — an admin creates a PENDING account (email + role) and gets a single-use
invite link /invite/<token>; the invitee opens it, chooses a password, and the
account is activated + logged in. Only the token's SHA256 lives on the account
(invite_token_hash); the cleartext travels solely in the URL the admin shares.

Cloud-only (when=_when_cloud in the route table). No session exists yet, so the
submit uses BASE CSRF only (like /api/setup) — the opaque token is the real
capability. An unknown / expired / already-used token is treated UNIFORMLY (404
on the page, 409 on submit) so it never reveals whether an invite existed.
"""
import sys
import time

import store
import server as _s


def _token_from_path(path: str) -> str:
    """The opaque token after /invite/ (query/fragment stripped)."""
    rest = path[len("/invite/"):]
    for sep in ("?", "#"):
        rest = rest.split(sep, 1)[0]
    return rest


def _live_invite_user(token: str):
    """The PENDING account behind a LIVE invite token (exists + not expired), or
    None. Read-only — accept_invite re-checks single-use/expiry atomically."""
    if not token:
        return None
    user = _s.get_store().find_user_by_invite_token(store.hash_api_token(token))
    if not user or not user.get("invite_token_hash"):
        return None
    if int(user.get("invite_expires_at") or 0) < int(time.time()):
        return None
    return user


def page(handler):
    """GET /invite/<token> — the accept page while the invite is live, else 404
    (same response as an unknown token: no existence oracle)."""
    token = _token_from_path(handler.path)
    user = _live_invite_user(token)
    if user is None:
        handler.send_error(404)
        return
    handler._send_invite_page(email=user.get("email") or "", token=token)


def submit(handler):
    """POST /api/invite {token, password}: set the invitee's OWN password, clear
    the invite (single-use, atomic), and open the session. 409 if the invite is no
    longer valid (already used / expired / unknown), 400 on a short password."""
    # Always read the body (keep-alive), even if we are going to refuse.
    data = handler._read_json()
    # BASE CSRF only: no session exists yet (we are activating the account); the
    # opaque single-use token is the protection against drive-by requests.
    if not handler._check_csrf_base_or_403():
        return
    token = data.get("token") or ""
    password = data.get("password") or ""
    if len(password) < 8:
        handler._send_json(400, {"error": _s._t("invite_password_too_short")})
        return
    try:
        result = _s.get_store().accept_invite(
            store.hash_api_token(token), store.hash_password(password))
    except Exception as e:
        print(f"[invite] could not accept invite: {e}", file=sys.stderr)
        handler._send_json(503, {"error": "registry unavailable"})
        return
    if not result:
        handler._send_json(409, {"error": _s._t("invite_invalid")})
        return
    handler.send_response(200)
    for cookie in handler._session_cookie_pair(
            result["email"], result["role"],
            _s.current_session_epoch(result["email"])):
        handler.send_header("Set-Cookie", cookie)
    handler.send_header("Cache-Control", "no-store")
    handler._send_json_after_cookie({"ok": True, "email": result["email"]})
