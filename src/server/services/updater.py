"""Update the engine from Settings › About.

Where the engine runs from a virtualenv it may write to, installed from PyPI (the alwaysdata
marketplace install, a pip install on a server), an admin updates it with one click: pip
installs the announced release into that same environment, a fresh interpreter checks that it
imports and reports that version (otherwise the running release goes back), then the server
re-executes itself in place: same PID and same port, so a host's supervisor never notices. A
container, a source checkout, uvx or Windows updates its own way: install_kind() says which,
for the About tab to explain.
"""
import os
import subprocess
import sys
import threading
import time
from importlib import metadata
from pathlib import Path

# Straight from PyPI: a host's own mirror can lag a release by several minutes.
INDEX_URL = "https://pypi.org/simple"
_PACKAGE = Path(__file__).resolve().parents[2]  # the atlas_mind package this code runs from
_busy = threading.Lock()


def install_kind() -> str:
    """"button" when a click can update this engine; otherwise how it updates instead:
    "container" (redeploy the image), "source" (a checkout, a branch or a wheel file:
    never swapped for PyPI behind the person's back) or "manual" (pip or uvx by hand)."""
    if os.path.exists("/.dockerenv") or os.environ.get("FLY_APP_NAME"):
        return "container"
    try:
        dist = metadata.distribution("atlas-mind")
    except metadata.PackageNotFoundError:
        return "source"
    # The installed package must be the very code running (not an egg-info lying in the cwd).
    if Path(dist.locate_file("atlas_mind")).resolve() != _PACKAGE or dist.read_text("direct_url.json"):
        return "source"
    site = _PACKAGE.parent
    pip_present = (site / "pip").is_dir()
    if os.name != "posix" or sys.prefix == sys.base_prefix or not pip_present \
            or not os.access(site, os.W_OK):
        return "manual"
    return "button"


def _pip_install(version: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-m", "pip", "install", "--quiet", "--disable-pip-version-check",
         "--no-cache-dir", "--index-url", INDEX_URL, f"atlas-mind=={version}"],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600)


def _installed_version() -> str:
    """What a fresh interpreter finds installed, once the server package imports."""
    try:
        done = subprocess.run(
            [sys.executable, "-I", "-c",
             "import atlas_mind, atlas_mind.server; print(atlas_mind.__version__)"],
            capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        return ""
    return done.stdout.strip() if done.returncode == 0 else ""


def update(target: str, current: str) -> tuple:
    """Install `target` in place of `current`. (True, "") once it is installed and imports;
    (False, why) otherwise, with `current` put back. A second click while one runs is refused."""
    if not _busy.acquire(blocking=False):
        return False, "an update is already running"
    try:
        result = _pip_install(target)
    except subprocess.TimeoutExpired:
        result = subprocess.CompletedProcess([], 1, "", "pip timed out")
    if result.returncode == 0 and _installed_version() == target:
        return True, ""  # keeps _busy: the restart follows
    why = next((ln.strip() for ln in reversed(result.stderr.splitlines()) if ln.strip()),
               "the new version did not start")
    print(f"[update] {target} failed, back to {current}: {why}", file=sys.stderr, flush=True)
    try:
        _pip_install(current)
    except subprocess.TimeoutExpired:
        pass
    _busy.release()
    return False, why[:300]


def restart(flush) -> None:
    """Once the answer has left: `flush` (commit and push what is pending), then re-execute
    this very command line, now running the new release."""
    def run():
        time.sleep(1)
        try:
            flush()
        except Exception as e:
            print(f"[update] flush before restart failed: {e}", file=sys.stderr, flush=True)
        print("[update] restarting on the new version", flush=True)
        sys.stdout.flush()
        sys.stderr.flush()
        os.execv(sys.executable, [sys.executable, *sys.orig_argv[1:]])

    threading.Thread(target=run, daemon=True).start()
