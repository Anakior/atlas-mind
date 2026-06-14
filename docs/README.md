# GitHub Pages site (`/docs`)

Served at **https://anakior.github.io/atlas-mind/** from `main` → `/docs`.

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
python3 src/cli.py build examples/demo-mind --offline
cp examples/demo-mind/dist/index-offline.html docs/demo/index.html
```

The viewer uses client-side hash routing, so it works unchanged from the
`/demo/` subpath. The landing's CTAs link to `./demo/`.
