---
tags: [guide, start]
---

# Install & set up your own mind

This demo is read-only — a frozen snapshot. The real thing is a command you run
on your own machine, against your own files. Here is the whole path, from nothing
installed to a living mind you edit and (optionally) share.

It takes about five minutes.

## What you need

| Requirement | Why | Notes |
|---|---|---|
| **Python 3.11+** | Atlas Mind is a single Python program, standard library only. | Already on most macOS/Linux. On Windows, install from [python.org](https://www.python.org/downloads/) and tick *"Add to PATH"*. |
| **git** | Your mind *is* a git repository — that is how you version and sync it. | [git-scm.com](https://git-scm.com/downloads). Optional if you only ever run locally, but you'll want it. |
| **A GitHub account** | Only to back up / sync your mind across machines, or to deploy it. | Optional. A mind works perfectly with zero accounts, fully offline. |

> No database, no sign-up, no API key. The engine has **no third-party
> dependencies** — see [[features/own-your-data]].

## 1 — Check Python and git

Open a terminal and confirm both are reachable:

```bash
python3 --version    # → Python 3.11.x or newer
git --version        # → git version 2.x
```

If a command is "not found", install it from the links in the table above and
reopen your terminal.

## 2 — Install Atlas Mind

Pick **one** of these. The first is the cleanest — it drops a self-contained
`atlas` command on your PATH without touching your Python install.

```bash
# Recommended — isolated install via uv or pipx
uv tool install atlas-mind        # or: pipx install atlas-mind

# Or classic pip (a virtualenv is recommended)
pip install atlas-mind
```

Check it worked:

```bash
atlas --help
```

> Just want a peek without installing anything?
> `uvx atlas-mind serve <a-folder>` runs it once straight from PyPI.

## 3 — Create your mind

`init` scaffolds a fresh mind: an `atlas.toml` config, a `content/` folder with a
few example documents, the AI-native scaffolding, and a fresh git repo.

```bash
atlas init ~/my-mind
```

On a terminal it asks a couple of questions (interface language, brand prefix,
tagline). Press Enter to accept the defaults, or pass `--yes` to skip them. It
**never overwrites** existing files, so it's safe to point at a folder you
already have.

## 4 — Run it locally

```bash
atlas serve ~/my-mind
```

This builds the viewer once, then becomes the server. Open
<http://127.0.0.1:8765> — that's *your* version of what you're looking at right
now, but editable. Stop it any time with `Ctrl+C`.

You can already start writing: drop `.md` files into `content/`, link them with
`[[wikilinks]]` (see [[guides/wikilinks-and-backlinks]]), and refresh.

## 5 — Put it on GitHub (optional)

Your mind is already a git repo. To back it up and sync it between machines,
create an **empty** repository on GitHub, then:

```bash
cd ~/my-mind
git add -A
git commit -m "My mind, first commit"
git remote add origin git@github.com:<you>/<your-mind>.git
git push -u origin main
```

From then on it's just `git pull` / `git push`. The engine code and your content
stay in **separate** repositories — own the engine, own the data.

## 6 — Connect your AI (optional)

A running instance exposes an **MCP** endpoint so an assistant can search, read
and write your mind. Mint a token and point your AI at the printed URL:

```bash
atlas token create ~/my-mind --label claude
# → https://<your-atlas>/mcp/<token>
```

See [[features/ai-native]] for the full loop.

## 7 — Host it for real (optional)

Running locally is great for one person on one machine. To reach your mind from
your phone, share it, or let your AI hit it from the cloud, put it on a server.
The same `atlas` command scaffolds everything:

```bash
# Fly.io, end to end — creates the app + volume, sets the secrets,
# asks for your private content repo, deploys, makes your admin account
atlas deploy ~/my-mind --target fly --wizard

# Or scaffold files for Docker Compose / a plain VM instead
atlas deploy ~/my-mind --target compose    # Dockerfile + compose + Caddy (auto-HTTPS)
atlas deploy ~/my-mind --target systemd    # a service unit, no Docker
```

In hosted mode the server clones your **private** content repo at boot, turns on
**authentication** (you create accounts with `atlas user add`), and pushes edits
back to GitHub — so the browser, your phone and your AI all read and write the
same git-backed mind. One process behind a reverse proxy; still no database, and
the code stays something you can read line by line.

Hosting is also the moment your mind becomes truly **AI-native**: the MCP
endpoint from step 6 now lives at a real URL your assistant can reach from
anywhere.

## Where to go next

- **[[guides/markdown-showcase]]** — everything the renderer supports.
- **[[features/multi-format]]** — drop in HTML decks, PDFs and Word files too.
- **[[features/the-mind-graph]]** — watch the links become a graph.
- Hosting it for real, in depth (tokens, HTTPS, updates): see the project
  [README](https://github.com/Anakior/atlas-mind#deployment).

Back to [[welcome|the start]].
