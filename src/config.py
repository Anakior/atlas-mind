"""AtlasConfig: the single configuration object of the Atlas engine.

Eliminates the historical trap of server.py's path globals (computed at import
time from __file__ then reassigned one by one in __main__ in cloud mode) and
DECOUPLES the engine (src/ + web/) from the mind (the content directory).

Sources, in order of priority:
  1. environment variables (PORT, KB_AUTH_ENABLED, SESSION_SECRET,
     GIT_PULL_INTERVAL, GITHUB_WEBHOOK_SECRET, ATLAS_TRUSTED_IP_HEADER,
     ATLAS_STORE, ATLAS_STORE_DIR, GITHUB_REPO_URL)
  2. <mind>/atlas.toml (optional, tomllib — stdlib)
  3. defaults = the EXACT historical values from server.py / build.py

Mind resolution (resolve_mind_root):
  - explicit argument to AtlasConfig.load(root=...)
  - env ATLAS_MIND
  - historical behavior: KB_REPO_PATH (default /app/repo) if KB_AUTH_ENABLED,
    otherwise the parent of src/ (the engine repo itself).

atlas.toml format (all keys optional):

    prefix = "Acme"            # optional prefix in front of the fixed "Atlas Mind"
                               # brand ("Acme" → "Acme Atlas Mind", empty → "Atlas")
    tagline = "Personal knowledge base."
    lang = "en"                # "en" or "fr" (consumed by the i18n phase)

    [server]
    port = 8765
    auth_enabled = false
    session_secret = "..."
    git_pull_interval = 300
    github_webhook_secret = "..."
    trusted_ip_header = "CF-Connecting-IP"  # client IP header behind a proxy
                                            # (list → last element, the only one
                                            # set by the trusted proxy)

    [store]
    kind = "file"             # local JSON registry under .atlas (no database)
    dir = ".atlas"            # relative to the mind, or absolute

    [git]
    author_name = "Atlas Bot"
    author_email = "atlas-bot@example.com"
    repo_url = "..."

    [todo]
    file = "notes/quick.md"            # relative to content/, or absolute
    categories = ["work", "personal"]  # the first is the default category

    [build]
    excluded_names = ["drafts", "quick.md"]
"""
from pathlib import Path
import difflib
import os
import re
import sys
import tomllib

# The installed package directory (src/, a.k.a. the `atlas_mind` package): holds
# the engine code AND the bundled assets (web/, templates/) so a pip wheel is
# self-contained. ENGINE_ROOT is its parent (the repo root when run from source).
PACKAGE_DIR = Path(__file__).resolve().parent
ENGINE_ROOT = PACKAGE_DIR.parent

CONFIG_FILENAME = "atlas.toml"

# "Atlas Mind" is THE BRAND: fixed, always present, styled by the viewer and the
# login page ("Atlas" as display, "Mind" as suffix). The user only configures an
# optional PREFIX (root key `prefix` in atlas.toml):
# "Acme" → "Acme Atlas Mind", empty → "Atlas Mind".
SITE_WORDMARK = "Atlas Mind"
DEFAULT_SITE_PREFIX = ""
DEFAULT_TAGLINE = "Personal knowledge base."
DEFAULT_LANG = "en"
VALID_LANGS = ("fr", "en")

# Defaults = exact historical values.
DEFAULT_PORT = 8765
DEFAULT_SESSION_SECRET = "dev-secret-change-me"
# Session cookie lifetime (seconds). 30 days: a compromise between convenience
# (not having to log in again every day) and the exposure window of a stolen
# cookie. Replaces the former "~10 years" (equivalent to a lifelong session).
# The real invalidation control remains the server-side session epoch
# (logout-all / password reset / TOTP change bump the epoch).
DEFAULT_SESSION_MAX_AGE = 30 * 86400
DEFAULT_GIT_PULL_INTERVAL = 300
DEFAULT_STORE_KIND = "file"
DEFAULT_KB_REPO_PATH = "/app/repo"
DEFAULT_GIT_AUTHOR_NAME = "Atlas Bot"
DEFAULT_GIT_AUTHOR_EMAIL = "atlas-bot@example.com"
DEFAULT_TODO_FILE = "notes/quick.md"
DEFAULT_TODO_CATEGORIES = ("work", "personal")
DEFAULT_EXCLUDED_NAMES = frozenset({"quick.md"})


class AtlasConfigError(Exception):
    """Invalid configuration (malformed atlas.toml, value of the wrong type...).

    Always carries an actionable message: callers (server.py, build.py) turn it
    into a readable fatal exit, never into a silent crash."""


VALID_STORE_KINDS = ("file",)

# Recognized atlas.toml keys, per section ("" = document root).
# The root keys carry the instance identity (configurable branding).
_KNOWN_TOML_KEYS = {
    "server": frozenset({"port", "auth_enabled", "session_secret",
                         "session_max_age", "git_pull_interval",
                         "github_webhook_secret", "trusted_ip_header",
                         "allow_private_remotes", "update_check"}),
    "store": frozenset({"kind", "dir"}),
    "git": frozenset({"author_name", "author_email", "repo_url"}),
    "todo": frozenset({"file", "categories"}),
    "build": frozenset({"excluded_names"}),
}
_KNOWN_TOML_TOP_LEVEL = (frozenset({"prefix", "tagline", "lang"})
                         | frozenset(_KNOWN_TOML_KEYS))

# Keys renamed over versions: difflib would never match "site_name" to "prefix"
# (no useful common letters), so the unknown-key warning points explicitly to
# the replacement.
_RENAMED_TOML_KEYS = {"site_name": "prefix"}


def _slugify(value: str) -> str:
    """Machine slug derived from the site_name (MCP serverInfo name): lowercase,
    runs of non-alphanumeric characters → '-'. Never empty (falls back to
    'atlas')."""
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or "atlas"


def _warn_unknown_toml_keys(data: dict) -> None:
    """Reports on stderr (non-fatal) any unknown atlas.toml section or key: a
    typo (auth_enable, [sever]...) must never be silently ignored — the user
    would believe their config was applied. A warning and not an error, so that
    an atlas.toml written for a newer engine remains usable (forward
    compatibility)."""
    def warn(label: str, unknown: str, known) -> None:
        renamed = _RENAMED_TOML_KEYS.get(unknown)
        suggestion = ([renamed] if renamed
                      else difflib.get_close_matches(unknown, sorted(known), n=1))
        hint = f" (did you mean {suggestion[0]!r}?)" if suggestion else ""
        print(f"atlas.toml: unknown {label} ignored{hint}", file=sys.stderr)

    for key, value in data.items():
        if key not in _KNOWN_TOML_TOP_LEVEL:
            label = f"section [{key}]" if isinstance(value, dict) else f"key {key}"
            warn(label, key, _KNOWN_TOML_TOP_LEVEL)
            continue
        known_keys = _KNOWN_TOML_KEYS.get(key)
        if known_keys is None or not isinstance(value, dict):
            continue  # known scalar key, or malformed table (_table will raise)
        for sub_key in value:
            if sub_key not in known_keys:
                warn(f"key {key}.{sub_key}", sub_key, known_keys)


def resolve_mind_root(env=None) -> Path:
    """Root of the mind. Explicit ATLAS_MIND, otherwise historical behavior:
    KB_REPO_PATH (clone) if KB_AUTH_ENABLED, otherwise the parent of src/."""
    if env is None:
        env = os.environ
    explicit = env.get("ATLAS_MIND")
    if explicit:
        return Path(explicit).resolve()
    if env.get("KB_AUTH_ENABLED"):
        return Path(env.get("KB_REPO_PATH", DEFAULT_KB_REPO_PATH)).resolve()
    return ENGINE_ROOT


# ─── Typed readers (clear errors, never a silent crash) ────────────────────────


def _parse_int(raw, label: str) -> int:
    try:
        return int(raw)
    except (TypeError, ValueError):
        raise AtlasConfigError(f"{label} must be an integer (got {raw!r})")


def _table(data: dict, name: str) -> dict:
    value = data.get(name)
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise AtlasConfigError(
            f"atlas.toml: [{name}] must be a TOML table "
            f"(got {type(value).__name__})")
    return value


def _toml_str(table: dict, section: str, key: str, default: str) -> str:
    value = table.get(key)
    if value is None:
        return default
    if not isinstance(value, str):
        # empty section = atlas.toml root key (site_name, tagline, lang).
        label = f"{section}.{key}" if section else key
        raise AtlasConfigError(f"atlas.toml: {label} must be a string")
    return value


def _toml_int(table: dict, section: str, key: str, default: int) -> int:
    value = table.get(key)
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int):
        raise AtlasConfigError(f"atlas.toml: {section}.{key} must be an integer")
    return value


def _toml_bool(table: dict, section: str, key: str, default: bool) -> bool:
    value = table.get(key)
    if value is None:
        return default
    if not isinstance(value, bool):
        raise AtlasConfigError(f"atlas.toml: {section}.{key} must be a boolean")
    return value


def _toml_str_list(table: dict, section: str, key: str):
    """List of strings, or None if absent."""
    value = table.get(key)
    if value is None:
        return None
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise AtlasConfigError(
            f"atlas.toml: {section}.{key} must be a list of strings")
    return value


class AtlasConfig:
    """Resolved configuration (env > atlas.toml > defaults), frozen at construction.

    MIND-side paths: root, content_root, dist_dir, index_file, notes_dir,
    extensions_dir, todo_file, store_dir. ENGINE-side path: web_dir (viewer
    template + PWA assets), always the package's web/ (the engine ships it)."""

    def __init__(self, root, *, toml_data: dict = None, env=None):
        if env is None:
            env = os.environ
        data = toml_data or {}
        _warn_unknown_toml_keys(data)
        server = _table(data, "server")
        store = _table(data, "store")
        git = _table(data, "git")
        todo = _table(data, "todo")
        build = _table(data, "build")

        # ── paths ──────────────────────────────────────────────────────────
        self.root = Path(root).resolve()
        self.content_root = self.root / "content"
        self.dist_dir = self.root / "dist"
        self.index_file = self.dist_dir / "index.html"
        self.notes_dir = self.root / ".notes"
        # Extension hook (spec decision: two hooks, not a plugin system): FIXED
        # location relative to the mind. build.py discovers the *.css / *.js to
        # inline into the viewer there, server.py loads the *.py there at boot.
        # Missing directory = no extensions, behavior unchanged.
        self.extensions_dir = self.root / ".atlas" / "extensions"
        # Viewer assets ship inside the package (src/web) so a pip-installed wheel
        # is self-contained — always the package's web/, never the mind's.
        self.web_dir = PACKAGE_DIR / "web"

        # ── instance identity (configurable branding) ──────────────────────
        # The "Atlas" brand is FIXED (SITE_WORDMARK); only the prefix is
        # configurable. Empty (or blank) = no prefix → "Atlas" alone, the
        # <title>/manifest can never come out without a name.
        self.prefix = _toml_str(data, "", "prefix",
                                DEFAULT_SITE_PREFIX).strip()
        self.tagline = (_toml_str(data, "", "tagline", DEFAULT_TAGLINE).strip()
                        or DEFAULT_TAGLINE)
        self.lang = (_toml_str(data, "", "lang", DEFAULT_LANG).strip().lower()
                     or DEFAULT_LANG)
        if self.lang not in VALID_LANGS:
            # Injected into <html lang> and consumed by the i18n phase: an
            # unsupported language must fail clearly, not show up as broken
            # English later on.
            raise AtlasConfigError(
                f"lang must be 'fr' or 'en' (got {self.lang!r})")
        # Derived machine name (MCP serverInfo): "Acme Atlas" →
        # "acme-atlas", without a prefix → "atlas".
        self.site_slug = _slugify(self.site_name)

        # ── server ─────────────────────────────────────────────────────────
        if "PORT" in env:
            self.port = _parse_int(env["PORT"], "PORT (env)")
        else:
            self.port = _toml_int(server, "server", "port", DEFAULT_PORT)
        if not 0 <= self.port <= 65535:
            # Without this bound, the bind blows up later as a raw OverflowError
            # — exactly the crash AtlasConfigError promises to avoid.
            raise AtlasConfigError(
                f"PORT / server.port must be between 0 and 65535 "
                f"(got {self.port})")

        # Historical env semantics preserved: any NON-EMPTY value enables auth
        # (including "0"), an empty value disables it.
        if "KB_AUTH_ENABLED" in env:
            self.auth_enabled = bool(env["KB_AUTH_ENABLED"])
        else:
            self.auth_enabled = _toml_bool(server, "server", "auth_enabled", False)

        if "SESSION_SECRET" in env:
            secret = env["SESSION_SECRET"]
        else:
            secret = _toml_str(server, "server", "session_secret",
                               DEFAULT_SESSION_SECRET)
        self.session_secret = secret.encode()

        # Dev sandbox (ATLAS_DEV=1): turn the CLOUD features on locally (login,
        # setup, share, 2FA, admin…) while staying ISOLATED from prod — no git
        # push/pull (run() + GitSync gate on dev_mode), bound to 127.0.0.1, a fixed
        # non-default secret, and a seeded dev admin. NEVER set ATLAS_DEV in prod.
        self.dev_mode = bool(env.get("ATLAS_DEV"))
        if self.dev_mode:
            self.auth_enabled = True
            if secret in ("", DEFAULT_SESSION_SECRET):
                # A stable non-sentinel secret so sessions survive a restart and the
                # run() default-secret guard passes.
                self.session_secret = b"atlas-dev-sandbox-secret-not-for-production"

        if "SESSION_MAX_AGE" in env:
            self.session_max_age = _parse_int(env["SESSION_MAX_AGE"],
                                              "SESSION_MAX_AGE (env)")
        else:
            self.session_max_age = _toml_int(server, "server",
                                             "session_max_age",
                                             DEFAULT_SESSION_MAX_AGE)
        if self.session_max_age <= 0:
            # A cookie with Max-Age <= 0 would expire immediately (login loop);
            # we refuse rather than open an unusable instance.
            raise AtlasConfigError(
                f"SESSION_MAX_AGE / server.session_max_age must be positive "
                f"(got {self.session_max_age})")

        if "GIT_PULL_INTERVAL" in env:
            self.git_pull_interval = _parse_int(env["GIT_PULL_INTERVAL"],
                                                "GIT_PULL_INTERVAL (env)")
        else:
            self.git_pull_interval = _toml_int(server, "server",
                                               "git_pull_interval",
                                               DEFAULT_GIT_PULL_INTERVAL)
        if self.git_pull_interval < 0:
            # time.sleep(negative) would silently kill the git_pull_loop thread
            # (periodic sync lost in the cloud).
            raise AtlasConfigError(
                f"GIT_PULL_INTERVAL / server.git_pull_interval must be "
                f"positive or zero (got {self.git_pull_interval})")

        if "GITHUB_WEBHOOK_SECRET" in env:
            webhook_secret = env["GITHUB_WEBHOOK_SECRET"]
        else:
            webhook_secret = _toml_str(server, "server",
                                       "github_webhook_secret", "")
        self.github_webhook_secret = webhook_secret.encode()

        # Trusted header for the client IP behind a reverse proxy (login rate
        # limit). If it carries a list (X-Forwarded-For stacked by
        # nginx/Caddy), server.py takes the LAST element — the only one set by
        # the trusted proxy, the preceding ones being supplied by the client
        # (forgeable). None (default): on Fly, server.py trusts Fly-Client-IP
        # (platform-injected); otherwise it falls back to the socket peer and
        # does NOT trust client headers (a forgeable X-Forwarded-First would let
        # an attacker rotate it to bypass the login rate limit). Self-hosters
        # behind a proxy should set this header explicitly.
        # `or` semantics: an EMPTY env value falls back to atlas.toml.
        trusted_ip_header = (env.get("ATLAS_TRUSTED_IP_HEADER")
                             or _toml_str(server, "server",
                                          "trusted_ip_header", ""))
        self.trusted_ip_header = trusted_ip_header.strip() or None

        # Hive SSRF guard: by default a pasted node link may only point at
        # a PUBLIC host (the subscribe client refuses URLs resolving to
        # loopback/private/link-local/reserved addresses — cloud metadata,
        # internal services). Set this True to also allow localhost/LAN remotes
        # (home-lab hive between instances on a private network).
        allow_private_env = env.get("ATLAS_ALLOW_PRIVATE_REMOTES", "").strip()
        if allow_private_env:
            self.allow_private_remotes = allow_private_env.lower() in (
                "1", "true", "yes", "on")
        else:
            self.allow_private_remotes = _toml_bool(
                server, "server", "allow_private_remotes", False)

        # Update check: the admin Settings panel shows a discreet banner when a
        # newer atlas-mind is on PyPI. It is the ONLY outbound call the engine
        # makes on its own (cached ~1/day, admin-only, best-effort). Opt out to
        # disable that single network call entirely.
        update_check_env = env.get("ATLAS_UPDATE_CHECK", "").strip()
        if update_check_env:
            self.update_check = update_check_env.lower() in (
                "1", "true", "yes", "on")
        else:
            self.update_check = _toml_bool(
                server, "server", "update_check", True)

        # ── identity/share registry ────────────────────────────────────────
        # `or` (and not presence): an EMPTY env value falls back to the next
        # level — historical semantics of ATLAS_STORE / ATLAS_STORE_DIR.
        self.store_kind = (env.get("ATLAS_STORE")
                           or _toml_str(store, "store", "kind", "")
                           or DEFAULT_STORE_KIND).strip().lower()
        if self.store_kind not in VALID_STORE_KINDS:
            # Reject anything but 'file' explicitly: a typo must fail loudly at
            # boot rather than degrade into an unintelligible runtime error.
            raise AtlasConfigError(
                f"store.kind / ATLAS_STORE must be 'file' "
                f"(got {self.store_kind!r})")
        raw_store_dir = (env.get("ATLAS_STORE_DIR")
                         or _toml_str(store, "store", "dir", ""))
        self.store_dir = (self._mind_path(raw_store_dir) if raw_store_dir
                          else self.root / ".atlas")
        store_dir_resolved = self.store_dir.resolve()
        if store_dir_resolved == self.root:
            # FileStore would write its catch-all "*" .gitignore AT THE ROOT of
            # the content repo: all of content/ would become invisible to git,
            # and trigger_sync's git add -A would no longer push anything.
            raise AtlasConfigError(
                "store.dir / ATLAS_STORE_DIR cannot be the mind root "
                f"({self.store_dir}) — use a dedicated subfolder "
                "(e.g. .atlas) or a path outside the mind")
        if (store_dir_resolved == self.content_root
                or self.content_root in store_dir_resolved.parents):
            raise AtlasConfigError(
                "store.dir / ATLAS_STORE_DIR cannot live under content/ "
                f"({self.store_dir}) — the registry (password hashes, tokens) "
                "would be served and committed together with the content")

        # ── git ────────────────────────────────────────────────────────────
        self.git_author_name = _toml_str(git, "git", "author_name",
                                         DEFAULT_GIT_AUTHOR_NAME)
        self.git_author_email = _toml_str(git, "git", "author_email",
                                          DEFAULT_GIT_AUTHOR_EMAIL)
        self.github_repo_url = (env.get("GITHUB_REPO_URL")
                                or _toml_str(git, "git", "repo_url", "")
                                or None)

        # ── todos ──────────────────────────────────────────────────────────
        todo_rel = _toml_str(todo, "todo", "file", DEFAULT_TODO_FILE)
        todo_path = Path(todo_rel)
        self.todo_file = (todo_path if todo_path.is_absolute()
                          else self.content_root / todo_rel)
        categories = _toml_str_list(todo, "todo", "categories")
        if categories is None:
            categories = list(DEFAULT_TODO_CATEGORIES)
        categories = [c.strip().lower() for c in categories if c.strip()]
        # Deduplication (order preserved): a repeated category ("work",
        # "WORK") would make write_todos emit its section twice → each
        # save/load round-trip would DOUBLE that category's todos.
        categories = list(dict.fromkeys(categories))
        if not categories:
            raise AtlasConfigError(
                "atlas.toml: todo.categories cannot be empty")
        self.todo_categories = tuple(categories)
        self.todo_cat_default = self.todo_categories[0]
        # "work" → "Work", "personal" → "Personal": derived H2 headers.
        self.todo_cat_headers = {c: c.capitalize() for c in self.todo_categories}

        # ── build ──────────────────────────────────────────────────────────
        excluded = _toml_str_list(build, "build", "excluded_names")
        self.excluded_names = (set(excluded) if excluded is not None
                               else set(DEFAULT_EXCLUDED_NAMES))

    @property
    def site_name(self) -> str:
        """Full name DERIVED from the prefix (raw text: <title>, manifest,
        OpenAPI, boot banner, shares footer): "<prefix> Atlas", or "Atlas"
        alone without a prefix."""
        if not self.prefix:
            return SITE_WORDMARK
        return f"{self.prefix} {SITE_WORDMARK}"

    @property
    def site_short_name(self) -> str:
        """Short variant (short_name of the PWA manifest, iOS homescreen): the
        brand alone, always — the prefix does not fit there."""
        return SITE_WORDMARK

    def _mind_path(self, raw: str) -> Path:
        """Path as-is if absolute, otherwise relative to the mind root."""
        path = Path(raw)
        return path if path.is_absolute() else self.root / raw

    @classmethod
    def load(cls, root=None, env=None) -> "AtlasConfig":
        """Builds the config: resolved mind (argument > ATLAS_MIND > historical
        default), <mind>/atlas.toml read if it exists, env overrides applied.

        Raises AtlasConfigError (actionable message) if atlas.toml is malformed
        or if a value has the wrong type — never a silent failure."""
        if env is None:
            env = os.environ
        resolved_root = (Path(root).resolve() if root is not None
                         else resolve_mind_root(env))
        toml_path = resolved_root / CONFIG_FILENAME
        data = {}
        if toml_path.is_file():
            try:
                data = tomllib.loads(toml_path.read_text(encoding="utf-8"))
            except (tomllib.TOMLDecodeError, UnicodeDecodeError) as e:
                raise AtlasConfigError(f"invalid atlas.toml ({toml_path}): {e}")
            except OSError as e:
                raise AtlasConfigError(f"unreadable atlas.toml ({toml_path}): {e}")
        return cls(resolved_root, toml_data=data, env=env)

    def __repr__(self) -> str:
        return (f"AtlasConfig(root={str(self.root)!r}, port={self.port}, "
                f"auth_enabled={self.auth_enabled}, store={self.store_kind!r})")
