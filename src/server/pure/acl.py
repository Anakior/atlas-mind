"""Per-document access control (ACL) — the "partage à la Notion" core (model B).

Pure resolution of an *effective permission level* for a (path, viewer) pair
against the central registry (``store.get_acl`` + groups). NO enforcement lives
here: callers (handler, mcp_call, apiv1) turn ``effective_level`` into 404s and
write gates.

Model B:
- A path with **no ACL entry anywhere on its chain** = *socle commun*: visible
  (``view``) to any authenticated account, **including an unbound api token** (a
  token sees shared content but never a private space; bind it via ``acts_as`` to
  give it a human's full identity).
- An entry with an ``owner`` makes the path **private**: only the owner and the
  explicitly granted principals see it. Sharing is positive (``grant``); the most
  permissive grant wins.
- **Folder inheritance is additive descending**, BUT an explicit-owner child
  **cuts** the inheritance coming from above (a private sub-doc under a shared
  folder is never re-exposed) — the classic Notion trap, closed.

Principals are opaque strings typed by prefix: ``user:<email>``, ``group:<name>``,
``anon:<token_sha256>`` (a share-link), and ``*`` = any authenticated human.
"""
import posixpath
import time

import server as _s
# Permission ladder + grant resolution live in `store` (single source, shared with
# store.list_docs_shared_with so the two can't drift); re-exported here for
# `acl.LEVELS` and `from ...acl import LEVELS`.
from store import LEVELS, best_grant, slugify_token_label


class ViewerCtx:
    """Resolved identity for an ACL decision.

    - ``principals``: the set the caller embodies (``user:<email>``, each
      ``group:<name>``, and ``*`` for an authenticated human).
    - ``is_admin``: bypasses the ACL entirely (sees/owns everything).
    - ``primary``: the principal stamped as ``owner`` on create (or None).
    """
    __slots__ = ("principals", "is_admin", "primary", "superuser", "api")

    def __init__(self, principals, is_admin, primary, superuser=False, api=False):
        self.principals = frozenset(principals)
        # is_admin: curates the COMMONS (owner-level on ownerless paths) but is
        # NOT special inside another user's private space.
        self.is_admin = is_admin
        self.primary = primary
        # superuser: full bypass (sees everything), reserved for LOCAL mode — the
        # single operator on their own machine. Never set from a cloud identity.
        self.superuser = superuser
        # api: an API/MCP token — full write on the commons; private spaces still
        # require the bound human (acts_as). Distinct from is_admin (no admin routes).
        self.api = api


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
    - api/MCP token with ``acts_as=<human email>`` → inherits that human (private
      space + grants); without ``acts_as`` → commons-only (writes the commons, but
      no private space). Both carry ``api=True``.
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
                # Bound: act as the human (private space + grants) + commons write.
                h = _ctx_for_human(human, store)
                return ViewerCtx(h.principals, h.is_admin, h.primary, api=True)
        # Unbound: writes the commons (api=True) but never admin and never in a
        # private space — owned docs stay hidden until the token is bound to a human
        # via acts_as. (Single-user: bind the token to yourself to see everything.)
        principals = {"*"}
        if email:
            principals.add("user:" + email)
        return ViewerCtx(principals, False, ("user:" + email) if email else None,
                         api=True)
    return _ctx_for_human(identity, store)


def attribution_for(ctx, ai=None, store=None):
    """Git author + trailers for a write: author = the responsible human, or None
    (autonomous AI / anonymous → the bot authors). `ai` is the actor's self-reported AI
    family (MCP writes); it becomes the `X-Atlas-Author: ai/<family>` trailer — the sole
    AI marker. Slugified: it lands in the commit body, so it must not inject."""
    store = store or _s.get_store()
    primary = ctx.primary if ctx else None
    email = primary[len("user:"):] if primary and primary.startswith("user:") else None
    user = store.get_user_by_email(email) if email else None
    author = (_s.display_name(user), email) if user and user.get("role") != _s.API_ROLE else None
    trailers = []
    if ai:
        try:
            trailers = ["X-Atlas-Author: ai/" + slugify_token_label(ai)]
        except ValueError:
            pass
    return author, trailers


def parse_ai_trailer(raw):
    """X-Atlas-Author trailer value (git %(trailers:…valueonly)) → AI family, or None for a
    human write. Tolerates a reparsed 'X-Atlas-Author:' prefix and strips the 'ai/' marker.
    The read-side inverse of the trailer attribution_for writes."""
    ai = (raw or "").strip()
    if ai.lower().startswith("x-atlas-author:"):
        ai = ai.split(":", 1)[1].strip()
    if ai.startswith("ai/"):
        ai = ai[3:]
    return ai.strip() or None


def share_ctx(token):
    """ViewerCtx for a /s/<token> visitor: the single ``anon:<sha256(token)>``
    principal (the verified capability). effective_level grants ``view`` on docs
    that carry an active share for this token (share-links unified into the ACL
    path). NOT a member of ``*`` (a share is not an authenticated account)."""
    import store
    sha = store.hash_share_token(token)
    return ViewerCtx(frozenset({"anon:" + sha}), False, None)


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

    Order: superuser bypass → owner of the doc → most-permissive grant → on a
    commons (ownerless) path the admin curates (owner) and others get *view*.
    A doc owned by someone else is hidden even from the admin.
    """
    if ctx.superuser:
        return "owner"  # local single-operator → full bypass
    # Normalize the key BEFORE any ACL lookup so `a//b`, `a/./b`, or a trailing
    # slash can't dodge the registry key — a private doc must never read as commons
    # because its path was spelled differently than its acl.json key.
    rel = posixpath.normpath((rel or "").strip("/"))
    if rel == ".":
        rel = ""
    store = store or _s.get_store()
    now = int(time.time())

    present = []  # (chain_index, entry), most-specific first
    for idx, path in enumerate(_ancestors(rel)):
        entry = store.get_acl(path)
        if entry:
            present.append((idx, entry))

    # A /s/<token> visitor carries an anon:<token_sha256> principal. Expose the
    # active share-links on THIS doc as matching anon: view-grants, so the share is
    # evaluated by the SAME path as everything else (no second authorization system).
    # Guarded on an anon: principal → zero cost for normal (non-share) access, and
    # a share only ever grants the holder of its token, never `*` or a member.
    if any(p.startswith("anon:") for p in ctx.principals):
        share_grants = [{"principal": "anon:" + s["token_sha256"], "level": "view",
                         "expires_at": s["expires_at"]}
                        for s in store.list_shares_for_path(rel)]
        if share_grants:
            present.insert(0, (0, {"grants": share_grants}))

    # Most-specific entry that declares an owner = the privacy boundary.
    owner_idx, owner = None, None
    for idx, entry in present:
        if entry.get("owner"):
            owner_idx, owner = idx, entry["owner"]
            break

    # Most permissive grant for ctx among applicable entries (at or below the
    # boundary; ancestors above an owned boundary are cut — the inheritance trap).
    best = None
    for idx, entry in present:
        if owner_idx is not None and idx > owner_idx:
            continue
        g = best_grant(entry.get("grants", ()), ctx.principals, now)
        if g and (best is None or LEVELS[g["level"]] > LEVELS[best]):
            best = g["level"]

    if owner is not None:
        # Private space (owned). NO admin bypass: the admin sees it only as the
        # owner or via an explicit grant, exactly like anyone else.
        if owner in ctx.principals:
            return "owner"
        return best  # a grant level, or None (hidden — including from the admin)

    # Not governed by an owner → commons. An API/MCP token gets full write here;
    # private spaces are handled by the owner branch above.
    if ctx.api:
        return "owner"
    # The CREATOR curates their own doc (owner-level: "on the commons only the
    # creator can make it private"); the admin curates only creator-less (legacy /
    # out-of-app) docs. Everyone else gets at least view, raised by a matching grant.
    self_entry = store.get_acl(rel)
    creator = self_entry.get("creator") if self_entry else None
    if creator is not None and creator in ctx.principals:
        return "owner"
    if ctx.is_admin and creator is None:
        return "owner"
    if best is not None:
        return best
    return "view" if "*" in ctx.principals else None


def can_read(rel, ctx, store=None):
    """True if ``ctx`` may at least *see* ``rel``."""
    return effective_level(rel, ctx, store) is not None


def can_write(rel, ctx, need="edit", store=None):
    """True if ``ctx`` reaches ``need`` (``edit`` or ``owner``) on ``rel``."""
    level = effective_level(rel, ctx, store)
    return level is not None and LEVELS[level] >= LEVELS[need]


def can_manage(rel, ctx, store=None):
    """True if ``ctx`` may change the *sharing* of ``rel`` — it resolves to
    ``owner``: it owns the doc, OR it is the admin/superuser on a commons (no
    owner) doc. The admin does NOT manage another user's private doc."""
    return effective_level(rel, ctx, store) == "owner"


def in_private_space(rel, store=None):
    """True if some ancestor of ``rel`` declares an owner — ``rel`` sits inside a
    private space, so a doc created there is private by inheritance (you cannot make
    it commons inside a private folder)."""
    store = store or _s.get_store()
    rel = posixpath.normpath((rel or "").strip("/"))
    for path in _ancestors(rel):
        entry = store.get_acl(path)
        if entry and entry.get("owner"):
            return True
    return False


def can_create(rel, ctx, store=None):
    """True if ``ctx`` may create a NEW doc at ``rel``. The commons is writable by
    any authenticated account; a private space requires ``edit`` (a view-only share
    does not allow creating). No access at all → False."""
    if ctx.superuser:
        return True
    store = store or _s.get_store()
    level = effective_level(rel, ctx, store)
    if level is None:
        return False
    if in_private_space(rel, store):
        return LEVELS[level] >= LEVELS["edit"]
    return True
