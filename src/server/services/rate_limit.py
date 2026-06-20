"""Login + API rate limiting.

RateLimiter holds the per-key sliding-window state (+ its locks), built once by
AppContext. `_evict_stale_buckets` is the shared bounded-growth sweep and part of
the WHITE-BOX test contract (tests/test_admin.py) — kept importable as
server._evict_stale_buckets (re-export in server/__init__.py).
"""
import threading
import time

# Per-minute caps (RateLimiter defaults).
LOGIN_RATE_LIMIT_PER_MIN = 10    # login attempts per client IP
API_RATE_LIMIT_PER_MIN = 120     # requests per API token
# Soft cap on each in-memory limiter dict: past this, fully-expired keys are
# swept. Without it, rotating source IPs (or IPv6 churn behind a proxy) / churned
# API tokens grow the dicts unbounded — a slow memory-exhaustion vector on a
# long-running instance.
_RATE_BUCKET_CAP = 4096


def _evict_stale_buckets(buckets: dict, cutoff: float) -> None:
    """Drop limiter keys whose timestamps are all older than `cutoff` (empty or
    fully expired). The most-recent timestamp is the last appended, so a single
    `ts[-1] <= cutoff` check identifies a key with nothing left in its window."""
    for key in [k for k, ts in buckets.items() if not ts or ts[-1] <= cutoff]:
        del buckets[key]


class RateLimiter:
    """Per-key 60-second sliding-window limiter for login (by IP) and API (by
    token hash). Each window has its own lock; stale keys are swept once a dict
    grows past the cap (bounded memory)."""

    def __init__(self, *, login_limit=LOGIN_RATE_LIMIT_PER_MIN,
                 api_limit=API_RATE_LIMIT_PER_MIN, cap=_RATE_BUCKET_CAP):
        self._login_limit = login_limit
        self._api_limit = api_limit
        self._cap = cap
        self._login_buckets: dict[str, list[float]] = {}
        self._login_lock = threading.Lock()
        self._api_buckets: dict[str, list[float]] = {}
        self._api_lock = threading.Lock()

    def login_allowed(self, ip: str) -> bool:
        return self._allowed(self._login_buckets, self._login_lock, self._login_limit, ip)

    def api_allowed(self, token_hash: str) -> bool:
        return self._allowed(self._api_buckets, self._api_lock, self._api_limit, token_hash)

    def _allowed(self, buckets: dict, lock: "threading.Lock", limit: int, key: str) -> bool:
        now = time.time()
        cutoff = now - 60
        with lock:
            if len(buckets) > self._cap:
                _evict_stale_buckets(buckets, cutoff)
            bucket = buckets.setdefault(key, [])
            bucket[:] = [t for t in bucket if t > cutoff]
            if len(bucket) >= limit:
                return False
            bucket.append(now)
            return True
