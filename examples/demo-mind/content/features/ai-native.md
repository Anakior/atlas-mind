---
tags: [feature, ai]
---

# AI-native — the memory your AI shares

Atlas Mind is meant to be the **external brain you share with your AI
assistant**: a library it reads before answering, and writes back into when it
produces something durable. Your AI comes to *your* mind through an open
protocol — it never pulls your brain into its own.

## How it connects: MCP

A running instance exposes an **MCP** (Model Context Protocol) endpoint with six
tools:

| Tool           | What the AI does with it                         |
|----------------|---------------------------------------------------|
| `search_docs`  | full-text search across the whole mind            |
| `read_doc`     | read a specific document                           |
| `list_tree`    | browse the folder structure                        |
| `recent_docs`  | see what changed lately                            |
| `create_doc`   | file a new note (recap, decision, analysis)        |
| `edit_doc`     | update an existing document                         |

You create a token (`atlas token create <mind>`) and point your assistant at
`https://<your-atlas>/mcp/<token>`. From then on the AI can search, read and
write directly into your memory palace.

## The loop

```text
   you ── ask ──▶ AI ── search_docs / read_doc ──▶ Atlas (source of truth)
                  │                                     ▲
                  └── create_doc / edit_doc ────────────┘
                          (durable knowledge written back)
```

The convention is simple and lives in an `AGENTS.md` at the root of your mind:
**the Atlas is the source of truth**; before answering on a documented topic the
AI consults it rather than guessing, and any lasting output is written into the
Atlas, not lost in a chat thread.

This is what makes a pile of notes into a [[features/the-mind-graph|mind]] that
compounds over time. And because you [[features/own-your-data|own the data and
the engine]], the AI enriches your library without ever taking custody of it.
