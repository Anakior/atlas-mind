"""A link to one file of the mind that opens without signing in, for an hour: how an AI outside
reads a PDF or a scan (its own web fetch), since its client drops a file carried in a tool
result. Signed with the session secret over the path and the expiry, so it names that file
only, and is only ever handed to someone who could read it."""
import hashlib
import hmac
import time
from urllib.parse import quote, unquote

import server as _s

PREFIX = "/f/"
TTL = 3600


def _sig(rel: str, exp: int) -> str:
    mac = hmac.new(_s.CONFIG.session_secret, f"file:{rel}|{exp}".encode(), hashlib.sha256)
    return mac.hexdigest()[:32]


def make(rel: str, now=None) -> str:
    """The path of a link to `rel` (prefix it with the public URL)."""
    exp = int((now or time.time()) + TTL)
    return f"{PREFIX}{exp}.{_sig(rel, exp)}/{quote(rel)}"


def verify(path: str, now=None):
    """The file `path` (a link made above) opens, or None: a wrong signature or a past expiry."""
    head, _, rel = path.split("?", 1)[0][len(PREFIX):].partition("/")
    exp, _, sig = head.partition(".")
    rel = unquote(rel)
    if not exp.isdigit() or int(exp) < (now or time.time()):
        return None
    return rel if hmac.compare_digest(sig, _sig(rel, int(exp))) else None
