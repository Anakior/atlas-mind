#!/usr/bin/env python3
"""Knowledge-base viewer server, dual local/cloud mode.

Local mode (default):
    Run: python server.py
    Open: http://localhost:8765
    No auth, serves files from the repo directory directly.

Cloud mode (when KB_AUTH_ENABLED=1):
    Required env vars: GITHUB_REPO_URL (with PAT embedded) and SESSION_SECRET.
    The identity/share registry is a FileStore: users + share links in JSON
    under ROOT/.atlas/ (no database). See src/store.py.
    ATLAS_STORE_DIR relocates the registry, default ROOT/.atlas.
    The registry is NEVER committed/pushed with the content repo (it holds
    password/token hashes): point ATLAS_STORE_DIR at a persistent volume in
    cloud, otherwise users/shares are lost when the ephemeral rootfs is rebuilt.
    The repo is cloned at startup into KB_REPO_PATH (default /app/repo).
    A background thread pulls the repo every GIT_PULL_INTERVAL seconds (default 30).
    All routes require a signed session cookie; /login renders an HTML form.

API:
    GET    /api/todos
    POST   /api/todos          {text}
    PATCH  /api/todos/:id      {done?, text?}
    DELETE /api/todos/:id
    GET    /api/events         (SSE, live reload in local mode)
    PUT    /api/file           {path, content}    (md edition)
    GET    /login              (cloud mode only)
    POST   /login              (cloud mode only ; 2 steps if 2FA is active)
    GET    /logout             (cloud mode only)
    POST   /api/account/logout-all          (revokes all of the user's sessions)
    POST   /api/account/totp/init           (2FA enrollment: secret + URI)
    POST   /api/account/totp/enable {code}  (enables 2FA + recovery codes)
    POST   /api/account/totp/disable {code|recovery}  (disables 2FA)

The todos live in the markdown file configured by [todo].file in atlas.toml
(GitHub Flavored Markdown checkboxes).

Configuration: src/config.py (AtlasConfig). The mind (content directory) is
resolved via ATLAS_MIND (otherwise the historical behavior), an optional
<mind>/atlas.toml provides the settings, and env vars keep priority.
"""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs
import base64
import gzip
import hashlib
import hmac
import html
import json
import os
import posixpath
import re
import signal
import struct
import subprocess
import sys
import tempfile
import threading
import time
import uuid

COOKIE_NAME = "kb_session"
# Readable CSRF cookie (NOT HttpOnly): the logged-in page reads it to set the
# X-CSRF-Token header on mutating requests (session-bound double-submit).
# Distinct from the HttpOnly session cookie.
CSRF_COOKIE_NAME = "kb_csrf"
# Bounds the request body: a huge Content-Length would inflate the in-memory
# read (DoS on the 256 MB VM). 25 MB = generous for a .md, tight for abuse.
MAX_BODY_BYTES = 25 * 1024 * 1024

# Identities (admin/viewer email, token identity email): basic email form +
# hardened bounds. RFC 5321 caps the address at 254 bytes; we also reject any
# C0/C1 control character (the \s in the pattern let NUL and DEL through, which
# would pollute the durable registry).
_EMAIL_PATTERN = re.compile(r"[^@\s]+@[^@\s]+")
MAX_EMAIL_LEN = 254
MAX_TOKEN_LABEL_LEN = 100


def _has_control_chars(value: str) -> bool:
    return any(ord(c) < 0x20 or ord(c) == 0x7f for c in value)


def is_valid_email(email: str) -> bool:
    """Shared validator (admin-users + setup): basic form, bounded length,
    no control character (NUL, DEL, C0/C1)."""
    if not email or len(email) > MAX_EMAIL_LEN:
        return False
    if _has_control_chars(email):
        return False
    return _EMAIL_PATTERN.fullmatch(email) is not None


sys.path.insert(0, str(Path(__file__).resolve().parent))  # src/ on path for sibling imports
import store  # identity/share registry: FileStore (JSON under .atlas/)
from config import AtlasConfig, AtlasConfigError, resolve_mind_root

# The SINGLE server configuration object (paths, port, auth, todos, store…).
# Built in __main__ — after the possible clone in cloud mode, so that
# <mind>/atlas.toml is readable at read time. No more reassignment of derived
# globals: everything goes through CONFIG (env > toml > defaults,
# see src/config.py).
CONFIG = None  # type: AtlasConfig

TODO_HEADER = "# To-do\n\nEditable from the widget in the bottom-right of the viewer.\n\n"


def _norm_cat(value):
    # Todo categories (CONFIG.todo_categories, default "travail"/"personnel"):
    # stored in the todo file under H2 sections (## Travail / ## Personnel);
    # the widget filters by category. See parse_todos / write_todos.
    v = (value or "").strip().lower()
    return v if v in CONFIG.todo_categories else CONFIG.todo_cat_default

_sse_clients = []
_sse_lock = threading.Lock()
_git_lock = threading.Lock()

# First-boot (cloud mode): random install token generated at startup when NO
# admin account exists. Printed to stderr, required by /api/setup to create the
# very first admin (anti drive-by). Stays None as long as an admin exists (the
# /setup window is then closed for good). See maybe_init_setup_token.
_setup_token = None
_setup_lock = threading.Lock()


# ─── Auth helpers ──────────────────────────────────────────────────────────────


_store = None
_store_lock = threading.Lock()


def _exclude_store_dir_from_git(store_dir):
    """Adds the registry directory to .git/info/exclude (idempotent).

    The registry (password hashes, api_token_hash, SHA256 of share-tokens)
    lives by default under ROOT/.atlas — INSIDE the content git repo that
    trigger_sync/pull_and_rebuild commit via `git add -A` then push to GitHub.
    Without exclusion, these derived secrets enter the git history forever (and
    state.json, rewritten on every Bearer request, generates commit churn).
    Belt AND braces with the .gitignore "*" that FileStore writes in its own
    directory. Best-effort: a failure does not block the boot."""
    git_dir = CONFIG.root / ".git"
    if not git_dir.is_dir():
        return
    try:
        relative = store_dir.resolve().relative_to(CONFIG.root.resolve())
    except ValueError:
        return  # registry outside the repo (ATLAS_STORE_DIR): git does not see it
    pattern = "/" + relative.as_posix() + "/"
    exclude_path = git_dir / "info" / "exclude"
    try:
        existing = ""
        if exclude_path.exists():
            existing = exclude_path.read_text(encoding="utf-8")
        if pattern in existing.splitlines():
            return
        exclude_path.parent.mkdir(parents=True, exist_ok=True)
        with open(exclude_path, "a", encoding="utf-8") as handle:
            if existing and not existing.endswith("\n"):
                handle.write("\n")
            handle.write(pattern + "\n")
    except OSError as e:
        print(f"[get_store] could not git-exclude the registry: {e}",
              file=sys.stderr)


def get_store():
    """Identity/share registry (users + share_links), see src/store.py.

    Lazy init (double-checked locking): CONFIG is only built in __main__ (after
    the possible clone in cloud mode), so the FileStore must point to the final
    mind.

    CONFIG.store_dir: registry location, default <mind>/.atlas (overridden by env
    ATLAS_STORE_DIR or atlas.toml). In cloud, point it at a persistent volume
    outside the repo (the Fly rootfs is ephemeral AND the content repo must not
    carry credentials); without a volume, cloud LOSES users/shares on every
    machine recreation — the registry is deliberately never committed/pushed."""
    global _store
    if _store is None:
        with _store_lock:
            if _store is None:
                store_dir = CONFIG.store_dir
                _store = store.FileStore(store_dir)
                _exclude_store_dir_from_git(store_dir)
    return _store


VALID_ROLES = ("admin", "viewer", "api")
API_ROLE = "api"  # Read + create only, never via session cookie


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
    user = get_store().get_user_by_email(email)
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
    sig = hmac.new(CONFIG.session_secret, payload, hashlib.sha256).digest()
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
        expected = hmac.new(CONFIG.session_secret, payload, hashlib.sha256).digest()
        if not hmac.compare_digest(sig, expected):
            return None
        data = json.loads(payload)
        if time.time() - data["ts"] > CONFIG.session_max_age:
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
    user = get_store().get_user_by_email(email)
    if not user:
        # Verify a dummy hash to equalize the response time: without it, an
        # unknown email responds instantly vs tens/hundreds of ms for a known
        # email → account enumeration oracle. The dummy is carried by the store
        # to match the cost of the scheme that ITS accounts actually use (bcrypt
        # rounds=12 for legacy bcrypt accounts — the old _dummy_bcrypt —, native scrypt +
        # possible bcrypt on the FileStore side).
        get_store().dummy_verify(password)
        return None
    if user.get("role") == API_ROLE:
        # Same here: we consume a verification before refusing, so as not to
        # distinguish an 'api' account from a normal one by timing.
        get_store().dummy_verify(password)
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


# ─── First-boot: initial admin account (cloud mode) ─────────────────────────────


def store_has_admin() -> bool:
    """True if at least one account with role 'admin' exists in the registry.

    A registry error (corrupted/unreachable) propagates instead of being
    swallowed: the boot caller treats it as "unable to know" (we do NOT open the
    /setup window blindly), and the request guards fail-closed."""
    return get_store().has_admin()


def maybe_init_setup_token() -> None:
    """Generates the first-boot install token if no admin exists.

    Called once at startup in cloud mode. If the registry is unreachable, we do
    NOT open the /setup window (the token stays None and setup_is_open() will
    return False on the request side): an unavailable setup is better than a
    window opened blindly. The token is printed to stderr — never in an HTTP
    response."""
    global _setup_token
    if not CONFIG.auth_enabled:
        return
    try:
        if store_has_admin():
            return
    except Exception as e:
        print(f"[setup] registry unreachable at boot, /setup window not "
              f"opened: {e}", file=sys.stderr)
        return
    import secrets
    with _setup_lock:
        if _setup_token is None:
            _setup_token = secrets.token_urlsafe(32)
    sys.stderr.write(
        f"\nAtlas setup token: {_setup_token}\n"
        f"  -> open /setup to create the admin account\n\n")
    sys.stderr.flush()


def setup_is_open() -> bool:
    """Is the first-boot window open?

    Cloud mode only, token generated at boot AND still no admin. As soon as an
    admin exists, it closes for good (the token is invalidated)."""
    if not CONFIG.auth_enabled or _setup_token is None:
        return False
    try:
        return not store_has_admin()
    except Exception:
        # Registry unreachable: we do NOT treat it as "open" (don't let an admin
        # be created on a registry we know nothing about).
        return False


# ─── Share tokens (signed public links) ────────────────────────────────────────


def make_share_token(path: str, expires_at: int) -> str:
    payload = json.dumps({"p": path, "e": expires_at}).encode()
    sig = hmac.new(CONFIG.session_secret, payload, hashlib.sha256).digest()
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
        expected = hmac.new(CONFIG.session_secret, payload, hashlib.sha256).digest()
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
        if CONFIG.auth_enabled:
            try:
                doc = get_store().find_share_by_token(token)
            except Exception as e:
                print(f"[verify_share_token] registry check failed: {e}", file=sys.stderr)
                return (None, "unavailable")
            if doc and doc.get("revoked"):
                return (None, "revoked")
        return (data.get("p"), None)
    except Exception:
        return (None, "invalid")


# ─── CSRF synchronizer token (session-bound) ───────────────────────────────────
#
# Session-bound double-submit: a READABLE kb_csrf cookie (not HttpOnly) carries
# the token; the logged-in page replays it in the X-CSRF-Token header on every
# mutating request. The token is an HMAC(session_secret, "email|epoch"): it is
# deterministic for a given session (so reconstructible server-side without
# storage) and changes as soon as the session epoch moves (logout-all/reset/TOTP).
# A third-party page CANNOT read the cookie (Same-Origin Policy) nor forge the
# HMAC (server secret) → it cannot set the correct header.


def make_csrf_token(email: str, epoch: int) -> str:
    message = f"{email}|{int(epoch)}".encode()
    sig = hmac.new(CONFIG.session_secret, b"csrf:" + message, hashlib.sha256).digest()
    return _b64url_nopad(sig)


def verify_csrf_token(email: str, epoch: int, provided: str) -> bool:
    if not provided:
        return False
    expected = make_csrf_token(email, epoch)
    return hmac.compare_digest(expected, provided)


# ─── TOTP (RFC 6238) — stdlib only ──────────────────────────────────────────────
#
# base32 secret (shared key), 6-digit code derived from HMAC-SHA1 over the time
# step number (T = floor(unix / 30)). Verification ±1 step to absorb clock
# drift. No dependency (no pyotp): hmac, hashlib, base64, struct, secrets from
# the stdlib.

TOTP_STEP_SECONDS = 30
TOTP_DIGITS = 6
TOTP_WINDOW = 1  # ±1 step (~30 s clock-drift tolerance)
TOTP_SECRET_BYTES = 20  # 160 bits, RFC 4226 recommendation for HMAC-SHA1
RECOVERY_CODE_COUNT = 10
_BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"


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
        raw = secrets.token_hex(5)  # 10 hex
        pretty = f"{raw[:5]}-{raw[5:]}"
        codes.append(pretty)
        hashes.append(hashlib.sha256(pretty.encode()).hexdigest())
    return codes, hashes


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
    return get_store().consume_recovery_hash(email, target)


# ─── Per-account lockout (volatile state in .atlas/state.json) ──────────────────
#
# COMPLEMENT to the per-IP rate-limit (login_rate_limit_ok): counts failures per
# email with growing backoff. Stored in <store_dir>/auth_state.json — NEVER
# committed (the store_dir's .gitignore "*" covers it), NEVER in the durable
# registry users.json. Reset on the first success. fail2ban-friendly log on stderr.

LOCKOUT_THRESHOLD = 5          # failures before the first lock
LOCKOUT_BASE_SECONDS = 60      # duration of the 1st lock
LOCKOUT_MAX_SECONDS = 3600     # backoff cap (1 h)
_AUTH_STATE_FILE = "auth_state.json"
_lockout_lock = threading.Lock()


def _auth_state_path():
    return CONFIG.store_dir / _AUTH_STATE_FILE


def _load_auth_state() -> dict:
    try:
        return json.loads(_auth_state_path().read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError, OSError):
        return {}


def _ensure_store_dir_gitignored(directory) -> None:
    """Drops a .gitignore "*" in the registry directory if it does not exist.

    The store_dir lives by default under ROOT/.atlas, INSIDE the content repo:
    auth_state.json (per-email failure counters) must never be committed. FileStore
    already writes this .gitignore; we also drop it here as a backstop to cover
    the lockout file. Best-effort (a failure does not block the login)."""
    try:
        directory.mkdir(parents=True, exist_ok=True)
        if (directory / ".git").exists():
            return  # don't hide an entire misconfigured repo
        gitignore = directory / ".gitignore"
        if not gitignore.exists():
            gitignore.write_text("*\n", encoding="utf-8")
    except OSError:
        pass


def _write_auth_state(state: dict) -> None:
    path = _auth_state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    _ensure_store_dir_gitignored(path.parent)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=_AUTH_STATE_FILE + ".",
                               suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(state, handle)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _lockout_duration(fail_count: int) -> int:
    """Bounded exponential backoff: 60 s, 120 s, 240 s… capped at 1 h."""
    over = max(0, fail_count - LOCKOUT_THRESHOLD)
    return min(LOCKOUT_MAX_SECONDS, LOCKOUT_BASE_SECONDS * (2 ** over))


def account_lock_remaining(email: str) -> int:
    """Remaining lock seconds for this account (0 if not locked)."""
    if not email:
        return 0
    with _lockout_lock:
        entry = _load_auth_state().get(email.lower())
    if not entry:
        return 0
    remaining = int(entry.get("locked_until", 0)) - int(time.time())
    return remaining if remaining > 0 else 0


def register_login_failure(email: str, ip: str) -> None:
    """Increments the account's failure counter and sets a lock beyond the
    threshold. fail2ban-friendly log on stderr (never a secret or a password).

    Counts ONLY failures on an EXISTING account: an unknown email accumulates
    nothing (no state.json swelling under an enumeration attack, and an attacker
    cannot lock an arbitrary email that does not exist). The per-IP rate-limit,
    for its part, already caps attempts on unknown emails."""
    if not email:
        return
    key = email.lower()
    try:
        if get_store().get_user_by_email(key) is None:
            return
    except Exception:
        # Registry unreachable: we still log the attempt for fail2ban, but we
        # don't write a counter (we don't know whether the account exists).
        sys.stderr.write(f"auth fail email={key} ip={ip} count=?\n")
        sys.stderr.flush()
        return
    with _lockout_lock:
        state = _load_auth_state()
        entry = state.get(key, {"fail_count": 0, "locked_until": 0})
        entry["fail_count"] = int(entry.get("fail_count", 0)) + 1
        if entry["fail_count"] >= LOCKOUT_THRESHOLD:
            entry["locked_until"] = int(time.time()) + _lockout_duration(
                entry["fail_count"])
        state[key] = entry
        try:
            _write_auth_state(state)
        except OSError as error:
            print(f"[auth] lockout state write failed: {error}", file=sys.stderr)
        count = entry["fail_count"]
    # Structured line parseable by fail2ban (regex on email/ip/count).
    sys.stderr.write(f"auth fail email={key} ip={ip} count={count}\n")
    sys.stderr.flush()


def reset_login_failures(email: str) -> None:
    """Clears the account's failure counter (called on the first successful login)."""
    if not email:
        return
    key = email.lower()
    with _lockout_lock:
        state = _load_auth_state()
        if key in state:
            state.pop(key, None)
            try:
                _write_auth_state(state)
            except OSError as error:
                print(f"[auth] lockout reset write failed: {error}",
                      file=sys.stderr)


# ─── API Bearer auth (for external connectors: Claude.ai, MCP, etc.) ───
#
# The /api/v1/* endpoints are protected by a Bearer token independent of the
# cookie system. The token is stored in the registry as a SHA256 hash on the
# claude@api.local user.
#
# Permissions of the 'api' role via REST /api/v1: read (search/file GET/tree/recent)
# + create (POST /api/v1/file refuses overwriting). Any other operation (DELETE,
# PUT edit, move, share, todos) returns 403, even with a valid token.
# Note: the MCP (/mcp/<token>) additionally exposes editing (edit_doc) because
# Claude first reads the doc then amends it; REST overwriting stays forbidden.

# Soft cap on the in-memory rate-limit dicts: once a limiter grows past this,
# fully-expired keys are swept. Without it, rotating source IPs (or IPv6 churn
# behind a proxy) / churned API tokens grow these module-level dicts without
# bound — a slow memory-exhaustion vector on a long-running instance.
_RATE_BUCKET_CAP = 4096


def _evict_stale_buckets(buckets: dict, cutoff: float) -> None:
    """Drop limiter keys whose timestamps are all older than `cutoff` (empty or
    fully expired). The most-recent timestamp is the last appended, so a single
    `ts[-1] <= cutoff` check identifies a key with nothing left in its window."""
    for key in [k for k, ts in buckets.items() if not ts or ts[-1] <= cutoff]:
        del buckets[key]


API_RATE_LIMIT_PER_MIN = 120  # requests/min per token
_api_rate_buckets: dict[str, list[float]] = {}
_api_rate_lock = threading.Lock()


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
        user = get_store().find_api_identity(token_hash)
        if not user:
            return None
        # Best-effort update, ignore errors (fail-open on store write hiccups).
        try:
            get_store().touch_last_used(user)
        except Exception:
            pass
        return {"email": user.get("email", "claude@api.local"), "role": API_ROLE}
    except Exception as e:
        print(f"[verify_api_bearer] registry lookup failed: {e}", file=sys.stderr)
        return None


def verify_node_bearer(authorization_header: str):
    """Returns the node dict {'name', 'path'} for a valid node token, or None.

    Counterpart of verify_api_bearer for NODE tokens (hive, #10). A node
    token opens neither the v1 API nor the admin: only the manifest and the files
    of the published subtree, read-only (path carried by the node)."""
    if not authorization_header:
        return None
    parts = authorization_header.strip().split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    token = parts[1]
    if not token:
        return None
    try:
        return get_store().find_node_by_token(token)
    except Exception as e:
        print(f"[verify_node_bearer] lookup failed: {e}", file=sys.stderr)
        return None


NODE_LINK_PREFIX = "atlas-node:"


def encode_node_link(origin: str, name: str, path: str, token: str) -> str:
    """Copyable link the recipient pastes to subscribe to a node.

    Opaque but self-contained: origin + token + name + path, as the base64url of
    a JSON. The subscriber side (Phase B) decodes it to bootstrap the mirror."""
    payload = {"url": origin, "name": name, "path": path, "token": token}
    blob = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":")).encode()).decode().rstrip("=")
    return NODE_LINK_PREFIX + blob


def decode_node_link(link: str):
    """Reverse of encode_node_link → {url, name, path, token}, or None if the link
    is malformed or incomplete (essential url/name/token fields missing)."""
    if not link or not link.startswith(NODE_LINK_PREFIX):
        return None
    blob = link[len(NODE_LINK_PREFIX):].strip()
    blob += "=" * (-len(blob) % 4)  # re-add the stripped base64url padding
    try:
        data = json.loads(base64.urlsafe_b64decode(blob).decode())
    except Exception:
        return None
    if not isinstance(data, dict) or not data.get("url") or not data.get("name") or not data.get("token"):
        return None
    return {"url": data["url"], "name": data["name"],
            "path": data.get("path", ""), "token": data["token"]}


def api_rate_limit_ok(token_hash: str) -> bool:
    """Sliding window rate limit per token: API_RATE_LIMIT_PER_MIN max/min."""
    now = time.time()
    cutoff = now - 60
    with _api_rate_lock:
        if len(_api_rate_buckets) > _RATE_BUCKET_CAP:
            _evict_stale_buckets(_api_rate_buckets, cutoff)
        bucket = _api_rate_buckets.setdefault(token_hash, [])
        # Drop entries older than 60s
        bucket[:] = [t for t in bucket if t > cutoff]
        if len(bucket) >= API_RATE_LIMIT_PER_MIN:
            return False
        bucket.append(now)
        return True


# Rate limit on login attempts, per client IP (60s sliding window).
# bcrypt (12 rounds) already slows brute-forcing, but this caps the attempts.
LOGIN_RATE_LIMIT_PER_MIN = 10
_login_buckets: dict[str, list[float]] = {}
_login_lock = threading.Lock()


def login_rate_limit_ok(ip: str) -> bool:
    now = time.time()
    cutoff = now - 60
    with _login_lock:
        if len(_login_buckets) > _RATE_BUCKET_CAP:
            _evict_stale_buckets(_login_buckets, cutoff)
        bucket = _login_buckets.setdefault(ip, [])
        bucket[:] = [t for t in bucket if t > cutoff]
        if len(bucket) >= LOGIN_RATE_LIMIT_PER_MIN:
            return False
        bucket.append(now)
        return True


def _safe_int(value, default: int = 0) -> int:
    """Tolerant int(): returns `default` instead of raising on a non-numeric
    input (forged Content-Length, invalid JSON field, etc.)."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


# ─── Git helpers ───────────────────────────────────────────────────────────────


def git(*args, cwd=None, check=False, timeout=60):
    return subprocess.run(
        ["git", *args],
        cwd=str(cwd or CONFIG.root),
        capture_output=True,
        text=True,
        timeout=timeout,
        check=check,
        # Never block on an interactive credential prompt: a bad/unset token
        # must fail fast and loud (not hang until the timeout).
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
    )


def _mask_url(s: str) -> str:
    return re.sub(r"://[^@\s]+@", "://***@", s or "")


# ─── Update check (admin Settings banner) ──────────────────────────────────────
# Compares the running version to the latest on PyPI. This is the ONLY outbound
# call the engine makes on its own: admin-only, cached ~1 day, best-effort, and
# disabled when CONFIG.update_check is False.

PYPI_JSON_URL = "https://pypi.org/pypi/atlas-mind/json"
PROJECT_URL = "https://pypi.org/project/atlas-mind/"
_UPDATE_CACHE = {"checked_at": 0, "latest": None}
_UPDATE_CACHE_TTL = 86400  # 1 day
_update_lock = threading.Lock()


def current_version():
    """Running atlas-mind version, in both install modes. Installed → package
    metadata; source run → parse __version__ from the sibling __init__.py."""
    try:
        from importlib.metadata import version
        return version("atlas-mind")
    except Exception:
        pass
    try:
        init = (Path(__file__).resolve().parent / "__init__.py").read_text(encoding="utf-8")
        match = re.search(r'__version__\s*=\s*"([^"]+)"', init)
        if match:
            return match.group(1)
    except OSError:
        pass
    return None


def _version_tuple(value):
    """Best-effort numeric tuple for comparison ("0.1.10" → (0, 1, 10)). Returns
    None if the string has no leading numeric component."""
    parts = re.findall(r"\d+", value or "")
    return tuple(int(p) for p in parts) if parts else None


def _is_newer(latest, current) -> bool:
    lt, ct = _version_tuple(latest), _version_tuple(current)
    if lt is None or ct is None:
        return False
    return lt > ct


def latest_pypi_version():
    """Latest atlas-mind version on PyPI, cached ~1 day. Best-effort: any failure
    (offline, timeout, parse error) returns None and is cached briefly so a
    flaky network does not hammer PyPI on every Settings open."""
    import urllib.request
    now = int(time.time())
    with _update_lock:
        if _UPDATE_CACHE["latest"] is not None and \
                now - _UPDATE_CACHE["checked_at"] < _UPDATE_CACHE_TTL:
            return _UPDATE_CACHE["latest"]
        fresh = now - _UPDATE_CACHE["checked_at"] < 3600  # back off after a failure
        if _UPDATE_CACHE["latest"] is None and fresh and _UPDATE_CACHE["checked_at"]:
            return None
    latest = None
    try:
        with urllib.request.urlopen(PYPI_JSON_URL, timeout=4) as resp:
            data = json.loads(resp.read(1_000_000))
        latest = (data.get("info") or {}).get("version") or None
    except Exception as e:
        print(f"[update-check] PyPI lookup failed: {e}", file=sys.stderr)
    with _update_lock:
        _UPDATE_CACHE["checked_at"] = now
        if latest is not None:
            _UPDATE_CACHE["latest"] = latest
    return latest


def ensure_repo_cloned(root: Path) -> bool:
    """Clone the repo into `root` if not already present. Cloud mode only.

    Reads GITHUB_REPO_URL from the env (not CONFIG: atlas.toml lives INSIDE the
    clone, it does not exist yet at this stage). Returns True if a fresh clone
    happened — __main__ then sets the git identity (CONFIG.git_author_*)."""
    if (root / ".git").exists():
        return False
    repo_url = os.environ.get("GITHUB_REPO_URL")
    if not repo_url:
        sys.exit("FATAL: GITHUB_REPO_URL missing to clone the mind (cloud mode)")
    root.parent.mkdir(parents=True, exist_ok=True)
    try:
        result = subprocess.run(
            ["git", "clone", repo_url, str(root)],
            capture_output=True,
            text=True,
            timeout=120,
        )
    except subprocess.TimeoutExpired:
        # Without a timeout, a GitHub slow at boot hung the server indefinitely →
        # a silent Fly restart loop. We fail outright instead.
        sys.exit("git clone timed out after 120s")
    if result.returncode != 0:
        print(
            f"git clone failed (exit {result.returncode}):\n"
            f"{_mask_url(result.stderr)}",
            file=sys.stderr,
        )
        sys.exit(1)
    return True


def _build_script() -> Path:
    """build.py to run as a subprocess: ALWAYS the engine's one (next to
    server.py), never any src/build.py from the cloned mind (an old engine from a
    historical repo) — the engine is self-contained, cf. _import_build."""
    return Path(__file__).resolve().parent / "build.py"


def _build_env() -> dict:
    """Env for the build.py subprocess: propagates the current mind (ATLAS_MIND)
    so the engine's build.py works on the right mind, even when decoupled."""
    env = os.environ.copy()
    env["ATLAS_MIND"] = str(CONFIG.root)
    return env


def pull_and_rebuild():
    """Pull latest from GitHub and rebuild index.html. Locked to serialize git ops.

    We first commit the PENDING local changes (edit / move / delete done by the
    endpoints, whose asynchronous trigger_sync commit has not happened yet) before
    pulling. Above all NO `reset --hard`: for a move it would resurrect the old
    path (tracked file, deletion undone) while keeping the new path (untracked
    file, ignored by the reset) → a DUPLICATE online. The build artifacts are
    gitignored, so they do not block the pull --rebase and have never needed to
    be discarded.
    """
    print("[pull_and_rebuild] start", flush=True)
    with _git_lock:
        try:
            git("add", "-A")
            committed = git("commit", "-m", "docs: update via viewer", "--quiet").returncode == 0
            r = git("pull", "--rebase", "--autostash", "--quiet", timeout=30)
            print(f"[pull_and_rebuild] committed_local={committed} git pull exit={r.returncode} stderr={r.stderr.strip()!r}", flush=True)
            b = subprocess.run(
                [sys.executable, str(_build_script())],
                cwd=str(CONFIG.root),
                env=_build_env(),
                capture_output=True,
                text=True,
                timeout=60,
            )
            print(f"[pull_and_rebuild] build.py exit={b.returncode} stderr={b.stderr.strip()!r}", flush=True)
            if committed:
                p = git("push", "--quiet", timeout=30)
                print(f"[pull_and_rebuild] push exit={p.returncode} stderr={p.stderr.strip()!r}", flush=True)
        except Exception as e:
            print(f"[pull_and_rebuild] ERROR {e}", file=sys.stderr, flush=True)


def git_pull_loop():
    """Fallback periodic pull (the webhook does instant sync when active).

    Piggyback: we also resync the subscribed remote nodes at the same cadence —
    a refreshed mirror triggers an index rebuild so it shows up."""
    while True:
        time.sleep(CONFIG.git_pull_interval)
        pull_and_rebuild()
        try:
            if sync_all_remotes():
                trigger_sync()
        except Exception as e:
            print(f"[git_pull_loop] remote sync error: {e}", file=sys.stderr, flush=True)


def _graceful_flush(signum, frame):
    """SIGTERM (Fly before a stop/redeploy) → flush git before dying.

    The Fly rootfs is ephemeral: a write present on the local disk but not yet
    pushed to GitHub would be lost if the machine is recreated with a fresh
    rootfs. trigger_sync pushes in the background, but a redeploy landing right
    in that window would cut the daemon thread. Here we push the pending changes
    DURING the grace period (kill_timeout in deploy/fly.toml.example), closing the
    only durability gap that neither the pull loop nor the non-suspend covers
    (deploy/migration during the not-yet-pushed window)."""
    print("[shutdown] SIGTERM -> flushing git (commit + push) before exit", flush=True)
    try:
        pull_and_rebuild()
    except Exception as e:
        print(f"[shutdown] flush error: {e}", file=sys.stderr, flush=True)
    finally:
        sys.exit(0)


def trigger_sync():
    """Commit + push local edits (todos / file PUT). Runs in a background thread."""
    def _sync():
        with _git_lock:
            try:
                # autostash: preserves our uncommitted changes during the rebase
                git("pull", "--rebase", "--autostash", "--quiet", timeout=30)
                subprocess.run(
                    [sys.executable, str(_build_script())],
                    cwd=str(CONFIG.root),
                    env=_build_env(),
                    capture_output=True,
                    timeout=60,
                )
                git("add", "-A")
                commit = git("commit", "-m", "docs: update via viewer", "--quiet")
                if commit.returncode == 0:
                    git("push", "--quiet", timeout=30)
            except Exception as e:
                print(f"[trigger_sync] {e}", file=sys.stderr)

    threading.Thread(target=_sync, daemon=True).start()


# ─── Todos ─────────────────────────────────────────────────────────────────────


def parse_todos(text):
    items = []
    cat = CONFIG.todo_cat_default
    header_to_cat = {label.lower(): key
                     for key, label in CONFIG.todo_cat_headers.items()}
    for line in text.splitlines():
        hm = re.match(r"^##\s+(.+?)\s*$", line)
        if hm:
            cat = header_to_cat.get(hm.group(1).strip().lower(), cat)
            continue
        m = re.match(r"^- \[([ xX])\] (.+)$", line)
        if not m:
            continue
        items.append({
            "id": len(items),
            "text": m.group(2).strip(),
            "done": m.group(1).lower() == "x",
            "cat": cat,
        })
    return items


def write_todos(todos):
    # Grouped by H2 section (## Travail / ## Personnel). We always emit every
    # section to keep the todo file readable and stable, even when empty.
    parts = []
    for cat in CONFIG.todo_categories:
        parts.append("## {}\n\n".format(CONFIG.todo_cat_headers[cat]))
        for t in todos:
            if _norm_cat(t.get("cat")) == cat:
                parts.append("- [{m}] {txt}\n".format(
                    m="x" if t["done"] else " ", txt=t["text"]))
        parts.append("\n")
    CONFIG.todo_file.parent.mkdir(parents=True, exist_ok=True)
    CONFIG.todo_file.write_text(TODO_HEADER + "".join(parts), encoding="utf-8")


def load_todos():
    if not CONFIG.todo_file.exists():
        return []
    return parse_todos(CONFIG.todo_file.read_text(encoding="utf-8"))


# ─── Pass-through annotations (sidecar .notes/<rel>.json) ────────────────────────


def _notes_path(rel: str):
    """Resolves a doc's notes sidecar → Path under CONFIG.notes_dir, or None if
    rel is invalid / escapes the tree. `rel` is the POSIX path of the .md
    (e.g. notes/quick.md) → .notes/notes/quick.md.json."""
    rel = (rel or "").strip()
    if not rel or rel.startswith("/") or ".." in rel.split("/"):
        return None
    notes_dir = CONFIG.notes_dir
    target = (notes_dir / (rel + ".json")).resolve()
    try:
        target.relative_to(notes_dir.resolve())
    except ValueError:
        return None
    return target


def load_notes(rel: str) -> list:
    """List of a doc's annotations (empty if no sidecar / unreadable)."""
    p = _notes_path(rel)
    if not p or not p.exists():
        return []
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    notes = data.get("notes") if isinstance(data, dict) else data
    return notes if isinstance(notes, list) else []


def save_notes(rel: str, notes: list) -> bool:
    """Writes (or deletes if empty) a doc's sidecar. True if written/deleted."""
    p = _notes_path(rel)
    if not p:
        return False
    if not notes:
        if p.exists():
            p.unlink()
        return True
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"version": 1, "notes": notes},
                            ensure_ascii=False, indent=1), encoding="utf-8")
    return True


def migrate_legacy_format():
    if not CONFIG.todo_file.exists():
        return
    text = CONFIG.todo_file.read_text(encoding="utf-8")
    if re.search(r"^- \[[ xX]\]", text, re.MULTILINE):
        return
    blocks = re.split(r"^## \d{4}-\d{2}-\d{2} \d{2}:\d{2}\s*$", text, flags=re.MULTILINE)
    todos = []
    for block in blocks[1:]:
        first = block.strip().split("\n", 1)[0].strip()
        if first:
            todos.append({"text": first, "done": False})
    if todos:
        write_todos([{"id": i, **t} for i, t in enumerate(todos)])


# ─── Live reload (local mode helper, harmless in cloud) ────────────────────────


def broadcast_reload():
    with _sse_lock:
        dead = []
        for client in _sse_clients:
            try:
                client.wfile.write(b"data: reload\n\n")
                client.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                dead.append(client)
        for d in dead:
            _sse_clients.remove(d)


def index_hash():
    try:
        return hashlib.md5(CONFIG.index_file.read_bytes()).hexdigest()
    except (FileNotFoundError, OSError):
        return None


def watcher_loop():
    last_hash = index_hash()
    while True:
        time.sleep(1)
        current = index_hash()
        if current is None or current == last_hash:
            continue
        last_hash = current
        broadcast_reload()


# ─── Per-user visibility (viewer ACL, #14) ─────────────────────────────────────
# A viewer can have "hidden_folders" (prefixes relative to content/) that they
# must neither see, search, nor open. Default = none (sees everything). Admin and
# local mode see everything. The 'api' role (MCP/REST = the owner's AI) is NOT
# affected. Filtering is ALWAYS server-side (never just client-side masking).

def _path_hidden(rel, hidden):
    """True if the doc `rel` (relative to content/) falls under a hidden folder."""
    return any(rel == f or rel.startswith(f + "/") for f in hidden)


def _filter_tree(node, hidden):
    """Prunes the tree: removes hidden files (by path) and folders that became
    empty. Returns the node unchanged if there is no hidden folder."""
    if not hidden:
        return node
    kids = []
    for child in node.get("children", []):
        if child.get("type") == "file":
            if not _path_hidden(child.get("path", ""), hidden):
                kids.append(child)
        else:
            filtered = _filter_tree(child, hidden)
            if filtered.get("children"):
                kids.append(filtered)
    return {**node, "children": kids}


# ─── HTTP handler ──────────────────────────────────────────────────────────────


# ─── i18n of the served HTML pages (login, share, share errors) ───────────────
# Selected by CONFIG.lang (atlas.toml, default "fr"). Scope DELIBERATELY narrowed
# to human-facing pages: the API's JSON error messages and the server logs stay
# as they are (a contract characterized by the tests).
STRINGS = {
    "fr": {
        "login_subtitle": "Connexion",
        "login_email_placeholder": "Email",
        "login_password_placeholder": "Mot de passe",
        "login_submit": "Se connecter",
        "login_rate_limited": "Trop de tentatives. Réessaie dans une minute.",
        "login_backend_unavailable": "Service d'authentification momentanément indisponible.",
        "login_invalid_credentials": "Identifiants invalides",
        "login_account_locked": "Compte temporairement verrouillé après trop d'échecs. Réessaie plus tard.",
        "login_totp_required": "Saisis le code de ton application d'authentification.",
        "login_totp_invalid": "Code de vérification invalide.",
        "login_totp_subtitle": "Vérification en deux étapes",
        "login_totp_intro": "Saisis le code à 6 chiffres de ton application d'authentification.",
        "login_totp_placeholder": "123456",
        "login_totp_submit": "Vérifier",
        "login_totp_use_recovery": "Utiliser un code de secours",
        "login_totp_use_app": "Revenir au code de l'application",
        "login_recovery_intro": "Saisis l'un de tes codes de secours à usage unique.",
        "login_recovery_placeholder": "xxxxx-xxxxx",
        "login_back": "Retour",
        "login_generic_error": "Connexion impossible. Réessaie.",
        "setup_subtitle": "Premier démarrage",
        "setup_intro": "Crée le compte administrateur de cette instance. Tu n'auras à le faire qu'une seule fois.",
        "setup_token_label": "Jeton d'installation",
        "setup_token_help": "Affiché une fois dans les logs du serveur au démarrage, sur la ligne « Atlas setup token: … ». Lis-les avec `fly logs`, `docker logs` ou `journalctl` selon ton hébergement.",
        "setup_token_placeholder": "Colle le jeton ici",
        "setup_email_label": "Email administrateur",
        "setup_email_placeholder": "toi@exemple.com",
        "setup_password_label": "Mot de passe",
        "setup_password_placeholder": "8 caractères minimum",
        "setup_submit": "Créer le compte admin",
        "setup_bad_token": "Jeton d'installation invalide.",
        "setup_password_too_short": "Mot de passe trop court (8 caractères minimum).",
        "setup_invalid_email": "Email invalide.",
        "share_footer": "Partage en lecture seule via {site_name}",
        "share_toc_title": "Sommaire",
        "share_expired_title": "Lien expir&eacute;",
        "share_expired_message": "La p&eacute;riode de validit&eacute; de ce lien est termin&eacute;e.",
        "share_expired_hint": "Le propri&eacute;taire du document peut g&eacute;n&eacute;rer un nouveau lien.",
        "share_revoked_title": "Lien r&eacute;voqu&eacute;",
        "share_revoked_message": "Ce lien a &eacute;t&eacute; d&eacute;sactiv&eacute; manuellement.",
        "share_revoked_hint": "Si tu en as besoin, demande un nouveau lien au propri&eacute;taire.",
        "share_invalid_title": "Lien invalide",
        "share_invalid_message": "Ce lien ne correspond &agrave; aucun document partag&eacute;.",
        "share_invalid_hint": "L'URL est peut-&ecirc;tre incompl&egrave;te ou mal copi&eacute;e.",
        "share_unavailable_title": "Lien momentan&eacute;ment indisponible",
        "share_unavailable_message": "Le service de v&eacute;rification du lien est temporairement injoignable.",
        "share_unavailable_hint": "R&eacute;essaie dans un instant.",
    },
    "en": {
        "login_subtitle": "Sign in",
        "login_email_placeholder": "Email",
        "login_password_placeholder": "Password",
        "login_submit": "Sign in",
        "login_rate_limited": "Too many attempts. Try again in a minute.",
        "login_backend_unavailable": "Authentication service temporarily unavailable.",
        "login_invalid_credentials": "Invalid credentials",
        "login_account_locked": "Account temporarily locked after too many failures. Try again later.",
        "login_totp_required": "Enter the code from your authenticator app.",
        "login_totp_invalid": "Invalid verification code.",
        "login_totp_subtitle": "Two-step verification",
        "login_totp_intro": "Enter the 6-digit code from your authenticator app.",
        "login_totp_placeholder": "123456",
        "login_totp_submit": "Verify",
        "login_totp_use_recovery": "Use a recovery code",
        "login_totp_use_app": "Back to authenticator code",
        "login_recovery_intro": "Enter one of your single-use recovery codes.",
        "login_recovery_placeholder": "xxxxx-xxxxx",
        "login_back": "Back",
        "login_generic_error": "Sign-in failed. Try again.",
        "setup_subtitle": "First boot",
        "setup_intro": "Create the administrator account for this instance. You only need to do this once.",
        "setup_token_label": "Setup token",
        "setup_token_help": "Printed in the server logs at startup, on the line \"Atlas setup token: …\".",
        "setup_token_placeholder": "Paste the token here",
        "setup_email_label": "Administrator email",
        "setup_email_placeholder": "you@example.com",
        "setup_password_label": "Password",
        "setup_password_placeholder": "8 characters minimum",
        "setup_submit": "Create admin account",
        "setup_bad_token": "Invalid setup token.",
        "setup_password_too_short": "Password too short (8 chars minimum).",
        "setup_invalid_email": "Invalid email.",
        "share_footer": "Read-only share via {site_name}",
        "share_toc_title": "Contents",
        "share_expired_title": "Link expired",
        "share_expired_message": "This link's validity period is over.",
        "share_expired_hint": "The document owner can generate a new link.",
        "share_revoked_title": "Link revoked",
        "share_revoked_message": "This link was manually disabled.",
        "share_revoked_hint": "If you need it, ask the owner for a new link.",
        "share_invalid_title": "Invalid link",
        "share_invalid_message": "This link does not match any shared document.",
        "share_invalid_hint": "The URL may be incomplete or badly copied.",
        "share_unavailable_title": "Link temporarily unavailable",
        "share_unavailable_message": "The link verification service is temporarily unreachable.",
        "share_unavailable_hint": "Try again in a moment.",
    },
}


def _t(key: str) -> str:
    """HTML page label in the instance's language (CONFIG.lang).

    Falls back to French if CONFIG is not built yet (module imports before
    __main__) — identical to AtlasConfig's DEFAULT_LANG default."""
    lang = CONFIG.lang if CONFIG is not None else "fr"
    return STRINGS.get(lang, STRINGS["fr"])[key]


LOGIN_HTML = """<!DOCTYPE html>
<html lang="{lang}"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0e0d12">
<title>{site_name} — Login</title>
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon.svg">
<link rel="stylesheet" href="/vendor/fonts.css">
<style>
*{{box-sizing:border-box}}
html,body{{margin:0;padding:0;height:100%}}
body{{
  background:radial-gradient(ellipse 80% 60% at 70% 30%, rgba(29,155,209,0.12), transparent),radial-gradient(ellipse 60% 40% at 20% 80%, rgba(251,198,120,0.08), transparent),#0e0d12;
  color:#d1d2d3;font-family:Manrope,system-ui,sans-serif;
  display:flex;align-items:center;justify-content:center;padding:24px;
}}
.card{{
  width:100%;max-width:380px;padding:36px 32px 32px;
  background:rgba(35,34,42,0.55);
  backdrop-filter:blur(22px) saturate(180%);-webkit-backdrop-filter:blur(22px) saturate(180%);
  border:1px solid rgba(255,255,255,0.1);border-radius:16px;
  box-shadow:0 18px 48px -12px rgba(0,0,0,0.65),inset 0 1px 0 rgba(255,255,255,0.08);
}}
.logo-wrap{{display:flex;justify-content:center;margin-bottom:18px}}
.logo-wrap svg{{width:64px;height:64px;border-radius:12px;box-shadow:0 6px 24px -2px rgba(251,198,120,0.35)}}
h1{{margin:0;font-size:22px;font-weight:700;letter-spacing:-0.015em;color:#fff;text-align:center;line-height:1.2}}
h1 .atlas{{color:#fbc678;font-style:italic;font-weight:400;font-family:'Rubik 80s Fade',Impact,sans-serif;letter-spacing:0.02em}}
h1 .wordmark{{position:relative;display:inline-block;line-height:1}}
h1 .mind{{position:absolute;top:-1.05em;right:-1em;font-size:0.3em;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#e5e6e8;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.22);border-radius:1em 0;padding:0.22em 0.6em;line-height:1.25;font-family:system-ui,-apple-system,sans-serif;opacity:0.3}}
h1 .brand{{font-family:'Corinthia',cursive;font-weight:700;font-size:1.6em;line-height:1}}
.subtitle{{font-size:11px;color:#868a90;text-align:center;margin:6px 0 24px;letter-spacing:0.12em;text-transform:uppercase;font-weight:600}}
form{{display:flex;flex-direction:column;gap:10px}}
input{{
  padding:12px 14px;border:1px solid #2a2a32;background:rgba(0,0,0,0.3);
  color:#fff;border-radius:8px;font:inherit;font-size:14px;outline:none;
  transition:border-color 0.15s,box-shadow 0.15s,background 0.15s;
}}
input:focus{{border-color:#1d9bd1;box-shadow:0 0 0 3px rgba(29,155,209,0.18);background:rgba(0,0,0,0.45)}}
input::placeholder{{color:#5e6066}}
button{{
  padding:12px 14px;margin-top:10px;background:#1d9bd1;color:white;border:0;border-radius:8px;
  font:inherit;font-size:14px;font-weight:600;cursor:pointer;
  transition:filter 0.12s,transform 0.06s;
}}
button:hover{{filter:brightness(1.1)}}
button:active{{transform:scale(0.98)}}
.err{{color:#fca5a5;font-size:13px;margin:0 0 14px;text-align:center;background:rgba(248,113,113,0.08);padding:9px 12px;border-radius:7px;border:1px solid rgba(248,113,113,0.22)}}
.footer{{text-align:center;margin-top:18px;font-size:11px;color:#5e6066;letter-spacing:0.05em}}
.hidden{{display:none!important}}
.intro{{font-size:13px;color:#b0b1b5;text-align:center;margin:2px 0 14px;line-height:1.55}}
.link-btn{{background:none;border:0;color:#1d9bd1;font:inherit;font-size:12px;cursor:pointer;padding:6px;margin:0;text-align:center;text-decoration:underline}}
.link-btn:hover{{filter:brightness(1.15)}}
input.code{{text-align:center;letter-spacing:0.35em;font-size:18px;font-variant-numeric:tabular-nums}}
input.code.recovery{{letter-spacing:0.12em;font-size:15px}}
</style></head><body>
<div class="card">
  <div class="logo-wrap">
    <svg viewBox="0 0 32 32"><defs><radialGradient id="sky-login" cx="50%" cy="40%" r="65%"><stop offset="0%" stop-color="#1f1d2a"/><stop offset="100%" stop-color="#0a0a12"/></radialGradient><radialGradient id="glow-login" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#fbc678" stop-opacity="0.75"/><stop offset="100%" stop-color="#fbc678" stop-opacity="0"/></radialGradient></defs><rect width="32" height="32" rx="7" fill="url(#sky-login)"/><circle cx="16" cy="16" r="9" fill="none" stroke="#fff" stroke-width="0.7" opacity="0.4"/><circle cx="16" cy="16" r="1.2" fill="#fff" opacity="0.85"/><g><animateTransform attributeName="transform" attributeType="XML" type="rotate" from="0 16 16" to="360 16 16" dur="5s" repeatCount="indefinite"/><circle cx="22.36" cy="9.64" r="4" fill="url(#glow-login)"/><circle cx="22.36" cy="9.64" r="1.9" fill="#fbc678"/></g></svg>
  </div>
  <h1><span class="brand">{site_prefix}</span> <span class="wordmark"><span class="atlas">Atlas</span><span class="mind">Mind</span></span></h1>
  <p class="subtitle" id="login-subtitle">{login_subtitle}</p>
  <div id="login-error" class="err hidden" role="alert"></div>
  {error_html}
  <!-- Étape 1 : email + mot de passe. POST classique en repli si JS off. -->
  <form id="login-step-credentials" method="post" action="/login">
    <input id="login-email" name="email" type="email" placeholder="{email_placeholder}" autocomplete="username" required autofocus>
    <input id="login-password" name="password" type="password" placeholder="{password_placeholder}" autocomplete="current-password" required>
    <button type="submit">{submit_label}</button>
  </form>
  <!-- Étape 2 : second facteur (TOTP). Révélée par JS si le backend l'exige. -->
  <form id="login-step-totp" class="hidden">
    <p class="intro">{totp_intro}</p>
    <input id="login-totp-code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="6" class="code" placeholder="{totp_placeholder}">
    <button type="submit">{totp_submit}</button>
    <button type="button" class="link-btn" id="login-to-recovery">{totp_use_recovery}</button>
    <button type="button" class="link-btn" id="login-totp-back">{back_label}</button>
  </form>
  <!-- Étape 2 bis : code de secours. -->
  <form id="login-step-recovery" class="hidden">
    <p class="intro">{recovery_intro}</p>
    <input id="login-recovery-code" type="text" autocomplete="off" class="code recovery" placeholder="{recovery_placeholder}">
    <button type="submit">{totp_submit}</button>
    <button type="button" class="link-btn" id="login-to-totp">{totp_use_app}</button>
    <button type="button" class="link-btn" id="login-recovery-back">{back_label}</button>
  </form>
</div>
<script>
(function() {{
  var STEP1 = "{login_subtitle}", STEP2 = "{totp_subtitle}";
  var GENERIC = "{generic_error}";
  var subtitle = document.getElementById('login-subtitle');
  var errBox = document.getElementById('login-error');
  var fCred = document.getElementById('login-step-credentials');
  var fTotp = document.getElementById('login-step-totp');
  var fRec = document.getElementById('login-step-recovery');
  var email = document.getElementById('login-email');
  var pw = document.getElementById('login-password');
  var totpCode = document.getElementById('login-totp-code');
  var recCode = document.getElementById('login-recovery-code');
  function showError(msg) {{ errBox.textContent = msg; errBox.classList.remove('hidden'); }}
  function clearError() {{ errBox.classList.add('hidden'); errBox.textContent = ''; }}
  function showStep(which) {{
    fCred.classList.toggle('hidden', which !== 'cred');
    fTotp.classList.toggle('hidden', which !== 'totp');
    fRec.classList.toggle('hidden', which !== 'recovery');
    subtitle.textContent = (which === 'cred') ? STEP1 : STEP2;
    var focusEl = which === 'cred' ? email : which === 'totp' ? totpCode : recCode;
    setTimeout(function() {{ focusEl.focus(); }}, 30);
  }}
  // POST JSON vers /login. Le serveur répond 303 (succès) ou JSON {{error, totp_required}}.
  // fetch suit la redirection : res.redirected===true ⇒ session ouverte.
  function submitLogin(extra) {{
    clearError();
    var body = {{ email: email.value.trim().toLowerCase(), password: pw.value }};
    if (extra) {{ for (var k in extra) body[k] = extra[k]; }}
    var sentSecondFactor = !!(extra && (extra.totp_code || extra.recovery_code));
    return fetch('/login', {{
      method: 'POST',
      headers: {{ 'Content-Type': 'application/json' }},
      body: JSON.stringify(body),
      redirect: 'follow',
    }}).then(function(res) {{
      if (res.redirected || res.url.indexOf('/login') === -1) {{ window.location = '/'; return; }}
      if (res.status === 303 || (res.status >= 200 && res.status < 300 && res.headers.get('Set-Cookie'))) {{ window.location = '/'; return; }}
      return res.json().catch(function() {{ return {{}}; }}).then(function(data) {{
        if (data.totp_required) {{
          // Challenge initial (aucun code soumis) : on révèle juste l'étape 2,
          // son intro suffit — surtout PAS la boîte rouge d'erreur. On n'affiche
          // une vraie erreur que si un code a été soumis et refusé.
          if (sentSecondFactor) {{ if (data.error) showError(data.error); }}
          else {{ showStep('totp'); }}
          return;
        }}
        showError(data.error || GENERIC);
      }});
    }}).catch(function() {{ showError(GENERIC); }});
  }}
  fCred.addEventListener('submit', function(e) {{ e.preventDefault(); submitLogin(null); }});
  fTotp.addEventListener('submit', function(e) {{ e.preventDefault(); submitLogin({{ totp_code: totpCode.value.trim() }}); }});
  fRec.addEventListener('submit', function(e) {{ e.preventDefault(); submitLogin({{ recovery_code: recCode.value.trim() }}); }});
  document.getElementById('login-to-recovery').addEventListener('click', function() {{ clearError(); recCode.value=''; showStep('recovery'); }});
  document.getElementById('login-to-totp').addEventListener('click', function() {{ clearError(); totpCode.value=''; showStep('totp'); }});
  document.getElementById('login-totp-back').addEventListener('click', function() {{ clearError(); totpCode.value=''; pw.value=''; showStep('cred'); }});
  document.getElementById('login-recovery-back').addEventListener('click', function() {{ clearError(); recCode.value=''; pw.value=''; showStep('cred'); }});
}})();
</script>
</body></html>"""


# First-boot "create the admin account" page (cloud mode, no admin yet).
# Deliberately reuses the style of LOGIN_HTML (same .card/.err/… classes)
# AND stays usable on mobile (viewport, full-width fields, appropriate
# autocomplete). The setup-token field is filled from what the server prints to
# stderr at boot — anti drive-by: reaching the URL is not enough to claim the
# instance.
SETUP_HTML = """<!DOCTYPE html>
<html lang="{lang}"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0e0d12">
<meta name="robots" content="noindex, nofollow">
<title>{site_name} — Setup</title>
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon.svg">
<link rel="stylesheet" href="/vendor/fonts.css">
<style>
*{{box-sizing:border-box}}
html,body{{margin:0;padding:0;height:100%}}
body{{
  background:radial-gradient(ellipse 80% 60% at 70% 30%, rgba(29,155,209,0.12), transparent),radial-gradient(ellipse 60% 40% at 20% 80%, rgba(251,198,120,0.08), transparent),#0e0d12;
  color:#d1d2d3;font-family:Manrope,system-ui,sans-serif;
  display:flex;align-items:center;justify-content:center;padding:24px;
}}
.card{{
  width:100%;max-width:420px;padding:36px 32px 32px;
  background:rgba(35,34,42,0.55);
  backdrop-filter:blur(22px) saturate(180%);-webkit-backdrop-filter:blur(22px) saturate(180%);
  border:1px solid rgba(255,255,255,0.1);border-radius:16px;
  box-shadow:0 18px 48px -12px rgba(0,0,0,0.65),inset 0 1px 0 rgba(255,255,255,0.08);
}}
.logo-wrap{{display:flex;justify-content:center;margin-bottom:18px}}
.logo-wrap svg{{width:64px;height:64px;border-radius:12px;box-shadow:0 6px 24px -2px rgba(251,198,120,0.35)}}
h1{{margin:0;font-size:22px;font-weight:700;letter-spacing:-0.015em;color:#fff;text-align:center;line-height:1.2}}
h1 .atlas{{color:#fbc678;font-style:italic;font-weight:400;font-family:'Rubik 80s Fade',Impact,sans-serif;letter-spacing:0.02em}}
h1 .wordmark{{position:relative;display:inline-block;line-height:1}}
h1 .mind{{position:absolute;top:-1.05em;right:-1em;font-size:0.3em;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#e5e6e8;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.22);border-radius:1em 0;padding:0.22em 0.6em;line-height:1.25;font-family:system-ui,-apple-system,sans-serif;opacity:0.3}}
h1 .brand{{font-family:'Corinthia',cursive;font-weight:700;font-size:1.6em;line-height:1}}
.subtitle{{font-size:11px;color:#868a90;text-align:center;margin:6px 0 12px;letter-spacing:0.12em;text-transform:uppercase;font-weight:600}}
.intro{{font-size:13px;color:#b0b1b5;text-align:center;margin:0 0 22px;line-height:1.5}}
form{{display:flex;flex-direction:column;gap:16px}}
.field{{display:flex;flex-direction:column;gap:6px}}
.field > label{{font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#868a90}}
input{{
  padding:12px 14px;border:1px solid #2a2a32;background:rgba(0,0,0,0.3);
  color:#fff;border-radius:8px;font:inherit;font-size:14px;outline:none;
  transition:border-color 0.15s,box-shadow 0.15s,background 0.15s;
}}
input:focus{{border-color:#1d9bd1;box-shadow:0 0 0 3px rgba(29,155,209,0.18);background:rgba(0,0,0,0.45)}}
input::placeholder{{color:#5e6066}}
.token-input{{font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:0.02em}}
.field-help{{font-size:11.5px;color:#868a90;line-height:1.45;margin:0;display:flex;gap:7px;align-items:flex-start}}
.field-help svg{{width:14px;height:14px;flex-shrink:0;margin-top:1px;color:#fbc678;opacity:0.85}}
.field-help code{{color:#cbd0d6;background:rgba(255,255,255,0.06);padding:1px 5px;border-radius:4px;font-size:11px}}
button{{
  padding:12px 14px;margin-top:4px;background:#1d9bd1;color:white;border:0;border-radius:8px;
  font:inherit;font-size:14px;font-weight:600;cursor:pointer;
  transition:filter 0.12s,transform 0.06s;
}}
button:hover{{filter:brightness(1.1)}}
button:active{{transform:scale(0.98)}}
.err{{color:#fca5a5;font-size:13px;margin:0 0 14px;text-align:center;background:rgba(248,113,113,0.08);padding:9px 12px;border-radius:7px;border:1px solid rgba(248,113,113,0.22)}}
</style></head><body>
<div class="card">
  <div class="logo-wrap">
    <svg viewBox="0 0 32 32"><defs><radialGradient id="sky-setup" cx="50%" cy="40%" r="65%"><stop offset="0%" stop-color="#1f1d2a"/><stop offset="100%" stop-color="#0a0a12"/></radialGradient><radialGradient id="glow-setup" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#fbc678" stop-opacity="0.75"/><stop offset="100%" stop-color="#fbc678" stop-opacity="0"/></radialGradient></defs><rect width="32" height="32" rx="7" fill="url(#sky-setup)"/><circle cx="16" cy="16" r="9" fill="none" stroke="#fff" stroke-width="0.7" opacity="0.4"/><circle cx="16" cy="16" r="1.2" fill="#fff" opacity="0.85"/><g><animateTransform attributeName="transform" attributeType="XML" type="rotate" from="0 16 16" to="360 16 16" dur="5s" repeatCount="indefinite"/><circle cx="22.36" cy="9.64" r="4" fill="url(#glow-setup)"/><circle cx="22.36" cy="9.64" r="1.9" fill="#fbc678"/></g></svg>
  </div>
  <h1><span class="brand">{site_prefix}</span> <span class="wordmark"><span class="atlas">Atlas</span><span class="mind">Mind</span></span></h1>
  <p class="subtitle">{setup_subtitle}</p>
  <p class="intro">{setup_intro}</p>
  <form id="setup-form">
    {error_html}
    <div class="field">
      <label for="setup-token">{token_label}</label>
      <input id="setup-token" name="setup_token" class="token-input" type="text" placeholder="{token_placeholder}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" required autofocus>
      <p class="field-help"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg><span>{token_help}</span></p>
    </div>
    <div class="field">
      <label for="setup-email">{email_label}</label>
      <input id="setup-email" name="email" type="email" placeholder="{email_placeholder}" autocomplete="username" required>
    </div>
    <div class="field">
      <label for="setup-password">{password_label}</label>
      <input id="setup-password" name="password" type="password" placeholder="{password_placeholder}" autocomplete="new-password" minlength="8" required>
    </div>
    <button type="submit">{submit_label}</button>
  </form>
</div>
<script>
// Soumission en JSON (les endpoints admin exigent application/json + même
// origine). Pas de form action HTML : on POST en fetch same-origin.
document.getElementById('setup-form').addEventListener('submit', async function(e) {{
  e.preventDefault();
  const form = e.target;
  const payload = {{
    setup_token: form.setup_token.value,
    email: form.email.value,
    password: form.password.value,
  }};
  const resp = await fetch('/api/setup', {{
    method: 'POST',
    headers: {{ 'Content-Type': 'application/json' }},
    body: JSON.stringify(payload),
  }});
  if (resp.ok) {{ window.location = '/'; return; }}
  let message = 'Error';
  try {{ message = (await resp.json()).error || message; }} catch (_) {{}}
  let box = form.querySelector('.err');
  if (!box) {{ box = document.createElement('p'); box.className = 'err'; form.insertBefore(box, form.firstChild); }}
  box.textContent = message;
}});
</script>
</body></html>"""


SHARE_ERROR_HTML = """<!DOCTYPE html>
<html lang="{lang}"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>{title}</title>
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon.svg">
<link rel="stylesheet" href="/vendor/fonts.css">
<style>
*{{box-sizing:border-box}}
html,body{{margin:0;padding:0;height:100%;background:#0e0d12;color:#d1d2d3;font-family:Manrope,system-ui,sans-serif}}
body{{display:flex;align-items:center;justify-content:center;padding:24px}}
.card{{max-width:460px;width:100%;background:rgba(35,34,42,0.85);border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:40px 32px;text-align:center;box-shadow:0 24px 64px -16px rgba(0,0,0,0.6),inset 0 1px 0 rgba(255,255,255,0.05);backdrop-filter:blur(20px)}}
.icon-wrap{{width:64px;height:64px;margin:0 auto 20px;border-radius:50%;background:linear-gradient(135deg,rgba(239,68,68,0.18),rgba(244,114,182,0.12));display:flex;align-items:center;justify-content:center;border:1px solid rgba(239,68,68,0.25)}}
.icon-wrap svg{{width:32px;height:32px;color:#f87171}}
h1{{margin:0 0 12px;font-size:1.5rem;font-weight:700;color:#ffffff;letter-spacing:-0.015em}}
p{{margin:0 0 8px;color:#b0b1b5;line-height:1.6;font-size:0.95rem}}
.hint{{color:#5e6066;font-size:0.85rem;margin-top:20px;padding-top:20px;border-top:1px solid rgba(255,255,255,0.06)}}
.logo{{display:inline-flex;align-items:center;gap:8px;margin-top:28px;color:#5e6066;font-size:0.75rem;font-weight:600;letter-spacing:0.05em;text-transform:uppercase}}
.logo svg{{width:18px;height:18px}}
</style></head><body>
<div class="card">
  <div class="icon-wrap">
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/></svg>
  </div>
  <h1>{title}</h1>
  <p>{message}</p>
  <p class="hint">{hint}</p>
  <div class="logo">
    <svg viewBox="0 0 32 32"><defs><radialGradient id="sky-err" cx="50%" cy="40%" r="65%"><stop offset="0%" stop-color="#1f1d2a"/><stop offset="100%" stop-color="#0a0a12"/></radialGradient></defs><rect width="32" height="32" rx="7" fill="url(#sky-err)"/><circle cx="16" cy="16" r="9" fill="none" stroke="#fff" stroke-width="0.7" opacity="0.4"/><circle cx="16" cy="16" r="1.2" fill="#fff" opacity="0.85"/><g><animateTransform attributeName="transform" attributeType="XML" type="rotate" from="0 16 16" to="360 16 16" dur="5s" repeatCount="indefinite"/><circle cx="22.36" cy="9.64" r="1.9" fill="#fbc678"/></g></svg>
    <span>{site_name}</span>
  </div>
</div>
</body></html>"""


SHARE_HTML = """<!DOCTYPE html>
<html lang="{lang}"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>{title}</title>
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon.svg">
<script src="/vendor/marked.min.js"></script>
<script src="/vendor/purify.min.js"></script>
<link rel="stylesheet" href="/vendor/highlight-github-dark.min.css">
<script src="/vendor/highlight.min.js"></script>
<link rel="stylesheet" href="/vendor/fonts.css">
<style>
*{{box-sizing:border-box}}
html,body{{overflow-x:clip}}
body{{margin:0;background:#23222a;color:#d1d2d3;font-family:Lora,Georgia,serif;font-size:17px;line-height:1.7}}
::-webkit-scrollbar{{width:6px;height:6px}}
::-webkit-scrollbar-thumb{{background:rgba(255,255,255,0.1);border-radius:3px}}
::-webkit-scrollbar-thumb:hover{{background:rgba(255,255,255,0.18)}}
::-webkit-scrollbar-track{{background:transparent}}
*{{scrollbar-width:thin;scrollbar-color:rgba(255,255,255,0.1) transparent}}
.layout{{display:flex;gap:2.5rem;max-width:1100px;margin:0 auto;padding:48px 24px 64px}}
aside#toc{{width:240px;flex-shrink:0;position:sticky;top:32px;align-self:flex-start;max-height:calc(100vh - 64px);overflow-y:auto;font-family:Manrope,system-ui,sans-serif}}
aside#toc .toc-title{{font-size:0.7rem;text-transform:uppercase;letter-spacing:0.12em;color:#1d9bd1;margin:0 0 0.75rem 0.5rem;font-weight:700}}
aside#toc nav{{display:flex;flex-direction:column;gap:0.15rem}}
aside#toc a{{color:#b0b1b5;text-decoration:none;padding:0.25rem 0.5rem;font-size:0.85rem;line-height:1.4;border-left:2px solid transparent}}
aside#toc a:hover{{color:#5db5e8;background:rgba(255,255,255,0.03);border-left-color:rgba(29,155,209,0.4)}}
aside#toc a.toc-h3{{padding-left:1.25rem;font-size:0.8rem;color:#868a90}}
article#content{{flex:1;min-width:0;max-width:780px;overflow-wrap:break-word}}
article#content *{{max-width:100%;overflow-wrap:break-word;word-wrap:break-word}}
article#content a{{word-break:break-all}}
h1,h2,h3,h4{{font-family:Manrope,system-ui,sans-serif;letter-spacing:-0.015em;font-weight:700}}
h1{{color:#fff;font-size:2rem;margin-top:0}}
h2{{color:#4fb3e0;border-bottom:1px solid #2a2a32;padding-bottom:0.3rem;margin-top:2rem;scroll-margin-top:24px}}
h3{{color:#87cdee;scroll-margin-top:24px}}
h4{{color:#b6dcef}}
a{{color:#36c5f0;text-decoration:none}}
a:hover{{text-decoration:underline}}
.wikilink{{color:#9aa0a6;border-bottom:1px dashed #3a3c44;cursor:default}}
code,pre{{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:0.9em}}
code{{background:rgba(29,155,209,0.1);color:#5db5e8;padding:2px 6px;border-radius:4px;border:1px solid rgba(29,155,209,0.15)}}
pre{{background:#13141a;border:1px solid #2a2c36;padding:1rem;border-radius:8px;overflow-x:auto;max-width:100%}}
/* !important : la classe .hljs (posée par le renderer code) amène la couleur de
   fond du thème highlight — le <pre> garde le fond/la bordure, comme le viewer. */
pre code{{background:transparent !important;color:inherit !important;border:0;padding:0}}
blockquote{{border-left:3px solid #1d9bd1;background:rgba(29,155,209,0.06);padding:0.5rem 1.25rem;margin:1rem 0;border-radius:0 6px 6px 0;color:#b0b1b5}}
table{{display:block;border-collapse:collapse;width:100%;margin:1rem 0;overflow-x:auto;max-width:100%}}
th,td{{border:1px solid #2a2a32;padding:8px 12px;text-align:left}}
th{{color:#fff}}
img{{max-width:100%;height:auto;border-radius:6px}}
hr{{border:0;border-top:1px solid #2a2a32;margin:2rem 0}}
ul,ol{{padding-left:1.5rem}}
.footer{{margin-top:3rem;padding-top:1rem;border-top:1px solid #2a2a32;font-size:12px;color:#5e6066;text-align:center}}
/* CSS des extensions du mind (mêmes fichiers que le viewer : .atlas/extensions/*.css).
   L'article porte la classe .prose pour que leurs sélecteurs s'appliquent ici aussi. */
{extensions_css}
@media(max-width:899px){{
  .layout{{flex-direction:column;padding:24px 16px;gap:1rem}}
  aside#toc{{width:auto;position:static;max-height:none;padding:0.75rem 1rem;background:rgba(0,0,0,0.25);border:1px solid #2a2a32;border-radius:8px}}
  aside#toc.empty{{display:none}}
  aside#toc nav{{max-height:14rem;overflow-y:auto}}
}}
</style></head><body>
<div class="layout">
  <aside id="toc" class="empty"></aside>
  <article id="content" class="prose"></article>
</div>
<div class="footer">{footer_label}</div>
<script>
const CONTENT = {content_json};
marked.setOptions({{ gfm: true, breaks: false }});
// Colorisation des blocs de code : marked ≥ v5 a SUPPRIMÉ l'option `highlight`
// (silencieusement ignorée) → renderer `code` custom qui appelle highlight.js
// au rendu (équivalent inline de marked-highlight). Même correctif que le
// viewer. La sortie hljs (spans + classes) survit à DOMPurify.
marked.use({{ renderer: {{
  code({{ text, lang }}) {{
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const language = (lang || '').trim().split(/\\s+/)[0];
    let html;
    try {{
      html = language && hljs.getLanguage(language)
        ? hljs.highlight(text, {{ language }}).value
        : hljs.highlightAuto(text).value;
    }} catch (e) {{ html = esc(text); }}
    const cls = language ? ' language-' + esc(language) : '';
    return '<pre><code class="hljs' + cls + '">' + html + '</code></pre>\\n';
  }},
}} }});
// Wikilinks [[target]] / [[target|alias]]: in a share the targets are not
// navigable (we only serve one doc) → render readable non-clickable text instead
// of the raw [[...]]. Without an alias: last segment de-slugged (my-note →
// "my note"). Handled as an inline token → ignored inside code blocks.
marked.use({{ extensions: [{{
  name: 'wikilink',
  level: 'inline',
  start(src) {{ return src.indexOf('[['); }},
  tokenizer(src) {{
    const m = /^\\[\\[([^\\[\\]\\n]+?)\\]\\]/.exec(src);
    if (m) return {{ type: 'wikilink', raw: m[0], target: m[1].trim() }};
  }},
  renderer(token) {{
    const parts = token.target.split('|');
    let label = (parts[1] || '').trim();
    if (!label) label = parts[0].split('/').pop().replace(/\\.md$/i, '').replace(/[-_]+/g, ' ').trim();
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return '<span class="wikilink">' + esc(label) + '</span>';
  }},
}}] }});
const article = document.getElementById('content');
article.innerHTML = DOMPurify.sanitize(marked.parse(CONTENT));
// Build TOC depuis h2/h3 du contenu
const headings = article.querySelectorAll('h2, h3');
if (headings.length >= 2) {{
  const slug = s => s.toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const used = new Set();
  const tocEl = document.getElementById('toc');
  tocEl.classList.remove('empty');
  let html = '<div class="toc-title">{toc_title}</div><nav>';
  headings.forEach(h => {{
    let id = slug(h.textContent) || 'section';
    let base = id, n = 2;
    while (used.has(id)) {{ id = base + '-' + n; n++; }}
    used.add(id);
    h.id = id;
    const cls = 'toc-' + h.tagName.toLowerCase();
    html += '<a href="#' + id + '" class="' + cls + '">' + h.textContent.replace(/</g, '&lt;') + '</a>';
  }});
  html += '</nav>';
  tocEl.innerHTML = html;
}}
</script>
<script>
// JS des extensions du mind (mêmes fichiers que le viewer) : permet aux
// contenus générés par une extension de rester interactifs une fois partagés.
// Chaque extension doit tolérer ce contexte (DOM du viewer absent).
{extensions_js}
</script>
</body></html>"""


_SHARE_EXTENSION_ASSETS = None

def share_extension_assets():
    """CSS and JS of the mind's extensions for the share page: same source as
    the viewer (<mind>/.atlas/extensions/*.css|*.js, see
    build.load_extension_assets), with closing tags neutralized the same way.
    Cached (read once — extensions only change on a redeploy, just like on the
    server side where they are loaded only at boot)."""
    global _SHARE_EXTENSION_ASSETS
    if _SHARE_EXTENSION_ASSETS is not None:
        return _SHARE_EXTENSION_ASSETS
    try:
        build = _import_build()
        css, js = build.load_extension_assets(CONFIG.extensions_dir)
        _SHARE_EXTENSION_ASSETS = (
            build._escape_closing_tag(css, build._CLOSING_STYLE_RE),
            build._escape_closing_tag(js, build._CLOSING_SCRIPT_RE),
        )
    except Exception as e:
        print(f"[share extensions] {e}", file=sys.stderr)
        _SHARE_EXTENSION_ASSETS = ("", "")
    return _SHARE_EXTENSION_ASSETS


# ─── API v1 helpers (module-level) ─────────────────────────────────────────────


def _import_build():
    """Imports (and caches) the ENGINE's build.py.

    The engine is self-contained: we ALWAYS import its own build.py (the engine's
    src/ is on sys.path, placed at the top of this module), NEVER any
    src/build.py that might be present in the cloned mind — otherwise a historical
    repo with the old embedded engine would run old code on the new image
    (clone↔image shadowing). The configured exclusions are injected into the
    module, the single source of truth consumed here (build.EXCLUDED_NAMES)."""
    import build as _build
    _build.EXCLUDED_NAMES = CONFIG.excluded_names
    return _build


def _validate_doc_path(rel: str):
    """Returns the resolved Path inside CONFIG.content_root, or None if invalid.

    Rejects '..', absolute paths, paths outside CONFIG.content_root, and any
    extension other than .md (prose) or .html (standalone styled document: deck,
    dashboard…). Both are first-class documents: created/read/edited/moved/shared.
    """
    if not rel or rel.startswith("/") or ".." in rel.split("/"):
        return None
    if not rel.endswith((".md", ".html")):
        return None
    content_root = CONFIG.content_root
    try:
        target = (content_root / rel).resolve()
        target.relative_to(content_root)
        return target
    except (ValueError, OSError):
        return None


# Git revision accepted by the read-only history endpoints: a full or
# abbreviated commit SHA, or HEAD / HEAD~N. Anything else is refused before it
# reaches `git`. The ref is passed as argv to subprocess (no shell, so no shell
# injection), but a flag-looking ("--output=…") or path-looking value must never
# slip through to git's argument parser.
_GIT_REV_RE = re.compile(r"^(?:[0-9a-fA-F]{4,40}|HEAD(?:~\d+)?)$")


def _valid_git_rev(rev: str) -> bool:
    return bool(rev) and _GIT_REV_RE.match(rev) is not None


def _iter_doc_files():
    """Yields (relative_path, Path) for each doc tracked by the viewer (.md + .html)."""
    excluded = _import_build().EXCLUDED_NAMES
    content_root = CONFIG.content_root
    for path in [*content_root.rglob("*.md"), *content_root.rglob("*.html")]:
        if any(p == ".git" or p.startswith(".") for p in path.relative_to(content_root).parts):
            continue
        if path.name in excluded:
            continue
        # Skip skill/ (consistent with build.py)
        parts = path.relative_to(content_root).parts
        if parts and parts[0] in ("skill", "tools", "__pycache__"):
            continue
        yield path.relative_to(content_root).as_posix(), path


def _validate_node_path(rel: str):
    """Resolved Path of a publishable node (folder OR .md/.html doc), or None.

    A node can point to a whole folder or a single document: in both cases the
    path must stay under content_root and must exist."""
    if not rel or rel.startswith("/") or ".." in rel.split("/"):
        return None
    content_root = CONFIG.content_root
    try:
        target = (content_root / rel.strip("/")).resolve()
        target.relative_to(content_root)
    except (ValueError, OSError):
        return None
    if not target.exists():
        return None
    if target.is_file() and not target.name.endswith((".md", ".html")):
        return None
    return target


def _iter_node_files(node_path: str):
    """Yields (path_relative_to_node, Path) for each doc published under the node.

    Folder → all docs in the subtree, rebased on the node's root. Single file →
    a single (file_name, Path) pair."""
    node_path = node_path.strip("/")
    prefix = node_path + "/"
    for rel, path in _iter_doc_files():
        if rel == node_path:              # node = single document
            yield path.name, path
        elif rel.startswith(prefix):      # node = folder
            yield rel[len(prefix):], path


# ─── Subscriptions: read-only mirror of remote nodes (hive, #10 B) ───────

REMOTES_DIR = "remotes"  # root of the mirrors, under content_root


def _remote_mirror_root(name: str):
    return CONFIG.content_root / REMOTES_DIR / name


def _is_readonly_path(rel: str) -> bool:
    """A path under remotes/ is a remote mirror: read-only on the local side
    (any edit/delete/move is refused — the truth lives at the publisher, we
    resync on top of it)."""
    parts = (rel or "").strip("/").split("/")
    return len(parts) >= 1 and parts[0] == REMOTES_DIR


def _is_safe_node_name(name: str) -> bool:
    """A node/remote name becomes a single directory under content/remotes/, so
    it must be a safe single path segment: no separator, no path-collapsing
    component ('.', '..'), no control char, bounded length. A name like '.'
    would collapse content/remotes/. onto content/remotes/ itself, letting a
    sync wipe every sibling mirror or a delete rmtree the whole tree."""
    if not name or len(name) > 60:
        return False
    if name in (".", ".."):
        return False
    if "/" in name or "\\" in name or ".." in name:
        return False
    return not _has_control_chars(name)


def _mirror_is_under_remotes(mirror) -> bool:
    """Defense in depth: the resolved mirror must be a DIRECT child of
    content/remotes/ (never the remotes/ dir itself, never outside it)."""
    try:
        remotes_root = (CONFIG.content_root / REMOTES_DIR).resolve()
        return mirror.resolve().parent == remotes_root
    except OSError:
        return False


def _atomic_write_bytes(dest, body: bytes) -> None:
    """Write a mirror file atomically (temp + os.replace) so a concurrent
    `git add -A` (trigger_sync) never stages a half-written file."""
    fd, tmp = tempfile.mkstemp(dir=str(dest.parent), prefix=".sync-", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(body)
        os.replace(tmp, dest)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


MAX_NODE_FILE_BYTES = 25 * 1024 * 1024  # cap a single remote fetch (manifest or file)


def _is_blocked_ip(ip_str: str) -> bool:
    import ipaddress
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return True
    return (ip.is_private or ip.is_loopback or ip.is_link_local
            or ip.is_multicast or ip.is_reserved or ip.is_unspecified)


def _validate_remote_url(url: str) -> None:
    """Guards the SSRF surface of node subscriptions: the URL comes from a
    pasted atlas-node: link, so before fetching we require http/https and refuse
    any host that resolves to a private/loopback/link-local/reserved address
    (cloud metadata, internal services). Raises ValueError if disallowed."""
    import socket
    from urllib.parse import urlsplit
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise ValueError(f"unsupported scheme: {parts.scheme!r}")
    host = parts.hostname
    if not host:
        raise ValueError("missing host")
    if getattr(CONFIG, "allow_private_remotes", False):
        return  # opt-in: localhost/LAN hive (home lab) — scheme still checked
    try:
        infos = socket.getaddrinfo(
            host, parts.port or (443 if parts.scheme == "https" else 80))
    except socket.gaierror as error:
        raise ValueError(f"cannot resolve host: {error}")
    for info in infos:
        if _is_blocked_ip(info[4][0]):
            raise ValueError("host resolves to a non-routable address")


def _http_get_bearer(url: str, token: str, timeout: float = 15.0) -> bytes:
    """Fetch a remote node URL with the Bearer token. Hardened against the
    hive SSRF surface: scheme/host are validated, redirects are NOT
    followed (a redirect could escape the validation into an internal target),
    and the response is capped at MAX_NODE_FILE_BYTES."""
    import urllib.request
    _validate_remote_url(url)

    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None  # never follow redirects (would bypass URL validation)

    opener = urllib.request.build_opener(_NoRedirect)
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with opener.open(req, timeout=timeout) as resp:
        data = resp.read(MAX_NODE_FILE_BYTES + 1)
    if len(data) > MAX_NODE_FILE_BYTES:
        raise ValueError("remote response exceeds size limit")
    return data


def _prune_empty_dirs(root) -> None:
    if not root.exists():
        return
    for path in sorted(root.rglob("*"), key=lambda p: len(p.parts), reverse=True):
        if path.is_dir() and not any(path.iterdir()):
            path.rmdir()


_remotes_sync_lock = threading.Lock()


def sync_remote(remote: dict) -> dict:
    """Pulls the manifest + the delta of a remote node into remotes/<name>/.

    Best-effort: any error (network, publisher offline, revoked token) is
    captured in last_error without crashing — the subscriber keeps its last
    copy. Serialized by _remotes_sync_lock so the periodic loop and a manual
    admin /sync cannot corrupt the same mirror concurrently."""
    from urllib.parse import quote
    name = remote["name"]
    url = (remote.get("url") or "").rstrip("/")
    token = remote.get("token", "")
    mirror = _remote_mirror_root(name)
    # A malformed/hostile name must never let the mirror escape its own subdir:
    # a "." name would make the mirror the whole remotes/ tree, so the delete
    # pass below would wipe every sibling subscription.
    if not _is_safe_node_name(name) or not _mirror_is_under_remotes(mirror):
        get_store().update_remote_status(name, {"last_error": "unsafe remote name"})
        return {"ok": False, "error": "unsafe remote name"}
    with _remotes_sync_lock:
        try:
            manifest = json.loads(_http_get_bearer(url + "/api/node/manifest", token))
            files = manifest.get("files", [])
            manifest_hash = hashlib.sha256(json.dumps(
                sorted((f.get("path", ""), f.get("sha256", "")) for f in files)
            ).encode()).hexdigest()
            wanted = {}
            for f in files:
                rel = f.get("path", "")
                if not rel or rel.startswith("/") or ".." in rel.split("/"):
                    continue  # anti-traversal guard on paths coming from the remote
                wanted[rel] = f.get("sha256", "")
            mirror.mkdir(parents=True, exist_ok=True)
            mirror_resolved = mirror.resolve()
            # 1. Download the delta (file missing or sha differs).
            for rel, sha in wanted.items():
                dest = mirror / rel
                try:
                    dest.resolve().relative_to(mirror_resolved)
                except (ValueError, OSError):
                    continue
                if dest.exists() and hashlib.sha256(dest.read_bytes()).hexdigest() == sha:
                    continue
                body = _http_get_bearer(url + "/api/node/file?path=" + quote(rel), token)
                dest.parent.mkdir(parents=True, exist_ok=True)
                _atomic_write_bytes(dest, body)
            # 2. Delete locally whatever disappeared from the remote manifest.
            #    Guard: an empty manifest while the mirror still holds files is
            #    almost always a transient publisher error (offline read, mid
            #    git-rebase, renamed source) — keep the last good copy rather
            #    than wiping it (the deletion would otherwise be committed and
            #    pushed). It self-heals on the next good sync.
            existing = [p for p in mirror.rglob("*") if p.is_file()]
            if wanted or not existing:
                for path in existing:
                    if path.relative_to(mirror).as_posix() not in wanted:
                        path.unlink()
                _prune_empty_dirs(mirror)
            else:
                print(f"[sync] {name}: empty manifest, keeping "
                      f"{len(existing)} existing file(s)", file=sys.stderr)
            get_store().update_remote_status(name, {
                "last_sync_at": int(time.time()),
                "last_manifest_hash": manifest_hash,
                "last_error": "",
            })
            return {"ok": True, "files": len(wanted)}
        except Exception as e:
            get_store().update_remote_status(name, {"last_error": str(e)[:200]})
            return {"ok": False, "error": str(e)}


def sync_all_remotes() -> bool:
    """Resyncs all subscriptions (periodic loop). Best-effort; returns True if at
    least one mirror could be refreshed (→ index rebuild)."""
    try:
        remotes = get_store().list_remotes(include_token=True)
    except Exception as e:
        print(f"[sync_all_remotes] list failed: {e}", file=sys.stderr, flush=True)
        return False
    refreshed = False
    for remote in remotes:
        if sync_remote(remote).get("ok"):
            refreshed = True
    return refreshed


def _normalize_text(s: str) -> str:
    import unicodedata
    return "".join(c for c in unicodedata.normalize("NFD", s.lower()) if unicodedata.category(c) != "Mn")


_HTML_BLOCK_RE = re.compile(r"<(script|style)\b[^>]*>.*?</\1>", re.S | re.I)


def _html_to_text(html_src: str) -> str:
    """Extracts the visible text from an .html for indexing/search.

    Without this, search_docs would index all the CSS/JS/markup and return
    unreadable snippets (`<div style=...>`). We first strip <script>/<style>
    entirely, then all tags, then roughly clean up the entities."""
    s = _HTML_BLOCK_RE.sub(" ", html_src)
    s = re.sub(r"<[^>]+>", " ", s)
    s = re.sub(r"&(?:nbsp|amp|lt|gt|quot|#\d+|[a-z]+);", " ", s)
    return re.sub(r"\s+", " ", s).strip()


# In-memory cache of the normalized content of .md files, key = mtime
# (self-invalidates on edit via /api/file and on git pull/reset which rewrites
# the mtime). Avoids re-reading+normalizing the whole corpus on every
# /api/search request.
_DOC_CACHE: dict = {}


def _doc_entry(rel: str, path):
    """Returns a cached {content, content_n, name_n, tokens, mtime}, reloaded only
    if the file's mtime has changed. None if the file cannot be read."""
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return None
    ent = _DOC_CACHE.get(rel)
    if ent is not None and ent["mtime"] == mtime:
        return ent
    try:
        content = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    # For an .html we index the visible text (not the markup): search and
    # snippets stay readable. read_doc / GET file themselves return the raw HTML.
    if rel.lower().endswith(".html"):
        content = _html_to_text(content)
    content_n = _normalize_text(content)
    ent = {
        "mtime": mtime,
        "content": content,
        "content_n": content_n,
        "name_n": _normalize_text(path.name),
        "tokens": set(re.findall(r"[a-z0-9]{2,}", content_n)),
    }
    _DOC_CACHE[rel] = ent
    return ent


def _api_search(q: str, limit: int) -> list:
    """Scoring: weighted occurrences (name x3, content x1), with typo tolerance
    (a token that can't be found is corrected to the closest word in the
    vocabulary). Content read via the _doc_entry in-memory cache."""
    import difflib
    tokens = [t for t in _normalize_text(q).split() if t]
    if not tokens:
        return []
    entries = []
    for rel, path in _iter_doc_files():
        e = _doc_entry(rel, path)
        if e is not None:
            entries.append((rel, path, e))
    # Typo tolerance: a token of at least 4 letters absent from the vocabulary
    # (as a substring) is replaced by the closest known word. Restores the fuzzy
    # behavior MiniSearch had on the client side.
    vocab = set()
    for _, _, e in entries:
        vocab |= e["tokens"]
    corrected = []
    for t in tokens:
        if len(t) < 4 or any(t in w for w in vocab):
            corrected.append(t)
        else:
            near = difflib.get_close_matches(t, vocab, n=1, cutoff=0.78)
            corrected.append(near[0] if near else t)
    tokens = corrected
    hits = []
    for rel, path, e in entries:
        name_n = e["name_n"]
        content_n = e["content_n"]
        content = e["content"]
        score = 0
        first_idx = -1
        first_token = None
        for t in tokens:
            n_name = name_n.count(t)
            n_content = content_n.count(t)
            score += n_name * 3 + n_content
            if n_content:
                idx = content_n.find(t)
                if first_idx == -1 or (idx >= 0 and idx < first_idx):
                    first_idx = idx
                    first_token = t
        if score == 0:
            continue
        if first_idx >= 0 and first_token:
            start = max(0, first_idx - 60)
            end = min(len(content), first_idx + len(first_token) + 120)
            snippet = (("…" if start > 0 else "")
                       + content[start:end].replace("\n", " ").strip()
                       + ("…" if end < len(content) else ""))
        else:
            snippet = content[:160].replace("\n", " ").strip() + ("…" if len(content) > 160 else "")
        hits.append({
            "path": rel,
            "name": path.name,
            "score": score,
            "snippet": snippet,
            "mtime": int(e["mtime"]),
        })
    hits.sort(key=lambda h: (-h["score"], -h["mtime"]))
    return hits[:limit]


def _api_recent(days: int, limit: int) -> list:
    """Documents modified within the window, from most recent to oldest."""
    cutoff = time.time() - days * 86400
    items = []
    for rel, path in _iter_doc_files():
        st = path.stat()
        if st.st_mtime < cutoff:
            continue
        try:
            content = path.read_text(encoding="utf-8")
            preview = content[:160].replace("\n", " ").strip()
            if len(content) > 160:
                preview += "…"
        except (OSError, UnicodeDecodeError):
            preview = ""
        items.append({
            "path": rel,
            "name": path.name,
            "score": 0,
            "snippet": preview,
            "mtime": int(st.st_mtime),
        })
    items.sort(key=lambda h: -h["mtime"])
    return items[:limit]


# ─── MCP server (Streamable HTTP, for Claude.ai Custom Connectors) ─────────────
#
# The MCP protocol (Model Context Protocol) is used by Claude.ai to expose
# "tools" to Claude. We expose it at /mcp/<token> where <token> is the same
# token as the REST API (stored hashed in the registry).
#
# Security: Claude.ai doesn't natively support Bearer for Custom Connectors
# → we put the token in the path. This is acceptable for personal use because
# the URL is stored by Claude.ai (private account) and is revocable.

MCP_PROTOCOL_VERSION = "2025-03-26"

MCP_TOOLS = [
    {
        "name": "search_docs",
        "description": "Full-text search across the knowledge base. Returns the documents matching the query, ranked by relevance. Use terms in the language of the indexed content.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "q": {"type": "string", "description": "Search terms"},
                "limit": {"type": "integer", "default": 10, "minimum": 1, "maximum": 50},
                "tag": {"type": "string", "description": "Optional: only keep results that also carry this tag (folder-derived or frontmatter, case-insensitive)."},
            },
            "required": ["q"],
        },
    },
    {
        "name": "read_doc",
        "description": "Read the full raw content of a document (.md OR .html). For a .html you get the complete HTML source (not extracted text).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Relative path of the .md or .html (e.g. notes/example.md, projects/deck-may.html). Use list_tree or search_docs to discover paths."},
            },
            "required": ["path"],
        },
    },
    {
        "name": "list_tree",
        "description": "List the full tree of the knowledge base (metadata only, no content). Handy to understand the folder organization before navigating.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "recent_docs",
        "description": "Recently modified documents, newest first. Handy to know what the user has worked on lately.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "days": {"type": "integer", "default": 7, "description": "Window in days", "minimum": 1},
                "limit": {"type": "integer", "default": 20, "minimum": 1, "maximum": 100},
            },
        },
    },
    {
        "name": "create_doc",
        "description": (
            "Create a new document. Two formats, pick by content:\n"
            "• .md — prose, notes, recaps, specs, markdown reports (rendered with marked in the viewer). Default.\n"
            "• .html — a SELF-CONTAINED styled document: slide deck, dashboard, richly laid-out "
            "page with its own CSS/JS. Rendered AS-IS in a viewer iframe sandbox.\n"
            "RULE: NEVER wrap a full HTML document (<!DOCTYPE html>…) inside a ```html code block "
            "of a .md — it would show as raw source. Create a .html instead.\n"
            "Refuses if the path already exists (create-only, no overwrite). The path must end in "
            ".md or .html and be in a valid folder (notes/, projects/, inbox/, etc.)."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Relative path ending in .md or .html (e.g. inbox/note.md, projects/deck-report.html)"},
                "content": {"type": "string", "description": "For a .md: full markdown body with an H1 title. For a .html: a complete self-contained HTML page (<!DOCTYPE html>…</html>), inline CSS/JS included."},
            },
            "required": ["path", "content"],
        },
    },
    {
        "name": "edit_doc",
        "description": (
            "Edit an EXISTING document (.md OR .html). Two mutually exclusive modes:\n"
            "1. Targeted replacement: pass 'old_string' + 'new_string'. 'old_string' must "
            "appear exactly once in the document (otherwise an error) — add surrounding context "
            "to make it unique. Token-efficient, preferred on large docs (and .html, often big).\n"
            "2. Full rewrite: pass 'content' (replaces the whole file).\n"
            "At least one of the two modes is required. The document must already exist "
            "(use create_doc to create a new one). Read the doc with read_doc before editing."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Relative path of the existing .md or .html (e.g. notes/recap.md, projects/deck-may.html)"},
                "old_string": {"type": "string", "description": "Patch mode: the exact text to replace, must be unique in the document."},
                "new_string": {"type": "string", "description": "Patch mode: the replacement text (required if old_string is provided)."},
                "content": {"type": "string", "description": "Rewrite mode: the full new markdown content. Ignored if old_string is provided."},
            },
            "required": ["path"],
        },
    },
    {
        "name": "move_doc",
        "description": (
            "Move OR rename an existing document (.md or .html), AUTOMATICALLY rewriting "
            "the incoming [[wikilinks]] that point at it (no broken backlinks). Renaming = "
            "a move within the same folder (just change the filename in 'to'). Refuses if the "
            "target already exists (no overwrite). Read list_tree/search_docs first for the exact path."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "from": {"type": "string", "description": "CURRENT relative path of the .md (e.g. notes/draft.md)"},
                "to": {"type": "string", "description": "NEW relative .md path (e.g. projects/draft-final.md). Same folder + new name = a plain rename."},
            },
            "required": ["from", "to"],
        },
    },
    {
        "name": "get_links",
        "description": "Outgoing [[wikilinks]] of a document: the docs it points to. Lets you traverse the mind's graph forward from a doc.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Relative path of the .md/.html (e.g. notes/example.md)"},
            },
            "required": ["path"],
        },
    },
    {
        "name": "get_backlinks",
        "description": "Backlinks of a document: the docs that point TO it via [[wikilinks]]. Find what references a doc.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Relative path of the .md/.html"},
            },
            "required": ["path"],
        },
    },
    {
        "name": "get_mind_topology",
        "description": (
            "Bird's-eye view of the whole mind's graph (a summary, not the full graph): "
            "doc/edge counts, density, hubs (most-referenced docs), orphans (no link), and the "
            "most frequent tags. Call it on first contact with a mind to get oriented before diving in."
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "list_by_tag",
        "description": "List the documents carrying a given tag (folder-derived or frontmatter). Navigate the mind by topic, like a human browsing folders.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "tag": {"type": "string", "description": "A single tag, e.g. 'projets' or 'recap' (case-insensitive)"},
            },
            "required": ["tag"],
        },
    },
    {
        "name": "delete_doc",
        "description": (
            "Delete a document — SOFT delete: it is moved to a .trash/ folder (reversible), never "
            "erased. To rename, use move_doc instead. Refuses on remote mirrors (remotes/). "
            "Called by an AI, so the move-to-trash keeps a wrong call recoverable."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Relative path of the .md/.html to delete"},
            },
            "required": ["path"],
        },
    },
]


def _verify_mcp_token(token: str) -> bool:
    if not token:
        return False
    try:
        token_hash = _hash_api_token(token)
        user = get_store().find_api_identity(token_hash)
        if user:
            try:
                get_store().touch_last_used(user)
            except Exception:
                pass
            return True
        return False
    except Exception as e:
        print(f"[verify_mcp_token] registry lookup failed: {e}", file=sys.stderr)
        return False


def _move_md_with_relink(src_rel: str, dst_rel: str):
    """Move/rename a .md AND rewrite the incoming [[wikilinks]] that target it.

    The move (disk rename) is the priority operation; rewriting the links is
    best-effort on top of it. We detect the links to fix BEFORE the move (while
    the source still resolves to its old path), compute the new bodies in memory,
    perform the move, then apply the rewrites.

    Returns (status, payload):
      "ok"  → payload = {"from","to","rewrites":[{path,count}],"links_updated":N}
      else  → payload = error message (status ∈ invalid/not_found/exists/error)."""
    build = _import_build()
    src = _validate_doc_path(src_rel)
    dst = _validate_doc_path(dst_rel)
    if not src or not dst:
        return ("invalid", "Invalid path (from and to must be relative .md or .html, no '..')")
    if not src.exists():
        return ("not_found", f"Source not found: {src_rel}")
    if dst.exists():
        return ("exists", f"Target already exists: {dst_rel} (no overwrite)")
    src_canon = src.relative_to(CONFIG.content_root).as_posix()
    dst_canon = dst.relative_to(CONFIG.content_root).as_posix()
    dst_stem = re.sub(r"\.md$", "", dst.name, flags=re.I)

    # Index wikilinks BEFORE the move (the source still resolves to its old path).
    md_files = []
    for rel, path in _iter_doc_files():
        try:
            md_files.append({"path": rel, "name": path.name,
                             "body": path.read_text(encoding="utf-8-sig")})
        except (OSError, UnicodeDecodeError):
            continue
    by_path = {f["path"].lower(): f["path"] for f in md_files}
    by_stem: dict = {}
    for f in md_files:
        stem = re.sub(r"\.md$", "", f["name"], flags=re.I).lower()
        by_stem.setdefault(stem, f["path"])

    def _make_replacer(counter):
        def _replace(m):
            whole, inner = m.group(0), m.group(1)
            resolved = build._resolve_wikilink(inner, by_path, by_stem)
            if not resolved or resolved.lower() != src_canon.lower():
                return whole  # doesn't target the moved doc → unchanged
            target_part, sep, alias = inner.partition("|")
            t = target_part.strip()
            had_md = t.lower().endswith(".md")
            if "/" in t:  # reference by path → new path
                new_target = dst_canon if had_md else dst_canon[:-3]
            else:         # reference by short name (stem) → new stem
                new_target = dst_stem + (".md" if had_md else "")
            new_whole = f"[[{new_target}{sep}{alias}]]"
            if new_whole == whole:
                return whole  # e.g. pure move, stem unchanged → nothing to rewrite
            counter[0] += 1
            return new_whole
        return _replace

    # In-memory computation (nothing written until the move succeeds).
    pending = []
    for f in md_files:
        if f["path"] == src_canon:
            continue  # the moved doc: its OUTGOING links don't change
        counter = [0]
        new_body = build._WIKILINK_RE.sub(_make_replacer(counter), f["body"])
        if counter[0]:
            pending.append((f["path"], new_body, counter[0]))

    # The move first (the requested operation), then the relinks (best-effort).
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        src.rename(dst)
    except OSError as e:
        print(f"[move_doc] rename failed {src_canon} -> {dst_canon}: {e}",
              file=sys.stderr)
        return ("error", "Move failed")
    rewrites = []
    for rel, new_body, count in pending:
        try:
            (CONFIG.content_root / rel).write_text(new_body, encoding="utf-8")
            rewrites.append({"path": rel, "count": count})
        except OSError as e:
            print(f"[move_doc] relink write failed {rel}: {e}", file=sys.stderr)
    return ("ok", {"from": src_canon, "to": dst_canon, "rewrites": rewrites,
                   "links_updated": sum(r["count"] for r in rewrites)})


# ─── MCP graph / tag / trash helpers (back the AI-native tools below) ─────────

def _doc_corpus():
    """[(rel, name, text)] for every viewer-tracked doc, each file read once.

    utf-8-sig tolerates a BOM. Same source set as _iter_doc_files (dotfolders,
    EXCLUDED_NAMES and skill/tools/__pycache__ already filtered out)."""
    out = []
    for rel, path in _iter_doc_files():
        try:
            out.append((rel, path.name, path.read_text(encoding="utf-8-sig")))
        except (OSError, UnicodeDecodeError):
            continue
    return out


def _links_graph():
    """Wikilink graph {path: {"out": [...], "in": [...]}} over the whole mind.

    Single source of truth shared with the build/viewer: build_links_index only
    keeps docs that have at least one edge, so an isolated doc is simply absent."""
    return _import_build().build_links_index(
        [{"path": rel, "name": name, "body": text} for rel, name, text in _doc_corpus()])


def _tags_for(build, rel: str, text: str) -> list:
    """Folder-derived tags + frontmatter tags, merged and deduped — mirrors the
    tag computation of build.walk so the MCP tools never diverge from the viewer."""
    tags = list(build._folder_tags(rel))
    fm_tags, _ = build._parse_frontmatter(text)
    for t in fm_tags:
        if t not in tags:
            tags.append(t)
    return tags


def _soft_delete(target: Path) -> str:
    """Move a doc into content_root/.trash/ (reversible) instead of erasing it.

    delete_doc is called by an AI, not a human seeing a confirmation box, so a
    wrong call must stay recoverable. '.trash' is dot-prefixed → automatically
    hidden from tree/search/links (build EXCLUDED_PREFIXES and _iter_doc_files
    both skip dot-prefixed parts). Returns the trash-relative path."""
    content_root = CONFIG.content_root
    rel = target.relative_to(content_root)
    dest = content_root / ".trash" / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    # Don't clobber an earlier trashed copy of the same doc: suffix -2, -3, …
    n = 2
    while dest.exists():
        dest = dest.with_name(f"{rel.stem}-{n}{rel.suffix}")
        n += 1
    target.replace(dest)
    return ".trash/" + rel.as_posix()


def _mcp_call_tool(name: str, args: dict) -> dict:
    """Dispatch an MCP tool to the _api_* helpers. Returns MCP CallToolResult."""
    def text_result(s: str, is_error: bool = False) -> dict:
        out = {"content": [{"type": "text", "text": s}]}
        if is_error:
            out["isError"] = True
        return out

    if name == "search_docs":
        q = (args.get("q") or "").strip()
        if not q:
            return text_result("Error: missing 'q' parameter", is_error=True)
        try:
            limit = min(50, max(1, int(args.get("limit", 10))))
        except (ValueError, TypeError):
            limit = 10
        tag = (args.get("tag") or "").strip().lower()
        # Tag filter is additive: without it, identical to before. With it, over-fetch
        # then keep only the hits that also carry the tag (post-scoring, order kept).
        hits = _api_search(q, 50 if tag else limit)
        if tag:
            build = _import_build()
            kept = []
            for h in hits:
                fp = CONFIG.content_root / h.get("path", "")
                try:
                    if tag in _tags_for(build, h.get("path", ""), fp.read_text(encoding="utf-8-sig")):
                        kept.append(h)
                except (OSError, UnicodeDecodeError):
                    continue
                if len(kept) >= limit:
                    break
            hits = kept
        if not hits:
            return text_result(f"No results for: {q}" + (f" (tag: {tag})" if tag else ""))
        return text_result(json.dumps(hits, ensure_ascii=False, indent=2))

    if name == "read_doc":
        rel = (args.get("path") or "").strip()
        target = _validate_doc_path(rel)
        if not target or not target.exists():
            return text_result(f"Document not found: {rel}", is_error=True)
        text = target.read_text(encoding="utf-8")
        return text_result(text)

    if name == "list_tree":
        try:
            tree = _import_build().walk(CONFIG.content_root)
            return text_result(json.dumps(tree, ensure_ascii=False, indent=2))
        except Exception as e:
            print(f"[mcp] list_tree failed: {e}", file=sys.stderr)
            return text_result("Error listing the tree", is_error=True)

    if name == "recent_docs":
        try:
            days = max(1, int(args.get("days", 7)))
            limit = min(100, max(1, int(args.get("limit", 20))))
        except (ValueError, TypeError):
            days, limit = 7, 20
        hits = _api_recent(days, limit)
        if not hits:
            return text_result(f"No document modified in the last {days} days")
        return text_result(json.dumps(hits, ensure_ascii=False, indent=2))

    if name == "create_doc":
        rel = (args.get("path") or "").strip()
        content = args.get("content", "")
        target = _validate_doc_path(rel)
        if not target:
            return text_result("Invalid path (must be a relative .md or .html, no '..')", is_error=True)
        if _is_readonly_path(rel):
            return text_result("Read-only location (remote node mirror) — choose another path.", is_error=True)
        if target.exists():
            return text_result(f"Document already exists: {rel} (cannot overwrite with this token)", is_error=True)
        if not isinstance(content, str):
            return text_result("'content' must be a string", is_error=True)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        trigger_sync()
        return text_result(f"Document created: {rel}")

    if name == "edit_doc":
        rel = (args.get("path") or "").strip()
        target = _validate_doc_path(rel)
        if not target:
            return text_result("Invalid path (must be a relative .md or .html, no '..')", is_error=True)
        if _is_readonly_path(rel):
            return text_result("Read-only document (remote node mirror). Use \"Appropriate\" to make an editable copy.", is_error=True)
        if not target.exists():
            return text_result(f"Document not found: {rel} (use create_doc to create a new one)", is_error=True)
        old_string = args.get("old_string")
        new_string = args.get("new_string")
        content = args.get("content")
        # Patch mode: targeted replacement, takes priority over the rewrite.
        if old_string is not None:
            if not isinstance(old_string, str) or not isinstance(new_string, str):
                return text_result("'old_string' and 'new_string' must be strings", is_error=True)
            if old_string == "":
                return text_result("'old_string' cannot be empty", is_error=True)
            current = target.read_text(encoding="utf-8")
            count = current.count(old_string)
            if count == 0:
                return text_result("'old_string' not found in the document (check it with read_doc)", is_error=True)
            if count > 1:
                return text_result(f"'old_string' appears {count} times — it must be unique. Add surrounding context to make it unique.", is_error=True)
            target.write_text(current.replace(old_string, new_string, 1), encoding="utf-8")
            trigger_sync()
            return text_result(f"Document edited (targeted replacement): {rel}")
        # Full rewrite mode.
        if content is not None:
            if not isinstance(content, str):
                return text_result("'content' must be a string", is_error=True)
            target.write_text(content, encoding="utf-8")
            trigger_sync()
            return text_result(f"Document rewritten: {rel}")
        return text_result("Provide either 'old_string'+'new_string' (patch) or 'content' (rewrite)", is_error=True)

    if name == "move_doc":
        src_rel = (args.get("from") or "").strip()
        dst_rel = (args.get("to") or "").strip()
        if not src_rel or not dst_rel:
            return text_result("'from' and 'to' are required", is_error=True)
        if _is_readonly_path(src_rel) or _is_readonly_path(dst_rel):
            return text_result("Read-only location (remote node mirror) — \"Appropriate\" it first to get an editable copy.", is_error=True)
        status, payload = _move_md_with_relink(src_rel, dst_rel)
        if status != "ok":
            return text_result(payload, is_error=True)
        trigger_sync()
        n, files = payload["links_updated"], len(payload["rewrites"])
        msg = f"Moved: {payload['from']} -> {payload['to']}."
        msg += (f" {n} incoming wikilink(s) rewritten in {files} doc(s)."
                if n else " No incoming wikilink to fix.")
        return text_result(msg)

    if name == "get_links":
        rel = (args.get("path") or "").strip()
        target = _validate_doc_path(rel)
        if not target or not target.exists():
            return text_result(f"Document not found: {rel}", is_error=True)
        entry = _links_graph().get(rel) or {"out": [], "in": []}
        return text_result(json.dumps({"path": rel, "links": entry["out"]},
                                      ensure_ascii=False, indent=2))

    if name == "get_backlinks":
        rel = (args.get("path") or "").strip()
        target = _validate_doc_path(rel)
        if not target or not target.exists():
            return text_result(f"Document not found: {rel}", is_error=True)
        entry = _links_graph().get(rel) or {"out": [], "in": []}
        return text_result(json.dumps({"path": rel, "backlinks": entry["in"]},
                                      ensure_ascii=False, indent=2))

    if name == "get_mind_topology":
        build = _import_build()
        corpus = _doc_corpus()
        graph = build.build_links_index(
            [{"path": rel, "name": name_, "body": text} for rel, name_, text in corpus])
        all_paths = [rel for rel, _, _ in corpus]
        edges = sum(len(v["out"]) for v in graph.values())
        hubs = sorted(
            ({"path": p, "in_degree": len(v["in"])} for p, v in graph.items() if v["in"]),
            key=lambda h: (-h["in_degree"], h["path"]))[:10]
        linked = set(graph)
        orphans = [p for p in all_paths if p not in linked]
        tag_counts: dict = {}
        for rel, _, text in corpus:
            for t in _tags_for(build, rel, text):
                tag_counts[t] = tag_counts.get(t, 0) + 1
        top_tags = sorted(({"tag": t, "count": c} for t, c in tag_counts.items()),
                          key=lambda x: (-x["count"], x["tag"]))[:15]
        n = len(all_paths)
        payload = {
            "counts": {"docs": n, "edges": edges},
            "density": round(edges / n, 4) if n else 0,
            "hubs": hubs,
            "orphans": orphans[:50],
            "orphans_total": len(orphans),
            "top_tags": top_tags,
        }
        return text_result(json.dumps(payload, ensure_ascii=False, indent=2))

    if name == "list_by_tag":
        tag = (args.get("tag") or "").strip().lower()
        if not tag:
            return text_result("Error: missing 'tag' parameter", is_error=True)
        build = _import_build()
        matches = sorted(rel for rel, _, text in _doc_corpus()
                         if tag in _tags_for(build, rel, text))
        if not matches:
            return text_result(f"No document tagged: {tag}")
        return text_result(json.dumps({"tag": tag, "documents": matches},
                                      ensure_ascii=False, indent=2))

    if name == "delete_doc":
        rel = (args.get("path") or "").strip()
        target = _validate_doc_path(rel)
        if not target:
            return text_result("Invalid path (must be a relative .md or .html, no '..')", is_error=True)
        if _is_readonly_path(rel):
            return text_result("Read-only location (remote node mirror) — cannot delete.", is_error=True)
        if not target.exists():
            return text_result(f"Document not found: {rel}", is_error=True)
        trashed = _soft_delete(target)
        trigger_sync()
        return text_result(f"Document moved to trash (reversible): {rel} -> {trashed}")

    return text_result(f"Unknown tool: {name}", is_error=True)


def _mcp_jsonrpc(req: dict):
    """Process an MCP JSON-RPC message. Returns response dict, or None for notifications."""
    method = req.get("method")
    params = req.get("params") or {}
    req_id = req.get("id")

    # Notifications have no id → no response
    if req_id is None:
        # We just log for debugging
        sys.stderr.write(f"[mcp] notification: {method}\n")
        sys.stderr.flush()
        return None

    def ok(result):
        return {"jsonrpc": "2.0", "id": req_id, "result": result}

    def err(code, message):
        return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}

    try:
        if method == "initialize":
            return ok({
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                # Machine slug derived from site_name ("Atlas" → "atlas"): see
                # AtlasConfig.site_slug — neutral by default.
                "serverInfo": {"name": CONFIG.site_slug, "version": "1.0.0"},
            })
        if method == "ping":
            return ok({})
        if method == "tools/list":
            return ok({"tools": MCP_TOOLS})
        if method == "tools/call":
            tool_name = params.get("name", "")
            arguments = params.get("arguments") or {}
            sys.stderr.write(f"[mcp] tools/call name={tool_name}\n")
            sys.stderr.flush()
            return ok(_mcp_call_tool(tool_name, arguments))
        return err(-32601, f"method not found: {method}")
    except Exception as e:
        # Log the detail (which may carry server paths) to stderr only; the
        # client gets a generic message.
        sys.stderr.write(f"[mcp] error in {method}: {e}\n")
        sys.stderr.flush()
        return err(-32603, "internal error")


# ─── Server extensions (<mind>/.atlas/extensions/*.py) ───────────────────────
# Minimal extension hook (spec decision: two hooks, not a plugin system). At
# boot, load_server_extensions(CONFIG) loads every Python module from the mind's
# extensions folder; the module exposes register(context) and registers its
# routes. A broken extension = stderr warning and we carry on, never a crash at
# boot.

EXTENSION_ROLES = ("public", "auth", "admin")
_extension_routes = []  # [(method, compiled regex, handler, role)]


class ExtensionContext:
    """Object passed to register(context) of each server extension.

    - context.config: the server's AtlasConfig (paths, identity, port…).
    - context.add_route(method, pattern, handler, role=None): registers an HTTP
      route. `method` is "GET" or "POST"; `pattern` is a regex matched (re.match)
      against the path WITHOUT the query string; `handler` is called as
      handler(http_handler, match) with the request's HTTP Handler
      (http_handler._read_json(), http_handler._send_json(status, payload)…)
      and the regex match (captured groups). `role`: "public" (no auth), "auth"
      (any logged-in session) or "admin" (admin session). Default: "auth" for
      GET, "admin" for POST. In local mode (auth disabled), the simulated session
      is admin: everything passes.
    """

    def __init__(self, config, routes):
        self.config = config
        self._routes = routes

    def add_route(self, method, pattern, handler, role=None):
        method = (method or "").upper()
        if method not in ("GET", "POST"):
            raise ValueError(f"unsupported method: {method!r} (GET or POST)")
        if role is None:
            role = "admin" if method == "POST" else "auth"
        if role not in EXTENSION_ROLES:
            raise ValueError(
                f"unknown role: {role!r} (public, auth or admin)")
        self._routes.append((method, re.compile(pattern), handler, role))


def load_server_extensions(config, routes=None):
    """Load the Python modules in <mind>/.atlas/extensions/*.py (alphabetical
    order) and call their register(context).

    Any failure (import, missing or faulty register) = stderr warning and we move
    on to the next extension: a broken extension NEVER kills the boot. Missing
    folder = no extensions, behavior strictly unchanged."""
    import importlib.util
    if routes is None:
        routes = _extension_routes
    extensions_dir = config.extensions_dir
    if not extensions_dir.is_dir():
        return routes
    for path in sorted(extensions_dir.glob("*.py")):
        try:
            spec = importlib.util.spec_from_file_location(
                f"atlas_extension_{path.stem}", path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            register = getattr(module, "register", None)
            if not callable(register):
                print(f"[extensions] {path.name} skipped: no register(context) "
                      "function", file=sys.stderr)
                continue
            register(ExtensionContext(config, routes))
            print(f"[extensions] {path.name} loaded", file=sys.stderr)
        except Exception as e:
            print(f"[extensions] {path.name} skipped: {e}", file=sys.stderr)
    return routes


class Handler(SimpleHTTPRequestHandler):
    # Explicit MIME types for the vendored assets (/vendor/): the system's
    # mimetypes table can be incomplete (woff2 missing on some distros) — the
    # browser then rejects mistyped fonts/CSS.
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".woff2": "font/woff2",
    }

    def __init__(self, *args, **kwargs):
        # The static handler serves the content (.md) from content/. index.html,
        # _backlinks.json and _notes-index.json (in dist/) are intercepted before
        # it; the PWA assets (web/) are redirected by translate_path below.
        super().__init__(*args, directory=str(CONFIG.content_root), **kwargs)

    def translate_path(self, path):
        clean = path.split("?", 1)[0].split("#", 1)[0]
        if clean == "/manifest.json":
            # PWA manifest GENERATED by build.py from the config (site_name…):
            # served from dist/, no more static manifest in web/.
            return str(CONFIG.dist_dir / "manifest.json")
        if clean in ("/icon.svg", "/favicon.ico", "/sw.js"):
            return str(CONFIG.web_dir / clean.lstrip("/"))
        if clean.startswith("/vendor/"):
            # Vendored assets (JS/CSS libs + fonts) served from web/vendor/.
            # Open prefix (≠ the exact-match above) → anti-traversal
            # normalization: after normpath, a path that escapes /vendor/
            # (/vendor/../src/server.py) no longer starts with /vendor/ → 404.
            from urllib.parse import unquote as _unquote
            normalized = posixpath.normpath(_unquote(clean))
            if normalized.startswith("/vendor/"):
                target = CONFIG.web_dir / normalized.lstrip("/")
                if target.is_dir():
                    # /vendor/fonts/ (trailing slash) would resolve to a real
                    # directory → SimpleHTTPRequestHandler would render an HTML
                    # autoindex. Only FILES are served under /vendor/ → 404.
                    return str(CONFIG.web_dir / "vendor" / "__refused__")
                return str(target)
            return str(CONFIG.web_dir / "vendor" / "__refused__")
        return super().translate_path(path)

    def end_headers(self):
        # Security headers on ALL responses (centralized here rather than
        # repeated in each _send_*). `no-referrer` notably prevents the token of
        # a /share link from leaking via Referer to an external link clicked from
        # the doc (the libs and fonts are local: /vendor/).
        # HSTS only in cloud (HTTPS) — useless on local http.
        self.send_header("X-Content-Type-Options", "nosniff")
        # SAMEORIGIN (and not DENY): the viewer renders .html documents in a
        # same-origin iframe (standalone deck/dashboard). DENY would break that
        # rendering; SAMEORIGIN allows our own framing while blocking third-party
        # clickjacking. The iframe also stays sandbox=allow-scripts (opaque origin).
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("Referrer-Policy", "no-referrer")
        if CONFIG.auth_enabled:
            self.send_header("Strict-Transport-Security",
                             "max-age=63072000; includeSubDomains")
        super().end_headers()

    # ── auth ─────────────────────────────────────────────────────────────────

    def _session(self):
        """Returns {'email','role'} or None. In local mode, fakes an admin session."""
        if not CONFIG.auth_enabled:
            return {"email": "local", "role": "admin"}
        cookie_header = self.headers.get("Cookie", "")
        for part in cookie_header.split(";"):
            part = part.strip()
            if part.startswith(COOKIE_NAME + "="):
                return verify_token(part[len(COOKIE_NAME) + 1:])
        return None

    def _hidden_folders(self):
        """Folders (prefixes relative to content/) forbidden for the current
        viewer. Admin / local mode / no-auth → []. The 'api' role doesn't use
        cookie sessions, so it never reaches here."""
        sess = self._session()
        if not sess or sess.get("role") == "admin":
            return []
        user = get_store().get_user_by_email(sess["email"])
        folders = (user or {}).get("hidden_folders") or []
        return [f.strip("/") for f in folders if isinstance(f, str) and f.strip("/")]

    def _serve_index_filtered(self, rel):
        """Serve _backlinks.json / _notes-index.json while REMOVING the docs
        hidden from the current viewer (otherwise the Mind/the backlinks would
        leak their names). With no hidden folder → fast static gzip path
        unchanged."""
        hidden = self._hidden_folders()
        if not hidden:
            self._serve_static_gzip(rel, "application/json; charset=utf-8")
            return
        try:
            data = json.loads((CONFIG.dist_dir / rel).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.send_error(404)
            return
        out = {}
        for path, val in data.items():
            if _path_hidden(path, hidden):
                continue
            if isinstance(val, dict):  # _backlinks.json: {path: {in:[...], out:[...]}}
                val = {k: ([x for x in v if not _path_hidden(x, hidden)]
                           if isinstance(v, list) else v)
                       for k, v in val.items()}
            out[path] = val
        self._send_json(200, out)

    def _is_authed(self):
        return self._session() is not None

    def _is_admin(self):
        sess = self._session()
        return sess is not None and sess.get("role") == "admin"

    def _require_auth_or_redirect(self):
        if self._is_authed():
            return True
        self.send_response(303)
        self.send_header("Location", "/login")
        self.end_headers()
        return False

    def _require_auth_or_401(self):
        if self._is_authed():
            return True
        self._send_json(401, {"error": "unauthorized"})
        return False

    def _require_admin_or_403(self):
        if not self._is_authed():
            self._send_json(401, {"error": "unauthorized"})
            return False
        if not self._is_admin():
            self._send_json(403, {"error": "forbidden"})
            return False
        return True

    def _request_origin_host(self):
        """Host of the request's origin (Origin, otherwise Referer), or None if
        neither header is present. Used for the same-origin check of the CSRF
        batch."""
        from urllib.parse import urlsplit
        for header in ("Origin", "Referer"):
            value = self.headers.get(header)
            if value:
                # Origin "null" (sandbox/file://): not a usable host →
                # treated as cross-origin (rejected).
                if value == "null":
                    return ""
                return urlsplit(value).netloc
        return None

    def _check_csrf_base_or_403(self):
        """Base CSRF defense (JSON Content-Type + same-origin origin).

        First line, kept from batch 2c as defense-in-depth AND the only defense
        enforceable BEFORE a session exists (first-admin setup: otherwise
        protected by the constant-time setup-token). In local mode (auth
        disabled), everything stays open."""
        if not CONFIG.auth_enabled:
            return True
        ctype = self.headers.get("Content-Type", "")
        content_length = int(self.headers.get("Content-Length") or 0)
        # The application/json Content-Type is only enforceable if there's a
        # BODY. A mutating request WITHOUT a body (e.g. DELETE /api/share/<id>,
        # deleting a user) legitimately has no Content-Type — the CSRF defense
        # then rests on the same-origin origin + the synchronizer token
        # (X-CSRF-Token), checked afterwards. Without this nuance, every DELETE
        # without a body fell into 415 (share revocation broken browser-side).
        if content_length > 0 and "application/json" not in ctype.lower():
            self._send_json(415, {"error": "Content-Type must be application/json"})
            return False
        origin_host = self._request_origin_host()
        if origin_host is not None and origin_host != self.headers.get("Host", ""):
            self._send_json(403, {"error": "cross-origin request refused"})
            return False
        return True

    def _check_csrf_or_403(self):
        """Full CSRF defense for authenticated mutating requests (batch 2d).

        Defense-in-depth, in order:
          1. application/json Content-Type REQUIRED — a cross-site HTML <form>
             can only emit urlencoded/multipart/text-plain, never this type
             without a CORS preflight (which the browser blocks, since the
             instance allows no third-party origin). [kept from 2c as
             defense-in-depth]
          2. Same-origin Origin/Referer WHEN present — a third-party origin is
             rejected with 403. [kept from 2c]
          3. Synchronizer CSRF token (X-CSRF-Token header) bound to the session:
             HMAC(secret, email|epoch). A third-party page can neither read the
             kb_csrf cookie (Same-Origin Policy) nor forge the HMAC → it can't
             set the right header. This is the STRONG barrier added in 2d.

        In local mode (auth disabled), everything stays open: no CSRF to fear on
        a single-user instance on 127.0.0.1."""
        if not CONFIG.auth_enabled:
            return True
        if not self._check_csrf_base_or_403():
            return False
        # Synchronizer CSRF token bound to the current session.
        sess = self._session()
        if sess is None:
            self._send_json(401, {"error": "unauthorized"})
            return False
        epoch = current_session_epoch(sess.get("email"))
        provided = self.headers.get("X-CSRF-Token", "")
        if not verify_csrf_token(sess.get("email"), epoch, provided):
            self._send_json(403, {"error": "missing or invalid CSRF token"})
            return False
        return True

    def _require_api_bearer(self):
        """Verifies the Authorization: Bearer header + rate limit.

        Returns the user dict on success, or sends an error and returns None.
        Logs every successful call to stderr for audit.
        """
        sess = verify_api_bearer(self.headers.get("Authorization", ""))
        if not sess:
            self._send_json(401, {"error": "invalid or missing bearer token"})
            return None
        # Rate limit
        auth = self.headers.get("Authorization", "")
        token = auth.strip().split(None, 1)[1] if " " in auth else ""
        if not api_rate_limit_ok(_hash_api_token(token)):
            self._send_json(429, {"error": "rate limit exceeded (120/min)"})
            return None
        sys.stderr.write(f"[api] {self.command} {self.path} email={sess['email']}\n")
        sys.stderr.flush()
        return sess

    def _send_login_page(self, error=None, status=200):
        error_html = f'<p class="err">{html.escape(error)}</p>' if error else ""
        body = LOGIN_HTML.format(
            error_html=error_html,
            site_name=html.escape(CONFIG.site_name, quote=True),
            site_prefix=html.escape(CONFIG.prefix, quote=True),
            lang=html.escape(CONFIG.lang, quote=True),
            login_subtitle=html.escape(_t("login_subtitle"), quote=True),
            email_placeholder=html.escape(_t("login_email_placeholder"), quote=True),
            password_placeholder=html.escape(_t("login_password_placeholder"), quote=True),
            submit_label=_t("login_submit"),
            totp_subtitle=html.escape(_t("login_totp_subtitle"), quote=True),
            totp_intro=html.escape(_t("login_totp_intro")),
            totp_placeholder=html.escape(_t("login_totp_placeholder"), quote=True),
            totp_submit=_t("login_totp_submit"),
            totp_use_recovery=_t("login_totp_use_recovery"),
            totp_use_app=_t("login_totp_use_app"),
            recovery_intro=html.escape(_t("login_recovery_intro")),
            recovery_placeholder=html.escape(_t("login_recovery_placeholder"), quote=True),
            back_label=_t("login_back"),
            generic_error=html.escape(_t("login_generic_error"), quote=True),
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _client_ip(self) -> str:
        """Real client IP behind a reverse proxy.

        If server.trusted_ip_header is configured (CF-Connecting-IP behind
        Cloudflare, X-Real-IP, X-Forwarded-For…), that header is authoritative —
        the LAST element if it carries a list: with a proxy that APPENDS
        (nginx `$proxy_add_x_forwarded_for`, Caddy without override), only the
        last element is added by the trusted proxy; the elements on the left
        come from the client and are forgeable (an attacker who relied on the
        first element could bypass the login rate limit by rotating it).
        Otherwise, the historical Fly behaviour: Fly-Client-IP, falling back to
        X-Forwarded-For, then the socket address locally."""
        trusted_header = CONFIG.trusted_ip_header
        if trusted_header:
            value = self.headers.get(trusted_header, "").split(",")[-1].strip()
            return value or self.client_address[0]
        # No trusted header configured. Fly injects Fly-Client-IP at its edge
        # (trustworthy ONLY when we actually run on Fly); honor it solely then.
        # We do NOT trust X-Forwarded-For here: its leftmost element is
        # client-set and forgeable, which would let an attacker rotate it to
        # bypass the login rate limit. A self-hoster behind a proxy must set
        # server.trusted_ip_header (documented) to get real client IPs.
        if os.environ.get("FLY_APP_NAME") or os.environ.get("FLY_ALLOC_ID"):
            fly_ip = self.headers.get("Fly-Client-IP", "").strip()
            if fly_ip:
                return fly_ip
        return self.client_address[0]

    def _session_cookie_pair(self, email: str, role: str, epoch: int):
        """The TWO Set-Cookie headers of an open session: the signed session
        cookie (HttpOnly) and the readable CSRF cookie (NOT HttpOnly, read by the
        page to set X-CSRF-Token). Same Max-Age, same Secure policy."""
        secure = "; Secure" if CONFIG.auth_enabled else ""
        max_age = CONFIG.session_max_age
        session_token = make_token(email, role, epoch)
        csrf_token = make_csrf_token(email, epoch)
        return [
            (f"{COOKIE_NAME}={session_token}; Path=/; HttpOnly; "
             f"SameSite=Lax; Max-Age={max_age}{secure}"),
            # NOT HttpOnly on purpose: the logged-in page MUST read it to replay
            # it as a header. It carries no secret (derived HMAC); stealing it is
            # not enough (the HttpOnly session cookie is also required).
            (f"{CSRF_COOKIE_NAME}={csrf_token}; Path=/; "
             f"SameSite=Lax; Max-Age={max_age}{secure}"),
        ]

    def _open_session_response(self, email: str, role: str):
        """303 to / with the session+CSRF cookies set (form login)."""
        epoch = current_session_epoch(email)
        self.send_response(303)
        self.send_header("Location", "/")
        for cookie in self._session_cookie_pair(email, role, epoch):
            self.send_header("Set-Cookie", cookie)
        self.end_headers()

    def _handle_login(self):
        # Read the body before any return (keep-alive: don't leave unread data
        # on the socket).
        body = self._read_body().decode("utf-8", "replace")
        client_ip = self._client_ip()
        ctype = self.headers.get("Content-Type", "")
        is_json = "application/json" in ctype
        # Per-IP rate limit: response consistent with the rest (JSON for the SPA,
        # HTML page for the form POST).
        if not login_rate_limit_ok(client_ip):
            self._login_error(is_json, _t("login_rate_limited"), 429)
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
        if email and account_lock_remaining(email) > 0:
            self._login_error(is_json, _t("login_account_locked"), 429,
                              extra={"locked": True})
            return

        try:
            user = authenticate_user(email, password) if email and password else None
        except Exception as e:
            # Atlas unreachable: a clean 503 rather than an opaque 500. (Browsing
            # content with an already-issued cookie does not touch the registry — only
            # session creation depends on it.)
            print(f"[login] backend auth indisponible: {e}", file=sys.stderr)
            self._send_login_page(
                error=_t("login_backend_unavailable"),
                status=503)
            return
        if not user:
            register_login_failure(email, client_ip)
            self._login_error(is_json, _t("login_invalid_credentials"), 401)
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
                self._login_error(is_json, _t("login_totp_required"), 200,
                                  extra={"totp_required": True})
                return
            if not self._verify_second_factor(user, totp_code, recovery_code):
                register_login_failure(email, client_ip)
                self._login_error(is_json, _t("login_totp_invalid"), 401,
                                  extra={"totp_required": True})
                return

        reset_login_failures(email)
        self._open_session_response(email, role)

    def _verify_second_factor(self, user: dict, totp_code: str,
                              recovery_code: str) -> bool:
        """Validate the 2nd factor: TOTP code (constant time) OR single-use
        recovery code (consumed). The recovery code is only attempted if no TOTP
        code is provided, to avoid consuming a code by mistake."""
        if totp_code:
            step = verify_totp_step(user.get("totp_secret") or "", totp_code)
            if step is None:
                return False
            # Anti-replay: a TOTP code is valid ~90 s across the window; refuse
            # reusing a step already accepted at login (proxy-phishing / shoulder
            # -surf). Fail-open if the state store hiccups — never lock out a
            # legitimate login over a hardening control.
            email = user.get("email") or ""
            if step <= get_store().get_last_totp_step(email):
                return False
            get_store().set_last_totp_step(email, step)
            return True
        if recovery_code:
            return consume_recovery_code(user.get("email"), recovery_code)
        return False

    def _login_error(self, is_json: bool, message: str, status: int,
                     extra: dict = None):
        """Login error response: JSON for the SPA (with totp_required/locked
        flags), re-rendered HTML page for the form POST."""
        if is_json:
            payload = {"error": message}
            if extra:
                payload.update(extra)
            self._send_json(status, payload)
            return
        self._send_login_page(error=message, status=status)

    def _send_setup_page(self, error=None, status=200):
        error_html = f'<p class="err">{html.escape(error)}</p>' if error else ""
        body = SETUP_HTML.format(
            error_html=error_html,
            site_name=html.escape(CONFIG.site_name, quote=True),
            site_prefix=html.escape(CONFIG.prefix, quote=True),
            lang=html.escape(CONFIG.lang, quote=True),
            setup_subtitle=_t("setup_subtitle"),
            setup_intro=_t("setup_intro"),
            token_label=html.escape(_t("setup_token_label")),
            token_help=html.escape(_t("setup_token_help")),
            token_placeholder=html.escape(_t("setup_token_placeholder"), quote=True),
            email_label=html.escape(_t("setup_email_label")),
            email_placeholder=html.escape(_t("setup_email_placeholder"), quote=True),
            password_label=html.escape(_t("setup_password_label")),
            password_placeholder=html.escape(_t("setup_password_placeholder"), quote=True),
            submit_label=_t("setup_submit"),
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Robots-Tag", "noindex, nofollow")
        self.end_headers()
        self.wfile.write(body)

    def _handle_setup_submit(self):
        """POST /api/setup {email, password, setup_token}: creates the FIRST
        admin and opens the session. Refuses outside the first-boot window (409),
        on a bad token (403, constant-time comparison), invalid email/password
        (400). Once the admin is created, the window closes for good
        (setup_is_open() becomes False)."""
        global _setup_token
        # Always read the body (keep-alive), even if we're going to refuse.
        data = self._read_json()
        # BASE CSRF only: no session exists yet (we're creating the first admin),
        # so no synchronizer CSRF token is possible — the constant-time setup
        # token is the real protection against drive-by requests.
        if not self._check_csrf_base_or_403():
            return
        if not setup_is_open():
            # An admin already exists (or the window was never opened): the
            # initial creation is closed for good.
            self._send_json(409, {"error": "setup already completed"})
            return
        provided = (data.get("setup_token") or "")
        if not hmac.compare_digest(str(provided), _setup_token or ""):
            self._send_json(403, {"error": _t("setup_bad_token")})
            return
        email = (data.get("email") or "").strip().lower()
        password = data.get("password") or ""
        if not is_valid_email(email):
            self._send_json(400, {"error": _t("setup_invalid_email")})
            return
        if len(password) < 8:
            self._send_json(400, {"error": _t("setup_password_too_short")})
            return
        try:
            # Anti-race guard: a second concurrent POST must not create a second
            # "first" admin. has_admin re-checked under the lock.
            with _setup_lock:
                if get_store().has_admin():
                    self._send_json(409, {"error": "setup already completed"})
                    return
                get_store().upsert_user(email, {
                    "password_hash": store.hash_password(password),
                    "role": "admin",
                    "created_at": int(time.time()),
                })
                _setup_token = None  # closes the window for good
        except Exception as e:
            print(f"[setup] could not create admin account: {e}", file=sys.stderr)
            self._send_json(503, {"error": "registry unavailable"})
            return
        self.send_response(200)
        for cookie in self._session_cookie_pair(email, "admin",
                                                current_session_epoch(email)):
            self.send_header("Set-Cookie", cookie)
        self.send_header("Cache-Control", "no-store")
        self._send_json_after_cookie({"ok": True, "email": email})

    def _send_json_after_cookie(self, payload):
        """Sends a JSON body when the caller has already started the response
        (send_response + Set-Cookie set): we do NOT call send_response again,
        only the body headers + the body itself."""
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_share_error(self, reason: str):
        statuses = {"expired": 410, "revoked": 410, "invalid": 404,
                    "unavailable": 503}
        if reason not in statuses:
            reason = "invalid"
        body = SHARE_ERROR_HTML.format(
            title=_t(f"share_{reason}_title"),
            message=_t(f"share_{reason}_message"),
            hint=_t(f"share_{reason}_hint"),
            site_name=html.escape(CONFIG.site_name, quote=True),
            lang=html.escape(CONFIG.lang, quote=True),
        ).encode("utf-8")
        status = statuses[reason]
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Robots-Tag", "noindex, nofollow")
        self.end_headers()
        self.wfile.write(body)

    def _serve_share(self, token):
        path, error = verify_share_token(token)
        if error:
            self._send_share_error(error)
            return
        target = (CONFIG.content_root / path).resolve()
        try:
            target.relative_to(CONFIG.content_root)
        except ValueError:
            self._send_share_error("invalid")
            return
        if not target.exists() or target.suffix.lower() not in (".md", ".html"):
            self._send_share_error("invalid")
            return
        # A shared .html is already a standalone page: we serve it as-is
        # (noindex), no marked re-rendering. The content is the doc owner's work,
        # just like a shared .md.
        if target.suffix.lower() == ".html":
            body = target.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Robots-Tag", "noindex, nofollow")
            self.end_headers()
            self.wfile.write(body)
            return
        content = target.read_text(encoding="utf-8")
        title = target.name
        extensions_css, extensions_js = share_extension_assets()
        body = SHARE_HTML.format(
            title=html.escape(title),
            # `</` → `<\/`: prevents a doc containing "</script>" from closing
            # the <script> tag and injecting HTML outside the sanitized content.
            content_json=json.dumps(content).replace("</", "<\\/"),
            # Mind extension assets: content generated by an extension keeps its
            # design (and its interactions) once shared.
            extensions_css=extensions_css,
            extensions_js=extensions_js,
            lang=html.escape(CONFIG.lang, quote=True),
            footer_label=_t("share_footer").format(
                site_name=html.escape(CONFIG.site_name, quote=True)),
            toc_title=_t("share_toc_title"),
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Robots-Tag", "noindex, nofollow")
        self.end_headers()
        self.wfile.write(body)

    def _handle_github_webhook(self):
        """GitHub push webhook: pull + rebuild if the HMAC signature is valid."""
        if not CONFIG.github_webhook_secret:
            self.send_response(503)
            self.end_headers()
            return
        body = self._read_body()
        received = self.headers.get("X-Hub-Signature-256", "")
        expected = "sha256=" + hmac.new(
            CONFIG.github_webhook_secret, body, hashlib.sha256
        ).hexdigest()
        if not hmac.compare_digest(received, expected):
            self.send_response(401)
            self.end_headers()
            return
        # Ignore everything except push events
        event = self.headers.get("X-GitHub-Event", "")
        if event == "push":
            threading.Thread(target=pull_and_rebuild, daemon=True).start()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(b"ok")

    def _handle_logout(self):
        self.send_response(303)
        self.send_header("Location", "/login")
        self.send_header(
            "Set-Cookie",
            f"{COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
        )
        self.send_header(
            "Set-Cookie",
            f"{CSRF_COOKIE_NAME}=; Path=/; SameSite=Lax; Max-Age=0",
        )
        self.end_headers()

    # ── account / token administration (admin role required) ──────────────────
    #
    # All these routes go through _require_admin_or_403 (read as well as
    # mutation); mutations ALSO go through _check_csrf_or_403 (JSON Content-Type
    # + same-origin Origin/Referer). The full CSRF token is batch 2d. Shares
    # reuse the existing /api/share/list + DELETE /api/share/<id> (not rewritten
    # here).

    def _handle_admin_users_get(self):
        if not self._require_admin_or_403():
            return
        try:
            users = get_store().list_admin_facing_users()
        except Exception as e:
            self._send_json(503, {"error": "registry unavailable"})
            print(f"[admin] list users: {e}", file=sys.stderr)
            return
        self._send_json(200, users)

    def _handle_admin_users_post(self):
        if not self._require_admin_or_403():
            return
        if not self._check_csrf_or_403():
            return
        data = self._read_json()
        email = (data.get("email") or "").strip().lower()
        password = data.get("password") or ""
        role = (data.get("role") or "viewer").strip().lower()
        if not is_valid_email(email):
            self._send_json(400, {"error": "invalid email"})
            return
        if role not in ("admin", "viewer"):
            self._send_json(400, {"error": "role must be 'admin' or 'viewer'"})
            return
        if len(password) < 8:
            self._send_json(400, {"error": "password too short (8 chars minimum)"})
            return
        try:
            if get_store().get_user_by_email(email) is not None:
                self._send_json(409, {"error": "email already taken"})
                return
            get_store().upsert_user(email, {
                "password_hash": store.hash_password(password),
                "role": role,
                "created_at": int(time.time()),
            })
        except Exception as e:
            print(f"[admin] create user: {e}", file=sys.stderr)
            self._send_json(503, {"error": "registry unavailable"})
            return
        self._send_json(201, {"email": email, "role": role})

    def _handle_admin_users_password(self):
        if not self._require_admin_or_403():
            return
        if not self._check_csrf_or_403():
            return
        data = self._read_json()
        email = (data.get("email") or "").strip().lower()
        password = data.get("password") or ""
        if not email:
            self._send_json(400, {"error": "email required"})
            return
        if len(password) < 8:
            self._send_json(400, {"error": "password too short (8 chars minimum)"})
            return
        try:
            user = get_store().get_user_by_email(email)
            if user is None or user.get("role") == API_ROLE:
                # An 'api' account has no usable password: no reset.
                self._send_json(404, {"error": "user not found"})
                return
            # Bump the epoch AT THE SAME TIME as the new hash: a password reset
            # invalidates all existing sessions of the account (a stolen cookie
            # becomes unusable). reset_login_failures also unlocks the account
            # (the admin takes responsibility for the manual unlock).
            get_store().upsert_user(email, {
                "password_hash": store.hash_password(password),
                "session_epoch": int(user.get("session_epoch") or 0) + 1,
            })
            reset_login_failures(email)
        except Exception as e:
            print(f"[admin] reset password: {e}", file=sys.stderr)
            self._send_json(503, {"error": "registry unavailable"})
            return
        self._send_json(200, {"ok": True, "email": email})

    def _handle_admin_users_hidden(self):
        """Viewer ACL (#14): sets the list of hidden folders for an account
        (prefixes relative to content/). Admin only. Empty list = sees
        everything."""
        if not self._require_admin_or_403():
            return
        if not self._check_csrf_or_403():
            return
        data = self._read_json()
        email = (data.get("email") or "").strip().lower()
        folders = data.get("folders")
        if not email:
            self._send_json(400, {"error": "email required"})
            return
        if not isinstance(folders, list):
            self._send_json(400, {"error": "folders must be a list"})
            return
        clean = [f.strip().strip("/") for f in folders
                 if isinstance(f, str) and f.strip().strip("/")]
        try:
            user = get_store().get_user_by_email(email)
            if user is None or user.get("role") == API_ROLE:
                self._send_json(404, {"error": "user not found"})
                return
            get_store().upsert_user(email, {"hidden_folders": clean})
        except Exception as e:
            print(f"[admin] set hidden folders: {e}", file=sys.stderr)
            self._send_json(503, {"error": "registry unavailable"})
            return
        self._send_json(200, {"ok": True, "email": email, "hidden_folders": clean})

    def _handle_admin_users_delete(self):
        if not self._require_admin_or_403():
            return
        if not self._check_csrf_or_403():
            return
        data = self._read_json()
        email = (data.get("email") or "").strip().lower()
        if not email:
            self._send_json(400, {"error": "email required"})
            return
        try:
            user = get_store().get_user_by_email(email)
            if user is None:
                self._send_json(404, {"error": "user not found"})
                return
            # Pre-check for a readable 409 BEFORE any write; the REAL guard
            # against lockout is atomic in delete_user (count + deletion under
            # the same lock/transaction) — two concurrent DELETEs on the last two
            # admins can no longer both fall to zero.
            if user.get("role") == "admin" and get_store().count_admins() <= 1:
                self._send_json(409, {"error": "cannot delete the last admin"})
                return
            if not get_store().delete_user(email, protect_last_admin=True):
                self._send_json(404, {"error": "user not found"})
                return
        except store.LastAdminError:
            self._send_json(409, {"error": "cannot delete the last admin"})
            return
        except Exception as e:
            print(f"[admin] delete user: {e}", file=sys.stderr)
            self._send_json(503, {"error": "registry unavailable"})
            return
        self._send_json(200, {"ok": True, "email": email})

    def _handle_admin_tokens_get(self):
        if not self._require_admin_or_403():
            return
        try:
            identities = get_store().list_api_identities()
        except Exception as e:
            print(f"[admin] list tokens: {e}", file=sys.stderr)
            self._send_json(503, {"error": "registry unavailable"})
            return
        self._send_json(200, identities)

    def _handle_admin_tokens_post(self):
        if not self._require_admin_or_403():
            return
        if not self._check_csrf_or_403():
            return
        data = self._read_json()
        label = (data.get("label") or "").strip()
        if not label:
            self._send_json(400, {"error": "label required"})
            return
        if len(label) > MAX_TOKEN_LABEL_LEN or _has_control_chars(label):
            self._send_json(400, {"error": "invalid label"})
            return
        try:
            store.slugify_token_label(label)  # validate BEFORE touching the store
        except ValueError:
            self._send_json(400, {"error": "invalid label"})
            return
        try:
            meta, token = get_store().create_api_identity(label)
        except ValueError as e:
            # Label colliding with a non-'api' account.
            self._send_json(409, {"error": str(e)})
            return
        except Exception as e:
            print(f"[admin] create token: {e}", file=sys.stderr)
            self._send_json(503, {"error": "registry unavailable"})
            return
        # mcp_url derived from the request host (the client may run behind any
        # domain): https scheme in the cloud, http otherwise.
        host = self.headers.get("Host", "")
        scheme = "https" if CONFIG.auth_enabled else "http"
        mcp_url = f"{scheme}://{host}/mcp/{token}" if host else f"/mcp/{token}"
        # The PLAINTEXT token is returned only HERE, a single time.
        self._send_json(201, {
            "token": token,
            "mcp_url": mcp_url,
            "label": label,
            "email": meta.get("email"),
        })

    def _handle_admin_tokens_delete(self):
        if not self._require_admin_or_403():
            return
        if not self._check_csrf_or_403():
            return
        data = self._read_json()
        identifier = (data.get("id") or data.get("label") or "").strip()
        if not identifier:
            self._send_json(400, {"error": "id or label required"})
            return
        try:
            if not get_store().revoke_api_identity(identifier):
                self._send_json(404, {"error": "token not found or already revoked"})
                return
        except Exception as e:
            print(f"[admin] revoke token: {e}", file=sys.stderr)
            self._send_json(503, {"error": "registry unavailable"})
            return
        self._send_json(200, {"ok": True})

    # ── Atlas nodes — administration (hive, #10) ────────────────────────
    def _handle_admin_update_check(self):
        if not self._require_admin_or_403():
            return
        current = current_version()
        if not CONFIG.update_check:
            self._send_json(200, {"current": current, "latest": None,
                                  "update_available": False, "disabled": True})
            return
        latest = latest_pypi_version()
        self._send_json(200, {
            "current": current,
            "latest": latest,
            "update_available": _is_newer(latest, current),
            "url": PROJECT_URL,
        })

    def _handle_admin_nodes_get(self):
        if not self._require_admin_or_403():
            return
        try:
            nodes = get_store().list_nodes()
        except Exception as e:
            print(f"[admin] list nodes: {e}", file=sys.stderr)
            self._send_json(503, {"error": "registry unavailable"})
            return
        self._send_json(200, nodes)

    def _handle_admin_nodes_post(self):
        if not self._require_admin_or_403():
            return
        if not self._check_csrf_or_403():
            return
        data = self._read_json()
        name = (data.get("name") or "").strip()
        rel = (data.get("path") or "").strip()
        if not _is_safe_node_name(name):
            self._send_json(400, {"error": "invalid name"})
            return
        target = _validate_node_path(rel)
        if target is None:
            self._send_json(400, {"error": "path not found"})
            return
        clean = target.relative_to(CONFIG.content_root).as_posix()
        import secrets
        token = secrets.token_urlsafe(32)
        try:
            get_store().create_node(name, clean, token)
        except Exception as e:
            print(f"[admin] create node: {e}", file=sys.stderr)
            self._send_json(503, {"error": "registry unavailable"})
            return
        host = self.headers.get("Host", "")
        scheme = "https" if CONFIG.auth_enabled else "http"
        origin = f"{scheme}://{host}" if host else ""
        # The PLAINTEXT token is returned only HERE, wrapped in the copyable link.
        self._send_json(201, {
            "name": name,
            "path": clean,
            "link": encode_node_link(origin, name, clean, token),
        })

    def _handle_admin_nodes_delete(self):
        if not self._require_admin_or_403():
            return
        if not self._check_csrf_or_403():
            return
        data = self._read_json()
        name = (data.get("name") or "").strip()
        if not name:
            self._send_json(400, {"error": "name required"})
            return
        try:
            if not get_store().revoke_node(name):
                self._send_json(404, {"error": "node not found or already revoked"})
                return
        except Exception as e:
            print(f"[admin] revoke node: {e}", file=sys.stderr)
            self._send_json(503, {"error": "registry unavailable"})
            return
        self._send_json(200, {"ok": True})

    # ── Remote node subscriptions — administration (#10 Phase B) ──────────────
    def _handle_admin_remotes_get(self):
        if not self._require_admin_or_403():
            return
        try:
            remotes = get_store().list_remotes()
        except Exception as e:
            print(f"[admin] list remotes: {e}", file=sys.stderr)
            self._send_json(503, {"error": "registry unavailable"})
            return
        self._send_json(200, remotes)

    def _handle_admin_remotes_post(self):
        if not self._require_admin_or_403():
            return
        if not self._check_csrf_or_403():
            return
        data = self._read_json()
        decoded = decode_node_link((data.get("link") or "").strip())
        if not decoded:
            self._send_json(400, {"error": "invalid node link"})
            return
        name = decoded["name"]
        if not _is_safe_node_name(name):
            self._send_json(400, {"error": "invalid node name"})
            return
        try:
            remote = get_store().add_remote(decoded)
            result = sync_remote(get_store().get_remote(name))
        except Exception as e:
            print(f"[admin] add remote: {e}", file=sys.stderr)
            self._send_json(503, {"error": "registry unavailable"})
            return
        trigger_sync()  # the new mirror must show up in the index
        self._send_json(201, {"remote": remote, "sync": result})

    def _handle_admin_remotes_sync(self):
        if not self._require_admin_or_403():
            return
        if not self._check_csrf_or_403():
            return
        data = self._read_json()
        name = (data.get("name") or "").strip()
        try:
            if name:
                remote = get_store().get_remote(name)
                if not remote:
                    self._send_json(404, {"error": "remote not found"})
                    return
                results = {name: sync_remote(remote)}
            else:
                results = {r["name"]: sync_remote(r)
                           for r in get_store().list_remotes(include_token=True)}
        except Exception as e:
            print(f"[admin] sync remote: {e}", file=sys.stderr)
            self._send_json(503, {"error": "registry unavailable"})
            return
        trigger_sync()  # propagate mirror changes into the index
        self._send_json(200, {"results": results})

    def _handle_admin_remotes_delete(self):
        if not self._require_admin_or_403():
            return
        if not self._check_csrf_or_403():
            return
        data = self._read_json()
        name = (data.get("name") or "").strip()
        if not name:
            self._send_json(400, {"error": "name required"})
            return
        try:
            if not get_store().remove_remote(name):
                self._send_json(404, {"error": "remote not found"})
                return
        except Exception as e:
            print(f"[admin] remove remote: {e}", file=sys.stderr)
            self._send_json(503, {"error": "registry unavailable"})
            return
        import shutil
        mirror = _remote_mirror_root(name)
        if _mirror_is_under_remotes(mirror) and mirror.exists():
            shutil.rmtree(mirror, ignore_errors=True)
        _prune_empty_dirs(CONFIG.content_root / REMOTES_DIR)
        trigger_sync()
        self._send_json(200, {"ok": True})

    def _handle_admin_remotes_appropriate(self):
        if not self._require_admin_or_403():
            return
        if not self._check_csrf_or_403():
            return
        data = self._read_json()
        name = (data.get("name") or "").strip()
        source = (data.get("source") or "").strip().strip("/")  # relative to the mirror; empty = everything
        dest = (data.get("dest") or "").strip().strip("/")       # relative to content_root
        if not name or not dest:
            self._send_json(400, {"error": "name and dest required"})
            return
        if not _is_safe_node_name(name):
            self._send_json(400, {"error": "invalid name"})  # no '..'/'/' traversal in name
            return
        if ".." in dest.split("/") or dest == REMOTES_DIR or dest.startswith(REMOTES_DIR + "/"):
            self._send_json(400, {"error": "invalid destination"})  # no copying INTO a mirror
            return
        try:
            if not get_store().get_remote(name):
                self._send_json(404, {"error": "remote not found"})
                return
        except Exception as e:
            print(f"[admin] appropriate: {e}", file=sys.stderr)
            self._send_json(503, {"error": "registry unavailable"})
            return
        mirror = _remote_mirror_root(name)
        if not _mirror_is_under_remotes(mirror) or not mirror.exists():
            self._send_json(404, {"error": "remote not mirrored"})
            return
        src = (mirror / source) if source else mirror
        content_root = CONFIG.content_root
        dest_path = content_root / dest
        try:
            src.resolve().relative_to(mirror.resolve())
            dest_path.resolve().relative_to(content_root.resolve())
        except (ValueError, OSError):
            self._send_json(400, {"error": "invalid path"})
            return
        if not src.exists():
            self._send_json(404, {"error": "source not found"})
            return
        import shutil
        copied = 0
        if src.is_file():
            target = dest_path
            if target.is_dir() or dest.endswith("/"):
                target = target / src.name
            if target.exists():
                self._send_json(409, {"error": "destination exists"})
                return
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, target)
            copied = 1
        else:
            sources = [p for p in src.rglob("*") if p.is_file()]
            # Mirror the single-file 409 guard: never silently overwrite the
            # admin's own (non-mirror) documents — appropriate makes a NEW copy.
            if any((dest_path / f.relative_to(src).as_posix()).exists()
                   for f in sources):
                self._send_json(409, {"error": "destination exists"})
                return
            for f in sources:
                target = dest_path / f.relative_to(src).as_posix()
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(f, target)
                copied += 1
        trigger_sync()  # rebuild the index so the detached copy shows up
        self._send_json(201, {"ok": True, "copied": copied})

    # ── Atlas nodes — public endpoints (node Bearer token, read-only) ─────────
    def _handle_node_manifest(self):
        node = verify_node_bearer(self.headers.get("Authorization", ""))
        if not node:
            self._send_json(401, {"error": "invalid node token"})
            return
        files = []
        for rel, path in _iter_node_files(node["path"]):
            try:
                body = path.read_bytes()
            except OSError:
                continue
            files.append({
                "path": rel,
                "sha256": hashlib.sha256(body).hexdigest(),
                "size": len(body),
            })
        files.sort(key=lambda f: f["path"])
        self._send_json(200, {
            "name": node["name"],
            "path": node["path"],
            "files": files,
        })

    def _handle_node_file(self):
        node = verify_node_bearer(self.headers.get("Authorization", ""))
        if not node:
            self._send_json(401, {"error": "invalid node token"})
            return
        from urllib.parse import urlparse, parse_qs as _pqs
        rel = (_pqs(urlparse(self.path).query).get("path", [""])[0] or "").strip()
        for node_rel, path in _iter_node_files(node["path"]):
            if node_rel != rel:
                continue
            try:
                body = path.read_bytes()
            except OSError:
                break
            ctype = ("text/html; charset=utf-8" if path.name.endswith(".html")
                     else "text/markdown; charset=utf-8")
            self._send_bytes(200, body, ctype, [("Cache-Control", "no-store")])
            return
        self._send_json(404, {"error": "file not found in node"})

    # ── current user's account (authenticated session) ────────────────────────
    #
    # These routes act on the CALLER's ACCOUNT (no admin required):
    # global logout, enrollment and disabling of TOTP 2FA. All of them
    # go through _require_auth_or_401 + _check_csrf_or_403.

    def _bump_session_epoch(self, email: str) -> int:
        """Increments the account's session epoch → invalidates ALL cookies
        already issued (the user's own AND any thief's). Returns the new
        epoch. The read-increment-write is not strictly atomic across
        requests, but the monotonic increment is enough: two concurrent bumps
        invalidate the old sessions either way."""
        new_epoch = current_session_epoch(email) + 1
        get_store().upsert_user(email, {"session_epoch": new_epoch})
        return new_epoch

    def _handle_account_logout_all(self):
        """POST /api/account/logout-all: bumps the epoch → logs out all
        sessions of this account (including this one). The client must log in again."""
        if not self._require_auth_or_401():
            return
        if not self._check_csrf_or_403():
            return
        sess = self._session()
        email = sess.get("email")
        try:
            self._bump_session_epoch(email)
        except Exception as e:
            print(f"[account] logout-all: {e}", file=sys.stderr)
            self._send_json(503, {"error": "registry unavailable"})
            return
        # The current session is now invalid: clear the cookies.
        self.send_response(200)
        self.send_header("Set-Cookie",
                         f"{COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0")
        self.send_header("Set-Cookie",
                         f"{CSRF_COOKIE_NAME}=; Path=/; SameSite=Lax; Max-Age=0")
        self.send_header("Cache-Control", "no-store")
        self._send_json_after_cookie({"ok": True})

    def _handle_totp_init(self):
        """POST /api/account/totp/init: generates a candidate TOTP secret and
        returns the otpauth:// URI + the plaintext secret (shown ONCE). The
        secret is NOT active yet: it must be confirmed via /enable. We store it
        as pending (totp_pending_secret) until confirmation."""
        if not self._require_auth_or_401():
            return
        if not self._check_csrf_or_403():
            return
        sess = self._session()
        email = sess.get("email")
        user = get_store().get_user_by_email(email) or {}
        if user.get("totp_enabled"):
            self._send_json(409, {"error": "2FA already enabled"})
            return
        secret = generate_totp_secret()
        try:
            get_store().upsert_user(email, {"totp_pending_secret": secret})
        except Exception as e:
            print(f"[account] totp init: {e}", file=sys.stderr)
            self._send_json(503, {"error": "registry unavailable"})
            return
        uri = totp_provisioning_uri(secret, email, CONFIG.site_name)
        self._send_json(200, {"secret": secret, "otpauth_uri": uri})

    def _handle_totp_enable(self):
        """POST /api/account/totp/enable {code}: confirms the pending secret
        with a valid code, enables 2FA, generates the recovery codes (shown
        ONCE) and BUMPS the epoch (invalidates stolen sessions)."""
        if not self._require_auth_or_401():
            return
        if not self._check_csrf_or_403():
            return
        data = self._read_json()
        code = (data.get("code") or "").strip()
        sess = self._session()
        email = sess.get("email")
        user = get_store().get_user_by_email(email) or {}
        if user.get("totp_enabled"):
            self._send_json(409, {"error": "2FA already enabled"})
            return
        pending = user.get("totp_pending_secret")
        if not pending:
            self._send_json(400, {"error": "call /totp/init first"})
            return
        if not verify_totp(pending, code):
            self._send_json(400, {"error": "invalid code"})
            return
        recovery_codes, recovery_hashes = generate_recovery_codes()
        try:
            get_store().upsert_user(email, {
                "totp_enabled": True,
                "totp_secret": pending,
                "totp_pending_secret": None,
                "totp_recovery_hashes": recovery_hashes,
            })
            self._bump_session_epoch(email)
        except Exception as e:
            print(f"[account] totp enable: {e}", file=sys.stderr)
            self._send_json(503, {"error": "registry unavailable"})
            return
        # The epoch changed: we reissue fresh cookies so we don't log out
        # the user who just enabled their 2FA from THIS session.
        new_epoch = current_session_epoch(email)
        self.send_response(200)
        for cookie in self._session_cookie_pair(
                email, user.get("role", "admin"), new_epoch):
            self.send_header("Set-Cookie", cookie)
        self.send_header("Cache-Control", "no-store")
        self._send_json_after_cookie({"ok": True, "recovery_codes": recovery_codes})

    def _handle_totp_disable(self):
        """POST /api/account/totp/disable {code|recovery}: disables 2FA
        after a valid second factor, purges the secret and the recovery codes,
        and BUMPS the epoch."""
        if not self._require_auth_or_401():
            return
        if not self._check_csrf_or_403():
            return
        data = self._read_json()
        code = (data.get("code") or "").strip()
        recovery = (data.get("recovery") or "").strip()
        sess = self._session()
        email = sess.get("email")
        user = get_store().get_user_by_email(email) or {}
        if not user.get("totp_enabled"):
            self._send_json(409, {"error": "2FA not enabled"})
            return
        verified = False
        if code:
            verified = verify_totp(user.get("totp_secret") or "", code)
        elif recovery:
            verified = consume_recovery_code(email, recovery)
        if not verified:
            self._send_json(400, {"error": "invalid code"})
            return
        try:
            get_store().upsert_user(email, {
                "totp_enabled": False,
                "totp_secret": None,
                "totp_pending_secret": None,
                "totp_recovery_hashes": [],
            })
            self._bump_session_epoch(email)
        except Exception as e:
            print(f"[account] totp disable: {e}", file=sys.stderr)
            self._send_json(503, {"error": "registry unavailable"})
            return
        new_epoch = current_session_epoch(email)
        self.send_response(200)
        for cookie in self._session_cookie_pair(
                email, user.get("role", "admin"), new_epoch):
            self.send_header("Set-Cookie", cookie)
        self.send_header("Cache-Control", "no-store")
        self._send_json_after_cookie({"ok": True})

    # ── JSON helpers ─────────────────────────────────────────────────────────

    def _read_body(self) -> bytes:
        """Reads the request body, bounded to MAX_BODY_BYTES.

        Beyond the bound we don't read the body (avoids memory blow-up):
        we return b"" and mark the connection to be closed so the huge unread
        body is discarded. Callers treat b"" as an empty/invalid body."""
        length = _safe_int(self.headers.get("content-length"))
        if length > MAX_BODY_BYTES:
            self.close_connection = True
            return b""
        return self.rfile.read(length) if length > 0 else b""

    def _read_json(self):
        body = self._read_body()
        if not body:
            return {}
        try:
            return json.loads(body)
        except (ValueError, json.JSONDecodeError):
            return {}

    def _accepts_gzip(self):
        return "gzip" in self.headers.get("Accept-Encoding", "").lower()

    def _send_bytes(self, status, body, content_type, extra_headers=None):
        """Sends bytes with gzip compression if the client supports it and body > 1KB."""
        headers = list(extra_headers or [])
        if self._accepts_gzip() and len(body) > 1024:
            body = gzip.compress(body, compresslevel=6)
            headers.append(("Content-Encoding", "gzip"))
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send_bytes(status, body, "application/json; charset=utf-8",
                         [("Cache-Control", "no-store")])

    def _serve_static_gzip(self, rel, content_type):
        """Serves a static file from ROOT with gzip + ETag revalidation (304).

        SimpleHTTPRequestHandler doesn't compress: for _search-data.json /
        _backlinks.json (large, prose) we go through _send_bytes (gzip >1KB). The
        ETag (mtime-size) lets the browser revalidate (fetch cache:'no-cache') and
        receive a 304 without re-downloading when nothing has changed.
        """
        target = (CONFIG.dist_dir / rel).resolve()
        try:
            target.relative_to(CONFIG.dist_dir)
        except ValueError:
            self.send_error(404)
            return
        if not target.is_file():
            self.send_error(404)
            return
        st = target.stat()
        etag = f'"{int(st.st_mtime)}-{st.st_size}"'
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.end_headers()
            return
        body = target.read_bytes()
        self._send_bytes(200, body, content_type,
                         [("ETag", etag), ("Cache-Control", "no-cache")])

    def _todo_index_from_path(self):
        m = re.match(r"^/api/todos/(\d+)$", self.path)
        return int(m.group(1)) if m else None

    def _serve_sw(self):
        """Serves sw.js: no-cache (so the browser quickly detects a new
        version of the SW) and explicit root scope.

        __ENGINE_VERSION__ is stamped into the worker's CACHE_VERSION so every
        release uses a fresh cache name: `activate` then purges the old cache and
        unversioned vendored assets (tailwind.css, fonts) are re-fetched instead
        of being served stale forever after a deploy."""
        target = (CONFIG.web_dir / "sw.js")
        if not target.is_file():
            self.send_error(404)
            return
        source = target.read_text(encoding="utf-8")
        stamped = source.replace("__ENGINE_VERSION__", current_version() or "dev")
        self._send_bytes(
            200, stamped.encode("utf-8"), "application/javascript; charset=utf-8",
            [("Cache-Control", "no-cache"), ("Service-Worker-Allowed", "/")],
        )

    # ── extensions ───────────────────────────────────────────────────────────

    def _dispatch_extension(self):
        """Attempts to route the request to a server extension route.

        Returns True if a route handled the request (response already sent,
        including 401/403 from the role guard), False otherwise — the caller
        then continues its normal fall-through. First registered route that
        matches wins. An extension handler that raises does not kill the
        thread: generic 500 + stderr log."""
        path = self.path.split("?", 1)[0]
        for method, regex, handler, role in _extension_routes:
            if method != self.command:
                continue
            match = regex.match(path)
            if not match:
                continue
            if role == "admin" and not self._require_admin_or_403():
                return True
            if role == "auth" and not self._require_auth_or_401():
                return True
            try:
                handler(self, match)
            except Exception as e:
                print(f"[extensions] erreur handler {self.command} {path}: {e}",
                      file=sys.stderr)
                try:
                    self._send_json(500, {"error": "extension error"})
                except Exception:
                    pass  # response already partially sent by the handler
            return True
        return False

    # ── verbs ────────────────────────────────────────────────────────────────

    def do_GET(self):
        # Fly healthcheck: public, no auth or registry (otherwise an Atlas outage
        # would fail the check and Fly would restart an otherwise healthy machine).
        if self.path == "/healthz":
            self._send_bytes(200, b"ok", "text/plain; charset=utf-8")
            return
        if CONFIG.auth_enabled and self.path == "/login":
            self._send_login_page()
            return
        if CONFIG.auth_enabled and self.path == "/logout":
            self._handle_logout()
            return
        # Public assets (PWA + favicon): must be accessible without auth
        # otherwise Chrome can't validate the manifest for the install prompt.
        if self.path in ("/manifest.json", "/icon.svg", "/favicon.ico"):
            return super().do_GET()
        # Vendored assets (libs + local fonts): public — the /login page and
        # the /share/ pages (outside a session) depend on them. translate_path maps
        # to web/vendor/ with an anti-traversal guard.
        if self.path.split("?", 1)[0].startswith("/vendor/"):
            return super().do_GET()
        # Service worker: public (the browser fetches it outside a session), at root scope.
        if self.path == "/sw.js":
            self._serve_sw()
            return
        # First-boot (cloud mode, no admin): admin account creation page.
        # Once an admin is created, the window closes → 404 (no more /setup).
        if CONFIG.auth_enabled and self.path.split("?", 1)[0] == "/setup":
            if setup_is_open():
                self._send_setup_page()
            else:
                self.send_error(404)
            return
        # Public shared links: no auth, validated by HMAC signature
        if self.path.startswith("/share/"):
            self._serve_share(self.path[len("/share/"):])
            return
        # Atlas nodes (hive, #10): Bearer channel independent of the cookie,
        # like /api/v1 — the remote subscriber has no session here.
        if self.path == "/api/node/manifest":
            self._handle_node_manifest()
            return
        if self.path.split("?", 1)[0] == "/api/node/file":
            self._handle_node_file()
            return
        if self.path == "/api/me":
            sess = self._session()
            if not sess:
                self._send_json(200, {"authenticated": False, "cloud": CONFIG.auth_enabled})
                return
            email = sess.get("email")
            payload = {
                "authenticated": True,
                "email": email,
                "role": sess.get("role", "admin"),
                "cloud": CONFIG.auth_enabled,
            }
            # Cloud mode only: the CSRF token (also set as a readable kb_csrf
            # cookie) and the 2FA state. Locally (auth disabled) the
            # session is fake and the store isn't necessarily reachable —
            # we don't query it (CSRF is useless on a 127.0.0.1 instance).
            if CONFIG.auth_enabled:
                epoch = current_session_epoch(email)
                user = get_store().get_user_by_email(email) or {}
                payload["csrf_token"] = make_csrf_token(email, epoch)
                payload["totp_enabled"] = bool(user.get("totp_enabled"))
            self._send_json(200, payload)
            return
        if self.path.startswith("/api/share/list"):
            if not self._require_admin_or_403():
                return
            from urllib.parse import urlparse, parse_qs as _pqs
            query = _pqs(urlparse(self.path).query)
            filter_path = (query.get("path", [""])[0] or "").strip()
            include_revoked = query.get("include_revoked", ["0"])[0] == "1"
            try:
                # The store never keeps the token in plaintext (FileStore: SHA256
                # only). But the token is a deterministic HMAC of
                # (path, expires_at, SESSION_SECRET) — we REGENERATE it here to
                # display a copyable public link, without storing anything sensitive.
                docs = get_store().list_shares(
                    path=filter_path or None,
                    include_revoked=include_revoked,
                    limit=200,
                )
                for doc in docs:
                    if doc.get("token") is None and doc.get("path"):
                        doc["token"] = make_share_token(
                            doc["path"], int(doc.get("expires_at") or 0)
                        )
                self._send_json(200, docs)
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return
        if self.path == "/api/admin/users":
            self._handle_admin_users_get()
            return
        if self.path == "/api/admin/tokens":
            self._handle_admin_tokens_get()
            return
        if self.path == "/api/admin/nodes":
            self._handle_admin_nodes_get()
            return
        if self.path == "/api/admin/remotes":
            self._handle_admin_remotes_get()
            return
        if self.path == "/api/admin/update-check":
            self._handle_admin_update_check()
            return
        if self.path == "/api/todos":
            if not self._require_auth_or_401():
                return
            self._send_json(200, load_todos())
            return
        if self.path.split("?", 1)[0] == "/api/notes":
            if not self._require_auth_or_401():
                return
            from urllib.parse import urlparse, parse_qs as _pqs
            rel = (_pqs(urlparse(self.path).query).get("path", [""])[0] or "").strip()
            if _notes_path(rel) is None:
                self._send_json(400, {"error": "invalid path"})
                return
            self._send_json(200, load_notes(rel))
            return
        if self.path == "/api/tree":
            if not self._require_auth_or_401():
                return
            try:
                tree = _import_build().walk(CONFIG.content_root)
                tree = _filter_tree(tree, self._hidden_folders())
                self._send_json(200, tree)
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return
        if self.path.split("?", 1)[0] == "/api/search":
            if not self._require_auth_or_401():
                return
            from urllib.parse import urlparse, parse_qs as _pqs
            query = _pqs(urlparse(self.path).query)
            q = (query.get("q", [""])[0] or "").strip()
            if not q:
                self._send_json(200, [])
                return
            try:
                limit = min(50, max(1, int(query.get("limit", ["50"])[0])))
            except ValueError:
                limit = 50
            # Server-side search: transfers O(results), not O(corpus). The online
            # viewer calls this instead of downloading the entire _search-data.json.
            results = _api_search(q, limit)
            hidden = self._hidden_folders()
            if hidden:
                results = [r for r in results if not _path_hidden(r.get("path", ""), hidden)]
            self._send_json(200, results)
            return
        # ─── Git history (read-only, authenticated admin/viewer) ───────────────
        # Every document is versioned git: expose its revisions, an old version,
        # and a diff between two revisions. `git` runs at CONFIG.root (repo root)
        # while ?path= is relative to content/, so the pathspec is prefixed with
        # "content/". Always `--` before the pathspec; revisions are regex-checked.
        if self.path.split("?", 1)[0] == "/api/history":
            if not self._require_auth_or_401():
                return
            from urllib.parse import urlparse, parse_qs as _pqs
            rel = (_pqs(urlparse(self.path).query).get("path", [""])[0] or "").strip()
            if _validate_doc_path(rel) is None:
                self._send_json(400, {"error": "invalid path"})
                return
            repo_rel = "content/" + rel
            # --follow tracks renames (move_doc); -z + \x1f keep records/fields
            # unambiguous; -n 100 bounds the payload and memory.
            fmt = "%H%x1f%an%x1f%aI%x1f%s"
            result = git("log", "--follow", "-n", "100", "--format=" + fmt, "-z",
                         "--", repo_rel)
            if result.returncode != 0:
                self._send_json(500, {"error": result.stderr.strip() or "git log failed"})
                return
            revisions = []
            for record in result.stdout.split("\x00"):
                if not record:
                    continue
                fields = (record.split("\x1f") + ["", "", "", ""])[:4]
                revisions.append({
                    "sha": fields[0], "author": fields[1],
                    "date": fields[2], "subject": fields[3],
                })
            self._send_json(200, {"path": rel, "revisions": revisions})
            return
        if self.path.split("?", 1)[0] == "/api/revision":
            if not self._require_auth_or_401():
                return
            from urllib.parse import urlparse, parse_qs as _pqs
            query = _pqs(urlparse(self.path).query)
            rel = (query.get("path", [""])[0] or "").strip()
            rev = (query.get("rev", [""])[0] or "").strip()
            if _validate_doc_path(rel) is None:
                self._send_json(400, {"error": "invalid path"})
                return
            if not _valid_git_rev(rev):
                self._send_json(400, {"error": "invalid rev"})
                return
            result = git("show", rev + ":content/" + rel)
            if result.returncode != 0:
                self._send_json(404, {"error": "revision not found"})
                return
            self._send_json(200, {"path": rel, "rev": rev, "content": result.stdout})
            return
        if self.path.split("?", 1)[0] == "/api/diff":
            if not self._require_auth_or_401():
                return
            from urllib.parse import urlparse, parse_qs as _pqs
            query = _pqs(urlparse(self.path).query)
            rel = (query.get("path", [""])[0] or "").strip()
            rev_from = (query.get("from", [""])[0] or "").strip()
            rev_to = (query.get("to", [""])[0] or "").strip()
            if _validate_doc_path(rel) is None:
                self._send_json(400, {"error": "invalid path"})
                return
            if not _valid_git_rev(rev_from) or not _valid_git_rev(rev_to):
                self._send_json(400, {"error": "invalid rev"})
                return
            result = git("diff", rev_from, rev_to, "--", "content/" + rel)
            if result.returncode != 0:
                self._send_json(500, {"error": result.stderr.strip() or "git diff failed"})
                return
            self._send_json(200, {
                "path": rel, "from": rev_from, "to": rev_to, "diff": result.stdout,
            })
            return
        if self.path == "/api/events":
            if not self._require_auth_or_401():
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            try:
                self.wfile.write(b": connected\n\n")
                self.wfile.flush()
                with _sse_lock:
                    _sse_clients.append(self)
                while True:
                    time.sleep(20)
                    try:
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError, OSError):
                        break
            finally:
                with _sse_lock:
                    if self in _sse_clients:
                        _sse_clients.remove(self)
            return
        # ─── Public v1 API (Bearer token) ───────────────────────────────────
        if self.path == "/.well-known/openapi.json":
            self._serve_openapi_spec()
            return
        if self.path.startswith("/api/v1/"):
            self._handle_api_v1_get()
            return
        if self.path.startswith("/mcp/"):
            self._handle_mcp()
            return
        # Extension routes (GET): BEFORE the global session guard — the
        # required role ("public"/"auth"/"admin") is applied per route.
        if self._dispatch_extension():
            return
        # First-boot (cloud mode, no admin): every viewer page redirects
        # to /setup as long as the initial admin account doesn't exist. Placed HERE
        # (after the explicit API/Bearer/MCP/share routes) so as NOT to hijack
        # the independent auth channels (Bearer /api/v1, /mcp) or /api/me —
        # only the viewer's navigable pages are affected.
        if setup_is_open():
            self.send_response(303)
            self.send_header("Location", "/setup")
            self.end_headers()
            return
        if not self._require_auth_or_redirect():
            return
        # Intercept .html files (typically index.html) to serve with gzip
        rel = self.path.split("?", 1)[0].lstrip("/")
        # Security: the static handler (super().do_GET) serves any
        # file under ROOT, dotfiles included. We explicitly refuse
        # dotfiles (.git/config contains the GitHub PAT embedded in the
        # clone URL) and source code (*.py/*.pyc).
        #
        # The checks MUST run on the CANONICAL path — normalized exactly the
        # way the static handler (translate_path -> posixpath.normpath) will
        # resolve it. A non-normalized path ("/a//b/x.md", "/a%2fb/x.md", a
        # leading "%2f") would otherwise slip past the literal-prefix dotfile/
        # ACL match here while translate_path still serves the normalized file
        # underneath — a real hidden-folder ACL bypass. URL-decoded to also
        # prevent %2e/%2f tricks.
        from urllib.parse import unquote as _unquote
        _norm = posixpath.normpath(_unquote(self.path.split("?", 1)[0]))
        _decoded = "/".join(w for w in _norm.split("/") if w and w not in (".", ".."))
        if (any(p.startswith(".") for p in _decoded.split("/"))
                or _decoded.endswith((".py", ".pyc"))):
            self.send_error(404)
            return
        # Viewer ACL (#14): a doc under a hidden folder is not found.
        if _path_hidden(_decoded, self._hidden_folders()):
            self.send_error(404)
            return
        # _backlinks.json: served gzip + ETag 304 (the default static handler
        # doesn't compress). Search itself goes through /api/search (server-side)
        # — no more _search-data.json to download. See _serve_static_gzip.
        if rel == "_backlinks.json":
            self._serve_index_filtered(rel)
            return
        # _notes-index.json (generated by build.py in dist/): counters for the
        # tree's "📝 n" badges. Without this route, the static handler
        # (which serves content/) returned 404 and the viewer silently fell
        # back to {} — the badges never showed up online.
        if rel == "_notes-index.json":
            self._serve_index_filtered(rel)
            return
        if not rel or rel.endswith("/"):
            rel = (rel + "index.html") if rel else "index.html"
        if rel.endswith(".html"):
            target = (CONFIG.dist_dir / rel).resolve()
            try:
                target.relative_to(CONFIG.dist_dir)
                if target.is_file():
                    body = target.read_bytes()
                    self._send_bytes(200, body, "text/html; charset=utf-8")
                    return
            except (ValueError, OSError):
                pass
        return super().do_GET()

    def do_POST(self):
        if CONFIG.auth_enabled and self.path == "/login":
            self._handle_login()
            return
        # First-boot: creation of the initial admin account. Before the general
        # admin guard (no admin exists yet). _handle_setup_submit refuses on its
        # own outside the window (409) and on an invalid token (403).
        if CONFIG.auth_enabled and self.path == "/api/setup":
            self._handle_setup_submit()
            return
        if self.path == "/webhook/github":
            self._handle_github_webhook()
            return
        if self.path == "/api/admin/users":
            self._handle_admin_users_post()
            return
        if self.path == "/api/admin/users/password":
            self._handle_admin_users_password()
            return
        if self.path == "/api/admin/users/hidden":
            self._handle_admin_users_hidden()
            return
        if self.path == "/api/admin/tokens":
            self._handle_admin_tokens_post()
            return
        if self.path == "/api/admin/nodes":
            self._handle_admin_nodes_post()
            return
        if self.path == "/api/admin/remotes":
            self._handle_admin_remotes_post()
            return
        if self.path == "/api/admin/remotes/sync":
            self._handle_admin_remotes_sync()
            return
        if self.path == "/api/admin/remotes/appropriate":
            self._handle_admin_remotes_appropriate()
            return
        if self.path == "/api/account/logout-all":
            self._handle_account_logout_all()
            return
        if self.path == "/api/account/totp/init":
            self._handle_totp_init()
            return
        if self.path == "/api/account/totp/enable":
            self._handle_totp_enable()
            return
        if self.path == "/api/account/totp/disable":
            self._handle_totp_disable()
            return
        if self.path == "/api/share":
            if not self._require_admin_or_403():
                return
            if not self._check_csrf_or_403():
                return
            data = self._read_json()
            rel = (data.get("path") or "").strip()
            days = _safe_int(data.get("expires_days"))
            if not rel or rel.endswith("/") or ".." in rel.split("/"):
                self._send_json(400, {"error": "invalid path"})
                return
            target = (CONFIG.content_root / rel).resolve()
            try:
                target.relative_to(CONFIG.content_root)
            except ValueError:
                self._send_json(403, {"error": "outside root"})
                return
            if not target.exists() or target.suffix.lower() not in (".md", ".html"):
                self._send_json(404, {"error": "document not found"})
                return
            exp = int(time.time() + days * 86400) if days > 0 else 0
            token = make_share_token(rel, exp)
            doc_id = None
            if CONFIG.auth_enabled:
                try:
                    sess = self._session()
                    doc_id = get_store().insert_share({
                        "path": rel,
                        "token": token,
                        "expires_at": exp,
                        "created_at": int(time.time()),
                        "created_by": (sess or {}).get("email"),
                        "revoked": False,
                    })
                except Exception as e:
                    print(f"[share insert] {e}", file=sys.stderr)
            self._send_json(200, {
                "id": doc_id, "token": token, "path": rel, "expires_at": exp,
            })
            return
        if self.path == "/api/todos":
            if not self._require_admin_or_403():
                return
            if not self._check_csrf_or_403():
                return
            data = self._read_json()
            text = (data.get("text") or "").strip()
            if not text:
                self._send_json(400, {"error": "empty text"})
                return
            todos = load_todos()
            todos.append({"id": len(todos), "text": text, "done": False,
                          "cat": _norm_cat(data.get("cat"))})
            write_todos(todos)
            trigger_sync()
            self._send_json(200, load_todos())
            return
        if self.path == "/api/notes":
            if not self._require_admin_or_403():
                return
            if not self._check_csrf_or_403():
                return
            data = self._read_json()
            rel = (data.get("path") or "").strip()
            if _notes_path(rel) is None:
                self._send_json(400, {"error": "invalid path"})
                return
            note_text = (data.get("note") or "").strip()
            exact = (data.get("exact") or "").strip()
            if not note_text or not exact:
                self._send_json(400, {"error": "note and exact required"})
                return
            note = {
                "id": uuid.uuid4().hex[:12],
                "exact": exact[:2000],
                "prefix": (data.get("prefix") or "")[:120],
                "suffix": (data.get("suffix") or "")[:120],
                "pos": _safe_int(data.get("pos")),
                "note": note_text[:5000],
                "created": int(time.time()),
            }
            notes = load_notes(rel)
            notes.append(note)
            save_notes(rel, notes)
            trigger_sync()
            self._send_json(200, note)
            return
        if self.path == "/api/revert":
            # Restore a doc to a past revision: write that revision's content back
            # as the current file. Mutating → admin + CSRF, like the other writes.
            if not self._require_admin_or_403():
                return
            if not self._check_csrf_or_403():
                return
            data = self._read_json()
            rel = (data.get("path") or "").strip()
            rev = (data.get("rev") or "").strip()
            target = _validate_doc_path(rel)
            if target is None:
                self._send_json(400, {"error": "invalid path"})
                return
            if not _valid_git_rev(rev):
                self._send_json(400, {"error": "invalid rev"})
                return
            if _is_readonly_path(rel):
                self._send_json(403, {"error": "remote mirror is read-only"})
                return
            show = git("show", rev + ":content/" + rel)
            if show.returncode != 0:
                self._send_json(404, {"error": "revision not found"})
                return
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(show.stdout, encoding="utf-8")
            trigger_sync()
            self._send_json(200, {"ok": True})
            return
        if self.path == "/api/file/move":
            if not self._require_admin_or_403():
                return
            if not self._check_csrf_or_403():
                return
            data = self._read_json()
            if _is_readonly_path(data.get("from") or "") or _is_readonly_path(data.get("to") or ""):
                self._send_json(403, {"error": "remote mirror is read-only"})
                return
            # Helper shared with the MCP move_doc tool: moves AND rewrites the
            # incoming wikilinks (the old code did a raw rename that broke
            # all the [[backlinks]] to the moved doc).
            status, payload = _move_md_with_relink(
                (data.get("from") or "").strip(), (data.get("to") or "").strip())
            if status != "ok":
                code = {"invalid": 400, "not_found": 404, "exists": 409}.get(status, 500)
                self._send_json(code, {"error": payload})
                return
            trigger_sync()
            self._send_json(200, {"ok": True, **payload})
            return
        if self.path == "/api/dir/rename":
            if not self._require_admin_or_403():
                return
            if not self._check_csrf_or_403():
                return
            data = self._read_json()
            src_rel = (data.get("from") or "").strip().strip("/")
            dst_rel = (data.get("to") or "").strip().strip("/")
            for rel in (src_rel, dst_rel):
                if not rel or ".." in rel.split("/") or rel.startswith("/"):
                    self._send_json(400, {"error": "invalid path"})
                    return
            # Blocks reserved / technical folders (remotes/ = read-only remote
            # mirrors, managed by the sync).
            reserved = {"skill", "tools", ".git", "__pycache__", "node_modules", REMOTES_DIR}
            for part in src_rel.split("/") + dst_rel.split("/"):
                if part in reserved or part.startswith("."):
                    self._send_json(403, {"error": f"protected dir: {part}"})
                    return
            src = (CONFIG.content_root / src_rel).resolve()
            dst = (CONFIG.content_root / dst_rel).resolve()
            try:
                src.relative_to(CONFIG.content_root)
                dst.relative_to(CONFIG.content_root)
            except ValueError:
                self._send_json(403, {"error": "outside root"})
                return
            if not src.exists() or not src.is_dir():
                self._send_json(404, {"error": "source dir not found"})
                return
            if dst.exists():
                self._send_json(409, {"error": "destination exists"})
                return
            # Prevents moving into a subfolder of itself
            try:
                dst.relative_to(src)
                self._send_json(400, {"error": "destination is inside source"})
                return
            except ValueError:
                pass
            dst.parent.mkdir(parents=True, exist_ok=True)
            src.rename(dst)
            trigger_sync()
            self._send_json(200, {"ok": True, "from": src_rel, "to": dst_rel})
            return
        if self.path.startswith("/api/v1/"):
            self._handle_api_v1_post()
            return
        if self.path.startswith("/mcp/"):
            self._handle_mcp()
            return
        # Extension routes (POST): after all the native routes, before
        # the final 404. Role required per route, default "admin" for POST.
        if self._dispatch_extension():
            return
        self.send_response(404)
        self.end_headers()

    def do_PATCH(self):
        if not self._require_admin_or_403():
            return
        if not self._check_csrf_or_403():
            return
        # Editing the text of an annotation: PATCH /api/notes?path=<rel>&id=<id>
        if self.path.split("?", 1)[0] == "/api/notes":
            from urllib.parse import urlparse, parse_qs as _pqs
            q = _pqs(urlparse(self.path).query)
            rel = (q.get("path", [""])[0] or "").strip()
            note_id = (q.get("id", [""])[0] or "").strip()
            if _notes_path(rel) is None or not note_id:
                self._send_json(400, {"error": "path and id required"})
                return
            note_text = (self._read_json().get("note") or "").strip()
            if not note_text:
                self._send_json(400, {"error": "empty note"})
                return
            notes = load_notes(rel)
            hit = next((n for n in notes if n.get("id") == note_id), None)
            if hit is None:
                self._send_json(404, {"error": "not found"})
                return
            hit["note"] = note_text[:5000]
            hit["updated"] = int(time.time())
            save_notes(rel, notes)
            trigger_sync()
            self._send_json(200, hit)
            return
        idx = self._todo_index_from_path()
        if idx is None:
            self.send_response(404)
            self.end_headers()
            return
        data = self._read_json()
        todos = load_todos()
        if idx < 0 or idx >= len(todos):
            self._send_json(404, {"error": "not found"})
            return
        if "done" in data:
            todos[idx]["done"] = bool(data["done"])
        if "text" in data and data["text"].strip():
            todos[idx]["text"] = data["text"].strip()
        if "cat" in data:
            todos[idx]["cat"] = _norm_cat(data["cat"])
        write_todos(todos)
        trigger_sync()
        self._send_json(200, load_todos())

    def do_DELETE(self):
        # Administration: these handlers carry their own admin + CSRF guard
        # (routed BEFORE the global guard below so as not to send two
        # responses).
        if self.path == "/api/admin/users":
            self._handle_admin_users_delete()
            return
        if self.path == "/api/admin/nodes":
            self._handle_admin_nodes_delete()
            return
        if self.path == "/api/admin/remotes":
            self._handle_admin_remotes_delete()
            return
        if self.path == "/api/admin/tokens":
            self._handle_admin_tokens_delete()
            return
        if not self._require_admin_or_403():
            return
        if not self._check_csrf_or_403():
            return
        # Deletion of a .md file
        if self.path == "/api/file":
            data = self._read_json()
            rel = (data.get("path") or "").strip()
            if not rel or ".." in rel.split("/") or rel.startswith("/"):
                self._send_json(400, {"error": "invalid path"})
                return
            if _is_readonly_path(rel):
                self._send_json(403, {"error": "remote mirror is read-only"})
                return
            target = (CONFIG.content_root / rel).resolve()
            try:
                target.relative_to(CONFIG.content_root)
            except ValueError:
                self._send_json(403, {"error": "outside root"})
                return
            if not target.exists() or target.suffix.lower() not in (".md", ".html"):
                self._send_json(404, {"error": "document not found"})
                return
            target.unlink()
            trigger_sync()
            self._send_json(200, {"ok": True})
            return
        # Deletion of an annotation: DELETE /api/notes?path=<rel>&id=<id>
        if self.path.split("?", 1)[0] == "/api/notes":
            from urllib.parse import urlparse, parse_qs as _pqs
            q = _pqs(urlparse(self.path).query)
            rel = (q.get("path", [""])[0] or "").strip()
            note_id = (q.get("id", [""])[0] or "").strip()
            if _notes_path(rel) is None or not note_id:
                self._send_json(400, {"error": "path and id required"})
                return
            notes = load_notes(rel)
            kept = [n for n in notes if n.get("id") != note_id]
            if len(kept) == len(notes):
                self._send_json(404, {"error": "not found"})
                return
            save_notes(rel, kept)
            trigger_sync()
            self._send_json(200, {"ok": True})
            return
        # Soft delete of a share link: sets revoked: true. The id is either an
        # EXACT 24-hex legacy id (historical regex) or a uuid4 8-4-4-4-12
        # (FileStore). Strict alternation: any other format (e.g. 25 hex) keeps
        # the historical fall-through to the todos route (bare 404).
        m = re.match(
            r"^/api/share/([a-fA-F0-9]{24}|"
            r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}"
            r"-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$",
            self.path)
        if m:
            try:
                if not get_store().revoke_share(m.group(1)):
                    self._send_json(404, {"error": "not found or already revoked"})
                    return
                self._send_json(200, {"ok": True})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return
        idx = self._todo_index_from_path()
        if idx is None:
            self.send_response(404)
            self.end_headers()
            return
        todos = load_todos()
        if idx < 0 or idx >= len(todos):
            self._send_json(404, {"error": "not found"})
            return
        todos.pop(idx)
        write_todos(todos)
        trigger_sync()
        self._send_json(200, load_todos())

    def do_PUT(self):
        if not self._require_admin_or_403():
            return
        if not self._check_csrf_or_403():
            return
        if self.path != "/api/file":
            self.send_response(404)
            self.end_headers()
            return
        data = self._read_json()
        rel = (data.get("path") or "").strip()
        content = data.get("content", "")
        if not rel or ".." in rel.split("/"):
            self._send_json(400, {"error": "invalid path"})
            return
        if _is_readonly_path(rel):
            self._send_json(403, {"error": "remote mirror is read-only"})
            return
        target = (CONFIG.content_root / rel).resolve()
        try:
            target.relative_to(CONFIG.content_root)
        except ValueError:
            self._send_json(403, {"error": "outside root"})
            return
        if target.suffix.lower() not in (".md", ".html"):
            self._send_json(400, {"error": "only .md or .html"})
            return
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        trigger_sync()
        self._send_json(200, {"ok": True, "mtime": int(target.stat().st_mtime)})

    # ─── API v1 handlers (Bearer auth, read + create) ─────────────────────

    def _serve_openapi_spec(self):
        """Public OpenAPI 3.1 spec (no auth) for discovery by Claude.ai."""
        scheme = "https" if CONFIG.auth_enabled else "http"
        host = self.headers.get("Host", f"localhost:{CONFIG.port}")
        spec = {
            "openapi": "3.1.0",
            "info": {
                "title": CONFIG.site_name,
                "description": f"{CONFIG.tagline} Search, read and create markdown documents (read-only + create-only).",
                "version": "1.0.0",
            },
            "servers": [{"url": f"{scheme}://{host}"}],
            "components": {
                "securitySchemes": {
                    "bearerAuth": {"type": "http", "scheme": "bearer"}
                },
                "schemas": {
                    "SearchHit": {
                        "type": "object",
                        "properties": {
                            "path": {"type": "string"},
                            "name": {"type": "string"},
                            "score": {"type": "number"},
                            "snippet": {"type": "string"},
                            "mtime": {"type": "integer", "description": "Unix epoch seconds"},
                        },
                    },
                    "FileContent": {
                        "type": "object",
                        "properties": {
                            "path": {"type": "string"},
                            "name": {"type": "string"},
                            "content": {"type": "string"},
                            "mtime": {"type": "integer"},
                            "words": {"type": "integer"},
                        },
                    },
                },
            },
            "security": [{"bearerAuth": []}],
            "paths": {
                "/api/v1/search": {
                    "get": {
                        "operationId": "searchDocs",
                        "summary": "Full-text search across all .md in the base",
                        "description": "Returns the documents matching the query, ranked by score. Use terms in the language of the indexed content.",
                        "parameters": [
                            {"name": "q", "in": "query", "required": True, "schema": {"type": "string"}, "description": "Search term(s)"},
                            {"name": "limit", "in": "query", "schema": {"type": "integer", "default": 10, "maximum": 50}},
                        ],
                        "responses": {
                            "200": {
                                "description": "Results ranked by relevance",
                                "content": {"application/json": {"schema": {"type": "array", "items": {"$ref": "#/components/schemas/SearchHit"}}}},
                            }
                        },
                    }
                },
                "/api/v1/file": {
                    "get": {
                        "operationId": "readDoc",
                        "summary": "Read the full content of a markdown document",
                        "parameters": [{"name": "path", "in": "query", "required": True, "schema": {"type": "string"}, "description": "Relative path (e.g. notes/example.md)"}],
                        "responses": {
                            "200": {"description": "Document content", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/FileContent"}}}},
                            "404": {"description": "Document not found"},
                        },
                    },
                    "post": {
                        "operationId": "createDoc",
                        "summary": "Create a new markdown document (refuses overwrite)",
                        "description": "Returns 409 if a document already exists at this path. The content must be valid markdown.",
                        "requestBody": {
                            "required": True,
                            "content": {"application/json": {"schema": {
                                "type": "object",
                                "required": ["path", "content"],
                                "properties": {
                                    "path": {"type": "string", "description": "Relative path ending in .md (e.g. inbox/note.md)"},
                                    "content": {"type": "string", "description": "Full markdown body"},
                                },
                            }}},
                        },
                        "responses": {
                            "201": {"description": "Document created"},
                            "409": {"description": "Already exists — no overwrite allowed for this token"},
                        },
                    },
                },
                "/api/v1/tree": {
                    "get": {
                        "operationId": "listTree",
                        "summary": "List the full document tree (metadata without content)",
                        "responses": {"200": {"description": "Knowledge base tree", "content": {"application/json": {"schema": {"type": "object"}}}}},
                    }
                },
                "/api/v1/recent": {
                    "get": {
                        "operationId": "recentDocs",
                        "summary": "Recently modified documents, newest first",
                        "parameters": [
                            {"name": "days", "in": "query", "schema": {"type": "integer", "default": 7}, "description": "Window in days"},
                            {"name": "limit", "in": "query", "schema": {"type": "integer", "default": 20, "maximum": 100}},
                        ],
                        "responses": {"200": {"description": "List of documents", "content": {"application/json": {"schema": {"type": "array", "items": {"$ref": "#/components/schemas/SearchHit"}}}}}},
                    }
                },
            },
        }
        body = json.dumps(spec, ensure_ascii=False).encode("utf-8")
        self._send_bytes(200, body, "application/json; charset=utf-8",
                         [("Cache-Control", "public, max-age=300")])

    def _handle_api_v1_get(self):
        sess = self._require_api_bearer()
        if not sess:
            return
        from urllib.parse import urlparse, parse_qs as _pqs
        parsed = urlparse(self.path)
        query = _pqs(parsed.query)
        endpoint = parsed.path
        if endpoint == "/api/v1/search":
            q = (query.get("q", [""])[0] or "").strip()
            if not q:
                self._send_json(400, {"error": "missing query parameter 'q'"})
                return
            try:
                limit = min(50, max(1, int(query.get("limit", ["10"])[0])))
            except ValueError:
                limit = 10
            self._send_json(200, _api_search(q, limit))
            return
        if endpoint == "/api/v1/file":
            rel = (query.get("path", [""])[0] or "").strip()
            target = _validate_doc_path(rel)
            if not target or not target.exists():
                self._send_json(404, {"error": "document not found"})
                return
            text = target.read_text(encoding="utf-8")
            self._send_json(200, {
                "path": rel,
                "name": target.name,
                "content": text,
                "mtime": int(target.stat().st_mtime),
                "words": len(text.split()),
            })
            return
        if endpoint == "/api/v1/tree":
            try:
                tree = _import_build().walk(CONFIG.content_root)
                self._send_json(200, tree)
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return
        if endpoint == "/api/v1/recent":
            try:
                days = max(1, int(query.get("days", ["7"])[0]))
                limit = min(100, max(1, int(query.get("limit", ["20"])[0])))
            except ValueError:
                days, limit = 7, 20
            self._send_json(200, _api_recent(days, limit))
            return
        self._send_json(404, {"error": "unknown endpoint"})

    def _handle_api_v1_post(self):
        sess = self._require_api_bearer()
        if not sess:
            return
        if self.path != "/api/v1/file":
            self._send_json(404, {"error": "unknown endpoint"})
            return
        data = self._read_json()
        rel = (data.get("path") or "").strip()
        content = data.get("content", "")
        target = _validate_doc_path(rel)
        if not target:
            self._send_json(400, {"error": "invalid path (must be a .md or .html inside root, no '..')"})
            return
        if target.exists():
            self._send_json(409, {"error": "document already exists (create-only token)"})
            return
        if not isinstance(content, str):
            self._send_json(400, {"error": "content must be a string"})
            return
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        trigger_sync()
        self._send_json(201, {"ok": True, "path": rel, "mtime": int(target.stat().st_mtime)})

    def _handle_mcp(self):
        """Streamable HTTP transport for the MCP protocol. Token in the path.

        URL: /mcp/<token>[/...].
        - POST JSON-RPC body → JSON-RPC response (or 204 if notification)
        - GET with Accept: text/event-stream → SSE stream (keep-alive, for
          server→client notifications); otherwise 405.
        """
        # Extract the token from the path: /mcp/<token>[/...]
        parts = self.path.split("?", 1)[0].strip("/").split("/")
        if len(parts) < 2 or parts[0] != "mcp":
            self._send_json(404, {"error": "not found"})
            return
        token = parts[1]
        if not _verify_mcp_token(token):
            self._send_json(401, {"error": "invalid mcp token"})
            return
        # Rate limit (shared with the REST API)
        if not api_rate_limit_ok(_hash_api_token(token)):
            self._send_json(429, {"error": "rate limit exceeded"})
            return

        if self.command == "GET":
            # SSE keep-alive stream (server→client notifications are not used
            # by our tools, but Claude.ai may open the connection for
            # discovery). We keep it open with a ping every 30s.
            accept = self.headers.get("Accept", "")
            if "text/event-stream" not in accept:
                self._send_json(405, {"error": "method not allowed (use Accept: text/event-stream)"})
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            try:
                self.wfile.write(b": connected\n\n")
                self.wfile.flush()
                while True:
                    time.sleep(30)
                    try:
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError, OSError):
                        break
            except Exception:
                pass
            return

        if self.command == "POST":
            try:
                raw = self._read_body() or b"{}"
                req = json.loads(raw)
            except (ValueError, json.JSONDecodeError):
                self._send_json(400, {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}})
                return

            # Batch or single request
            if isinstance(req, list):
                responses = [r for r in (_mcp_jsonrpc(item) for item in req) if r is not None]
                if not responses:
                    self.send_response(204)
                    self.end_headers()
                    return
                self._send_json(200, responses)
                return

            response = _mcp_jsonrpc(req)
            if response is None:
                # Notification → 204 No Content
                self.send_response(204)
                self.end_headers()
                return
            self._send_json(200, response)
            return

        self._send_json(405, {"error": "method not allowed"})

    def log_message(self, fmt, *args):
        # In cloud mode we log requests to debug webhook/sync
        if CONFIG.auth_enabled:
            # Mask the MCP token present in the path (/mcp/<token>) so it is not
            # written in clear text in the Fly logs.
            msg = re.sub(r"/mcp/[^/\s\"?]+", "/mcp/***", fmt % args)
            sys.stderr.write("%s - %s\n" % (self.address_string(), msg))
            sys.stderr.flush()


# ─── Bootstrap ─────────────────────────────────────────────────────────────────


if __name__ == "__main__":
    # Any clone can only depend on the env: atlas.toml lives INSIDE the mind,
    # which does not yet exist on the cloud side at this point.
    mind_root = resolve_mind_root()
    freshly_cloned = False
    if os.environ.get("KB_AUTH_ENABLED"):
        # Fail-fast BEFORE the clone when the env EXPLICITLY carries an empty or
        # default SESSION_SECRET: otherwise each iteration of the Fly restart
        # loop would pay for a full clone (network, PAT, disk write) before
        # dying on the guard below. A SESSION_SECRET absent from the env is
        # still accepted at this point: atlas.toml (which lives INSIDE the
        # clone) can provide it — the full guard after AtlasConfig.load remains
        # the authority.
        env_secret = os.environ.get("SESSION_SECRET")
        if env_secret is not None and env_secret in ("", "dev-secret-change-me"):
            sys.exit(
                "FATAL: SESSION_SECRET not set in cloud mode (KB_AUTH_ENABLED=1).\n"
                "  fly secrets set SESSION_SECRET=$(python3 -c \"import secrets;print(secrets.token_hex(32))\")"
            )
        freshly_cloned = ensure_repo_cloned(mind_root)

    # The config is built HERE, and nowhere else: after the clone, so that
    # <mind>/atlas.toml is readable. No more reassignment of path globals —
    # everything derived from it goes through CONFIG.
    try:
        CONFIG = AtlasConfig.load(root=mind_root)
    except AtlasConfigError as e:
        sys.exit(f"FATAL: {e}")

    if CONFIG.auth_enabled:
        # Refuse to start in cloud with the default secret: it is public (in
        # this file) → forgeable session AND share tokens = total auth bypass.
        # Better to crash than to run wide open.
        if not CONFIG.session_secret or CONFIG.session_secret == b"dev-secret-change-me":
            sys.exit(
                "FATAL: SESSION_SECRET not set in cloud mode (KB_AUTH_ENABLED=1).\n"
                "  fly secrets set SESSION_SECRET=$(python3 -c \"import secrets;print(secrets.token_hex(32))\")"
            )
        if freshly_cloned:
            # The bot's git identity is set on the fresh clone only (as before);
            # the values come from CONFIG (historical defaults).
            git("config", "user.email", CONFIG.git_author_email)
            git("config", "user.name", CONFIG.git_author_name)
        # Rebuild the viewer on cold start in case the cloned repo is fresh.
        subprocess.run(
            [sys.executable, str(_build_script())],
            cwd=str(CONFIG.root),
            env=_build_env(),
            capture_output=True,
            timeout=60,
        )

    # The mind's server extensions: loaded once at boot. A broken extension is
    # reported on stderr and ignored — the server still starts.
    load_server_extensions(CONFIG)

    # First-boot (cloud mode): if no admin exists, generate and print a setup
    # token, opening the /setup window to create the first admin.
    if CONFIG.auth_enabled:
        maybe_init_setup_token()

    os.chdir(CONFIG.root)
    migrate_legacy_format()
    threading.Thread(target=watcher_loop, daemon=True).start()
    if CONFIG.auth_enabled:
        threading.Thread(target=git_pull_loop, daemon=True).start()
        # Flush unpushed writes when Fly stops the machine (deploy/scale).
        signal.signal(signal.SIGTERM, _graceful_flush)

    bind = "0.0.0.0" if CONFIG.auth_enabled else "127.0.0.1"
    mode = "cloud" if CONFIG.auth_enabled else "local"
    print(f"{CONFIG.site_name} ({mode}) : http://{bind}:{CONFIG.port}")
    try:
        todo_display = CONFIG.todo_file.relative_to(CONFIG.root)
    except ValueError:
        # [todo].file absolute and outside the mind (supported by AtlasConfig):
        # displayed as-is instead of killing the boot on the relative_to.
        todo_display = CONFIG.todo_file
    print(f"Todo -> {todo_display}")
    print("Ctrl+C to stop")
    try:
        ThreadingHTTPServer((bind, CONFIG.port), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        sys.exit(0)
