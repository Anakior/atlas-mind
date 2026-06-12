#!/usr/bin/env python3
"""Atlas engine CLI: scaffolding, serve, build and administration of a mind's
file registry (accounts, API tokens, share links).

Usage:

    python3 src/cli.py init <dir> [--force]
    python3 src/cli.py serve <dir> [--port N]
    python3 src/cli.py build <dir> [--offline]
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
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path

ENGINE_SRC = Path(__file__).resolve().parent
if str(ENGINE_SRC) not in sys.path:
    sys.path.insert(0, str(ENGINE_SRC))

import store  # noqa: E402
from config import AtlasConfig, AtlasConfigError  # noqa: E402

MIN_PASSWORD_LENGTH = 8
DEFAULT_TOKEN_LABEL = "claude"
# Unusable-password sentinel for 'api' accounts: source of truth in store.py
# (shared with the server's admin endpoints).
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


def _build_script_for(mind: Path) -> Path:
    """build.py to run: the mind's own if it ships one (legacy repo with
    src/), otherwise the engine's — same preference as server.py."""
    mind_build = mind / "src" / "build.py"
    if mind_build.is_file():
        return mind_build
    return ENGINE_SRC / "build.py"


def _run_build(mind: Path, *, offline: bool = False) -> int:
    """Run build.py on the mind (inherited output, visible to the user)."""
    env = os.environ.copy()
    env["ATLAS_MIND"] = str(mind)
    command = [sys.executable, str(_build_script_for(mind))]
    if offline:
        command.append("--offline")
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

ATLAS_TOML_TEMPLATE = """\
# Configuration du mind Atlas — toutes les clés sont optionnelles.
# Priorité : variables d'environnement > ce fichier > défauts du moteur.

# Identité de l'instance : la marque "Atlas" est FIXE (wordmark stylisé du
# viewer et de la page de login) ; `prefix` est un préfixe optionnel affiché
# devant ("Acme" → "Acme Atlas"). Vide ou absent → "Atlas" seul.
# Le nom complet dérivé alimente <title>, manifest PWA, OpenAPI et serveur MCP.
# prefix = "Acme"
# Baseline affichée sous le titre de la page d'accueil du viewer.
tagline = "Base de connaissances personnelle."
# Langue de l'interface : "fr" ou "en" (aussi posée sur <html lang>).
lang = "fr"

[server]
# port = 8765
# auth_enabled = false   # true = mode cloud (login requis) ; exige session_secret
# session_secret = ""    # secret long et aléatoire, OBLIGATOIRE si auth_enabled
# session_max_age = 2592000  # durée de vie du cookie de session en secondes
#                            # (défaut 30 j). La révocation côté serveur
#                            # (logout-all / reset mdp / 2FA) prime sur ce délai.
# Derrière un reverse proxy, header qui porte l'IP cliente réelle (utilisé par
# le rate limit du login) : "CF-Connecting-IP" derrière Cloudflare,
# "X-Real-IP" ou "X-Forwarded-For" derrière Caddy/nginx. Si le header porte
# une liste (X-Forwarded-For empilé par le proxy), Atlas prend le DERNIER
# élément — le seul ajouté par le proxy de confiance ; les éléments de gauche
# viennent du client et sont falsifiables. Ne convient qu'avec UN SEUL proxy
# de confiance devant Atlas (plusieurs étages : faire écraser le header par le
# premier proxy, cf. deploy/Caddyfile.example). Absent = chaîne historique
# Fly-Client-IP, puis X-Forwarded-For, puis l'adresse de socket.
# trusted_ip_header = "X-Forwarded-For"

[store]
# Registre des comptes, tokens API et liens de partage.
# "file" = JSON locaux sous .atlas/ — administrés par `atlas user|token|share`.
kind = "file"
# dir = ".atlas"

[git]
# Identité des commits automatiques du serveur (mode cloud uniquement).
# author_name = "Atlas Bot"
# author_email = "kb-bot@fly.dev"

[todo]
# Fichier de la to-do du widget, relatif à content/ (exclu du viewer ci-dessous).
# file = "notes/quick.md"
# categories = ["travail", "personnel"]   # la première est la catégorie par défaut

[build]
# Noms exclus du viewer (dossiers ou fichiers, où qu'ils soient sous content/).
# excluded_names = ["skill", "quick.md"]

# Extensions — dossier .atlas/extensions/ du mind (pas de clé à configurer,
# l'emplacement est fixe ; dossier vide ou absent = aucune extension) :
# - *.css / *.js : inlinés dans le viewer au build (ordre alphabétique,
#   modes online et offline).
# - *.py : chargés au boot du serveur ; chaque module expose
#   register(context) et enregistre ses routes via
#   context.add_route(method, pattern, handler, role=...) — method "GET" ou
#   "POST", pattern regex sur le path, handler(http_handler, match), role
#   "public" / "auth" / "admin" (défaut : "auth" en GET, "admin" en POST).
#   context.config expose l'AtlasConfig. Une extension cassée est ignorée
#   avec un warning au boot — jamais de crash.
"""

GITIGNORE_TEMPLATE = """\
dist/
.atlas/
"""

BIENVENUE_MD = """\
---
tags: [aide]
---

# Bienvenue

Ce mind est servi par Atlas. Tout document Markdown déposé sous `content/`
apparaît dans le viewer, organisé selon l'arborescence des dossiers.

## Syntaxe supportée

- Markdown classique : titres, listes, tableaux, blocs de code, images.
- Wikilinks : [[notes/exemple]] cible un document par son chemin,
  [[exemple|un alias]] change le texte affiché (le graphe de liens et les
  rétroliens sont construits automatiquement).
- Frontmatter YAML en tête de fichier : `tags: [aide]` ajoute des tags ;
  les dossiers parents deviennent aussi des tags automatiquement.

## Organisation

- `notes/` : un exemple de sous-dossier — voir [[notes/exemple]].
- `inbox/` : dépôt rapide pour les documents à trier plus tard.
- `save-ia/` : sauvegardes de session de ton assistant IA (voir le modèle).
- `agents/` : définitions d'agents IA réutilisables.

## Avec ton IA

Atlas est pensé comme la mémoire externe partagée avec un assistant IA : le
fichier `AGENTS.md` (racine) explique comment la brancher (MCP) pour qu'elle
lise et enrichisse ton palais mental.
"""

EXEMPLE_MD = """\
# Exemple de note

Une note ordinaire, rangée dans `notes/`. Le lien [[bienvenue]] ramène à la
page d'accueil : un wikilink se résout par chemin (`notes/exemple`) ou par
nom de fichier (`exemple`), avec un alias optionnel après `|`.
"""

# Example instructions file for the AI assistant, at the mind's root
# (read automatically by Claude Code and AGENTS.md-compatible tools).
# This is the heart of Atlas's "AI-native" usage: the Atlas is the external
# memory shared between the user and their AI.
AGENTS_MD = """\
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
- `save-ia/` — sauvegardes de session de travail (voir `save-ia/MODELE.md`).
- `agents/` — définitions d'agents IA réutilisables (voir `agents/README.md`).
- (ajoute tes dossiers : projets/, reunions/, cours/…)

## Règles

- **Pas de date dans les noms de fichiers** (le filesystem et git la portent
  déjà) ; le nom décrit le **sujet**. kebab-case.
- Demander avant d'écrire si le dossier cible est ambigu.
"""

AGENTS_README_MD = """\
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

SAVE_IA_MODELE_MD = """\
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


def cmd_init(args) -> int:
    mind = Path(args.dir).expanduser().resolve()
    if mind.exists() and not mind.is_dir():
        raise CliError(f"{mind} already exists and is not a directory.")
    if mind.is_dir() and any(mind.iterdir()) and not args.force:
        raise CliError(
            f"{mind} is not empty — rerun with --force to scaffold "
            "anyway (existing files are kept).")
    mind.mkdir(parents=True, exist_ok=True)

    created: list = []
    kept: list = []
    _scaffold_file(mind / "atlas.toml", ATLAS_TOML_TEMPLATE, created, kept)
    _scaffold_file(mind / ".gitignore", GITIGNORE_TEMPLATE, created, kept)
    _scaffold_file(mind / "content" / "bienvenue.md", BIENVENUE_MD, created, kept)
    _scaffold_file(mind / "content" / "notes" / "exemple.md", EXEMPLE_MD,
                   created, kept)
    # .gitkeep: an empty inbox/ must survive the git clone; the "." prefix
    # keeps it out of the viewer (EXCLUDED_PREFIXES).
    _scaffold_file(mind / "content" / "inbox" / ".gitkeep", "", created, kept)
    # Extensions hook (CSS/JS inlined at build, *.py loaded at server boot):
    # empty, ready-to-use folder — mechanism documented in a comment in
    # atlas.toml.
    _scaffold_file(mind / ".atlas" / "extensions" / ".gitkeep", "",
                   created, kept)
    # "AI-native" scaffolding: Atlas is designed as the external memory shared
    # with an AI assistant. We ship enough to bootstrap that workflow.
    _scaffold_file(mind / "AGENTS.md", AGENTS_MD, created, kept)
    _scaffold_file(mind / "content" / "agents" / "README.md", AGENTS_README_MD,
                   created, kept)
    _scaffold_file(mind / "content" / "save-ia" / "MODELE.md", SAVE_IA_MODELE_MD,
                   created, kept)

    git_message = _git_init_main(mind)

    print(f"Mind initialized: {mind}")
    for path in created:
        print(f"  created : {path.relative_to(mind)}")
    for path in kept:
        print(f"  kept    : {path.relative_to(mind)} (existing, untouched)")
    print(f"  git     : {git_message}")
    print()
    print("Next steps:")
    print(f"  python3 {sys.argv[0]} serve {args.dir}")
    print(f"  python3 {sys.argv[0]} user add {args.dir} --email you@example.com")
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
    if args.port is not None:
        env["PORT"] = str(args.port)
    # exec: the process BECOMES the server (direct Ctrl+C and signals).
    os.execve(sys.executable,
              [sys.executable, str(ENGINE_SRC / "server.py")], env)
    return 0  # never reached


def cmd_build(args) -> int:
    mind = _require_mind(args.dir)
    if not (mind / "content").is_dir():
        raise CliError(f"{mind} has no content/ directory — nothing to build.")
    _load_config(mind)  # human error if atlas.toml is broken
    return _run_build(mind, offline=args.offline)


# ─── user ──────────────────────────────────────────────────────────────────────


def _normalize_email(raw: str) -> str:
    email = (raw or "").strip().lower()
    # \s covers space, tab and newline (a stored control character would be
    # re-printed raw by `atlas user list`); both sides of the @ are
    # mandatory ("@" alone used to pass before).
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

    # Token format (256 bits, SHA256 stored, role 'api') factored into
    # store.new_api_token_fields — shared with the server's admin endpoints.
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
    p_init.add_argument("dir", help="Directory of the mind to create.")
    p_init.add_argument("--force", action="store_true",
                        help="Scaffold even if the directory is not empty "
                             "(existing files are kept).")
    p_init.set_defaults(func=cmd_init)

    p_serve = subparsers.add_parser(
        "serve", help="Start the server on this mind (local mode by default).")
    p_serve.add_argument("dir", help="Directory of the mind.")
    p_serve.add_argument("--port", type=int, default=None,
                         help="Listening port (default: atlas.toml or 8765).")
    p_serve.set_defaults(func=cmd_serve)

    p_build = subparsers.add_parser(
        "build", help="Generate this mind's viewer (dist/).")
    p_build.add_argument("dir", help="Directory of the mind.")
    p_build.add_argument("--offline", action="store_true",
                         help="Self-contained monolith index-offline.html (file://).")
    p_build.set_defaults(func=cmd_build)

    p_user = subparsers.add_parser(
        "user", help="Accounts in the mind's file registry (.atlas/users.json).")
    user_sub = p_user.add_subparsers(dest="action", metavar="<action>",
                                     required=True)
    p_user_add = user_sub.add_parser("add", help="Create an account.")
    p_user_add.add_argument("dir", help="Directory of the mind.")
    p_user_add.add_argument("--email", required=True)
    p_user_add.add_argument("--role", choices=("admin", "viewer"),
                            default="admin")
    p_user_add.add_argument("--password", default=None,
                            help="Password (otherwise prompted with hidden input).")
    p_user_add.set_defaults(func=cmd_user_add)
    p_user_list = user_sub.add_parser("list", help="List the accounts.")
    p_user_list.add_argument("dir", help="Directory of the mind.")
    p_user_list.set_defaults(func=cmd_user_list)
    p_user_remove = user_sub.add_parser("remove", help="Remove an account.")
    p_user_remove.add_argument("dir", help="Directory of the mind.")
    p_user_remove.add_argument("--email", required=True)
    p_user_remove.set_defaults(func=cmd_user_remove)

    p_token = subparsers.add_parser(
        "token", help="Bearer API tokens (role 'api', /api/v1 and /mcp).")
    token_sub = p_token.add_subparsers(dest="action", metavar="<action>",
                                       required=True)
    p_token_create = token_sub.add_parser(
        "create", help="Issue a 256-bit token (shown ONLY once).")
    p_token_create.add_argument("dir", help="Directory of the mind.")
    p_token_create.add_argument("--label", default=DEFAULT_TOKEN_LABEL,
                                help=f"Identifies the token (default: {DEFAULT_TOKEN_LABEL}).")
    p_token_create.set_defaults(func=cmd_token_create)
    p_token_list = token_sub.add_parser("list", help="List the tokens.")
    p_token_list.add_argument("dir", help="Directory of the mind.")
    p_token_list.set_defaults(func=cmd_token_list)
    p_token_revoke = token_sub.add_parser(
        "revoke", help="Revoke a token (cuts off access immediately).")
    p_token_revoke.add_argument("dir", help="Directory of the mind.")
    p_token_revoke.add_argument("--label", default=DEFAULT_TOKEN_LABEL)
    p_token_revoke.set_defaults(func=cmd_token_revoke)

    p_share = subparsers.add_parser(
        "share", help="Share links of the file registry.")
    share_sub = p_share.add_subparsers(dest="action", metavar="<action>",
                                       required=True)
    p_share_list = share_sub.add_parser("list", help="List the links (including revoked ones).")
    p_share_list.add_argument("dir", help="Directory of the mind.")
    p_share_list.set_defaults(func=cmd_share_list)
    p_share_revoke = share_sub.add_parser("revoke", help="Revoke a link by id.")
    p_share_revoke.add_argument("dir", help="Directory of the mind.")
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
        # Environment errors (PermissionError on init/mkstemp, full disk…) and
        # corrupted registry (ValueError "users.json illisible ou corrompu"
        # from store._load, deliberately raised for the server's fail-closed):
        # human message, never a traceback for these cases.
        print(f"Error: {e}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
