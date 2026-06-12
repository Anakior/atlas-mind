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
  viewer assets in `src/web/` and `src/templates/`); a *mind* (content) is a
  separate git repository. Changes should not blur that boundary.
- **No silent failure of safety paths, no crashing of optional ones.** Extensions
  and builds must degrade gracefully (warn and continue); security checks must
  fail closed.

## Running the tests

The test suite is standard-library `unittest`, run from the repository root:

```bash
python3 -m unittest discover -s tests
```

Please run the full suite before opening a pull request, and add or update tests
for any behaviour you change. Tests live in `tests/` (one file per area, plus
`tests/harness.py`).

## Trying your change

```bash
python3 src/cli.py init /tmp/scratch-mind
python3 src/cli.py serve /tmp/scratch-mind
```

This scaffolds a throwaway mind and serves it locally (no auth, `127.0.0.1:8765`),
which is the quickest way to see a change end to end.

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
