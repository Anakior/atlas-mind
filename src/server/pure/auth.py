"""Session/share/CSRF token signing, email validation, and Bearer auth (security-critical crypto)."""
import base64
import hashlib
import hmac
import json
import secrets
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

    Bumping it invalidates ALL sessions issued for this account (logout-all,
    password reset, TOTP change): verify_token compares the cookie's epoch against
    this one. Raises if the registry is unreachable — verify_token treats it as
    fail-CLOSED (cookie rejected)."""
    user = _s.get_store().get_user_by_email(email)
    if not user:
        return 0
    return int(user.get("session_epoch") or 0)


def make_token(email: str, role: str, epoch: int = 0) -> str:
    """Signed session cookie: base64url(payload) + '.' + base64url(sig).

    Both segments are encoded SEPARATELY (urlsafe alphabet has no '.') then joined
    by '.', removing the ambiguity of the old format (a 0x2e byte in the raw sig
    let verify_token's rsplit cut into it → ~12% of cookies self-invalidated). The
    `ep` epoch enables server-side revocation."""
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
        # An old-format token (no '.') falls into the exception via the decoding
        # below; a second '.' (impossible with the urlsafe alphabet) is rejected here.
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
        # Verify a dummy hash to equalize response time: an unknown email replying
        # instantly vs ms for a known one is an account-enumeration oracle. The
        # store carries a dummy matching the cost of its real scheme.
        _s.get_store().dummy_verify(password)
        return None
    if user.get("role") == _s.API_ROLE or user.get("invite_token_hash"):
        # 'api' accounts authenticate via Bearer, not a cookie; a PENDING invite
        # has no usable password yet (it is set only when the invitee accepts).
        # Same timing equalization before refusing — and we never reach
        # verify_password, so a pending account (no password_hash) cannot KeyError
        # nor route an UNUSABLE "$2…" sentinel into bcrypt.
        _s.get_store().dummy_verify(password)
        return None
    # verify_password handles native scrypt AND the legacy bcrypt fallback ("$2…").
    if not store.verify_password(password, user.get("password_hash")):
        return None
    return user


def authenticate(email: str, password: str):
    """Returns the user role if credentials match, None otherwise.

    Keeps the historical signature (role only). The 2-factor login flow goes
    through authenticate_user to be able to inspect the account's 2FA state."""
    user = authenticate_user(email, password)
    return user.get("role", "admin") if user else None


# Share links are opaque CAPABILITY tokens: a random key whose SHA256 indexes the
# share registry. The target path lives in the registry (mutable), not in the token,
# so a link survives the doc being moved/renamed. 16 bytes → 128-bit capability.
SHARE_TOKEN_BYTES = 16


def new_share_token() -> str:
    """A fresh opaque share token (random capability key, not a signed payload).
    Only its SHA256 is the lookup index; the target path is read from the registry."""
    return secrets.token_urlsafe(SHARE_TOKEN_BYTES)


def verify_share_token(token: str):
    """Resolve a share token to its current target path via the registry.

    Returns (path, error_code) with error_code in
    None | "invalid" | "expired" | "revoked" | "unavailable".

    The registry is the single source of truth: an unknown token is rejected
    (fail-CLOSED), a revoked/expired record is refused, and an unreadable registry
    yields "unavailable" (503) rather than risk leaking. The path is read from the
    record (mutable), which lets a link outlive a doc move."""
    if not token:
        return (None, "invalid")
    try:
        record = _s.get_store().find_share_by_token(token)
    except Exception as e:
        print(f"[verify_share_token] registry lookup failed: {e}", file=sys.stderr)
        return (None, "unavailable")
    if not record:
        return (None, "invalid")
    if record.get("revoked"):
        return (None, "revoked")
    expires_at = record.get("expires_at") or 0
    if expires_at and time.time() > expires_at:
        return (None, "expired")
    return (record.get("path"), None)


# CSRF synchronizer token (session-bound double-submit): a readable kb_csrf cookie
# carries an HMAC(session_secret, "email|epoch"), replayed in the X-CSRF-Token
# header on mutating requests. Deterministic per session (reconstructible without
# storage), rotates with the epoch (logout-all/reset/TOTP). A third-party page can
# neither read the cookie (SOP) nor forge the HMAC → it can't set the right header.
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

    Removal goes through the ATOMIC store.consume_recovery_hash (presence + removal
    in one critical section), so two concurrent logins with the SAME code can't
    consume it twice (the old read-then-write released the lock in between).
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
        # Best-effort: a store write hiccup must not fail auth.
        try:
            _s.get_store().touch_last_used(user)
        except Exception:
            pass
        return {"email": user.get("email", "claude@api.local"), "role": _s.API_ROLE,
                "acts_as": user.get("acts_as"), "label": user.get("label")}
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


def resolve_mcp_identity(token: str):
    """Identity {email, role, acts_as?} behind an MCP token (/mcp/<token>), or
    None. Unlike _verify_mcp_token (a bool), it KEEPS the identity so the dispatch
    can enforce per-document ACL. Touches last_used best-effort."""
    if not token:
        return None
    try:
        user = _s.get_store().find_api_identity(_hash_api_token(token))
        if not user:
            return None
        try:
            _s.get_store().touch_last_used(user)
        except Exception:
            pass
        return {"email": user.get("email", "claude@api.local"),
                "role": _s.API_ROLE, "acts_as": user.get("acts_as"),
                "label": user.get("label")}
    except Exception as e:
        print(f"[resolve_mcp_identity] registry lookup failed: {e}", file=sys.stderr)
        return None
