"""Per-account login lockout (fail2ban-friendly).

LockoutTracker tracks failed logins per email in auth_state.json under the store
dir (NEVER committed — a .gitignore "*" backstop is dropped next to it). After
LOCKOUT_THRESHOLD failures the account is locked with a bounded exponential
backoff (60 s, 120 s, 240 s… capped at 1 h). Only failures on an EXISTING account
are counted (an unknown email accumulates nothing — no state.json swelling under
an enumeration attack, and an attacker cannot lock an arbitrary missing email).
Each failure also emits a structured stderr line parseable by fail2ban. Built once
by AppContext (needs config for the store dir + store for the account guard).
"""
import json
import os
import sys
import tempfile
import threading
import time

LOCKOUT_THRESHOLD = 5          # failures before the first lock
LOCKOUT_BASE_SECONDS = 60      # duration of the 1st lock
LOCKOUT_MAX_SECONDS = 3600     # backoff cap
_AUTH_STATE_FILE = "auth_state.json"


def _lock_duration(fail_count: int) -> int:
    """Bounded exponential backoff: 60 s, 120 s, 240 s… capped at 1 h."""
    over = max(0, fail_count - LOCKOUT_THRESHOLD)
    return min(LOCKOUT_MAX_SECONDS, LOCKOUT_BASE_SECONDS * (2 ** over))


class LockoutTracker:
    """Per-email failure counters + lock windows. All read-modify-writes of
    auth_state.json happen under a single lock so concurrent failures on the same
    account serialise. The file lives under the store dir, never committed."""

    def __init__(self, *, config, store):
        self._config = config
        self._store = store
        self._lock = threading.Lock()

    def _state_path(self):
        return self._config.store_dir / _AUTH_STATE_FILE

    def _load_state(self) -> dict:
        try:
            return json.loads(self._state_path().read_text(encoding="utf-8"))
        except (FileNotFoundError, ValueError, OSError):
            return {}

    @staticmethod
    def _ensure_gitignored(directory) -> None:
        """Drops a .gitignore "*" in the registry directory if it does not exist.

        store_dir lives by default under ROOT/.atlas, INSIDE the content repo:
        auth_state.json must never be committed. FileStore already writes this
        .gitignore; this is a backstop covering the lockout file. Best-effort."""
        try:
            directory.mkdir(parents=True, exist_ok=True)
            if (directory / ".git").exists():
                return  # don't hide an entire misconfigured repo
            gitignore = directory / ".gitignore"
            if not gitignore.exists():
                gitignore.write_text("*\n", encoding="utf-8")
        except OSError:
            pass

    def _write_state(self, state: dict) -> None:
        path = self._state_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        self._ensure_gitignored(path.parent)
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

    def lock_remaining(self, email: str) -> int:
        """Remaining lock seconds for this account (0 if not locked)."""
        if not email:
            return 0
        with self._lock:
            entry = self._load_state().get(email.lower())
        if not entry:
            return 0
        remaining = int(entry.get("locked_until", 0)) - int(time.time())
        return remaining if remaining > 0 else 0

    def register_failure(self, email: str, ip: str) -> None:
        """Increments the account's failure counter and sets a lock beyond the
        threshold. fail2ban-friendly log on stderr (never a secret or a password).

        Counts ONLY failures on an EXISTING account: an unknown email accumulates
        nothing (no state.json swelling under an enumeration attack, and an
        attacker cannot lock an arbitrary email that does not exist). The per-IP
        rate-limit, for its part, already caps attempts on unknown emails."""
        if not email:
            return
        key = email.lower()
        try:
            if self._store.get_user_by_email(key) is None:
                return
        except Exception:
            # Registry unreachable: we still log the attempt for fail2ban, but we
            # don't write a counter (we don't know whether the account exists).
            sys.stderr.write(f"auth fail email={key} ip={ip} count=?\n")
            sys.stderr.flush()
            return
        with self._lock:
            state = self._load_state()
            entry = state.get(key, {"fail_count": 0, "locked_until": 0})
            entry["fail_count"] = int(entry.get("fail_count", 0)) + 1
            if entry["fail_count"] >= LOCKOUT_THRESHOLD:
                entry["locked_until"] = int(time.time()) + _lock_duration(
                    entry["fail_count"])
            state[key] = entry
            try:
                self._write_state(state)
            except OSError as error:
                print(f"[auth] lockout state write failed: {error}", file=sys.stderr)
            count = entry["fail_count"]
        # Structured line parseable by fail2ban (regex on email/ip/count).
        sys.stderr.write(f"auth fail email={key} ip={ip} count={count}\n")
        sys.stderr.flush()

    def reset_failures(self, email: str) -> None:
        """Clears the account's failure counter (called on the first successful
        login)."""
        if not email:
            return
        key = email.lower()
        with self._lock:
            state = self._load_state()
            if key in state:
                state.pop(key, None)
                try:
                    self._write_state(state)
                except OSError as error:
                    print(f"[auth] lockout reset write failed: {error}",
                          file=sys.stderr)
