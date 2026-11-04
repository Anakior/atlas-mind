#!/usr/bin/env python3
"""Atlas engine CLI: scaffolding, serve, build and administration of a mind's
file registry (accounts, API tokens, share links).

Usage:

    python3 src/cli.py init <dir> [--force] [--lang en|fr] [--prefix P] [--tagline T] [--yes]
    python3 src/cli.py serve <dir> [--port N]
    python3 src/cli.py dev [--port N] [--fresh] [--reset]
    python3 src/cli.py dev seed [<dir>]                       # DEV-ONLY sample data
    python3 src/cli.py dev inbox "<title>" [<dir>]            # DEV-ONLY single item
    python3 src/cli.py build <dir> [--offline]
    python3 src/cli.py deploy <dir> [--target compose|systemd|fly] [--app NAME] [--wizard] [--force]
    python3 src/cli.py user add <dir> --email a@b.c [--role admin|viewer] [--password ...]
    python3 src/cli.py user list <dir>
    python3 src/cli.py user remove <dir> --email a@b.c
    python3 src/cli.py token create <dir> [--label claude]
    python3 src/cli.py token list <dir>
    python3 src/cli.py token revoke <dir> [--label claude]
    python3 src/cli.py token revoke-all <dir> --acts-as a@b.c
    python3 src/cli.py share list <dir>
    python3 src/cli.py share revoke <dir> --id <id>
    python3 src/cli.py setup-code [--url https://my-atlas.example]
    python3 src/cli.py export <dir> [--out notes.zip]
    python3 src/cli.py import <file|folder|zip> [--into folder] [--dir <mind>]
    python3 src/cli.py sync <https://my-atlas.example> [<dir>]   # a copy here, then: sync <dir> [--every 60]
    python3 src/cli.py doctor <dir> [--fix | --sync]

All user/token/share commands operate on the mind's FileStore
(<mind>/.atlas by default, or store.dir from atlas.toml).
"""
from __future__ import annotations

import argparse
import base64
import datetime
import getpass
import hashlib
import json
import os
import platform
import re
import secrets
import shutil
import stat
import subprocess
import sys
import time
import uuid
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit

ENGINE_SRC = Path(__file__).resolve().parent
if str(ENGINE_SRC) not in sys.path:
    sys.path.insert(0, str(ENGINE_SRC))

import store  # noqa: E402
from config import AtlasConfig, AtlasConfigError, DEFAULT_PORT, toml_string  # noqa: E402

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


def _run_build(mind: Path, *, offline: bool = False, as_email: str | None = None) -> int:
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
tagline = {tagline}
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
# Served under a sub-path of its address (https://example.com/notes): any depth. Behind a
# proxy that keeps the path or one that takes it off, the same setting works.
# base_path = "/notes"

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
    # Typed in a form, a name may hold a quote: escaped, it cannot break the file.
    prefix_line = (f"prefix = {toml_string(prefix)}" if prefix else '# prefix = "Acme"')
    return ATLAS_TOML_TEMPLATE.format(
        prefix_line=prefix_line, tagline=toml_string(tagline), lang=lang)


# ── Scaffolded documents (English default, French variant via --lang fr) ───────

WELCOME_MD_EN = """\
---
tags: [help]
---

# Welcome to your Atlas

Your Atlas is your memory: notes of your own that your AI can read, search and add
to when you ask it. Everything stays in plain files you can open elsewhere and take
with you whenever you like.

## Getting started

- **Connect your AI**: on the home page, "Add to Claude". Then just tell it "note
  this in my Atlas" or "what does my Atlas say about…".
- **Write a note**: the **+** button at the top of the menu. A title is enough.
- **File things your way**: folders are free-form. The **Inbox** receives what your
  AI suggests keeping: you choose what stays.

## Writing

Notes are written in Markdown, the format of plain notes: `# Title`, `- list`,
`**bold**`. The editor's toolbar does it for you.

- To link two notes, write the other one's name between double brackets:
  [[notes/example]]. The link works both ways: the linked note shows what points
  to it.
- To add tags, start the note with:

  ```
  ---
  tags: [project, idea]
  ---
  ```

## Nothing gets lost

Every change is kept in the note's history, whether it came from you or your AI:
you can look at a past version, or undo what an AI did. A deleted note goes to the
**Trash**, where it can be restored.
"""

EXAMPLE_MD_EN = """\
# Example note

An ordinary note, filed under `notes/`. The link [[welcome]] goes back to the
welcome note: a note's name between double brackets is enough, its path
(`notes/example`) settles two notes of the same name, and
`[[welcome|other text]]` changes the text shown.
"""

AGENTS_MD_EN = """\
# Instructions for your AI

Your AI assistant reads this document every time it connects to your Atlas. Adapt
it: this is where you tell it how to work with you. Keep it short and directive
(8,000 characters at most).

## Principle

- The Atlas is the **source of truth**. Before answering on a topic already noted,
  search and read the Atlas rather than guessing.
- What is worth keeping (a recap, a decision, an idea, an analysis) is **written into
  the Atlas**, not left in the conversation.
- When you were not asked to write, suggest an item in the **Inbox** instead: the
  person decides whether to keep it.

## Filing (adapt it)

- `notes/` — miscellaneous notes, quick captures.
- `ai-sessions/` — saved work sessions (template: `ai-sessions/TEMPLATE.md`).
- `agents/` — reusable agent instructions (see `agents/README.md`).
- Add your own folders: projects/, meetings/, courses/…

## Rules

- Talk plainly to the person: no technical terms (commit, MCP, frontmatter…) unless
  they use them.
- No date in filenames: the name describes the **topic**, lowercase with hyphens.
- Ask before writing if the folder is not obvious.
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

## Prompts

Each Markdown file in `prompts/` is a prompt every connected assistant offers you by
name (a `/` command in Claude Code): its frontmatter gives a `description` and its
`arguments` (`subject, folder?`, `?` = optional), its first heading the title, the
rest the text sent. `{{subject}}` takes the value you give, `{{include path/doc.md}}`
the text of that document. See `prompts/save-session.md`.
"""

PROMPT_SAVE_SESSION_MD_EN = """\
---
description: Save this work session into the Atlas, following the session template.
arguments: subject
---
# Save this session

Save our work session about "{{subject}}" into this Atlas, following the template
below. Fill each section from our conversation and keep it factual. Create it with
create_doc under ai-sessions/, with a kebab-case name that describes the subject
(no date in it).

{{include ai-sessions/TEMPLATE.md}}
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

# Bienvenue dans ton Atlas

Ton Atlas, c'est ta mémoire : des notes à toi, que ton IA peut lire, chercher et
compléter quand tu le lui demandes. Tout reste dans des fichiers simples, que tu
peux ouvrir ailleurs et emporter quand tu veux.

## Pour commencer

- **Branche ton IA** : sur l'accueil, « Ajouter à Claude ». Ensuite, dis-lui
  simplement « note ça dans mon Atlas » ou « qu'est-ce que mon Atlas dit de… ».
- **Écris une note** : le bouton **+** en haut du menu. Un titre suffit.
- **Range comme tu veux** : les dossiers sont libres. L'**Inbox** reçoit ce que
  ton IA te propose de garder : tu choisis ce qui reste.

## Écrire

Les notes s'écrivent en Markdown, le format des notes simples : `# Titre`,
`- liste`, `**gras**`. La barre d'outils de l'éditeur le fait pour toi.

- Pour relier deux notes, écris le nom de l'autre entre doubles crochets :
  [[notes/example]]. Le lien marche dans les deux sens : la note liée montre qui
  pointe vers elle.
- Pour ajouter des tags, commence la note par :

  ```
  ---
  tags: [projet, idée]
  ---
  ```

## Rien ne se perd

Chaque modification est gardée dans l'historique de la note, qu'elle vienne de
toi ou de ton IA : tu peux revoir une version passée, ou annuler ce qu'une IA a
fait. Une note supprimée part dans la **Corbeille**, d'où elle se restaure.
"""

EXAMPLE_MD_FR = """\
# Exemple de note

Une note ordinaire, rangée dans `notes/`. Le lien [[welcome]] ramène à la note
de bienvenue : le nom d'une note entre doubles crochets suffit, son chemin
(`notes/example`) lève le doute entre deux notes du même nom, et
`[[welcome|un autre texte]]` change le texte affiché.
"""

AGENTS_MD_FR = """\
# Consignes pour ton IA

Ce document est lu par ton assistant IA chaque fois qu'il se connecte à ton Atlas.
Adapte-le : c'est ici que tu lui dis comment travailler avec toi. Garde-le court et
directif (8 000 caractères au plus).

## Principe

- L'Atlas est la **source de vérité**. Avant de répondre sur un sujet déjà noté,
  cherche et lis dans l'Atlas plutôt que de deviner.
- Ce qui mérite d'être gardé (un récap, une décision, une idée, une analyse) est
  **écrit dans l'Atlas**, pas laissé dans la conversation.
- Quand on ne t'a pas demandé d'écrire, propose plutôt une fiche dans l'**Inbox** :
  la personne décide de la garder.

## Rangement (à adapter)

- `notes/` — notes diverses, captures rapides.
- `ai-sessions/` — sauvegardes de session de travail (modèle :
  `ai-sessions/TEMPLATE.md`).
- `agents/` — consignes d'agents réutilisables (voir `agents/README.md`).
- Ajoute tes dossiers : projets/, réunions/, cours/…

## Règles

- Parle simplement à la personne : pas de termes techniques (commit, MCP,
  frontmatter…) sauf si elle les emploie.
- Pas de date dans les noms de fichiers : le nom décrit le **sujet**, en minuscules
  avec des tirets.
- Demande avant d'écrire si le dossier n'est pas évident.
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

## Prompts

Chaque fichier Markdown de `prompts/` est un prompt que tout assistant connecté te
propose par son nom (une commande `/` dans Claude Code) : son frontmatter donne une
`description` et ses `arguments` (`sujet, dossier?`, `?` = optionnel), son premier
titre le titre, le reste le texte envoyé. `{{sujet}}` prend la valeur donnée,
`{{include chemin/doc.md}}` le texte de ce document. Voir `prompts/save-session.md`.
"""

PROMPT_SAVE_SESSION_MD_FR = """\
---
description: Sauvegarde cette session de travail dans l'Atlas, selon le modèle de session.
arguments: sujet
---
# Sauvegarder la session

Sauvegarde notre session de travail sur « {{sujet}} » dans cet Atlas, selon le modèle
ci-dessous. Remplis chaque section à partir de notre conversation, en restant
factuel. Crée-la avec create_doc dans ai-sessions/, avec un nom en kebab-case qui
décrit le sujet (sans date).

{{include ai-sessions/TEMPLATE.md}}
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
            ("content/agents/prompts/save-session.md", PROMPT_SAVE_SESSION_MD_FR),
        ]
    return [
        ("content/welcome.md", WELCOME_MD_EN),
        ("content/notes/example.md", EXAMPLE_MD_EN),
        ("AGENTS.md", AGENTS_MD_EN),
        ("content/agents/README.md", AGENTS_README_MD_EN),
        ("content/ai-sessions/TEMPLATE.md", AI_SESSION_TEMPLATE_MD_EN),
        ("content/agents/prompts/save-session.md", PROMPT_SAVE_SESSION_MD_EN),
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


def _first_commit(mind: Path) -> str:
    """The scaffold's root commit: the mind has a history from the start, so the
    server's path-scoped commits build on a HEAD and nobody has to commit by hand.
    Made as Atlas, whose starter docs these are: not the machine's git user's, nor
    Claude's when Claude Code runs the init (CLAUDECODE would trip the hook)."""
    env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}

    def _git(*args):
        return subprocess.run(["git", *args], cwd=str(mind), capture_output=True,
                              text=True, env=env)

    if shutil.which("git") is None or not (mind / ".git").exists():
        return "no repo: no first commit."
    if _git("rev-parse", "--verify", "-q", "HEAD").returncode == 0:
        return "history already present, kept."
    _git("add", "-A")
    result = _git("-c", "user.name=Atlas", "-c", "user.email=atlas@localhost",
                  "commit", "-q", "-m", "chore: new mind")
    if result.returncode != 0:
        return f"first commit failed: {(result.stderr or result.stdout).strip()}"
    return "first commit made."


def init_mind(mind: Path, lang: str, prefix: str = "", tagline: str = "") -> dict:
    """Scaffold a mind (never overwriting a file), make it a git repo with its first
    commit and the Claude Code hook. Shared by `atlas init` and a cloud boot that has
    no repo to clone. Returns what it did, for the caller to report."""
    tagline = tagline or (DEFAULT_TAGLINE_FR if lang == "fr" else DEFAULT_TAGLINE_EN)
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
    hook_message = _install_commit_hook(mind)[1]
    return {"created": created, "kept": kept, "git": git_message,
            "hook": hook_message, "commit": _first_commit(mind)}


# Claude Code runs its shell with CLAUDECODE=1, so a commit made there is Claude's even
# when its message lacks the trailers Atlas reads. A message that names its author
# already, and a merge (it brings in others' work), are left alone.
_HOOK_MARK = "# atlas: prepare-commit-msg"
_COMMIT_HOOK = f"""#!/bin/sh
{_HOOK_MARK}, marks a commit made from Claude Code as written by Claude.
[ "$CLAUDECODE" = 1 ] || exit 0
[ "$2" = merge ] && exit 0
grep -qi '^X-Atlas-Author:' "$1" && exit 0
host=$(hostname | tr -d '\\r' | tr '[:upper:]' '[:lower:]')
exec git interpret-trailers --in-place --trailer "X-Atlas-Author: ai/claude" \\
  --trailer "X-Atlas-Token: claude-code-$host" "$1"
"""


def _install_commit_hook(mind: Path) -> tuple:
    """Write the prepare-commit-msg hook into the mind's repo (wherever core.hooksPath
    puts it); a hook that is not Atlas's is left as is. Returns (installed, message)."""
    if shutil.which("git") is None:
        return False, "git not found: commit hook not installed."
    r = subprocess.run(["git", "rev-parse", "--git-path", "hooks"],
                       cwd=str(mind), capture_output=True, text=True)
    if r.returncode != 0:
        return False, f"{mind} is not a git repository: commit hook not installed."
    hook = mind / r.stdout.strip() / "prepare-commit-msg"
    if hook.exists() and _HOOK_MARK not in hook.read_text(encoding="utf-8", errors="replace"):
        return False, f"{hook} already exists and is not Atlas's: left as is."
    hook.parent.mkdir(parents=True, exist_ok=True)
    hook.write_text(_COMMIT_HOOK, encoding="utf-8", newline="\n")
    hook.chmod(0o755)
    return True, "commit hook installed: commits made from Claude Code are marked as Claude's."


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
    done = init_mind(mind, lang, prefix, tagline)

    print(f"Mind initialized: {mind}")
    for path in done["created"]:
        print(f"  created : {path.relative_to(mind)}")
    for path in done["kept"]:
        print(f"  kept    : {path.relative_to(mind)} (existing, untouched)")
    print(f"  git     : {done['git']}")
    print(f"  hook    : {done['hook']}")
    print(f"  commit  : {done['commit']}")
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
    print(f"  git -C {mind} push -u origin main")
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


def _user_cache_dir() -> Path:
    """OS-appropriate per-user cache dir: %LOCALAPPDATA% on Windows, $XDG_CACHE_HOME
    (or ~/.cache) elsewhere. Falls back to the home-relative default if the env var
    is unset."""
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA")

        return Path(base) if base else Path.home() / "AppData" / "Local"

    return Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")


# Default throwaway location: a per-user cache dir OUTSIDE the engine checkout, so the
# sandbox's own .git isn't picked up as a nested repo by editors (VSCode Source Control)
# and doesn't clutter the project tree. State (accounts, edits) persists across runs
# there; --reset wipes it.
_DEFAULT_DEV_MIND = _user_cache_dir() / "atlas" / "dev-mind"


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
    # Always rebuild the viewer: a dev sandbox must reflect the current engine src
    # on every start, so it never serves a stale dist/ from a previous run.
    if _run_build(scratch) != 0:
        print("warning: viewer build failed; serving the previous build.", file=sys.stderr)
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


# ─── dev seeding (DEV-ONLY) ──────────────────────────────────────────────────
# `atlas dev seed` / `atlas dev inbox` populate a mind with sample data so the home
# Activity card and the Inbox render WITHOUT real git history or upstream agents —
# the missing pieces that make a fresh/dev mind show empty + stuck-skeleton states.
#
# DEV-ONLY: this MUTATES the mind (writes docs, sets ACLs, makes git commits). It only
# ever targets a throwaway dev mind (default: the .dev-mind sandbox) and refuses a mind
# wired to a git remote. It deliberately reuses the LIVE code paths so the seeded data is
# identical to production output: the MCP create_inbox_item tool
# (server.pure.mcp_call._tool_create_inbox_item) for inbox items, and GitSync.commit_change
# for the attributed Activity commits.

# Pinned to the dev sandbox's seeded admin (dev@local / dev): the inbox items land in THAT
# person's owned lane, so they appear once you log into `atlas dev`.
_DEV_SEED_EMAIL = "dev@local"

# Inbox samples: varied sources (the source becomes the origin badge), a suggested
# destination, tags, a short preview and a confidence — every field the triage UI shows.
_DEV_INBOX_SAMPLES = (
    {"source": "gmail", "title": "Invoice from Hetzner — June",
     "content": "Monthly hosting invoice (47.20 EUR) is ready. File it under finance once paid.",
     "confidence": 0.82, "suggest_dest": "finance/invoices",
     "suggest_tags": ["finance", "invoice"]},
    {"source": "sentry", "title": "TypeError in checkout flow (prod)",
     "content": "Cannot read properties of undefined (reading 'total') in cart.js — 23 events, 9 users in the last hour.",
     "confidence": 0.66, "suggest_dest": "incidents",
     "suggest_tags": ["incident", "prod", "frontend"]},
    {"source": "manual", "title": "Idea: weekly digest of the inbox",
     "content": "Send myself a Monday email summarizing what landed in the inbox over the week.",
     "confidence": 0.5, "suggest_dest": "ideas",
     "suggest_tags": ["idea", "product"]},
    {"source": "gmail", "title": "Re: Q3 roadmap sync — notes",
     "content": "Action items from the roadmap sync: cut scope on the editor rewrite, ship search first.",
     "confidence": 0.74, "suggest_dest": "meetings",
     "suggest_tags": ["meeting", "roadmap"]},
)

# Activity samples: plain commons docs, each committed under a DISTINCT author/email and
# back-dated a few days apart, so the Journal spans several days and the contributor
# constellation has several people to render.
_DEV_ACTIVITY_SAMPLES = (
    {"author": ("Ada Lovelace", "ada@dev.local"), "rel": "notes/architecture-overview.md",
     "title": "Architecture overview",
     "body": "How the pieces fit together. See [[welcome]] for the entry point.", "days_ago": 6},
    {"author": ("Linus Torvalds", "linus@dev.local"), "rel": "notes/git-workflow.md",
     "title": "Git workflow",
     "body": "Branch, commit small, rebase before push. Trunk stays green.", "days_ago": 4},
    {"author": ("Grace Hopper", "grace@dev.local"), "rel": "notes/debugging-playbook.md",
     "title": "Debugging playbook",
     "body": "Reproduce, bisect, add a failing test, fix, keep the test.", "days_ago": 2},
    {"author": ("Ada Lovelace", "ada@dev.local"), "rel": "notes/api-design-notes.md",
     "title": "API design notes",
     "body": "Small, orthogonal endpoints. Errors are data. Links over IDs.", "days_ago": 1},
)


def _resolve_seed_mind(raw: str | None) -> Path:
    """Mind to seed: the explicit dir, else the .dev-mind sandbox. The default sandbox is
    scaffolded on demand (so `atlas dev seed` is turnkey from nothing); an explicit dir
    must already be a mind."""
    if raw:
        mind = Path(raw).expanduser().resolve()
        if not (mind / "content").is_dir():
            raise CliError(f"{mind} is not a mind (no content/) — run `atlas init {raw}` first.")
        return mind
    mind = _DEFAULT_DEV_MIND
    if not (mind / "content").is_dir():
        _seed_dev_mind(mind, reset=False)
    return mind


def _guard_dev_only(mind: Path) -> None:
    """Refuse to seed a mind wired to a git remote: that signals a REAL, synced mind, and
    seeding mutates content (sample docs, commits, ACLs). Dev seeding is only ever for a
    throwaway local mind."""
    if not (mind / ".git").is_dir():
        return
    remotes = subprocess.run(["git", "remote"], cwd=str(mind),
                             capture_output=True, text=True)
    if "origin" in remotes.stdout.split():
        raise CliError(
            f"{mind} has a git remote (origin) — refusing to seed what looks like a real "
            "mind. `atlas dev seed` is DEV-ONLY and mutates content; point it at a throwaway "
            "mind (default: the .dev-mind sandbox).")


def _boot_seed_server(mind: Path):
    """Bootstrap the server module's globals (CONFIG + AppContext) against `mind` WITHOUT
    serving — the minimum of server.run() the seed needs to reuse the live inbox/commit
    code. The async git push/rebuild is neutralized: a dev mind has no remote, and the
    viewer is (re)built by `atlas dev` / `atlas serve`, so the seed only writes data plus
    the explicit attributed commits."""
    import server
    config = _load_config(mind)
    server.CONFIG = config
    server._CTX = server.AppContext.build(config, server.build_store(config))
    git_sync = server._CTX.git_sync
    git_sync._request_push = lambda: None   # real inline commits, but never push (no remote)
    git_sync.trigger_sync = lambda: None    # never spawn the background add-all / rebuild / push
    return server


def _ensure_seed_repo(mind: Path) -> None:
    """Make `mind` its OWN git repo with a committer identity and an initial commit. Critical
    before any git op: a dev mind without its own .git would make `git add/commit` walk UP
    into the enclosing engine checkout. Reuses _git_init_main."""
    if shutil.which("git") is None:
        raise CliError("git is required to seed Activity history (install git, then re-run).")
    if not (mind / ".git").exists():
        _git_init_main(mind)

    def _git(*args):
        return subprocess.run(["git", *args], cwd=str(mind), capture_output=True, text=True)

    # --author on each attributed commit sets the AUTHOR; the committer still needs an
    # identity, so pin a neutral one on the repo (dev mind, never pushed).
    _git("config", "user.email", "atlas-dev-seed@local")
    _git("config", "user.name", "Atlas Dev Seed")
    if _git("rev-parse", "--verify", "-q", "HEAD").returncode != 0:
        # Fresh repo: a root commit so `git commit --only` has a HEAD to build on.
        _git("add", "-A")
        _git("commit", "-m", "chore: dev mind scaffold", "--quiet")


def _seed_inbox(server, items) -> int:
    """Drop each sample via the MCP create_inbox_item tool, under a human ctx pinned to the
    dev admin — exactly as an agent bound to that person would. `source` (normally the
    token label) is set per item to vary the origin badge."""
    from server.pure.mcp_call import _tool_create_inbox_item
    email = _DEV_SEED_EMAIL
    created = 0
    for item in items:
        ctx = server.ViewerCtx({"*", "user:" + email}, True, "user:" + email,
                               source=item["source"])
        result = _tool_create_inbox_item({
            "title": item["title"], "content": item.get("content", ""),
            "confidence": item.get("confidence"),
            "suggest_dest": item.get("suggest_dest"),
            "suggest_tags": item.get("suggest_tags"),
        }, ctx)
        if result.get("isError"):
            print(f"  inbox: skipped {item['title']!r}: {result['content'][0]['text']}",
                  file=sys.stderr)
        else:
            created += 1
    return created


def _seed_activity(server, docs) -> int:
    """Write each sample doc into the commons and commit it under a DISTINCT author,
    back-dated, via GitSync.commit_change — so /api/activity returns attributed history."""
    git_sync = server._CTX.git_sync
    content_root = server.CONFIG.content_root
    made = 0
    for doc in docs:
        target = content_root / doc["rel"]
        if target.exists():
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(f"# {doc['title']}\n\n{doc['body']}\n", encoding="utf-8")
        when = time.strftime("%Y-%m-%d %H:%M:%S",
                             time.localtime(time.time() - doc.get("days_ago", 0) * 86400))
        # GitSync.run inherits os.environ, so these set the commit's author/committer date.
        os.environ["GIT_AUTHOR_DATE"] = when
        os.environ["GIT_COMMITTER_DATE"] = when
        try:
            git_sync.commit_change(f"created: {target.stem}", [str(target)],
                                   author=doc["author"])
        finally:
            os.environ.pop("GIT_AUTHOR_DATE", None)
            os.environ.pop("GIT_COMMITTER_DATE", None)
        made += 1
    return made


def cmd_dev_seed(args) -> int:
    """DEV-ONLY: fill a mind with sample inbox items + attributed Activity commits."""
    mind = _resolve_seed_mind(args.dir)
    _guard_dev_only(mind)
    _ensure_seed_repo(mind)
    server = _boot_seed_server(mind)
    n_inbox = _seed_inbox(server, _DEV_INBOX_SAMPLES)
    n_activity = _seed_activity(server, _DEV_ACTIVITY_SAMPLES)
    authors = len({doc["author"] for doc in _DEV_ACTIVITY_SAMPLES})
    print(f"Seeded {mind} (DEV-ONLY):")
    print(f"  inbox   : {n_inbox} sample item(s) in {_DEV_SEED_EMAIL}'s lane")
    print(f"  activity: {n_activity} sample doc(s) committed under {authors} author(s)")
    print()
    print(f"View it:  atlas dev   (log in as {_DEV_SEED_EMAIL} / dev to triage the inbox)")
    print(f"   or:    atlas serve {mind}")
    return 0


def cmd_dev_inbox(args) -> int:
    """DEV-ONLY: drop a single sample inbox item with the given title."""
    mind = _resolve_seed_mind(args.dir)
    _guard_dev_only(mind)
    server = _boot_seed_server(mind)
    if not _seed_inbox(server, [{
        "source": "manual", "title": args.title,
        "content": "Seeded via `atlas dev inbox`.", "confidence": 0.6,
        "suggest_dest": "notes", "suggest_tags": ["dev", "seed"],
    }]):
        raise CliError("could not create the inbox item (see the message above).")
    print(f"Dropped 1 inbox item {args.title!r} into {_DEV_SEED_EMAIL}'s lane in {mind}.")
    return 0


# ─── deploy ──────────────────────────────────────────────────────────────────
# Scaffolds deployment files into <mind>/deploy/ + prints a "going online" guide.
# The templates are self-contained (pull the engine from PyPI) so they work for a
# plain `pip install atlas-mind` user, with no clone of this repo.

DEPLOY_DOCKERFILE = """\
# Atlas Mind container image — installs the engine from PyPI.
FROM python:3.12-slim
# git keeps the history; ssh pushes the copy connected from Settings (GitHub deploy key).
RUN apt-get update \\
    && apt-get install -y --no-install-recommends git openssh-client ca-certificates \\
    && rm -rf /var/lib/apt/lists/*
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
# (a PRIVATE git repo) at boot. git is needed for that clone + the content push;
# ssh for a copy connected from Settings (the instance's own GitHub deploy key).
FROM python:3.12-slim
RUN apt-get update \\
    && apt-get install -y --no-install-recommends git openssh-client ca-certificates \\
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
# Cloud-mode boot: clones GITHUB_REPO_URL into KB_REPO_PATH (on the volume, set in
# fly.toml; or pulls if already there), builds the viewer, serves, and
# commits+pushes content writes back.
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
  # The content checkout lives on the volume too: a commit not pushed yet (remote
  # down, token expired) survives a restart or a redeploy instead of vanishing with
  # the rootfs. Fly hands the mount to the image's user (`app`), so it can write here.
  KB_REPO_PATH = '/data/kb'

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


def new_setup_code() -> tuple:
    """A one-time setup code and its SHA-256: the hash goes on the server
    (ATLAS_SETUP_CODE_SHA256), the code only in the /setup#code=… link."""
    code = secrets.token_urlsafe(24)
    return code, hashlib.sha256(code.encode("utf-8")).hexdigest()


def setup_link(base_url: str, code: str) -> str:
    """The link that creates the first admin. The code rides in the fragment, which
    never reaches a server or a proxy log."""
    return f"{base_url.rstrip('/')}/setup#code={code}"


def cmd_setup_code(args) -> int:
    """`atlas setup-code`: a fresh code for the first admin, without a shell on the
    server — its hash goes in the server's env, the link to whoever creates the admin."""
    code, digest = new_setup_code()
    print("1. Set this on the server (it reads it at start-up), e.g. on Fly:")
    print(f"     fly secrets set -a <your-app> ATLAS_SETUP_CODE_SHA256={digest}")
    print(f"   elsewhere: ATLAS_SETUP_CODE_SHA256={digest}")
    print("2. Open or send this link: it creates the first admin, and works only while")
    print("   no admin exists.")
    print(f"     {setup_link(args.url or 'https://<your-atlas>', code)}")
    return 0


def _fly_wizard(mind: Path, app_name: str, region: str) -> int:
    """End-to-end guided Fly deploy: provision the app + volume in the personal org
    (where Fly waives bills under $5), set the secrets, deploy, then print the
    /setup link that creates the first admin — no shell into the machine, no
    password typed here. GitHub is optional: without it a new mind starts on the
    volume. Requires an interactive terminal and the fly CLI; every outward step
    is confirmed once up front."""
    if not sys.stdin.isatty():
        raise CliError("--wizard needs an interactive terminal.")
    fly = shutil.which("fly") or shutil.which("flyctl")
    if not fly:
        raise CliError("the `fly` CLI is required for --wizard (install: "
                       "https://fly.io/docs/flyctl/install/, then `fly auth login`).")

    def run(*cmd, label, shown=None):
        # `shown`: the command as printed, when its real arguments carry secrets.
        print(f"\n-> {label}")
        print(f"   $ fly {shown or ' '.join(str(c) for c in cmd)}")
        return subprocess.run([fly, *[str(c) for c in cmd]]).returncode

    print(f"\nGuided Fly deploy — app '{app_name}' (region {region}, personal org).\n")
    env = {}
    repo = _prompt("Private GitHub repo holding the mind (<you>/<repo>), "
                   "or empty to start a new mind without GitHub", "")
    if repo:
        print("GitHub token: a fine-grained PAT with Contents: Read and write on that repo")
        print("  (create one at https://github.com/settings/personal-access-tokens/new).")
        token = getpass.getpass("GitHub token (input hidden): ").strip()
        if not token:
            raise CliError("a GitHub token is required to clone and push that repo.")
        env["GITHUB_REPO_URL"] = _build_github_repo_url(repo, token)
    else:
        lang = _prompt("Language of the new mind (en/fr)", "en")
        env["ATLAS_LANG"] = lang if lang in ("en", "fr") else "en"
    code, env["ATLAS_SETUP_CODE_SHA256"] = new_setup_code()

    print(f"\nAbout to: create the Fly app '{app_name}' + its volume, set the secrets and")
    print("deploy. Then you get the link that creates the first admin.")
    if _prompt("Proceed?", "yes").strip().lower() not in ("y", "yes", "o", "oui"):
        print("Aborted. Your deploy/ files are already written; re-run when ready.")
        return 1

    # Tolerates an existing app (a re-run).
    run("apps", "create", app_name, "--org", "personal", label=f"Create the Fly app '{app_name}'")
    existing = subprocess.run([fly, "volumes", "list", "-a", app_name],
                              capture_output=True, text=True).stdout
    if "atlas_store" in existing:
        print("\n-> Volume 'atlas_store' already exists, keeping it.")
    elif run("volumes", "create", "atlas_store", "--region", region, "--size", "1",
             "-a", app_name, "--yes", label="Create the data volume") != 0:
        raise CliError("volume creation failed — fix the issue above and re-run.")

    # SESSION_SECRET signs sessions and share links: a re-run keeps the one in place.
    set_already = subprocess.run([fly, "secrets", "list", "-a", app_name],
                                 capture_output=True, text=True).stdout
    if "SESSION_SECRET" not in set_already:
        env["SESSION_SECRET"] = secrets.token_hex(32)
    names = " ".join(f"{k}=***" for k in env)
    if run("secrets", "set", "-a", app_name, "--stage", *(f"{k}={v}" for k, v in env.items()),
           label="Set the secrets", shown=f"secrets set -a {app_name} --stage {names}") != 0:
        raise CliError("setting secrets failed — fix the issue above and re-run.")

    if run("deploy", "-c", str(mind / "deploy" / "fly.toml"),
           label="Build + deploy (waits until healthy)") != 0:
        raise CliError("deploy failed — check `fly logs` and re-run.")

    print("\n[done] Your Atlas is online. Create its first admin with this link — open it")
    print("yourself, or send it to the person who will use this Atlas:")
    print(f"  {setup_link(f'https://{app_name}.fly.dev', code)}")
    print("It works until an admin exists. Lost it? `atlas setup-code` makes a new one.")
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
        print(f"Going online on Fly.io as '{app_name}'.")
        print("  TIP: re-run with --wizard to do ALL of the steps below interactively")
        print("  (provision, secrets, deploy, first-admin link) — no shell, no manual juggling.")
        print(f"  1. Optional: push {mind} to a PRIVATE GitHub repo (atlas.toml + content/, no")
        print( "     engine code) to keep a copy there. Without it a new mind starts on the volume.")
        print( "  2. Create the app in your personal org (Fly waives its bills under $5) and the")
        print( "     data volume (the app name is already in deploy/fly.toml):")
        print(f"       fly apps create {app_name} --org personal")
        print(f"       fly volumes create atlas_store --region cdg --size 1 -a {app_name}")
        print(f"  3. Make a first-admin code: `{_invocation()} setup-code --url https://{app_name}.fly.dev`")
        print( "     prints its ATLAS_SETUP_CODE_SHA256 and the link. Then set the secrets:")
        print(f"       fly secrets set -a {app_name} \\")
        print( "         SESSION_SECRET=$(python3 -c \"import secrets;print(secrets.token_hex(32))\") \\")
        print( "         ATLAS_SETUP_CODE_SHA256=<from setup-code> \\")
        print( "         GITHUB_REPO_URL=\"https://x-access-token:<TOKEN>@github.com/<you>/<your-mind>.git\"")
        print( "     (GITHUB_REPO_URL only with a repo. <TOKEN> = a fine-grained PAT, that repo only,")
        print( "     Contents: Read and write — https://github.com/settings/personal-access-tokens/new.")
        print( "     Without a repo, ATLAS_LANG=fr or en picks the new mind's language.)")
        print( "  4. Deploy:")
        print( "       fly deploy -c deploy/fly.toml")
        print( "  5. Open the setup-code link (or send it to whoever will use this Atlas): it")
        print( "     creates the first admin, who picks their own password.")
        print( "  6. Edits via the viewer/MCP are committed, and pushed to the repo if there is one.")
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
    if args.password == "-":
        password = sys.stdin.readline().rstrip("\r\n")
    else:
        password = args.password if args.password is not None else _ask_password()
    if len(password) < MIN_PASSWORD_LENGTH:
        raise CliError(
            f"password too short (minimum {MIN_PASSWORD_LENGTH} characters).")
    doc = {
        "password_hash": store.hash_password(password),
        "role": args.role,
        "created_at": int(time.time()),
    }
    for field, raw in (("first_name", args.first_name), ("last_name", args.last_name)):
        if raw is None:
            continue
        if not store.valid_name(raw):
            raise CliError(f"invalid {field}: {raw!r}")
        doc[field] = raw.strip()
    file_store.upsert_user(email, doc)
    print(f"Account created: {email} (role {args.role})")
    if doc.get("first_name") or doc.get("last_name"):
        print(f"  name: {store.display_name(doc)}")
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
    # Optional: bind the token to a HUMAN account (acts_as). The AI then also sees
    # that person's PRIVATE space, not just the commons (an unbound token writes the
    # commons but never a private doc). Validated against a real admin/viewer.
    acts_as = args.acts_as
    if acts_as:
        acts_as = _normalize_email(acts_as)
        human = file_store.get_user_by_email(acts_as)
        if human is None or human.get("role") not in ("admin", "viewer"):
            raise CliError(
                f"--acts-as {acts_as}: no human (admin/viewer) account with that email.")
        fields["acts_as"] = acts_as
    try:
        fields["scopes"] = store.normalize_scopes(args.scope) if args.scope else None
    except ValueError as e:
        raise CliError(f"--scope: {e}")
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
    if fields.get("acts_as"):
        print(f"Bound to {fields['acts_as']} — the AI also sees that account's private space.")
    if fields["scopes"]:
        print(f"Limited to: {', '.join(fields['scopes'])}.")
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
        scopes = ",".join(record.get("scopes") or store.API_SCOPES)
        print(f"{label}  {email}  {state}  {scopes}  created on {created}")
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


def cmd_token_revoke_all(args) -> int:
    """Kill switch: revoke EVERY token bound to a human account at once — matched by
    acts_as, so it catches the user's tokens whatever their email scheme."""
    mind = _require_mind(args.dir)
    file_store = _file_store(_load_config(mind))
    owner = _normalize_email(args.acts_as)
    revoked = 0
    for record in file_store.list_users():
        if (record.get("role") == store.API_ROLE
                and record.get("acts_as") == owner
                and record.get("api_token_hash")):
            file_store.upsert_user(record["email"], {
                "api_token_hash": None,
                "api_token_revoked_at": int(time.time()),
            })
            revoked += 1
    print(f"Revoked {revoked} active token(s) bound to {owner}: every call now returns 401.")
    return 0


# ─── inbox ─────────────────────────────────────────────────────────────────────


def cmd_inbox_claim(args) -> int:
    """Pre-own a person's inbox lane (inbox/<user>/), keeping their agents' drops private to
    them. Multi-user: each person has their own inbox. This is optional — the lane is owned
    automatically on the first drop — but lets an admin provision it ahead of time. Idempotent."""
    mind = _require_mind(args.dir)
    file_store = _file_store(_load_config(mind))
    email = _normalize_email(args.email)
    human = file_store.get_user_by_email(email)
    if human is None or human.get("role") not in ("admin", "viewer"):
        raise CliError(
            f"{email}: no human (admin/viewer) account with that email. "
            "Create it first with `atlas user add`.")
    slug = store.slugify_token_label(email)
    file_store.set_owner(f"inbox/{slug}", "user:" + email)
    print(f"inbox/{slug}/ is now owned by {email} (their private inbox). Agents bound to that "
          "account (token --acts-as) drop into it; only they triage it.")
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


# ─── hook ──────────────────────────────────────────────────────────────────────


def cmd_hook(args) -> int:
    installed, message = _install_commit_hook(_require_mind(args.dir))
    if not installed:
        raise CliError(message)
    print(message)
    return 0


# ─── doctor ────────────────────────────────────────────────────────────────────


def cmd_doctor(args) -> int:
    """Audit the per-document ACL + share registry for orphans (and optionally
    repair the safe ones): entries left behind by user/group deletions, document
    deletions, or out-of-band (git/filesystem) moves."""
    cfg = _load_config(_require_mind(args.dir))
    if args.sync:
        return _doctor_sync(cfg)
    file_store = _file_store(cfg)
    report = file_store.audit_registry(cfg.content_root)
    if sum(len(v) for v in report.values()) == 0:
        print("Registry clean: no orphaned ACL entries, grants or share links.")
        return 0

    def _show(key, label):
        items = report.get(key, [])
        if items:
            print(f"\n{label} ({len(items)}):")
            for it in items:
                print(f"  - {it}")

    _show("acl_no_file", "ACL entries whose document no longer exists")
    _show("share_no_file", "Active share links whose document no longer exists")
    _show("bad_grant", "Grants to a deleted user/group")
    _show("bad_owner", "Owner is a deleted account — reassign manually")
    _show("bad_creator", "Creator is a deleted account")

    if not args.fix:
        print("\nRun `atlas doctor --fix` to clean the SAFE issues (orphan ACL "
              "entries, dead shares, dead grants). Stale owners/creators are left "
              "for manual reassignment — auto-clearing would expose a private doc.")
        return 0

    fixed = file_store.repair_registry(report)
    print(f"\nFixed: {fixed['acl_dropped']} orphan ACL entr(ies), "
          f"{fixed['shares_revoked']} dead share(s), {fixed['grants_purged']} dead "
          f"grant(s). {len(report['bad_owner'])} stale owner(s) need manual "
          "reassignment.")
    return 0


def _doctor_sync(cfg) -> int:
    """`atlas doctor --sync`: the mind against its remote, plus a live check that the
    remote answers. A running server's own failures live in its memory: GET /api/sync."""
    from server.services.git_sync import GitSync, classify_git_error, mask_url
    gs = GitSync(config=cfg)
    health = gs.health()
    if not health["remote"]:
        print("No remote: this mind exists only here. Connect a private remote to "
              "keep a copy elsewhere.")
        return 0
    upstream = gs.run("rev-parse", "--abbrev-ref", "@{u}").stdout.strip()
    print(f"Remote branch: {upstream}")
    oldest = health["oldest_unpushed_at"]
    since = f" (oldest from {time.strftime('%Y-%m-%d %H:%M', time.localtime(oldest))})" if oldest else ""
    print(f"Unpushed commits: {health['unpushed']}{since}")
    try:
        probe = gs.run("ls-remote", "-q", upstream.split("/", 1)[0], timeout=30)
        out = probe.stderr if probe.returncode else ""
    except subprocess.TimeoutExpired:
        out = "git ls-remote timed out"
    if not out:
        print("Remote reachable: yes")
        return 0
    first = next((ln.strip() for ln in out.splitlines() if ln.strip()), "")
    print(f"Remote reachable: NO ({classify_git_error(out)}): {mask_url(first)}")
    return 1


# ─── backup / restore ───────────────────────────────────────────────────────────


def cmd_export(args) -> int:
    """The same zip as the viewer's "leave with your notes" (GET /api/export), with the
    whole history: whoever runs this has the mind's folder anyway."""
    from server.pure.export import exportable, write_export
    cfg = _load_config(_require_mind(args.dir))
    out = Path(args.out) if args.out else Path.cwd() / f"{cfg.site_slug}-notes.zip"
    rels = exportable(cfg.content_root, lambda rel: True)
    with open(out, "wb") as f:
        write_export(f, cfg.content_root, rels, cfg.site_slug, cfg.lang,
                     cfg.root if (cfg.root / ".git").exists() else None)
    print(f"Notes exported: {out} ({len(rels)} files)")
    return 0


def cmd_import(args) -> int:
    """Files from this computer into the mind, as a drop in the viewer does: a file, a folder
    (kept as a folder) or a .zip (unpacked into a folder of its name). Never over an existing
    file ("name (2).ext"); a page that would run in the viewer (.html, .svg), another type
    the viewer doesn't take, or a file over 25 MB stays out."""
    import contextlib
    import zipfile
    from server.pure import uploads
    cfg = _load_config(_require_mind(args.dir))
    src = Path(args.source)
    into = (args.into or "").strip().strip("/")
    if into and uploads.clean_path(into) is None:
        print(f"Not a folder name for the mind: {into}", file=sys.stderr)
        return 1
    if not src.exists():
        print(f"Nothing at {src}", file=sys.stderr)
        return 1
    under = (lambda name: f"{into}/{name}" if into else name)
    skipped, plan = [], []  # plan: (rel, open the bytes)
    archive = contextlib.ExitStack()
    if src.is_file() and src.suffix.lower() == ".zip":
        try:
            entries, skipped = uploads.zip_entries(src, under(src.stem))
        except uploads.UploadError as e:
            print(f"Cannot unpack {src}: {e.code}", file=sys.stderr)
            return 1
        zf = archive.enter_context(zipfile.ZipFile(src))
        plan = [(rel, (lambda m=member: zf.open(m))) for member, rel in entries]
    else:
        files = [src] if src.is_file() else sorted(p for p in src.rglob("*") if p.is_file())
        for path in files:
            name = src.name if path == src else f"{src.name}/{path.relative_to(src).as_posix()}"
            rel = uploads.clean_rel(under(name))
            if rel is None or path.stat().st_size > uploads.MAX_FILE:
                skipped.append(name)
            else:
                plan.append((rel, (lambda p=path: open(p, "rb"))))
    written = []
    with archive:
        for rel, read in plan:
            rel = uploads.free_rel(cfg.content_root, rel)
            target = cfg.content_root / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            with read() as data, open(target, "wb") as out:
                shutil.copyfileobj(data, out)
            written.append(target)
    if written and (cfg.root / ".git").exists():
        _copy_git(cfg.root, "add", "--", *(str(p) for p in written))
        _copy_git(cfg.root, *_copy_who(cfg.root), "commit", "-q", "-m",
                  f"created: {src.stem if src.suffix.lower() == '.zip' else src.name} ({len(written)})")
    print(f"{len(written)} file(s) added" + (f", {len(skipped)} left out: " + ", ".join(skipped[:10])
                                             + (" …" if len(skipped) > 10 else "") if skipped else ""))
    return 0


def _copy_git(cwd: Path, *args, text=True) -> subprocess.CompletedProcess:
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
    return subprocess.run(["git", "-c", "core.quotepath=false", *args], cwd=str(cwd),
                          capture_output=True, text=text, env=env)


def _copy_who(dest: Path) -> list:
    """A commit identity for a computer where git has none set."""
    return [] if _copy_git(dest, "config", "user.email").stdout.strip() else [
        "-c", "user.name=Atlas copy", "-c", "user.email=copy@atlas.local"]


def _beside(dest: Path, rel: str) -> str:
    """Where this copy's version of a note goes when both sides changed it, the viewer's
    way: "<note> (my version).md", numbered when taken."""
    try:
        suffix = "ma version" if AtlasConfig.load(root=dest).lang == "fr" else "my version"
    except AtlasConfigError:
        suffix = "my version"
    path = PurePosixPath(rel)
    n = 1
    while True:
        name = f"{path.stem} ({suffix}{f' {n}' if n > 1 else ''}){path.suffix}"
        if not (dest / path.with_name(name)).exists():
            return path.with_name(name).as_posix()
        n += 1


def _keep_both(dest: Path) -> list:
    """Take the instance's changes when the same notes changed here too: the online
    version stays in place, this copy's goes beside it. Never a git screen. Returns the
    copies made."""
    who = _copy_who(dest)
    base = _copy_git(dest, "merge-base", "HEAD", "FETCH_HEAD").stdout.strip()

    def changed(rev):
        return set(_copy_git(dest, "diff", "--name-only", base, rev).stdout.splitlines())

    def blob(path):
        return _copy_git(dest, "rev-parse", "--verify", "--quiet", f"HEAD:{path}").stdout.strip()

    mine = {path: blob(path) for path in changed("HEAD") & changed("FETCH_HEAD")}
    if _copy_git(dest, *who, "merge", "-q", "--no-edit", "-X", "theirs", "FETCH_HEAD").returncode:
        # What -X theirs leaves open: a note deleted on one side, edited on the other.
        for path in _copy_git(dest, "diff", "--name-only", "--diff-filter=U").stdout.splitlines():
            if _copy_git(dest, "cat-file", "-e", f"FETCH_HEAD:{path}").returncode == 0:
                _copy_git(dest, "checkout", "FETCH_HEAD", "--", path)
            else:
                _copy_git(dest, "rm", "-q", "--", path)
        _copy_git(dest, *who, "commit", "-q", "--no-edit")
    copies = []
    for path, before in mine.items():
        if before and blob(path) != before:
            rel = _beside(dest, path)
            (dest / rel).write_bytes(_copy_git(dest, "cat-file", "blob", before, text=False).stdout)
            copies.append(rel)
    if copies:
        _copy_git(dest, "add", "--", *copies)
        _copy_git(dest, *who, "commit", "-q", "-m", "notes: keep both versions")
    return copies


def _copy_refusal(stderr: str) -> str:
    """Why the instance said no, in its own words when it gave some."""
    for line in stderr.splitlines():
        if "Atlas:" in line:
            return line.split("Atlas:", 1)[1].strip()
    if "401" in stderr:
        return "the instance refused this access token"
    if "403" in stderr:
        return ("only the owner of a mind with a single account can copy it: "
                "a copy carries every file and the whole history")
    lines = stderr.strip().splitlines()
    return lines[-1] if lines else "git failed"


def _git_base(url: str) -> str:
    """An Atlas address as its git URL: https://my-atlas.example → …/git."""
    base = url.rstrip("/")
    return base if base.endswith("/git") else base + "/git"


def _same_atlas(a: str, b: str) -> bool:
    """Two git URLs of the same Atlas, whatever credentials or trailing slash they carry."""
    pa, pb = urlsplit(_git_base(a)), urlsplit(_git_base(b))
    return ((pa.scheme, pa.hostname, pa.port, pa.path.rstrip("/"))
            == (pb.scheme, pb.hostname, pb.port, pb.path.rstrip("/")))


def _copy_here(url: str):
    """The copy of `url`'s Atlas this command runs in (this folder or one above), or None."""
    top = _copy_git(Path.cwd(), "rev-parse", "--show-toplevel")
    if top.returncode:
        return None
    root = Path(top.stdout.strip())
    origin = _copy_git(root, "remote", "get-url", "origin").stdout.strip()
    return root if origin and _same_atlas(origin, url) else None


def _sync_clone(url: str, dest) -> int:
    base = _git_base(url)
    host = urlsplit(base).hostname or "atlas"
    # The notes of that Atlas, not a name a developer's own checkout may already hold.
    dest = Path(dest) if dest else Path.cwd() / (host.split(".")[0] + "-notes")
    if dest.exists() and any(dest.iterdir()):
        raise CliError(f"{dest} is not empty: pick another folder")
    token = (os.environ.get("ATLAS_TOKEN")
             or getpass.getpass("Access token (Settings > Copies > On your computer): ")).strip()
    if not token:
        raise CliError("an access token is needed")
    header = "Authorization: Basic " + base64.b64encode(f"atlas:{token}".encode()).decode()
    clone = _copy_git(Path.cwd(), "-c", f"http.extraHeader={header}", "clone", "-q", base, str(dest))
    if clone.returncode:
        raise CliError(_copy_refusal(clone.stderr))
    # The token stays with this copy only (its .git/config), for the next syncs.
    _copy_git(dest, "config", f"http.{base}.extraHeader", header)
    print(f"Your copy: {dest}\nEdit the notes in content/, then run: atlas sync \"{dest}\"")
    return 0


def _sync_once(dest: Path) -> str:
    """Send this copy's note changes, take the instance's: one round."""
    _copy_git(dest, "add", "-A", "--", "content")
    _copy_git(dest, "add", "-A", "--", "AGENTS.md")
    if _copy_git(dest, "diff", "--cached", "--quiet").returncode:
        _copy_git(dest, *_copy_who(dest), "commit", "-q", "-m",
                  f"notes: from {platform.node() or 'a copy'}")
    received, kept = 0, []
    for _ in range(3):  # the instance may record a change of its own while we push
        fetch = _copy_git(dest, "fetch", "-q", "origin", "main")
        if fetch.returncode:
            raise CliError(_copy_refusal(fetch.stderr))
        new = int(_copy_git(dest, "rev-list", "--count", "HEAD..FETCH_HEAD").stdout or 0)
        if new and _copy_git(dest, "rebase", "-q", "--autostash", "FETCH_HEAD").returncode:
            _copy_git(dest, "rebase", "--abort")
            kept += _keep_both(dest)
        received += new
        sent = int(_copy_git(dest, "rev-list", "--count", "FETCH_HEAD..HEAD").stdout or 0)
        push = _copy_git(dest, "push", "-q", "origin", "HEAD:main") if sent else None
        if push is None or push.returncode == 0:
            break
        if "fetch first" not in push.stderr and "non-fast-forward" not in push.stderr:
            raise CliError("the instance refused the changes: " + _copy_refusal(push.stderr))
    else:
        raise CliError("the instance keeps changing: run atlas sync again in a moment")
    if not (sent or received):
        return "Up to date."
    summary = f"{sent} change(s) sent, {received} received."
    if kept:
        summary += ("\nChanged here and online: the online version stays, yours is beside it: "
                    + ", ".join(kept))
    return summary


def cmd_sync(args) -> int:
    """A copy of an online mind on this computer, kept in step through its own git
    (/git): `atlas sync <url> [dir]` makes it, then `atlas sync [dir]` sends the note
    changes made here and takes the others'. Only content/ and AGENTS.md travel."""
    if shutil.which("git") is None:
        raise CliError("git is needed: https://git-scm.com/downloads")
    if re.match(r"https?://", args.target):
        # Run from inside a copy of that same Atlas (one `git clone` made), it syncs that copy
        # rather than nesting a second one in it.
        dest = None if args.dir else _copy_here(args.target)
        if dest is None:
            return _sync_clone(args.target, args.dir)
    else:
        dest = Path(args.target)
    if not (dest / ".git").exists():
        raise CliError(f"{dest} is not a copy: make one with atlas sync <address> [folder]")
    while True:
        try:
            print(_sync_once(dest))
        except CliError as e:
            if not args.every:
                raise
            print(f"Error: {e}", file=sys.stderr)
        if not args.every:
            return 0
        time.sleep(args.every)


def cmd_backup(args) -> int:
    """Snapshot the .atlas registry (accounts, tokens, 2FA, share links, per-document
    ACLs, groups) to a zip. The content lives in git; this registry does NOT — a lost
    volume loses every account and share unless it was backed up."""
    cfg = _load_config(_require_mind(args.dir))
    src = Path(cfg.store_dir)
    if not src.is_dir():
        raise CliError(f"no registry to back up at {src}")
    out = Path(args.out) if args.out else Path.cwd() / "atlas-registry-backup.zip"
    archive = shutil.make_archive(
        str(out.with_suffix("")), "zip", root_dir=str(src))  # make_archive adds .zip
    print(f"Registry backed up: {archive}")
    return 0


def cmd_restore(args) -> int:
    """Restore a .atlas registry from a backup zip. Refuses to overwrite a non-empty
    registry unless --force (the existing accounts/shares would be replaced)."""
    cfg = _load_config(_require_mind(args.dir))
    dst = Path(cfg.store_dir)
    src = Path(args.source)
    if not src.is_file():
        raise CliError(f"backup not found: {src}")
    if dst.is_dir() and any(dst.iterdir()) and not args.force:
        raise CliError(
            f"a registry already exists at {dst} — pass --force to overwrite it")
    dst.mkdir(parents=True, exist_ok=True)
    shutil.unpack_archive(str(src), str(dst), "zip")
    print(f"Registry restored into {dst}")
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
                    "copy of the demo mind. Subcommands seed sample data.")
    p_dev.add_argument("--port", type=int, default=None,
                       help="Listening port (default: 8765).")
    p_dev.add_argument("--fresh", action="store_true",
                       help="Do NOT seed the admin — exercise the first-boot "
                            "/setup token flow instead.")
    p_dev.add_argument("--reset", action="store_true",
                       help="Wipe the dev mind (accounts + edits) and re-seed it.")
    # Bare `atlas dev` (no sub-action) runs the sandbox on the .dev-mind; the
    # subcommands below populate a mind with sample data instead.
    p_dev.set_defaults(func=cmd_dev, dir=None)
    dev_sub = p_dev.add_subparsers(dest="dev_action", metavar="<action>",
                                   required=False)
    p_dev_seed = dev_sub.add_parser(
        "seed", help="DEV-ONLY: fill the mind with sample inbox items + "
                     "attributed Activity commits (so the home card + Inbox render).")
    p_dev_seed.add_argument("dir", nargs="?", default=None,
                            help="Mind to seed (default: the .dev-mind sandbox).")
    p_dev_seed.set_defaults(func=cmd_dev_seed)
    p_dev_inbox = dev_sub.add_parser(
        "inbox", help="DEV-ONLY: drop a single sample inbox item with the given title.")
    p_dev_inbox.add_argument("title", help="Title of the inbox item.")
    p_dev_inbox.add_argument("dir", nargs="?", default=None,
                             help="Mind to seed (default: the .dev-mind sandbox).")
    p_dev_inbox.set_defaults(func=cmd_dev_inbox)

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
    p_user_add.add_argument("--first-name", default=None, help="Account holder's first name.")
    p_user_add.add_argument("--last-name", default=None, help="Account holder's last name.")
    p_user_add.add_argument("--password", default=None,
                            help="Password (otherwise prompted with hidden input); '-' reads "
                                 "it from stdin, keeping it out of the process list.")
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
    p_token_create.add_argument("--acts-as", dest="acts_as", default=None,
                                help="Bind the token to a human account (email): the "
                                     "AI then also sees that person's PRIVATE space, "
                                     "not just the commons.")
    p_token_create.add_argument("--scope", default=None, metavar="SCOPES",
                                help="Limit the token, comma-separated among "
                                     f"{','.join(store.API_SCOPES)} (default: all). E.g. "
                                     "read,inbox for a triage agent that must never edit.")
    p_token_create.set_defaults(func=cmd_token_create)
    p_token_list = token_sub.add_parser("list", help="List the tokens.")
    p_token_list.add_argument("dir", nargs="?", default=".", help="Directory of the mind (default: current directory).")
    p_token_list.set_defaults(func=cmd_token_list)
    p_token_revoke = token_sub.add_parser(
        "revoke", help="Revoke a token (cuts off access immediately).")
    p_token_revoke.add_argument("dir", nargs="?", default=".", help="Directory of the mind (default: current directory).")
    p_token_revoke.add_argument("--label", default=DEFAULT_TOKEN_LABEL)
    p_token_revoke.set_defaults(func=cmd_token_revoke)
    p_token_revoke_all = token_sub.add_parser(
        "revoke-all", help="Revoke EVERY token bound to a user at once (kill switch).")
    p_token_revoke_all.add_argument("dir", nargs="?", default=".", help="Directory of the mind (default: current directory).")
    p_token_revoke_all.add_argument("--acts-as", dest="acts_as", required=True, metavar="EMAIL",
                                    help="Revoke every token bound to this human account.")
    p_token_revoke_all.set_defaults(func=cmd_token_revoke_all)

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

    p_inbox = subparsers.add_parser(
        "inbox", help="The agents' inbox (the on-ramp to the mind).")
    inbox_sub = p_inbox.add_subparsers(dest="action", metavar="<action>", required=True)
    p_inbox_claim = inbox_sub.add_parser(
        "claim", help="Make a human the owner of inbox/ (keeps the queue private).")
    p_inbox_claim.add_argument("dir", nargs="?", default=".", help="Directory of the mind (default: current directory).")
    p_inbox_claim.add_argument("--email", required=True, metavar="EMAIL",
                               help="The person who owns the inbox and triages it.")
    p_inbox_claim.set_defaults(func=cmd_inbox_claim)

    p_hook = subparsers.add_parser(
        "hook", help="Install the git hook that marks commits made from Claude Code "
                     "as Claude's (run once per clone; `init` does it).")
    p_hook.add_argument("dir", nargs="?", default=".", help="Directory of the mind (default: current directory).")
    p_hook.set_defaults(func=cmd_hook)

    p_setup = subparsers.add_parser(
        "setup-code",
        help="Make a code for the first admin of an online instance: its hash for the "
             "server, a /setup link for whoever creates the admin (no shell needed).")
    p_setup.add_argument("--url", default=None,
                         help="The instance's address, to print a ready link "
                              "(e.g. https://my-atlas.fly.dev).")
    p_setup.set_defaults(func=cmd_setup_code)

    p_doctor = subparsers.add_parser(
        "doctor",
        help="Audit the ACL/share registry for orphans (--fix to repair safe ones).")
    p_doctor.add_argument("dir", nargs="?", default=".", help="Directory of the mind (default: current directory).")
    p_doctor.add_argument("--fix", action="store_true",
                          help="Apply the safe repairs (drop orphan ACL/shares/grants).")
    p_doctor.add_argument("--sync", action="store_true",
                          help="Check the mind against its git remote instead: unpushed "
                               "commits and whether the remote answers.")
    p_doctor.set_defaults(func=cmd_doctor)

    p_export = subparsers.add_parser(
        "export", help="Zip the mind's notes and their whole history (git bundle), to "
                       "leave with them: plain files, readable anywhere.")
    p_export.add_argument("dir", nargs="?", default=".", help="Directory of the mind (default: current directory).")
    p_export.add_argument("--out", default=None,
                          help="Output zip path (default: ./<mind>-notes.zip).")
    p_export.set_defaults(func=cmd_export)

    p_import = subparsers.add_parser(
        "import", help="Put files from this computer into the mind: a file, a folder, or a .zip "
                       "(unpacked into a folder of its name). Never over an existing file.")
    p_import.add_argument("source", help="The file, folder or .zip to bring in.")
    p_import.add_argument("--into", default="", help="The mind's folder to put it in (default: the top).")
    p_import.add_argument("--dir", default=".", help="Directory of the mind (default: current directory).")
    p_import.set_defaults(func=cmd_import)

    p_sync = subparsers.add_parser(
        "sync", help="A copy of an online mind on this computer: `atlas sync <address> [folder]` "
                     "makes it (asking for an access token), then `atlas sync [folder]` sends the "
                     "note changes made here and takes the others'.")
    p_sync.add_argument("target", nargs="?", default=".",
                        help="The instance's address (first time), else the copy's folder (default: .).")
    p_sync.add_argument("dir", nargs="?", default=None,
                        help="Folder for a new copy (default: <instance>-notes).")
    p_sync.add_argument("--every", type=int, default=0, metavar="SECONDS",
                        help="Keep syncing, every SECONDS.")
    p_sync.set_defaults(func=cmd_sync)

    p_backup = subparsers.add_parser(
        "backup", help="Snapshot the .atlas registry (accounts/shares/ACLs/groups) to a zip.")
    p_backup.add_argument("dir", nargs="?", default=".", help="Directory of the mind (default: current directory).")
    p_backup.add_argument("--out", default=None,
                          help="Output zip path (default: ./atlas-registry-backup.zip).")
    p_backup.set_defaults(func=cmd_backup)

    p_restore = subparsers.add_parser(
        "restore", help="Restore the .atlas registry from a backup zip.")
    p_restore.add_argument("dir", nargs="?", default=".", help="Directory of the mind (default: current directory).")
    p_restore.add_argument("--from", dest="source", required=True, help="Backup zip to restore.")
    p_restore.add_argument("--force", action="store_true", help="Overwrite an existing registry.")
    p_restore.set_defaults(func=cmd_restore)

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
