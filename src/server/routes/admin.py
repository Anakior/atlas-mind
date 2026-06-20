"""Admin routes: user/token/node/remote administration + update check.

All routes are table-guarded ADMIN (GET) or ADMIN_CSRF (POST/DELETE); the leading
self._require_admin_or_403() / self._check_csrf_or_403() guards have been stripped
from the bodies because the route table now applies them at the verb level.
"""
import sys
import time
import store
from server import _is_newer, PROJECT_URL
import server as _s


def users_get(handler):
    try:
        users = _s.get_store().list_admin_facing_users()
    except Exception as e:
        handler._send_json(503, {"error": "registry unavailable"})
        print(f"[admin] list users: {e}", file=sys.stderr)
        return
    handler._send_json(200, users)


def users_post(handler):
    """POST /api/admin/users {email, role} — create a PENDING account and mint a
    single-use invite link. The admin no longer sets a password: the invitee opens
    the returned invite_url and chooses their OWN password (see routes/invite.py).
    The cleartext invite token is returned only HERE, once. Re-inviting a still
    pending account is allowed (a fresh link; the previous token is invalidated)."""
    data = handler._read_json()
    email = (data.get("email") or "").strip().lower()
    role = (data.get("role") or "viewer").strip().lower()
    if not _s.is_valid_email(email):
        handler._send_json(400, {"error": "invalid email"})
        return
    if role not in ("admin", "viewer"):
        handler._send_json(400, {"error": "role must be 'admin' or 'viewer'"})
        return
    try:
        existing = _s.get_store().get_user_by_email(email)
        # An ACTIVE account (real password) cannot be re-invited; a still-PENDING
        # one is re-invited (the upsert overwrites invite_token_hash → old link dies).
        if existing is not None and not existing.get("invite_token_hash"):
            handler._send_json(409, {"error": "email already taken"})
            return
        token, fields = store.new_invite_fields(role)
        _s.get_store().upsert_user(email, fields)
    except Exception as e:
        print(f"[admin] invite user: {e}", file=sys.stderr)
        handler._send_json(503, {"error": "registry unavailable"})
        return
    # Invite URL derived from the request host (the instance may run behind any
    # domain): https in cloud, http otherwise — mirrors tokens_post / nodes_post.
    host = handler.headers.get("Host", "")
    # https only in REAL cloud; the dev sandbox + local both serve plain http on
    # loopback (an https URL there hits the http server with a TLS handshake → 400).
    scheme = "https" if (_s.CONFIG.auth_enabled and not _s.CONFIG.dev_mode) else "http"
    invite_url = (f"{scheme}://{host}/invite/{token}" if host
                  else f"/invite/{token}")
    handler._send_json(201, {"email": email, "role": role,
                             "invite_url": invite_url})


def users_password(handler):
    data = handler._read_json()
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    if not email:
        handler._send_json(400, {"error": "email required"})
        return
    if len(password) < 8:
        handler._send_json(400, {"error": "password too short (8 chars minimum)"})
        return
    try:
        user = _s.get_store().get_user_by_email(email)
        if (user is None or user.get("role") == _s.API_ROLE
                or user.get("invite_token_hash")):
            # An 'api' account has no usable password; a PENDING invite sets its
            # password via the invite link, not an admin reset. Same 404 (no oracle).
            handler._send_json(404, {"error": "user not found"})
            return
        # Bump the epoch together with the new hash: a password reset invalidates
        # all existing sessions (a stolen cookie becomes unusable).
        # reset_login_failures also unlocks the account (manual admin unlock).
        _s.get_store().upsert_user(email, {
            "password_hash": store.hash_password(password),
            "session_epoch": int(user.get("session_epoch") or 0) + 1,
        })
        _s.reset_login_failures(email)
    except Exception as e:
        print(f"[admin] reset password: {e}", file=sys.stderr)
        handler._send_json(503, {"error": "registry unavailable"})
        return
    handler._send_json(200, {"ok": True, "email": email})


def users_hidden(handler):
    """Viewer ACL (#14): sets the list of hidden folders for an account
    (prefixes relative to content/). Admin only. Empty list = sees
    everything."""
    data = handler._read_json()
    email = (data.get("email") or "").strip().lower()
    folders = data.get("folders")
    if not email:
        handler._send_json(400, {"error": "email required"})
        return
    if not isinstance(folders, list):
        handler._send_json(400, {"error": "folders must be a list"})
        return
    clean = [f.strip().strip("/") for f in folders
             if isinstance(f, str) and f.strip().strip("/")]
    try:
        user = _s.get_store().get_user_by_email(email)
        if user is None or user.get("role") == _s.API_ROLE:
            handler._send_json(404, {"error": "user not found"})
            return
        _s.get_store().upsert_user(email, {"hidden_folders": clean})
    except Exception as e:
        print(f"[admin] set hidden folders: {e}", file=sys.stderr)
        handler._send_json(503, {"error": "registry unavailable"})
        return
    handler._send_json(200, {"ok": True, "email": email, "hidden_folders": clean})


def users_delete(handler):
    data = handler._read_json()
    email = (data.get("email") or "").strip().lower()
    if not email:
        handler._send_json(400, {"error": "email required"})
        return
    try:
        user = _s.get_store().get_user_by_email(email)
        if user is None:
            handler._send_json(404, {"error": "user not found"})
            return
        # Pre-check for a readable 409; the REAL anti-lockout guard is atomic in
        # delete_user (count + deletion under one lock), so two concurrent DELETEs
        # on the last admins can't both fall to zero.
        if user.get("role") == "admin" and _s.get_store().count_admins() <= 1:
            handler._send_json(409, {"error": "cannot delete the last admin"})
            return
        if not _s.get_store().delete_user(email, protect_last_admin=True):
            handler._send_json(404, {"error": "user not found"})
            return
    except store.LastAdminError:
        handler._send_json(409, {"error": "cannot delete the last admin"})
        return
    except Exception as e:
        print(f"[admin] delete user: {e}", file=sys.stderr)
        handler._send_json(503, {"error": "registry unavailable"})
        return
    handler._send_json(200, {"ok": True, "email": email})


def tokens_get(handler):
    try:
        identities = _s.get_store().list_api_identities()
    except Exception as e:
        print(f"[admin] list tokens: {e}", file=sys.stderr)
        handler._send_json(503, {"error": "registry unavailable"})
        return
    handler._send_json(200, identities)


def tokens_post(handler):
    data = handler._read_json()
    label = (data.get("label") or "").strip()
    if not label:
        handler._send_json(400, {"error": "label required"})
        return
    if len(label) > _s.MAX_TOKEN_LABEL_LEN or _s._has_control_chars(label):
        handler._send_json(400, {"error": "invalid label"})
        return
    try:
        store.slugify_token_label(label)  # validate BEFORE touching the store
    except ValueError:
        handler._send_json(400, {"error": "invalid label"})
        return
    try:
        meta, token = _s.get_store().create_api_identity(label)
    except ValueError as e:
        # Label colliding with a non-'api' account.
        handler._send_json(409, {"error": str(e)})
        return
    except Exception as e:
        print(f"[admin] create token: {e}", file=sys.stderr)
        handler._send_json(503, {"error": "registry unavailable"})
        return
    # mcp_url derived from the request host (the client may run behind any
    # domain): https scheme in the cloud, http otherwise.
    host = handler.headers.get("Host", "")
    # https only in REAL cloud; the dev sandbox + local both serve plain http on
    # loopback (an https URL there hits the http server with a TLS handshake → 400).
    scheme = "https" if (_s.CONFIG.auth_enabled and not _s.CONFIG.dev_mode) else "http"
    mcp_url = f"{scheme}://{host}/mcp/{token}" if host else f"/mcp/{token}"
    # The PLAINTEXT token is returned only HERE, a single time.
    handler._send_json(201, {
        "token": token,
        "mcp_url": mcp_url,
        "label": label,
        "email": meta.get("email"),
    })


def tokens_delete(handler):
    data = handler._read_json()
    identifier = (data.get("id") or data.get("label") or "").strip()
    if not identifier:
        handler._send_json(400, {"error": "id or label required"})
        return
    try:
        if not _s.get_store().revoke_api_identity(identifier):
            handler._send_json(404, {"error": "token not found or already revoked"})
            return
    except Exception as e:
        print(f"[admin] revoke token: {e}", file=sys.stderr)
        handler._send_json(503, {"error": "registry unavailable"})
        return
    handler._send_json(200, {"ok": True})


# ── Atlas nodes — administration (hive, #10) ────────────────────────
def update_check(handler):
    current = _s.current_version()
    if not _s.CONFIG.update_check:
        handler._send_json(200, {"current": current, "latest": None,
                                 "update_available": False, "disabled": True})
        return
    latest = _s.latest_pypi_version()
    handler._send_json(200, {
        "current": current,
        "latest": latest,
        "update_available": _is_newer(latest, current),
        "url": PROJECT_URL,
    })


def nodes_get(handler):
    try:
        nodes = _s.get_store().list_nodes()
    except Exception as e:
        print(f"[admin] list nodes: {e}", file=sys.stderr)
        handler._send_json(503, {"error": "registry unavailable"})
        return
    handler._send_json(200, nodes)


def nodes_post(handler):
    data = handler._read_json()
    name = (data.get("name") or "").strip()
    rel = (data.get("path") or "").strip()
    if not _s._is_safe_node_name(name):
        handler._send_json(400, {"error": "invalid name"})
        return
    target = _s._validate_node_path(rel)
    if target is None:
        handler._send_json(400, {"error": "path not found"})
        return
    clean = target.relative_to(_s.CONFIG.content_root).as_posix()
    import secrets
    token = secrets.token_urlsafe(32)
    try:
        _s.get_store().create_node(name, clean, token)
    except Exception as e:
        print(f"[admin] create node: {e}", file=sys.stderr)
        handler._send_json(503, {"error": "registry unavailable"})
        return
    host = handler.headers.get("Host", "")
    # https only in REAL cloud; the dev sandbox + local both serve plain http on
    # loopback (an https URL there hits the http server with a TLS handshake → 400).
    scheme = "https" if (_s.CONFIG.auth_enabled and not _s.CONFIG.dev_mode) else "http"
    origin = f"{scheme}://{host}" if host else ""
    # The PLAINTEXT token is returned only HERE, wrapped in the copyable link.
    handler._send_json(201, {
        "name": name,
        "path": clean,
        "link": _s.encode_node_link(origin, name, clean, token),
    })


def nodes_delete(handler):
    data = handler._read_json()
    name = (data.get("name") or "").strip()
    if not name:
        handler._send_json(400, {"error": "name required"})
        return
    try:
        if not _s.get_store().revoke_node(name):
            handler._send_json(404, {"error": "node not found or already revoked"})
            return
    except Exception as e:
        print(f"[admin] revoke node: {e}", file=sys.stderr)
        handler._send_json(503, {"error": "registry unavailable"})
        return
    handler._send_json(200, {"ok": True})


# ── Remote node subscriptions — administration (#10 Phase B) ──────────────
def remotes_get(handler):
    try:
        remotes = _s.get_store().list_remotes()
    except Exception as e:
        print(f"[admin] list remotes: {e}", file=sys.stderr)
        handler._send_json(503, {"error": "registry unavailable"})
        return
    handler._send_json(200, remotes)


def remotes_post(handler):
    data = handler._read_json()
    decoded = _s.decode_node_link((data.get("link") or "").strip())
    if not decoded:
        handler._send_json(400, {"error": "invalid node link"})
        return
    name = decoded["name"]
    if not _s._is_safe_node_name(name):
        handler._send_json(400, {"error": "invalid node name"})
        return
    try:
        remote = _s.get_store().add_remote(decoded)
        result = _s.sync_remote(_s.get_store().get_remote(name))
    except Exception as e:
        print(f"[admin] add remote: {e}", file=sys.stderr)
        handler._send_json(503, {"error": "registry unavailable"})
        return
    _s.trigger_sync()  # the new mirror must show up in the index
    handler._send_json(201, {"remote": remote, "sync": result})


def remotes_sync(handler):
    data = handler._read_json()
    name = (data.get("name") or "").strip()
    try:
        if name:
            remote = _s.get_store().get_remote(name)
            if not remote:
                handler._send_json(404, {"error": "remote not found"})
                return
            results = {name: _s.sync_remote(remote)}
        else:
            results = {r["name"]: _s.sync_remote(r)
                       for r in _s.get_store().list_remotes(include_token=True)}
    except Exception as e:
        print(f"[admin] sync remote: {e}", file=sys.stderr)
        handler._send_json(503, {"error": "registry unavailable"})
        return
    _s.trigger_sync()  # propagate mirror changes into the index
    handler._send_json(200, {"results": results})


def remotes_delete(handler):
    data = handler._read_json()
    name = (data.get("name") or "").strip()
    if not name:
        handler._send_json(400, {"error": "name required"})
        return
    try:
        if not _s.get_store().remove_remote(name):
            handler._send_json(404, {"error": "remote not found"})
            return
    except Exception as e:
        print(f"[admin] remove remote: {e}", file=sys.stderr)
        handler._send_json(503, {"error": "registry unavailable"})
        return
    import shutil
    mirror = _s._remote_mirror_root(name)
    if _s._mirror_is_under_remotes(mirror) and mirror.exists():
        shutil.rmtree(mirror, ignore_errors=True)
    _s._prune_empty_dirs(_s.CONFIG.content_root / _s.REMOTES_DIR)
    _s.trigger_sync()
    handler._send_json(200, {"ok": True})


def remotes_appropriate(handler):
    data = handler._read_json()
    name = (data.get("name") or "").strip()
    source = (data.get("source") or "").strip().strip("/")  # relative to the mirror; empty = everything
    dest = (data.get("dest") or "").strip().strip("/")       # relative to content_root
    if not name or not dest:
        handler._send_json(400, {"error": "name and dest required"})
        return
    if not _s._is_safe_node_name(name):
        handler._send_json(400, {"error": "invalid name"})  # no '..'/'/' traversal in name
        return
    if ".." in dest.split("/") or dest == _s.REMOTES_DIR or dest.startswith(_s.REMOTES_DIR + "/"):
        handler._send_json(400, {"error": "invalid destination"})  # no copying INTO a mirror
        return
    try:
        if not _s.get_store().get_remote(name):
            handler._send_json(404, {"error": "remote not found"})
            return
    except Exception as e:
        print(f"[admin] appropriate: {e}", file=sys.stderr)
        handler._send_json(503, {"error": "registry unavailable"})
        return
    mirror = _s._remote_mirror_root(name)
    if not _s._mirror_is_under_remotes(mirror) or not mirror.exists():
        handler._send_json(404, {"error": "remote not mirrored"})
        return
    src = (mirror / source) if source else mirror
    content_root = _s.CONFIG.content_root
    dest_path = content_root / dest
    try:
        src.resolve().relative_to(mirror.resolve())
        dest_path.resolve().relative_to(content_root.resolve())
    except (ValueError, OSError):
        handler._send_json(400, {"error": "invalid path"})
        return
    if not src.exists():
        handler._send_json(404, {"error": "source not found"})
        return
    import shutil
    copied = 0
    if src.is_file():
        target = dest_path
        if target.is_dir() or dest.endswith("/"):
            target = target / src.name
        if target.exists():
            handler._send_json(409, {"error": "destination exists"})
            return
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, target)
        copied = 1
    else:
        sources = [p for p in src.rglob("*") if p.is_file()]
        # Like the single-file 409 guard: never silently overwrite the admin's
        # own docs — appropriate always makes a NEW copy.
        if any((dest_path / f.relative_to(src).as_posix()).exists()
               for f in sources):
            handler._send_json(409, {"error": "destination exists"})
            return
        for f in sources:
            target = dest_path / f.relative_to(src).as_posix()
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, target)
            copied += 1
    _s.trigger_sync()  # rebuild the index so the detached copy shows up
    handler._send_json(201, {"ok": True, "copied": copied})
