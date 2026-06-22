#!/usr/bin/env python3
"""Knowledge-base viewer server, dual local/cloud mode.

Local mode (default):
    Run: python server.py
    Open: http://localhost:8765
    No auth, serves files from the repo directory directly.

Cloud mode (when KB_AUTH_ENABLED=1):
    Required env vars: GITHUB_REPO_URL (with PAT embedded) and SESSION_SECRET.
    The identity/share registry is a FileStore: users + share links in JSON
    under ROOT/.atlas/ (no database). See src/store.py.
    ATLAS_STORE_DIR relocates the registry, default ROOT/.atlas.
    The registry is NEVER committed/pushed with the content repo (it holds
    password/token hashes): point ATLAS_STORE_DIR at a persistent volume in
    cloud, otherwise users/shares are lost when the ephemeral rootfs is rebuilt.
    The repo is cloned at startup into KB_REPO_PATH (default /app/repo).
    A background thread pulls the repo every GIT_PULL_INTERVAL seconds (default 30).
    All routes require a signed session cookie; /login renders an HTML form.

API:
    GET    /api/todos
    POST   /api/todos          {text}
    PATCH  /api/todos/:id      {done?, text?}
    DELETE /api/todos/:id
    GET    /api/events         (SSE, live reload in local mode)
    PUT    /api/file           {path, content}    (md edition)
    GET    /login              (cloud mode only)
    POST   /login              (cloud mode only ; 2 steps if 2FA is active)
    GET    /logout             (cloud mode only)
    POST   /api/account/logout-all          (revokes all of the user's sessions)
    POST   /api/account/totp/init           (2FA enrollment: secret + URI)
    POST   /api/account/totp/enable {code}  (enables 2FA + recovery codes)
    POST   /api/account/totp/disable {code|recovery}  (disables 2FA)

The todos live in the markdown file configured by [todo].file in atlas.toml
(GitHub Flavored Markdown checkboxes).

Configuration: src/config.py (AtlasConfig). The mind (content directory) is
resolved via ATLAS_MIND (otherwise the historical behavior), an optional
<mind>/atlas.toml provides the settings, and env vars keep priority.
"""
from pathlib import Path
import os
import re
import signal
import subprocess
import sys
import threading
import time

# Intra-package imports below are FLAT so the same code runs under both entry
# points. Bootstrapped BEFORE the first flat import:
#   • put the parent dir on sys.path so `server`/`store`/`config`/`build` resolve
#     under `python -m atlas_mind.server` (pip prod, package dir NOT on the path)
#     as well as `python -m server` (dev/tests);
#   • alias this module as flat `server` so `from server.X import` binds to THIS
#     module instead of re-importing (and double-executing) the package.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.modules.setdefault("server", sys.modules[__name__])

from server.constants import (  # noqa: F401
    COOKIE_NAME, CSRF_COOKIE_NAME, MAX_BODY_BYTES, _EMAIL_PATTERN, MAX_EMAIL_LEN,
    MAX_TOKEN_LABEL_LEN, API_ROLE, NODE_LINK_PREFIX, REMOTES_DIR,
    MAX_NODE_FILE_BYTES, PROJECT_URL, _GIT_REV_RE, MCP_PROTOCOL_VERSION,
    _SHARE_ID_PATTERN,
)


import store  # identity/share registry: FileStore (JSON under .atlas/)
from store import valid_name, display_name  # noqa: F401  account name field + UI render
from config import AtlasConfig, AtlasConfigError, resolve_mind_root

# WHITE-BOX TEST CONTRACT — tests/test_admin.py imports server._is_newer and
# server._evict_stale_buckets; keep these two re-exports.
from server.services.rate_limit import _evict_stale_buckets  # noqa: F401
from server.services.update_check import _is_newer, _version_tuple  # noqa: F401

from server.context import AppContext, AtlasHTTPServer
from server.pure import docs  # document-domain logic (path validation / traversal / move)

# The single server config object. Built in run() AFTER the possible cloud clone
# so <mind>/atlas.toml is readable (env > toml > defaults, see src/config.py).
CONFIG = None  # type: AtlasConfig
# Application context (config + services), built once by run() and carried by
# AtlasHTTPServer (self.server.context).
_CTX = None  # type: AppContext

from server.pure.todos_md import (  # noqa: F401
    TODO_HEADER, _norm_cat, parse_todos, write_todos, load_todos,
)
from server.pure.notes_md import _notes_path, load_notes, save_notes  # noqa: F401
from server.pure.auth import (  # noqa: F401  token/CSRF/share/bearer crypto + identity
    _has_control_chars, is_valid_email, _b64url_nopad, _b64url_nopad_decode,
    current_session_epoch, make_token, verify_token, authenticate_user, authenticate,
    new_share_token, verify_share_token, make_csrf_token, verify_csrf_token,
    consume_recovery_code, _hash_api_token, verify_api_bearer, _verify_mcp_token,
    resolve_mcp_identity,
)
from server.pure.docs import (  # noqa: F401  tree ACL / git-history / live tasks / search text
    _filter_tree, _valid_git_rev, _doc_path_history, _doc_path_at,
    _live_tasks_index, _normalize_text, _html_to_text, _HTML_BLOCK_RE,
)
from server.pure.acl import (  # noqa: F401  per-document ACL (model B — partage à la Notion)
    ViewerCtx, viewer_ctx, share_ctx, effective_level, LEVELS,
    can_read as _acl_can_read, can_write as _acl_can_write,
    can_manage as _acl_can_manage, can_create as _acl_can_create,
    in_private_space as _acl_in_private_space,
)

# ── cross-platform ACL-key integrity (canonical path) ─────────────────────────
# On a case-insensitive filesystem (Windows, macOS) a doc can be requested under a
# non-canonical spelling — different letter case, a trailing dot — that opens the
# SAME file but a DIFFERENT (or missing) acl.json key, slipping a private doc past
# the gate as "commons". Every ACL check goes through these façade wrappers, which
# canonicalize the path to its EXACT on-disk spelling first, so the ACL is always
# keyed by the real path. No-op on a case-sensitive FS (Linux, incl. the SaaS),
# where the variant is simply a different, non-existent path (→ natural 404) — so
# zero overhead in production. The pure acl.* functions stay FS-agnostic (unit-test
# friendly); only the server façade is filesystem-aware.
_fs_case_insensitive = None


def _is_fs_case_insensitive() -> bool:
    global _fs_case_insensitive
    if _fs_case_insensitive is None:
        try:
            root = str(CONFIG.content_root)
            swapped = root.swapcase()
            _fs_case_insensitive = bool(
                root != swapped and os.path.exists(swapped)
                and os.path.samefile(root, swapped))
        except Exception:
            _fs_case_insensitive = (os.name == "nt")
    return _fs_case_insensitive


def _canonical_rel(rel):
    """The EXACT on-disk spelling of doc `rel` on a case-insensitive FS, else `rel`
    unchanged (no on-disk file, a case-sensitive FS, or a not-yet-created path)."""
    if not rel or not _is_fs_case_insensitive():
        return rel
    try:
        root = CONFIG.content_root
        target = (root / rel).resolve()
        if target.exists():  # an existing file OR folder → its real on-disk key
            return target.relative_to(root).as_posix()
    except (ValueError, OSError):
        pass
    return rel


def can_read(rel, ctx, store=None):
    return _acl_can_read(_canonical_rel(rel), ctx, store)


def can_write(rel, ctx, need="edit", store=None):
    return _acl_can_write(_canonical_rel(rel), ctx, need, store)


def can_manage(rel, ctx, store=None):
    return _acl_can_manage(_canonical_rel(rel), ctx, store)


def can_create(rel, ctx, store=None):
    return _acl_can_create(_canonical_rel(rel), ctx, store)


def in_private_space(rel, store=None):
    return _acl_in_private_space(_canonical_rel(rel), store)


def _stamp_new_doc(rel, ctx, *, private=None):
    """On create: stamp the creator, then (unless admin/api/in a private space) make
    the doc private to its creator. `private` overrides the default (the New-Document
    toggle); None → a human member's doc is private, an admin's or an API token's
    stays in the commons. Callers own the surrounding try/except + any clean-slate
    delete_acl (these differ per write surface)."""
    store = get_store()
    store.set_creator(rel, ctx.primary)
    if private is None:
        private = not ctx.is_admin and not ctx.api
    if private and not in_private_space(rel):
        store.set_owner(rel, ctx.primary)


def _repoint_doc(frm, to):
    """Move a doc's ACL + share-registry entries from `frm` to `to`. Best-effort and
    logged — called BEFORE the git sync so the moved doc never lands at its new path
    with no ACL (which would read as commons)."""
    try:
        store = get_store()
        store.repoint_acl_by_path(frm, to)   # privacy travels first
        store.repoint_shares_by_path(frm, to)
    except Exception as e:
        print(f"[move repoint] {e}", file=sys.stderr)


def registry_503(handler, context, e):
    """Map a registry/store failure to the uniform fail-closed 503, logging
    `context` + the exception. One home for the payload so the store-op handlers
    can't drift on the error shape; each call site keeps its own except (+ return)."""
    print(f"{context}: {e}", file=sys.stderr)
    handler._send_json(503, {"error": "registry unavailable"})


from server.pure.hive import (  # noqa: F401  federation node links / mirror / fetch
    encode_node_link, decode_node_link, verify_node_bearer, _validate_node_path,
    _iter_node_files, _remote_mirror_root, _is_readonly_path, _is_safe_node_name,
    _mirror_is_under_remotes, _atomic_write_bytes, _is_blocked_ip, _validate_remote_url,
    _http_get_bearer, _prune_empty_dirs,
)
from server.pure.mcp_call import (  # noqa: F401  MCP dispatch + graph/tag/trash/search
    _doc_corpus, _links_graph, _tags_for, _soft_delete, _api_search, _api_recent,
    _activity_events, _mcp_call_tool, _mcp_jsonrpc,
)
from server.extensions import load_server_extensions  # noqa: F401


def _exclude_store_dir_from_git(store_dir):
    """Adds the registry directory to .git/info/exclude (idempotent).

    The registry (password/token hashes) lives by default under ROOT/.atlas,
    INSIDE the content repo that trigger_sync commits via `git add -A` and pushes.
    Without exclusion these secrets would enter git history forever (and
    state.json's per-request churn). Belt-and-braces with the "*" .gitignore
    FileStore writes. Best-effort: a failure does not block boot."""
    git_dir = CONFIG.root / ".git"
    if not git_dir.is_dir():
        return
    try:
        relative = store_dir.resolve().relative_to(CONFIG.root.resolve())
    except ValueError:
        return  # registry outside the repo (ATLAS_STORE_DIR): git does not see it
    pattern = "/" + relative.as_posix() + "/"
    exclude_path = git_dir / "info" / "exclude"
    try:
        existing = ""
        if exclude_path.exists():
            existing = exclude_path.read_text(encoding="utf-8")
        if pattern in existing.splitlines():
            return
        exclude_path.parent.mkdir(parents=True, exist_ok=True)
        with open(exclude_path, "a", encoding="utf-8") as handle:
            if existing and not existing.endswith("\n"):
                handle.write("\n")
            handle.write(pattern + "\n")
    except OSError as e:
        print(f"[get_store] could not git-exclude the registry: {e}",
              file=sys.stderr)


def build_store(config):
    """Build the identity/share registry (FileStore) and best-effort exclude its
    directory from git — it holds password/token hashes and must never be
    committed. Called once from run().

    config.store_dir defaults to <mind>/.atlas. In cloud, point it at a persistent
    volume outside the repo (the Fly rootfs is ephemeral AND the content repo must
    not carry credentials); without a volume, cloud LOSES users/shares on every
    machine recreation."""
    st = store.FileStore(config.store_dir)
    _exclude_store_dir_from_git(config.store_dir)
    return st


def get_store():
    """The identity/share registry (FileStore). Delegation seam to the AppContext."""
    return _CTX.store


# ─── First-boot: initial admin account (cloud mode) ─────────────────────────────


def maybe_init_setup_token() -> None:
    """Generate the first-boot install token (cloud mode, no admin yet).
    Delegates to the SetupToken service."""
    _CTX.setup_token.maybe_init()


def setup_is_open() -> bool:
    """Is the first-boot admin-creation window open? Delegates to the service."""
    return _CTX.setup_token.is_open()


# ─── TOTP (RFC 6238) + recovery codes ───────────────────────────────────────────
from server.totp import (  # noqa: F401
    TOTP_STEP_SECONDS, TOTP_DIGITS, TOTP_WINDOW, TOTP_SECRET_BYTES,
    RECOVERY_CODE_COUNT, generate_totp_secret, _hotp, _decode_base32_secret,
    verify_totp_step, verify_totp, totp_provisioning_uri, generate_recovery_codes,
)



# ─── Per-account lockout (complement to the per-IP rate-limit) ──────────────────

def account_lock_remaining(email: str) -> int:
    """Remaining lock seconds for this account (0 if not locked). Delegates to the
    LockoutTracker service."""
    return _CTX.lockout.lock_remaining(email)


def register_login_failure(email: str, ip: str) -> None:
    """Records a failed login (counter + backoff + fail2ban stderr line).
    Delegates to the LockoutTracker service."""
    _CTX.lockout.register_failure(email, ip)


def reset_login_failures(email: str) -> None:
    """Clears the account's failure counter on a successful login. Delegates to
    the LockoutTracker service."""
    _CTX.lockout.reset_failures(email)


# ─── API Bearer auth (external connectors: Claude.ai, MCP, etc.) ───
#
# /api/v1/* is protected by a Bearer token independent of the cookie system
# (SHA256 hash on the api user). The 'api' role via REST is read + create only
# (POST /api/v1/file refuses overwrite); any other op (DELETE, PUT, move, share,
# todos) returns 403. MCP (/mcp/<token>) additionally exposes edit_doc (Claude
# reads then amends); REST overwriting stays forbidden.

def api_rate_limit_ok(token_hash: str) -> bool:
    """Requests per API token (60s sliding window). Delegates to the limiter."""
    return _CTX.rate_limiter.api_allowed(token_hash)


def login_rate_limit_ok(ip: str) -> bool:
    """Login attempts per client IP (60s sliding window). Delegates to the
    limiter. bcrypt (12 rounds) already slows brute-forcing; this caps attempts."""
    return _CTX.rate_limiter.login_allowed(ip)


def _safe_int(value, default: int = 0) -> int:
    """Tolerant int(): returns `default` instead of raising on a non-numeric
    input (forged Content-Length, invalid JSON field, etc.)."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


# ─── Git helpers ───────────────────────────────────────────────────────────────


def git(*args, cwd=None, check=False, timeout=60):
    """Run a git command in the mind repo. Delegation seam to the GitSync service."""
    return _CTX.git_sync.run(*args, cwd=cwd, check=check, timeout=timeout)


def _mask_url(s: str) -> str:
    return re.sub(r"://[^@\s]+@", "://***@", s or "")


# ─── Update check (admin Settings banner) ──────────────────────────────────────
# Compares the running version to the latest on PyPI. This is the ONLY outbound
# call the engine makes on its own: admin-only, cached ~1 day, best-effort, and
# disabled when CONFIG.update_check is False.

def current_version():
    """Running atlas-mind version, in both install modes. Installed → package
    metadata; source run → parse __version__ from the sibling __init__.py."""
    try:
        from importlib.metadata import version
        return version("atlas-mind")
    except Exception:
        pass
    try:
        # The atlas_mind package __init__ (src/__init__.py) holds __version__,
        # two levels up from this server sub-package.
        init = (Path(__file__).resolve().parent.parent / "__init__.py").read_text(encoding="utf-8")
        match = re.search(r'__version__\s*=\s*"([^"]+)"', init)
        if match:
            return match.group(1)
    except OSError:
        pass
    return None


def latest_pypi_version():
    """Latest atlas-mind version on PyPI (cached). Delegates to the checker."""
    return _CTX.update_checker.latest()


def ensure_repo_cloned(root: Path) -> bool:
    """Clone the repo into `root` if not present. Cloud mode only.

    Reads GITHUB_REPO_URL from the env (not CONFIG: atlas.toml lives INSIDE the
    not-yet-existing clone). Returns True on a fresh clone — run() then sets the
    git identity."""
    if (root / ".git").exists():
        return False
    repo_url = os.environ.get("GITHUB_REPO_URL")
    if not repo_url:
        sys.exit("FATAL: GITHUB_REPO_URL missing to clone the mind (cloud mode)")
    root.parent.mkdir(parents=True, exist_ok=True)
    try:
        result = subprocess.run(
            ["git", "clone", repo_url, str(root)],
            capture_output=True,
            text=True,
            timeout=120,
        )
    except subprocess.TimeoutExpired:
        # Without a timeout, a slow GitHub at boot hung the server indefinitely
        # (silent Fly restart loop). Fail outright instead.
        sys.exit("git clone timed out after 120s")
    if result.returncode != 0:
        print(
            f"git clone failed (exit {result.returncode}):\n"
            f"{_mask_url(result.stderr)}",
            file=sys.stderr,
        )
        sys.exit(1)
    return True


def pull_and_rebuild():
    """Commit pending edits, pull --rebase, rebuild, push. Delegates to GitSync."""
    _CTX.git_sync.pull_and_rebuild()


def git_pull_loop():
    """Fallback periodic pull (the webhook does instant sync when active).

    Piggybacks a resync of subscribed remote nodes at the same cadence — a
    refreshed mirror triggers an index rebuild so it shows up."""
    while True:
        time.sleep(CONFIG.git_pull_interval)
        _CTX.git_sync.pull_and_rebuild()
        try:
            if _CTX.remote_sync.sync_all():
                _CTX.git_sync.trigger_sync()
        except Exception as e:
            print(f"[git_pull_loop] remote sync error: {e}", file=sys.stderr, flush=True)


def _graceful_flush(signum, frame):
    """SIGTERM (Fly before a stop/redeploy) → flush git before dying.

    The Fly rootfs is ephemeral: a write on local disk but not yet pushed is lost
    if the machine is recreated. trigger_sync pushes in the background, but a
    redeploy landing in that window would cut the daemon thread. Here we push
    pending changes DURING the grace period, closing that durability gap."""
    print("[shutdown] SIGTERM -> flushing git (commit + push) before exit", flush=True)
    try:
        _CTX.git_sync.pull_and_rebuild()
    except Exception as e:
        print(f"[shutdown] flush error: {e}", file=sys.stderr, flush=True)
    finally:
        sys.exit(0)


def trigger_sync():
    """Background commit + push of local edits (todos / file PUT). Delegates to
    GitSync."""
    _CTX.git_sync.trigger_sync()


def commit_change(ctx, subject, *paths, ai=None):
    """Attributed commit of ONE content action then a background push: `paths` are the
    absolute files it touched (doc + side effects), `subject` the commit summary, `ctx`
    the actor, `ai` its self-reported AI family (MCP only → the ai/<family> trailer).
    Falls back to the anonymous trigger_sync backstop when the actor is unknown or the
    attributed commit errors — the content is already on disk, so a git hiccup must
    never fail the caller's write."""
    from server.pure import acl
    author, trailers = acl.attribution_for(ctx, ai=ai)
    if author is None and not trailers:      # anonymous / local / system → backstop
        _CTX.git_sync.trigger_sync()
        return
    try:
        rel = [Path(p).resolve().relative_to(CONFIG.root).as_posix() for p in paths]
        _CTX.git_sync.commit_change(subject, rel, author=author, trailers=trailers)
    except Exception as e:
        print(f"[commit_change] {e}", file=sys.stderr, flush=True)
        _CTX.git_sync.trigger_sync()         # content is on disk; let the backstop catch it


def _clean_subject(text, limit=100):
    """Collapse free-form text (an AI commit_message, a task label) into a single,
    length-capped line — so it can't break the commit subject or inject a trailer."""
    return " ".join((text or "").split())[:limit]


# Only the legacy-format migration stays here (boot-time IO); todos/notes are
# re-exported above.


def migrate_legacy_format():
    if not CONFIG.todo_file.exists():
        return
    text = CONFIG.todo_file.read_text(encoding="utf-8")
    if re.search(r"^- \[[ xX]\]", text, re.MULTILINE):
        return
    blocks = re.split(r"^## \d{4}-\d{2}-\d{2} \d{2}:\d{2}\s*$", text, flags=re.MULTILINE)
    todos = []
    for block in blocks[1:]:
        first = block.strip().split("\n", 1)[0].strip()
        if first:
            todos.append({"text": first, "done": False})
    if todos:
        write_todos([{"id": i, **t} for i, t in enumerate(todos)])


# Live reload (local-dev): SSE fan-out + dist/index.html watcher live in the
# ReloadHub service; run() starts reload_hub.watch_loop as a daemon thread.


from server.render.i18n import _strings, _t  # noqa: F401
from server.render.pages import (  # noqa: F401
    _load_page, render_page, share_extension_assets,
)


def _import_build():
    """Imports (and caches) the ENGINE's build.py.

    ALWAYS the engine's own build.py (engine src/ on sys.path), NEVER any
    src/build.py present in the cloned mind — else a historical repo with the old
    embedded engine would run old code on the new image (clone↔image shadowing).
    Configured exclusions are injected into build.EXCLUDED_NAMES (single source)."""
    import build as _build
    _build.EXCLUDED_NAMES = CONFIG.excluded_names
    return _build


def _validate_doc_path(rel: str):
    """Resolve+validate a doc path inside CONFIG.content_root (None if invalid).
    Injects the content root into docs.validate_doc_path."""
    return docs.validate_doc_path(rel, CONFIG.content_root)


def _iter_doc_files():
    """Yields (relative_path, Path) for each doc tracked by the viewer (.md + .html).
    Injects the content root + build exclusions into docs.iter_doc_files."""
    return docs.iter_doc_files(CONFIG.content_root, _import_build().EXCLUDED_NAMES)


# ─── Subscriptions: read-only mirror of remote nodes (hive, #10 B) ───────


def sync_remote(remote: dict) -> dict:
    """Pull one remote node's manifest + delta into remotes/<name>/. Delegates to
    the RemoteSync service."""
    return _CTX.remote_sync.sync_one(remote)


def sync_all_remotes() -> bool:
    """Resync all subscriptions (periodic loop). Delegates to the RemoteSync
    service."""
    return _CTX.remote_sync.sync_all()


from server.render.search_cache import _doc_entry, _DOC_CACHE  # noqa: F401
from server.render.mcp_tools import _mcp_tools  # noqa: F401


def _move_md_with_relink(src_rel: str, dst_rel: str):
    """Move a .md/.html and rewrite the incoming [[wikilinks]] that target it.
    Injects the content root + build module into docs.move_md_with_relink."""
    return docs.move_md_with_relink(src_rel, dst_rel, CONFIG.content_root, _import_build())


from server.app.handler import Handler  # noqa: E402


# ─── Bootstrap ─────────────────────────────────────────────────────────────────


def _seed_dev_admin() -> None:
    """Dev sandbox only: create a known admin (dev@local / dev) if none exists so
    /login works immediately. Skipped with ATLAS_DEV_FRESH=1 (to exercise the
    first-boot /setup flow). Best-effort — a failure does not block boot."""
    try:
        registry = get_store()
        if registry.has_admin():
            return
        registry.upsert_user("dev@local", {
            "password_hash": store.hash_password("dev"),
            "role": "admin",
            "created_at": int(time.time()),
        })
        print("[dev] seeded admin  ->  login at /login with  dev@local / dev",
              file=sys.stderr, flush=True)
    except Exception as e:
        print(f"[dev] could not seed admin: {e}", file=sys.stderr, flush=True)


def run() -> None:
    """Boot the server: resolve the mind, (cloud) clone + secret guard, load the
    config, start the background threads and serve forever. Invoked by
    `python -m server` (see __main__); a plain `import server` never triggers it."""
    global CONFIG, _CTX
    # The clone can only depend on the env: atlas.toml lives INSIDE the mind,
    # which doesn't exist yet on the cloud side here.
    mind_root = resolve_mind_root()
    freshly_cloned = False
    if os.environ.get("KB_AUTH_ENABLED"):
        # Fail-fast BEFORE the clone on an explicitly empty/default SESSION_SECRET,
        # so a Fly restart loop doesn't pay for a full clone before dying. A secret
        # ABSENT from the env is still accepted here — atlas.toml (inside the clone)
        # may provide it; the full guard after AtlasConfig.load is the authority.
        env_secret = os.environ.get("SESSION_SECRET")
        if env_secret is not None and env_secret in ("", "dev-secret-change-me"):
            sys.exit(
                "FATAL: SESSION_SECRET not set in cloud mode (KB_AUTH_ENABLED=1).\n"
                "  fly secrets set SESSION_SECRET=$(python3 -c \"import secrets;print(secrets.token_hex(32))\")"
            )
        freshly_cloned = ensure_repo_cloned(mind_root)

    # Config built HERE and nowhere else: after the clone, so <mind>/atlas.toml
    # is readable. Everything derived goes through CONFIG.
    try:
        CONFIG = AtlasConfig.load(root=mind_root)
    except AtlasConfigError as e:
        sys.exit(f"FATAL: {e}")

    if CONFIG.auth_enabled:
        # Refuse to start in cloud with the default secret: it is public →
        # forgeable session AND share tokens = total auth bypass. Crash instead.
        if not CONFIG.session_secret or CONFIG.session_secret == b"dev-secret-change-me":
            sys.exit(
                "FATAL: SESSION_SECRET not set in cloud mode (KB_AUTH_ENABLED=1).\n"
                "  fly secrets set SESSION_SECRET=$(python3 -c \"import secrets;print(secrets.token_hex(32))\")"
            )

    # Build the application context (config + store + services) now that CONFIG is
    # final and the secret guard has passed; the HTTP server carries it. Built
    # BEFORE the cold-start git identity + rebuild below (which go through
    # _CTX.git_sync).
    _CTX = AppContext.build(CONFIG, build_store(CONFIG))

    if CONFIG.auth_enabled:
        # Set always (idempotent): a checkout restored from the volume may lack it.
        git("config", "user.email", CONFIG.git_author_email)
        git("config", "user.name", CONFIG.git_author_name)
        if not freshly_cloned:
            # Repo persisted on the volume: refresh now instead of waiting for the pull
            # loop. Best-effort — a slow/offline remote must not block boot.
            try:
                git("pull", "--rebase", "--autostash", "--quiet", timeout=30)
            except Exception as e:
                print(f"[boot] git pull skipped: {e}", file=sys.stderr, flush=True)
        _CTX.git_sync.build()

    # Mind's server extensions, loaded once at boot. A broken one is reported on
    # stderr and ignored — the server still starts.
    load_server_extensions(CONFIG, _CTX.extension_routes)

    # First-boot (cloud): if no admin exists, generate+print a setup token to open
    # the /setup window. The dev sandbox seeds a known admin first (unless
    # ATLAS_DEV_FRESH=1), making maybe_init a no-op.
    if CONFIG.auth_enabled:
        if CONFIG.dev_mode and not os.environ.get("ATLAS_DEV_FRESH"):
            _seed_dev_admin()
        maybe_init_setup_token()

    os.chdir(CONFIG.root)
    migrate_legacy_format()
    threading.Thread(target=_CTX.reload_hub.watch_loop, args=(CONFIG,), daemon=True).start()
    if CONFIG.dev_mode:
        # Dev sandbox: rebuild the viewer when its sources change for a real
        # edit-and-see loop (the rebuilt dist/index.html drives watch_loop's
        # browser reload). Dev-only: cloud/prod builds once at boot / on pull.
        threading.Thread(
            target=_CTX.reload_hub.watch_sources_loop,
            args=(CONFIG, _CTX.git_sync.build), daemon=True).start()
    if CONFIG.auth_enabled and not CONFIG.dev_mode:
        # The dev sandbox NEVER pulls/pushes (would touch prod's GitHub repo): skip
        # the periodic pull loop AND the SIGTERM git-flush.
        threading.Thread(target=git_pull_loop, daemon=True).start()
        # Flush unpushed writes when Fly stops the machine (deploy/scale).
        signal.signal(signal.SIGTERM, _graceful_flush)

    # Dev sandbox + local both bind loopback; only real cloud listens on 0.0.0.0.
    # ATLAS_BIND overrides this (docker dev sets it to 0.0.0.0 so the host port
    # map — pinned to 127.0.0.1 — can reach the container).
    bind = CONFIG.bind_host or (
        "0.0.0.0" if (CONFIG.auth_enabled and not CONFIG.dev_mode) else "127.0.0.1")
    mode = "dev sandbox" if CONFIG.dev_mode else ("cloud" if CONFIG.auth_enabled else "local")
    print(f"{CONFIG.site_name} ({mode}) : http://{bind}:{CONFIG.port}")
    if not CONFIG.auth_enabled:
        # Only local mode uses the single git-versioned todo file; cloud/dev store
        # todos per-account in .atlas/todos.json, so there is no single file to show.
        try:
            todo_display = CONFIG.todo_file.relative_to(CONFIG.root)
        except ValueError:
            # An absolute [todo].file outside the mind: show as-is, don't kill boot.
            todo_display = CONFIG.todo_file
        print(f"Todo -> {todo_display}")
    print("Ctrl+C to stop")
    try:
        AtlasHTTPServer((bind, CONFIG.port), _CTX, Handler).serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        sys.exit(0)
