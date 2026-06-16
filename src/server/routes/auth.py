"""Auth routes: login page render, form/JSON login flow, logout, and the
session auth-state probe (/api/me)."""
import json
import sys
from urllib.parse import parse_qs
import server as _s


def login_page(handler):
    """GET /login (cloud) — render the login page. Thin wrapper over the Handler's
    _send_login_page plumbing (also called by the login flow with error/status)."""
    handler._send_login_page()


def login(handler):
    # Read the body before any return (keep-alive: don't leave unread data
    # on the socket).
    body = handler._read_body().decode("utf-8", "replace")
    client_ip = handler._client_ip()
    ctype = handler.headers.get("Content-Type", "")
    is_json = "application/json" in ctype
    # Per-IP rate limit: response consistent with the rest (JSON for the SPA,
    # HTML page for the form POST).
    if not _s.login_rate_limit_ok(client_ip):
        handler._login_error(is_json, _s._t("login_rate_limited"), 429)
        return
    if is_json:
        try:
            data = json.loads(body)
        except (ValueError, json.JSONDecodeError):
            data = {}
    else:
        data = {k: v[0] for k, v in parse_qs(body).items()}
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    totp_code = (data.get("totp_code") or "").strip()
    recovery_code = (data.get("recovery_code") or "").strip()

    # Per-account lockout (IN ADDITION to the per-IP rate limit): a locked
    # account is refused BEFORE any password check.
    if email and _s.account_lock_remaining(email) > 0:
        handler._login_error(is_json, _s._t("login_account_locked"), 429,
                          extra={"locked": True})
        return

    try:
        user = _s.authenticate_user(email, password) if email and password else None
    except Exception as e:
        # Atlas unreachable: a clean 503 rather than an opaque 500. (Browsing
        # content with an already-issued cookie does not touch the registry — only
        # session creation depends on it.)
        print(f"[login] backend auth indisponible: {e}", file=sys.stderr)
        handler._send_login_page(
            error=_s._t("login_backend_unavailable"),
            status=503)
        return
    if not user:
        _s.register_login_failure(email, client_ip)
        handler._login_error(is_json, _s._t("login_invalid_credentials"), 401)
        return

    role = user.get("role", "admin")
    if user.get("totp_enabled"):
        # Second factor required BEFORE setting the cookie. With no code
        # provided, we signal the client to ask for one (NOT an auth error:
        # the password was correct, the failure counter is NOT incremented).
        # We answer 200 — and NOT 401 — in this case: it's a progression
        # signal ("move to the code step"), not a failure. A 401 on a fetch
        # triggers a console.error "Failed to load resource: 401" in every
        # browser; the JS tests data.totp_required BEFORE the status and does
        # not set a cookie here, so the 200 is harmless (401 stays reserved
        # for real credential/code failures).
        if not totp_code and not recovery_code:
            handler._login_error(is_json, _s._t("login_totp_required"), 200,
                              extra={"totp_required": True})
            return
        if not handler._verify_second_factor(user, totp_code, recovery_code):
            _s.register_login_failure(email, client_ip)
            handler._login_error(is_json, _s._t("login_totp_invalid"), 401,
                              extra={"totp_required": True})
            return

    _s.reset_login_failures(email)
    handler._open_session_response(email, role)


def logout(handler):
    handler.send_response(303)
    handler.send_header("Location", "/login")
    handler.send_header(
        "Set-Cookie",
        f"{_s.COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
    )
    handler.send_header(
        "Set-Cookie",
        f"{_s.CSRF_COOKIE_NAME}=; Path=/; SameSite=Lax; Max-Age=0",
    )
    handler.end_headers()


def me(handler):
    """GET /api/me — the session's auth state (+ CSRF token / 2FA state in
    cloud)."""
    sess = handler._session()
    if not sess:
        handler._send_json(200, {"authenticated": False, "cloud": _s.CONFIG.auth_enabled})
        return
    email = sess.get("email")
    payload = {
        "authenticated": True,
        "email": email,
        "role": sess.get("role", "admin"),
        "cloud": _s.CONFIG.auth_enabled,
    }
    # Cloud mode only: the CSRF token (also set as a readable kb_csrf
    # cookie) and the 2FA state. Locally (auth disabled) the
    # session is fake and the store isn't necessarily reachable —
    # we don't query it (CSRF is useless on a 127.0.0.1 instance).
    if _s.CONFIG.auth_enabled:
        epoch = _s.current_session_epoch(email)
        user = _s.get_store().get_user_by_email(email) or {}
        payload["csrf_token"] = _s.make_csrf_token(email, epoch)
        payload["totp_enabled"] = bool(user.get("totp_enabled"))
    handler._send_json(200, payload)
