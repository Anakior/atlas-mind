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

# The intra-package imports below are FLAT (`from server.X import …`,
# `import server as _s`, `import store`/`config`/`build`) so the very same code
# runs under both entry points. This must be bootstrapped BEFORE the first flat
# import:
#   • put this package's parent dir on sys.path so `server`/`store`/`config`/
#     `build` resolve under `python -m atlas_mind.server` (the pip-installed prod
#     entry, whose package dir is NOT on the path) as well as `python -m server`
#     (dev/tests, engine src already on PYTHONPATH);
#   • alias this module as the flat `server`, so a `from server.X import` binds to
#     THIS module rather than importing — and double-executing — the package under
#     a second name.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.modules.setdefault("server", sys.modules[__name__])

from server.constants import (  # noqa: F401
    COOKIE_NAME, CSRF_COOKIE_NAME, MAX_BODY_BYTES, _EMAIL_PATTERN, MAX_EMAIL_LEN,
    MAX_TOKEN_LABEL_LEN, API_ROLE, NODE_LINK_PREFIX, REMOTES_DIR,
    MAX_NODE_FILE_BYTES, PROJECT_URL, _GIT_REV_RE, MCP_PROTOCOL_VERSION,
    _SHARE_ID_DELETE_PATTERN,
)


import store  # identity/share registry: FileStore (JSON under .atlas/)
from config import AtlasConfig, AtlasConfigError, resolve_mind_root

# WHITE-BOX TEST CONTRACT — tests/test_admin.py imports server._is_newer and
# server._evict_stale_buckets; keep these two re-exports for the life of the package.
from server.services.rate_limit import _evict_stale_buckets  # noqa: F401
from server.services.update_check import _is_newer, _version_tuple  # noqa: F401

from server.context import AppContext, AtlasHTTPServer
from server.pure import docs  # document-domain logic (path validation / traversal / move)

# The SINGLE server configuration object (paths, port, auth, todos, store…).
# Built in __main__ — after the possible clone in cloud mode, so that
# <mind>/atlas.toml is readable at read time. No more reassignment of derived
# globals: everything goes through CONFIG (env > toml > defaults,
# see src/config.py).
CONFIG = None  # type: AtlasConfig
# The application context (config + services), built once by run() and carried by
# AtlasHTTPServer (self.server.context). The migration moves readers off the
# module globals onto it, one concern at a time — see plan-appcontext.
_CTX = None  # type: AppContext

from server.pure.todos_md import (  # noqa: F401
    TODO_HEADER, _norm_cat, parse_todos, write_todos, load_todos,
)
from server.pure.notes_md import _notes_path, load_notes, save_notes  # noqa: F401
from server.pure.auth import (  # noqa: F401  token/CSRF/share/bearer crypto + identity
    _has_control_chars, is_valid_email, _b64url_nopad, _b64url_nopad_decode,
    current_session_epoch, make_token, verify_token, authenticate_user, authenticate,
    make_share_token, verify_share_token, make_csrf_token, verify_csrf_token,
    consume_recovery_code, _hash_api_token, verify_api_bearer, _verify_mcp_token,
)
from server.pure.docs import (  # noqa: F401  tree ACL / git-history / live tasks / search text
    _path_hidden, _filter_tree, _valid_git_rev, _doc_path_history, _doc_path_at,
    _live_tasks_index, _normalize_text, _html_to_text, _HTML_BLOCK_RE,
)
from server.pure.hive import (  # noqa: F401  federation node links / mirror / fetch
    encode_node_link, decode_node_link, verify_node_bearer, _validate_node_path,
    _iter_node_files, _remote_mirror_root, _is_readonly_path, _is_safe_node_name,
    _mirror_is_under_remotes, _atomic_write_bytes, _is_blocked_ip, _validate_remote_url,
    _http_get_bearer, _prune_empty_dirs,
)
from server.pure.mcp_call import (  # noqa: F401  MCP dispatch + graph/tag/trash/search
    _doc_corpus, _links_graph, _tags_for, _soft_delete, _api_search, _api_recent,
    _mcp_call_tool, _mcp_jsonrpc,
)
from server.extensions import load_server_extensions  # noqa: F401


def _exclude_store_dir_from_git(store_dir):
    """Adds the registry directory to .git/info/exclude (idempotent).

    The registry (password hashes, api_token_hash, SHA256 of share-tokens)
    lives by default under ROOT/.atlas — INSIDE the content git repo that
    trigger_sync/pull_and_rebuild commit via `git add -A` then push to GitHub.
    Without exclusion, these derived secrets enter the git history forever (and
    state.json, rewritten on every Bearer request, generates commit churn).
    Belt AND braces with the .gitignore "*" that FileStore writes in its own
    directory. Best-effort: a failure does not block the boot."""
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
    """Build the identity/share registry (FileStore, see src/store.py) and
    best-effort exclude its directory from git — it holds password/token hashes
    and must never be committed/pushed. Called once from run().

    config.store_dir: registry location, default <mind>/.atlas (overridden by env
    ATLAS_STORE_DIR or atlas.toml). In cloud, point it at a persistent volume
    outside the repo (the Fly rootfs is ephemeral AND the content repo must not
    carry credentials); without a volume, cloud LOSES users/shares on every
    machine recreation — the registry is deliberately never committed/pushed."""
    st = store.FileStore(config.store_dir)
    _exclude_store_dir_from_git(config.store_dir)
    return st


def get_store():
    """The identity/share registry (FileStore). Single delegation seam to the
    AppContext — the call sites read it unchanged."""
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


# ─── API Bearer auth (for external connectors: Claude.ai, MCP, etc.) ───
#
# The /api/v1/* endpoints are protected by a Bearer token independent of the
# cookie system. The token is stored in the registry as a SHA256 hash on the
# claude@api.local user.
#
# Permissions of the 'api' role via REST /api/v1: read (search/file GET/tree/recent)
# + create (POST /api/v1/file refuses overwriting). Any other operation (DELETE,
# PUT edit, move, share, todos) returns 403, even with a valid token.
# Note: the MCP (/mcp/<token>) additionally exposes editing (edit_doc) because
# Claude first reads the doc then amends it; REST overwriting stays forbidden.

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
    """Run a git command in the mind repo. Single delegation seam to the GitSync
    service — the history/diff/config call sites read it unchanged."""
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
        # The atlas_mind package __init__ (src/__init__.py) holds __version__;
        # from this server sub-package that is two levels up.
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
    """Clone the repo into `root` if not already present. Cloud mode only.

    Reads GITHUB_REPO_URL from the env (not CONFIG: atlas.toml lives INSIDE the
    clone, it does not exist yet at this stage). Returns True if a fresh clone
    happened — __main__ then sets the git identity (CONFIG.git_author_*)."""
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
        # Without a timeout, a GitHub slow at boot hung the server indefinitely →
        # a silent Fly restart loop. We fail outright instead.
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

    Piggyback: we also resync the subscribed remote nodes at the same cadence —
    a refreshed mirror triggers an index rebuild so it shows up. Orchestrates the
    GitSync (+ remote sync) services; the per-concern state lives in them."""
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

    The Fly rootfs is ephemeral: a write present on the local disk but not yet
    pushed to GitHub would be lost if the machine is recreated with a fresh
    rootfs. trigger_sync pushes in the background, but a redeploy landing right
    in that window would cut the daemon thread. Here we push the pending changes
    DURING the grace period (kill_timeout in deploy/fly.toml.example), closing the
    only durability gap that neither the pull loop nor the non-suspend covers
    (deploy/migration during the not-yet-pushed window)."""
    print("[shutdown] SIGTERM -> flushing git (commit + push) before exit", flush=True)
    try:
        _CTX.git_sync.pull_and_rebuild()
    except Exception as e:
        print(f"[shutdown] flush error: {e}", file=sys.stderr, flush=True)
    finally:
        sys.exit(0)


def trigger_sync():
    """Background commit + push of local edits (todos / file PUT). Delegates to the
    GitSync service."""
    _CTX.git_sync.trigger_sync()


# Todos (pure/todos_md.py) and pass-through annotations (pure/notes_md.py) are
# re-exported above. Only the legacy-format migration stays here (boot-time IO).


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


# Live reload (local-dev): the SSE fan-out + the dist/index.html watcher both live
# in the ReloadHub service; run() starts reload_hub.watch_loop as a daemon thread.


from server.render.i18n import _strings, _t  # noqa: F401
from server.render.pages import (  # noqa: F401
    _load_page, render_page, share_extension_assets,
)


def _import_build():
    """Imports (and caches) the ENGINE's build.py.

    The engine is self-contained: we ALWAYS import its own build.py (the engine's
    src/ is on sys.path, placed at the top of this module), NEVER any
    src/build.py that might be present in the cloned mind — otherwise a historical
    repo with the old embedded engine would run old code on the new image
    (clone↔image shadowing). The configured exclusions are injected into the
    module, the single source of truth consumed here (build.EXCLUDED_NAMES)."""
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
    """Dev sandbox only: create a known admin (dev@local / dev) if none exists, so
    /login works immediately. Skipped with ATLAS_DEV_FRESH=1 (to exercise the
    first-boot /setup flow instead). Best-effort — a failure does not block boot."""
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
    # Any clone can only depend on the env: atlas.toml lives INSIDE the mind,
    # which does not yet exist on the cloud side at this point.
    mind_root = resolve_mind_root()
    freshly_cloned = False
    if os.environ.get("KB_AUTH_ENABLED"):
        # Fail-fast BEFORE the clone when the env EXPLICITLY carries an empty or
        # default SESSION_SECRET: otherwise each iteration of the Fly restart
        # loop would pay for a full clone (network, PAT, disk write) before
        # dying on the guard below. A SESSION_SECRET absent from the env is
        # still accepted at this point: atlas.toml (which lives INSIDE the
        # clone) can provide it — the full guard after AtlasConfig.load remains
        # the authority.
        env_secret = os.environ.get("SESSION_SECRET")
        if env_secret is not None and env_secret in ("", "dev-secret-change-me"):
            sys.exit(
                "FATAL: SESSION_SECRET not set in cloud mode (KB_AUTH_ENABLED=1).\n"
                "  fly secrets set SESSION_SECRET=$(python3 -c \"import secrets;print(secrets.token_hex(32))\")"
            )
        freshly_cloned = ensure_repo_cloned(mind_root)

    # The config is built HERE, and nowhere else: after the clone, so that
    # <mind>/atlas.toml is readable. No more reassignment of path globals —
    # everything derived from it goes through CONFIG.
    try:
        CONFIG = AtlasConfig.load(root=mind_root)
    except AtlasConfigError as e:
        sys.exit(f"FATAL: {e}")

    if CONFIG.auth_enabled:
        # Refuse to start in cloud with the default secret: it is public (in
        # this file) → forgeable session AND share tokens = total auth bypass.
        # Better to crash than to run wide open.
        if not CONFIG.session_secret or CONFIG.session_secret == b"dev-secret-change-me":
            sys.exit(
                "FATAL: SESSION_SECRET not set in cloud mode (KB_AUTH_ENABLED=1).\n"
                "  fly secrets set SESSION_SECRET=$(python3 -c \"import secrets;print(secrets.token_hex(32))\")"
            )

    # Build the application context (config + store + services) now that CONFIG is
    # final and the secret guard has passed; the HTTP server carries it, and
    # get_store() / GitSync / the extensions / maybe_init read it. Built BEFORE the
    # cold-start git identity + rebuild below, which now go through _CTX.git_sync.
    _CTX = AppContext.build(CONFIG, build_store(CONFIG))

    if CONFIG.auth_enabled:
        if freshly_cloned:
            # The bot's git identity is set on the fresh clone only (as before);
            # the values come from CONFIG (historical defaults).
            git("config", "user.email", CONFIG.git_author_email)
            git("config", "user.name", CONFIG.git_author_name)
        # Rebuild the viewer on cold start in case the cloned repo is fresh.
        _CTX.git_sync.build()

    # The mind's server extensions: loaded once at boot into the context's route
    # list. A broken extension is reported on stderr and ignored — the server
    # still starts.
    load_server_extensions(CONFIG, _CTX.extension_routes)

    # First-boot (cloud mode): if no admin exists, generate and print a setup
    # token, opening the /setup window to create the first admin. In the dev
    # sandbox we seed a known admin first (unless ATLAS_DEV_FRESH=1) so /login works
    # right away; maybe_init then no-ops (an admin already exists).
    if CONFIG.auth_enabled:
        if CONFIG.dev_mode and not os.environ.get("ATLAS_DEV_FRESH"):
            _seed_dev_admin()
        maybe_init_setup_token()

    os.chdir(CONFIG.root)
    migrate_legacy_format()
    threading.Thread(target=_CTX.reload_hub.watch_loop, args=(CONFIG,), daemon=True).start()
    if CONFIG.dev_mode:
        # Dev sandbox: rebuild the viewer when its sources (partials/js/css/pages)
        # change, so `atlas-dev-cloud` is a real edit-and-see loop. The rebuild
        # updates dist/index.html, which watch_loop() above turns into a browser
        # reload. Dev-only: in cloud/prod the viewer is built once at boot / on pull.
        threading.Thread(
            target=_CTX.reload_hub.watch_sources_loop,
            args=(CONFIG, _CTX.git_sync.build), daemon=True).start()
    if CONFIG.auth_enabled and not CONFIG.dev_mode:
        # The dev sandbox NEVER pulls/pushes (it would touch prod's GitHub repo):
        # skip the periodic pull loop AND the SIGTERM git-flush entirely.
        threading.Thread(target=git_pull_loop, daemon=True).start()
        # Flush unpushed writes when Fly stops the machine (deploy/scale).
        signal.signal(signal.SIGTERM, _graceful_flush)

    # Dev sandbox + local both bind loopback; only real cloud listens on 0.0.0.0.
    bind = "0.0.0.0" if (CONFIG.auth_enabled and not CONFIG.dev_mode) else "127.0.0.1"
    mode = "dev sandbox" if CONFIG.dev_mode else ("cloud" if CONFIG.auth_enabled else "local")
    print(f"{CONFIG.site_name} ({mode}) : http://{bind}:{CONFIG.port}")
    try:
        todo_display = CONFIG.todo_file.relative_to(CONFIG.root)
    except ValueError:
        # [todo].file absolute and outside the mind (supported by AtlasConfig):
        # displayed as-is instead of killing the boot on the relative_to.
        todo_display = CONFIG.todo_file
    print(f"Todo -> {todo_display}")
    print("Ctrl+C to stop")
    try:
        AtlasHTTPServer((bind, CONFIG.port), _CTX, Handler).serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        sys.exit(0)
