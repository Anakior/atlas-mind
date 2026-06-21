---
tags: [feature, ai]
---

# AI-native — the memory your AI shares

Atlas Mind is meant to be the **external brain you share with your AI
assistant**: a library it reads before answering, and writes back into when it
produces something durable. Your AI comes to *your* mind through an open
protocol — it never pulls your brain into its own.

## How it connects: MCP

A running instance exposes an **MCP** (Model Context Protocol) endpoint. Each user
mints their own token from the web UI (**Settings → Tokens**, or `atlas token
create <mind>` locally) and points their assistant at
`https://<your-atlas>/mcp/<token>`. From then on the AI works your mind through
**nineteen tools**, grouped into four superpowers.

### 1. Reads your whole mind

| Tool          | What the AI does with it                        |
|---------------|--------------------------------------------------|
| `search_docs` | full-text search across the whole mind           |
| `read_doc`    | read a specific document (Markdown or HTML)      |
| `list_tree`   | browse the folder structure                      |
| `recent_docs` | see what changed lately                          |

### 2. Writes it back

| Tool         | What the AI does with it                                  |
|--------------|-----------------------------------------------------------|
| `create_doc` | file a new note (recap, decision, analysis)               |
| `edit_doc`   | update a document — full rewrite or a surgical replace    |
| `move_doc`   | move/rename, fixing every incoming `[[backlink]]`         |
| `delete_doc` | archive a note (soft-deleted to trash, never erased)      |

### 3. Sees the connections

| Tool                | What the AI does with it                          |
|---------------------|----------------------------------------------------|
| `get_links`         | the documents a note points to                     |
| `get_backlinks`     | the documents that point back at it                |
| `get_mind_topology` | a bird's-eye map: hubs, orphans, top tags          |
| `list_by_tag`       | every note carrying a tag                          |

### 4. Travels through time

Because your mind is a git repository, its whole history is queryable — something
a present-state index can't do:

| Tool             | What the AI does with it                                   |
|------------------|------------------------------------------------------------|
| `doc_history`    | a document's revisions, newest-first, across renames       |
| `doc_at`         | read a document as it was at a past revision *or date*     |
| `doc_diff`       | what a commit changed in a document                        |
| `search_history` | find when a string entered or left history (even if since deleted) |
| `changelog`      | recent commit-level activity across the whole mind         |
| `doc_blame`      | trace each line to the commit that wrote it                |
| `doc_revert`     | restore a document to a past revision                      |

This is how an AI answers *"when did we decide this — and what was it before?"*
without you digging through git yourself.

## The loop

```text
   you ── ask ──▶ AI ── search_docs / read_doc / search_history ──▶ Atlas (source of truth)
                  │                                                      ▲
                  └── create_doc / edit_doc / doc_revert ────────────────┘
                          (durable knowledge written back, every version kept)
```

The convention is simple and lives in an `AGENTS.md` at the root of your mind:
**the Atlas is the source of truth**; before answering on a documented topic the
AI consults it rather than guessing, and any lasting output is written into the
Atlas, not lost in a chat thread.

This is what makes a pile of notes into a [[features/the-mind-graph|mind]] that
compounds over time. And because you [[features/own-your-data|own the data and
the engine]], the AI enriches your library without ever taking custody of it.
