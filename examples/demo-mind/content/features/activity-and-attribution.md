---
tags: [feature, activity]
---

# Activity & attribution — your mind remembers who did what

Every change to your mind is a git commit, and Atlas turns that history into a
living **activity layer** on the home page — not a raw log, but a readable story
of how your knowledge grew, and who (or what) grew it.

## Attribution, AI included

Each edit is attributed to its author, with the date and **whether an AI wrote
it** — Atlas records the AI family in a git trailer when your assistant writes
through MCP. So you can always tell a human note from an AI-written one: "who
decided this, and was it me or Claude?" stops being a guess.

## The activity card

The home page opens on an **Activity** card with three views:

- **Journal** — a chronological feed of who changed what, grouped by day, with a
  badge on AI-authored edits. Click any entry to peek that document's history
  without leaving the page; a "this week" digest sums up the recent pulse.
- **Constellation** — the contributors as a small constellation, a glanceable
  picture of who's been active.
- **Health** — two maintenance lenses:
  - **Obsolescence** — documents nobody has touched in months, oldest first
    (dated by the last git commit, so it survives a clone or pull).
  - **Contradictions** — pairs of documents on the **same subject** (shared tags
    or wikilinks) that may now disagree, surfaced for review.

## Your AI works the same layer

The Health view is a deterministic shortlist; the judgement is the AI's. Through
MCP it reads the same data — `activity` (the attributed feed), `stale`
(obsolescence) and `contradictions` (the candidate pairs) — then opens the docs
with `read_doc` / `doc_diff` to confirm what's actually outdated or conflicting.
See [[features/ai-native]] for the full toolset.

Because it all rides on the [[features/own-your-data|git history your mind already
carries]], there's nothing extra to maintain: write notes, and the activity layer
writes itself.
