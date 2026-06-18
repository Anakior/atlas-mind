# Demo mind — the public Atlas Mind demo

This folder is a small, self-referential **mind** used to publish the live,
static, offline demo of Atlas Mind on GitHub Pages. It contains **no private
data** — every document showcases a feature of the engine.

## Structure

- `atlas.toml` — config for the demo mind.
- `content/` — the showcase documents (Markdown + one standalone HTML deck).

## Rebuild the static demo

The offline build produces a single self-contained `index-offline.html`
(documents, search index, backlink graph, fonts and JS libraries all embedded —
works from `file://`, no server, no network). Copy it to `docs/demo/index.html`,
which GitHub Pages serves (`docs/index.html` is the hand-authored landing page —
do not overwrite it).

```bash
# from the repo root (uses the working-tree engine on the working-tree content)
python3 src/cli.py build examples/demo-mind --offline   # or: atlas build examples/demo-mind --offline
cp examples/demo-mind/dist/index-offline.html docs/demo/index.html
git add docs/demo/index.html && git commit -m "docs: rebuild demo" && git push
```

On Windows (PowerShell):

```powershell
python src\cli.py build examples\demo-mind --offline
Copy-Item examples\demo-mind\dist\index-offline.html docs\demo\index.html
```

## GitHub Pages

Pages serves from `main` branch, `/docs` folder. The published URL is
`https://anakior.github.io/atlas-mind/`.
