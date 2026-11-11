# Contributing to Atlas Mind

Thanks for your interest. Atlas Mind is a small, deliberately scoped engine; the goal
is to keep it that way. Contributions that fix bugs, sharpen the docs, or
improve the existing features without enlarging the surface area are the most
welcome.

## Principles

- **Standard library first.** The engine runs on Python 3's standard library.
  The only optional dependency is `bcrypt`, and only to verify legacy password
  hashes. Please do not add dependencies to the engine.
- **Engine and content stay decoupled.** Code lives under `src/` (with the
  viewer assets in `src/viewer/` and `src/templates/`); a *mind* (content) is a
  separate git repository. Changes should not blur that boundary.
- **No silent failure of safety paths, no crashing of optional ones.** Extensions
  and builds must degrade gracefully (warn and continue); security checks must
  fail closed.

## Running the tests

The test suite is standard-library `unittest`, run from the repository root:

```bash
python3 -m unittest discover -s tests
python3 tests/run_parallel.py        # the same tests, one process per test class: much faster
```

`run_parallel.py` is what CI runs, and like CI it hides your global git config: a
change that needs a git identity fails there as it would on a newcomer's computer.

The tests of the viewer's code (the QR code, the avatars, the MCP Apps views) run
under Node with the viewer's build tools. Without them they are **skipped**, and
`run_parallel.py` lists each skip with its reason. To run them too:

```bash
cd src/viewer/build
npm ci                                # esbuild, TypeScript, Playwright (gitignored node_modules)
npx playwright install chromium       # the browser of the MCP Apps view tests
```

Please run the full suite before opening a pull request, and add or update tests
for any behaviour you change. Tests live in `tests/` (one file per area, plus
`tests/harness.py`).

The viewer ships built: `src/viewer/vendor/app.bundle.js` is compiled from the
TypeScript in `src/viewer/lib/`. After changing those sources, rebuild it with
`npm run build` in `src/viewer/build` and commit it with them (CI rebuilds it and
fails when the committed bundle differs).

### Tool-use evals

The tests check what the MCP tools return; the evals check what an agent manages to
do with them. `evals/run.py` asks a model the questions in `evals/questions.json`
through a real MCP client (Claude Code, headless, with only the mind's tools), on
the demo mind replayed with its history plus a prompt injection planted in a remote
mirror, and grades each answer, the tools used and the mind's state afterwards:

```bash
python3 evals/run.py                          # every question, on Sonnet
python3 evals/run.py --model opus --only week,stale
```

It needs `claude` on your PATH and runs on its login (no API key). A full run is
37 sessions, about 8 minutes; the results land in `evals/results/` (gitignored). Run it
when you change a tool's description, its output or the server instructions.

### Search benchmark

`evals/beir.py` measures the search ranking alone on a public BEIR dataset (SciFact by
default, downloaded once into `~/.cache/atlas-evals/beir/`): each document becomes a note,
each test query goes to `search_docs` over `atlas mcp`, and nDCG@10, Recall@10/@50 and
MRR@10 come out beside the BM25 baseline of the BEIR paper. No model is called; SciFact
takes a minute or two.

```bash
python3 evals/beir.py                         # SciFact, notes named after their titles
python3 evals/beir.py --dataset nfcorpus --names id
```

Run it when you change the search: a refactor must give every query the same result.

## Trying your change

```bash
python3 src/cli.py init /tmp/scratch-mind
python3 src/cli.py serve /tmp/scratch-mind
```

This scaffolds a throwaway mind and serves it locally (no auth, `127.0.0.1:8765`),
which is the quickest way to see a change end to end.

## Testing cloud mode locally (dev sandbox)

`atlas serve` runs in **local mode** (no accounts). To exercise the **cloud**
features — login, the `/setup` onboarding, share links, 2FA, the admin panel —
without ever touching git (no commit, no push, no pull) and without a remote,
use the dev sandbox:

```bash
python3 src/cli.py dev
```

It copies the bundled demo mind into a gitignored `.dev-mind/`, serves it on
`127.0.0.1:8765` with cloud features on, and seeds a ready-made admin so you can
log in immediately:

- **login:** `dev@local` / `dev`
- `--fresh` skips the seeded admin to exercise the first-boot `/setup` token flow
- `--reset` wipes the dev mind (accounts + edits) and re-seeds it from the demo
- `--port N` changes the port
- `atlas dev seed` fills the mind with sample inbox items + attributed Activity
  commits so the home Activity card and the Inbox render without real history
  (DEV-ONLY — it mutates the mind; `atlas dev inbox "<title>"` drops one item)

Edits are written to `.dev-mind/` and the viewer rebuilds, but **git is never
touched**. Under the hood `dev` sets `ATLAS_DEV=1`; the server then forces auth
on, disables every git operation, binds loopback, and seeds the admin.

> Prefer `atlas dev` (or `python -m server`) over `atlas serve` from a
> **Git-Bash / MSYS2** shell: `serve` hands off with `os.execve`, which crashes
> under MSYS2 on recent CPython. `atlas dev` uses a subprocess, so it is safe in
> any shell on any platform.

### In Docker (any platform, no local Python)

```bash
docker compose -f deploy/docker-compose.dev.yml up       # -> http://127.0.0.1:8765
docker compose -f deploy/docker-compose.dev.yml down -v   # wipe the dev mind
```

Same sandbox, isolated in a container, running the engine from your local source
(mounted live). The host port is pinned to `127.0.0.1`, so it never leaves your
machine.

To try your change the way Atlas is deployed (cloud mode with git on, the engine
baked into an image), `deploy/Dockerfile` and `deploy/docker-compose.yml` build an
image from your checkout; the compose file's header says how to run it. Real
deployments take the PyPI release instead: `atlas deploy` writes their files.

## Front-end CSS (Tailwind)

The viewer's styles ship as a **precompiled** stylesheet, `src/viewer/vendor/tailwind.css`,
so the engine itself needs no Node toolchain at runtime. That file is generated by
scanning `src/viewer/viewer.html` and keeping only the utility classes it actually uses.

**Consequence:** if you add a Tailwind class to `viewer.html` that was not already
in the page, it will not exist in the compiled CSS and will silently do nothing
until you regenerate it. After changing classes, rebuild the stylesheet:

```bash
cd src/viewer/tailwind
npm install      # once — installs the build toolchain into a local (gitignored) node_modules
npm run build    # every time you change classes in viewer.html
```

`npm run build` re-extracts the safelist of dynamically-built classes (from the
JS string literals) and recompiles `../vendor/tailwind.css`. Commit the regenerated
CSS alongside your HTML change. The toolchain (Tailwind v3 + the typography plugin)
is dev-only and is never bundled into the published package.

## Style

- Keep functions small and named for what they do; reject the bad input first and
  let the happy path fall through unindented.
- Match the surrounding code. The codebase favours early returns over nested
  `if`/`else` and avoids one-letter or abbreviated names.
- Comments explain *why*, not *what*. Prefer an expressive name over a comment.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Make focused commits — one logical change per commit, written in English,
   present tense.
3. Run the test suite and, where relevant, the manual check above.
4. Open a pull request describing the change and the motivation. If it changes
   behaviour, say which tests cover it. If it touches the security model, the
   configuration surface, or the public API/MCP/REST contract, call that out
   explicitly so it gets the review it needs.

## Licence of contributions

Atlas Mind is licensed under the AGPL-3.0. By submitting a contribution you agree that
it is licensed under the same terms. Do not contribute code you are not entitled
to license this way.
