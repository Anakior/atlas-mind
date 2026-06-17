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
    # Read the body before any return (keep-alive: don't leave unread data on the socket).
    body = handler._read_body().decode("utf-8", "replace")
    client_ip = handler._client_ip()
    ctype = handler.headers.get("Content-Type", "")
    is_json = "application/json" in ctype
    # Per-IP rate limit: response shape matches the request (JSON / HTML form).
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
        # Atlas unreachable: clean 503 rather than an opaque 500 (only session
        # creation touches the registry; browsing with a live cookie doesn't).
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
        # Second factor required BEFORE the cookie. No code provided → signal the
        # client to ask for one. We answer 200 (NOT 401): it's a progression signal,
        # not an auth failure (password was correct, failure counter untouched), and
        # a 401 would log a console.error in every browser. The JS tests
        # data.totp_required before the status and sets no cookie here.
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
    # Cloud only: CSRF token (also set as a readable kb_csrf cookie) and 2FA state.
    # Locally (auth disabled) the session is fake and the store may be unreachable, and
    # CSRF is useless on 127.0.0.1, so we don't query it.
    if _s.CONFIG.auth_enabled:
        epoch = _s.current_session_epoch(email)
        user = _s.get_store().get_user_by_email(email) or {}
        payload["csrf_token"] = _s.make_csrf_token(email, epoch)
        payload["totp_enabled"] = bool(user.get("totp_enabled"))
    handler._send_json(200, payload)
