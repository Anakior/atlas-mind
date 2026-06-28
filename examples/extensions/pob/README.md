# PoB extension — Path of Exile module

Imports Path of Building builds (PoE1/PoE2) into Atlas: an "Import Path of
Building" template in the New document modal (a styled build sheet generated
from the PoB code), an "Update PoB" button to re-import a code into an existing
doc, and a server endpoint `POST /api/pob-tree` (admin role) that resolves the
passive-tree nodes into names.

## Installation

Copy the three files into the mind's extensions directory:

```bash
mkdir -p <mind>/.atlas/extensions
cp pob.py pob.js pob.css <mind>/.atlas/extensions/
```

Then rebuild the viewer and restart the server:

```bash
atlas build <mind>
atlas serve <mind>
```

- `pob.py` — loaded at boot by the server (`register(context)`): route
  `POST /api/pob-tree`. The tree data (tree.lua from the Path of Building
  Community repositories) is downloaded on demand and cached in
  `<mind>/.atlas/extensions/_tree_cache/` (outside git, outside the viewer).
- `pob.js` — inlined into the viewer at build time, also injected into the
  public share pages: PoB decoder (pako 2.1.0 loaded lazily from
  `/vendor/pako.min.js`, vendored in `src/viewer/vendor/`), markdown sheet
  generator, modals and button, with fr/en translations embedded.
- `pob.css` — `.poe-*` styles for the sheet (viewer + share pages).

## Uninstall

Delete the three files (and `_tree_cache/`), then rebuild: the viewer reverts
strictly to the bare engine. The sheets already generated remain valid markdown
docs, simply without styles or buttons.
