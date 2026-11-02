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

Reload the viewer: Atlas's blue accent becomes purple. Edit the `--accent`
value in `custom-theme.css` to pick your shade, or uncomment the other options
(background, font, rounded corners).

## Going further

- Every colour of the palette is a token on `:root` (`--navy-900`…`--navy-500`
  for the surfaces, `--ink-100`…`--ink-500` for the text, `--accent`), read by
  the compiled Tailwind classes (`bg-navy-800`, `text-ink-200`, `ring-accent/40`…)
  and the engine's stylesheets alike: redefine a token rather than override the
  classes. For anything else, inspect the viewer with the devtools to find the
  class to override.
- The viewer has a light theme: `:root[data-theme="light"]` redefines the same
  tokens. A rule of yours with a fixed colour needs its light twin under that
  selector, or it shows the dark page's colour on the light one.
- The instance accent (buttons, badges, this week's docs) is the `--brand` token.
  Admins pick it in Settings › Appearance; prefer that over an extension.
- For logic (not just style), add a `.js` (inlined the same way) or a `.py`
  (loaded at server boot, can expose routes). See the `pob/` example and the
  *Extensions* section of the scaffolded `atlas.toml`.
