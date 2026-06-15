---
tags: [guide, hive]
---

# Build a Hive Mind

A mind doesn't have to be an island. Two Atlas instances can **share a slice of
their content** — one publishes a *node*, the other mirrors it read-only — and
keep it in sync. That's a **Hive Mind**: minds that point at other minds, in the
open, with no central server in the middle.

This demo already follows one: the teal
**[[remotes/mira-garden/start-here|Mira's public garden]]** cluster you can see in
[[features/the-mind-graph|the graph]]. Here is how to build your own.

## The model in one minute

- It's a **personal memory with sharing**, *not* a real-time collaborative editor.
  A node is published by one side and **mirrored read-only** by the other.
- It's **pull-asymmetric**: only the **publisher** needs to be reachable over the
  network. The **subscriber** just pulls — if the publisher goes offline, the last
  synced copy stays in place.
- Mirrored documents land under `remotes/<node>/`, show up under a **Mental nodes**
  umbrella in the sidebar, and appear as their own teal, dashed regions in the
  graph. They are read-only on your side.

```text
   Publisher (reachable)                     Subscriber (just pulls)
   ┌────────────────────┐   atlas-node:…     ┌──────────────────────────┐
   │ folder / document  │ ───── link ─────▶ │ remotes/<node>/  (mirror)│
   │  + read-only token │ ◀──── pull ────── │  re-syncs on a cadence   │
   └────────────────────┘   (SHA-256 diff)   └──────────────────────────┘
```

## Before you start

- **Two minds**, each running (see [[guides/install-and-setup]]). They can be two
  people, or two of your own machines.
- The **publisher must be hosted** (auth on, reachable over the network — step 7 of
  the install guide). The subscriber can be anything, even a laptop.
- You act from the admin **Settings → Nodes** panel, so you need an **admin
  account** on each side (`atlas user add <mind> --email you@… --role admin`).

## 1 — Publish a node (publisher side)

In the hosted instance, open the tree and pick what to share — a whole folder or
a single document — then use the **share-as-node** button (also in **Settings →
Nodes**).

You get a **one-time** link:

```text
atlas-node:<origin-url>#<read-only-token>
```

It carries the origin URL and a **read-only token** (stored hashed on the
publisher; the link is shown only once). Copy it now — to rotate it later, just
re-issue the node.

> Scope it deliberately: the token is **scoped to the published path**. Publish the
> `team/specs` folder, not your whole mind.

## 2 — Subscribe (subscriber side)

On the other instance, open **Settings → Nodes** and paste the link. Atlas Mind:

1. fetches a **manifest** from the publisher,
2. downloads the documents into a read-only mirror under `remotes/<node>/`,
3. records the source so it can re-sync.

The node now appears in your sidebar under **Mental nodes**, with the source
instance shown.

## 3 — Browse it like your own

Read it, search it, and **link to it** from your own notes with a normal
[[guides/wikilinks-and-backlinks|wikilink]] — `[[remotes/<node>/some-doc]]`. Open
the graph (`Ctrl/Cmd+G`) and the node shows as a **teal island** bridged into your
mind by those links. That bridge is the whole idea of the hive.

What you **can't** do: edit, rename, move or delete mirrored documents — it's a
mirror, and the next sync would overwrite the change anyway.

## 4 — Keep it in sync

The mirror re-syncs **automatically** on the regular pull cadence — it compares
the manifest by **SHA-256** and only pulls what changed. There's also an on-demand
**Sync** button when you want it now. If the publisher is offline, the sync is a
no-op and your last copy stays put.

## 5 — Make it yours (optional)

Need to fork a mirrored note into something you can edit? **Appropriate** it: that
copies a node (or, from a multi-file node, just the current document) into your own
`content/` at a destination you choose — a detached, fully editable copy that no
longer tracks the source.

## 6 — Revoke (publisher side)

Tokens are **revocable at any time** from **Settings → Nodes**. Revoking removes
the subscriber's access at their next sync. Nothing on either side is overwritten
without a sync the owner controls.

## Self-host a Hive for a team (worked example: 20 people)

The Hive scales without scaling your ops. The trick: the **engine** is just a
package, so you install it **once** and run many cheap, independent processes —
each its own mind — behind a single reverse proxy. Here is the concrete shape for
**20 people**.

You run **20 minds** on **one server** — one per person, nothing central. That's
20 `atlas serve` processes — each a stdlib Python server with no database, so they
sit comfortably on a small VM. Give each a port (say **8701–8720**) and its own
private content repo.

There is **no "team mind" to set up**: the Hive is peer-to-peer. Anyone publishes
any folder or document, to whomever they choose, and anyone subscribes to what
they were given a link for. Sharing flows directly between the 20 minds — see step 4.

**1. Install the engine once.** One venv (or one pinned Docker image) for all 20:

```bash
python3 -m venv /opt/atlas/venv
/opt/atlas/venv/bin/pip install atlas-mind
```

**2. Run one process per mind.** A single systemd *template* unit serves them all
— `%i` is the instance name:

```ini
# /etc/systemd/system/atlas@.service
[Service]
User=atlas
EnvironmentFile=/etc/atlas/%i.env          # PORT, SESSION_SECRET, GITHUB_REPO_URL
ExecStart=/opt/atlas/venv/bin/atlas serve /srv/minds/%i
Restart=always
```

```bash
# each /etc/atlas/<name>.env sets PORT=87xx, KB_AUTH_ENABLED=1, SESSION_SECRET=…, GITHUB_REPO_URL=…
systemctl enable --now atlas@alice atlas@bob …   # 20 instances, one per person
```

**3. One reverse proxy, subdomain → port.** A single Caddy with a wildcard cert
routes `<name>.kb.example.com` to the right process:

```caddy
*.kb.example.com {
  tls you@example.com           # one wildcard certificate for all 20
  map {host} {dest} {
    alice.kb.example.com  127.0.0.1:8701
    bob.kb.example.com    127.0.0.1:8702
    # … one line per person …
  }
  reverse_proxy {dest}
}
```

**4. Let people share, peer-to-peer.** No central node, no admin choke point:
each person decides what to expose. Whenever someone wants to share, they publish
a folder or document from their own **Settings → Nodes** (steps 1–2 above) and
send the `atlas-node:…` link to exactly the people they want — who paste it into
their own Nodes panel to mirror it read-only. Alice can publish her `specs/` to the
whole group, Bob can share one design doc with just Carol; each link is scoped and
revocable independently. The result is a real web of minds, not a hub.

> Want a common space anyway? It's just a convention, not a requirement: spin up
> a 21st "team" mind exactly like the others, and have people subscribe to *its*
> node. Useful for shared conventions, but nothing in the Hive depends on it.

**What you actually operate:** *one* engine install, *one* reverse proxy, *one*
wildcard cert. The sharing graph is the users' business — you don't manage it.
Updating the engine for everyone is a single step —
`pip install -U atlas-mind && systemctl restart 'atlas@*'` (or bump the
image tag and restart) — not 20 redeploys.

## Why it matters

- **Your AI sees everything.** Mirrored content lives under your `content/`, so the
  MCP/REST tools read it like any other document — your assistant can cite a
  teammate's node. See [[features/ai-native]].
- **No lock-in, no central server.** Sharing is just signed links and pulls between
  instances you each own. You still
  [[features/own-your-data|own your data and your engine]].

Back to [[welcome|the start]], or see [[features/the-mind-graph]] for the graph
this builds.
