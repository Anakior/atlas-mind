"""Local content-repo git sync (cloud mode).

One lock serializes every git op on the mind's repo. An interactive edit commits
INLINE (commit_change — attributed, path-scoped) then wakes a single coalescing
worker that pulls --rebase, rebuilds and pushes in the background, so the request
never waits on the network. pull_and_rebuild() (periodic + SIGTERM) and trigger_sync()
are the anonymous add -A backstops. run() never blocks on a credential prompt
(GIT_TERMINAL_PROMPT=0) and bounds every call with a timeout. Built once by AppContext.
"""
import os
import subprocess
import sys
import threading
from pathlib import Path

# src/ — holds the `server` package; first on PYTHONPATH so `python -m build`
# resolves the ENGINE's build even with the cwd set to the mind.
_ENGINE_DIR = Path(__file__).resolve().parents[2]


class GitSync:
    def __init__(self, *, config):
        self._config = config
        self._lock = threading.Lock()        # serializes every git op on the repo
        self._push_lock = threading.Lock()   # guards the coalescing-push flag + handle
        self._push_pending = False
        self._pusher = None

    def run(self, *args, cwd=None, check=False, timeout=60):
        """Run a git command in the mind repo. GIT_TERMINAL_PROMPT=0 so a bad/unset
        token fails fast instead of hanging on a credential prompt."""
        return subprocess.run(
            ["git", *args],
            cwd=str(cwd or self._config.root),
            capture_output=True,
            # Git stores/emits UTF-8; decode it as such on EVERY platform. Without
            # this, text=True falls back to the locale encoding (cp1252 on Windows)
            # and mojibakes any non-ASCII in git output — accented author names in
            # the activity feed, the "→" in a move subject, etc. errors="replace"
            # keeps a stray non-UTF-8 byte from crashing a whole read.
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=check,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
        )

    def _build_command(self) -> list:
        """The ENGINE's build (`python -m build`), never a mind-shipped one."""
        return [sys.executable, "-m", "build"]

    def _build_env(self) -> dict:
        env = os.environ.copy()
        env["ATLAS_MIND"] = str(self._config.root)
        env["PYTHONPATH"] = str(_ENGINE_DIR) + os.pathsep + env.get("PYTHONPATH", "")
        return env

    def build(self, *, text=False, timeout=60):
        """Rebuild the viewer against the current mind. text=True to read stderr."""
        return subprocess.run(
            self._build_command(),
            cwd=str(self._config.root),
            env=self._build_env(),
            capture_output=True,
            text=text,
            timeout=timeout,
        )

    # --- attributed inline commit + coalesced push ------------------------

    def commit_change(self, subject, paths, *, author=None, trailers=()) -> None:
        """Commit this action's `paths` NOW (attributed, path-scoped), then wake the
        async push worker. `paths` must be EVERY file the action touched (the doc + any
        relinked/repointed side effects) so the commit isn't split with the backstop.
        `author` is (name, email) or None; `trailers` are raw lines. dev: rebuild only."""
        if self._config.dev_mode:
            threading.Thread(target=self.build, daemon=True).start()
            return
        with self._lock:
            self._commit_one(subject, [str(p) for p in paths], author, tuple(trailers))
        self._request_push()

    def _commit_one(self, subject, paths, author, trailers) -> None:
        """Stage + commit ONLY `paths`. A no-op edit leaves git untouched."""
        if not paths:
            return
        self.run("add", "-A", "--", *paths)
        # One line only: a stray newline (e.g. from a doc/folder name) must not split
        # the subject into a body that forges an X-Atlas-Author trailer.
        subject = " ".join(subject.split())
        msg = subject + ("\n\n" + "\n".join(trailers) if trailers else "")
        args = ["commit", "--only", "-m", msg, "--quiet"]
        if author:
            args += ["--author", f"{author[0]} <{author[1]}>"]
        self.run(*args, "--", *paths)

    def _request_push(self) -> None:
        """Wake a single background worker to pull/rebuild/push; coalesces a burst."""
        with self._push_lock:
            self._push_pending = True
            if self._pusher is None or not self._pusher.is_alive():
                self._pusher = threading.Thread(target=self._push_loop, daemon=True)
                self._pusher.start()

    def _push_loop(self) -> None:
        while True:
            with self._push_lock:
                if not self._push_pending:
                    self._pusher = None
                    return
                self._push_pending = False
            self._sync_remote()

    def _sync_remote(self) -> None:
        """pull --rebase, rebuild, push if ahead. Serialized with every git op."""
        with self._lock:
            try:
                self.run("pull", "--rebase", "--autostash", "--quiet", timeout=30)
                self.build()
                self._push_if_ahead()
            except Exception as e:
                print(f"[sync_remote] {e}", file=sys.stderr, flush=True)

    def _push_if_ahead(self) -> None:
        """Push when HEAD has commits the upstream lacks — covers inline commits (or
        commits rebased in by the webhook / pull loop) that no self-commit pushed."""
        ahead = self.run("rev-list", "--count", "@{u}..HEAD")
        if ahead.returncode == 0 and ahead.stdout.strip() not in ("", "0"):
            self.run("push", "--quiet", timeout=30)

    # --- anonymous backstops -----------------------------------------------

    def pull_and_rebuild(self) -> None:
        """Periodic + SIGTERM net: add -A any stray change (a forgotten side-effect
        path, an edit from a non-attributed site), pull --rebase, rebuild, push if
        ahead. NO reset --hard — for a move it would resurrect the old path → an
        online DUPLICATE."""
        if self._config.dev_mode:
            with self._lock:
                self.build()
            return
        print("[pull_and_rebuild] start", flush=True)
        with self._lock:
            try:
                self.run("add", "-A")
                self.run("commit", "-m", "docs: update via viewer", "--quiet")
                r = self.run("pull", "--rebase", "--autostash", "--quiet", timeout=30)
                b = self.build(text=True)
                print(f"[pull_and_rebuild] pull={r.returncode} build={b.returncode} "
                      f"{r.stderr.strip()!r} {b.stderr.strip()!r}", flush=True)
                self._push_if_ahead()
            except Exception as e:
                print(f"[pull_and_rebuild] ERROR {e}", file=sys.stderr, flush=True)

    def trigger_sync(self) -> None:
        """Anonymous commit + push for sites not (yet) attributed (todos local-only,
        admin mirrors). Background thread; dev: rebuild only."""
        if self._config.dev_mode:
            threading.Thread(target=self.build, daemon=True).start()
            return

        def _sync():
            with self._lock:
                try:
                    self.run("pull", "--rebase", "--autostash", "--quiet", timeout=30)
                    self.build()
                    self.run("add", "-A")
                    self.run("commit", "-m", "docs: update via viewer", "--quiet")
                    self._push_if_ahead()
                except Exception as e:
                    print(f"[trigger_sync] {e}", file=sys.stderr)

        threading.Thread(target=_sync, daemon=True).start()
