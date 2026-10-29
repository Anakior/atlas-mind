# Changelog

All notable, user-facing changes are listed here; the full commit-level history
lives on the [GitHub releases](https://github.com/Anakior/atlas-mind/releases)
page (`gh release create vX.Y.Z --generate-notes` builds those from commits). The
format loosely follows [Keep a Changelog](https://keepachangelog.com/) — only
highlights, not every commit — and versioning tracks the PyPI package.

## [Unreleased]

## [1.10.0] - 2026-10-29

### Added
- **Undo part of a run.** `undo_run` takes `from`, one of the run's commits: what came before it
  stays, and that commit and everything after it are undone. It also takes `paths`, to undo only
  those docs (a moved doc counts under either of its paths). The undo is still one commit, all or
  nothing. `agent_runs` with `run` lists that run's commits and the docs each one changed, to choose
  where to cut.

### Changed
- **Everyone's runs.** `agent_runs` now groups anyone's commits, not only those marked as an AI's.
  An agent that commits from a clone without the `X-Atlas-Author` trailer now shows up, and can be
  undone, as a run of the person it works for. A run written by an AI still names it in `ai`; a
  human's run has none.
- **Who may undo a run.** Besides the person it was for, anyone with the rights each of its changes
  would take by hand: edit for an edited doc, owner to remove, bring back or move one. An admin who
  can only read a doc in someone's private space can no longer undo changes to it, and a token that
  writes the commons can now undo a run there.

## [1.9.3] - 2026-10-28

### Fixed
- `then_and_now` on a topic no doc mentions walked and diffed the whole mind's history: 20 to 30 s
  on a 3,500-commit mind, long enough for the client to give up and for the calls behind it to
  wait. It now answers at once with nothing to compare.
- Asked whether they had changed their mind, Claude on the web rebuilt the answer from searches
  instead of opening the view: with many connectors, a host looks tools up by keyword, and those
  words find `search_docs` first. The server instructions now name the tools that answer with a
  view (`resume_session`, `mind_weather`, `then_and_now` then `show_shift`) and the questions
  they answer. A French "did I change my mind" eval question went from no view in 2 runs to the
  view in 2.

## [1.9.2] - 2026-10-28

### Fixed
- Asked what you thought of something without a date, `then_and_now` compared with 90 days ago,
  which misses a change of mind made last week as surely as one made last year. Without `at` it now
  returns the days the topic moved, for Claude to pick the one the question means and compare
  with it; its description covers these undated questions (Sonnet goes through to the view 2 runs
  in 2 on a new eval question; Haiku, 1 in 3).
- A doc flagged as still saying the old position must now name the claim it repeats (`echoes`: a
  reversed, refined or dropped one), and the view shows that claim under it, "as then: …". An old
  doc that happens to agree with today is no longer flagged for its age.
- `then_and_now` walks the history once instead of three times, and keeps its passages within a
  budget, the docs past it named rather than quoted: on a 3,500-commit mind, from 8 s and 20,000
  characters down to 6 s and 11,000. Paths with accents are read as they are (git escaped them).

## [1.9.1] - 2026-10-28

### Fixed
- Asked what you thought of something on a past date, Claude could stop after `then_and_now` and
  write the comparison out instead of showing the view. `then_and_now` now leads its result with
  the next step, and both descriptions say that `show_shift` is the answer the user sees. On a new
  eval question, the call through to `show_shift` went from 1 run in 3 to 3 in 3 (Sonnet, Haiku).

## [1.9.0] - 2026-10-28

What you thought then, beside what you think now.

### Added
- **`then_and_now`** and **`show_shift`**, the 33rd and 34th MCP tools. Ask what you thought of
  something in June: `then_and_now` reads the mind as it was on that date and as it is, and
  returns each doc's passages on the topic on both sides (docs since deleted or moved included,
  an unchanged passage said once) and the days the topic moved. The model pairs the claims,
  then shows them with `show_shift`, which checks every quote word for word against the version
  it cites (ellipses allowed, Markdown marks ignored) and dates it by the commit that wrote it:
  a claim the mind never made is rejected, never shown. Docs that still state the old position
  come back as `lagging`.
- **The third MCP App: then and now.** Each claim as it was and as it is, side by side, badged
  reversed, refined, held, dropped or new; the days the topic moved on a line, one click to
  compare with another; the docs still saying the old, to update with Claude; and **Why did I
  think that then?**, which asks Claude to rebuild your reasoning from what the mind said on
  that date only.

### Fixed
- The weather view on a phone: the layer tabs stay on one line (scrolling if they must), the
  late reports put their button under the text instead of squeezing it, and the closing button of
  both views takes its own line. Folders and subfolders now share the ranking's columns, so every
  bar starts and every number ends at the same place, whatever its width.

## [1.8.1] - 2026-10-28

### Changed
- The weather's review deck says what each verdict does: **Still true** (nothing to change: it
  leaves the fog), **Needs an update** (set aside, to update with Claude), **To the trash**
  (deleted, still recoverable), and **Later**, set apart. The doc reads as a document (headings,
  paragraphs, lists, tables row by row) with a **Read it all**, its last edit is dated in the
  reader's language, and the deck no longer nests a box in a box.

## [1.8.0] - 2026-10-28

The weekly review becomes the mind's weather: where the mind is being forgotten, a deck to clear it, and the reports gone missing.

### Added
- **Confirmations: `confirm_doc`**, a 31st MCP tool. A reader who reviewed a doc records that it
  still holds, or that it is outdated. Bound to the text reviewed (an edit clears it), kept in a
  git-tracked `.attestations.json` like the contradiction verdicts, attributed to the AI that
  calls it or, called from an app view, to the user.
- **`mind_weather`**, a 32nd MCP tool, which the `weekly-review` prompt now starts with: the
  mind folder by folder (a top folder and its subfolders), with its activity over the last weeks,
  its fog (the docs nobody has looked at for three months), its contradictions worth settling
  and the AI's share of its commits; plus the docs flagged outdated and the **periodic reports
  gone missing**. Those are read from the period in their names (`bilan-juin-2026`, `q3-2025`,
  `2026-04-notes`), since a mind imported or reorganised in batches has no telling git dates:
  a monthly series that stopped in June shows July, August and September as missed, and a
  series silent for half a year (a year for quarters) counts as over, not late.
- **The second MCP App: the weather.** In a host that renders apps, `mind_weather` ranks the
  folders by fog, activity, storms or the AI's share, a bar and a number each, the quiet ones
  folded away. Open a folder to see its subfolders ranked the same way, and clear their fog one
  doc at a time, keys 1 2 3: still true,
  outdated (recorded through `confirm_doc`, in your name), or let it go (to the trash); the
  model is told every verdict. The missed reports each have a button that hands them to Claude
  to prepare, as do the outdated docs and a folder's contradictions, and Claude writes the
  week's bulletin from what you settled.

### Changed
- **`stale` counts a confirmation as a look**: a doc confirmed to hold leaves the audit like an
  edited one, for twice as long each time it is confirmed again (6 months, then 1, 2, at most 4
  years at the default threshold). Docs flagged outdated come apart, in a new `outdated` list:
  they wait for an edit, not a review. `stale` also takes a `prefix`, to review one folder.
- The MCP tool descriptions are 28% shorter (about 2k tokens fewer on every request of a client
  that loads all the tools), the same facts without the repetitions. The evals hold: Sonnet
  25/25 with 8% fewer prompt tokens per question, Haiku 24/25 with 13% fewer (its one miss is a
  question it already misses one run in three).

### Fixed
- Two saves committed within the same second (a quick follow-up, or a fast machine) could be
  listed in the wrong order, and the later one not flagged `newer`: git's own order now breaks
  the tie.

## [1.7.3] - 2026-10-28

### Fixed
- In the resume view's timeline, a step whose title fits on one line sank below the line.
- Asked to show their saves, models answered from a search instead of the list:
  `resume_session` now says first that it lists the saves, then how it resumes one.

## [1.7.2] - 2026-10-28

The resume view becomes a way in: your recent work, one line each, then the save you pick.

### Changed
- `resume_session` without arguments lists the recent **pieces of work**, one line each: the
  latest save of a chain, with how many saves it took (`steps`), its project and machine, 20 of
  them instead of 10 saves of which most were steps of the same work. The tool description
  tells the model to call it that way when you want to see or pick among your saves.
- In the view, that list has a filter (title, state, project, machine), and a save opened from
  it has a link back to the list.

### Fixed
- The resume view's button did nothing: it sent its message as one content block where the
  hosts expect a list of them. It now says when the host took the message (or why not), and
  reads "Continue here with these points": it resumes in this conversation, while the command
  above it resumes on the machine.

## [1.7.1] - 2026-10-27

### Fixed
- The resume view stayed invisible in Claude: its handshake named itself `clientInfo`, as the
  spec's prose has it, where the hosts validate `appInfo` against the SDK's schema, so the
  host never answered and kept the frame closed. A failed handshake now shows its error
  instead of nothing, and the server declares the MCP Apps extension
  (`io.modelcontextprotocol/ui`) in its capabilities, as the extension negotiation expects.

## [1.7.0] - 2026-10-27

The first MCP App: in Claude on the web or desktop, picking up a session is a view you act on.

### Added
- **The first MCP App: a resume view.** In a host that renders MCP Apps (Claude on the web
  and desktop, ChatGPT, VS Code with Copilot…), `resume_session` shows inline in the
  conversation: the open points to tick for the session (the model is told which ones you
  keep), the docs that moved since with their diffs to unfold, the chain of saves and a
  banner when a newer one continues the work (one click opens it, in place), the resume
  command to copy, and a button that resumes with the points you kept. A call without
  arguments lists the recent saves to pick from. Hosts without apps, Claude Code among them,
  keep the text answer. Served as `ui://atlas/resume`: one self-contained page with its
  labels in the mind's language, loading nothing from anywhere; mind text is never parsed
  as HTML in it.

## [1.6.1] - 2026-10-27

### Fixed
- `resume_session` on a broad topic named an older step of the work: the best-scoring save
  wins, but the saves written after it now come first in `other_matches`, flagged `newer`,
  and the `resume` prompt resumes the newer one when it continues the same work. Saves are
  ranked among themselves, so a save far down the whole mind's results is no longer missed.
- Open points listed under an item ending with a colon ("Open at closure:") are now read:
  its sub-items are the points, grouped under it.

## [1.6.0] - 2026-10-27

Pick up a saved work session where it stopped, from any assistant: `/atlas:resume <topic>`.

### Added
- **`resume_session`**, a 30th MCP tool, and a **`resume`** prompt (`/atlas:resume <topic>` in
  Claude Code): pick up a saved work session where it stopped. A save is any doc with a "How to
  resume" section (the `ai-sessions/` template, or a mind's own model). In one call: the resume
  command and machine, the open points with the date each has been carried since and the docs
  they cite that moved after the save, the points closed along the way, what changed in the
  mind since (the docs it links to first, commits by humans and by AI, contradictions among
  them), and the other saves its links tie it to. Without arguments it lists the recent saves;
  with a topic it finds the save and names the other matches. The demo mind ships a save to
  try it on, and the evals ask about it: each linked doc comes with its diff excerpt because
  the models kept calling doc_diff for it (Sonnet went from 6 calls to 3 on that question).

### Changed
- The README explains how to connect Claude Code under a short name (`claude mcp add
  --transport http --scope user atlas …`), so the prompts read `/atlas:…`, and to turn off
  the duplicate claude.ai connector.

## [1.5.0] - 2026-10-27

Images and JSON open in the viewer, a model now sits an exam on the MCP surface (and
already caught a friction), and the server keeps less in memory.

### Added
- **Images and JSON open in the viewer.** An image (PNG, JPEG, GIF, WebP, AVIF, SVG…) is
  fitted to the pane over a checkerboard, its size in the banner; a click shows it at
  full size. A `.json` is pretty-printed and highlighted under a one-line summary (an
  array's length, an object's keys, the size); an invalid one is shown as is, under
  where it breaks. Both used to open raw in a new tab. A link to any viewable file
  (`#path`) now opens it, not only a Markdown doc.
- **Tool-use evals** (`evals/run.py`): 24 real questions asked to a model through a real
  MCP client on the demo mind, graded on the answer, the tools used and the mind's state
  after, with calls and tokens per question. One of them plants a prompt injection in a
  remote mirror.

### Changed
- `grep_docs`: a literal pattern that matches nothing but reads like a regex (`a|b`) now
  says to pass `regex=true`. The evals caught a model searching `Ctrl|Cmd|shortcut`
  literally and concluding the mind didn't document the shortcut; with the hint it
  retries as a regex and finds it.
- The search cache holds 45 % less memory (95 → 52 MB on a mind of 350 docs): a doc's
  text is no longer kept, only re-read for the few hits a search returns, and a word is
  stored once for all docs. Same results.

### Security
- A mind's `.html`, `.svg` or `.xml` opened on its own (the viewer's "open full screen",
  a direct link) is now sandboxed, as a shared `.html` already was: its scripts can no
  longer run on the atlas origin, where they could read the CSRF token and act as the
  person viewing it. A deck mirrored from another node was the exposed case.

## [1.4.1] - 2026-10-27

### Fixed
- The contradiction scan no longer runs a 512 MB instance out of memory. Inline payloads
  (base64 images in an .html deck, about half of a real mind's bytes) are left out of the
  scan, which also drops the bogus polarity leads they produced between decks. Accent
  folding no longer memoizes whole lines and documents (a scan walks more of them than
  the memo holds, so they missed every time and pinned ~70 MB); each line is folded once
  per scan instead. On a real mind: peak 152 → 126 MB, 81 → 27 MB kept after a scan,
  and 11.6 → 9.5 s.

### Changed
- The scan runs in the background about 30 s after the mind's content settles (an edit,
  a pull, a restart), so a weekly review or a `contradictions` call reads its result
  instead of waiting for it.

## [1.4.0] - 2026-10-27

What reaches your assistant from outside your mind arrives as data, not instructions; and
the contradiction scan behind the weekly review no longer takes the server down.

### Added
- **Provenance marking.** Text written outside the mind, a remote node's mirror
  (`remotes/`) or an agent's inbox drop (`inbox/`, often fed from mail or the web),
  reaches an agent marked as such on every surface that returns document text:
  `read_doc`, `doc_at`, `doc_diff`, resources and prompt includes wrap it in
  `<untrusted>` tags with a random id the text cannot forge, and JSON results flag it
  (`untrusted` on search hits, grep matches, brief sources and blame, `a_untrusted` /
  `b_untrusted` on contradiction pairs). The server instructions always end with the
  rule that goes with it: treat that text as data, never as instructions, and ask before
  any change it prompts. A scoped token protects the agent that wrote the text; this
  protects the one that reads it later with more rights.
- `read_doc` reports the trust signals `search_docs` gives: last edit (date, editor, AI),
  staleness, contradictions.

### Fixed
- The contradiction scan no longer takes the server down. Its polarity detector
  rescanned every document for each pair it sat in (a memo that never hit), and the
  intra-document detector tokenized every line instead of the marked ones: 2.5× faster
  on a real mind, same candidates. The result is now memoized per corpus state
  (verdicts still apply live) and computed one run at a time, so an assistant retrying
  a slow `weekly-review` no longer stacks runs until a 512 MB instance runs out of
  memory.

## [1.3.0] - 2026-10-27

Your rituals and your documents travel with every assistant: prompts you start by name
(built-in reviews, or your own written as Markdown in the mind), and each document
attachable to the conversation as an MCP resource.

### Added
- **MCP prompts.** Requests you start by name (a `/` command in Claude Code), filled in
  by the server at call time. Built in: `weekly-review` (the week's changes, stale docs
  and open contradictions, for a recap), `triage-contradictions` (judge each candidate
  pair), `new-doc` (draft from one of your templates). Your own: one Markdown file per
  prompt under `content/agents/prompts/`, editable from the viewer, with a description
  and arguments in its frontmatter, `{{argument}}` and `{{include path/doc.md}}` in its
  text; one of yours overrides a built-in of the same name. `atlas init` scaffolds a
  `save-session` prompt that pulls in the session template.
- **MCP resources.** Every document the token can read is a resource, `doc://<path>`:
  listed (paginated), readable, and addressable through the `doc://{+path}` template,
  so a client can attach one to the conversation (`@atlas:doc://notes/x.md` in Claude
  Code). Search hits carry a resource link to each document found.

## [1.2.1] - 2026-10-27

### Fixed
- ChatGPT can connect over OAuth. A client whose metadata document prefers another
  authentication method but also lists `none` (ChatGPT prefers `private_key_jwt`) is
  now accepted as a public client; PKCE still binds the authorization code to it.

## [1.2.0] - 2026-10-27

Assistants connect over OAuth 2.1: point one at `https://<your-atlas>/mcp`, sign in, and
choose what it may do; no secret in a URL anymore. Settings says how, and no longer
pieces itself together on screen.

### Added
- **OAuth 2.1 for MCP.** Point an assistant at `https://<your-atlas>/mcp`: it signs you
  in to your Atlas (2FA included), shows a consent screen where you can narrow what it
  gets (read / inbox / write), and connects without a token in any URL. The grant shows
  up in Settings → Tokens (marked OAuth) and revokes like a token. Access tokens last an
  hour and renew silently through a rotating refresh token (30 days unused → asked
  again); a replayed refresh token revokes the whole grant. PKCE S256, resource-bound
  tokens (`iss` in the authorization response), 401 / 403 `insufficient_scope`
  challenges for step-up.
- Clients register themselves (DCR) or identify by the HTTPS URL of a metadata document
  (CIMD), fetched on connect with an SSRF guard (public addresses only, pinned
  connection, no redirect, size and time caps). `[oauth] client_metadata_fetch = false`
  in `atlas.toml` turns that fetch off.
- `/mcp` also takes any API token as `Authorization: Bearer`, so no client has to put a
  token in the URL. `/mcp/<token>` keeps working.
- Settings → Tokens opens on **Connect an assistant**: the `/mcp` address to paste, and
  what will happen; a hand-made token is offered as the fallback for clients without
  OAuth.

### Fixed
- The Settings dialog no longer pieces itself together: a tab is shown once everything
  it needs has loaded (Nodes waits for both of its lists), the previous one staying up
  meanwhile, and only a slow load shows a placeholder. The dialog still fits its
  content, gliding once to the new height instead of jumping.

### Changed
- An OAuth access token is refused on the REST API and in an `/mcp/<token>` URL: its
  audience is the MCP endpoint, as a Bearer header.
- The login page honours a local `next` path (and only a local one) after sign-in.
- Settings → Tokens revokes by identity email, so a token and an OAuth grant sharing a
  name can't be confused.

## [1.1.0] - 2026-10-27

Atlas speaks the stateless MCP `2026-07-28` revision and becomes a place agents can
work in safely: they find the right passage and know how far to trust it, check every
write before and after making it, pick up where they left off, and a whole session of
theirs can be undone in one go.

### Added
- **MCP `2026-07-28`.** The endpoint speaks the stateless revision (version in each
  request's `_meta`, `server/discover`, caching hints, header validation) alongside
  the earlier `initialize`-based ones, on the same URL.
- **Your `AGENTS.md` becomes the server instructions.** Every MCP client receives it
  when it connects, so your conventions follow you into claude.ai, ChatGPT or any
  other assistant (a built-in primer stands in when the mind has none).
- **Tool annotations.** Read-only tools say so (clients can run them without asking);
  `edit_doc`, `delete_doc` and `doc_revert` are flagged destructive.
- **Search an agent can trust.** `search_docs` ranks with BM25 and each hit points at its
  line and heading section, with what to weigh it by: last edit date and editor, the AI
  behind it if any, `stale`, and `contested_with` (docs it was judged to contradict).
- **`grep_docs`**, the 25th tool: exact matching lines (string or regex) across the mind.
- **Partial reads.** `read_doc` takes a line range or a section heading, and reports the
  doc's `version`.
- **Safer, verifiable edits.** `edit_doc` returns the diff and the new version, takes
  `dry_run`, and refuses a `base_version` that is no longer current instead of
  overwriting a concurrent change. `move_doc` takes `dry_run` too.
- **Errors that say what to do.** A wrong path suggests the likely ones; an `old_string`
  that doesn't match quotes the closest passage, an ambiguous one lists its lines.
- **`brief`**: a context pack on a topic in one call, the best section of each relevant
  doc within a token budget, with trust signals and the docs linked around them.
- **`changes_since`**: what changed, net per document, since a cursor the agent keeps
  between sessions.
- **Agent runs, undone in one go.** `agent_runs` groups an agent's consecutive commits
  (same AI, token and person, no pause over 30 minutes); `undo_run` reverts a whole run
  as one commit, all or nothing, putting moved and deleted docs back with their access
  rights. Only the person the agent acted for, or an admin, may undo it. MCP writes now
  name their token in an `X-Atlas-Token` trailer.
- **Scoped tokens.** A token can be limited to `read`, `inbox` and/or `write`, from
  Settings → Tokens or `atlas token create --scope read,inbox`. A scoped token only sees
  the MCP tools it may call, and the REST API answers 403 beyond its scopes.

### Changed
- MCP tools return compact JSON with a matching `structuredContent` (and an
  `outputSchema`); an empty result is an empty list, no longer a sentence. Search
  scores are BM25 floats in the viewer and the REST API too.
- `changelog` and `search_history` now show soft-deleted docs as deletions (and a
  restore as an addition) instead of leaving them out.
- The MCP URL shown when a token is created uses `http://` on localhost.
- `initialize` answers with a revision Atlas actually serves instead of echoing any
  value, and `serverInfo` reports the real engine version.
- The MCP endpoint no longer holds a GET event stream open (it never carried a
  message): GET now answers 405, and notifications answer 202 as the spec requires.

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
