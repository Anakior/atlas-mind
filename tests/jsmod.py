"""Make a viewer source module importable from node as real ESM.

The viewer modules are ordinary ES modules now (named `export`s, no globalThis self-attach),
so to exercise one in isolation under node, requirable() esbuild-BUNDLES it (bundle:true,
format:'esm') into a temp .mjs. Bundling resolves the module's own imports — e.g. ui/avatar.ts
pulls core/rng.ts in automatically — so the .mjs is self-contained and re-exports the entry's
named symbols. Callers `import()` that .mjs and read the exports directly.

Used by the pure-module unit tests (test_avatar, test_qr)."""
from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

_ESBUILD = Path(__file__).resolve().parent.parent / "src" / "viewer" / "build" / "node_modules" / "esbuild"
_cache: dict[tuple, Path] = {}


def requirable(module: Path, expose: tuple[str, ...] = ()) -> Path:
    """Path to a node-importable ESM build of a viewer module: esbuild bundles the .ts (with its
    transitive imports inlined) into a temp .mjs that re-exports the entry's named symbols. The
    caller `import()`s the returned .mjs and reads those exports. Cached per (module, expose)."""
    module = module.resolve()
    key = (module, tuple(expose))
    if key not in _cache:
        tmpdir = Path(tempfile.mkdtemp(prefix="atlas-jsmod-"))
        out = tmpdir / (module.stem + ".mjs")
        # Bundle the module + its imports into one ESM file (types stripped, side effects kept).
        script = (
            "const esb=require(process.argv[1]);"
            "esb.buildSync({entryPoints:[process.argv[2]],bundle:true,format:'esm',"
            "target:'es2020',treeShaking:false,charset:'utf8',legalComments:'none',"
            "outfile:process.argv[3],logLevel:'silent'});"
        )
        subprocess.run(["node", "-e", script, str(_ESBUILD), str(module), str(out)],
                       check=True, capture_output=True, text=True)
        _cache[key] = out
    return _cache[key]
