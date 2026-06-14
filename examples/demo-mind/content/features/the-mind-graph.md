---
tags: [feature]
---

# The Mind — a graph, not a folder

A folder is a filing cabinet. A **mind** is a network. Atlas Mind builds a link
graph from the [[guides/wikilinks-and-backlinks|wikilinks]] between your
documents, so your knowledge has *shape*: clusters, hubs, and paths between
ideas you would never see in a flat list.

## How the graph is built

- Every `[[wikilink]]` becomes a directed edge between two documents.
- Parent folders and frontmatter `tags` become nodes too, grouping related
  notes.
- The build step computes the **backlinks** index — for any document, every
  other note that points at it — and embeds it in the viewer.

This very demo is a small graph. Trace a few edges from here:

- back to the hub: [[welcome]]
- the philosophy cluster: [[features/own-your-data]] ↔ [[notes/why-not-notion]]
- the how-to cluster: [[guides/markdown-showcase]] ↔
  [[guides/wikilinks-and-backlinks]]
- the AI cluster: [[features/ai-native]]

## Minds that link to other minds

A mind doesn't have to be an island. You can **follow a node** published by
*another* Atlas instance — it shows up read-only, in its own teal cluster, wired
into your own notes. This demo follows one: see
[[remotes/mira-garden/start-here|Mira's public garden]] and its
[[remotes/mira-garden/zettelkasten|note on the Zettelkasten]]. Open the graph and
you'll spot it as a separate island bridged to the main mind — that bridge is the
whole idea of the hive. Want to build one yourself? See [[guides/hive-mind]].

## Why a graph beats search alone

Search finds what you remember to ask for. A graph surfaces what you *forgot* —
the note three hops away that turns out to be exactly relevant. Combine the two
and your past thinking starts working *for* you instead of rotting in an archive.

> Scroll to the bottom of any document in this demo: the **backlinks** section is
> the graph, seen from one node.
