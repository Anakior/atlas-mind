"""Auth routes: login page render, form/JSON login flow, logout, and the
session auth-state probe (/api/me)."""
import json
import sys
from urllib.parse import parse_qs
import server as _s
import store
from server.pure.auth import PASSWORD_CODES


def _safe_next(value) -> str:
    """Where to land after signing in: a local path only (never //host or a scheme),
    so the login page can't be turned into an open redirect."""
    v = value if isinstance(value, str) else ""
    if (not v.startswith("/") or v.startswith(("//", "/\\")) or len(v) > 2048
            or any(ord(c) < 0x20 for c in v)):
        return "/"
    return v


def password_recover(handler):
    """POST /api/password/recover {email, code, password} — a forgotten password replaced
    with one of the account's recovery codes (Settings › Me), each good once. A wrong code
    counts like a failed sign-in; the 2FA, when on, is still asked at the next sign-in."""
    data = handler._read_json()
    email = (data.get("email") or "").strip().lower()
    ip = handler._client_ip()
    if not _s.login_rate_limit_ok(ip) or (email and _s.account_lock_remaining(email) > 0):
        handler._send_json(429, {"error": _s._t("login_rate_limited")})
        return
    password = data.get("password") or ""
    if len(password) < 8:
        handler._send_json(400, {"error": _s._t("recover_too_short")})
        return
    user = _s.get_store().get_user_by_email(email) if email else None
    if not user or not _s.consume_recovery_code(email, data.get("code"), PASSWORD_CODES):
        _s.register_login_failure(email, ip)
        handler._send_json(401, {"error": _s._t("recover_bad_code")})
        return
    try:
        _s.get_store().upsert_user(email, {"password_hash": store.hash_password(password),
                                           "session_epoch": int(user.get("session_epoch") or 0) + 1})
    except Exception as e:
        _s.registry_503(handler, "[auth] recover password", e)
        return
    _s.reset_login_failures(email)
    handler._send_json(200, {"ok": True, "message": _s._t("recover_done")})


def login_page(handler):
    """GET /login (cloud) — render the login page. Thin wrapper over the Handler's
    _send_login_page plumbing (also called by the login flow with error/status).
    `next` (e.g. an OAuth authorize URL) is where a successful sign-in lands."""
    handler._send_login_page(next_url=_safe_next((handler._query().get("next") or [""])[0]))


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
    handler._open_session_response(email, role, _safe_next(data.get("next")))


def logout(handler):
    # Only a navigation signs out: an <img src="/logout"> in a note must not log its reader
    # out (a browser without Fetch Metadata sends no header and keeps working).
    if handler.headers.get("Sec-Fetch-Dest", "document") not in ("document", "empty"):
        handler.send_response(403)
        handler.send_header("Content-Length", "0")
        handler.end_headers()
        return
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
        payload["name"] = _s.display_name(user) or email
        # Raw name halves so the client seeds the avatar identically to the admin
        # list / profile (avatarSeed = name + email); display_name above is for text.
        payload["first_name"] = user.get("first_name") or ""
        payload["last_name"] = user.get("last_name") or ""
    handler._send_json(200, payload)
