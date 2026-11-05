# Changelog

All notable, user-facing changes are listed here; the full commit-level history
lives on the [GitHub releases](https://github.com/Anakior/atlas-mind/releases)
page (`gh release create vX.Y.Z --generate-notes` builds those from commits). The
format loosely follows [Keep a Changelog](https://keepachangelog.com/) — only
highlights, not every commit — and versioning tracks the PyPI package.

## [Unreleased]

## [2.4.2] - 2026-11-05

Faster: then and now, and the first search after a start on a mind with PDFs. No MCP tool
changes: an Atlas on 2.2.0 or later gets this one from Settings › About.

### Fixed
- **Then and now answers several times faster.** Each quote was dated by a git blame of its own, up
  to a second on a long-lived note, and each move of a cited note cost one more walk of the history.
  The quotes are now dated from the one walk the answer already makes, which also follows a note
  moved to another folder. On a mind of 3,500 commits, showing a comparison went from 12 seconds to 3.
- **A PDF or an office file is read once.** Search and `read_doc` take a file's text out with the
  standard library, which for a PDF meant going word by word through everything drawn on its pages,
  boxes, rules and colours included. That drawing is now passed over in one go, twice as fast, and
  the text is kept in the store (`.atlas/text-cache/`) under the file's content hash: a restart or a
  deploy reads it back instead of taking the files apart again. On a mind with a hundred PDFs, the
  first search after a start went from 20 seconds to 2. The store keeps only the texts of the files
  still in the mind, and none of it goes into a backup.

## [2.4.1] - 2026-11-04

Two fixes to the then-and-now view. No MCP tool changes: an Atlas on 2.2.0 or later gets this one
from Settings › About.

### Fixed
- **Then and now: the days on the timeline no longer run into each other.** When a topic moved on
  many close days, their dates overlapped the one compared with ("29 Aug" ran into "Then · Sep 4").
  A date that would touch another is now hidden, its dot kept, with the date in its tooltip; the
  date compared and today always show. On a phone, the dates that fit now show instead of none.
- **Then and now follows a note that moved.** A note moved to another folder lost its history from
  before the move: the day it moved showed as a day the topic moved, and a doc still saying the old
  read as "untouched since" that day. The move is now seen as a move, and the note's history goes on
  from before it, under its older names. It costs a little more time when the notes cited have moved,
  nothing otherwise.

## [2.4.0] - 2026-11-04

Atlas under any sub-path of its address, Settings as a real page, your own password changed and
recovered with recovery codes, the interface language chosen after the install, and one "First
steps" card on the home. No MCP tool changes. An Atlas installed from alwaysdata on 2.2.0 or later
gets this one from Settings › About; to move one under a sub-path, install it again there.

### Added
- **Settings is a page.** It opens in place of the content at the home's width: a hero with the
  sections as tabs, then each section's cards on the home's grid (stacked on a narrow screen). Each
  section has its own address (`#settings/account`, `#settings/ai`…), so Back and a link both work.
  Me becomes Account; any other page — a note, the home — takes its place. It replaces the dialog,
  which had grown too full.
- **The interface language in Settings › Appearance** (an admin's): French or English for the menus
  and pages, for every account; it goes to `atlas.toml` and the page reloads once the viewer is
  rebuilt. Notes stay as written; the default line under the logo follows the language.
- **Atlas under a sub-path of its address**, any depth (`https://example.com/notes`,
  `/tools/atlas`…): `[server] base_path` in `atlas.toml`, or `ATLAS_BASE_PATH`. Atlas takes it off
  what it receives (and works the same when a proxy took it off first) and puts it on every URL it
  makes: the viewer's calls and links, the service worker, the phone app's manifest, cookies,
  redirects, share and file links, `git clone`, the MCP address and the OAuth endpoints. Tested with
  claude.ai: its first guesses for the sign-in metadata sit at the host's root, outside Atlas, and it
  then finds them under the sub-path (`/.well-known/openid-configuration`, answered there too). The
  alwaysdata script passes the chosen sub-path instead of refusing it.
- **First steps on the home**: one card with what makes an Atlas yours, each step checked once done —
  connect an AI (with the address for any other assistant, and ideas to try once it has read the
  Atlas), create recovery codes, keep a copy on GitHub (an admin's). It replaces the AI card and the
  GitHub card, can be closed, and goes away once everything is done.
- **Change your own password** in Settings › Account: the current one (and the 2FA code when on) is
  asked again, a wrong one counts like a failed sign-in, and every other session ends while this
  one stays open. Until now only an admin could reset someone else's.
- **Recovery codes for a forgotten password.** Settings › Account makes them (the current password is
  asked), shows them once, to copy or download; new ones replace the old. On the sign-in page,
  "Forgot your password?" takes one of them and a new password; each code works once, and the
  2FA, when on, is still asked at the next sign-in. Without a code, the admin resets it as before.

### Fixed
- **The Mind keeps each folder's name by its notes.** A region's glow and name were sized by its
  farthest note, so one that drifted off carried the name far from the group; they now follow the
  bulk of the folder, and the names are drawn over the notes, haloed, instead of under them.
- **About asks PyPI for real.** Opening it gets an answer of the last five minutes; it used to keep
  the version seen for a day, so a release out since went unnoticed. A failed lookup falls back to
  the last version seen.
- **Moving a note or a folder no longer reads every note.** The links to rewrite are found through
  the backlinks index, plus the notes written since it was built; with no usable index, every note
  is read as before. On a small shared machine a move went from about ten seconds to about three.

## [2.3.0] - 2026-11-04

Folders you can create, keep empty, move whole and remove; a bin you can empty; any file deleted
like a note; and a nudge on the home to keep a copy on GitHub. Two MCP tool descriptions change
(`delete_doc`, `move_doc`): refresh the connector for your assistant to know it can now delete any
file and move folders. An Atlas installed from the alwaysdata marketplace on 2.2.0 gets this one
from Settings › About.

### Added
- **Folders.** "New" has a **Folder** tab, and each folder of the tree a "+" to create a note or a
  sub-folder inside it. A folder made this way stays even empty (a hidden `.gitkeep` keeps it in
  git), private to a member like a new note until it holds something others may read; an empty one
  goes with the bin beside it.
- **Move a whole folder.** Drag it onto another folder, or onto the tree's empty space for the top
  level. Everything in it moves, its privacy and share links follow, and the `[[links]]` that reach
  its notes by path are rewritten (they used to break). `move_doc` moves a folder too, and a PDF or
  an image, as the viewer already did.
- **Delete for good from the bin.** Each item has Delete beside Restore, and "Empty the trash" takes
  everything this person may restore, after a confirmation. The file leaves the bin and the disk;
  the git history still holds it.
- An empty folder, opened in the tree, shows **"Add a file +"**, which opens New in it. While
  something is dragged over the menu, the "Move into…" hint stays at the top of the tree, naming the
  folder it is about, instead of at the foot of the page. Files from the computer go in through the
  tree only (a folder, or its empty space for the top level): dropped anywhere else, nothing
  happens, where they used to land beside the open note.
- **A moon in the light theme.** The Constellation's sun becomes a pale moon with a darker rim on a
  light page (the sun reads better on a dark one).
- **"Keep a copy of your Atlas on GitHub"** on the home, for an admin whose Atlas has no copy yet:
  it opens Settings › My Atlas, where the steps are. It can be closed, like the AI card.

### Fixed
- **Deleting a PDF, an image or an Office file.** The delete, the bin and the restore took notes
  only (`.md`, `.html`), in the viewer as in `delete_doc`: the viewer offered the delete on a PDF
  and then failed. Any file now goes to the bin and comes back from it.

## [2.2.0] - 2026-11-04

An Atlas installed from the alwaysdata marketplace now updates itself from Settings › About, and
its owner picks the name before "Atlas" and the line under the logo without a terminal. Saving no
longer waits on GitHub, and a GitHub having a bad day no longer raises the "not saved online yet"
banner. The MCP tools are unchanged: no need to refresh the connector. An Atlas on 2.1.x moves to
2.2.0 once by hand (`pip install --upgrade atlas-mind` in its environment, then a restart); from
then on, the Update button does it.

### Added
- **Settings › About.** The running version, how to report a problem (a GitHub issue that opens with
  the version, the mode and the browser filled in), how to support Atlas (GitHub Sponsors), and the
  links to the site, the code and the licence. Every account sees it.
- **Update from Atlas itself.** For an admin, About says whether a newer version is out, with a link
  to what changed. Where Atlas runs from a Python environment it may write to, installed from PyPI
  (the alwaysdata marketplace install), an **Update** button installs it in place, checks that the
  new version starts (otherwise the current one goes back), then restarts Atlas on it; the page
  reloads by itself. A container, a source checkout or a hand install says how to update instead.
  With the automatic check on (`ATLAS_UPDATE_CHECK`, now on for alwaysdata installs), a dot on the
  gear and a line atop Settings say a new version is out. About checks when it opens, even with the
  automatic check off.
- **The name before "Atlas" and the line under the logo, chosen without a terminal.** Settings ›
  Apparence has a field for each: saved on Enter, written into `atlas.toml` (committed like any
  edit), live at once in the menu and on the home. The alwaysdata install form asks for both too
  (optional). A quote or a backslash in either no longer breaks `atlas.toml` at `atlas init`.

### Fixed
- **A slow or failing GitHub no longer slows Atlas down.** Fetching and pushing run outside the
  lock that saves take, so a save never waits on the network. After a save, Atlas pushes right
  away and only pulls when GitHub has moved (before, every save pulled first). A failed push is
  tried again after 15 s, 45 s and 2 min instead of waiting for the next save or the five-minute
  loop, and a rebase that cannot apply is undone instead of leaving the mind mid-rebase.
- **The "not saved online yet" banner waits for a real problem.** A push or pull failing now and
  then (GitHub having a bad day) no longer raises it: it shows once the failure has lasted two
  minutes with changes waiting. A refused commit still shows at once. `/api/sync` and
  `atlas doctor --sync` still report every failure.
- **The alwaysdata script refuses a sub-path.** Atlas serves from the root of its address: an
  install under `name.alwaysdata.net/atlas` now stops at once with a clear message instead of
  installing an Atlas that cannot load.

## [2.1.1] - 2026-11-03

### Fixed
- **The Inbox in a narrow card.** In the home's column, on a phone or in the menu's panel, the
  card now follows its own width. The folder and the tags each get their own row, so the tags wrap
  under one another instead of leaving their label at the end of a line and the "+" alone below.
  The four actions share one row, two by two when it gets narrower, without their key hints (the
  keys still work). The time stays inside the card, under the badges when they take the line, and
  the queue drops its times to keep room for the titles. The tags label is translated
  ("étiquettes"). The MCP tools are unchanged.

## [2.1.0] - 2026-11-03

Atlas for people who don't code. An Atlas installs from the alwaysdata marketplace without a
terminal and starts on its own disk, GitHub becoming an optional copy. Files go in by drag and
drop, your AI reads PDF and Office files, and the settings are sorted into tabs. One MCP change:
`read_doc` now reads PDF, Office, .txt and .csv files. Its description says so, so refresh the
connector for your assistant to know; the other tools are unchanged.

### Added
- **Install from the alwaysdata marketplace.** `deploy/alwaysdata/atlas.sh` asks for a language,
  an email and a password, then installs the engine, creates the mind and its first admin, and
  starts the site: about a minute on the free plan, no card, no terminal. The public listing
  awaits alwaysdata's review.
- **Start without GitHub.** A cloud instance without `GITHUB_REPO_URL` creates its mind on its own
  disk (`ATLAS_LANG` picks the language) with a first commit; `atlas init` makes that commit too. A
  folder that holds files but no repository stops the boot instead of being overwritten.
- **The first admin without ssh.** The server keeps only the hash of a setup code
  (`ATLAS_SETUP_CODE_SHA256`), and the link `/setup#code=…` fills it in; `atlas setup-code` makes
  one. The Fly wizard no longer needs GitHub, `fly ssh` or an admin password, and prints the link
  at the end.
- **Copies of your Atlas**, in Settings › My Atlas:
  - **On GitHub**, in four steps and without a token: create an empty private repository, name
    it, paste the instance's deploy key, connect. Every refusal from git comes back as its cause
    (key missing, write access not ticked, repository not found or not empty).
  - **On your computer**: `git clone` from the instance itself (the new `/git` route), with a
    password per computer, then `atlas sync` both ways, `--every N` to keep at it. A conflict
    keeps the online version and puts yours beside it as "note (my version).md". A push that
    touches anything but `content/` and `AGENTS.md` is refused whole.
  - **Restore**: from a "Download my notes" zip, from the GitHub repository ("Take this repository
    back", the way back after a lost instance), or from a full backup.
- **Full backup.** The notes, their history and the registry under `.atlas/`: account and 2FA, AI
  access, rights, shares, tasks, settings, GitHub key. The password, and the 2FA code if it is on,
  is asked again. Restoring it puts the registry back as it was. For the owner of a single-account
  Atlas; `atlas backup` stays for a shared one.
- **Leave with your notes.** `GET /api/export` (in the account card) and `atlas export`: a zip of
  the files you can read, plus the history as a `git bundle` when the Atlas is wholly yours.
- **Drop files in.** Onto the window or a folder of the tree, by pasting an image into the editor,
  or with "Add files…" in New document; `atlas import` applies the same rules. Notes, Office, PDF,
  images, audio and video only (no HTML or SVG), 25 MB a file, a .zip unpacked into its own folder,
  never an overwrite ("name (2).ext"). A file dropped beside a note takes that note's privacy. The
  Journal shows dropped files.
- **Your AI reads PDF and Office files.** `read_doc` reads .docx, .xlsx, .pptx and OpenDocument
  files, a PDF page by page (section "Page 3"), and .txt, .csv and .json; search finds their text.
  Standard library only, no new dependency. A file with no text in it (a scan, an image, a
  recording) comes back as its path on disk locally, or online as a signed link valid for an hour,
  with a small image inline. Known limits: a page in columns reads in drawing order, and Excel
  dates come out as numbers.
- **Connect your AI.** A home card and Settings › AI assistants carry an "Add to Claude" button
  (Claude's own pre-filled link), the address for other assistants, and then "Claude read your
  Atlas" with three first requests to try. Each access shows when it was last used. On your own
  computer, the snippets for Claude Code and Claude Desktop.
- **Sync health in sight.** A banner when changes have not reached GitHub, with Retry, a warning at
  the top of `list_tree` and `brief` so the AI says it too, `/api/sync` and `atlas doctor --sync`.
- **On a phone.** An installable app (icons, share target into a quick capture whose text never
  reaches the server), a QR code of the address in Settings › My Atlas › On your phone, and an
  editor with Write and Preview.
- **Send as a file.** Share offers the note as a standalone HTML page, its images, libraries and
  fonts inside (`GET /api/export/page`); on 127.0.0.1, where a link would only open on that
  computer, it comes first.
- **A Trash in the viewer.** Deleting from the viewer goes through the same trash as `delete_doc`,
  and a doc comes back in one click.
- **Drag to file.** A note or a file of the tree dropped on a folder moves there; a note's
  `[[links]]` follow.

### Changed
- **Titles instead of file names.** The front-matter `title:`, else the first heading, else a
  page's `<title>`: in the tree (sorted by title, the file name as tooltip), the breadcrumb, search,
  the palette, the home, the activity, `list_tree` and a shared page.
- **A new note in two moves.** ⊕, type the title, Enter: the editor opens. The open note's folder
  comes first, the path to be created shows under the title, and templates are cards.
- **Settings in tabs.** Me, My Atlas, AI assistants, Hive (published nodes and subscriptions),
  Shares (only while links exist), Team (groups from two accounts on) and Appearance (admins).
  Settings now open on a local Atlas too.
- **Share links are stored hashed.** A link shows once, when it is made. Links made before keep
  working but can no longer be copied again.
- **Saving never overwrites the AI.** If Claude changed the note while you edited it, you get
  "Keep both" instead of a silent overwrite; a draft is kept in the browser, and leaving asks first.
- **Plain words.** Developer jargon is gone from the French interface, and the first note and the
  AI's instructions (`AGENTS.md`) are rewritten for people who don't code, in both languages.
- **Fly keeps the mind on its volume** (`/data/kb`); a clone left in `/app/repo` moves there at boot.
- **Local guards.** A local instance only answers its loopback names (else 421) and applies the
  JSON and same-origin checks too; `[server] public_url` / `ATLAS_PUBLIC_URL` gives the address
  behind a proxy or tunnel.

### Fixed
- The name saved in Settings shows in the account card without a reload.
- A notes folder named `git` at the top level loads again.
- The meeting and contact templates put each field on its own line.

## [2.0.3] - 2026-11-02

### Fixed
- **White folder names on a light menu, in the installed app.** The first time the app opened
  after an update, the service worker still answered with the previous release's stylesheet,
  and a cache could keep it there. The new page then ran on the old classes: in 1.x the menu's
  text colours were fixed for a dark page, so in the light theme the folder tree showed white
  names on a light background. The stylesheet's address now carries the version, so a new page
  always loads the stylesheet that goes with it. The MCP tools are unchanged.

## [2.0.2] - 2026-11-02

### Fixed
- **Your avatar lost its branches and its glow.** The same face drawn twice on a page gave both
  copies the same gradient and filter names, so each used the first copy's. Since 2.0 the first one
  is the folded menu's button, hidden while the menu is open, and a hidden copy draws none of them:
  in the menu, the Journal and Settings, your avatar showed bare dots. Each drawing now names its
  own. The MCP tools are unchanged.

## [2.0.1] - 2026-11-02

### Fixed
- **The Constellation's legend on a phone.** Under the sky, its labels sat in a narrow column, one
  per line and off to the left, instead of wrapping across the card. The set width that keeps the
  card still while the activity loads now applies only when the legend stands beside the sky. The
  MCP tools are unchanged.

## [2.0.0] - 2026-11-02

A new face for the viewer: a new home and a new menu, a light theme beside the dark one, and an
accent colour of its own for each instance. The Mind now settles instead of shaking, and the tree,
the inbox and the stale list no longer read the whole git history again on every request. The MCP
tools are unchanged: their definitions are the same, no connector needs refreshing.

### Added
- **A new home.** At the top, the logo, the tagline, three figures and the week at a glance: a bar
  per day with the AI's share in its own colour, the docs touched, the new ones, those written by an
  AI, and the busiest folder. Then the activity, all at once instead of behind tabs, with the "AI
  only" switch: the Journal, filling its card down to "See all", beside the Constellation and the
  recent docs; then the Inbox, the Health and the folders with the longest docs; then the tags and
  the shortcuts. The bar that only said "/" is gone from the home on a computer.
- **A light theme.** Three small buttons at the foot of the menu switch between light, dark and
  auto, which follows the system. The choice is kept per browser and applied before the first
  paint. The Mind stays a night sky in both. An extension that paints with fixed colours can add
  its own light rules under `:root[data-theme="light"]`.
- **Each instance its own accent.** Settings › Appearance (admins) picks the accent colour, among a
  few or any other, for every account of the instance, so two Atlas instances tell apart at a
  glance; on the light page it darkens until it reads. The same tab hides the site prefix (the
  name written before "Atlas") and the tagline under the logo. It is stored in the registry (`settings.json`) and served by
  `GET /api/appearance`, set by `POST /api/appearance`.
- **A Journal entry opens its doc.** Its title is now a link to the doc, and a button shown on hover
  does the same, next to the undo one; the rest of the row still opens the doc's history. A doc
  since deleted or moved keeps only its history. The undo button now reads "Undo this change", and
  both buttons show the viewer's own tooltips like the rest of the page.

### Changed
- **A new menu.** Home, Inbox (with its count), Journal, The Mind, Tasks and Recent on top. Inbox,
  Journal and Recent open a panel over the page, the way Tasks does, so the inbox, the latest
  changes or the docs edited last are a click away from any doc. The pinned and shared docs and the
  folders follow, running under the glass card at the foot that holds the account, the version and
  the theme switch. The logo and the prefix are unchanged. Folded (Ctrl+B), the menu stays as a
  column of icons instead of disappearing, each with its label as a tooltip: search opens the
  palette, a Folders entry opens the folder tree in a panel, the avatar opens the account card. Only
  its width moves as it folds, the content showing again once it is in place. On a phone it is still
  a drawer.
- **Loading keeps its shape.** Each part of the home, and the history panel, shows a quiet
  placeholder the size of what is coming instead of an empty frame, and the loading shimmer is
  neutral instead of gold.
- **The floating to-do looks like the home's cards**: categories as a segmented control, the accent
  on the add button, the checkboxes and the phone bubble. Every option it had is still there.
- **The viewer's palette is a set of CSS variables.** The surfaces (`--navy-900` to `--navy-500`),
  the text (`--ink-100` to `--ink-500`) and the accent live in `styles/00-tokens.css`, and both the
  Tailwind palette classes and the engine's stylesheets read them. Nothing changes on screen. An
  extension now re-tints the viewer by redefining a variable instead of overriding classes with
  `!important` (see `examples/extensions/custom-theme`). The light theme and the instance accent
  are built on them.

### Fixed
- **The tree, the inbox and the stale list answer faster.** Each doc's last commit date came from a
  full `git log` run again on every request (seconds on a mind with a long history); it is now read
  again only when HEAD moves, after a commit or a pull.
- **The Mind opens already in place, and stays still.** A folder's docs all started in the same few
  pixels, so a big folder burst apart, then kept shaking: two docs pressed together pushed each
  other further than the gap between them on every step, for as long as the layout ran. They now
  start spread on a spiral sized to the folder, the push between two close docs eases off, the steps
  shrink as the layout settles, its busiest first moments run before it is shown, and the view
  frames the whole graph instead of a fixed ring that a big folder overflowed.

## [1.12.1] - 2026-11-02

### Fixed
- **An agent can see what waits in the inbox.** The inbox is kept out of search and the graph, and
  `list_tree` left it out too, so an agent asked to go through the inbox found nothing there and
  answered that it was empty. `list_tree` now ends with an `inbox` folder holding the items the
  caller may read and has not trashed or snoozed: a person's lane stays theirs. Its description
  says so, which changes the tool definition.
- The folder list under the inbox's "File under" field could open a few pixels off its field. The
  item card slides in when it appears, and the list was placed once, so opening it during that
  slide left it where the field was at that moment. The list now follows its field while it is
  open. The end-to-end test that checked it failed about one run in four for that reason; it now
  measures once the card has landed, and a new case moves the card to check the list follows.

### Evals
- The inbox question no longer gives the item's path: "go through what is waiting in my inbox".

## [1.12.0] - 2026-11-02

### Added
- **Undo a run from the Activity journal.** Each entry has an undo button, which opens, under the
  entry, the run that change belongs to: what one writer (an AI or a person) did in one go. It says
  what undoing does to each doc. A doc the run created is removed, an edited one goes back to
  before the run, a deleted one comes back and a moved one returns to its place. Untick what you
  keep, and the rest is undone in one commit in your name. A doc you could not change by hand is
  shown locked. Until now a run could only be undone through MCP (`undo_run`). New routes:
  `GET /api/run?sha=` and `POST /api/run/undo`.
- **`atlas hook`: commits made from Claude Code are marked as Claude's.** Claude Code may edit a
  clone of a mind and commit itself. Nothing then told Atlas an AI wrote it, so the commit counted
  as the person's in the activity, the weather and `agent_runs`. The hook adds the
  `X-Atlas-Author: ai/claude` and `X-Atlas-Token: claude-code-<host>` trailers to a commit made
  with `CLAUDECODE=1`. It leaves alone a message that names its author already, and merges.
  `atlas init` installs it; in an existing clone, run `atlas hook` once. A hook that is not
  Atlas's is never overwritten. The server drops `CLAUDECODE` from its own git commands, so a
  server started from Claude Code does not mark a person's clicks as Claude's.

### Fixed
- The weather view's test failed now and then under the parallel suite. After a verdict, the
  stand-in host waited for a review card, but the card it found was the one still on screen while
  `confirm_doc` ran, so a slow commit was cut short. It now waits for the next card.

### Evals
- Seven harder questions, 37 in all:
  - a false premise;
  - one person's work, reaching past the last week;
  - a page compared with what it said three weeks ago;
  - a French question with a budget of calls (the new `max_calls` check);
  - an injection dropped in the inbox;
  - a doc confirmed as still true;
  - a deletion that must leave no link behind.

  Sonnet passes 37/37 and Haiku 36/37. Haiku's miss is `changed-mind`, a French question with no
  date, where it still stops before `show_shift`.

## [1.11.1] - 2026-10-29

### Fixed
- Asked what Claude did yesterday, Claude on the web opened the editing room three times: it listed
  the runs, then asked for each of Claude's runs again to read its commits, and a host that shows
  views opens one per call. `agent_runs` now lists each run with its newest commits (sha, date,
  subject, up to ten, `log_more` counting the rest), so one call answers and gives the `from` sha
  undo_run takes; `run` is left for a run's full log with each commit's docs. Its description says
  one call is enough. A new eval check counts the calls: one, for Sonnet, Haiku and Opus.

## [1.11.0] - 2026-10-29

### Added
- **The editing room**, a view for `agent_runs` in hosts that render MCP Apps. It lays out what
  was written lately as runs, grouped by day: who wrote each one (an AI's name as a badge, a
  person's name otherwise), when, the docs it touched and a tick per commit. Open a run and play it back commit by
  commit, each commit's diffs one click away. **Discard from here** undoes that commit and the
  ones after it and keeps the ones before; **Remove** undoes a single doc; **Discard it all** undoes
  the whole run. Each cut is first run dry and shown, then made in one commit in the user's name,
  and Claude is told what was undone. **Write the save for this work** asks Claude for the save of
  what the run leaves, the undone part named as such. The server instructions now name
  `agent_runs` among the tools that answer with a view, for what was written lately.

### Changed
- The landing page's MCP Apps section gets a fourth row for the editing room. Its captures were
  blurry: they were shot at the view's own width, then shrunk by the browser to about half that.
  Each one is now rendered at the size it is shown, in 1x, 1.5x and 2x, losslessly, and shown a
  little larger. The menu's "How it works" link now goes to that section, not back up the page.

### Fixed
- Asked for "my sessions from yesterday", Claude listed saves: `agent_runs` called runs "work
  sessions", the words `resume_session` uses for saved work. It now calls them runs, what one writer
  did in one go, and points saved work to `resume_session`. A French "what did Claude do yesterday"
  eval question reaches `agent_runs` 3 runs in 3 (Sonnet twice, Haiku once), and the resume question
  still reaches `resume_session`.
- An item an agent dropped in the inbox counted as written by its human: `create_inbox_item` had no
  `ai` field, so the commit got no `X-Atlas-Author` trailer. It now asks for it like the other write
  tools, and the drop counts as the AI's in the activity, the runs and the weather.
- In the viewer's sidebar, a folder holding the open document could not be folded: it reopened at
  once. The folders holding a document now open when it is shown, then are yours to fold. A
  top-level folder you folded also stays folded when the mind is rebuilt (every push used to open
  them all again); only a new one opens.

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
