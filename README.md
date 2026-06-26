# Atlas Mind

[![Live demo](https://img.shields.io/badge/live-demo-635bff.svg)](https://atlas-mind.anakior.app/) [![Licence: AGPL v3](https://img.shields.io/badge/licence-AGPL--3.0-blue.svg)](LICENSE) ![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-blue.svg) ![Dependencies: standard library](https://img.shields.io/badge/deps-standard%20library-green.svg) ![Database: none](https://img.shields.io/badge/database-none-green.svg)

<!-- mcp-name: app.anakior/atlas-mind -->

> **It's your mind, not someone else's.**

Notion, and every hosted notes app, ask you to pour your thinking into *their* structure, on *their* servers, in *their* format. You rent the space; they hold the keys. Atlas Mind inverts that: your knowledge is **plain files in your own git repository**, served by an **engine you can read line by line** and throw away without losing a single note. Your AI comes to *your* library through an open protocol; it never pulls your brain into its own.

Own the data. Own the engine. Own the mind.

<p align="center">
  <img alt="Atlas Mind viewer" width="900" src="https://github.com/user-attachments/assets/726ab344-b024-425f-a5ee-f56d97a886c7" />
</p>

> 🔗 **[Try the live demo →](https://atlas-mind.anakior.app/demo/)** (offline build, some features missing) · **[What is Atlas Mind?](https://atlas-mind.anakior.app/)**

**Atlas Mind** is a self-hostable wiki / knowledge base engine, and an external brain you share with your AI. It serves a single-page viewer from a folder of documents (a *mind*), keeping the **engine** (the code) cleanly decoupled from your **content** (your notes, in their own git repository). Built on three ideas:

- **Multi-format, not just Markdown.** Markdown is first-class (rendered, linked, searched). Standalone **HTML** decks and dashboards, **PDFs**, and **Word `.docx`** are previewed inline, converted to readable HTML in your browser, nothing uploaded anywhere.
- **AI-native.** It exposes an **MCP** endpoint (twenty-four tools to read, write, triage, map, rewind and audit your mind), and `atlas init` scaffolds the conventions (`AGENTS.md`, `agents/`, `ai-sessions/`) so an assistant knows how to use your mind.
- **Lightweight & self-contained.** A single Python HTTP server on the **standard library**: **no database**, accounts and share links live as plain JSON on disk, frontend libraries and fonts are vendored. A running instance makes **no third-party network calls**: your mind never leaves your disk, and nothing you write trains anyone's model.

It is not a multi-tenant SaaS, a real-time collaborative editor, or a plugin marketplace. One focused mind per instance, fully yours.

## Install

Installing puts a self-contained `atlas` command on your PATH (the viewer assets ship inside the package, no separate download).

```bash
# Easy way: uv or pipx (isolated env, no virtualenv to manage)
uv tool install atlas-mind        # or: pipx install atlas-mind
atlas serve ~/my-mind

# Run once without installing, straight from PyPI
uvx atlas-mind serve ~/my-mind    # or: pipx run atlas-mind serve ~/my-mind

# With pip (a virtualenv is recommended)
pip install atlas-mind
```

Requires **Python >= 3.11** and a **git repository for your content**.

## Quick start

```bash
atlas init ~/my-mind     # scaffold a mind: atlas.toml, example docs, AGENTS.md, git init
atlas serve ~/my-mind    # build once if needed, then serve on http://127.0.0.1:8765
```

`init` is never destructive (it refuses a non-empty directory without `--force` and keeps any file already present). `serve` listens on `127.0.0.1:8765` with authentication off by default. To produce the static viewer without serving: `atlas build ~/my-mind [--offline]`.

See `atlas --help` for all commands (`user`, `token`, `share`, `deploy`).

## Use it with your AI (MCP)

Atlas Mind is designed to be the external memory your assistant reads and writes. On a deployed instance, each user mints their **own** token from the web UI — **Settings → Tokens** — bound to their account; it prints the MCP URL to point your AI at.

Locally (or to script it), the CLI does the same:

```bash
atlas token create ~/my-mind --label claude
# → prints the MCP URL: https://<your-atlas>/mcp/<token>
```

The MCP endpoint exposes **twenty-four tools** in six groups:

- **read**: `search_docs`, `read_doc`, `list_tree`, `recent_docs`
- **write**: `create_doc`, `edit_doc`, `move_doc` (fixes incoming `[[backlinks]]`), `delete_doc` (soft-delete to `.trash/`)
- **graph**: `get_links`, `get_backlinks`, `list_by_tag`, `get_mind_topology`
- **time-travel** (your mind is a git repo): `doc_history`, `doc_at`, `doc_diff`, `search_history`, `changelog`, `doc_blame`, `doc_revert`
- **activity** (the attribution layer's read side): `activity` (who changed what, with AI-author detection), `stale` (docs untouched for months: obsolescence), `contradictions` (same-topic doc pairs to review), `judge_contradiction` (record a verdict on a pair)
- **inbox**: `create_inbox_item` (an agent stages a ready-to-file item in your inbox for triage)

`atlas init` scaffolds `AGENTS.md` + `content/agents/` + `content/ai-sessions/` so the assistant knows your conventions. There is also a **REST API v1** (Bearer tokens, create-only writes) with a published **OpenAPI 3.1** spec.

## Features

- **Reading**: GitHub-flavoured Markdown (TOC, syntax highlighting, reading time, tag bar), inline preview of standalone HTML decks/dashboards, PDF, and `.docx` (converted in-browser, read-only). Download any file as its original.
- **Navigation**: collapsible tree, full-text search (server-side online, fuzzy MiniSearch offline), `[[wikilinks]]` + backlinks + "same subject", folder/frontmatter tags, mind-wide task rollup, command palette (Ctrl-K), pinned and recent docs.
- **The Mind**: a force-directed mind palace where every document and tag is a navigable node, colour-grouped by folder, recent nodes glowing, orphans dimmed.
- **Editing**: create / edit / rename / move / delete from the viewer (moving rewrites the wikilinks pointing at a doc), document templates, interactive task checkboxes, a categorised todos widget.
- **History**: every document git-versioned, with a revision list, clean diffs, view/restore of past versions (restore is a new commit), renames and moves followed.
- **Activity**: a home card over the attributed git history — a journal of who-changed-what (with AI-author detection and a per-doc history peek), a constellation of contributors, and a Health view that surfaces stale documents (obsolescence) and same-topic contradiction candidates for your AI to review.
- **Inbox**: a per-person triage lane on the home for the items your agents staged via MCP. One focused card at a time; keep (filed to a suggested folder and tags), trash or snooze, by click or keyboard (K / X / S / J).
- **Annotations**: notes anchored to a text selection, re-anchored on later visits, with one-click copy-all-notes as Markdown.
- **Sharing**: per-document access in cloud mode (private / shared with people or groups / common to the team), plus HMAC-signed public share links with optional expiry.
- **Offline & PWA**: a self-contained `index-offline.html` that works from `file://`, an installable PWA via service worker, live reload over SSE.
- **i18n**: French and English, a single carefully-built dark theme, re-skinnable via a CSS extension.

## Self-hosting

- **Cloud mode**: accounts and login (admin / member roles), per-document access control, cookie sessions, optional **TOTP 2FA** with recovery codes, per-account lockout and per-IP login rate limiting, full CSRF defence.
- **Deployment**: `atlas deploy ~/my-mind --target compose|systemd|fly`; `fly --wizard` deploys end-to-end.
- **Configuration**: a small `atlas.toml` (brand prefix, port, auth, content paths).
- **Updating**: engine and content update independently, and upgrading the engine never touches your notes.

## Documentation

The documentation is itself an Atlas mind — **[browse it in the live demo →](https://atlas-mind.anakior.app/demo/)** (the `guides/` and `features/` sections).

## Licence

AGPL v3, see [LICENSE](LICENSE). The "Atlas" + "Mind" branding in the viewer and login page is a fixed part of the project.
