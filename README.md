# Atlas Mind

**Atlas Mind** is a self-hostable wiki / knowledge base engine — and an external
brain you share with your AI. It serves a single-page viewer from a folder of
documents (a *mind*), and keeps the **engine** (the code) cleanly decoupled from
your **content** (your notes, in their own git repository).

It is built on three ideas:

- **Multi-format, not just Markdown.** Markdown is first-class (rendered, linked,
  searched), but Atlas Mind also previews **standalone HTML** documents (decks,
  dashboards), **PDFs**, and **Word `.docx`** files inline — converted to readable
  HTML in your browser, nothing uploaded anywhere. Your knowledge lives in one
  place whatever its shape.
- **AI-native.** Atlas Mind is meant to be the memory your AI assistant reads and
  enriches: it exposes an **MCP** endpoint (six tools) and `atlas init` scaffolds
  the conventions (`AGENTS.md`, `agents/`, `save-ia/`) so an assistant knows how
  to use your mind. See [Use it with your AI](#use-it-with-your-ai-mcp).
- **Lightweight & self-contained.** A single Python HTTP server plus a build step,
  written entirely on the standard library — **no database required**, accounts
  and share links live in plain JSON files on disk. Frontend libraries and fonts
  are vendored, so a running instance makes no third-party network calls.

## Who it is for

- Anyone who wants a personal or small-team knowledge base they fully own.
- People who already keep notes as Markdown in git and want a viewer, search,
  linking and an AI integration on top — without a database or a hosted service.
- Self-hosters who want one process behind a reverse proxy, or a small container
  on a PaaS such as Fly.io.

It is not a multi-tenant SaaS, a real-time collaborative editor, or a plugin
marketplace. It is a focused engine for one mind per instance.

## How it works

Atlas Mind is two things kept deliberately apart:

- The **engine** — this repository: the Python server, the build step, and the
  single-page viewer.
- A **mind** — your content, in its own git repository: a `content/` folder of
  documents plus a small `atlas.toml`. Accounts, tokens and share links live in a
  local `.atlas/` directory (plain JSON, gitignored), so a mind carries its own
  state and **no database is involved**.

You point the engine at a mind and it serves a fast single-page app: a build step
turns `content/` into a search/backlink index and a viewer shell, the server
serves it, and edits made in the viewer are written back to the files (and, in
cloud mode, committed and pushed). Upgrading the engine never touches your
content; syncing content never touches the engine.

## Features

Everything below ships in the box.

### Reading & multi-format viewer

- **Markdown** is first-class: rendered with GitHub-flavoured Markdown, syntax
  highlighting, a table of contents, reading time, and a per-document tag bar.
- **Standalone HTML** documents (slide decks, dashboards) are previewed inline in
  a sandboxed iframe — their own CSS/JS runs, isolated from the viewer.
- **PDF** is previewed inline in the browser's native viewer.
- **Word `.docx`** is converted to readable HTML **in the browser** (via a
  lazily-loaded library) and shown with the same prose styling as Markdown —
  read-only, and nothing ever leaves your machine. (`.pptx` and other binaries
  are offered as a direct download.)
- Every file type can be **downloaded** as its original from the toolbar.

### Navigation & discovery

- **Tree sidebar** over `content/`, collapsible, with rename / share-as-node
  actions on hover.
- **Full-text search** — server-side when online (transfers only the results),
  or MiniSearch (fuzzy, prefix) over embedded content when offline.
- **Wikilinks `[[...]]`, backlinks, and "same subject"** suggestions from shared
  tags, surfaced in a side panel; a wikilink/backlink index is built at build time.
- **Tags** derived from parent folders and YAML frontmatter, each with its own
  per-tag view.
- **The Mind** — a force-directed "mind palace": every document and tag is a node
  on a navigable map (drag, pan, zoom), colour-grouped into regions by folder,
  with recently-edited nodes glowing and orphans dimmed. Subscribed remote nodes
  appear as their own distinct, teal regions (see
  [Atlas nodes](#atlas-nodes-federation)).
- **Command palette** (Ctrl-K), **pinned** and **recently-modified** documents,
  and a quick-capture button.

### Editing

- Create, edit, **rename**, move and **delete** documents straight from the
  viewer; moving a document **rewrites the wikilinks** that point at it.
- **Interactive task checkboxes** — tick a `- [ ]` item in a rendered document and
  the change is written back to the file, with no full re-render flicker.
- **Todos** — a small categorised CRUD widget backed by a Markdown file, with a
  count badge on the favicon.
- All edits in cloud mode are committed and pushed by the instance itself.

### Notes (annotations)

- Attach a **note to a text selection** in any Markdown document; the highlight
  persists and re-anchors on later visits (orphaned notes are flagged if the text
  changed). A tree badge shows each document's note count, live.
- **Copy all notes** of a document as Markdown (quote + note) in one click — handy
  for sharing your annotations, including on a read-only remote node.

### Sharing

- **Public share links** — an HMAC-signed token that serves a single document
  with no login, with optional expiry and one-click revocation. Useful to hand a
  page to someone outside your instance.

### Atlas nodes (federation)

Share a folder or document with **another Atlas Mind instance**, read-only, kept
in sync. See the dedicated section: [Atlas nodes](#atlas-nodes-federation).

### Multi-user & permissions (cloud mode)

- **Cloud mode** turns on accounts and login. Two roles: **admin** (full access +
  the Settings panel: users, tokens, shares, nodes) and **viewer** (read-only).
- **Per-viewer document permissions** — an admin can hide chosen folders from a
  given viewer; hidden paths are filtered server-side everywhere (tree, search,
  direct URL, backlinks), never just visually masked.

### Security & authentication

Cloud mode brings cookie sessions, optional **TOTP 2FA** with single-use recovery
codes, per-account lockout with backoff and per-IP login rate limiting, and full
CSRF defence. See the [Security model](#security-model) for the honest details.

### AI integration

- An **MCP endpoint** exposing six tools (`search_docs`, `read_doc`, `list_tree`,
  `recent_docs`, `create_doc`, `edit_doc`) so an assistant reads and writes your
  mind directly.
- A **REST API v1** (Bearer tokens, create-only writes) with a published
  **OpenAPI 3.1** spec.
- `atlas init` scaffolds the conventions (`AGENTS.md`, `agents/`, `save-ia/`). See
  [Use it with your AI](#use-it-with-your-ai-mcp).

### Offline, PWA & sync

- **Offline build** — a single self-contained `index-offline.html` that works from
  `file://`, plus a **service worker** for an installable, offline-capable PWA.
- **Live reload** over server-sent events; in cloud mode, content syncs via a
  periodic `git pull` and an optional GitHub webhook (see [Updating](#updating)).

### Look & feel

- **i18n**: French and English. A single, carefully-built dark theme, re-skinnable
  via a CSS [extension](#extensions).

## Requirements

- **Python 3** (standard library only; developed on 3.12+).
- **A git repository for your content** (the mind). For cloud mode with content
  sync, a GitHub repository.
- **Somewhere to run it** — your machine for local use, or any host that can run
  a Python process or a container for self-hosting.
- No database. Accounts, tokens and share links are stored as plain JSON under
  `.atlas/`. (`bcrypt` is an optional dependency, used only to verify legacy
  `$2…` password hashes; the native scheme is scrypt, from the standard library.)

## Install

`pip install` puts a self-contained `atlas` command on your PATH (the viewer
assets ship inside the package — no separate download). A virtualenv is
recommended.

```bash
pip install atlas-mind                                   # once published to PyPI
# or, straight from the repository:
pip install "git+https://github.com/Anakior/atlas-mind.git"
# or, for development (editable, from a clone):
git clone https://github.com/Anakior/atlas-mind.git && cd atlas-mind && pip install -e .
```

Without installing, the engine also runs straight from the source tree as
`python3 src/cli.py <command>` (the form used by the systemd unit:
`python3 -m src.cli serve <mind>`). All examples below use the `atlas` command;
substitute `python3 src/cli.py` if you did not install.

## Quick start

Scaffold a new mind and serve it locally:

```bash
atlas init ~/my-mind
atlas serve ~/my-mind
```

`init` creates `atlas.toml`, a `.gitignore`, example documents under `content/`,
the AI-native scaffolding (`AGENTS.md`, `content/agents/`, `content/save-ia/`),
an empty `.atlas/extensions/` hook directory, and runs `git init -b main`. It
never overwrites existing files: it refuses a non-empty directory unless you pass
`--force`, and keeps any file already present.

`serve` builds the viewer once if it is missing, then becomes the HTTP server.
By default it listens on `127.0.0.1:8765` with authentication disabled — open
<http://127.0.0.1:8765> and your notes are there. Stop it with Ctrl+C.

To produce the static viewer without serving:

```bash
atlas build ~/my-mind            # dist/index.html (online shell)
atlas build ~/my-mind --offline  # dist/index-offline.html (monolith)
```

### CLI commands

All commands take the mind directory as a positional argument.

| Command | Purpose |
|---|---|
| `init <dir> [--force]` | Scaffold a new mind (never destructive). |
| `serve <dir> [--port N]` | Build if needed, then run the HTTP server. |
| `build <dir> [--offline]` | Build the static viewer (`--offline` for the monolith). |
| `user add <dir> --email <e> [--role admin\|viewer] [--password ...]` | Create an account in the file store. |
| `user list <dir>` | List accounts (and token state for API accounts). |
| `user remove <dir> --email <e>` | Remove an account. |
| `token create <dir> [--label claude]` | Mint a 256-bit API/MCP token (shown once). |
| `token list <dir>` | List API tokens (label, email, active/revoked, date). |
| `token revoke <dir> [--label claude]` | Revoke a token (idempotent). |
| `share list <dir>` | List all share links (active / expired / revoked). |
| `share revoke <dir> --id <id>` | Revoke a share link. |

The `user`, `token` and `share` commands operate on the local file store
(`.atlas/` by default). `token create` derives the account email from the label
(`claude` → `claude@api.local`) and prints the token once, with both the REST
(`Authorization: Bearer`) and MCP (`/mcp/<token>`) usage.

## Use it with your AI (MCP)

Atlas Mind is designed to be the external memory your AI assistant reads and
writes. `atlas init` scaffolds an **`AGENTS.md`** at the mind root (read by Claude
Code and AGENTS.md-aware tools) that tells the assistant how to use your mind —
adapt it to your conventions. Two folders come scaffolded: `content/agents/`
(reusable AI agent definitions) and `content/save-ia/` (session saves, with a
`MODELE.md` template).

The engine exposes an **MCP endpoint** with six tools — `search_docs`,
`read_doc`, `list_tree`, `recent_docs`, `create_doc`, `edit_doc`. Mint a token
and point your assistant at it:

```bash
atlas token create ~/my-mind --label claude
# → prints the MCP URL: https://<your-atlas>/mcp/<token>
```

Your AI can then search, read and create documents directly in your mind — the
**Mind** view is, quite literally, the map it walks.

## Atlas nodes (federation)

Two Atlas Mind instances can share a slice of their content. The model is a
**personal memory with sharing**, not a real-time collaborative editor: a node is
published by one side and **mirrored read-only** by the other, kept in sync.

It is **pull-asymmetric** — only the *publisher* needs to be reachable over the
network; the subscriber just pulls. From the admin Settings → **Nodes** panel (or
the share-as-node button on any folder/file in the tree):

- **Publish a node.** Pick a folder or a single document and publish it. You get a
  one-time, copyable link (`atlas-node:…`) that carries the origin URL and a
  read-only token (stored hashed; the link is shown only once, re-issue to rotate).
- **Subscribe.** On the other instance, paste the link. Atlas Mind fetches a
  manifest, downloads the documents, and keeps a **read-only mirror** under
  `remotes/<node>/`. It re-syncs automatically (manifest diff by SHA-256) on the
  regular pull cadence, plus an on-demand **Sync** button. The publisher being
  offline just leaves the last copy in place.
- **Browse it like your own.** Mirrored documents appear in the tree under a
  distinct **“Mental nodes”** umbrella (with the source instance shown), and as
  their own teal, dashed regions in **The Mind**. They are read-only: editing,
  renaming, moving or deleting them is refused (it would be overwritten on the next
  sync anyway).
- **Make it yours.** “Appropriate” copies a node (or, from a multi-file node, just
  the current document) into your own documents at a destination you choose — a
  detached, fully editable copy.
- **Your AI sees everything.** Mirrored content lives under your `content/`, so the
  MCP/REST tools read it like any other document.

Nodes are managed by admins; tokens are scoped to the published path and can be
revoked at any time (which removes the subscriber's access at the next sync).

## Configuration

Configuration lives in `atlas.toml` at the root of the mind; every key is
optional. Precedence is **environment variable > `atlas.toml` > built-in
default**. Configuration is read once at startup. Unknown keys produce a
non-fatal warning on stderr (with a `difflib` suggestion); a wrong-typed value is
a fatal, readable error.

A minimal `atlas.toml` (roughly what `init` scaffolds):

```toml
# prefix = "Acme"          # "Acme" -> "Acme Atlas Mind"; empty/absent -> "Atlas Mind"
tagline = "Personal knowledge base."
lang = "fr"                # "fr" or "en"

[server]
# port = 8765
# auth_enabled = false     # true = cloud mode (login required); needs session_secret
# session_secret = ""      # long random secret, REQUIRED if auth_enabled
# trusted_ip_header = "X-Forwarded-For"

[store]
kind = "file"              # local JSON under .atlas/ (no database)
# dir = ".atlas"

[todo]
# file = "notes/quick.md"
# categories = ["work", "personal"]

[build]
# excluded_names = ["skill", "quick.md"]
```

### Key reference

The `prefix` key only changes the displayed name; the **Atlas Mind** wordmark
itself is fixed (see [Licence](#licence)). Env semantics: keys marked *presence*
take effect when the variable is set (even empty); keys marked *or* fall back to
`atlas.toml` when the variable is empty.

| `atlas.toml` key | Env var | Env semantics | Default | Notes |
|---|---|---|---|---|
| `prefix` (root) | — | — | `""` | Prefix before the fixed `Atlas Mind` wordmark. |
| `tagline` (root) | — | — | `Base de connaissances personnelle.` | Home page tagline. |
| `lang` (root) | — | — | `fr` | `fr` or `en` only. |
| `[server] port` | `PORT` | presence | `8765` | Validated 0–65535. |
| `[server] auth_enabled` | `KB_AUTH_ENABLED` | presence | `false` | Any non-empty value enables; empty disables. |
| `[server] session_secret` | `SESSION_SECRET` | presence | `dev-secret-change-me` | Cloud mode refuses to boot on the default. |
| `[server] session_max_age` | `SESSION_MAX_AGE` | presence | `2592000` (30 d) | Must be > 0. |
| `[server] git_pull_interval` | `GIT_PULL_INTERVAL` | presence | `300` | Seconds between content pulls; must be ≥ 0. |
| `[server] github_webhook_secret` | `GITHUB_WEBHOOK_SECRET` | presence | `""` | HMAC secret for the GitHub webhook. |
| `[server] trusted_ip_header` | `ATLAS_TRUSTED_IP_HEADER` | or | `""` (→ none) | Client-IP header behind a proxy. |
| `[store] kind` | `ATLAS_STORE` | or | `file` | Storage backend (local JSON). |
| `[store] dir` | `ATLAS_STORE_DIR` | or | `<mind>/.atlas` | Cannot be the mind root or under `content/`. |
| `[git] author_name` | — | — | `Atlas Bot` | Commit author for the bot. |
| `[git] author_email` | — | — | `kb-bot@fly.dev` | Commit author email for the bot. |
| `[git] repo_url` | `GITHUB_REPO_URL` | or | none | Content repo URL (initial clone reads the env var only). |
| `[todo] file` | — | — | `notes/quick.md` | Todo file, relative to `content/`. |
| `[todo] categories` | — | — | `["travail", "personnel"]` | First is the default category. |
| `[build] excluded_names` | — | — | `{"skill", "quick.md"}` | Names hidden from the viewer (dotfiles always excluded). |

`ATLAS_MIND` (and, in cloud mode only, `KB_REPO_PATH`, default `/app/repo`) select
the mind root. Resolution order: explicit `--dir`, then `ATLAS_MIND`, then
`KB_REPO_PATH` if `KB_AUTH_ENABLED` is set, otherwise the parent of `src/`.

## Updating

Engine and content are decoupled, so there are two independent update channels.

### Updating content (everyday)

Edit your documents and push to your mind's git repository. In cloud mode the
running instance picks the change up by **two means**: a periodic `git pull`
every `GIT_PULL_INTERVAL` seconds (default **300 s = 5 min**), and an instant
**GitHub webhook** (`POST /api/webhook`, HMAC-verified with
`GITHUB_WEBHOOK_SECRET`) for push-to-update. On each sync the instance rebuilds
the viewer and the open page **live-reloads** over SSE.

So a freshly-pushed note appears within five minutes by default, or immediately
if the webhook is configured. Lower `GIT_PULL_INTERVAL` for snappier polling, or
rely on the webhook and raise it. (Edits made *through* the viewer are committed
and pushed by the instance itself, so they need no manual sync.)

### Updating the engine

When a new engine version ships, redeploy the image — **content and the `.atlas`
store/volume are preserved**, only the code changes. On Fly.io it is one command:

```bash
deploy/update.sh <your-fly-app>     # e.g. deploy/update.sh my-atlas
```

That script pulls the latest engine, then rebuilds and redeploys the image
(config lives in `deploy/fly.toml`). For other hosts, rebuild and restart the
container / service the same way you first deployed it.

## Deployment

The `deploy/` directory covers four modes. The local/cloud split is driven by
`KB_AUTH_ENABLED`: any non-empty value enables authentication, empty disables it.
The Docker image enables auth by default (`KB_AUTH_ENABLED=1`); the local CLI
leaves it off. When auth is on, a real `SESSION_SECRET` is mandatory — the server
refuses to boot on the default secret.

- **Local (CLI)** — `atlas serve <mind>` (or `python3 src/cli.py serve <mind>`
  without installing): binds `127.0.0.1`, auth off, no secret required. The
  everyday local mode.
- **Docker Compose** — `deploy/docker-compose.yml` builds the image and serves a
  mounted mind (`ATLAS_STORE: file`, accounts under `<mind>/.atlas`):
  `docker compose -f deploy/docker-compose.yml up -d`.
- **Fly.io** — `deploy/fly.toml` (cloud + file store on a persistent volume).
  Create the volume once (`fly volumes create atlas_store --region <r> --size 1`),
  set `GITHUB_REPO_URL` and `SESSION_SECRET` as secrets, then deploy /
  update with `deploy/update.sh <app>`.
- **systemd (no Docker)** — `deploy/atlas.service` runs `python3 -m src.cli serve
  <mind>` as a dedicated non-root user. Configure port/auth in `atlas.toml`, pass
  secrets via `Environment=` / `EnvironmentFile=`.

Behind a reverse proxy, `deploy/Caddyfile.example` terminates HTTPS and forwards
to `127.0.0.1:8765`, setting `X-Forwarded-For` to the real client IP; set
`trusted_ip_header = "X-Forwarded-For"` so the login rate limiter sees it.

## Extensions

Atlas Mind has two minimal hooks rather than a plugin system, both anchored on a
fixed per-mind directory: `<mind>/.atlas/extensions/`. A missing or empty
directory means no extensions, and the viewer and server are byte-for-byte
unchanged.

- **Viewer assets** — at build time, `*.css` and `*.js` there are concatenated
  (alphabetical) and inlined into the viewer, in both online and offline builds,
  and re-injected into public share pages. Closing tags are neutralised so an
  extension cannot escape its container.
- **Server routes** — at boot, `*.py` modules are imported; each exposes
  `register(context)` and registers routes via `context.add_route(method,
  pattern, handler, role=...)` (`role` ∈ `public` / `auth` / `admin`).

A broken extension is logged and skipped — it never crashes the boot or fails a
build. The viewer exposes a small `window.Atlas` API and emits
`atlas:doc-rendered` / `atlas:edit-enter` DOM events. Two worked examples live in
`examples/extensions/`: **`custom-theme`** (re-skin the design via CSS) and
**`pob`** (a server route + viewer template + styles). Installing an extension
means copying the files in, rebuilding, and restarting the server.

## Security model

Authentication is implemented from scratch on the standard library. A brief,
honest summary:

- **Passwords**: native scrypt (N=2¹⁴, r=8, p=1, 16-byte salt, 64-byte output).
  bcrypt is an optional fallback only for legacy `$2…` hashes.
- **Sessions**: HMAC-SHA256–signed (not encrypted) cookies (email/role/epoch/ts),
  revocable server-side via a `session_epoch` bumped on logout-all, password
  reset and TOTP changes. `HttpOnly`, `SameSite=Lax`, `Secure` when auth is on.
- **CSRF** defence in depth: JSON content type required when there is a body,
  same-origin `Origin`/`Referer` check when present, and a synchronizer token
  (`HMAC(secret, "email|epoch")`) in an `X-CSRF-Token` header.
- **2FA**: TOTP (RFC 6238, ±1 step) with ten single-use recovery codes.
- **Brute-force**: per-account lockout with exponential backoff (60 s → 1 h) plus
  a per-IP login rate limit (10/min); timing equalised to avoid enumeration.
- **API / MCP tokens**: SHA-256 of a 256-bit secret, role `api`; REST writes are
  create-only; per-token rate limit 120/min.
- **Share links**: HMAC-signed and **fail-closed** when auth is on — an
  unreachable registry returns 503 rather than serving a possibly-revoked doc.

Known limitations, stated plainly: the **TOTP secret is stored in cleartext** in
the registry; the **session cookie payload is readable** (signed, not encrypted);
share-link revocation is only re-checked when `auth_enabled`; account lockout
state is per-instance; and `SESSION_SECRET` is used for sessions, CSRF, share
links and the webhook alike (cloud mode refuses the default secret).

## Licence

Atlas Mind is licensed under the **GNU Affero General Public License v3.0**
(AGPL-3.0). Because the AGPL covers use over a network, if you run a modified
version as a network service you must make the corresponding source available to
its users. See `LICENSE` for the full terms and `NOTICE` for the brand notice.

**Brand notice.** The name **Atlas Mind** and its visual wordmark (the styled
"Atlas" + "Mind" badge in the viewer and login page) are a fixed part of the
engine and are not granted to you by the software licence. The configurable
`prefix` key lets you display your own name in front (e.g. `"Acme"` → "Acme Atlas
Mind"); the `Atlas Mind` wordmark itself stays. You may fork and modify under the
AGPL, but please do not present a modified version as the official Atlas Mind, and
keep the brand notice intact.

Bundled third-party frontend libraries and fonts are vendored under their own
licences (MIT, Apache-2.0, BSD-3-Clause, OFL, …); see `web/vendor/LICENSES.md`.
