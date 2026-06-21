"""The route tables — the URL map. Each per-verb list binds a path + RouteKind +
Guard to a route function in server/routes/*.py; Handler.do_<VERB> walks the
matching list with router.dispatch, which applies the Guard (the single auth point)
then calls the function.

ORDER IS SEMANTIC (it reproduces the legacy if/elif fall-through). /login, /logout,
/setup and /api/setup are cloud-only (when=_when_cloud). The machinery lives in
app/router.py; the handlers in routes/*.py.
"""
import server as _s
from server.app import router
from server.constants import _SHARE_ID_PATTERN
from server.routes import (
    system, auth, setup, invite, share, docs, todos, notes, admin,
    account, hive, apiv1, mcp, acl,
)

_RK = router.RouteKind
_G = router.Guard


def _when_cloud(handler) -> bool:
    """Route `when` predicate: active only in cloud mode (CONFIG.auth_enabled). A
    non-cloud request skips the route and falls through."""
    return _s.CONFIG.auth_enabled


# GET: public pages/assets, the Bearer channels (node / v1 / mcp), the admin + auth
# JSON endpoints; then (in do_GET) extension dispatch → setup redirect → session
# guard → navigable static tail.
GET_ROUTES = [
    router.Route(_RK.EXACT, "/healthz", system.healthz, _G.PUBLIC),
    router.Route(_RK.EXACT, "/login", auth.login_page, _G.PUBLIC, when=_when_cloud),
    router.Route(_RK.EXACT, "/logout", auth.logout, _G.PUBLIC, when=_when_cloud),
    router.Route(_RK.ANY_OF, ("/manifest.json", "/icon.svg", "/favicon.ico"), system.static_get, _G.PUBLIC),
    router.Route(_RK.PREFIX_NOQUERY, "/vendor/", system.static_get, _G.PUBLIC),
    router.Route(_RK.EXACT, "/sw.js", system.sw, _G.PUBLIC),
    router.Route(_RK.EXACT_NOQUERY, "/setup", setup.page, _G.PUBLIC, when=_when_cloud),
    router.Route(_RK.PREFIX, "/invite/", invite.page, _G.PUBLIC, when=_when_cloud),
    router.Route(_RK.PREFIX, "/s/", share.page, _G.PUBLIC),
    router.Route(_RK.EXACT, "/api/node/manifest", hive.manifest, _G.BEARER),
    router.Route(_RK.EXACT_NOQUERY, "/api/node/file", hive.file, _G.BEARER),
    router.Route(_RK.EXACT, "/api/me", auth.me, _G.PUBLIC),
    router.Route(_RK.PREFIX, "/api/share/list", share.list_shares, _G.ADMIN),
    router.Route(_RK.EXACT, "/api/admin/users", admin.users_get, _G.ADMIN),
    router.Route(_RK.EXACT, "/api/tokens", admin.tokens_get, _G.AUTH),
    router.Route(_RK.EXACT, "/api/admin/nodes", admin.nodes_get, _G.ADMIN),
    router.Route(_RK.EXACT, "/api/admin/remotes", admin.remotes_get, _G.ADMIN),
    router.Route(_RK.EXACT, "/api/admin/groups", acl.groups_get, _G.ADMIN),
    router.Route(_RK.EXACT, "/api/admin/update-check", admin.update_check, _G.ADMIN),
    router.Route(_RK.EXACT, "/api/todos", todos.list_todos, _G.AUTH),
    router.Route(_RK.EXACT_NOQUERY, "/api/notes", notes.list_notes, _G.AUTH),
    router.Route(_RK.EXACT, "/api/tree", docs.tree, _G.AUTH),
    router.Route(_RK.EXACT_NOQUERY, "/api/acl", acl.acl_get, _G.AUTH),
    router.Route(_RK.EXACT, "/api/shared-with-me", acl.shared_with_me, _G.AUTH),
    router.Route(_RK.EXACT, "/api/directory", acl.directory, _G.AUTH),
    router.Route(_RK.EXACT_NOQUERY, "/api/search", docs.search, _G.AUTH),
    router.Route(_RK.EXACT_NOQUERY, "/api/history", docs.history, _G.AUTH),
    router.Route(_RK.EXACT_NOQUERY, "/api/revision", docs.revision, _G.AUTH),
    router.Route(_RK.EXACT_NOQUERY, "/api/diff", docs.diff, _G.AUTH),
    router.Route(_RK.EXACT, "/api/account/profile", account.profile_get, _G.AUTH),
    router.Route(_RK.EXACT, "/api/events", system.events, _G.AUTH),
    router.Route(_RK.EXACT, "/.well-known/openapi.json", system.openapi, _G.PUBLIC),
    router.Route(_RK.PREFIX, "/api/v1/", apiv1.get, _G.BEARER),
    router.Route(_RK.PREFIX, "/mcp/", mcp.handle, _G.BEARER),
]

# POST: login/setup (cloud-only), the github webhook, admin (ADMIN_CSRF), account +
# TOTP (CSRF_BASE = auth + csrf), the content mutations (ADMIN_CSRF), then the Bearer
# channels. do_POST falls through to extension dispatch then 404.
POST_ROUTES = [
    router.Route(_RK.EXACT, "/login", auth.login, _G.PUBLIC, when=_when_cloud),
    router.Route(_RK.EXACT, "/api/setup", setup.submit, _G.PUBLIC, when=_when_cloud),
    router.Route(_RK.EXACT, "/api/invite", invite.submit, _G.PUBLIC, when=_when_cloud),
    router.Route(_RK.EXACT, "/webhook/github", system.webhook, _G.PUBLIC),
    router.Route(_RK.EXACT, "/api/admin/users", admin.users_post, _G.ADMIN_CSRF),
    router.Route(_RK.EXACT, "/api/admin/users/password", admin.users_password, _G.ADMIN_CSRF),
    router.Route(_RK.EXACT, "/api/admin/groups", acl.groups_post, _G.ADMIN_CSRF),
    router.Route(_RK.EXACT, "/api/tokens", admin.tokens_post, _G.CSRF_BASE),
    router.Route(_RK.EXACT, "/api/admin/nodes", admin.nodes_post, _G.ADMIN_CSRF),
    router.Route(_RK.EXACT, "/api/admin/remotes", admin.remotes_post, _G.ADMIN_CSRF),
    router.Route(_RK.EXACT, "/api/admin/remotes/sync", admin.remotes_sync, _G.ADMIN_CSRF),
    router.Route(_RK.EXACT, "/api/admin/remotes/appropriate", admin.remotes_appropriate, _G.ADMIN_CSRF),
    router.Route(_RK.EXACT, "/api/account/profile", account.profile_post, _G.CSRF_BASE),
    router.Route(_RK.EXACT, "/api/account/logout-all", account.logout_all, _G.CSRF_BASE),
    router.Route(_RK.EXACT, "/api/account/totp/init", account.totp_init, _G.CSRF_BASE),
    router.Route(_RK.EXACT, "/api/account/totp/enable", account.totp_enable, _G.CSRF_BASE),
    router.Route(_RK.EXACT, "/api/account/totp/disable", account.totp_disable, _G.CSRF_BASE),
    router.Route(_RK.EXACT, "/api/share", share.create, _G.CSRF_BASE),       # per-doc: owner can share
    router.Route(_RK.EXACT, "/api/acl", acl.acl_post, _G.CSRF_BASE),
    router.Route(_RK.EXACT, "/api/todos", todos.create, _G.CSRF_BASE),       # per-member: own list
    router.Route(_RK.EXACT, "/api/notes", notes.create, _G.ADMIN_CSRF),
    router.Route(_RK.EXACT, "/api/revert", docs.revert, _G.CSRF_BASE),       # per-doc: needs edit
    router.Route(_RK.EXACT, "/api/file/move", docs.move, _G.CSRF_BASE),      # per-doc: needs owner
    router.Route(_RK.EXACT, "/api/dir/rename", docs.dir_rename, _G.CSRF_BASE),  # per-folder: owner (can_manage)
    router.Route(_RK.PREFIX, "/api/v1/", apiv1.post, _G.BEARER),
    router.Route(_RK.PREFIX, "/mcp/", mcp.handle, _G.BEARER),
]

# PATCH: per-route guards (do_PATCH no longer blanket-admins). notes + share
# repoint stay ADMIN_CSRF; todos is CSRF_BASE (a member patches its OWN list).
PATCH_ROUTES = [
    router.Route(_RK.EXACT_NOQUERY, "/api/notes", notes.patch, _G.ADMIN_CSRF),
    router.Route(_RK.REGEX, _SHARE_ID_PATTERN, share.repoint, _G.ADMIN_CSRF),
    router.Route(_RK.REGEX, r"^/api/todos/(\d+)$", todos.patch, _G.CSRF_BASE),
]

# DELETE: per-route guards (do_DELETE no longer blanket-admins). Admin routes keep
# ADMIN_CSRF; /api/file is CSRF_BASE (any member, authorized per-document — owner —
# in docs.delete). Admin routes ordered FIRST; share-id regex BEFORE todos.
DELETE_ROUTES = [
    router.Route(_RK.EXACT, "/api/admin/users", admin.users_delete, _G.ADMIN_CSRF),
    router.Route(_RK.EXACT, "/api/admin/groups", acl.groups_delete, _G.ADMIN_CSRF),
    router.Route(_RK.EXACT, "/api/admin/nodes", admin.nodes_delete, _G.ADMIN_CSRF),
    router.Route(_RK.EXACT, "/api/admin/remotes", admin.remotes_delete, _G.ADMIN_CSRF),
    router.Route(_RK.EXACT, "/api/tokens", admin.tokens_delete, _G.CSRF_BASE),
    router.Route(_RK.EXACT, "/api/file", docs.delete, _G.CSRF_BASE),
    router.Route(_RK.EXACT_NOQUERY, "/api/notes", notes.delete, _G.ADMIN_CSRF),
    router.Route(_RK.REGEX, _SHARE_ID_PATTERN, share.revoke, _G.ADMIN_CSRF),
    router.Route(_RK.REGEX, r"^/api/todos/(\d+)$", todos.delete, _G.CSRF_BASE),  # per-member: own list
]

# PUT: a single content route. do_PUT no longer blanket-admins; /api/file is
# CSRF_BASE (any member, authorized per-document in docs.file_put — create/edit).
PUT_ROUTES = [
    router.Route(_RK.EXACT, "/api/file", docs.file_put, _G.CSRF_BASE),
]
