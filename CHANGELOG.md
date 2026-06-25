# Changelog

All notable, user-facing changes are listed here; the full commit-level history
lives on the [GitHub releases](https://github.com/Anakior/atlas-mind/releases)
page (`gh release create vX.Y.Z --generate-notes` builds those from commits). The
format loosely follows [Keep a Changelog](https://keepachangelog.com/) — only
highlights, not every commit — and versioning tracks the PyPI package.

## [Unreleased]

### Added
- Opt-in `[site]` config (`url` / `description` / `og_image`): the build emits a
  `<meta name="description">`, a canonical link and an Open Graph / Twitter card
  when a public URL is set — so a self-hosted mind shares cleanly.
- Offline builds embed an activity-layer snapshot (journal, obsolescence and
  contradiction candidates), so a static export shows the same home the server
  serves live instead of an empty one.

### Changed
- Errors now surface as a styled in-app popup instead of the native `alert()`;
  in an offline build every server-backed action shows a single localized
  "feature disabled offline" notice.

### Fixed
- Git output is decoded as UTF-8 on every platform — accented author names in the
  activity feed and the `→` in move subjects no longer mojibake on Windows.
