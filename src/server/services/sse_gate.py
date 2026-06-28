"""Bounded ceiling on simultaneously-open Server-Sent-Events streams (DoS guard).

ThreadingHTTPServer gives every connection its own OS thread with NO cap, and an SSE
stream holds that thread for the entire life of the client. Without a ceiling, a peer
(or attacker) opening many never-closing SSE connections pins one thread each →
unbounded thread/memory growth = denial of service. This gate caps the number of SSE
streams open at once ACROSS every SSE endpoint (the /api/events live-reload stream and
the /mcp/<token> discovery stream); once the cap is reached a new stream is refused
with 503 instead of pinning another thread.

Backed by a stdlib threading.BoundedSemaphore: try_acquire() is atomic and never
blocks, and release() — being *bounded* — raises if ever called more often than it was
acquired, surfacing a missing/extra release as a loud bug rather than silently
inflating the cap. The cap is process-wide and deliberately generous, so normal use is
never affected (see MAX_SSE_CONNECTIONS).
"""
import threading


class SSEGate:
    """Thread-safe, non-blocking slot counter for concurrent SSE streams."""

    def __init__(self, limit: int):
        self._semaphore = threading.BoundedSemaphore(limit)

    def try_acquire(self) -> bool:
        """Claim one slot without blocking. True → the caller owns a slot and MUST
        release() it when the stream ends (in a try/finally). False → the cap is
        already reached; the caller must refuse the stream (503) and NOT release()."""
        return self._semaphore.acquire(blocking=False)

    def release(self) -> None:
        """Return a slot taken by a successful try_acquire(). Call exactly once per
        successful claim (the try/finally around the stream loop guarantees this)."""
        self._semaphore.release()


# Generous GLOBAL ceiling on simultaneously-open SSE streams. Ordinary use stays far
# below it: a handful of browser tabs' live-reload streams + Claude.ai's MCP discovery
# stream + the 1-2 streams the tests/goldens open. It bites ONLY a held-open flood.
MAX_SSE_CONNECTIONS = 64

# Process-wide singleton shared by every SSE route.
SSE_GATE = SSEGate(MAX_SSE_CONNECTIONS)
