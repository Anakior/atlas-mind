#!/usr/bin/env python3
"""Run the test suite in parallel — one `python -m unittest` process per test CLASS.

Each test is fully isolated (its own tmp mind + ephemeral port), so units run
concurrently with no shared state. Splitting at the CLASS level (not the file) keeps a
single big file — e.g. test_auth_hardening, which spins up ~28 cloud servers — from
setting the wall-clock floor on its own: its classes spread across workers too.
Stdlib only, no pytest/xdist.

    python tests/run_parallel.py                 # everything, half-CPU workers
    python tests/run_parallel.py -j 6            # cap workers
    python tests/run_parallel.py test_browse     # a module or module.Class subset
"""
from __future__ import annotations

import argparse
import concurrent.futures
import os
import re
import subprocess
import sys
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
_RAN_RE = re.compile(r"Ran (\d+) test")
_SKIPPED_RE = re.compile(r"skipped=(\d+)")
# `-v` names each skip and its reason: "test_x (mod.Class.test_x) ... skipped 'why'".
_SKIP_REASON_RE = re.compile(r"\.\.\. skipped ['\"](.*)['\"]$", re.MULTILINE)


def _module_units(module: str) -> list[str]:
    """The 'module.ClassName' units of a test module, so big files split across workers.
    Falls back to the bare module name if it can't be introspected (e.g. import error)."""
    classes: set[str] = set()

    def walk(test) -> None:
        if isinstance(test, unittest.TestSuite):
            for sub in test:
                walk(sub)
        else:
            classes.add(f"{module}.{type(test).__name__}")

    try:
        walk(unittest.defaultTestLoader.loadTestsFromName(module))
    except Exception:
        return [module]
    return sorted(classes) or [module]


def _run_unit(unit: str) -> tuple[str, int, int, list[str], bool, float, str]:
    """Run one unit (module or module.Class); return
    (unit, count, skipped, skip reasons, ok, seconds, tail)."""
    started = time.monotonic()
    proc = subprocess.run(
        [sys.executable, "-m", "unittest", "-v", unit],
        cwd=str(HERE), capture_output=True, encoding="utf-8", errors="replace",
        # No global git identity, as on CI and a newcomer's computer: 2.5.0 shipped an
        # `atlas sync` that needed one, green on every machine that had one. UTF-8 both ways:
        # the locale's code page can't decode every test's output.
        env={**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "PYTHONIOENCODING": "utf-8"},
    )
    seconds = time.monotonic() - started
    out = proc.stdout + proc.stderr
    match = _RAN_RE.search(out)
    count = int(match.group(1)) if match else 0
    match = _SKIPPED_RE.search(out)
    skipped = int(match.group(1)) if match else 0
    reasons = sorted(set(_SKIP_REASON_RE.findall(out)))
    ok = proc.returncode == 0
    tail = "" if ok else "\n".join(out.strip().splitlines()[-25:])
    return unit, count, skipped, reasons, ok, seconds, tail


def main() -> int:
    sys.stdout.reconfigure(errors="backslashreplace")  # a failure's tail may not fit the console's code page
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    # Half the cores by default: each worker spawns its own server subprocess, so one
    # worker per core oversubscribes (a boot then misses boot_timeout under load and a
    # timing-sensitive test flakes).
    parser.add_argument("-j", "--jobs", type=int, default=max(2, (os.cpu_count() or 4) // 2),
                        help="parallel workers (default: half the CPU count)")
    parser.add_argument("targets", nargs="*",
                        help="specific modules or module.Class units (default: all test_*.py)")
    args = parser.parse_args()

    if args.targets:
        units = args.targets
    else:
        units = [u for p in sorted(HERE.glob("test_*.py")) for u in _module_units(p.stem)]

    start = time.monotonic()
    total = total_skipped = 0
    failed: list[str] = []
    skips: list[tuple[str, int, list[str]]] = []
    timings: list[tuple[float, str]] = []

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures = [pool.submit(_run_unit, u) for u in units]
        for future in concurrent.futures.as_completed(futures):
            unit, count, skipped, reasons, ok, seconds, tail = future.result()
            total += count
            total_skipped += skipped
            if skipped:
                skips.append((unit, skipped, reasons))
            timings.append((seconds, unit))
            if not ok:
                failed.append(unit)
                print(f"  [FAIL] {unit} ({count}) {seconds:.0f}s", flush=True)
                print("    " + tail.replace("\n", "\n    "), flush=True)

    elapsed = time.monotonic() - start
    if skips:
        print("\nskipped (not run, so not checked):")
        for unit, skipped, reasons in sorted(skips):
            print(f"  {skipped:4d}  {unit}: {'; '.join(reasons) or '?'}")
    print("\nslowest units (the wall-clock floor):")
    for seconds, unit in sorted(timings, reverse=True)[:6]:
        print(f"  {seconds:5.0f}s  {unit}")
    print(f"\nRan {total} tests ({total_skipped} skipped) across {len(units)} units "
          f"in {elapsed:.1f}s ({args.jobs} workers)")
    if failed:
        print("FAILED: " + " ".join(sorted(failed)))
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
