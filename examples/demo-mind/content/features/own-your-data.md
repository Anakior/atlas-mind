---
tags: [feature, philosophy]
---

# Own your data

Notion, and every hosted notes app, ask you to pour your thinking into *their*
structure, on *their* servers, in *their* format. You rent the space; they hold
the keys. Atlas Mind inverts that.

## Three things you own

1. **The data** — your knowledge is **plain Markdown files in your own git
   repository**. No proprietary export, no lock-in. If Atlas Mind disappeared
   tomorrow, your mind would still open in any text editor.
2. **The engine** — a single Python HTTP server you can read line by line,
   written entirely on the **standard library**. No database. Accounts, tokens
   and share links live in plain JSON files on disk.
3. **The mind** — the structure is yours: folders, tags and
   [[guides/wikilinks-and-backlinks|wikilinks]] you define, not a schema someone
   else imposes.

## Engine and content, kept apart

The whole design rests on one separation:

| Layer       | What it is                              | Where it lives          |
|-------------|------------------------------------------|--------------------------|
| **Engine**  | Python server + build step + viewer      | the `atlas-mind` repo    |
| **A mind**  | your notes + a small `atlas.toml`        | *your own* git repo      |

Upgrading the engine never touches your content; syncing content never touches
the engine. That is the whole point — read the rest of the story in
[[notes/why-not-notion]], and see how your AI plugs in via [[features/ai-native]].
