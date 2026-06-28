"""TOTP (RFC 6238) two-factor auth — stdlib only, pure crypto.

base32 secret (shared key), 6-digit code from HMAC-SHA1 over the time step
(T = floor(unix / 30)), verified +/-1 step for clock drift. Plus single-use
recovery-code GENERATION (only the SHA256 hashes are stored). No third-party dep
(no pyotp). Every function here is pure — server/__init__ re-exports them as
server.* and keeps consume_recovery_code (which touches the store)."""
import base64
import hashlib
import hmac
import struct
import time

TOTP_STEP_SECONDS = 30
TOTP_DIGITS = 6
TOTP_WINDOW = 1  # ±1 step (~30 s clock-drift tolerance)
TOTP_SECRET_BYTES = 20  # 160 bits, RFC 4226 recommendation for HMAC-SHA1
RECOVERY_CODE_COUNT = 10


def generate_totp_secret() -> str:
    """Random TOTP secret encoded as base32 (no padding), shown only once."""
    import secrets
    return base64.b32encode(secrets.token_bytes(TOTP_SECRET_BYTES)).decode().rstrip("=")


def _hotp(secret_bytes: bytes, counter: int) -> str:
    counter_bytes = struct.pack(">Q", counter)
    digest = hmac.new(secret_bytes, counter_bytes, hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    binary = ((digest[offset] & 0x7F) << 24
              | (digest[offset + 1] & 0xFF) << 16
              | (digest[offset + 2] & 0xFF) << 8
              | (digest[offset + 3] & 0xFF))
    return str(binary % (10 ** TOTP_DIGITS)).zfill(TOTP_DIGITS)


def _decode_base32_secret(secret_b32: str) -> bytes:
    # b32decode requires padding and uppercase: we restore both.
    padded = secret_b32.strip().upper()
    padded += "=" * (-len(padded) % 8)
    return base64.b32decode(padded)


def verify_totp_step(secret_b32: str, code: str, *, at: int = None):
    """Verifies a TOTP code in constant time over the ±TOTP_WINDOW window and
    returns the matched ABSOLUTE step (counter), or None if invalid.

    Compares ALL steps of the window before returning (no short-circuit on the
    first match): the response time does not depend on the step that validates.
    A malformed code (length/non-digits) is rejected without revealing by timing
    whether it reached the HMAC comparison. The returned step lets the login path
    refuse replays (a code stays valid ~90 s across the window)."""
    code = (code or "").strip()
    if len(code) != TOTP_DIGITS or not code.isdigit():
        return None
    try:
        secret_bytes = _decode_base32_secret(secret_b32)
    except (ValueError, TypeError):
        return None
    if at is None:
        at = int(time.time())
    counter = at // TOTP_STEP_SECONDS
    matched = None
    for step in range(-TOTP_WINDOW, TOTP_WINDOW + 1):
        candidate = _hotp(secret_bytes, counter + step)
        if hmac.compare_digest(candidate, code):
            matched = counter + step
    return matched


def verify_totp(secret_b32: str, code: str, *, at: int = None) -> bool:
    """True if `code` is a valid TOTP in the ±TOTP_WINDOW window (constant time)."""
    return verify_totp_step(secret_b32, code, at=at) is not None


def totp_provisioning_uri(secret_b32: str, account: str, issuer: str) -> str:
    """otpauth:// URI for QR code / manual entry in the authenticator app."""
    from urllib.parse import quote
    label = quote(f"{issuer}:{account}")
    params = (f"secret={secret_b32}&issuer={quote(issuer)}"
              f"&algorithm=SHA1&digits={TOTP_DIGITS}&period={TOTP_STEP_SECONDS}")
    return f"otpauth://totp/{label}?{params}"


# ── single-use recovery codes ──────────────────────────────────────────────────


def generate_recovery_codes(count: int = RECOVERY_CODE_COUNT):
    """Returns (plaintext_codes, hashed_codes). The plaintext is shown only
    once; ONLY the SHA256 is stored. Readable format grouped with dashes."""
    import secrets
    codes = []
    hashes = []
    for _ in range(count):
        raw = secrets.token_hex(8)  # 16 hex (64 bits of entropy)
        pretty = f"{raw[:8]}-{raw[8:]}"
        codes.append(pretty)
        hashes.append(hashlib.sha256(pretty.encode()).hexdigest())
    return codes, hashes
