"""Hive node publishing/subscription helpers: node links, path resolution, the
read-only remote mirror, and the hardened HTTP fetch for syncing remotes."""
import base64
import json
import os
import sys
import tempfile

import server as _s


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
        return _s.get_store().find_node_by_token(token)
    except Exception as e:
        print(f"[verify_node_bearer] lookup failed: {e}", file=sys.stderr)
        return None


def encode_node_link(origin: str, name: str, path: str, token: str) -> str:
    """Copyable link the recipient pastes to subscribe to a node.

    Opaque but self-contained: origin + token + name + path, as the base64url of
    a JSON. The subscriber side (Phase B) decodes it to bootstrap the mirror."""
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
    blob += "=" * (-len(blob) % 4)  # re-add the stripped base64url padding
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

    A node can point to a whole folder or a single document: in both cases the
    path must stay under content_root and must exist."""
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

    Folder → all docs in the subtree, rebased on the node's root. Single file →
    a single (file_name, Path) pair."""
    node_path = node_path.strip("/")
    prefix = node_path + "/"
    for rel, path in _s._iter_doc_files():
        if rel == node_path:              # node = single document
            yield path.name, path
        elif rel.startswith(prefix):      # node = folder
            yield rel[len(prefix):], path


# ─── Subscriptions: read-only mirror of remote nodes (hive, #10 B) ───────

def _remote_mirror_root(name: str):
    return _s.CONFIG.content_root / _s.REMOTES_DIR / name


def _is_readonly_path(rel: str) -> bool:
    """A path under remotes/ is a remote mirror: read-only on the local side
    (any edit/delete/move is refused — the truth lives at the publisher, we
    resync on top of it)."""
    parts = (rel or "").strip("/").split("/")
    return len(parts) >= 1 and parts[0] == _s.REMOTES_DIR


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
    if getattr(_s.CONFIG, "allow_private_remotes", False):
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
        data = resp.read(_s.MAX_NODE_FILE_BYTES + 1)
    if len(data) > _s.MAX_NODE_FILE_BYTES:
        raise ValueError("remote response exceeds size limit")
    return data


def _prune_empty_dirs(root) -> None:
    if not root.exists():
        return
    for path in sorted(root.rglob("*"), key=lambda p: len(p.parts), reverse=True):
        if path.is_dir() and not any(path.iterdir()):
            path.rmdir()
