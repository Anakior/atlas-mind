# Example extension — custom CSS theme

Shows how to **change Atlas's design** without touching the engine, through the
CSS extension mechanism.

## How it works

Any `.css` (and `.js`) file dropped into `<your-mind>/.atlas/extensions/` is
**inlined into the viewer at build time** (online and offline modes), in
alphabetical order, after the engine's CSS. An extension can therefore override
any style — here, the accent color.

## Usage

```bash
# from your mind
mkdir -p .atlas/extensions
cp /path/to/atlas/examples/extensions/custom-theme/custom-theme.css .atlas/extensions/
atlas build .          # or restart the server: atlas serve .
```

Reload the viewer: Atlas's blue accent becomes purple. Edit the `--my-accent`
value in `custom-theme.css` to pick your shade, or uncomment the other options
(background, font, rounded corners).

## Going further

- The engine uses **compiled Tailwind classes** (`text-accent`, `bg-navy-800`,
  `text-ink-200`, `subtle-border`…): inspect the viewer with the devtools to
  find the class to override.
- For logic (not just style), add a `.js` (inlined the same way) or a `.py`
  (loaded at server boot, can expose routes). See the `pob/` example and the
  *Extensions* section of the scaffolded `atlas.toml`.
