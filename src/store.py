#!/usr/bin/env python3
"""Access layer for identities and share links (users + share_links).

FileStore: an on-disk registry with no external dependency.
- users.json / shares.json under <base> (ROOT/.atlas/ in practice).
  Atomic writes (tempfile + os.replace) under a per-file threading.Lock,
  re-read on mtime change. uuid4 ids (str) — find/revoke also accept legacy
  24-hex ids (plain equality, no format enforced).
  A share token is a capability URL, not an auth secret: kept in CLEARTEXT in
  shares.json so the admin can re-copy the link, alongside its SHA256 lookup
  index. Only users.json (password hashes, api_token_hash) is hash-only.
  last_used_at lives in a separate state.json, never in the durable files.
  The directory carries a .gitignore "*": the registry (password hashes,
  api_token_hash, AND the cleartext share-link tokens) must NEVER be staged by
  the `git add -A` of trigger_sync/pull_and_rebuild and pushed to the content repo.
  An ABSENT registry file counts as empty; a present-but-corrupted file raises
  (fail-CLOSED in server.py: login/share 503, Bearer 401) — an unreadable
  registry must never pass for empty, or a link revocation would be bypassed.

Login timing equalization (anti email-enumeration): dummy_verify is aligned
with the cost of the hash scheme the accounts actually use — dummy scrypt
(native scheme) plus a dummy bcrypt when importable (legacy "$2…" hashes may
coexist via verify_password).

The native password hash is scrypt (stdlib, no dependency) in the format
"scrypt$N$r$p$salt_b64$hash_b64"; verify_password falls back to bcrypt for
legacy hashes starting with "$2" (conditional import).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import tempfile
import threading
import time
import uuid
from pathlib import Path

API_ROLE = "api"


class LastAdminError(Exception):
    """Raised by delete_user(protect_last_admin=True) when the deletion would
    remove the LAST admin (total lockout of the instance). Distinct from infra
    errors: the server maps it to 409, not 503."""


# ─── Passwords (native scrypt + legacy bcrypt fallback) ────────────────────────

SCRYPT_N = 2 ** 14
SCRYPT_R = 8
SCRYPT_P = 1
_SCRYPT_DKLEN = 64
_SCRYPT_SALT_BYTES = 16


def hash_password(password: str) -> str:
    """scrypt hash in the format "scrypt$N$r$p$salt_b64$hash_b64"."""
    salt = os.urandom(_SCRYPT_SALT_BYTES)
    digest = hashlib.scrypt(
        password.encode("utf-8"), salt=salt,
        n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=_SCRYPT_DKLEN,
    )
    salt_b64 = base64.b64encode(salt).decode("ascii")
    hash_b64 = base64.b64encode(digest).decode("ascii")
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${salt_b64}${hash_b64}"


def _verify_scrypt(password: str, stored: str) -> bool:
    try:
        _, n, r, p, salt_b64, hash_b64 = stored.split("$")
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(hash_b64)
        digest = hashlib.scrypt(
            password.encode("utf-8"), salt=salt,
            n=int(n), r=int(r), p=int(p), dklen=len(expected),
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(digest, expected)


def _verify_bcrypt(password: str, stored: str) -> bool:
    """Fallback verification for legacy "$2…" hashes (historical accounts).

    bcrypt is only imported when such a hash is actually encountered: it
    stays optional everywhere else (pure-scrypt FileStore = zero dependency)."""
    try:
        import bcrypt
    except ImportError:
        return False
    try:
        return bcrypt.checkpw(password.encode("utf-8"), stored.encode("utf-8"))
    except ValueError:
        return False


def verify_password(password: str, stored) -> bool:
    """Verify a password against a stored hash (str OR bytes).

    "$2…"      → legacy bcrypt (conditional import)
    "scrypt$…" → native scrypt
    other      → reject.
    """
    if isinstance(stored, bytes):
        stored = stored.decode("utf-8", "replace")
    if not isinstance(stored, str) or not stored:
        return False
    if stored.startswith("$2"):
        return _verify_bcrypt(password, stored)
    if stored.startswith("scrypt$"):
        return _verify_scrypt(password, stored)
    return False


_dummy_hash = None
_dummy_lock = threading.Lock()


def dummy_verify(password: str) -> None:
    """Verify a dummy scrypt hash to equalize the login response time when the
    email is unknown (or role 'api') — without it, an unknown email replies
    instantly vs ~X ms for a known email → enumeration oracle.

    scrypt cost only: this is the dummy of the NATIVE scheme. Stores expose
    dummy_verify() as a method to match the cost of the scheme their accounts
    actually use (legacy bcrypt accounts) — see the module docstring."""
    global _dummy_hash
    if _dummy_hash is None:
        with _dummy_lock:
            if _dummy_hash is None:
                _dummy_hash = hash_password("timing-equalizer")
    verify_password(password, _dummy_hash)


_dummy_bcrypt_hash = None
_dummy_bcrypt_lock = threading.Lock()


def _dummy_bcrypt_verify(password: str) -> None:
    """Verify a dummy bcrypt hash rounds=12 — the cost of a real bcrypt account.
    Exact replica of server.py's former _dummy_bcrypt, lazy
    import included: without bcrypt installed, ImportError propagates (like the
    former `import bcrypt` in authenticate() → 503 on the login side)."""
    global _dummy_bcrypt_hash
    import bcrypt
    if _dummy_bcrypt_hash is None:
        with _dummy_bcrypt_lock:
            if _dummy_bcrypt_hash is None:
                _dummy_bcrypt_hash = bcrypt.hashpw(
                    b"timing-equalizer", bcrypt.gensalt(rounds=12))
    bcrypt.checkpw(password.encode("utf-8"), _dummy_bcrypt_hash)


def hash_share_token(token: str) -> str:
    return hashlib.sha256((token or "").encode("utf-8")).hexdigest()


def hash_api_token(token: str) -> str:
    """SHA256 hex of an API token — the only stored form (never cleartext)."""
    return hashlib.sha256((token or "").encode("utf-8")).hexdigest()


# Unusable password sentinel for 'api' accounts: looks like bcrypt but never
# verifies. Historical value shared with cli.py — an 'api' account rejects login.
UNUSABLE_PASSWORD_HASH = "$2b$12$" + "x" * 53


def slugify_token_label(label: str) -> str:
    """Slug of a token label (a-z0-9._-), to derive its identity email.

    Raises ValueError if the label produces no usable character — callers
    (CLI, server) translate that into a human-facing error."""
    slug = "".join(
        c if c in "abcdefghijklmnopqrstuvwxyz0123456789._-" else "-"
        for c in (label or "").strip().lower())
    # Collapse consecutive dashes, then trim the edges ("." and "-").
    while "--" in slug:
        slug = slug.replace("--", "-")
    slug = slug.strip("-.")
    if not slug:
        raise ValueError(f"invalid token label: {label!r}")
    return slug


def token_email(label: str) -> str:
    """Identity email of a token, derived from the label (<slug>@api.local).

    Single source of truth for the format (CLI and admin endpoints point here):
    the label "claude" yields claude@api.local, the historical identity."""
    return f"{slugify_token_label(label)}@api.local"


def new_api_token_fields(label: str, *, set_unusable_password: bool) -> tuple:
    """Generate an API token and the block of fields to upsert for its account.

    secrets.token_hex(32) = 256 bits, only the SHA256 is stored, role 'api'.
    Returns (plaintext_token, fields) — the cleartext is exposed only here, once.

    set_unusable_password: True for a NEW 'api' account (sets the non-loggable
    password sentinel); False to regenerate an existing one (its sentinel
    password_hash stays in place)."""
    import secrets  # local: the boot does not need it

    token = secrets.token_hex(32)
    fields = {
        "role": API_ROLE,
        "label": label,
        "api_token_hash": hash_api_token(token),
        "api_token_created_at": int(time.time()),
        "api_token_revoked_at": None,
    }
    if set_unusable_password:
        fields["password_hash"] = UNUSABLE_PASSWORD_HASH
    return token, fields


# Invite link TTL: 7 days. An admin creates a PENDING account (email + role, no
# password); the invitee opens /invite/<token> and sets their OWN password. Only
# the token's SHA256 is stored on the account (invite_token_hash) — never the
# cleartext, which is returned to the admin once at creation.
INVITE_TTL_SECONDS = 7 * 86400


def new_invite_fields(role: str) -> tuple:
    """Generate an invite token + the fields for a PENDING user account.

    The account carries NO usable password (no password_hash) until the invitee
    accepts; login rejects it on invite_token_hash (see authenticate_user), so it
    never reaches verify_password. Returns (plaintext_token, fields) — the
    cleartext is exposed only here, once."""
    import secrets  # local: the boot does not need it
    token = secrets.token_urlsafe(32)
    now = int(time.time())
    fields = {
        "role": role,
        "created_at": now,
        "invite_token_hash": hash_api_token(token),
        "invite_created_at": now,
        "invite_expires_at": now + INVITE_TTL_SECONDS,
    }
    return token, fields


def _public_api_identity(user: dict) -> dict:
    """Exposable view of an 'api' account: NEVER the token nor its hash.

    Stable shape shared by both stores (list_api_identities)."""
    return {
        "email": user.get("email"),
        "label": user.get("label"),
        "role": API_ROLE,
        "created_at": user.get("api_token_created_at"),
        "last_used_at": user.get("api_last_used_at"),
        "revoked": not bool(user.get("api_token_hash")),
        "revoked_at": user.get("api_token_revoked_at"),
    }


def _normalize_share(record: dict) -> dict:
    """Output shape of list_shares — exactly the keys the /api/share/list
    endpoint returned when it mapped the registry documents itself."""
    return {
        "id": record.get("id"),
        "path": record.get("path"),
        "token": record.get("token"),
        "expires_at": record.get("expires_at", 0),
        "created_at": record.get("created_at", 0),
        "created_by": record.get("created_by"),
        "revoked": record.get("revoked", False),
        "revoked_at": record.get("revoked_at"),
    }


def _remote_public(record: dict) -> dict:
    """View of a subscription WITHOUT the token, for the UI/API (the token never leaves)."""
    return {key: value for key, value in record.items() if key != "token"}


# ─── FileStore ─────────────────────────────────────────────────────────────────


class FileStore:
    """On-disk users/shares registry (JSON), with no external dependency.

    - users.json  : list of {email, password_hash, role, api_token_hash?, …}
                    (password/token HASHES only — never a cleartext secret).
    - shares.json : list of {id, path, token, token_sha256, expires_at, created_at,
                    created_by, revoked, revoked_at?}. A share token is a
                    capability URL, not an auth secret: it is kept in cleartext so
                    the admin can re-copy the link, alongside its SHA256 lookup
                    index. The registry is never committed/pushed (gitignored).
    - state.json  : volatile data (last_used_at per identity), kept separate so
                    the durable files aren't rewritten on every Bearer request.

    Concurrency: one threading.Lock per file around each read-modify-write
    sequence; atomic write tempfile + os.replace; re-read when the mtime
    changes (an external seed is seen immediately).
    """

    USERS_FILE = "users.json"
    SHARES_FILE = "shares.json"
    NODES_FILE = "nodes.json"
    REMOTES_FILE = "remotes.json"
    STATE_FILE = "state.json"
    ACL_FILE = "acl.json"        # per-document ACL (model B): {path: {owner, grants[]}}
    GROUPS_FILE = "groups.json"  # principals: {group_name: [emails]}
    TODOS_FILE = "todos.json"    # per-member todos (private, not git): {email: [items]}

    def __init__(self, base_dir):
        self.base = Path(base_dir)
        self._locks = {
            self.USERS_FILE: threading.Lock(),
            self.SHARES_FILE: threading.Lock(),
            self.NODES_FILE: threading.Lock(),
            self.REMOTES_FILE: threading.Lock(),
            self.STATE_FILE: threading.Lock(),
            self.ACL_FILE: threading.Lock(),
            self.GROUPS_FILE: threading.Lock(),
            self.TODOS_FILE: threading.Lock(),
        }
        self._cache: dict = {}  # name -> (mtime_ns, data)
        self._ensure_gitignore()

    def _ensure_gitignore(self) -> None:
        """Write <base>/.gitignore = "*": when the registry lives INSIDE the
        content's git repo (ROOT/.atlas), the `git add -A` of trigger_sync must
        never stage it — otherwise password hashes, api_token_hash and share-token
        SHA256s end up in git history, then on GitHub at push. Best-effort: a write
        failure must not break the store (server.py also adds it to
        .git/info/exclude)."""
        try:
            self.base.mkdir(parents=True, exist_ok=True)
            if (self.base / ".git").exists():
                # The registry dir is itself a git repo root (misconfig pointing at
                # a whole mind): a .gitignore "*" would hide ALL content from git.
                # AtlasConfig already refuses store.dir = mind root; belt-and-braces
                # for FileStore instances built directly.
                return
            gitignore = self.base / ".gitignore"
            if not gitignore.exists():
                gitignore.write_text("*\n", encoding="utf-8")
        except OSError:
            pass

    # ── low-level persistence ─────────────────────────────────────────────────

    def _load(self, name: str, default_type=list):
        """Parsed file contents, re-read only if the mtime changed.

        ONLY an absent file counts as "empty". Present-but-unreadable /
        unparseable / wrong root type → ValueError, which server.py maps to
        fail-CLOSED. A corrupted registry must NEVER pass for an empty one, or a
        revoked link would be re-served and upsert_user would overwrite the file."""
        path = self.base / name
        try:
            mtime = path.stat().st_mtime_ns
        except FileNotFoundError:
            self._cache.pop(name, None)
            return default_type()
        cached = self._cache.get(name)
        if cached is not None and cached[0] == mtime:
            return cached[1]
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            # Removed between the stat() and the read: absent → empty.
            self._cache.pop(name, None)
            return default_type()
        except (OSError, ValueError) as error:
            raise ValueError(f"{name} unreadable or corrupted: {error}")
        if not isinstance(data, default_type):
            raise ValueError(
                f"{name}: unexpected root type ({type(data).__name__} "
                f"instead of {default_type.__name__})")
        self._cache[name] = (mtime, data)
        return data

    def _write(self, name: str, data) -> None:
        """Atomic write: all or nothing, never a readable truncated JSON."""
        self.base.mkdir(parents=True, exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(
            dir=str(self.base), prefix=name + ".", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(data, handle, ensure_ascii=False, indent=1)
            os.replace(tmp_path, self.base / name)
        except BaseException:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise
        try:
            self._cache[name] = ((self.base / name).stat().st_mtime_ns, data)
        except OSError:
            self._cache.pop(name, None)

    # ── users ────────────────────────────────────────────────────────────────

    def get_user_by_email(self, email: str):
        with self._locks[self.USERS_FILE]:
            for user in self._load(self.USERS_FILE):
                if user.get("email") == email:
                    return dict(user)
        return None

    def dummy_verify(self, password: str) -> None:
        """Timing equalization for unknown email / role 'api'.

        Always run the dummy of the NATIVE scheme (scrypt). Run the bcrypt dummy
        ONLY when the registry actually holds a legacy "$2…" account, so the
        unknown-email cost matches the heaviest scheme IN USE. Adding bcrypt
        unconditionally over a scrypt-only registry would itself be the
        enumeration oracle we defend against (unknown = scrypt+bcrypt vs real =
        scrypt-only → measurably faster)."""
        dummy_verify(password)
        if self._has_bcrypt_account():
            try:
                _dummy_bcrypt_verify(password)
            except ImportError:
                pass

    def _has_bcrypt_account(self) -> bool:
        """True if any account stores a legacy bcrypt ("$2…") password hash."""
        try:
            with self._locks[self.USERS_FILE]:
                users = self._load(self.USERS_FILE)
        except Exception:
            return False
        return any(str(u.get("password_hash", "")).startswith("$2") for u in users)

    def find_api_identity(self, token_sha256: str):
        if not token_sha256:
            return None
        with self._locks[self.USERS_FILE]:
            for user in self._load(self.USERS_FILE):
                if user.get("role") != API_ROLE:
                    continue
                stored = user.get("api_token_hash") or ""
                if stored and hmac.compare_digest(stored, token_sha256):
                    return dict(user)
        return None

    def find_user_by_invite_token(self, token_sha256: str):
        """Find a PENDING account by its invite-token SHA256 (constant-time).
        Returns the user dict or None. Liveness (expiry / single-use) is
        re-checked atomically by accept_invite — this is a read-only lookup just
        to render the accept page."""
        if not token_sha256:
            return None
        with self._locks[self.USERS_FILE]:
            for user in self._load(self.USERS_FILE):
                stored = user.get("invite_token_hash") or ""
                if stored and hmac.compare_digest(stored, token_sha256):
                    return dict(user)
        return None

    def touch_last_used(self, identity: dict) -> None:
        """last_used_at in state.json ONLY (never in users.json): this file is
        volatile, the durable files don't churn on every Bearer request."""
        key = identity.get("api_token_hash") or identity.get("email") or ""
        if not key:
            return
        with self._locks[self.STATE_FILE]:
            state = self._load(self.STATE_FILE, dict)
            state = dict(state)
            state[key] = int(time.time())
            self._write(self.STATE_FILE, state)

    # ── TOTP anti-replay (last accepted step per account) ─────────────────────
    # Stored in state.json (volatile) under "totp_step:<email>", namespaced so it
    # never collides with last_used_at. Best-effort: a read/write hiccup must NOT
    # block a legitimate login (the replay check is defense-in-depth).

    def get_last_totp_step(self, email: str) -> int:
        if not email:
            return 0
        try:
            with self._locks[self.STATE_FILE]:
                state = self._load(self.STATE_FILE, dict)
            return int(state.get("totp_step:" + email, 0))
        except Exception:
            return 0

    def set_last_totp_step(self, email: str, step: int) -> None:
        if not email:
            return
        try:
            with self._locks[self.STATE_FILE]:
                state = dict(self._load(self.STATE_FILE, dict))
                state["totp_step:" + email] = int(step)
                self._write(self.STATE_FILE, state)
        except Exception:
            pass

    def upsert_user(self, email: str, fields: dict) -> None:
        with self._locks[self.USERS_FILE]:
            users = [dict(u) for u in self._load(self.USERS_FILE)]
            for user in users:
                if user.get("email") == email:
                    user.update(dict(fields))
                    user["email"] = email
                    break
            else:
                users.append({"email": email, **dict(fields)})
            self._write(self.USERS_FILE, users)

    def accept_invite(self, token_sha256: str, password_hash: str):
        """ATOMICALLY redeem an invite: under the USERS_FILE lock, match the
        PENDING account by invite-token hash, refuse if it has expired, set the
        real password + bump the session epoch, and CLEAR the invite fields
        (single-use). Returns {email, role} on success, None otherwise (unknown /
        expired / already redeemed — the SAME None, no oracle). A concurrent
        redeem of the same token loses: the second pass finds no invite_token_hash."""
        if not token_sha256 or not password_hash:
            return None
        now = int(time.time())
        with self._locks[self.USERS_FILE]:
            users = [dict(u) for u in self._load(self.USERS_FILE)]
            for user in users:
                stored = user.get("invite_token_hash") or ""
                if not stored or not hmac.compare_digest(stored, token_sha256):
                    continue
                if int(user.get("invite_expires_at") or 0) < now:
                    return None  # expired (left in place; admin re-invites or deletes)
                user["password_hash"] = password_hash
                user["session_epoch"] = int(user.get("session_epoch") or 0) + 1
                for key in ("invite_token_hash", "invite_created_at",
                            "invite_expires_at"):
                    user.pop(key, None)
                self._write(self.USERS_FILE, users)
                return {"email": user.get("email"), "role": user.get("role")}
        return None

    def consume_recovery_hash(self, email: str, target_hash: str) -> bool:
        """ATOMICALLY remove a single-use recovery-code hash.

        Read/check/remove/write in a SINGLE critical section under USERS_FILE: no
        read-then-write window where two concurrent logins presenting the SAME
        code consume it twice. Returns True only if the hash was present AND
        removed (constant-time comparison)."""
        if not target_hash:
            return False
        with self._locks[self.USERS_FILE]:
            users = [dict(u) for u in self._load(self.USERS_FILE)]
            target = next((u for u in users if u.get("email") == email), None)
            if target is None:
                return False
            stored = list(target.get("totp_recovery_hashes") or [])
            matched_index = -1
            for index, candidate in enumerate(stored):
                if hmac.compare_digest(candidate, target_hash):
                    matched_index = index
            if matched_index < 0:
                return False
            target["totp_recovery_hashes"] = [
                h for i, h in enumerate(stored) if i != matched_index]
            self._write(self.USERS_FILE, users)
            return True

    def list_users(self) -> list:
        """Copies of all user records (CLI: `atlas user list`,
        `atlas token list`). Never exposed by the HTTP server."""
        with self._locks[self.USERS_FILE]:
            return [dict(u) for u in self._load(self.USERS_FILE)]

    def delete_user(self, email: str, *, protect_last_admin: bool = False) -> bool:
        """Delete the account `email`. Returns False if it doesn't exist.

        protect_last_admin: if True, the admin count AND the deletion run under the
        SAME USERS_FILE lock, so the anti-lockout guard is atomic (concurrent
        DELETEs on the last two admins can't both drop to zero). Raises
        LastAdminError if the deletion would remove the last admin. The CLI leaves
        this False (deliberate local recovery path)."""
        with self._locks[self.USERS_FILE]:
            users = [dict(u) for u in self._load(self.USERS_FILE)]
            target = next((u for u in users if u.get("email") == email), None)
            if target is None:
                return False
            if protect_last_admin and target.get("role") == "admin":
                admin_count = sum(1 for u in users if u.get("role") == "admin")
                if admin_count <= 1:
                    raise LastAdminError("cannot delete the last admin")
            kept = [u for u in users if u.get("email") != email]
            self._write(self.USERS_FILE, kept)
            return True

    # ── administration (cloud mode) ───────────────────────────────────────────

    def has_admin(self) -> bool:
        with self._locks[self.USERS_FILE]:
            return any(u.get("role") == "admin"
                       for u in self._load(self.USERS_FILE))

    def count_admins(self) -> int:
        with self._locks[self.USERS_FILE]:
            return sum(1 for u in self._load(self.USERS_FILE)
                       if u.get("role") == "admin")

    def list_admin_facing_users(self) -> list:
        """{email, role, hidden_folders, pending, invite_expires_at} of human
        accounts (admin/viewer), NEVER a hash. `pending` = invited but hasn't set
        a password yet. 'api' accounts are listed separately by
        list_api_identities."""
        with self._locks[self.USERS_FILE]:
            return [{"email": u.get("email"), "role": u.get("role"),
                     "hidden_folders": u.get("hidden_folders") or [],
                     "pending": bool(u.get("invite_token_hash")),
                     "invite_expires_at": u.get("invite_expires_at")}
                    for u in self._load(self.USERS_FILE)
                    if u.get("role") != API_ROLE]

    def list_api_identities(self) -> list:
        """'api' identities WITHOUT token or hash. last_used_at comes from
        state.json (volatile) since touch_last_used never writes users.json."""
        with self._locks[self.STATE_FILE]:
            state = dict(self._load(self.STATE_FILE, dict))
        with self._locks[self.USERS_FILE]:
            users = [dict(u) for u in self._load(self.USERS_FILE)
                     if u.get("role") == API_ROLE]
        identities = []
        for user in users:
            meta = _public_api_identity(user)
            key = user.get("api_token_hash") or user.get("email") or ""
            if key in state:
                meta["last_used_at"] = state[key]
            identities.append(meta)
        return identities

    def create_api_identity(self, label: str) -> tuple:
        """Create (or regenerate) the label's 'api' account, returns (meta, token).

        The cleartext is returned only HERE, once; only its SHA256 is stored.
        Critical section under the USERS_FILE lock: no TOCTOU between the
        existence check and the write."""
        email = token_email(label)
        with self._locks[self.USERS_FILE]:
            users = [dict(u) for u in self._load(self.USERS_FILE)]
            existing = next((u for u in users if u.get("email") == email), None)
            if existing is not None and existing.get("role") != API_ROLE:
                raise ValueError(
                    f"{email} is already taken by a "
                    f"{existing.get('role')!r} account")
            token, fields = new_api_token_fields(
                label, set_unusable_password=existing is None)
            if existing is not None:
                existing.update(fields)
                existing["email"] = email
            else:
                users.append({"email": email, **fields})
            self._write(self.USERS_FILE, users)
        meta = _public_api_identity({"email": email, **fields})
        return meta, token

    def revoke_api_identity(self, id_or_email: str) -> bool:
        """Cut the token (api_token_hash → None). Accepts the identity email
        or the label. Returns False if not found or already revoked."""
        email = id_or_email
        if "@" not in (id_or_email or ""):
            try:
                email = token_email(id_or_email)
            except ValueError:
                return False
        with self._locks[self.USERS_FILE]:
            users = [dict(u) for u in self._load(self.USERS_FILE)]
            for user in users:
                if user.get("email") != email or user.get("role") != API_ROLE:
                    continue
                if not user.get("api_token_hash"):
                    return False  # already revoked
                user["api_token_hash"] = None
                user["api_token_revoked_at"] = int(time.time())
                self._write(self.USERS_FILE, users)
                return True
        return False

    # ── shares ───────────────────────────────────────────────────────────────

    def insert_share(self, share: dict) -> str:
        record = dict(share)
        # The cleartext token is KEPT (capability URL, re-copyable by the admin);
        # token_sha256 is the constant-time lookup index used on each share hit.
        token = record.get("token")
        record["token_sha256"] = hash_share_token(token or "")
        record["id"] = str(uuid.uuid4())
        with self._locks[self.SHARES_FILE]:
            shares = [dict(s) for s in self._load(self.SHARES_FILE)]
            shares.append(record)
            self._write(self.SHARES_FILE, shares)
        return record["id"]

    def find_share_by_token(self, token: str):
        token_sha256 = hash_share_token(token or "")
        with self._locks[self.SHARES_FILE]:
            for share in self._load(self.SHARES_FILE):
                stored = share.get("token_sha256") or ""
                if stored and hmac.compare_digest(stored, token_sha256):
                    return dict(share)
        return None

    def list_shares(self, path=None, include_revoked: bool = False,
                    limit: int = 200) -> list:
        with self._locks[self.SHARES_FILE]:
            shares = [dict(s) for s in self._load(self.SHARES_FILE)]
        if path:
            shares = [s for s in shares if s.get("path") == path]
        if not include_revoked:
            shares = [s for s in shares if not s.get("revoked", False)]
        shares.sort(key=lambda s: -(s.get("created_at") or 0))
        # The cleartext token is returned so the admin UI shows a copyable link.
        return [_normalize_share(s) for s in shares[:limit]]

    def revoke_share(self, share_id: str) -> bool:
        # Plain equality on the id field: accepts native uuid4s as well as the
        # legacy 24-hex ids.
        with self._locks[self.SHARES_FILE]:
            shares = [dict(s) for s in self._load(self.SHARES_FILE)]
            for share in shares:
                if share.get("id") != share_id:
                    continue
                if share.get("revoked", False):
                    return False  # already revoked → same 404 as before
                share["revoked"] = True
                share["revoked_at"] = int(time.time())
                self._write(self.SHARES_FILE, shares)
                return True
        return False

    def repoint_share(self, share_id: str, new_path: str) -> bool:
        """Point an existing, non-revoked share at a new target path (reactivate a
        link whose document was moved/renamed). The token is unchanged — only the
        stored target moves — so the public link keeps working. Returns False if no
        active share matches the id."""
        with self._locks[self.SHARES_FILE]:
            shares = [dict(s) for s in self._load(self.SHARES_FILE)]
            for share in shares:
                if share.get("id") != share_id or share.get("revoked", False):
                    continue
                share["path"] = new_path
                self._write(self.SHARES_FILE, shares)
                return True
        return False

    def _repoint_shares(self, matches, rewrite) -> int:
        """Re-point every active share whose path `matches(path)`, rewriting it via
        `rewrite(path)`. Returns the count updated (single atomic write). Shared by
        the file-move and folder-move repointers below."""
        count = 0
        with self._locks[self.SHARES_FILE]:
            shares = [dict(s) for s in self._load(self.SHARES_FILE)]
            for share in shares:
                path = share.get("path") or ""
                if share.get("revoked", False) or not matches(path):
                    continue
                share["path"] = rewrite(path)
                count += 1
            if count:
                self._write(self.SHARES_FILE, shares)
        return count

    def repoint_shares_by_path(self, old_path: str, new_path: str) -> int:
        """Re-point active shares targeting exactly `old_path` to `new_path` (called
        when a document is moved/renamed in-app, so its links never break)."""
        return self._repoint_shares(lambda p: p == old_path, lambda p: new_path)

    def repoint_shares_under(self, old_dir: str, new_dir: str) -> int:
        """Re-point active shares under a moved folder: a target `old_dir/<rest>`
        becomes `new_dir/<rest>` (called when a folder is renamed in-app)."""
        old_prefix = old_dir.rstrip("/") + "/"
        new_prefix = new_dir.rstrip("/") + "/"
        return self._repoint_shares(
            lambda p: p.startswith(old_prefix),
            lambda p: new_prefix + p[len(old_prefix):])

    # ── per-document ACL + groups (model B — partage à la Notion) ─────────────
    # acl.json is a DICT keyed by content-relative path (file OR folder, the
    # folder without extension). Value = {owner, grants:[{principal, level, at,
    # expires_at?}]}. Same lock/atomic-write/fail-CLOSED machinery as the rest:
    # a corrupted acl.json raises (server maps it to 503), never reads as empty.

    def get_acl(self, path: str):
        """ACL entry {owner?, grants[]} for an exact path key, or None (copy)."""
        with self._locks[self.ACL_FILE]:
            entry = self._load(self.ACL_FILE, dict).get(path)
            return dict(entry) if entry else None

    def set_owner(self, path: str, principal: str) -> None:
        """Set/replace the owner of `path` (creates the entry, keeps grants)."""
        with self._locks[self.ACL_FILE]:
            acl = dict(self._load(self.ACL_FILE, dict))
            entry = dict(acl.get(path) or {})
            entry["owner"] = principal
            entry.setdefault("grants", [])
            acl[path] = entry
            self._write(self.ACL_FILE, acl)

    def grant(self, path: str, principal: str, level: str, *,
              expires_at: int = 0) -> None:
        """Grant (or upgrade) `principal` to `level` on `path`. One grant per
        principal: an existing grant for the same principal is replaced."""
        with self._locks[self.ACL_FILE]:
            acl = dict(self._load(self.ACL_FILE, dict))
            entry = dict(acl.get(path) or {})
            grants = [dict(g) for g in entry.get("grants", [])
                      if g.get("principal") != principal]
            record = {"principal": principal, "level": level, "at": int(time.time())}
            if expires_at:
                record["expires_at"] = int(expires_at)
            grants.append(record)
            entry["grants"] = grants
            acl[path] = entry
            self._write(self.ACL_FILE, acl)

    def revoke_grant(self, path: str, principal: str) -> bool:
        """Remove `principal`'s grant on `path`. False if there was none."""
        with self._locks[self.ACL_FILE]:
            acl = dict(self._load(self.ACL_FILE, dict))
            entry = acl.get(path)
            if not entry:
                return False
            entry = dict(entry)
            before = entry.get("grants", [])
            after = [g for g in before if g.get("principal") != principal]
            if len(after) == len(before):
                return False
            entry["grants"] = after
            acl[path] = entry
            self._write(self.ACL_FILE, acl)
            return True

    def list_grants(self, path: str) -> list:
        """The grants list of `path` ([] if no entry)."""
        with self._locks[self.ACL_FILE]:
            entry = self._load(self.ACL_FILE, dict).get(path) or {}
            return [dict(g) for g in entry.get("grants", [])]

    def delete_acl(self, path: str) -> bool:
        """Drop the whole ACL entry of `path`. False if there was none."""
        with self._locks[self.ACL_FILE]:
            acl = dict(self._load(self.ACL_FILE, dict))
            if path not in acl:
                return False
            del acl[path]
            self._write(self.ACL_FILE, acl)
            return True

    def set_creator(self, path: str, principal: str) -> None:
        """Stamp who created `path` (distinct from `owner`, set once at creation).
        A commons doc keeps NO owner but remembers its creator, so on the commons
        the creator — not the admin — manages its sharing. Idempotent: never
        overwrites an existing creator (survives edits/moves)."""
        with self._locks[self.ACL_FILE]:
            acl = dict(self._load(self.ACL_FILE, dict))
            entry = dict(acl.get(path) or {})
            if entry.get("creator"):
                return
            entry["creator"] = principal
            entry.setdefault("grants", [])
            acl[path] = entry
            self._write(self.ACL_FILE, acl)

    def make_commons(self, path: str) -> None:
        """Return `path` to the commons: drop `owner` and all grants, but KEEP the
        `creator` (so its creator keeps managing it). Drops the entry entirely only
        when there was no creator to remember."""
        with self._locks[self.ACL_FILE]:
            acl = dict(self._load(self.ACL_FILE, dict))
            entry = acl.get(path)
            if not entry:
                return
            creator = entry.get("creator")
            acl[path] = {"creator": creator, "grants": []} if creator else None
            if acl[path] is None:
                del acl[path]
            self._write(self.ACL_FILE, acl)

    def repoint_acl_by_path(self, old_path: str, new_path: str) -> bool:
        """Move a doc's ACL entry when it is renamed/moved in-app, so its sharing
        travels with it (mirror of repoint_shares_by_path). False if no entry."""
        with self._locks[self.ACL_FILE]:
            acl = dict(self._load(self.ACL_FILE, dict))
            if old_path not in acl:
                return False
            acl[new_path] = acl.pop(old_path)
            self._write(self.ACL_FILE, acl)
            return True

    def repoint_acl_under(self, old_dir: str, new_dir: str) -> int:
        """Move every ACL entry under a renamed folder (the folder key itself +
        each descendant). Returns the count moved (single atomic write)."""
        old = old_dir.strip("/")
        new = new_dir.strip("/")
        old_prefix = old + "/"
        new_prefix = new + "/"
        with self._locks[self.ACL_FILE]:
            acl = dict(self._load(self.ACL_FILE, dict))
            moved = {}
            for path in list(acl):
                if path == old:
                    moved[new] = acl.pop(path)
                elif path.startswith(old_prefix):
                    moved[new_prefix + path[len(old_prefix):]] = acl.pop(path)
            if moved:
                acl.update(moved)
                self._write(self.ACL_FILE, acl)
            return len(moved)

    # groups.json: {name: [emails]} — a principal `group:<name>` resolves to its
    # member emails at evaluation time (a user inherits all its groups' grants).

    def groups_for_email(self, email: str) -> list:
        """Names of the groups `email` belongs to ([] if none)."""
        if not email:
            return []
        with self._locks[self.GROUPS_FILE]:
            groups = self._load(self.GROUPS_FILE, dict)
            return [name for name, members in groups.items()
                    if isinstance(members, list) and email in members]

    def set_group(self, name: str, emails) -> None:
        """Create/replace a group's membership (deduped, order kept)."""
        with self._locks[self.GROUPS_FILE]:
            groups = dict(self._load(self.GROUPS_FILE, dict))
            groups[name] = list(dict.fromkeys(e for e in emails if e))
            self._write(self.GROUPS_FILE, groups)

    def get_group(self, name: str):
        with self._locks[self.GROUPS_FILE]:
            members = self._load(self.GROUPS_FILE, dict).get(name)
            return list(members) if isinstance(members, list) else None

    def list_groups(self) -> dict:
        with self._locks[self.GROUPS_FILE]:
            return {name: list(members)
                    for name, members in self._load(self.GROUPS_FILE, dict).items()
                    if isinstance(members, list)}

    def delete_group(self, name: str) -> bool:
        with self._locks[self.GROUPS_FILE]:
            groups = dict(self._load(self.GROUPS_FILE, dict))
            if name not in groups:
                return False
            del groups[name]
            self._write(self.GROUPS_FILE, groups)
            return True

    # ── per-member todos (private, not git) ─────────────────────────────
    # todos.json is a DICT keyed by account email; each value is that member's
    # list of {text, done, cat}. Same lock/atomic-write/fail-CLOSED machinery.

    def load_user_todos(self, email: str):
        """The member's todo list (copy), or None if they have no entry yet (lets
        the caller distinguish "never had todos" from "cleared their list")."""
        with self._locks[self.TODOS_FILE]:
            data = self._load(self.TODOS_FILE, dict)
            return [dict(t) for t in data[email]] if email in data else None

    def save_user_todos(self, email: str, items) -> None:
        """Replace the member's whole todo list (private to that account)."""
        with self._locks[self.TODOS_FILE]:
            data = dict(self._load(self.TODOS_FILE, dict))
            data[email] = [dict(t) for t in items]
            self._write(self.TODOS_FILE, data)

    # ── Atlas nodes (hive, #10) ─────────────────────────────────────────
    def create_node(self, name: str, path: str, token: str) -> dict:
        """Publish a node: the folder/file `path` (relative to content/) becomes
        readable read-only via `token` (stored as SHA256). Upsert by name:
        re-publishing an existing name regenerates the token (revokes the old one)."""
        record = {"name": name, "path": path.strip("/"),
                  "token_sha256": hash_api_token(token),
                  "created_at": int(time.time()), "revoked": False}
        with self._locks[self.NODES_FILE]:
            nodes = [dict(n) for n in self._load(self.NODES_FILE)
                     if n.get("name") != name]
            nodes.append(record)
            self._write(self.NODES_FILE, nodes)
        return {"name": name, "path": record["path"]}

    def list_nodes(self) -> list:
        with self._locks[self.NODES_FILE]:
            return [{"name": n.get("name"), "path": n.get("path"),
                     "created_at": n.get("created_at", 0),
                     "revoked": n.get("revoked", False)}
                    for n in self._load(self.NODES_FILE)]

    def find_node_by_token(self, token: str):
        """Node {name, path} matching the token (not revoked), or None."""
        token_sha256 = hash_api_token(token)
        with self._locks[self.NODES_FILE]:
            for n in self._load(self.NODES_FILE):
                if n.get("revoked"):
                    continue
                if hmac.compare_digest(n.get("token_sha256", ""), token_sha256):
                    return {"name": n.get("name"), "path": n.get("path", "")}
        return None

    def revoke_node(self, name: str) -> bool:
        with self._locks[self.NODES_FILE]:
            nodes = [dict(n) for n in self._load(self.NODES_FILE)]
            for n in nodes:
                if n.get("name") == name and not n.get("revoked"):
                    n["revoked"] = True
                    n["revoked_at"] = int(time.time())
                    self._write(self.NODES_FILE, nodes)
                    return True
        return False

    # ── Subscriptions to remote nodes (hive, #10 Phase B) ───────────────
    def add_remote(self, record: dict) -> dict:
        """Register a subscription to a remote node (upsert by local name).

        The token is stored IN CLEARTEXT: we're the client, it must be sent back to
        the issuer on every sync (.atlas is gitignored → secret at rest)."""
        name = record["name"]
        clean = {
            "name": name,
            "url": record.get("url", ""),
            "path": record.get("path", ""),
            "token": record.get("token", ""),
            "added_at": int(time.time()),
            "last_sync_at": 0,
            "last_manifest_hash": "",
            "last_error": "",
        }
        with self._locks[self.REMOTES_FILE]:
            remotes = [dict(r) for r in self._load(self.REMOTES_FILE)
                       if r.get("name") != name]
            remotes.append(clean)
            self._write(self.REMOTES_FILE, remotes)
        return _remote_public(clean)

    def list_remotes(self, include_token: bool = False) -> list:
        with self._locks[self.REMOTES_FILE]:
            remotes = [dict(r) for r in self._load(self.REMOTES_FILE)]
        return remotes if include_token else [_remote_public(r) for r in remotes]

    def get_remote(self, name: str):
        with self._locks[self.REMOTES_FILE]:
            for r in self._load(self.REMOTES_FILE):
                if r.get("name") == name:
                    return dict(r)
        return None

    def remove_remote(self, name: str) -> bool:
        with self._locks[self.REMOTES_FILE]:
            remotes = [dict(r) for r in self._load(self.REMOTES_FILE)]
            kept = [r for r in remotes if r.get("name") != name]
            if len(kept) == len(remotes):
                return False
            self._write(self.REMOTES_FILE, kept)
        return True

    def update_remote_status(self, name: str, fields: dict) -> None:
        allowed = ("last_sync_at", "last_manifest_hash", "last_error")
        with self._locks[self.REMOTES_FILE]:
            remotes = [dict(r) for r in self._load(self.REMOTES_FILE)]
            for r in remotes:
                if r.get("name") == name:
                    for key in allowed:
                        if key in fields:
                            r[key] = fields[key]
                    self._write(self.REMOTES_FILE, remotes)
                    return
