"""First-boot setup routes: the admin-creation page and its submit endpoint.

Both routes self-handle their own setup-token / first-boot-window logic (409 when
the window is closed, 403 on a bad token); they are NOT table-guarded.
"""
import hmac
import sys
import time
import store
import server as _s


def submit(handler):
    """POST /api/setup {email, password, setup_token}: creates the FIRST
    admin and opens the session. Refuses outside the first-boot window (409),
    on a bad token (403, constant-time comparison), invalid email/password
    (400). Once the admin is created, the window closes for good
    (setup_is_open() becomes False)."""
    # Always read the body (keep-alive), even if we're going to refuse.
    data = handler._read_json()
    # BASE CSRF only: no session exists yet (we're creating the first admin),
    # so no synchronizer CSRF token is possible — the constant-time setup
    # token is the real protection against drive-by requests.
    if not handler._check_csrf_base_or_403():
        return
    if not _s.setup_is_open():
        handler._send_json(409, {"error": "setup already completed"})
        return
    provided = (data.get("setup_token") or "")
    if not hmac.compare_digest(str(provided), _s._CTX.setup_token.token or ""):
        handler._send_json(403, {"error": _s._t("setup_bad_token")})
        return
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    if not _s.is_valid_email(email):
        handler._send_json(400, {"error": _s._t("setup_invalid_email")})
        return
    if len(password) < 8:
        handler._send_json(400, {"error": _s._t("setup_password_too_short")})
        return
    def _create_admin():
        _s.get_store().upsert_user(email, {
            "password_hash": store.hash_password(password),
            "role": "admin",
            "created_at": int(time.time()),
        })
    try:
        # Anti-race guard: a second concurrent POST must not create a second
        # "first" admin. consume() re-checks has_admin under the lock and
        # closes the window in the same critical section.
        claimed = _s._CTX.setup_token.consume(_create_admin)
    except Exception as e:
        _s.registry_503(handler, "[setup] could not create admin account", e)
        return
    if not claimed:
        handler._send_json(409, {"error": "setup already completed"})
        return
    handler.send_response(200)
    for cookie in handler._session_cookie_pair(email, "admin",
                                            _s.current_session_epoch(email)):
        handler.send_header("Set-Cookie", cookie)
    handler.send_header("Cache-Control", "no-store")
    handler._send_json_after_cookie({"ok": True, "email": email})


def page(handler):
    """GET /setup (cloud) — the first-boot admin-creation page while the window
    is open, else 404 (the window closes once an admin exists)."""
    if _s.setup_is_open():
        handler._send_setup_page()
    else:
        handler.send_error(404)
