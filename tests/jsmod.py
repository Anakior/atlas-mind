"""Make a viewer source module require()-able from node, whether it is .js or .ts.

The pure-codec modules (ui/avatar, ui/qr-code) are plain TOP-LEVEL declarations in the
shared transform-concat bundle scope (no IIFE, no self-attach to a root). To exercise one
in isolation under node, requirable() concatenates its `deps` (other bundle modules it
relies on, e.g. core/rng for avatar) ahead of it, transpiles the whole through the project's
esbuild (viewer/build/node_modules) into a temp .cjs once (cached), and re-attaches the named
`expose` symbols to globalThis — so a test reads them off globalThis exactly as a later module
in the bundle would reach them by bare name.

Used by the pure-module unit tests (test_avatar, test_qr)."""
from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

_ESBUILD = Path(__file__).resolve().parent.parent / "src" / "viewer" / "build" / "node_modules" / "esbuild"
_cache: dict[tuple, Path] = {}


def requirable(module: Path, deps: tuple[Path, ...] = (), expose: tuple[str, ...] = ()) -> Path:
    """A node-require()-able path for a viewer module: the file itself if .js with no
    deps/expose, else a temp .cjs = `deps` + the .ts transpiled by esbuild, with the named
    top-level `expose` symbols assigned onto globalThis. Cached per (module, deps, expose)."""
    module = module.resolve()
    deps = tuple(Path(d).resolve() for d in deps)
    if module.suffix != ".ts" and not deps and not expose:
        return module
    key = (module, deps, tuple(expose))
    if key not in _cache:
        tmpdir = Path(tempfile.mkdtemp(prefix="atlas-jsmod-"))
        parts = [d.read_text("utf-8") for d in deps] + [module.read_text("utf-8")]
        if expose:
            parts.append("Object.assign(globalThis, { " + ", ".join(expose) + " });")
        combined = tmpdir / (module.stem + ".src.ts")
        combined.write_text("\n".join(parts), encoding="utf-8")
        out = tmpdir / (module.stem + ".cjs")
        # Strip TS types via esbuild (same transform the bundle uses).
        script = (
            "const esb=require(process.argv[1]),fs=require('fs');"
            "fs.writeFileSync(process.argv[3],"
            "esb.transformSync(fs.readFileSync(process.argv[2],'utf8'),{loader:'ts'}).code);"
        )
        subprocess.run(["node", "-e", script, str(_ESBUILD), str(combined), str(out)],
                       check=True, capture_output=True, text=True)
        _cache[key] = out
    return _cache[key]
