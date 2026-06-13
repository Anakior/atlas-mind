---
tags: [guide]
---

# Wikilinks and backlinks

Links are what turn a folder of files into a [[features/the-mind-graph|mind]].
Atlas Mind uses a simple, portable wikilink syntax — the same one you may know
from other tools — and computes backlinks automatically.

## Writing a link

```markdown
[[notes/why-not-notion]]            → links by path
[[why-not-notion]]                  → links by filename (no folder needed)
[[notes/why-not-notion|read why]]   → custom display text after the pipe
```

A link resolves either by **path** (`notes/why-not-notion`) or by **filename**
(`why-not-notion`), so you can move a note between folders without breaking every
reference to it.

## Backlinks come for free

You never write a backlink. The build step scans every document, records each
`[[link]]` as an edge, and inverts the index. The result: at the bottom of every
document, Atlas shows **every other note that points here** — with a snippet of
the surrounding text.

Try it: this page links to [[notes/why-not-notion]] and
[[features/the-mind-graph]]. Open either one and scroll down — you'll find *this*
page listed in its backlinks.

## Why it matters

- **No dead ends.** Every connection is bidirectional, even though you only typed
  it once.
- **Refactor freely.** Rename and reorganize; links resolve by name.
- **The graph is real.** Those edges feed [[features/the-mind-graph|the Mind]] and
  the AI's [[features/ai-native|search]].

Back to [[welcome|the start]].
