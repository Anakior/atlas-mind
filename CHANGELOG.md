# Changelog

All notable, user-facing changes are listed here; the full commit-level history
lives on the [GitHub releases](https://github.com/Anakior/atlas-mind/releases)
page (`gh release create vX.Y.Z --generate-notes` builds those from commits). The
format loosely follows [Keep a Changelog](https://keepachangelog.com/) — only
highlights, not every commit — and versioning tracks the PyPI package.

## [Unreleased]

### Added
- **Inbox triage.** Point your agents at upstream noise (mail, alerts, a competitor's
  move, a CI webhook) and they pre-sort it: each item lands as a ready-to-file card
  in a per-person inbox via the new `create_inbox_item` MCP tool, with a suggested
  folder, tags, and the same-subject doc it echoes. You keep / trash / snooze from a
  focused card on the home (keyboard K / X / S / J); Keep files it into your mind with
  the chosen folder and tags. Each person owns their own lane, and the inbox is sealed
  from the build, the tree and the search index.
- Opt-in `[site]` config (`url` / `description` / `og_image`): the build emits a
  `<meta name="description">`, a canonical link and an Open Graph / Twitter card
  when a public URL is set — so a self-hosted mind shares cleanly.
- Offline builds embed an activity-layer snapshot (journal, obsolescence and
  contradiction candidates), so a static export shows the same home the server
  serves live instead of an empty one.

### Changed
- Contradiction detection reworked. The old typed-value collision finder (which
  flagged dozens of non-issues) gives way to topical tf-idf cosine clusters plus
  three precise deterministic detectors (aligned table-row drift, polarity/negation,
  intra-doc status). The Health card now shows only the solid signals: a value
  divergence between two aligned tables, or a pair your AI has confirmed. The broader
  same-topic clusters stay the AI's on-demand material via the `contradictions` MCP
  tool, so the card surfaces a handful instead of dozens.
- Errors now surface as a styled in-app popup instead of the native `alert()`;
  in an offline build every server-backed action shows a single localized
  "feature disabled offline" notice.

### Fixed
- The contradiction scan is now Unicode-aware (non-latin scripts such as Cyrillic
  or CJK no longer silently return nothing) and provably memory-bounded, so a large
  or markup-heavy mind can no longer run the scan out of memory.
- Git output is decoded as UTF-8 on every platform — accented author names in the
  activity feed and the `→` in move subjects no longer mojibake on Windows.
