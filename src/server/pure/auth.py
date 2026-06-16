"""Session/share/CSRF token signing, email validation, and Bearer auth (security-critical crypto)."""
import base64
import hashlib
import hmac
import json
import sys
import time

import store
import server as _s


def _has_control_chars(value: str) -> bool:
    return any(ord(c) < 0x20 or ord(c) == 0x7f for c in value)


def is_valid_email(email: str) -> bool:
    """Shared validator (admin-users + setup): basic form, bounded length,
    no control character (NUL, DEL, C0/C1)."""
    if not email or len(email) > _s.MAX_EMAIL_LEN:
        return False
    if _has_control_chars(email):
        return False
    return _s._EMAIL_PATTERN.fullmatch(email) is not None


def _b64url_nopad(raw: bytes) -> str:
    """base64 urlsafe WITHOUT padding — the urlsafe alphabet (A-Za-z0-9-_) NEVER
    contains a '.', so joining two segments with '.' is unambiguous (the '.' can
    only come from the separator, never from a payload or signature byte)."""
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _b64url_nopad_decode(segment: str) -> bytes:
    pad = "=" * (-len(segment) % 4)
    return base64.urlsafe_b64decode(segment + pad)


def current_session_epoch(email: str) -> int:
    """Current session epoch of the account (integer, default 0).

    Bumping this epoch invalidates ALL sessions already issued for this account
    (logout-all, password reset, TOTP change): verify_token compares the epoch
    embedded in the cookie against this one. Raises if the registry is
    unreachable — verify_token treats it as fail-CLOSED (cookie rejected)."""
    user = _s.get_store().get_user_by_email(email)
    if not user:
        return 0
    return int(user.get("session_epoch") or 0)


def make_token(email: str, role: str, epoch: int = 0) -> str:
    """Signed session cookie: base64url(payload) + '.' + base64url(sig).

    The two segments are encoded SEPARATELY (urlsafe alphabet without '.') then
    joined by '.'. The old format concatenated payload + b"." + RAW sig before
    the base64: when the HMAC signature contained a 0x2e byte ('.'), the rsplit
    of verify_token cut into the signature → ~12% of cookies were
    self-invalidated. This format removes the ambiguity. The `ep` epoch enables
    server-side revocation."""
    payload = json.dumps({
        "email": email, "role": role, "ep": int(epoch), "ts": int(time.time()),
    }).encode()
    sig = hmac.new(_s.CONFIG.session_secret, payload, hashlib.sha256).digest()
    return _b64url_nopad(payload) + "." + _b64url_nopad(sig)


def verify_token(token: str):
    """Returns {'email': ..., 'role': ...} or None. Old tokens without role default to admin.

    Verifies, in order: HMAC signature (constant time) → expiration
    (CONFIG.session_max_age) → session epoch (server-side revocation). A registry
    unreachable at the time of the epoch check REJECTS the cookie (fail-closed):
    a re-login is better than a revoked session being re-validated."""
    try:
        payload_b64, sig_b64 = token.split(".", 1)
        # split(".", 1) guarantees two segments; a token without '.' (old
        # format) or with several '.' (impossible with the urlsafe alphabet)
        # falls into the exception via the decoding that follows.
        if "." in sig_b64:
            return None
        payload = _b64url_nopad_decode(payload_b64)
        sig = _b64url_nopad_decode(sig_b64)
        expected = hmac.new(_s.CONFIG.session_secret, payload, hashlib.sha256).digest()
        if not hmac.compare_digest(sig, expected):
            return None
        data = json.loads(payload)
        if time.time() - data["ts"] > _s.CONFIG.session_max_age:
            return None
        email = data["email"]
        cookie_epoch = int(data.get("ep") or 0)
        if current_session_epoch(email) != cookie_epoch:
            return None
        return {"email": email, "role": data.get("role", "admin")}
    except Exception:
        return None


def authenticate_user(email: str, password: str):
    """Returns the user dict if credentials match, None otherwise.

    Users with role 'api' cannot login via password (Bearer-only). The password
    is the FIRST factor; the second factor (TOTP / recovery code) is required by
    the caller AFTERWARDS, when the account has 2FA active."""
    user = _s.get_store().get_user_by_email(email)
    if not user:
        # Verify a dummy hash to equalize the response time: without it, an
        # unknown email responds instantly vs tens/hundreds of ms for a known
        # email → account enumeration oracle. The dummy is carried by the store
        # to match the cost of the scheme that ITS accounts actually use (bcrypt
        # rounds=12 for legacy bcrypt accounts — the old _dummy_bcrypt —, native scrypt +
        # possible bcrypt on the FileStore side).
        _s.get_store().dummy_verify(password)
        return None
    if user.get("role") == _s.API_ROLE:
        # Same here: we consume a verification before refusing, so as not to
        # distinguish an 'api' account from a normal one by timing.
        _s.get_store().dummy_verify(password)
        return None  # API users authenticate via /api/v1 + Bearer token, not by cookie
    # verify_password handles native scrypt AND the legacy bcrypt fallback ("$2…").
    if not store.verify_password(password, user["password_hash"]):
        return None
    return user


def authenticate(email: str, password: str):
    """Returns the user role if credentials match, None otherwise.

    Keeps the historical signature (role only). The 2-factor login flow goes
    through authenticate_user to be able to inspect the account's 2FA state."""
    user = authenticate_user(email, password)
    return user.get("role", "admin") if user else None


def make_share_token(path: str, expires_at: int) -> str:
    payload = json.dumps({"p": path, "e": expires_at}).encode()
    sig = hmac.new(_s.CONFIG.session_secret, payload, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(payload).decode().rstrip("=") + "." + \
           base64.urlsafe_b64encode(sig).decode().rstrip("=")


def verify_share_token(token: str):
    """Returns (path, error_code) where error_code is None|"invalid"|"expired"|"revoked"."""
    try:
        payload_b64, sig_b64 = token.split(".")
        pad = "=" * (-len(payload_b64) % 4)
        payload = base64.urlsafe_b64decode(payload_b64 + pad)
        sig_pad = "=" * (-len(sig_b64) % 4)
        sig = base64.urlsafe_b64decode(sig_b64 + sig_pad)
        expected = hmac.new(_s.CONFIG.session_secret, payload, hashlib.sha256).digest()
        if not hmac.compare_digest(sig, expected):
            return (None, "invalid")
        data = json.loads(payload)
        if data.get("e") and time.time() > data["e"]:
            return (None, "expired")
        # Revocation check in the FileStore registry. Fail-CLOSED: if the
        # registry is unreachable we REFUSE the
        # link (503 "unavailable") rather than risk serving a doc whose
        # revocation could not be verified. A public link points to potentially
        # sensitive content: unavailable is better than revocation bypassed
        # during an outage.
        if _s.CONFIG.auth_enabled:
            try:
                doc = _s.get_store().find_share_by_token(token)
            except Exception as e:
                print(f"[verify_share_token] registry check failed: {e}", file=sys.stderr)
                return (None, "unavailable")
            if doc and doc.get("revoked"):
                return (None, "revoked")
        return (data.get("p"), None)
    except Exception:
        return (None, "invalid")


# CSRF synchronizer token (session-bound double-submit): a READABLE kb_csrf cookie
# (not HttpOnly) carries the token; the logged-in page replays it in the
# X-CSRF-Token header on every mutating request. The token is an
# HMAC(session_secret, "email|epoch"): deterministic for a given session (so
# reconstructible server-side without storage) and it changes as soon as the
# session epoch moves (logout-all / password reset / TOTP). A third-party page
# CANNOT read the cookie (Same-Origin Policy) nor forge the HMAC (server secret) →
# it cannot set the correct header.
def make_csrf_token(email: str, epoch: int) -> str:
    message = f"{email}|{int(epoch)}".encode()
    sig = hmac.new(_s.CONFIG.session_secret, b"csrf:" + message, hashlib.sha256).digest()
    return _b64url_nopad(sig)


def verify_csrf_token(email: str, epoch: int, provided: str) -> bool:
    if not provided:
        return False
    expected = make_csrf_token(email, epoch)
    return hmac.compare_digest(expected, provided)


def consume_recovery_code(email: str, code: str) -> bool:
    """Consumes a SINGLE-USE recovery code (removes it from the stored list).

    The removal goes through the ATOMIC primitive store.consume_recovery_hash:
    presence + removal of the hash in A SINGLE critical section (FileStore) or a
    single conditional removal. Two concurrent logins presenting the SAME
    code can therefore no longer consume it twice (the old get_user_by_email +
    upsert_user released the lock between the read and the write).
    Returns False if no code matches (including already consumed)."""
    code = (code or "").strip()
    if not code:
        return False
    target = hashlib.sha256(code.encode()).hexdigest()
    return _s.get_store().consume_recovery_hash(email, target)


def _hash_api_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def verify_api_bearer(authorization_header: str):
    """Returns the user dict {'email', 'role'} or None.

    Expects header value like "Bearer <token>". Looks up the SHA256 of the
    token against the users collection. Bumps last_used_at on success.
    """
    if not authorization_header:
        return None
    parts = authorization_header.strip().split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    token = parts[1]
    if not token:
        return None
    token_hash = _hash_api_token(token)
    try:
        user = _s.get_store().find_api_identity(token_hash)
        if not user:
            return None
        # Best-effort update, ignore errors (fail-open on store write hiccups).
        try:
            _s.get_store().touch_last_used(user)
        except Exception:
            pass
        return {"email": user.get("email", "claude@api.local"), "role": _s.API_ROLE}
    except Exception as e:
        print(f"[verify_api_bearer] registry lookup failed: {e}", file=sys.stderr)
        return None


def _verify_mcp_token(token: str) -> bool:
    """Bearer verification for the /mcp/<token> channel: the token hashes to an API
    identity in the registry. Touches last_used best-effort."""
    if not token:
        return False
    try:
        token_hash = _hash_api_token(token)
        user = _s.get_store().find_api_identity(token_hash)
        if user:
            try:
                _s.get_store().touch_last_used(user)
            except Exception:
                pass
            return True
        return False
    except Exception as e:
        print(f"[verify_mcp_token] registry lookup failed: {e}", file=sys.stderr)
        return False
