# Changelog

All notable, user-facing changes are listed here; the full commit-level history
lives on the [GitHub releases](https://github.com/Anakior/atlas-mind/releases)
page (`gh release create vX.Y.Z --generate-notes` builds those from commits). The
format loosely follows [Keep a Changelog](https://keepachangelog.com/) — only
highlights, not every commit — and versioning tracks the PyPI package.

## [Unreleased]

## [1.0.0] - 2026-06-28

The viewer is now strict TypeScript built as real ES modules (esbuild `--bundle`) —
a maintainability milestone with no behaviour change — and this release folds in the
fixes from the first independent security review.

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
- `atlas dev seed` / `atlas dev inbox` (dev-only): populate a throwaway mind with
  sample inbox items and attributed git activity, so the home Activity card and the
  Inbox are testable without real history or upstream agents.

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
- The "newer version on PyPI" admin check is now **off by default**: a stock instance
  makes zero third-party network calls (opt in with `[server] update_check = true`).

### Fixed
- The contradiction scan is now Unicode-aware (non-latin scripts such as Cyrillic
  or CJK no longer silently return nothing) and provably memory-bounded, so a large
  or markup-heavy mind can no longer run the scan out of memory.
- Git output is decoded as UTF-8 on every platform — accented author names in the
  activity feed and the `→` in move subjects no longer mojibake on Windows.
- Muted UI text now meets WCAG AA contrast, and constellation nodes + toolbar icon
  buttons show a visible keyboard-focus ring.
- The sidebar's boot skeleton no longer lingers below the tree once it has loaded.
- A hardcoded French word no longer leaks into the English history panel, and the
  remotes "N files copied" success message no longer paints into the red error banner.

### Security
- Shared `.html` documents are served **sandboxed** (opaque origin, `sandbox
  allow-scripts`): a shared deck's own JavaScript still runs, but can no longer read a
  logged-in visitor's session — the same isolation the in-app viewer already applies.
- Document paths are escaped at every viewer sink and rejected at creation when they
  contain HTML-injection characters (stored-XSS hardening); a role-less identity now
  defaults to `viewer`, never `admin`; internal errors no longer leak `str(e)` /
  filesystem paths to API clients.
- Concurrent SSE streams are capped (thread-exhaustion DoS); the on-disk JSON store
  takes a cross-process advisory lock around every read-modify-write (no more lost
  updates between the CLI and a running server); 2FA recovery codes gain entropy.
