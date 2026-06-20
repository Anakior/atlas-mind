"""Local content-repo git sync (cloud mode).

GitSync serializes every git operation on the mind's OWN repo behind a single lock
and runs the viewer rebuild. pull_and_rebuild() (periodic + on SIGTERM) commits the
pending local edits, pulls --rebase, rebuilds, then pushes; trigger_sync() does the
same in a background thread after an interactive edit. The run() wrapper never
blocks on a credential prompt (GIT_TERMINAL_PROMPT=0 → a bad/unset token fails fast,
not at the timeout) and bounds every call with a timeout. Built once by AppContext
(needs config for the repo root + the build env).
"""
import os
import subprocess
import sys
import threading
from pathlib import Path

# src/ — the directory that holds the `server` package; put first on PYTHONPATH so
# `python -m build` resolves the ENGINE's build even with the cwd set to the mind.
_ENGINE_DIR = Path(__file__).resolve().parents[2]


class GitSync:
    def __init__(self, *, config):
        self._config = config
        self._lock = threading.Lock()

    def run(self, *args, cwd=None, check=False, timeout=60):
        """Run a git command in the mind repo. GIT_TERMINAL_PROMPT=0 so a bad/unset
        token fails fast and loud instead of hanging on a credential prompt."""
        return subprocess.run(
            ["git", *args],
            cwd=str(cwd or self._config.root),
            capture_output=True,
            text=True,
            timeout=timeout,
            check=check,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
        )

    def _build_command(self) -> list:
        """Command to (re)build the viewer: the ENGINE's build via `python -m
        build` (never a mind-shipped one). _build_env's PYTHONPATH resolves the
        engine's build even with the cwd set to the mind."""
        return [sys.executable, "-m", "build"]

    def _build_env(self) -> dict:
        """Env for the build subprocess: ATLAS_MIND points at the current mind;
        PYTHONPATH puts the engine package dir first."""
        env = os.environ.copy()
        env["ATLAS_MIND"] = str(self._config.root)
        env["PYTHONPATH"] = str(_ENGINE_DIR) + os.pathsep + env.get("PYTHONPATH", "")
        return env

    def build(self, *, text=False, timeout=60):
        """Rebuild the viewer (`python -m build`) against the current mind. Returns
        the CompletedProcess; pass text=True to read its captured stderr."""
        return subprocess.run(
            self._build_command(),
            cwd=str(self._config.root),
            env=self._build_env(),
            capture_output=True,
            text=text,
            timeout=timeout,
        )

    def pull_and_rebuild(self) -> None:
        """Pull latest from GitHub and rebuild index.html. Locked to serialize git
        ops.

        Commits the PENDING local changes (edit/move/delete from the endpoints,
        whose async trigger_sync commit hasn't fired) before pulling. Above all NO
        `reset --hard`: for a move it would resurrect the old path while keeping
        the new one → a DUPLICATE online. Build artifacts are gitignored, so they
        never block the pull --rebase.
        """
        if self._config.dev_mode:
            # Dev sandbox: rebuild only, never touch git (no push to prod's repo).
            with self._lock:
                self.build()
            return
        print("[pull_and_rebuild] start", flush=True)
        with self._lock:
            try:
                self.run("add", "-A")
                committed = self.run("commit", "-m", "docs: update via viewer", "--quiet").returncode == 0
                r = self.run("pull", "--rebase", "--autostash", "--quiet", timeout=30)
                print(f"[pull_and_rebuild] committed_local={committed} git pull exit={r.returncode} stderr={r.stderr.strip()!r}", flush=True)
                b = self.build(text=True)
                print(f"[pull_and_rebuild] build.py exit={b.returncode} stderr={b.stderr.strip()!r}", flush=True)
                if committed:
                    p = self.run("push", "--quiet", timeout=30)
                    print(f"[pull_and_rebuild] push exit={p.returncode} stderr={p.stderr.strip()!r}", flush=True)
            except Exception as e:
                print(f"[pull_and_rebuild] ERROR {e}", file=sys.stderr, flush=True)

    def trigger_sync(self) -> None:
        """Commit + push local edits (todos / file PUT). Runs in a background
        thread. In the dev sandbox it ONLY rebuilds the viewer (so the live-reload
        watcher reflects the edit) and NEVER touches git — no push to prod."""
        if self._config.dev_mode:
            threading.Thread(target=self.build, daemon=True).start()
            return

        def _sync():
            with self._lock:
                try:
                    self.run("pull", "--rebase", "--autostash", "--quiet", timeout=30)
                    self.build()
                    self.run("add", "-A")
                    commit = self.run("commit", "-m", "docs: update via viewer", "--quiet")
                    if commit.returncode == 0:
                        self.run("push", "--quiet", timeout=30)
                except Exception as e:
                    print(f"[trigger_sync] {e}", file=sys.stderr)

        threading.Thread(target=_sync, daemon=True).start()
