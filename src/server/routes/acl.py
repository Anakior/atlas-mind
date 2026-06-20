"""Per-document ACL management + groups (model B — partage "à la Notion").

- /api/acl       : an OWNER (or admin) reads/changes the sharing of one doc/folder
                   (grant, revoke, set_owner/transfer, make_commons). Guarded AUTH
                   (GET) / CSRF_BASE (POST) + an in-handler can_manage() check, so a
                   non-admin owner can share WITHOUT being admin.
- /api/admin/groups : admin-only CRUD of named groups (principals group:<name>).
"""
import sys
import time

import server as _s

_GRANTABLE = {"view", "comment", "edit"}  # 'owner' is set via set_owner, not granted


def _valid_principal(p) -> bool:
    return isinstance(p, str) and (
        p == "*" or p.startswith("user:") or p.startswith("group:"))


def acl_get(handler):
    """GET /api/acl?path= — the ACL entry of a doc + whether the caller manages it.
    A doc the caller can't read returns 404 (no-existence-oracle)."""
    from urllib.parse import urlparse, parse_qs as _pqs
    rel = (_pqs(urlparse(handler.path).query).get("path", [""])[0] or "").strip().strip("/")
    if not rel:
        handler._send_json(400, {"error": "path required"})
        return
    ctx = handler._viewer_ctx()
    if not _s.can_read(rel, ctx):
        handler._send_json(404, {"error": "not found"})
        return
    entry = _s.get_store().get_acl(rel) or {}
    handler._send_json(200, {
        "path": rel,
        "owner": entry.get("owner"),
        "creator": entry.get("creator"),
        "grants": entry.get("grants", []),
        "can_manage": _s.can_manage(rel, ctx),
    })


def acl_post(handler):
    """POST /api/acl {path, action, principal?, level?} — manage one doc's sharing.
    action ∈ grant | revoke | set_owner | make_commons. Owner-or-admin only."""
    data = handler._read_json()
    rel = (data.get("path") or "").strip().strip("/")
    action = (data.get("action") or "").strip()
    if not rel:
        handler._send_json(400, {"error": "path required"})
        return
    ctx = handler._viewer_ctx()
    actor = (handler._session() or {}).get("email")
    if not _s.can_read(rel, ctx):
        handler._send_json(404, {"error": "not found"})  # no-existence-oracle
        return
    if not _s.can_manage(rel, ctx):
        # Audit the DENIED attempt too (abuse detection): someone tried to change the
        # sharing of a doc they don't own.
        sys.stderr.write(f"[acl-audit] DENIED {action} path={rel} by={actor or '?'} "
                         f"ip={handler._client_ip()}\n")
        sys.stderr.flush()
        handler._send_json(403, {"error": "only the owner or an admin can manage sharing"})
        return
    store = _s.get_store()
    try:
        if action == "grant":
            principal = (data.get("principal") or "").strip()
            level = (data.get("level") or "").strip()
            if not _valid_principal(principal):
                handler._send_json(400, {"error": "invalid principal"})
                return
            if level not in _GRANTABLE:
                handler._send_json(400, {"error": "level must be view, comment or edit"})
                return
            # Optional time-limited grant: expires_days → absolute epoch.
            # 0/absent = no expiry; a negative value is rejected (would create an
            # already-expired, inert grant).
            expires_at = 0
            days = data.get("expires_days")
            if days:
                try:
                    days = int(days)
                except (TypeError, ValueError):
                    handler._send_json(400, {"error": "expires_days must be a number"})
                    return
                if days <= 0:
                    handler._send_json(400, {"error": "expires_days must be a positive number"})
                    return
                expires_at = int(time.time()) + days * 86400
            # Record who granted it: audit + "shared by …" attribution.
            store.grant(rel, principal, level, expires_at=expires_at,
                        by=("user:" + actor) if actor else None)
        elif action == "revoke":
            principal = (data.get("principal") or "").strip()
            if not store.revoke_grant(rel, principal):
                handler._send_json(404, {"error": "no such grant"})
                return
        elif action == "set_owner":
            principal = (data.get("principal") or "").strip()
            if not principal.startswith("user:"):
                handler._send_json(400, {"error": "owner must be user:<email>"})
                return
            store.set_owner(rel, principal)
        elif action == "make_commons":
            store.make_commons(rel)  # drop owner + grants but KEEP the creator
        else:
            handler._send_json(400, {"error": "unknown action"})
            return
    except Exception as e:
        print(f"[acl] {action} on {rel} failed: {e}", file=sys.stderr)
        handler._send_json(503, {"error": "registry unavailable"})
        return
    # Audit trail: who changed the sharing of what, when. A multi-user atlas
    # needs this for incident response / abuse detection — the access log records
    # the IP+verb but not the actor's identity nor the action/principal.
    sys.stderr.write(
        f"[acl-audit] {action} path={rel} "
        f"principal={(data.get('principal') or '-').strip() or '-'} "
        f"by={actor or '?'} ip={handler._client_ip()}\n")
    sys.stderr.flush()
    entry = store.get_acl(rel) or {}
    handler._send_json(200, {"ok": True, "path": rel,
                            "owner": entry.get("owner"), "grants": entry.get("grants", [])})


def shared_with_me(handler):
    """GET /api/shared-with-me — docs another user has shared WITH the caller (a
    grant to their user:/group: principals), so a member can discover them instead
    of stumbling on them in the tree. `*` (commons) grants are excluded — this is
    what was shared with ME specifically."""
    ctx = handler._viewer_ctx()
    mine = {p for p in ctx.principals if p.startswith(("user:", "group:"))}
    try:
        docs = _s.get_store().list_docs_shared_with(mine)
    except Exception as e:
        print(f"[acl] shared-with-me: {e}", file=sys.stderr)
        handler._send_json(503, {"error": "registry unavailable"})
        return
    # Defense-in-depth: only return what the caller can still actually read.
    docs = [d for d in docs if _s.can_read(d["path"], ctx)]
    handler._send_json(200, docs)


def directory(handler):
    """GET /api/directory — known emails + group names, for the share-dialog
    autocompletion. Any authenticated account (you must know whom to share with).
    Exposes the member directory to authenticated users — acceptable in a shared
    atlas; never exposes hashes/tokens."""
    try:
        st = _s.get_store()
        users = sorted(
            u.get("email") for u in st.list_admin_facing_users() if u.get("email"))
        groups = sorted((st.list_groups() or {}).keys())
    except Exception as e:
        print(f"[acl] directory: {e}", file=sys.stderr)
        handler._send_json(503, {"error": "registry unavailable"})
        return
    handler._send_json(200, {"users": users, "groups": groups})


# ── groups (admin) ────────────────────────────────────────────────────────────

def groups_get(handler):
    try:
        groups = _s.get_store().list_groups()
    except Exception as e:
        print(f"[acl] list groups: {e}", file=sys.stderr)
        handler._send_json(503, {"error": "registry unavailable"})
        return
    handler._send_json(200, groups)


def groups_post(handler):
    data = handler._read_json()
    name = (data.get("name") or "").strip()
    members = data.get("members")
    if not name or "/" in name or name.startswith(".") or len(name) > 64:
        handler._send_json(400, {"error": "invalid group name"})
        return
    if not isinstance(members, list):
        handler._send_json(400, {"error": "members must be a list"})
        return
    # Validate each member is a real email: an unvalidated string (typo,
    # control chars) becomes a dead grant that never matches a login — a silent
    # no-op that reads as "shared" but grants no one.
    emails = []
    for m in members:
        if not isinstance(m, str) or not m.strip():
            continue
        email = m.strip().lower()
        if not _s.is_valid_email(email):
            handler._send_json(400, {"error": f"invalid email: {m.strip()}"})
            return
        emails.append(email)
    try:
        _s.get_store().set_group(name, emails)
    except Exception as e:
        print(f"[acl] set group: {e}", file=sys.stderr)
        handler._send_json(503, {"error": "registry unavailable"})
        return
    handler._send_json(200, {"ok": True, "name": name, "members": emails})


def groups_delete(handler):
    data = handler._read_json()
    name = (data.get("name") or "").strip()
    if not name:
        handler._send_json(400, {"error": "name required"})
        return
    try:
        if not _s.get_store().delete_group(name):
            handler._send_json(404, {"error": "group not found"})
            return
    except Exception as e:
        print(f"[acl] delete group: {e}", file=sys.stderr)
        handler._send_json(503, {"error": "registry unavailable"})
        return
    handler._send_json(200, {"ok": True})
