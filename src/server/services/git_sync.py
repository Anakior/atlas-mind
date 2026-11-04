"""Local content-repo git sync (cloud mode).

One lock serializes the git ops that change the repo (commit, rebase) and the rebuild;
fetch and push run outside it, under their own, so a slow or failing remote never holds
up a save. An interactive edit commits INLINE (commit_change — attributed, path-scoped)
then wakes a single coalescing worker that rebuilds and pushes in the background,
pulling only when the remote has moved, and retrying a failed push a few times before
the periodic loop takes over. pull_and_rebuild() (periodic + SIGTERM) and trigger_sync()
are the anonymous add -A backstops. run() never blocks on a credential prompt
(GIT_TERMINAL_PROMPT=0) and bounds every call with a timeout. Without an upstream (a
mind started with no remote) pull/push are skipped. Every commit/pull/push outcome is
recorded; health() reports a refused commit at once, a failing pull/push once it lasts.
Built once by AppContext.
"""
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

from server.pure import restore

# src/ — holds the `server` package; first on PYTHONPATH so `python -m build`
# resolves the ENGINE's build even with the cwd set to the mind.
_ENGINE_DIR = Path(__file__).resolve().parents[2]

# What the person can do about a failed git op, guessed from git's own words.
_ERROR_KINDS = (
    ("auth", ("authentication failed", "permission denied", "could not read username",
              "invalid username or password", "terminal prompts disabled",
              "returned error: 401", "returned error: 403")),
    ("network", ("could not resolve host", "failed to connect", "connection timed out",
                 "network is unreachable", "connection refused", "timed out")),
    ("conflict", ("conflict", "could not apply", "rejected", "non-fast-forward",
                  "fetch first")),
)
# `git commit` exits 1 when there is simply nothing to commit: not a failure.
_NOTHING_TO_COMMIT = ("nothing to commit", "nothing added to commit",
                      "no changes added to commit")
# A push refused because the remote has commits the mind lacks: pull, then push again.
_REMOTE_AHEAD = ("fetch first", "non-fast-forward")
# Retries of a failed push (a newer save retries at once), then the periodic loop's turn.
_RETRY_S = (15, 45, 120)
# A remote failing now and then is no news: a pull/push failure counts once it lasts.
_ERROR_GRACE_S = 120


def mask_url(s: str) -> str:
    """Hide the credentials of a remote URL (https://user:token@host) in a log line."""
    return re.sub(r"://[^@\s]+@", "://***@", s or "")


def classify_git_error(text: str) -> str:
    low = (text or "").lower()
    for kind, needles in _ERROR_KINDS:
        if any(n in low for n in needles):
            return kind
    return "other"


class GitSync:
    def __init__(self, *, config):
        self._config = config
        self._lock = threading.Lock()        # serializes the git ops that change the repo
        self._remote_lock = threading.Lock() # serializes fetch/push, apart from _lock
        self._push_lock = threading.Lock()   # guards the coalescing-push flag + handle
        self._push_pending = False
        self._pusher = None
        self._push_wake = threading.Event()  # a new save cuts a retry wait short
        self._retry_s = _RETRY_S
        self._error_grace = _ERROR_GRACE_S
        self._dev_lock = threading.Lock()    # coalesces the dev live-rebuild (single-flight)
        self._dev_building = False
        self._dev_dirty = False
        self._build_lock = threading.Lock()  # serializes `python -m build` runs so two never race on web/vendor/app.bundle.js
        self._health_lock = threading.Lock()
        self._last_ok = {}   # op ("commit" / "pull" / "push") -> epoch of its last success
        self._error = None   # the last failure still standing, reported by health()

    def run(self, *args, cwd=None, check=False, timeout=60):
        """Run a git command in the mind repo. GIT_TERMINAL_PROMPT=0 so a bad/unset
        token fails fast instead of hanging on a credential prompt. CLAUDECODE is
        dropped: on a server started from Claude Code, the commit hook would mark a
        person's edit as Claude's."""
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
            env={**{k: v for k, v in os.environ.items() if k != "CLAUDECODE"},
                 "GIT_TERMINAL_PROMPT": "0"},
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
        """Rebuild the viewer against the current mind. text=True to read stderr.

        Serialized on _build_lock: in dev the source-watch loop (A) and a content edit
        (B) both land here, and two concurrent `python -m build` would race on
        web/vendor/app.bundle.js — esbuild rewrites it while another render reads it."""
        with self._build_lock:
            return subprocess.run(
                self._build_command(),
                cwd=str(self._config.root),
                env=self._build_env(),
                capture_output=True,
                text=text,
                timeout=timeout,
            )

    def _dev_rebuild(self) -> None:
        """Coalesced dev live-rebuild: at most ONE build runs at a time; a burst of writes
        (e.g. an agent streaming inbox items) collapses to a single rebuild, plus one more if
        changes landed mid-build. Replaces the old thread-per-commit, which piled up N concurrent
        KB builds and could thrash the box."""
        with self._dev_lock:
            self._dev_dirty = True
            if self._dev_building:
                return
            self._dev_building = True
        threading.Thread(target=self._dev_build_loop, daemon=True).start()

    def _dev_build_loop(self) -> None:
        while True:
            with self._dev_lock:
                if not self._dev_dirty:
                    self._dev_building = False
                    return
                self._dev_dirty = False
            try:
                self.build()
            except Exception as e:
                print(f"[dev rebuild] {e}", file=sys.stderr, flush=True)

    # --- attributed inline commit + coalesced push ------------------------

    def commit_change(self, subject, paths, *, author=None, trailers=()) -> None:
        """Commit this action's `paths` NOW (attributed, path-scoped), then wake the
        async push worker. `paths` must be EVERY file the action touched (the doc + any
        relinked/repointed side effects) so the commit isn't split with the backstop.
        `author` is (name, email) or None; `trailers` are raw lines. dev: rebuild only."""
        if self._config.dev_mode:
            self._dev_rebuild()
            return
        with self._lock:
            self._commit_one(subject, [str(p) for p in paths], author, tuple(trailers))
        self._request_push()

    def _commit_one(self, subject, paths, author, trailers) -> None:
        """Stage + commit ONLY `paths`. A no-op edit leaves git untouched."""
        if not paths:
            return
        add = self.run("add", "-A", "--", *paths)
        if add.returncode != 0:
            self._note("commit", add)
            return
        # One line only: a stray newline (e.g. from a doc/folder name) must not split
        # the subject into a body that forges an X-Atlas-Author trailer.
        subject = " ".join(subject.split())
        msg = subject + ("\n\n" + "\n".join(trailers) if trailers else "")
        args = ["commit", "--only", "-m", msg, "--quiet"]
        if author:
            args += ["--author", f"{author[0]} <{author[1]}>"]
        self._note("commit", self.run(*args, "--", *paths))

    def revert(self, shas, subject, *, author=None, trailers=(), only=None):
        """Revert `shas` (newest first) as ONE attributed commit, under the repo lock.
        `only`: the repo paths to undo, the revert's other changes dropped (a move stays
        whole when either of its paths is listed). All or nothing: on a conflict
        `revert --abort` puts the tree back as it was.
        Returns (new commit sha, None) or (None, why it could not apply)."""
        if self._config.dev_mode:
            return None, "dev mode keeps no git history"
        with self._lock:
            if self.run("diff", "--cached", "--quiet").returncode != 0:
                return None, "the index holds staged changes"
            r = self.run("revert", "--no-commit", *shas)
            if r.returncode != 0:
                self.run("revert", "--abort")
                # The CONFLICT lines name the files at fault; else git's own error line.
                why = [ln for ln in r.stdout.splitlines() if ln.startswith("CONFLICT")]
                return None, "; ".join(why or r.stderr.strip().splitlines()[:1] or ["revert failed"])
            if only is not None:
                drop = [p for change in self._staged_changes() if not only & set(change) for p in change]
                if drop:
                    self.run("restore", "--source=HEAD", "--staged", "--worktree", "--", *drop)
                if self.run("diff", "--cached", "--quiet").returncode == 0:
                    self.run("revert", "--abort")
                    return None, "nothing left to undo on those docs"
            msg = " ".join(subject.split()) + ("\n\n" + "\n".join(trailers) if trailers else "")
            args = ["commit", "-m", msg, "--quiet"]
            if author:
                args += ["--author", f"{author[0]} <{author[1]}>"]
            c = self.run(*args)
            if c.returncode != 0:
                self.run("revert", "--abort")
                return None, (c.stdout or c.stderr).strip() or "commit failed"
            sha = self.run("rev-parse", "HEAD").stdout.strip()
        self._request_push()
        return sha, None

    def _staged_changes(self) -> list:
        """The paths of each staged change: one, or a move's two."""
        out = self.run("diff", "--cached", "--name-status", "-M", "-z").stdout
        tokens = [t for t in out.split("\x00") if t]
        changes, i = [], 0
        while i < len(tokens):
            n = 2 if tokens[i][:1] in ("R", "C") else 1
            changes.append(tokens[i + 1:i + 1 + n])
            i += 1 + n
        return changes

    def _request_push(self) -> None:
        """Wake a single background worker to rebuild and push; coalesces a burst."""
        with self._push_lock:
            self._push_pending = True
            self._push_wake.set()
            if self._pusher is None or not self._pusher.is_alive():
                self._pusher = threading.Thread(target=self._push_loop, daemon=True)
                self._pusher.start()

    def _push_loop(self) -> None:
        retries = iter(self._retry_s)
        while True:
            with self._push_lock:
                if not self._push_pending:
                    self._pusher = None
                    return
                self._push_pending = False
                self._push_wake.clear()
            if self._sync_remote():
                retries = iter(self._retry_s)
                continue
            delay = next(retries, None)
            if delay is not None:
                self._push_wake.wait(delay)
                with self._push_lock:
                    self._push_pending = True

    def _sync_remote(self) -> bool:
        """Rebuild, then push; pull only when the remote has moved. True once nothing
        is left to push (or there is no remote)."""
        try:
            with self._lock:
                self.build()
            if not self._has_upstream():
                return True
            outcome = self._push()
            if outcome == "behind" and self._pull():
                outcome = self._push()
            return outcome == "ok"
        except Exception as e:
            print(f"[sync_remote] {e}", file=sys.stderr, flush=True)
            return False

    def _push(self) -> str:
        """Push the commits the upstream lacks — inline ones, or ones rebased in by the
        webhook / pull loop. "ok" when none is left, "behind" when the remote has commits
        the mind lacks (not a failure: pull, then push again), else "failed"."""
        if not self._unpushed()[0]:
            return "ok"
        result = self._net("push", "--quiet")
        out = f"{result.stderr or ''}\n{result.stdout or ''}".lower()
        if result.returncode and any(n in out for n in _REMOTE_AHEAD):
            return "behind"
        return "ok" if self._note("push", result) else "failed"

    def _pull(self, *, build=True) -> bool:
        """Fetch outside the repo lock, then rebase onto the upstream under it, and
        rebuild when that brought something. A rebase that cannot apply is undone: the
        mind stays as it was. True when the mind now holds the remote's commits."""
        fetched = self._net("fetch", "--quiet")
        if fetched.returncode:
            self._note("pull", fetched)
            return False
        with self._lock:
            before = self.run("rev-parse", "HEAD").stdout
            result = self.run("rebase", "--autostash", "--quiet")
            if result.returncode:
                self.run("rebase", "--abort")
            if not self._note("pull", result):
                return False
            if build and self.run("rev-parse", "HEAD").stdout != before:
                self.build()
        return True

    # --- sync health -------------------------------------------------------

    def _has_upstream(self) -> bool:
        """A mind started without a remote has nothing to pull from or push to."""
        return self.run("rev-parse", "--abbrev-ref", "@{u}").returncode == 0

    def _unpushed(self) -> tuple:
        """(count, epoch of the oldest) of the commits the upstream lacks."""
        stamps = self.run("log", "@{u}..HEAD", "--format=%ct").stdout.split()
        return len(stamps), (int(stamps[-1]) if stamps else None)

    def _net(self, *args) -> subprocess.CompletedProcess:
        """A fetch or push: under the remote lock only (git takes its own ref locks, so
        a save can commit meanwhile), bounded in time; a timeout reads as a network
        failure."""
        with self._remote_lock:
            try:
                return self.run(*args, timeout=30)
            except subprocess.TimeoutExpired:
                return subprocess.CompletedProcess(args, 1, "", f"git {args[0]} timed out")

    def _note(self, op, result) -> bool:
        """Record a git op's outcome for health(); True when it succeeded. A success
        of `op` clears a standing failure of that same op. Failures are logged: a
        commit refused by git must never vanish silently."""
        out = f"{result.stderr or ''}\n{result.stdout or ''}"
        if result.returncode == 0 or (op == "commit" and any(n in out for n in _NOTHING_TO_COMMIT)):
            with self._health_lock:
                self._last_ok[op] = time.time()
                if self._error and self._error["op"] == op:
                    self._error = None
            return True
        first = next((ln.strip() for ln in out.splitlines() if ln.strip()), "git failed")
        now = time.time()
        error = {"op": op, "kind": classify_git_error(out),
                 "message": mask_url(first)[:300], "at": now, "since": now}
        with self._health_lock:
            if self._error and self._error["op"] == op:  # the same failure, still standing
                error["since"] = self._error["since"]
            self._error = error
        print(f"[git {op}] FAILED ({error['kind']}): {mask_url(out.strip())[:500]}",
              file=sys.stderr, flush=True)
        return False

    def health(self) -> dict:
        """Where the mind stands against its remote, for the viewer banner, the MCP
        warning and `atlas doctor --sync`. Read-only git: never waits on a sync."""
        if self._config.dev_mode:
            return {"status": "local", "remote": False, "unpushed": 0,
                    "oldest_unpushed_at": None, "last_push_at": None, "error": None}
        upstream = self._has_upstream()
        count, oldest = self._unpushed() if upstream else (0, None)
        with self._health_lock:
            error = dict(self._error) if self._error else None
            last_push = self._last_ok.get("push")
        lasting = bool(error) and (error["op"] == "commit" or (
            count > 0 and time.time() - error["since"] >= self._error_grace))
        status = ("error" if lasting else "local" if not upstream
                  else "pending" if count else "ok")
        return {"status": status, "remote": upstream, "unpushed": count,
                "oldest_unpushed_at": oldest, "last_push_at": last_push, "error": error}

    def remote_url(self):
        """The origin the mind syncs with, or None."""
        r = self.run("remote", "get-url", "origin")
        return r.stdout.strip() if r.returncode == 0 else None

    def connect_remote(self, url, ssh_command) -> tuple:
        """Make `url` the mind's origin and push the whole mind there, under the repo
        lock. A refused push puts things back as they were (no origin): the mind stays
        local rather than half-connected. Returns (ok, git's own message)."""
        with self._lock:
            self.run("config", "core.sshCommand", ssh_command)
            self.run("remote", "add", "origin", url)
            try:
                result = self.run("push", "-u", "origin", "HEAD:main", timeout=120)
            except subprocess.TimeoutExpired:
                result = subprocess.CompletedProcess([], 1, "", "git push timed out")
            if result.returncode != 0:
                self._forget_remote()
                return False, mask_url((result.stderr or result.stdout).strip())
            self._note("push", result)
            return True, ""

    def adopt_remote(self, url, ssh_command) -> tuple:
        """Make `url` the mind's origin and ITS history the mind's: a mind restored from
        its GitHub copy. The current history stays reachable (restore.BEFORE); a failed
        fetch, or a repo holding no Atlas (RestoreError, re-raised), puts things back.
        Returns (ok, git's own message)."""
        with self._lock:
            self._commit_stray()
            self.run("config", "core.sshCommand", ssh_command)
            self.run("remote", "add", "origin", url)
            try:
                result = self.run("fetch", "--quiet", "origin", "main", timeout=120)
                if result.returncode != 0:
                    self._forget_remote()
                    return False, mask_url((result.stderr or result.stdout).strip())
                restore.adopt(self._config.root, "refs/remotes/origin/main")
            except BaseException:
                self._forget_remote()
                raise
            self.run("branch", "--set-upstream-to=origin/main")
            self._note("pull", result)
            return True, ""

    def disconnect_remote(self) -> None:
        """Stop syncing with origin; the mind and its history stay as they are."""
        with self._lock:
            self._forget_remote()

    def _forget_remote(self) -> None:
        self.run("remote", "remove", "origin")
        self.run("config", "--unset", "core.sshCommand")
        with self._health_lock:  # no remote, so no pull/push failure left to report
            if self._error and self._error["op"] != "commit":
                self._error = None

    def _commit_stray(self) -> None:
        """Record tracked changes not yet committed (lock held)."""
        self.run("add", "-u")
        self._note("commit", self.run("commit", "-m", "docs: update via viewer", "--quiet"))

    def settled(self, op):
        """Run `op` under the repo lock, tracked changes not yet committed recorded first:
        git updates a clean working tree only (a push to /git), and a restore keeps them
        in the history it replaces. Returns what `op` returns."""
        with self._lock:
            self._commit_stray()
            return op()

    def sync_now(self) -> None:
        """The banner's button, and after a push to /git: commit what was left over,
        pull, rebuild, push — in the background — so a cleared cause (a stale lock,
        fixed credentials) clears the warning too."""
        threading.Thread(target=self.pull_and_rebuild, daemon=True).start()

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
        try:
            with self._lock:
                self.run("add", "-A")
                self._note("commit", self.run("commit", "-m", "docs: update via viewer", "--quiet"))
            upstream = self._has_upstream()
            if upstream:
                self._pull(build=False)
            with self._lock:
                b = self.build(text=True)
            if b.returncode != 0:
                print(f"[pull_and_rebuild] build failed: {b.stderr.strip()!r}",
                      file=sys.stderr, flush=True)
            if upstream:
                self._push()
        except Exception as e:
            print(f"[pull_and_rebuild] ERROR {e}", file=sys.stderr, flush=True)

    def trigger_sync(self) -> None:
        """Anonymous commit + push for sites not (yet) attributed (todos local-only,
        admin mirrors). Background thread; dev: rebuild only."""
        if self._config.dev_mode:
            self._dev_rebuild()
            return

        def _sync():
            try:
                upstream = self._has_upstream()
                if upstream:
                    self._pull(build=False)
                with self._lock:
                    self.build()
                    self.run("add", "-A")
                    self._note("commit", self.run("commit", "-m", "docs: update via viewer", "--quiet"))
                if upstream:
                    self._push()
            except Exception as e:
                print(f"[trigger_sync] {e}", file=sys.stderr)

        threading.Thread(target=_sync, daemon=True).start()
