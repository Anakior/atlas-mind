---
tags: [feature, ai]
---

# AI-native — the memory your AI shares

Atlas Mind is meant to be the **external brain you share with your AI
assistant**: a library it reads before answering, and writes back into when it
produces something durable. Your AI comes to *your* mind through an open
protocol — it never pulls your brain into its own.

## How it connects: MCP

A running instance exposes an **MCP** (Model Context Protocol) endpoint. Point
your assistant at `https://<your-atlas>/mcp` and it connects over **OAuth**: you
sign in to your Atlas, see what it asks for (read, inbox, write), untick what you
don't want to grant, and allow it. You can also mint a token yourself (**Settings →
Tokens**, or `atlas token create <mind>` locally) and use
`https://<your-atlas>/mcp/<token>`. From then on the AI works your mind through
**thirty tools**, grouped into six superpowers.

### 1. Reads your whole mind

| Tool          | What the AI does with it                        |
|---------------|--------------------------------------------------|
| `brief`       | the best sections on a topic, within a token budget |
| `search_docs` | ranked search, each hit with its section and how far to trust it |
| `grep_docs`   | find the exact lines that state a fact          |
| `read_doc`    | read a document, a line range or one section     |
| `list_tree`   | browse the folder structure                      |
| `recent_docs` | see what changed lately                          |
| `changes_since` | what changed since the AI last looked (a cursor it keeps) |
| `resume_session` | pick up a saved work session: resume command, open points, what moved since |

### 2. Writes it back

| Tool         | What the AI does with it                                  |
|--------------|-----------------------------------------------------------|
| `create_doc` | file a new note (recap, decision, analysis)               |
| `edit_doc`   | update a document — full rewrite or a surgical replace    |
| `move_doc`   | move/rename, fixing every incoming `[[backlink]]`         |
| `delete_doc` | archive a note (soft-deleted to trash, never erased)      |

Every edit comes back as a diff the AI can check, can be rehearsed with `dry_run`, and
is refused if you changed the document since the AI read it, so it never overwrites
your work.

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

### 5. Knows who did what

Every commit is attributed — author, date, and whether an **AI** wrote it — so the
mind carries an [[features/activity-and-attribution|activity layer]] the AI can read and audit:

| Tool             | What the AI does with it                                       |
|------------------|----------------------------------------------------------------|
| `activity`       | the attributed feed: who changed what, when, AI or human       |
| `agent_runs`     | an agent's work sessions, with the documents each one changed  |
| `undo_run`       | undo a whole session in one commit, all or nothing             |
| `stale`          | documents untouched for months — obsolescence to revisit       |
| `contradictions` | same-topic document pairs that may now disagree, to review     |
| `judge_contradiction` | record a verdict on a pair, so a false positive stops resurfacing |

### 6. Stages things for you

| Tool                | What the AI does with it                                        |
|---------------------|------------------------------------------------------------------|
| `create_inbox_item` | drop an item (a mail worth keeping, an alert) into your inbox to triage |

## Prompts you start yourself

Besides the tools the AI picks, the mind offers **prompts** you start by name — a
`/` command in Claude Code. Some come built in and gather live context for you: a
weekly review of what moved, a pass over the contradictions to settle, a new document
from one of your templates. The rest are yours: each Markdown file under
`agents/prompts/` becomes one, with its own arguments, and can pull in another
document — your session-save template, say — so every assistant follows the same
ritual.

Every document is also a **resource** the assistant's app can attach to the
conversation by its address, `doc://features/ai-native.md`, and search results link
to the documents they found.

Read-only tools are flagged as such, so your assistant can run them without asking,
and the destructive ones (`edit_doc`, `delete_doc`, `doc_revert`, `undo_run`) are
flagged too. A token can also be narrowed to reading, the inbox, or both: an agent that
triages your mail never gets to edit anything.

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
Atlas, not lost in a chat thread. Atlas hands that file to the AI as its
instructions the moment it connects, so every assistant follows your rules
without you pasting them anywhere.

This is what makes a pile of notes into a [[features/the-mind-graph|mind]] that
compounds over time. And because you [[features/own-your-data|own the data and
the engine]], the AI enriches your library without ever taking custody of it.
