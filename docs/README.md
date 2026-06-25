# GitHub Pages site (`/docs`)

Served at **https://atlas-mind.anakior.app/** (custom domain via `docs/CNAME`;
GitHub Pages from `main` → `/docs`). The old `anakior.github.io/atlas-mind/`
redirects here.

| Path | What it is | How it's produced |
|------|------------|-------------------|
| `index.html` | **Landing page** (the marketing "vitrine"). Hand-maintained, self-contained, no third-party network calls. | Edit by hand. |
| `demo/index.html` | **Live interactive demo** — the real viewer, an offline build of `examples/demo-mind/`. | Generated (see below). |
| `.nojekyll` | Disables Jekyll so subfolders/underscored files serve as-is. | Leave it. |

## Refreshing the demo

The demo is a single self-contained file (content, search index, backlink graph,
fonts and JS embedded — no server, no network). Regenerate it after changing
`examples/demo-mind/`:

```bash
python3 examples/demo-mind/build-demo.py
```

This does NOT build `examples/demo-mind/` in place: that directory is a sub-folder
of the engine repo, so its real git history is thin and one-author — the **activity
layer** (Journal / Constellation / Health) would render empty. Instead the script
replays the content into a throwaway git repo (content/ at its root, like a real
mind) with a curated, multi-author, back-dated history (some commits AI-attributed),
then runs the offline build against it so the activity home is populated. The final
document content is identical to `examples/demo-mind/content/`; only the synthetic
authorship timeline differs. To tweak the demo's activity (contributors, dates, AI
edits), edit the `EVENTS` table at the top of `build-demo.py`.

A plain `python3 src/cli.py build examples/demo-mind --offline` still works for a
quick content-only preview, but ships an empty activity layer — use it only when
the activity home isn't what you're checking.

The viewer uses client-side hash routing, so it works unchanged from the
`/demo/` subpath. The landing's CTAs link to `./demo/`.
