"""Per-document access control (ACL) — the "partage à la Notion" core (model B).

Pure resolution of an *effective permission level* for a (path, viewer) pair
against the central registry (``store.get_acl`` + groups). NO enforcement lives
here: callers (handler, mcp_call, apiv1) turn ``effective_level`` into 404s and
write gates. See ``atlas-mind/cdc-commons-repo-partage.md`` §4/§5.

Model B:
- A path with **no ACL entry anywhere on its chain** = *socle commun*: visible
  (``view``) to any authenticated account, **including an unbound api token** (a
  token sees shared content but never a private space; bind it via ``acts_as`` to
  give it a human's full identity, §11.2).
- An entry with an ``owner`` makes the path **private**: only the owner and the
  explicitly granted principals see it. Sharing is positive (``grant``); the most
  permissive grant wins.
- **Folder inheritance is additive descending**, BUT an explicit-owner child
  **cuts** the inheritance coming from above (a private sub-doc under a shared
  folder is never re-exposed) — the classic Notion trap, closed (§4).

Principals are opaque strings typed by prefix: ``user:<email>``, ``group:<name>``,
``anon:<token_sha256>`` (a share-link), and ``*`` = any authenticated human.
"""
import time

import server as _s

# Ordered permission ladder. ``comment`` is reserved but folded onto ``view`` in
# v1 (decision §11.4); kept in the order so a future grant slots in cleanly.
LEVELS = {"view": 1, "comment": 2, "edit": 3, "owner": 4}


class ViewerCtx:
    """Resolved identity for an ACL decision.

    - ``principals``: the set the caller embodies (``user:<email>``, each
      ``group:<name>``, and ``*`` for an authenticated human).
    - ``is_admin``: bypasses the ACL entirely (sees/owns everything).
    - ``primary``: the principal stamped as ``owner`` on create (or None).
    """
    __slots__ = ("principals", "is_admin", "primary")

    def __init__(self, principals, is_admin, primary):
        self.principals = frozenset(principals)
        self.is_admin = is_admin
        self.primary = primary


# Anonymous caller (no session, no token): no principals → only share-links and
# the offline build expose content to it; the commons is for authenticated humans.
ANON = ViewerCtx(frozenset(), False, None)


def _ctx_for_human(user, store):
    """Ctx of a human account (admin/viewer): own principal + groups + ``*``."""
    email = user.get("email")
    principals = {"*"}
    primary = None
    if email:
        principals.add("user:" + email)
        primary = "user:" + email
        for name in store.groups_for_email(email):
            principals.add("group:" + name)
    return ViewerCtx(principals, user.get("role") == "admin", primary)


def viewer_ctx(identity, store=None):
    """Build a :class:`ViewerCtx` from a *verified* identity ``{email, role,
    acts_as?}`` (never from a tool argument — the caller resolves it from the
    cookie or the bearer/MCP token).

    - None → anonymous (:data:`ANON`).
    - human (admin/viewer) → own principal + groups + ``*``.
    - api/MCP token with ``acts_as=<human email>`` → **inherits that human**
      (decision §11.2, "un token MCP = un humain"); without ``acts_as`` →
      least privilege: only its own ``user:<email>``, NOT a member of ``*``.
    """
    store = store or _s.get_store()
    if not identity:
        return ANON
    role = identity.get("role")
    email = identity.get("email")
    if role == _s.API_ROLE:
        acts_as = identity.get("acts_as")
        if acts_as:
            human = store.get_user_by_email(acts_as)
            if human:
                return _ctx_for_human(human, store)
        # Unbound token: member of the commons (sees shared content) but NEVER
        # admin and NEVER in a private space — owned/private docs stay hidden
        # until explicitly granted, or until the token is bound via `acts_as` to
        # a human (decision §11.2). Mono-user reality (§11.3): the owner binds his
        # token to himself/admin and sees everything.
        principals = {"*"}
        if email:
            principals.add("user:" + email)
        return ViewerCtx(principals, False, ("user:" + email) if email else None)
    return _ctx_for_human(identity, store)


def _ancestors(rel):
    """``[rel, parent-dir, …, top-dir]`` most-specific first. Folder keys carry
    no extension (mirrors how a directory is keyed in ``acl.json``)."""
    rel = rel.strip("/")
    chain = [rel]
    parts = rel.split("/")
    for i in range(len(parts) - 1, 0, -1):
        chain.append("/".join(parts[:i]))
    return chain


def effective_level(rel, ctx, store=None):
    """The level ``ctx`` effectively has on ``rel``, or ``None`` for no access.

    Order: admin bypass → owner → most-permissive applicable grant → *socle
    commun* (``view``) when no owner governs the chain.
    """
    if ctx.is_admin:
        return "owner"
    store = store or _s.get_store()
    now = int(time.time())

    present = []  # (chain_index, entry), most-specific first
    for idx, path in enumerate(_ancestors(rel)):
        entry = store.get_acl(path)
        if entry:
            present.append((idx, entry))

    if not present:
        return "view" if "*" in ctx.principals else None

    # Most-specific entry that declares an owner = the privacy boundary.
    owner_idx = None
    for idx, entry in present:
        if entry.get("owner"):
            owner_idx = idx
            if entry["owner"] in ctx.principals:
                return "owner"
            break

    # Most permissive grant among applicable entries (at or below the boundary;
    # ancestors above an owned boundary are cut — the inheritance trap).
    best = None
    for idx, entry in present:
        if owner_idx is not None and idx > owner_idx:
            continue
        for g in entry.get("grants", ()):  # noqa: E741
            if g.get("principal") not in ctx.principals:
                continue
            exp = g.get("expires_at") or 0
            if exp and now > exp:
                continue
            rank = LEVELS.get(g.get("level"))
            if rank and (best is None or rank > LEVELS[best]):
                best = g["level"]
    if best is not None:
        return best

    if owner_idx is not None:
        return None  # owned, ctx is neither owner nor grantee → private
    return "view" if "*" in ctx.principals else None


def can_read(rel, ctx, store=None):
    """True if ``ctx`` may at least *see* ``rel``."""
    return effective_level(rel, ctx, store) is not None


def can_write(rel, ctx, need="edit", store=None):
    """True if ``ctx`` reaches ``need`` (``edit`` or ``owner``) on ``rel``."""
    level = effective_level(rel, ctx, store)
    return level is not None and LEVELS[level] >= LEVELS[need]
