"""Account routes: bulk logout and TOTP (2FA) enrollment / enable / disable."""
import sys
import server as _s


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
    verified = False
    if code:
        verified = _s.verify_totp(user.get("totp_secret") or "", code)
    elif recovery:
        verified = _s.consume_recovery_code(email, recovery)
    if not verified:
        handler._send_json(400, {"error": "invalid code"})
        return
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
