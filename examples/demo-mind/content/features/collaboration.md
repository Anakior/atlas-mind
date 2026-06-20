---
tags: [feature, collaboration]
---

# Collaboration — one mind, many people

Sharing in Atlas Mind comes in **two very different flavours**, and it's worth
keeping them straight:

- **The Hive** ([[guides/hive-mind]]) links *your* mind to *someone else's* — two
  separate instances, a read-only mirror, peer-to-peer. Minds that follow minds.
- **Collaboration** (this page) is the other direction: **several people inside
  one mind**, each document with its own access — private to you, shared with a
  few, or open to the whole team. Google-Docs-style sharing, *à la Notion* — but
  on files you own, with no database.

Same engine, no new moving parts: access is just another JSON file (`acl.json`),
on disk next to your accounts and share links.

## Private by default, shared on purpose

Every document has a state, shown at a glance by a coloured dot in the tree:

- 🟡 **Private** — only you (a note a member creates starts here).
- 🔵 **Shared** — yours, but you've granted some people or groups access.
- 🟢 **Shared with you** — someone else's document, shared *with* you.
- *(no dot)* **Common** — no owner: visible to the whole team, the shared socle.

You grant access **per person or per group**, at a level — **view**, **comment**
or **edit** — and a grant can **expire** (handy for a contractor's 30 days). The
*owner*, not the admin, controls a document's sharing: an admin curates the
common space but **never sees another member's private notes**. And nothing is an
existence oracle — what you can't see simply isn't there (a clean 404, not a
"forbidden" that confirms it exists).

## Invite a teammate

An admin invites someone by email and gets a **one-time link**; the person opens
it and **sets their own password** — the admin never types it or sees it. From
then on it's their account, with their own private space and whatever has been
shared with them.

## See what's yours, what's shared

Collaboration is only useful if it's legible, so the viewer surfaces it without
making you open a single dialog:

- a **"Shared with you"** section in the sidebar, listing what others handed you;
- the tree dots above, so you scan a folder and *see* who-sees-what;
- a **"· shared by Alice"** line right under a shared document's title;
- and **margin notes that carry their author** — the amber highlights on
  [[features/own-your-data]] and [[notes/why-not-notion]] in this very demo show
  **✍ who wrote each one, and when** (that part is the live feature, not a mockup).

## Collaboration *vs* the Hive — which one?

| | **Collaboration** | **The Hive** ([[guides/hive-mind]]) |
|---|---|---|
| Who | several people in **one** mind | **two** minds, each its own |
| Access | per-document: view / comment / edit | a published slice, **read-only** mirror |
| Edits | anyone with `edit` writes live | the subscriber can't touch the mirror |
| Reach for it when | a team works a shared knowledge base | you follow a colleague's or a public garden's notes |

They compose, too: run [[guides/hive-mind|one mind per person]] **and** let a few
people share an instance — whatever fits the group.

## Still no database, still yours

Accounts, groups, share links and now per-document access are **plain JSON on
disk** under `.atlas/` — never committed with your content, never a hosted
service you can be evicted from. Collaboration doesn't trade away the one thing
that matters: you still [[features/own-your-data|own the data and the engine]].

Back to [[welcome|the start]], or wire your mind to another with the
[[guides/hive-mind|Hive]].
