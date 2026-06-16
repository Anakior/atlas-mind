"""PyPI update check.

UpdateChecker holds the cached "is there a newer release?" check (URL + cache +
lock), built once by AppContext. The version-comparison helpers below are pure.
`_is_newer` is part of the WHITE-BOX test contract (tests/test_admin.py) and must
stay importable as server._is_newer — see the re-export in server/__init__.py.
`_version_tuple` is co-located because `_is_newer` depends on it.
"""
import json
import re
import sys
import threading
import time
import urllib.request

PYPI_JSON_URL = "https://pypi.org/pypi/atlas-mind/json"
_UPDATE_CACHE_TTL = 86400  # 1 day


def _version_tuple(value):
    """Best-effort numeric tuple for comparison ("0.1.10" -> (0, 1, 10)). Returns
    None if the string has no leading numeric component."""
    parts = re.findall(r"\d+", value or "")
    return tuple(int(p) for p in parts) if parts else None


def _is_newer(latest, current) -> bool:
    lt, ct = _version_tuple(latest), _version_tuple(current)
    if lt is None or ct is None:
        return False
    return lt > ct


class UpdateChecker:
    """Cached PyPI release check. Best-effort: any failure (offline, timeout,
    parse error) returns None and is cached briefly so a flaky network does not
    hammer PyPI on every Settings open."""

    def __init__(self, *, ttl=_UPDATE_CACHE_TTL, pypi_url=PYPI_JSON_URL):
        self._ttl = ttl
        self._pypi_url = pypi_url
        self._lock = threading.Lock()
        self._cache = {"checked_at": 0, "latest": None}

    def latest(self):
        now = int(time.time())
        with self._lock:
            if self._cache["latest"] is not None and \
                    now - self._cache["checked_at"] < self._ttl:
                return self._cache["latest"]
            fresh = now - self._cache["checked_at"] < 3600  # back off after a failure
            if self._cache["latest"] is None and fresh and self._cache["checked_at"]:
                return None
        latest = None
        try:
            with urllib.request.urlopen(self._pypi_url, timeout=4) as resp:
                data = json.loads(resp.read(1_000_000))
            latest = (data.get("info") or {}).get("version") or None
        except Exception as e:
            print(f"[update-check] PyPI lookup failed: {e}", file=sys.stderr)
        with self._lock:
            self._cache["checked_at"] = now
            if latest is not None:
                self._cache["latest"] = latest
        return latest
