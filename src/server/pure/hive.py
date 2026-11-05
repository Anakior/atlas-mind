"""Hive node publishing/subscription helpers: node links, path resolution, the
read-only remote mirror, and the hardened HTTP fetch for syncing remotes."""
import base64
import http.client
import json
import os
import posixpath
import socket
import sys
import tempfile
from urllib.parse import urlsplit

import server as _s


def verify_node_bearer(authorization_header: str):
    """Returns the node dict {'name', 'path'} for a valid node token, or None.

    Counterpart of verify_api_bearer for NODE tokens (hive, #10). A node token opens
    neither the v1 API nor the admin: only the published subtree, read-only."""
    if not authorization_header:
        return None
    parts = authorization_header.strip().split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    token = parts[1]
    if not token:
        return None
    try:
        return _s.get_store().find_node_by_token(token)
    except Exception as e:
        print(f"[verify_node_bearer] lookup failed: {e}", file=sys.stderr)
        return None


def encode_node_link(origin: str, name: str, path: str, token: str) -> str:
    """Copyable link the recipient pastes to subscribe to a node.

    Self-contained: origin + token + name + path, as base64url of a JSON. The
    subscriber side (Phase B) decodes it to bootstrap the mirror."""
    payload = {"url": origin, "name": name, "path": path, "token": token}
    blob = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":")).encode()).decode().rstrip("=")
    return _s.NODE_LINK_PREFIX + blob


def decode_node_link(link: str):
    """Reverse of encode_node_link → {url, name, path, token}, or None if the link
    is malformed or incomplete (essential url/name/token fields missing)."""
    if not link or not link.startswith(_s.NODE_LINK_PREFIX):
        return None
    blob = link[len(_s.NODE_LINK_PREFIX):].strip()
    blob += "=" * (-len(blob) % 4)  # re-add stripped base64url padding
    try:
        data = json.loads(base64.urlsafe_b64decode(blob).decode())
    except Exception:
        return None
    if not isinstance(data, dict) or not data.get("url") or not data.get("name") or not data.get("token"):
        return None
    return {"url": data["url"], "name": data["name"],
            "path": data.get("path", ""), "token": data["token"]}


def _validate_node_path(rel: str):
    """Resolved Path of a publishable node (folder OR .md/.html doc), or None.
    The path must stay under content_root and must exist."""
    if not rel or rel.startswith("/") or ".." in rel.split("/"):
        return None
    content_root = _s.CONFIG.content_root
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
    Folder → subtree rebased on the node root; single file → one (name, Path) pair.
    Only what every account of this mind may read: a member's private doc inside the
    node's folder is never published."""
    node_path = node_path.strip("/")
    prefix = node_path + "/"
    everyone = _s.ViewerCtx({"*"}, False, None)
    for rel, path in _s._iter_doc_files():
        if not _s.can_read(rel, everyone):
            continue
        if rel == node_path:              # node = single document
            yield path.name, path
        elif rel.startswith(prefix):      # node = folder
            yield rel[len(prefix):], path


# ─── Subscriptions: read-only mirror of remote nodes (hive, #10 B) ───────

def _remote_mirror_root(name: str):
    return _s.CONFIG.content_root / _s.REMOTES_DIR / name


def _lexical_rel(rel: str) -> str:
    """`rel` with '\\' read as the separator it is on Windows, and its '.', '..' and doubled
    slashes folded."""
    rel = rel or ""
    if os.name == "nt":
        rel = rel.replace("\\", "/")
    return posixpath.normpath(rel.strip("/"))


def _mind_rel(rel: str) -> str:
    """`rel` as the filesystem reads it: where names ignore case (Windows, macOS), the spelling
    on disk of the folders that exist, short names (REMOTE~1) included, so `Remotes\\x.md`
    names the mirror it opens. Lexical on a case-sensitive filesystem, where another
    spelling is another file."""
    rel = _lexical_rel(rel)
    if not _s._is_fs_case_insensitive():
        return rel
    root = _s.CONFIG.content_root
    try:
        return (root / rel).resolve().relative_to(root).as_posix()
    except (ValueError, OSError):
        return rel


def _top_dir(rel: str) -> str:
    """The top folder of a _lexical_rel or _mind_rel path, to compare with remotes or inbox:
    folded where names ignore case, since macOS does not give back the spelling on disk and
    Windows drops the trailing dots and spaces of a name."""
    top = rel.split("/")[0]
    return top.rstrip(" .").casefold() if _s._is_fs_case_insensitive() else top


def _is_readonly_path(rel: str) -> bool:
    """A path under remotes/ is a remote mirror: read-only on the local side
    (any edit/delete/move is refused — the truth lives at the publisher, we
    resync on top of it)."""
    return _top_dir(_mind_rel(rel)) == _s.REMOTES_DIR


def _is_safe_node_name(name: str) -> bool:
    """A node/remote name becomes a single directory under content/remotes/, so it
    must be a safe single path segment: no separator, no '.'/'..', no control char,
    bounded length. A name like '.' would collapse onto remotes/ itself, letting a
    sync wipe every sibling mirror or a delete rmtree the whole tree."""
    if not name or len(name) > 60:
        return False
    if name in (".", ".."):
        return False
    if "/" in name or "\\" in name or ".." in name:
        return False
    return not _s._has_control_chars(name)


def _mirror_is_under_remotes(mirror) -> bool:
    """Defense in depth: the resolved mirror must be a DIRECT child of
    content/remotes/ (never the remotes/ dir itself, never outside it)."""
    try:
        remotes_root = (_s.CONFIG.content_root / _s.REMOTES_DIR).resolve()
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


def _is_blocked_ip(ip_str: str) -> bool:
    """Anything but a public unicast address: the OAuth metadata fetch's own rule (shared
    100.64/10 and IPv4-mapped forms included)."""
    from server.pure.oauth import _public_address
    try:
        return not _public_address(ip_str)
    except ValueError:
        return True


def _validate_remote_url(url: str):
    """Guards the SSRF surface of node subscriptions (URL comes from a pasted
    atlas-node: link): require http/https and refuse any host resolving to a
    private/loopback/link-local/reserved address. Raises ValueError if disallowed;
    returns the vetted address to connect to (None when private remotes are allowed)."""
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise ValueError(f"unsupported scheme: {parts.scheme!r}")
    host = parts.hostname
    if not host:
        raise ValueError("missing host")
    if getattr(_s.CONFIG, "allow_private_remotes", False):
        return None  # opt-in: localhost/LAN hive — scheme still checked
    try:
        infos = socket.getaddrinfo(
            host, parts.port or (443 if parts.scheme == "https" else 80))
    except socket.gaierror as error:
        raise ValueError(f"cannot resolve host: {error}")
    for info in infos:
        if _is_blocked_ip(info[4][0]):
            raise ValueError("host resolves to a non-routable address")
    return infos[0][4][0]


class _PinnedHTTP(http.client.HTTPConnection):
    """Plain HTTP to `host` over a socket opened to the already-vetted `ip`."""

    def __init__(self, host, ip, port, timeout):
        super().__init__(host, port, timeout=timeout)
        self._ip = ip

    def connect(self):
        self.sock = socket.create_connection((self._ip, self.port), self.timeout)


def _http_get_bearer(url: str, token: str, timeout: float = 15.0) -> bytes:
    """Fetch a remote node URL with the Bearer token. Hardened against the hive SSRF
    surface: scheme/host validated and the connection made to the address that was
    vetted (a second DNS answer can't swap in an internal one), redirects NOT followed
    (one could escape validation into an internal target), response capped at
    MAX_NODE_FILE_BYTES."""
    from server.pure.oauth import _PinnedHTTPS
    parts = urlsplit(url)
    ip = _validate_remote_url(url)
    https = parts.scheme == "https"
    port = parts.port or (443 if https else 80)
    if ip is None:  # a LAN hive, opted in: by name
        conn = (http.client.HTTPSConnection if https else http.client.HTTPConnection)(
            parts.hostname, port, timeout=timeout)
    else:
        conn = (_PinnedHTTPS if https else _PinnedHTTP)(parts.hostname, ip, port, timeout)
    try:
        conn.request("GET", (parts.path or "/") + (f"?{parts.query}" if parts.query else ""),
                     headers={"Authorization": f"Bearer {token}"})
        resp = conn.getresponse()
        data = resp.read(_s.MAX_NODE_FILE_BYTES + 1)
    finally:
        conn.close()
    if resp.status != 200:
        raise ValueError(f"the remote node answered {resp.status}")
    if len(data) > _s.MAX_NODE_FILE_BYTES:
        raise ValueError("remote response exceeds size limit")
    return data


def _prune_empty_dirs(root) -> None:
    if not root.exists():
        return
    for path in sorted(root.rglob("*"), key=lambda p: len(p.parts), reverse=True):
        if path.is_dir() and not any(path.iterdir()):
            path.rmdir()
