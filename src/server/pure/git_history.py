"""Git history/diff/blame parsing behind the time-travel tools."""
import datetime
import re

import server as _s
from server.pure.queries import _visible, _strip_content, _history_path_included

# The well-known empty-tree object: lets doc_diff express "this doc's first
# appearance" as a normal two-tree diff (empty -> rev) instead of a special case.
_EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
# Output caps: a real .html deck in a mind can be ~2 MB; an uncapped diff/content/
# blame would blow the model's context. The HTTP endpoints have no cap (a browser
# doesn't care) — the MCP tools must.
_MAX_OUTPUT_CHARS = 60000
_MAX_BLAME_LINES = 600
_BLAME_HEAD_RE = re.compile(r"^[0-9a-f]{40} \d+ \d+")

# Every git call goes through _s.git (subprocess arg-list, NO shell). Doc paths are
# content/-relative on the MCP side; git runs at the repo root, so the pathspec is
# prefixed with "content/". Revs the AGENT supplies are gated by _s._valid_git_rev
# (SHA or HEAD~N only) — dates and relative bases are resolved to a SHA server-side
# (the validator rejects them by design), and filter flags (--since/--grep/--author)
# are passed as fused argv tokens, never through the rev validator.


def _scrub_commits(commits, ctx):
    """Drop, from each commit, the changed files `ctx` can't read; drop commits
    left with no visible file. Keeps history tools from leaking private doc paths."""
    if ctx is None:
        return commits
    out = []
    for c in commits:
        files = [f for f in c.get("files", []) if _visible(f.get("path", ""), ctx)]
        if files:
            out.append({**c, "files": files})
    return out


def _capped(text):
    """Truncate a payload to protect the model context; returns (text, truncated)."""
    if not text:
        return text or "", False
    if len(text) <= _MAX_OUTPUT_CHARS:
        return text, False
    return text[:_MAX_OUTPUT_CHARS], True


def _fmt_commit(record: str) -> dict:
    """Parse a '%H\\x1f%an\\x1f%aI\\x1f%s' record into a revision dict."""
    f = (record.split("\x1f") + ["", "", "", ""])[:4]
    return {"sha": f[0], "short_sha": f[0][:7], "author": f[1], "date": f[2], "subject": f[3]}


def _git_doc_records(repo_rel: str, *opts):
    """git log --follow over one doc, returning the raw '\\x1f'-field records
    (newest-first) or None on failure. --follow keeps pre-rename commits."""
    r = _s.git("log", "--follow", *opts, "--format=%H\x1f%an\x1f%aI\x1f%s", "-z", "--", repo_rel)
    if r.returncode != 0:
        return None
    return [x for x in r.stdout.split("\x00") if x]


def _safe_path_prefix(prefix: str):
    """Validate a directory/file prefix for the history-search tools (which can't
    reuse _validate_doc_path — it requires a .md/.html suffix). Returns the cleaned
    prefix ('' = whole tree) or None if it tries to escape content/."""
    prefix = (prefix or "").strip()
    if not prefix:
        return ""
    if prefix.startswith("/") or ".." in prefix.split("/"):
        return None
    return prefix.strip("/")


def _parse_namestatus_log(stdout: str, excluded) -> list:
    """Parse `git log --format=%x1e… --name-status -z` into commit dicts with their
    changed DOC files. The leading \\x1e (record separator) delimits commits so the
    flat -z stream is unambiguous; R/C statuses carry two paths (old + new). Commits
    whose changed files are all excluded/non-doc are dropped."""
    out = []
    for rec in stdout.split("\x1e"):
        rec = rec.strip("\n")
        if not rec:
            continue
        head, _, rest = rec.partition("\x00")
        sha, an, aI, subj = (head.split("\x1f") + ["", "", "", ""])[:4]
        if not sha:
            continue
        # git inserts a '\n' between the format's \x00 terminator and the name-status
        # block, so the first status token arrives as '\nM' / '\nR100' — strip it.
        tokens = [t for t in (x.lstrip("\n") for x in rest.split("\x00")) if t]
        files = []
        i = 0
        while i < len(tokens):
            status = tokens[i]
            if status[:1] in ("R", "C") and i + 2 < len(tokens):
                new_rel = _strip_content(tokens[i + 2])
                if new_rel is not None and _history_path_included(new_rel, excluded):
                    files.append({"status": status[:1], "path": new_rel,
                                  "old_path": _strip_content(tokens[i + 1])})
                i += 3
            else:
                path = tokens[i + 1] if i + 1 < len(tokens) else ""
                rel = _strip_content(path)
                if rel is not None and _history_path_included(rel, excluded):
                    files.append({"status": status[:1] or "?", "path": rel})
                i += 2
        if files:
            out.append({"sha": sha, "short_sha": sha[:7], "author": an,
                        "date": aI, "subject": subj, "files": files})
    return out


def _numstat_first(stdout: str):
    """(added, removed) from the first `git diff --numstat` line; '-' (binary) -> 0."""
    for line in stdout.splitlines():
        parts = line.split("\t")
        if len(parts) >= 2:
            added = 0 if parts[0] == "-" else int(parts[0] or 0)
            removed = 0 if parts[1] == "-" else int(parts[1] or 0)
            return added, removed
    return 0, 0


def _doc_diff_between(repo_rel: str, base_sha: str, rev_sha: str):
    """Unified diff + (added, removed) for a doc between two resolved SHAs. Mirrors
    /api/diff: same-path -> pathspec diff; renamed-between-revs -> blob:blob diff;
    base == empty tree -> the doc's introduction. Returns (diff_text|None, +, -)."""
    to_path = _s._doc_path_at(repo_rel, rev_sha)
    if base_sha == _EMPTY_TREE:
        diff = _s.git("diff", base_sha, rev_sha, "--", to_path)
        num = _s.git("diff", "--numstat", base_sha, rev_sha, "--", to_path)
    else:
        from_path = _s._doc_path_at(repo_rel, base_sha)
        if from_path == to_path:
            diff = _s.git("diff", base_sha, rev_sha, "--", from_path)
            num = _s.git("diff", "--numstat", base_sha, rev_sha, "--", from_path)
        else:
            a, b = base_sha + ":" + from_path, rev_sha + ":" + to_path
            diff = _s.git("diff", a, b)
            num = _s.git("diff", "--numstat", a, b)
    if diff.returncode != 0:
        return None, 0, 0
    added, removed = _numstat_first(num.stdout)
    return diff.stdout, added, removed


def _parse_blame(stdout: str) -> list:
    """Parse `git blame --line-porcelain` into per-line attribution. --line-porcelain
    repeats every header for every line, so each line carries author/time/summary."""
    lines = []
    cur = {}
    for raw in stdout.split("\n"):
        if _BLAME_HEAD_RE.match(raw):
            p = raw.split(" ")
            cur = {"sha": p[0], "short_sha": p[0][:7], "line_no": int(p[2])}
        elif raw.startswith("author "):
            cur["author"] = raw[len("author "):]
        elif raw.startswith("author-time "):
            cur["_epoch"] = raw[len("author-time "):]
        elif raw.startswith("summary "):
            cur["subject"] = raw[len("summary "):]
        elif raw.startswith("\t"):
            try:
                date = datetime.datetime.fromtimestamp(
                    int(cur.get("_epoch", "")), datetime.timezone.utc).isoformat()
            except (ValueError, TypeError):
                date = ""
            lines.append({"line_no": cur.get("line_no"), "text": raw[1:],
                          "sha": cur.get("sha"), "short_sha": cur.get("short_sha"),
                          "author": cur.get("author", ""), "date": date,
                          "subject": cur.get("subject", "")})
            cur = {}
    return lines
