"""First-boot admin-creation window (cloud mode).

maybe_init() generates a one-time token (printed to stderr) when no admin exists;
the window stays open (is_open()) until the first admin is created. consume() does
the LOCKED read-modify-write (has_admin re-check + create + close the window) that
defeats a concurrent double-POST creating a second "first" admin. The token never
leaves stderr.
"""
import secrets
import sys
import threading


class SetupToken:
    def __init__(self, *, config, store):
        self._config = config
        self._store = store
        self._token = None
        self._lock = threading.Lock()

    @property
    def token(self):
        return self._token

    def maybe_init(self) -> None:
        """Generate + print the install token if cloud mode and no admin exists.

        If the registry is unreachable, we do NOT open the window (token stays
        None, is_open() returns False): an unavailable setup beats a window opened
        blindly. The token is printed to stderr — never in an HTTP response."""
        if not self._config.auth_enabled:
            return
        try:
            if self._store.has_admin():
                return
        except Exception as e:
            print(f"[setup] registry unreachable at boot, /setup window not "
                  f"opened: {e}", file=sys.stderr)
            return
        with self._lock:
            if self._token is None:
                self._token = secrets.token_urlsafe(32)
        sys.stderr.write(
            f"\nAtlas setup token: {self._token}\n"
            f"  -> open /setup to create the admin account\n\n")
        sys.stderr.flush()

    def is_open(self) -> bool:
        """Is the first-boot window open? Cloud mode, token present AND still no
        admin. A registry error → False (fail-closed: never open blindly)."""
        if not self._config.auth_enabled or self._token is None:
            return False
        try:
            return not self._store.has_admin()
        except Exception:
            return False

    def consume(self, create_admin) -> bool:
        """Atomically claim the window: under the lock, lose the race (→ False) if
        an admin now exists, else create the admin via create_admin() and close
        the window for good. create_admin() may raise (store error); it propagates
        to the caller (handled there as 503)."""
        with self._lock:
            if self._store.has_admin():
                return False
            create_admin()
            self._token = None
            return True
