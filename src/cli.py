#!/usr/bin/env python3
"""Atlas engine CLI: scaffolding, serve, build and administration of a mind's
file registry (accounts, API tokens, share links).

Usage:

    python3 src/cli.py init <dir> [--force] [--lang en|fr] [--prefix P] [--tagline T] [--yes]
    python3 src/cli.py serve <dir> [--port N]
    python3 src/cli.py dev [<dir>] [--port N] [--fresh] [--reset]
    python3 src/cli.py build <dir> [--offline]
    python3 src/cli.py deploy <dir> [--target compose|systemd|fly] [--app NAME] [--wizard] [--force]
    python3 src/cli.py user add <dir> --email a@b.c [--role admin|viewer] [--password ...]
    python3 src/cli.py user list <dir>
    python3 src/cli.py user remove <dir> --email a@b.c
    python3 src/cli.py token create <dir> [--label claude]
    python3 src/cli.py token list <dir>
    python3 src/cli.py token revoke <dir> [--label claude]
    python3 src/cli.py share list <dir>
    python3 src/cli.py share revoke <dir> --id <id>

All user/token/share commands operate on the mind's FileStore
(<mind>/.atlas by default, or store.dir from atlas.toml).

`main()` is the clean entry-point alias for future packaging
(console_script `atlas = cli:main`).
"""
from __future__ import annotations

import argparse
import datetime
import getpass
import json
import os
import re
import secrets
import shlex
import shutil
import stat
import subprocess
import sys
import time
import uuid
from pathlib import Path

ENGINE_SRC = Path(__file__).resolve().parent
if str(ENGINE_SRC) not in sys.path:
    sys.path.insert(0, str(ENGINE_SRC))

import store  # noqa: E402
from config import AtlasConfig, AtlasConfigError, DEFAULT_PORT  # noqa: E402

MIN_PASSWORD_LENGTH = 8
DEFAULT_TOKEN_LABEL = "claude"
# Source of truth in store.py (shared with the server's admin endpoints).
UNUSABLE_PASSWORD_HASH = store.UNUSABLE_PASSWORD_HASH


class CliError(Exception):
    """User error: human message on stderr, exit 1 — never a traceback for a
    typo or a non-existent mind."""


# ─── Mind / config / store helpers ────────────────────────────────────────────


def _require_mind(raw: str) -> Path:
    mind = Path(raw).expanduser().resolve()
    if not mind.is_dir():
        raise CliError(
            f"mind not found: {mind} — the directory does not exist "
            f"(run `atlas init {raw}` to create one)")
    return mind


def _load_config(mind: Path) -> AtlasConfig:
    try:
        return AtlasConfig.load(root=mind)
    except AtlasConfigError as e:
        raise CliError(str(e))


def _file_store(config: AtlasConfig) -> store.FileStore:
    return store.FileStore(config.store_dir)


def _run_build(mind: Path, *, offline: bool = False, as_email: str = None) -> int:
    """Build the mind's viewer via `python -m build` (inherited output). Always the
    ENGINE's build: PYTHONPATH puts the engine src first, so a mind never builds
    with its own (now-forbidden) shipped build."""
    env = os.environ.copy()
    env["ATLAS_MIND"] = str(mind)
    env["PYTHONPATH"] = str(ENGINE_SRC) + os.pathsep + env.get("PYTHONPATH", "")
    command = [sys.executable, "-m", "build"]
    if offline:
        command.append("--offline")
    if as_email:
        command += ["--as", as_email]
    completed = subprocess.run(command, cwd=str(mind), env=env)
    return completed.returncode


def _format_timestamp(value) -> str:
    if not value:
        return "?"
    try:
        return time.strftime("%Y-%m-%d %H:%M", time.localtime(int(value)))
    except (ValueError, OverflowError, OSError):
        return "?"


# ─── init ──────────────────────────────────────────────────────────────────────

DEFAULT_TAGLINE_EN = "Personal knowledge base."
DEFAULT_TAGLINE_FR = "Base de connaissances personnelle."

# Only THIS template is .format()'d (prefix/tagline/lang) — the scaffolded docs
# below are written verbatim (they contain literal { } that are not placeholders).
ATLAS_TOML_TEMPLATE = """\
# Atlas mind configuration — every key is optional.
# Precedence: environment variables > this file > engine defaults.

# Instance identity: the "Atlas" mark is FIXED (the stylized wordmark in the
# viewer and on the login page); `prefix` is an optional label shown before it
# ("Acme" -> "Acme Atlas"). Empty or absent -> "Atlas" alone. The derived full
# name feeds <title>, the PWA manifest, the OpenAPI spec and the MCP server.
{prefix_line}
# Tagline shown under the title on the viewer's home page.
tagline = "{tagline}"
# Interface language: "en" or "fr" (also set on <html lang>).
lang = "{lang}"

[server]
# port = 8765
# auth_enabled = false   # true = cloud mode (login required); needs session_secret
# session_secret = ""    # long random secret, REQUIRED when auth_enabled
# session_max_age = 2592000  # session cookie lifetime in seconds (default 30 d).
#                            # Server-side revocation (logout-all / password reset
#                            # / 2FA) always overrides this delay.
# Behind a reverse proxy, the header carrying the real client IP (used by the
# login rate limit): "CF-Connecting-IP" behind Cloudflare, "X-Real-IP" or
# "X-Forwarded-For" behind Caddy/nginx. If the header carries a list
# (X-Forwarded-For stacked by the proxy), Atlas takes the LAST element — the only
# one set by the trusted proxy; the left-hand elements come from the client and
# are forgeable. Use it only with a SINGLE trusted proxy in front of Atlas. When
# unset: on Fly, Atlas trusts Fly-Client-IP; otherwise it uses the socket peer
# and ignores client headers (so a forged header cannot bypass the rate limit).
# trusted_ip_header = "X-Forwarded-For"
# Hive: by default a pasted node link may only point at a PUBLIC host
# (loopback/private/LAN addresses are refused — SSRF guard). Set true to also
# allow localhost/LAN remotes (home-lab hive between instances).
# allow_private_remotes = false

[store]
# Registry of accounts, API tokens and share links.
# "file" = local JSON under .atlas/ — administered with `atlas user|token|share`.
kind = "file"
# dir = ".atlas"

[git]
# Identity of the server's automatic commits (cloud mode only). The mind is a
# git repo: in cloud mode the server commits content changes and pushes them to
# the linked remote — this is how an online instance persists and shares state.
# author_name = "Atlas Bot"
# author_email = "atlas-bot@example.com"

[todo]
# Quick to-do file of the widget, relative to content/ (excluded from the viewer below).
# file = "notes/quick.md"
# categories = ["work", "personal"]   # the first one is the default category

[build]
# Names excluded from the viewer (folders or files, anywhere under content/).
# excluded_names = ["drafts", "quick.md"]

# Extensions — the mind's .atlas/extensions/ folder (no key to configure, the
# location is fixed; empty or absent folder = no extension):
# - *.css / *.js : inlined into the viewer at build time (alphabetical order,
#   both online and offline modes).
# - *.py : loaded at server boot; each module exposes register(context) and
#   registers its routes via context.add_route(method, pattern, handler,
#   role=...) — method "GET" or "POST", pattern a regex on the path,
#   handler(http_handler, match), role "public" / "auth" / "admin" (default:
#   "auth" for GET, "admin" for POST). context.config exposes the AtlasConfig.
#   A broken extension is skipped with a warning at boot — never a crash.
"""

GITIGNORE_TEMPLATE = """\
dist/
.atlas/
"""


def _render_atlas_toml(prefix: str, tagline: str, lang: str) -> str:
    prefix_line = (f'prefix = "{prefix}"' if prefix else '# prefix = "Acme"')
    return ATLAS_TOML_TEMPLATE.format(
        prefix_line=prefix_line, tagline=tagline, lang=lang)


# ── Scaffolded documents (English default, French variant via --lang fr) ───────

WELCOME_MD_EN = """\
---
tags: [help]
---

# Welcome

This mind is served by Atlas. Any Markdown document placed under `content/`
shows up in the viewer, organized along the folder tree.

## Supported syntax

- Plain Markdown: headings, lists, tables, code blocks, images.
- Wikilinks: [[notes/example]] targets a document by its path,
  [[example|an alias]] changes the displayed text (the link graph and the
  backlinks are built automatically).
- YAML frontmatter at the top of a file: `tags: [help]` adds tags; parent
  folders also become tags automatically.

## Organization

- `notes/` : an example subfolder — see [[notes/example]].
- `inbox/` : quick drop for documents to sort later.
- `ai-sessions/` : saved sessions from your AI assistant (see the template).
- `agents/` : reusable AI agent definitions.

## With your AI

Atlas is meant as the external memory shared with an AI assistant: the
`AGENTS.md` file (at the root) explains how to connect it (MCP) so it can read
and enrich your memory palace.
"""

EXAMPLE_MD_EN = """\
# Example note

An ordinary note, filed under `notes/`. The link [[welcome]] goes back to the
home page: a wikilink resolves by path (`notes/example`) or by filename
(`example`), with an optional alias after `|`.
"""

AGENTS_MD_EN = """\
# AGENTS.md — how your AI assistant uses this Atlas

This Atlas is the external memory shared between you and your AI assistant. This
file tells the AI how to read and enrich your Atlas. Adapt it to your
conventions (and duplicate it as `CLAUDE.md` if you use Claude Code).

## Principle

- The Atlas is the **source of truth**. Before answering on an already
  documented topic, the AI consults the Atlas (search + read) rather than
  guessing.
- Any durable knowledge produced (recap, decision, note, analysis) is **written
  into the Atlas**, not lost in the conversation thread.

## Access via MCP

The Atlas exposes an MCP server: six tools `search_docs`, `read_doc`,
`list_tree`, `recent_docs`, `create_doc`, `edit_doc`. Create a token with
`atlas token create <mind>` and point your assistant at
`https://<your-atlas>/mcp/<token>`. The AI can then search, read and create
documents directly in your memory palace.

## Filing conventions (adapt them)

When the AI creates a document, it files it by type:
- `notes/` — miscellaneous notes, quick captures.
- `ai-sessions/` — saved work sessions (see `ai-sessions/TEMPLATE.md`).
- `agents/` — reusable AI agent definitions (see `agents/README.md`).
- (add your own folders: projects/, meetings/, courses/…)

## Rules

- **No date in filenames** (the filesystem and git already carry it); the name
  describes the **topic**. kebab-case.
- Ask before writing if the target folder is ambiguous.
"""

AGENTS_README_MD_EN = """\
# Agents

Keep here the reusable **AI agent definitions** (e.g. Claude Code subagents) you
want to version and store in your Atlas.

An agent = a Markdown file with frontmatter:

```markdown
---
name: my-agent
description: "When and how to use this agent."
model: opus
---

The agent's system instructions…
```

Copying/symlinking them to the location your tool expects (`.claude/agents/` for
Claude Code) makes them usable; keeping them here versions them and makes them
browsable in your Atlas.
"""

AI_SESSION_TEMPLATE_MD_EN = """\
# TEMPLATE — AI session save

Format for the session saves in this folder: lets a fresh AI (or you, later)
resume exactly where a session stopped.

## Naming conventions

- kebab-case, **no date** in the name (already in the filesystem and git).
- The name describes the **topic**, not the moment. Prefix by type if useful:
  `patch-`, `incident-`, `project-`, `refactor-`.

## When to create a save

- Complex session whose context will not fit in a simple note.
- Risky work tested later (deployment, migration).
- Work resumed across several sessions.

## Structure (copy-paste, delete the unused sections)

---

# Save — {Short title}

> {One sentence: what a fresh AI must know on arrival.}

## How to resume
- Machine / project / resume command (session id…).

## Context
{The goal, the useful history.}

## Current state
{What is done, what works, what remains.}

## Pitfalls / decisions
{Choices made, pitfalls to avoid, loose ends.}
"""

WELCOME_MD_FR = """\
---
tags: [aide]
---

# Bienvenue

Ce mind est servi par Atlas. Tout document Markdown déposé sous `content/`
apparaît dans le viewer, organisé selon l'arborescence des dossiers.

## Syntaxe supportée

- Markdown classique : titres, listes, tableaux, blocs de code, images.
- Wikilinks : [[notes/example]] cible un document par son chemin,
  [[example|un alias]] change le texte affiché (le graphe de liens et les
  rétroliens sont construits automatiquement).
- Frontmatter YAML en tête de fichier : `tags: [aide]` ajoute des tags ;
  les dossiers parents deviennent aussi des tags automatiquement.

## Organisation

- `notes/` : un exemple de sous-dossier — voir [[notes/example]].
- `inbox/` : dépôt rapide pour les documents à trier plus tard.
- `ai-sessions/` : sauvegardes de session de ton assistant IA (voir le modèle).
- `agents/` : définitions d'agents IA réutilisables.

## Avec ton IA

Atlas est pensé comme la mémoire externe partagée avec un assistant IA : le
fichier `AGENTS.md` (racine) explique comment la brancher (MCP) pour qu'elle
lise et enrichisse ton palais mental.
"""

EXAMPLE_MD_FR = """\
# Exemple de note

Une note ordinaire, rangée dans `notes/`. Le lien [[welcome]] ramène à la
page d'accueil : un wikilink se résout par chemin (`notes/example`) ou par
nom de fichier (`example`), avec un alias optionnel après `|`.
"""

AGENTS_MD_FR = """\
# AGENTS.md — comment ton assistant IA utilise cet Atlas

Cet Atlas est la mémoire externe partagée entre toi et ton assistant IA. Ce
fichier dit à l'IA comment lire et enrichir ton Atlas. Adapte-le à tes
conventions (et duplique-le en `CLAUDE.md` si tu utilises Claude Code).

## Principe

- L'Atlas est la **source de vérité**. Avant de répondre sur un sujet déjà
  documenté, l'IA consulte l'Atlas (recherche + lecture) plutôt que de deviner.
- Toute connaissance durable produite (récap, décision, note, analyse) est
  **écrite dans l'Atlas**, pas perdue dans le fil de conversation.

## Accès via MCP

L'Atlas expose un serveur MCP : six outils `search_docs`, `read_doc`,
`list_tree`, `recent_docs`, `create_doc`, `edit_doc`. Crée un token avec
`atlas token create <mind>` et branche ton assistant sur
`https://<ton-atlas>/mcp/<token>`. L'IA peut alors chercher, lire et créer des
documents directement dans ton palais mental.

## Conventions de rangement (à adapter)

Quand l'IA crée un document, elle le range selon son type :
- `notes/` — notes diverses, captures rapides.
- `ai-sessions/` — sauvegardes de session de travail (voir `ai-sessions/TEMPLATE.md`).
- `agents/` — définitions d'agents IA réutilisables (voir `agents/README.md`).
- (ajoute tes dossiers : projets/, reunions/, cours/…)

## Règles

- **Pas de date dans les noms de fichiers** (le filesystem et git la portent
  déjà) ; le nom décrit le **sujet**. kebab-case.
- Demander avant d'écrire si le dossier cible est ambigu.
"""

AGENTS_README_MD_FR = """\
# Agents

Range ici les **définitions d'agents IA** réutilisables (ex. sous-agents
Claude Code) que tu veux versionner et garder dans ton Atlas.

Un agent = un fichier Markdown avec un frontmatter :

```markdown
---
name: mon-agent
description: "Quand et comment utiliser cet agent."
model: opus
---

Instructions système de l'agent…
```

Les copier/symlinker vers l'emplacement attendu par ton outil (`.claude/agents/`
pour Claude Code) les rend utilisables ; les garder ici les versionne et les
rend consultables dans ton Atlas.
"""

AI_SESSION_TEMPLATE_MD_FR = """\
# MODÈLE — Save de session IA

Format des sauvegardes de session dans ce dossier : permet à une IA fraîche (ou
à toi-même plus tard) de reprendre exactement où une session s'est arrêtée.

## Conventions de nommage

- kebab-case, **pas de date** dans le nom (déjà dans le filesystem et git).
- Le nom décrit le **sujet**, pas le moment. Préfixe par type si utile :
  `patch-`, `incident-`, `chantier-`, `refonte-`.

## Quand créer une save

- Session complexe dont le contexte ne tiendra pas dans une simple note.
- Travail à risque testé plus tard (déploiement, migration).
- Chantier repris sur plusieurs sessions.

## Structure (copier-coller, supprimer les sections inutiles)

---

# Save — {Titre court}

> {Une phrase : ce qu'une IA fraîche doit savoir en arrivant.}

## Comment reprendre
- Machine / projet / commande de reprise (id de session…).

## Contexte
{Le but, l'historique utile.}

## État actuel
{Ce qui est fait, ce qui marche, ce qui reste.}

## Pièges / décisions
{Choix faits, pièges à éviter, fils en suspens.}
"""


def _scaffold_docs(lang: str) -> list:
    """(relative path, content) pairs for the chosen language. English is the
    default; --lang fr ships the French variant."""
    if lang == "fr":
        return [
            ("content/welcome.md", WELCOME_MD_FR),
            ("content/notes/example.md", EXAMPLE_MD_FR),
            ("AGENTS.md", AGENTS_MD_FR),
            ("content/agents/README.md", AGENTS_README_MD_FR),
            ("content/ai-sessions/TEMPLATE.md", AI_SESSION_TEMPLATE_MD_FR),
        ]
    return [
        ("content/welcome.md", WELCOME_MD_EN),
        ("content/notes/example.md", EXAMPLE_MD_EN),
        ("AGENTS.md", AGENTS_MD_EN),
        ("content/agents/README.md", AGENTS_README_MD_EN),
        ("content/ai-sessions/TEMPLATE.md", AI_SESSION_TEMPLATE_MD_EN),
    ]


def _scaffold_file(path: Path, content: str, created: list, kept: list) -> None:
    """Write the file if it does not exist; an existing file (--force case)
    is kept as-is — init never destroys data."""
    if path.exists():
        kept.append(path)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    created.append(path)


def _git_init_main(mind: Path) -> str:
    """`git init -b main` (fallback to `git init` for old git versions), or a
    warning if git is absent — init never fails because of this."""
    if shutil.which("git") is None:
        return "git not found: repo not initialized (install git then run `git init -b main`)."
    if (mind / ".git").exists():
        return "git repo already present, kept."
    result = subprocess.run(["git", "init", "-q", "-b", "main"],
                            cwd=str(mind), capture_output=True, text=True)
    if result.returncode != 0:
        # git < 2.28 does not know -b: fall back to the default branch.
        fallback = subprocess.run(["git", "init", "-q"], cwd=str(mind),
                                  capture_output=True, text=True)
        if fallback.returncode != 0:
            return f"git init failed: {fallback.stderr.strip()}"
        return "git repo initialized (default branch: this git does not support -b main)."
    return "git repo initialized (branch main)."


def _invocation() -> str:
    """How the CLI was invoked, for copy-pasteable next-steps: "atlas" when run
    as the installed console script, else "python3 <path>" for a source run."""
    name = Path(sys.argv[0]).name
    if name in ("atlas", "__main__.py"):
        return "atlas"
    return f"python3 {sys.argv[0]}"


def _prompt(question: str, default: str) -> str:
    suffix = f" [{default}]" if default else ""
    try:
        answer = input(f"{question}{suffix}: ").strip()
    except EOFError:
        return default
    return answer or default


def _personalize(args) -> tuple:
    """Resolve (lang, prefix, tagline) for the scaffold.

    Interactive (asks the few questions) ONLY when stdin is a TTY and --yes was
    not passed; otherwise it stays non-interactive (CI/tests/pipes never hang),
    using the --lang/--prefix/--tagline flags or the English defaults."""
    lang, prefix, tagline = args.lang, args.prefix, args.tagline
    if sys.stdin.isatty() and not args.yes:
        if lang is None:
            lang = _prompt("Interface language (en/fr)", "en")
        if prefix is None:
            prefix = _prompt(
                'Brand prefix shown before "Atlas" (optional, e.g. Acme)', "")
        if tagline is None:
            default_tagline = (DEFAULT_TAGLINE_FR if lang == "fr"
                               else DEFAULT_TAGLINE_EN)
            tagline = _prompt("Home page tagline", default_tagline)
    lang = lang if lang in ("en", "fr") else "en"
    prefix = (prefix or "").strip()
    tagline = (tagline or (DEFAULT_TAGLINE_FR if lang == "fr"
                           else DEFAULT_TAGLINE_EN)).strip()
    return lang, prefix, tagline


def cmd_init(args) -> int:
    mind = Path(args.dir).expanduser().resolve()
    if mind.exists() and not mind.is_dir():
        raise CliError(f"{mind} already exists and is not a directory.")
    if mind.is_dir() and any(mind.iterdir()) and not args.force:
        raise CliError(
            f"{mind} is not empty — rerun with --force to scaffold "
            "anyway (existing files are kept).")

    lang, prefix, tagline = _personalize(args)
    mind.mkdir(parents=True, exist_ok=True)

    created: list = []
    kept: list = []
    _scaffold_file(mind / "atlas.toml",
                   _render_atlas_toml(prefix, tagline, lang), created, kept)
    _scaffold_file(mind / ".gitignore", GITIGNORE_TEMPLATE, created, kept)
    # .gitkeep: an empty inbox/ must survive the git clone; the "." prefix
    # keeps it out of the viewer (EXCLUDED_PREFIXES).
    _scaffold_file(mind / "content" / "inbox" / ".gitkeep", "", created, kept)
    # Extensions hook (CSS/JS inlined at build, *.py loaded at server boot):
    # empty ready-to-use folder, documented in atlas.toml.
    _scaffold_file(mind / ".atlas" / "extensions" / ".gitkeep", "",
                   created, kept)
    for rel, content in _scaffold_docs(lang):
        _scaffold_file(mind / rel, content, created, kept)

    git_message = _git_init_main(mind)

    print(f"Mind initialized: {mind}")
    for path in created:
        print(f"  created : {path.relative_to(mind)}")
    for path in kept:
        print(f"  kept    : {path.relative_to(mind)} (existing, untouched)")
    print(f"  git     : {git_message}")
    print()
    # Absolute paths so every command is copy-pasteable from ANY working directory.
    print("Next steps:")
    print(f"  {_invocation()} serve {mind}")
    print(f"  {_invocation()} user add {mind} --email you@example.com")
    print()
    print("Going online (cloud mode): this mind is a git repository. Link it to")
    print("a PRIVATE remote and grant push access — in cloud mode the server")
    print("commits content changes and pushes them to that remote, which is how")
    print("an online instance persists and shares its state:")
    print(f"  git -C {mind} remote add origin git@github.com:<you>/<your-mind>.git")
    print(f"  git -C {mind} add -A && git -C {mind} commit -m initial && git -C {mind} push -u origin main")
    print("Keep the repository PRIVATE — it holds your notes (the .atlas/ account")
    print("registry stays local, it is gitignored). The deployment needs push")
    print("credentials (a deploy key or a token with write access). Full guide:")
    print(f"  {_invocation()} deploy --help")
    return 0


# ─── serve / build ─────────────────────────────────────────────────────────────


def cmd_serve(args) -> int:
    mind = _require_mind(args.dir)
    if not (mind / "content").is_dir():
        raise CliError(
            f"{mind} has no content/ directory — is this really a "
            f"mind? (run `atlas init {args.dir}` to scaffold one)")
    config = _load_config(mind)  # human error if atlas.toml is broken
    if not config.index_file.exists():
        print("dist/index.html missing: initial build of the viewer…")
        if _run_build(mind) != 0:
            print("warning: the build failed, the viewer will be "
                  "unavailable (the API is still served).", file=sys.stderr)
    env = os.environ.copy()
    env["ATLAS_MIND"] = str(mind)
    env["PYTHONPATH"] = str(ENGINE_SRC) + os.pathsep + env.get("PYTHONPATH", "")
    if args.port is not None:
        env["PORT"] = str(args.port)
    # PYTHONPATH puts the engine src first so `-m server` resolves the engine's server.
    if os.name == "nt":
        # Windows has NO true execve: os.execve spawns a new pid and exits this
        # one, which breaks pid-based supervision (and segfaults under MSYS2 on
        # recent CPython). Run the server as a child instead — stable pid, clean
        # Ctrl+C (SIGINT reaches the child via the console group; the server
        # handles KeyboardInterrupt). The graceful-SIGTERM cloud path (systemd /
        # Fly) is Linux-only, so it keeps the POSIX overlay below.
        try:
            return subprocess.run([sys.executable, "-m", "server"], env=env).returncode
        except KeyboardInterrupt:
            return 0
    # POSIX: exec so the process BECOMES the server — it must BE the pid that
    # receives SIGTERM for the cloud graceful flush (systemd/Fly send it there).
    os.execve(sys.executable,
              [sys.executable, "-m", "server"], env)
    return 0  # unreachable


def cmd_build(args) -> int:
    mind = _require_mind(args.dir)
    if not (mind / "content").is_dir():
        raise CliError(f"{mind} has no content/ directory — nothing to build.")
    _load_config(mind)  # human error if atlas.toml is broken
    return _run_build(mind, offline=args.offline, as_email=args.as_email)


# ─── dev sandbox ─────────────────────────────────────────────────────────────
# `atlas dev` is the turnkey LOCAL test environment: the CLOUD features (login,
# /setup onboarding, share links, 2FA, admin) WITHOUT ever touching git — no
# commit, no push, no pull, no remote — against a throwaway copy of the demo
# mind, with a ready-made admin (dev@local / dev) so /login works immediately.
# It is the fastest way to exercise cloud behaviour locally and is safe to throw
# away: it never points at your real mind and never writes to a remote. Under
# the hood it just sets ATLAS_DEV=1 (see config.py / server.run).

# Bundled demo mind — present in a source checkout, absent from a pip wheel
# (which ships no examples/). When missing, the dev mind is scaffolded instead.
_DEMO_MIND = ENGINE_SRC.parent / "examples" / "demo-mind"
# Default throwaway location: a gitignored .dev-mind next to the engine. State
# (accounts, edits) persists across runs there; --reset wipes it.
_DEFAULT_DEV_MIND = ENGINE_SRC.parent / ".dev-mind"


def _rmtree_robust(path: Path) -> None:
    """rmtree that survives Windows: the error handler clears the read-only bit
    Windows leaves on some copied/git files (which makes os.unlink/rmdir raise
    WinError 5) and retries; a short outer retry covers a transient handle from
    an indexer/antivirus. Without this, `atlas dev --reset` dies mid-wipe."""
    def _onexc(func, target, _exc):
        try:
            os.chmod(target, stat.S_IWRITE)
        except OSError:
            pass
        func(target)

    for attempt in range(3):
        try:
            if sys.version_info >= (3, 12):
                shutil.rmtree(path, onexc=_onexc)
            else:  # onexc replaced onerror in 3.12; 3.11 still needs onerror.
                shutil.rmtree(path, onerror=lambda f, p, _info: _onexc(f, p, None))
            return
        except OSError:
            if attempt == 2:
                raise
            time.sleep(0.2)


def _seed_dev_mind(scratch: Path, *, reset: bool) -> str:
    """Make `scratch` a ready-to-serve mind. Copies the bundled demo mind into it
    (or scaffolds a minimal one if the demo is absent, e.g. a pip install). An
    existing mind is reused as-is so edits/accounts persist between runs; --reset
    wipes it first. Returns a one-line human status."""
    if reset and scratch.exists():
        _rmtree_robust(scratch)
    if (scratch / "content").is_dir():
        return f"reused existing dev mind ({scratch})"
    scratch.mkdir(parents=True, exist_ok=True)
    if _DEMO_MIND.is_dir():
        # dirs_exist_ok: scratch was just created (and may hold a leftover .atlas).
        shutil.copytree(_DEMO_MIND, scratch, dirs_exist_ok=True)
        return f"seeded from the demo mind ({scratch})"
    # No bundled demo (pip install): scaffold a minimal English mind.
    created: list = []
    kept: list = []
    _scaffold_file(scratch / "atlas.toml",
                   _render_atlas_toml("", DEFAULT_TAGLINE_EN, "en"), created, kept)
    for rel, content in _scaffold_docs("en"):
        _scaffold_file(scratch / rel, content, created, kept)
    return f"scaffolded a fresh dev mind ({scratch})"


def _dev_serve_env(scratch: Path, *, port, fresh: bool) -> dict:
    """Environment for the dev-sandbox server subprocess. ATLAS_DEV turns on the
    sandbox; ATLAS_MIND pins it to the throwaway mind; PYTHONPATH puts the engine
    first. The cloud/clone knobs are PURGED so an ambient KB_AUTH_ENABLED in the
    shell cannot flip the sandbox into real cloud mode (which would try to clone
    and push to a remote)."""
    env = os.environ.copy()
    for var in ("KB_AUTH_ENABLED", "KB_REPO_PATH", "GITHUB_REPO_URL",
                "ATLAS_STORE", "ATLAS_STORE_DIR"):
        env.pop(var, None)
    env["ATLAS_DEV"] = "1"
    env["ATLAS_MIND"] = str(scratch)
    env["PYTHONPATH"] = str(ENGINE_SRC) + os.pathsep + env.get("PYTHONPATH", "")
    if fresh:
        # Skip the seeded admin to exercise the first-boot /setup token flow.
        env["ATLAS_DEV_FRESH"] = "1"
    if port is not None:
        env["PORT"] = str(port)
    return env


def cmd_dev(args) -> int:
    """Run the local cloud sandbox (see the section comment above)."""
    scratch = (Path(args.dir).expanduser().resolve() if args.dir
               else _DEFAULT_DEV_MIND)
    status = _seed_dev_mind(scratch, reset=args.reset)
    env = _dev_serve_env(scratch, port=args.port, fresh=args.fresh)

    port = args.port or DEFAULT_PORT
    print("Atlas dev sandbox — cloud features ON, git OFF (no commit/push/pull).")
    print(f"  mind   : {status}")
    if args.fresh:
        print("  login  : first-boot /setup flow (admin NOT seeded — token printed below)")
    else:
        print("  login  : dev@local / dev  (seeded admin)")
    print(f"  url    : http://127.0.0.1:{port}/")
    reset_target = f" {args.dir}" if args.dir else ""
    print(f"  reset  : atlas dev{reset_target} --reset   (wipe accounts + edits)")
    print("  stop   : Ctrl+C")
    print()
    # subprocess, NOT os.execve like `serve`: execve segfaults under MSYS2/git-bash
    # on recent CPython, and a child process keeps Ctrl+C working on every platform.
    try:
        return subprocess.run([sys.executable, "-m", "server"], env=env).returncode
    except KeyboardInterrupt:
        return 0


# ─── deploy ──────────────────────────────────────────────────────────────────
# Scaffolds deployment files into <mind>/deploy/ + prints a "going online" guide.
# The templates are self-contained (pull the engine from PyPI) so they work for a
# plain `pip install atlas-mind` user, with no clone of this repo.

DEPLOY_DOCKERFILE = """\
# Atlas Mind container image — installs the engine from PyPI.
FROM python:3.12-slim
RUN pip install --no-cache-dir "atlas-mind[bcrypt]"
# Non-root runtime user.
RUN useradd --uid 10001 --create-home app
USER app
WORKDIR /app
ENV ATLAS_STORE=file \\
    KB_AUTH_ENABLED=1 \\
    PORT=8765
EXPOSE 8765
# The mind (atlas.toml, content/, .atlas/) is mounted at /app/repo. It must be
# an initialized git repo. SESSION_SECRET is provided at runtime (see .env).
CMD ["atlas", "serve", "/app/repo"]
"""

DEPLOY_COMPOSE = """\
# docker-compose.yml — self-host Atlas Mind behind Caddy (automatic HTTPS).
#
#   1. Put your initialized mind (a git repo: atlas.toml + content/ + .git) in ./mind
#   2. cp .env.example .env  and set a long random SESSION_SECRET
#   3. Set your domain in Caddyfile
#   4. docker compose up -d
#
services:
  atlas:
    build: .
    restart: unless-stopped
    env_file: .env
    volumes:
      # Your mind. It MUST be an initialized git repo (a present .git skips the
      # boot clone; the server commits content writes into it).
      - ./mind:/app/repo
    expose:
      - "8765"

  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - atlas

volumes:
  caddy_data:
  caddy_config:
"""

DEPLOY_CADDYFILE = """\
# Replace example.com with your domain (its DNS must point at this server).
# Caddy obtains and renews a TLS certificate automatically.
example.com {
    encode zstd gzip
    # Overwrite X-Forwarded-For with the real client IP so it cannot be forged.
    # The engine trusts the LAST element when ATLAS_TRUSTED_IP_HEADER is set
    # (see .env), which is what this single value provides.
    reverse_proxy atlas:8765 {
        header_up X-Forwarded-For {remote_host}
    }
}
"""

DEPLOY_ENV_EXAMPLE = """\
# Copy to .env and fill in. NEVER commit .env.
# Long random secret, REQUIRED in cloud mode. Generate one with:
#   python3 -c "import secrets; print(secrets.token_hex(32))"
SESSION_SECRET=
# Behind the bundled Caddy reverse proxy, trust its forwarded client IP
# (used by the login rate limit). Caddy is configured to set X-Forwarded-For.
ATLAS_TRUSTED_IP_HEADER=X-Forwarded-For
# Optional: auto-pull + auto-push the mind to a PRIVATE GitHub repo. <TOKEN> =
# a GitHub fine-grained PAT with Contents:Read-and-write on that repo, created
# at https://github.com/settings/personal-access-tokens/new (otherwise just
# commit/push the ./mind repo yourself).
# GITHUB_REPO_URL=https://x-access-token:<TOKEN>@github.com/<you>/<your-mind>.git
"""

DEPLOY_SYSTEMD = """\
# Atlas Mind systemd unit (runs `atlas serve` from a venv install).
#
#   sudo useradd --system --create-home --home-dir /opt/atlas atlas
#   sudo -u atlas python3 -m venv /opt/atlas/venv
#   sudo -u atlas /opt/atlas/venv/bin/pip install "atlas-mind[bcrypt]"
#   # put your initialized mind (git repo) at /opt/atlas/mind
#   sudo cp deploy/atlas.service /etc/systemd/system/
#   sudo systemctl edit atlas        # set SESSION_SECRET privately (see below)
#   sudo systemctl enable --now atlas
#
# Front it with a reverse proxy (Caddy/nginx) for TLS and set
# ATLAS_TRUSTED_IP_HEADER to the header the proxy sets.
[Unit]
Description=Atlas Mind
After=network.target

[Service]
Type=exec
User=atlas
WorkingDirectory=/opt/atlas
Environment=ATLAS_STORE=file
Environment=KB_AUTH_ENABLED=1
Environment=PORT=8765
# REQUIRED. Do NOT hardcode it here in a committed file — instead run
# `systemctl edit atlas` and add, under [Service]:
#   Environment=SESSION_SECRET=<long random value>
Environment=SESSION_SECRET=change-me
ExecStart=/opt/atlas/venv/bin/atlas serve /opt/atlas/mind
Restart=on-failure

[Install]
WantedBy=multi-user.target
"""

DEPLOY_FLY_DOCKERFILE = """\
# Atlas Mind on Fly.io — installs the engine from PyPI and clones your mind
# (a PRIVATE git repo) at boot. git is needed for that clone + the content push.
FROM python:3.12-slim
RUN apt-get update \\
    && apt-get install -y --no-install-recommends git ca-certificates \\
    && rm -rf /var/lib/apt/lists/*
# Pin the version for reproducible deploys, e.g. "atlas-mind[bcrypt]==0.1.1".
RUN pip install --no-cache-dir "atlas-mind[bcrypt]"
# Non-root: limits cross-user escalation after an RCE. It does NOT hide the
# GitHub token from the app context (it lives in GITHUB_REPO_URL / .git/config,
# readable by `app` and via `fly ssh`) — so scope the PAT fine-grained (this one
# repo, Contents:read/write) and rotate it if the machine is ever compromised.
# `app` owns /app to clone/write the repo and commit at runtime.
RUN useradd --create-home --uid 10001 app
WORKDIR /app
RUN chown app:app /app
USER app
ENV KB_AUTH_ENABLED=1 \\
    KB_REPO_PATH=/app/repo \\
    PORT=8765 \\
    PYTHONUNBUFFERED=1
EXPOSE 8765
# Cloud-mode boot: clones GITHUB_REPO_URL into /app/repo (or pulls if already
# there), builds the viewer, serves, and commits+pushes content writes back.
# `atlas serve` is NOT used here — it expects content/ to already exist; the
# clone happens inside this entrypoint instead.
CMD ["python", "-m", "atlas_mind.server"]
"""

DEPLOY_FLY_TOML = """\
# Fly.io deployment for an Atlas Mind instance (cloud mode + file store on a
# persistent volume). Edit `app`, then run the one-time setup + deploy:
#
#   fly apps create <your-app>
#   fly volumes create atlas_store --region cdg --size 1 -a <your-app>
#   fly secrets set -a <your-app> \\
#       SESSION_SECRET=$(python3 -c "import secrets;print(secrets.token_hex(32))") \\
#       GITHUB_REPO_URL="https://x-access-token:<TOKEN>@github.com/<you>/<your-mind>.git"
#   fly deploy -a <your-app> -c deploy/fly.toml
#
# <TOKEN> = a GitHub token with read/write access to the PRIVATE mind repo
# (fine-grained PAT scoped to that one repo is ideal). The mind repo holds only
# content (atlas.toml + content/ + AGENTS.md) — no engine code.
#
# OPTIONAL — instant push-to-update (otherwise the periodic git pull, ~5 min):
#   fly secrets set -a <your-app> \\
#       GITHUB_WEBHOOK_SECRET=$(python3 -c "import secrets;print(secrets.token_hex(32))")
# then add a webhook on the GitHub repo (Settings -> Webhooks): payload URL
# https://<your-app>.fly.dev/webhook/github , content type application/json,
# secret = the same value.
app = 'your-atlas-app'
primary_region = 'cdg'
# Give the SIGTERM handler time to push pending writes before the machine stops.
kill_timeout = '30s'

[build]
  dockerfile = 'Dockerfile.fly'

[env]
  PORT = '8765'
  # Registry (accounts/tokens/2FA) as JSON on the volume — never committed with
  # the content; the Fly rootfs is ephemeral, the volume makes it persistent.
  ATLAS_STORE = 'file'
  ATLAS_STORE_DIR = '/data/atlas-store'

[mounts]
  source = 'atlas_store'
  destination = '/data'

[http_service]
  internal_port = 8765
  force_https = true
  auto_stop_machines = 'suspend'
  auto_start_machines = true
  min_machines_running = 1
  processes = ['app']

  [[http_service.checks]]
    interval = '30s'
    timeout = '5s'
    # Wide enough to cover the cold boot (clone + viewer build) before the first check.
    grace_period = '40s'
    method = 'GET'
    path = '/healthz'

[[vm]]
  memory = '256mb'
  cpus = 1
"""

_DEPLOY_TARGETS = {
    "compose": [
        ("deploy/Dockerfile", DEPLOY_DOCKERFILE),
        ("deploy/docker-compose.yml", DEPLOY_COMPOSE),
        ("deploy/Caddyfile", DEPLOY_CADDYFILE),
        ("deploy/.env.example", DEPLOY_ENV_EXAMPLE),
    ],
    "systemd": [
        ("deploy/atlas.service", DEPLOY_SYSTEMD),
    ],
    "fly": [
        ("deploy/fly.toml", DEPLOY_FLY_TOML),
        ("deploy/Dockerfile.fly", DEPLOY_FLY_DOCKERFILE),
    ],
}


def _fly_app_slug(name: str) -> str:
    """DNS-safe Fly app name derived from a string: lowercase, alphanumerics and
    single hyphens, no leading/trailing hyphen. Empty input → 'atlas-mind'."""
    slug = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")
    return slug or "atlas-mind"


def _provision_fly(app_name: str, region: str) -> None:
    """Opt-in (`--provision`): run the two one-time Fly steps for the user —
    `fly apps create` + `fly volumes create`. Output streams to the terminal so
    `fly` can prompt (login/confirmations). A failure is reported, not fatal:
    the user re-runs or does it by hand. Secrets + deploy stay manual on purpose
    (they need the GitHub token)."""
    fly = shutil.which("fly") or shutil.which("flyctl")
    if not fly:
        print("  --provision skipped: the `fly` CLI is not installed "
              "(https://fly.io/docs/flyctl/install/).")
        return
    print(f"Provisioning on Fly.io (app '{app_name}', region {region}):")
    commands = [
        [fly, "apps", "create", app_name],
        [fly, "volumes", "create", "atlas_store", "--region", region,
         "--size", "1", "-a", app_name, "--yes"],
    ]
    for cmd in commands:
        print(f"  $ {' '.join(cmd)}")
        try:
            result = subprocess.run(cmd)
        except OSError as e:
            print(f"  could not run fly: {e}")
            return
        if result.returncode != 0:
            print(f"  (exited {result.returncode} — fix the issue above and re-run, "
                  "or run the remaining commands manually.)")


def _build_github_repo_url(repo: str, token: str) -> str:
    """Turn a repo reference + token into the clone/push URL the server uses
    (GITHUB_REPO_URL). Accepts an https URL, a git@ SSH URL, or `owner/repo`."""
    repo = (repo or "").strip()
    token = (token or "").strip()
    match = re.search(r"github\.com[:/]+([^/]+/[^/]+?)(?:\.git)?/?$", repo)
    if match:
        slug = match.group(1)
    elif re.fullmatch(r"[^/\s]+/[^/\s]+", repo):
        slug = repo
    else:
        raise CliError(
            f"unrecognized GitHub repo: {repo!r} "
            "(use https://github.com/<you>/<repo>.git or <you>/<repo>)")
    return f"https://x-access-token:{token}@github.com/{slug}.git"


def _fly_wizard(mind: Path, app_name: str, region: str) -> int:
    """End-to-end guided Fly deploy: provision app+volume, set secrets (auto
    SESSION_SECRET), deploy, and create the admin — no setup token, no manual
    secret juggling. Requires an interactive terminal and the fly CLI; every
    outward step is confirmed once up front."""
    if not sys.stdin.isatty():
        raise CliError("--wizard needs an interactive terminal.")
    fly = shutil.which("fly") or shutil.which("flyctl")
    if not fly:
        raise CliError("the `fly` CLI is required for --wizard (install: "
                       "https://fly.io/docs/flyctl/install/, then `fly auth login`).")

    def run(*cmd, label):
        print(f"\n-> {label}")
        print(f"   $ fly {' '.join(str(c) for c in cmd)}")
        return subprocess.run([fly, *[str(c) for c in cmd]]).returncode

    print(f"\nGuided Fly deploy — app '{app_name}' (region {region}).")
    print("You will be asked for your private GitHub repo + token and the admin login.\n")

    repo = _prompt("Private GitHub repo (https://github.com/<you>/<repo>.git or <you>/<repo>)", "")
    if not repo:
        raise CliError("a GitHub repo is required (the mind is cloned from it at boot).")
    print("GitHub token: a fine-grained PAT with Contents: Read and write on that repo")
    print("  (create one at https://github.com/settings/personal-access-tokens/new).")
    token = getpass.getpass("GitHub token (input hidden): ").strip()
    if not token:
        raise CliError("a GitHub token is required (clone + push authentication).")
    repo_url = _build_github_repo_url(repo, token)

    admin_email = _normalize_email(_prompt("Admin email", ""))
    admin_pw = _ask_password()
    if len(admin_pw) < MIN_PASSWORD_LENGTH:
        raise CliError(f"admin password too short (min {MIN_PASSWORD_LENGTH} characters).")

    print("\nAbout to: create the Fly app + volume, set the secrets, deploy, and create")
    print(f"the admin — on app '{app_name}'.")
    if _prompt("Proceed?", "yes").strip().lower() not in ("y", "yes", "o", "oui"):
        print("Aborted. Your deploy/ files are already written; re-run when ready.")
        return 1

    run("apps", "create", app_name, label=f"Create the Fly app '{app_name}'")  # tolerate exists
    existing = subprocess.run([fly, "volumes", "list", "-a", app_name],
                              capture_output=True, text=True).stdout
    if "atlas_store" in existing:
        print("\n-> Volume 'atlas_store' already exists, keeping it.")
    elif run("volumes", "create", "atlas_store", "--region", region, "--size", "1",
             "-a", app_name, "--yes", label="Create the data volume") != 0:
        raise CliError("volume creation failed — fix the issue above and re-run.")

    if run("secrets", "set", "-a", app_name,
           f"SESSION_SECRET={secrets.token_hex(32)}",
           f"GITHUB_REPO_URL={repo_url}",
           label="Set SESSION_SECRET + GITHUB_REPO_URL") != 0:
        raise CliError("setting secrets failed — fix the issue above and re-run.")

    if run("deploy", "-c", str(mind / "deploy" / "fly.toml"),
           label="Build + deploy (waits until healthy)") != 0:
        raise CliError("deploy failed — check `fly logs` and re-run.")

    # `fly ssh` runs as ROOT, so the store files would land root-owned and the
    # non-root server (uid 10001 'app') could not read them → chown them back.
    # /data/atlas-store must match ATLAS_STORE_DIR in DEPLOY_FLY_TOML.
    admin_cmd = ("atlas user add /app/repo --email " + shlex.quote(admin_email)
                 + " --role admin --password " + shlex.quote(admin_pw)
                 + " && chown -R app:app /data/atlas-store")
    if run("ssh", "console", "-a", app_name, "-C", admin_cmd,
           label="Create the admin account (over SSH, no setup token)") != 0:
        print(f"\nAdmin creation over SSH failed. Fallback: open "
              f"https://{app_name}.fly.dev/setup and paste the token from `fly logs`.")
        return 1

    print(f"\n[done] Open https://{app_name}.fly.dev/login and sign in as {admin_email}.")
    return 0


def cmd_deploy(args) -> int:
    mind = _require_mind(args.dir)

    # Fly needs a globally-unique app name (default = slug of the mind folder,
    # prompted on a TTY, --app overrides). Baked into the generated fly.toml AND
    # the printed commands so the whole guide is copy-pasteable as-is.
    app_name = None
    if args.target == "fly":
        chosen = args.app
        if chosen is None and sys.stdin.isatty():
            chosen = _prompt("Fly app name", _fly_app_slug(mind.name))
        app_name = _fly_app_slug(chosen if chosen is not None else mind.name)

    files = _DEPLOY_TARGETS[args.target]
    written, kept = [], []
    for rel, content in files:
        if app_name:
            content = (content.replace("your-atlas-app", app_name)
                              .replace("<your-app>", app_name))
        path = mind / rel
        if path.exists() and not args.force:
            kept.append(path)
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        written.append(path)

    print(f"Deployment files for target '{args.target}':")
    for path in written:
        print(f"  created : {path.relative_to(mind)}")
    for path in kept:
        print(f"  kept    : {path.relative_to(mind)} (exists, use --force to overwrite)")
    print()
    if args.target == "fly" and args.wizard:
        return _fly_wizard(mind, app_name, args.region)
    if args.target == "fly" and args.provision:
        _provision_fly(app_name, args.region)
        print()
    if args.target == "compose":
        print("Going online with Docker + Caddy (automatic HTTPS):")
        print(f"  1. Ensure {mind} is an initialized git repo (atlas.toml + content/ + .git).")
        print( "  2. Move/symlink it as deploy/mind, or edit the volume path in docker-compose.yml.")
        print( "  3. cd deploy && cp .env.example .env  then set a long random SESSION_SECRET")
        print( "     (python3 -c \"import secrets; print(secrets.token_hex(32))\").")
        print( "  4. Put your domain in deploy/Caddyfile and point its DNS at this server.")
        print( "  5. docker compose up -d   (first run: open the printed setup token to create admin).")
        print( "  Cloud mode commits content writes into the mounted repo; set GITHUB_REPO_URL in .env")
        print( "  to also auto-push to your PRIVATE GitHub remote.")
    elif args.target == "fly":
        print(f"Going online on Fly.io as '{app_name}' (the mind is cloned from a PRIVATE GitHub repo at boot).")
        print("  TIP: re-run with --wizard to do ALL of the steps below interactively")
        print("  (provision, secrets, deploy, admin) — no setup token, no manual juggling.")
        print(f"  1. Push {mind} to a PRIVATE GitHub repo (atlas.toml + content/ — no engine code).")
        print(f"  2. Create the app (name already set in deploy/fly.toml) and the data volume:")
        print(f"       fly apps create {app_name}")
        print(f"       fly volumes create atlas_store --region cdg --size 1 -a {app_name}")
        print( "  3. Set the secrets. <TOKEN> = a GitHub fine-grained PAT with Contents:Read-and-write")
        print( "     on the mind repo — create it at https://github.com/settings/personal-access-tokens/new")
        print( "     (Repository access: only that repo; Permissions: Contents -> Read and write).")
        print(f"       fly secrets set -a {app_name} \\")
        print( "         SESSION_SECRET=$(python3 -c \"import secrets;print(secrets.token_hex(32))\") \\")
        print( "         GITHUB_REPO_URL=\"https://x-access-token:<TOKEN>@github.com/<you>/<your-mind>.git\"")
        print( "  4. Deploy:")
        print( "       fly deploy -c deploy/fly.toml")
        print( "  5. First boot clones the repo + builds the viewer. Create the admin account —")
        print( "     easiest over SSH, NO setup token needed:")
        print(f"       fly ssh console -a {app_name} -C \"atlas user add /app/repo --email you@example.com --role admin --password 'CHANGE-ME'\"")
        print( "     (Or open the URL and paste the /setup token from `fly logs`.) Then log in.")
        print( "  6. Edits via the viewer/MCP auto-commit+push to your GitHub repo.")
        print( "  Optional: for INSTANT push-to-update (vs the ~5 min poll), set a")
        print( "  GITHUB_WEBHOOK_SECRET secret + a GitHub webhook to /webhook/github (see deploy/fly.toml).")
    else:
        print("Going online with systemd (venv install behind a TLS reverse proxy):")
        print( "  Follow the commented header of deploy/atlas.service (create the atlas user,")
        print( "  the venv, install atlas-mind, place your mind, set SESSION_SECRET via")
        print( "  `systemctl edit atlas`, then enable the service). Front it with Caddy/nginx for TLS.")
    # Print the upgrade command right next to the deploy (mirror of `update`).
    print()
    update_hint = f"{_invocation()} update --target {args.target}"
    if args.target == "fly" and app_name:
        update_hint += f" --app {app_name}"
    print(f"To update the engine later (new atlas-mind version):\n  {update_hint}")
    return 0


def cmd_update(args) -> int:
    """Update a DEPLOYED instance to the newest engine (mirror of `deploy`). Prints
    the exact command for the target (runs it with --run for fly/compose). The
    pip-based images cache the install layer, hence the --no-cache that forces the
    new version."""
    target = args.target

    if target == "fly":
        mind = _require_mind(args.dir)
        chosen = args.app
        if chosen is None and sys.stdin.isatty():
            chosen = _prompt("Fly app name", _fly_app_slug(mind.name))
        app_name = _fly_app_slug(chosen if chosen is not None else mind.name)
        fly_args = ["deploy", "-a", app_name, "-c", "deploy/fly.toml", "--no-cache"]
        print("Update the engine on Fly.io (rebuilds the image so pip pulls the")
        print("latest atlas-mind; content is re-cloned and the volume is preserved):")
        print(f"  (from {mind})  fly {' '.join(fly_args)}")
        if not args.run:
            print("  -> re-run with --run to execute it now.")
            return 0
        fly = shutil.which("fly") or shutil.which("flyctl")
        if not fly:
            raise CliError("the `fly` CLI is required for --run "
                           "(https://fly.io/docs/flyctl/install/).")
        return subprocess.run([fly, *fly_args], cwd=str(mind)).returncode

    if target == "compose":
        mind = _require_mind(args.dir)
        cf = "deploy/docker-compose.yml"
        print("Update the engine with Docker Compose (rebuilds atlas so pip pulls")
        print("the latest atlas-mind; the mounted mind is untouched):")
        print(f"  (from {mind})")
        print(f"  docker compose -f {cf} build --no-cache atlas")
        print(f"  docker compose -f {cf} up -d")
        if not args.run:
            print("  -> re-run with --run to execute it now.")
            return 0
        docker = shutil.which("docker")
        if not docker:
            raise CliError("the `docker` CLI is required for --run.")
        if subprocess.run([docker, "compose", "-f", cf, "build", "--no-cache",
                           "atlas"], cwd=str(mind)).returncode != 0:
            raise CliError("compose build failed — fix the issue above and re-run.")
        return subprocess.run([docker, "compose", "-f", cf, "up", "-d"],
                              cwd=str(mind)).returncode

    # systemd: runs on the server as root — print-only (nothing to execute here).
    print("Update the engine on a systemd host (run these ON the server):")
    print('  sudo -u atlas /opt/atlas/venv/bin/pip install -U "atlas-mind[bcrypt]"')
    print("  sudo systemctl restart atlas")
    print("The content and the .atlas registry (accounts/tokens/2FA) are preserved.")
    return 0


# ─── user ──────────────────────────────────────────────────────────────────────


def _normalize_email(raw: str) -> str:
    email = (raw or "").strip().lower()
    # \s rejects whitespace/control chars (would be re-printed raw by `user list`);
    # both sides of the @ are mandatory.
    if not re.fullmatch(r"[^@\s]+@[^@\s]+", email):
        raise CliError(f"invalid email: {raw!r}")
    return email


def _ask_password() -> str:
    password = getpass.getpass("Password (hidden input): ")
    confirmation = getpass.getpass("Confirmation: ")
    if password != confirmation:
        raise CliError("passwords differ, aborting.")
    return password


def cmd_user_add(args) -> int:
    mind = _require_mind(args.dir)
    file_store = _file_store(_load_config(mind))
    email = _normalize_email(args.email)
    if file_store.get_user_by_email(email) is not None:
        raise CliError(
            f"the email {email} is already taken — run `atlas user remove` first "
            "to replace it.")
    password = args.password if args.password is not None else _ask_password()
    if len(password) < MIN_PASSWORD_LENGTH:
        raise CliError(
            f"password too short (minimum {MIN_PASSWORD_LENGTH} characters).")
    file_store.upsert_user(email, {
        "password_hash": store.hash_password(password),
        "role": args.role,
        "created_at": int(time.time()),
    })
    print(f"Account created: {email} (role {args.role})")
    return 0


def cmd_user_list(args) -> int:
    mind = _require_mind(args.dir)
    file_store = _file_store(_load_config(mind))
    users = file_store.list_users()
    if not users:
        print("No accounts. (run `atlas user add <dir> --email …` to create one.)")
        return 0
    for user in users:
        email = user.get("email", "?")
        role = user.get("role", "?")
        note = ""
        if role == store.API_ROLE:
            label = user.get("label", "?")
            state = "token active" if user.get("api_token_hash") else "token revoked"
            note = f"  (label {label}, {state})"
        print(f"{email}  {role}{note}")
    return 0


def cmd_user_remove(args) -> int:
    mind = _require_mind(args.dir)
    file_store = _file_store(_load_config(mind))
    email = _normalize_email(args.email)
    if not file_store.delete_user(email):
        raise CliError(f"no account {email} in this mind.")
    print(f"Account removed: {email}")
    return 0


# ─── token ─────────────────────────────────────────────────────────────────────


def _token_email(label: str) -> str:
    """Identity email of the token, derived from the label. The default label
    "claude" yields claude@api.local (the legacy identity). Delegates to
    store.token_email (source of truth for the format) and translates the
    validation error into a human CliError."""
    try:
        return store.token_email(label)
    except ValueError:
        raise CliError(f"invalid token label: {label!r}")


def cmd_token_create(args) -> int:
    mind = _require_mind(args.dir)
    file_store = _file_store(_load_config(mind))
    email = _token_email(args.label)
    existing = file_store.get_user_by_email(email)
    if existing is not None and existing.get("role") != store.API_ROLE:
        raise CliError(
            f"{email} is already taken by a {existing.get('role')!r} account — "
            "choose another label.")

    # Token format factored into store.new_api_token_fields — shared with the
    # server's admin endpoints.
    token, fields = store.new_api_token_fields(
        args.label, set_unusable_password=existing is None)
    file_store.upsert_user(email, fields)

    action = "regenerated (the old one is revoked)" if existing else "created"
    print()
    print("=" * 72)
    print(f"API token {action} for {email} (label: {args.label})")
    print("=" * 72)
    print()
    print(f"  {token}")
    print()
    print("This token will never be shown again. Copy it now.")
    print()
    print("Usage:")
    print("  REST : header  Authorization: Bearer <token>  on /api/v1/*")
    print("  MCP  : URL /mcp/<token> (custom Claude.ai connector)")
    print()
    print(f"To revoke it: atlas token revoke <dir> --label {args.label}")
    return 0


def cmd_token_list(args) -> int:
    mind = _require_mind(args.dir)
    file_store = _file_store(_load_config(mind))
    tokens = [u for u in file_store.list_users()
              if u.get("role") == store.API_ROLE]
    if not tokens:
        print("No API tokens. (run `atlas token create <dir>` to issue one.)")
        return 0
    for record in tokens:
        label = record.get("label", "?")
        email = record.get("email", "?")
        state = "active" if record.get("api_token_hash") else "revoked"
        created = _format_timestamp(record.get("api_token_created_at"))
        print(f"{label}  {email}  {state}  created on {created}")
    return 0


def cmd_token_revoke(args) -> int:
    mind = _require_mind(args.dir)
    file_store = _file_store(_load_config(mind))
    email = _token_email(args.label)
    record = file_store.get_user_by_email(email)
    if record is None:
        print(f"No token \"{args.label}\" ({email}): nothing to revoke.")
        return 0
    if record.get("role") != store.API_ROLE:
        raise CliError(f"{email} is not an API account (role {record.get('role')!r}).")
    if not record.get("api_token_hash"):
        print(f"Token \"{args.label}\" already revoked: nothing to do.")
        return 0
    file_store.upsert_user(email, {
        "api_token_hash": None,
        "api_token_revoked_at": int(time.time()),
    })
    print(f"Token \"{args.label}\" revoked: every call will now return 401.")
    print("To reissue: atlas token create <dir> --label " + args.label)
    return 0


# ─── share ─────────────────────────────────────────────────────────────────────


def cmd_share_list(args) -> int:
    mind = _require_mind(args.dir)
    file_store = _file_store(_load_config(mind))
    shares = file_store.list_shares(include_revoked=True)
    if not shares:
        print("No share links.")
        return 0
    now = int(time.time())
    for share in shares:
        if share.get("revoked"):
            state = "revoked"
        elif share.get("expires_at") and share["expires_at"] < now:
            state = "expired"
        else:
            state = "active"
        expires = _format_timestamp(share.get("expires_at"))
        print(f"{share.get('id')}  {share.get('path')}  {state}  expires on {expires}")
    return 0


def cmd_share_revoke(args) -> int:
    mind = _require_mind(args.dir)
    file_store = _file_store(_load_config(mind))
    if not file_store.revoke_share(args.id):
        raise CliError(f"link not found or already revoked: {args.id}")
    print(f"Link revoked: {args.id}")
    return 0


# ─── argparse ──────────────────────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="atlas",
        description="Atlas engine: scaffolding, server, build and "
                    "administration of a mind's file registry.")
    subparsers = parser.add_subparsers(dest="command", metavar="<command>",
                                       required=True)

    p_init = subparsers.add_parser(
        "init", help="Scaffold a new mind (atlas.toml, content/, git).")
    p_init.add_argument("dir", nargs="?", default=".",
                        help="Directory of the mind to create (default: current directory).")
    p_init.add_argument("--force", action="store_true",
                        help="Scaffold even if the directory is not empty "
                             "(existing files are kept).")
    # Prompted on a TTY, or set via these flags (--yes skips the prompts).
    p_init.add_argument("--lang", choices=("en", "fr"), default=None,
                        help="Interface language (default: en).")
    p_init.add_argument("--prefix", default=None,
                        help='Brand prefix shown before "Atlas" (e.g. Acme).')
    p_init.add_argument("--tagline", default=None,
                        help="Tagline on the viewer's home page.")
    p_init.add_argument("--yes", "-y", action="store_true",
                        help="Skip the interactive prompts (use flags/defaults).")
    p_init.set_defaults(func=cmd_init)

    p_serve = subparsers.add_parser(
        "serve", help="Start the server on this mind (local mode by default).")
    p_serve.add_argument("dir", nargs="?", default=".", help="Directory of the mind (default: current directory).")
    p_serve.add_argument("--port", type=int, default=None,
                         help="Listening port (default: atlas.toml or 8765).")
    p_serve.set_defaults(func=cmd_serve)

    p_dev = subparsers.add_parser(
        "dev", help="Local CLOUD sandbox: login/share/2FA/admin with NO git "
                    "push/commit, a seeded dev@local/dev admin, on a throwaway "
                    "copy of the demo mind.")
    p_dev.add_argument("dir", nargs="?", default=None,
                       help="Throwaway mind location (default: a gitignored "
                            ".dev-mind next to the engine).")
    p_dev.add_argument("--port", type=int, default=None,
                       help="Listening port (default: 8765).")
    p_dev.add_argument("--fresh", action="store_true",
                       help="Do NOT seed the admin — exercise the first-boot "
                            "/setup token flow instead.")
    p_dev.add_argument("--reset", action="store_true",
                       help="Wipe the dev mind (accounts + edits) and re-seed it.")
    p_dev.set_defaults(func=cmd_dev)

    p_build = subparsers.add_parser(
        "build", help="Generate this mind's viewer (dist/).")
    p_build.add_argument("dir", nargs="?", default=".", help="Directory of the mind (default: current directory).")
    p_build.add_argument("--offline", action="store_true",
                         help="Self-contained monolith index-offline.html (file://).")
    p_build.add_argument("--as", dest="as_email", default=None, metavar="EMAIL",
                         help="With --offline: embed only the docs visible to this "
                              "account (default: the common socle only — no private "
                              "docs of any account).")
    p_build.set_defaults(func=cmd_build)

    p_deploy = subparsers.add_parser(
        "deploy", help="Scaffold deployment files + print a going-online guide.")
    p_deploy.add_argument("dir", nargs="?", default=".", help="Directory of the mind (default: current directory).")
    p_deploy.add_argument("--target", choices=tuple(_DEPLOY_TARGETS),
                          default="compose",
                          help="Deployment target (default: compose = Docker + Caddy).")
    p_deploy.add_argument("--force", action="store_true",
                          help="Overwrite existing deployment files.")
    p_deploy.add_argument("--app", default=None,
                          help="Fly app name (default: a slug of the mind folder; "
                               "prompted on a TTY). fly target only.")
    p_deploy.add_argument("--provision", action="store_true",
                          help="fly target: also run `fly apps create` + "
                               "`fly volumes create` for you (needs the fly CLI).")
    p_deploy.add_argument("--wizard", action="store_true",
                          help="fly target: full guided deploy (provision + secrets "
                               "+ deploy + admin) in one interactive flow.")
    p_deploy.add_argument("--region", default="cdg",
                          help="Fly region for --provision/--wizard (default: cdg).")
    p_deploy.set_defaults(func=cmd_deploy)

    p_update = subparsers.add_parser(
        "update",
        help="Update a deployed instance to the newest engine (mirror of deploy).")
    p_update.add_argument("dir", nargs="?", default=".", help="Directory of the mind (default: current directory).")
    p_update.add_argument("--target", choices=tuple(_DEPLOY_TARGETS),
                          default="compose",
                          help="Deployment target to update (default: compose).")
    p_update.add_argument("--app", default=None,
                          help="Fly app name (fly target; default: slug of the mind "
                               "folder, prompted on a TTY).")
    p_update.add_argument("--run", action="store_true",
                          help="Execute the update now (fly/compose; needs the relevant CLI).")
    p_update.set_defaults(func=cmd_update)

    p_user = subparsers.add_parser(
        "user", help="Accounts in the mind's file registry (.atlas/users.json).")
    user_sub = p_user.add_subparsers(dest="action", metavar="<action>",
                                     required=True)
    p_user_add = user_sub.add_parser("add", help="Create an account.")
    p_user_add.add_argument("dir", nargs="?", default=".", help="Directory of the mind (default: current directory).")
    p_user_add.add_argument("--email", required=True)
    p_user_add.add_argument("--role", choices=("admin", "viewer"),
                            default="admin")
    p_user_add.add_argument("--password", default=None,
                            help="Password (otherwise prompted with hidden input).")
    p_user_add.set_defaults(func=cmd_user_add)
    p_user_list = user_sub.add_parser("list", help="List the accounts.")
    p_user_list.add_argument("dir", nargs="?", default=".", help="Directory of the mind (default: current directory).")
    p_user_list.set_defaults(func=cmd_user_list)
    p_user_remove = user_sub.add_parser("remove", help="Remove an account.")
    p_user_remove.add_argument("dir", nargs="?", default=".", help="Directory of the mind (default: current directory).")
    p_user_remove.add_argument("--email", required=True)
    p_user_remove.set_defaults(func=cmd_user_remove)

    p_token = subparsers.add_parser(
        "token", help="Bearer API tokens (role 'api', /api/v1 and /mcp).")
    token_sub = p_token.add_subparsers(dest="action", metavar="<action>",
                                       required=True)
    p_token_create = token_sub.add_parser(
        "create", help="Issue a 256-bit token (shown ONLY once).")
    p_token_create.add_argument("dir", nargs="?", default=".", help="Directory of the mind (default: current directory).")
    p_token_create.add_argument("--label", default=DEFAULT_TOKEN_LABEL,
                                help=f"Identifies the token (default: {DEFAULT_TOKEN_LABEL}).")
    p_token_create.set_defaults(func=cmd_token_create)
    p_token_list = token_sub.add_parser("list", help="List the tokens.")
    p_token_list.add_argument("dir", nargs="?", default=".", help="Directory of the mind (default: current directory).")
    p_token_list.set_defaults(func=cmd_token_list)
    p_token_revoke = token_sub.add_parser(
        "revoke", help="Revoke a token (cuts off access immediately).")
    p_token_revoke.add_argument("dir", nargs="?", default=".", help="Directory of the mind (default: current directory).")
    p_token_revoke.add_argument("--label", default=DEFAULT_TOKEN_LABEL)
    p_token_revoke.set_defaults(func=cmd_token_revoke)

    p_share = subparsers.add_parser(
        "share", help="Share links of the file registry.")
    share_sub = p_share.add_subparsers(dest="action", metavar="<action>",
                                       required=True)
    p_share_list = share_sub.add_parser("list", help="List the links (including revoked ones).")
    p_share_list.add_argument("dir", nargs="?", default=".", help="Directory of the mind (default: current directory).")
    p_share_list.set_defaults(func=cmd_share_list)
    p_share_revoke = share_sub.add_parser("revoke", help="Revoke a link by id.")
    p_share_revoke.add_argument("dir", nargs="?", default=".", help="Directory of the mind (default: current directory).")
    p_share_revoke.add_argument("--id", required=True, dest="id",
                                help="Link id (see `atlas share list`).")
    p_share_revoke.set_defaults(func=cmd_share_revoke)

    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except CliError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
    except (OSError, ValueError) as e:
        # Environment errors (PermissionError, full disk…) and corrupted registry
        # (ValueError from store._load): human message, never a traceback.
        print(f"Error: {e}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
