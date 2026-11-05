"""Account routes: your own password, bulk logout and TOTP (2FA) enrollment / enable / disable."""
import sys
import server as _s
import store
from server.pure.auth import PASSWORD_CODES


def profile_get(handler):
    """GET /api/account/profile: the current session user's {email, first_name,
    last_name}. Names are optional (missing → empty string)."""
    email = handler._session().get("email")
    user = _s.get_store().get_user_by_email(email) or {}
    handler._send_json(200, {
        "email": email,
        "first_name": user.get("first_name") or "",
        "last_name": user.get("last_name") or "",
        "recovery_codes": len(user.get(PASSWORD_CODES) or []),
    })


def profile_post(handler):
    """POST /api/account/profile {first_name?, last_name?}: updates the caller's
    OWN names only. Empty/absent clears the field; rejects invalid names."""
    data = handler._read_json()
    fields = {}
    for key in ("first_name", "last_name"):
        if key not in data:
            continue
        value = data.get(key)
        if not _s.valid_name(value):
            handler._send_json(400, {"error": f"invalid {key}"})
            return
        fields[key] = (value or "").strip() or None
    email = handler._session().get("email")
    try:
        _s.get_store().upsert_user(email, fields)
    except Exception as e:
        _s.registry_503(handler, "[account] profile", e)
        return
    handler._send_json(200, {"ok": True})


def password_change(handler):
    """POST /api/account/password {current, password, code?} — your own password. The
    current one (and the 2FA code when on) is asked again; every other session ends, this
    one stays open."""
    email = handler._session().get("email")
    data = handler._read_json()
    password = data.get("password") or ""
    if len(password) < 8:
        handler._send_json(400, {"error": "password too short (8 chars minimum)"})
        return
    user = handler._reauthenticate(email, data.get("current"), data.get("code"))
    if not user:
        return
    epoch = int(user.get("session_epoch") or 0) + 1
    try:
        _s.get_store().upsert_user(email, {"password_hash": store.hash_password(password),
                                           "session_epoch": epoch})
    except Exception as e:
        _s.registry_503(handler, "[account] password", e)
        return
    handler.send_response(200)
    for cookie in handler._session_cookie_pair(email, user.get("role"), epoch):
        handler.send_header("Set-Cookie", cookie)
    handler.send_header("Cache-Control", "no-store")
    handler._send_json_after_cookie({"ok": True})


def password_codes(handler):
    """POST /api/account/recovery-codes {password, code?} — new recovery codes for your
    password (the old ones stop working), shown once. Asked with the password, so an open
    session alone can't plant a way back in."""
    email = handler._session().get("email")
    data = handler._read_json()
    if not handler._reauthenticate(email, data.get("password"), data.get("code")):
        return
    codes, hashes = _s.generate_recovery_codes()
    try:
        _s.get_store().upsert_user(email, {PASSWORD_CODES: hashes})
    except Exception as e:
        _s.registry_503(handler, "[account] recovery codes", e)
        return
    handler._send_json(200, {"codes": codes})


def logout_all(handler):
    """POST /api/account/logout-all: bumps the epoch → logs out all
    sessions of this account (including this one). The client must log in again."""
    sess = handler._session()
    email = sess.get("email")
    try:
        handler._bump_session_epoch(email)
    except Exception as e:
        _s.registry_503(handler, "[account] logout-all", e)
        return
    # Session now invalid → clear the cookies.
    handler.send_response(200)
    handler.send_header("Set-Cookie",
                     f"{_s.COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0")
    handler.send_header("Set-Cookie",
                     f"{_s.CSRF_COOKIE_NAME}=; Path=/; SameSite=Lax; Max-Age=0")
    handler.send_header("Cache-Control", "no-store")
    handler._send_json_after_cookie({"ok": True})


def totp_init(handler):
    """POST /api/account/totp/init: generates a candidate TOTP secret, returns the
    otpauth:// URI + plaintext secret (shown ONCE). Not active yet — stored as
    totp_pending_secret until confirmed via /enable."""
    sess = handler._session()
    email = sess.get("email")
    user = _s.get_store().get_user_by_email(email) or {}
    if user.get("totp_enabled"):
        handler._send_json(409, {"error": "2FA already enabled"})
        return
    secret = _s.generate_totp_secret()
    try:
        _s.get_store().upsert_user(email, {"totp_pending_secret": secret})
    except Exception as e:
        _s.registry_503(handler, "[account] totp init", e)
        return
    uri = _s.totp_provisioning_uri(secret, email, _s.CONFIG.site_name)
    handler._send_json(200, {"secret": secret, "otpauth_uri": uri})


def totp_enable(handler):
    """POST /api/account/totp/enable {code}: confirms the pending secret
    with a valid code, enables 2FA, generates the recovery codes (shown
    ONCE) and BUMPS the epoch (invalidates stolen sessions)."""
    data = handler._read_json()
    code = (data.get("code") or "").strip()
    sess = handler._session()
    email = sess.get("email")
    user = _s.get_store().get_user_by_email(email) or {}
    if user.get("totp_enabled"):
        handler._send_json(409, {"error": "2FA already enabled"})
        return
    pending = user.get("totp_pending_secret")
    if not pending:
        handler._send_json(400, {"error": "call /totp/init first"})
        return
    if not _s.verify_totp(pending, code):
        handler._send_json(400, {"error": "invalid code"})
        return
    recovery_codes, recovery_hashes = _s.generate_recovery_codes()
    try:
        _s.get_store().upsert_user(email, {
            "totp_enabled": True,
            "totp_secret": pending,
            "totp_pending_secret": None,
            "totp_recovery_hashes": recovery_hashes,
        })
        handler._bump_session_epoch(email)
    except Exception as e:
        _s.registry_503(handler, "[account] totp enable", e)
        return
    # Epoch changed: reissue fresh cookies so we don't log out the user who just
    # enabled 2FA from THIS session.
    new_epoch = _s.current_session_epoch(email)
    handler.send_response(200)
    for cookie in handler._session_cookie_pair(
            email, user.get("role", "admin"), new_epoch):
        handler.send_header("Set-Cookie", cookie)
    handler.send_header("Cache-Control", "no-store")
    handler._send_json_after_cookie({"ok": True, "recovery_codes": recovery_codes})


def totp_disable(handler):
    """POST /api/account/totp/disable {code|recovery}: disables 2FA
    after a valid second factor, purges the secret and the recovery codes,
    and BUMPS the epoch."""
    data = handler._read_json()
    code = (data.get("code") or "").strip()
    recovery = (data.get("recovery") or "").strip()
    sess = handler._session()
    email = sess.get("email")
    user = _s.get_store().get_user_by_email(email) or {}
    if not user.get("totp_enabled"):
        handler._send_json(409, {"error": "2FA not enabled"})
        return
    # Codes guessed here count like failed sign-ins: six digits don't stand a free run.
    ip = handler._client_ip()
    if not _s.login_rate_limit_ok(ip) or _s.account_lock_remaining(email) > 0:
        handler._send_json(429, {"error": "locked"})
        return
    verified = False
    if code:
        verified = _s.verify_totp(user.get("totp_secret") or "", code)
    elif recovery:
        verified = _s.consume_recovery_code(email, recovery)
    if not verified:
        _s.register_login_failure(email, ip)
        handler._send_json(400, {"error": "invalid code"})
        return
    _s.reset_login_failures(email)
    try:
        _s.get_store().upsert_user(email, {
            "totp_enabled": False,
            "totp_secret": None,
            "totp_pending_secret": None,
            "totp_recovery_hashes": [],
        })
        handler._bump_session_epoch(email)
    except Exception as e:
        _s.registry_503(handler, "[account] totp disable", e)
        return
    new_epoch = _s.current_session_epoch(email)
    handler.send_response(200)
    for cookie in handler._session_cookie_pair(
            email, user.get("role", "admin"), new_epoch):
        handler.send_header("Set-Cookie", cookie)
    handler.send_header("Cache-Control", "no-store")
    handler._send_json_after_cookie({"ok": True})
