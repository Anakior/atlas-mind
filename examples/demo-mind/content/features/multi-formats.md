---
tags: [feature]
---

# Multi-format, not just Markdown

Most note apps speak one dialect. Atlas Mind keeps your knowledge in one place
**whatever its shape** — and renders it all inline, in your browser, with
nothing uploaded anywhere.

## What it renders

- **Markdown** — first-class: rendered, linked, searched, backlinked. See
  [[guides/markdown-showcase]] for the full rendering tour.
- **Standalone HTML** — decks, dashboards, reports. Drop an `.html` file in your
  content and it previews inline. This demo ships one:
  [[decks/atlas-dashboard|a full admin dashboard mockup]].
- **PDF** — viewed inline through the browser's PDF engine.
- **Word `.docx`** — converted to readable HTML *client-side* (via `mammoth.js`),
  never uploaded.

## Why it matters

Your knowledge rarely arrives as tidy Markdown. A meeting deck, a signed PDF, a
spec someone sent as `.docx` — they all belong next to your notes, not in a
separate drawer. Atlas Mind treats them as first-class citizens of the same
[[features/the-mind-graph|mind]].

> In the **offline demo** you are reading, the Markdown and the standalone HTML
> dashboard are embedded directly in the page. PDF and `.docx` rendering need
> actual files, so they shine best in a running instance — but the principle is
> the same: one library, every format.

Next: let your AI read all of it → [[features/ai-native]].
