"""Make a viewer source module require()-able from node, whether it is .js or .ts.

A pure module (02-avatar, 17-qr…) attaches its API to the global scope (window in the
browser, globalThis in node) — node cannot require() a .ts, so requirable() runs a .ts
through the project's esbuild (web/ts/node_modules) into a temp .cjs once (cached) and
returns that path; a .js is returned as-is. After require()-ing it, a test reads the
function off globalThis (the same global-attach path the browser uses).

Used by the pure-module unit tests (test_avatar; test_qr in phase 1b)."""
from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

_ESBUILD = Path(__file__).resolve().parent.parent / "src" / "web" / "ts" / "node_modules" / "esbuild"
_cache: dict[Path, Path] = {}


def requirable(module: Path) -> Path:
    """A node-require()-able path for a viewer module: the file itself if .js, else a
    temp .cjs transpiled from the .ts (cached per source path for the test run)."""
    module = module.resolve()
    if module.suffix != ".ts":
        return module
    if module not in _cache:
        out = Path(tempfile.mkdtemp(prefix="atlas-jsmod-")) / (module.stem + ".cjs")
        # Strip TS types via esbuild (same transform the bundle uses), keeping module.exports.
        script = (
            "const esb=require(process.argv[1]),fs=require('fs');"
            "fs.writeFileSync(process.argv[3],"
            "esb.transformSync(fs.readFileSync(process.argv[2],'utf8'),{loader:'ts'}).code);"
        )
        subprocess.run(["node", "-e", script, str(_ESBUILD), str(module), str(out)],
                       check=True, capture_output=True, text=True)
        _cache[module] = out
    return _cache[module]
