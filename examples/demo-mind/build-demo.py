#!/usr/bin/env python3
"""Build the PUBLIC offline demo (docs/demo/index.html) with a CURATED git history.

Why this exists: examples/demo-mind is a sub-directory of the engine repo, so its
real git history is thin, single-author and `git log -- content` yields
repo-relative paths the activity layer can't map — the demo would show an EMPTY
activity home (the whole "your mind remembers who did what" pitch, invisible).

So we replay the demo content into a THROWAWAY git repo (content/ at its root, the
shape a real self-hosted mind has) with a hand-authored, back-dated, multi-author
history — some commits carrying the `X-Atlas-Author: ai/claude` trailer the engine
writes for AI edits — then run the normal offline build against it. The activity
snapshot (_snapshot_activity in build/__main__) is then computed from a real,
showcase-worthy history: a populated Journal + Constellation, AI badges, a couple
of stale docs, and contradiction candidates.

The final content state of every doc EQUALS the real examples/demo-mind/content,
so nothing fake ships in the docs themselves — only the (synthetic) authorship
timeline differs from the engine repo's. Run it from anywhere:

    python examples/demo-mind/build-demo.py
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SRC = REPO / "src"
DEMO = REPO / "examples" / "demo-mind"
CONTENT = DEMO / "content"
OUT = REPO / "docs" / "demo" / "index.html"

# Fictional cast — the tone is irrelevant, the point is to exercise every facet of
# the activity layer: several humans (constellation), the remote garden's owner
# (Hive collaboration), the sync bot, and AI-attributed edits (the badge).
AUTHORS = {
    "sasha": ("Sasha Rives", "sasha@example.com"),
    "theo": ("Theo Lambert", "theo@example.com"),
    "mira": ("Mira Vance", "mira@example.com"),     # owner of remotes/mira-garden
    "bot": ("Atlas Bot", "atlas-bot@example.com"),  # hive re-sync
}

# One note is created under a working name then RENAMED to its final path (Atlas
# rewrites incoming [[wikilinks]] on a move) — shows a "moved:" event.
MOVE_TMP = "guides/getting-started.md"
MOVE_FINAL = "guides/getting-started-checklist.md"

# (days_ago, author, ai, kind, arg). Events are committed OLDEST first (chronological
# order, so `git log` — hence the Journal — reads newest-first correctly). Commits
# sharing a `days_ago` land on the SAME day → the Journal groups them under one day
# header instead of one-event-per-day clutter. A path written N times is created
# once then edited N-1 times (body grown back paragraph by paragraph, real diffs).
# why-not-notion + multi-formats are created long ago and never touched → they
# surface in Health/obsolescence (stale > 6 months).
EVENTS = [
    # — foundational, long ago (the two that go stale) —
    (250, "sasha", None, "w", "notes/why-not-notion.md"),
    (232, "sasha", None, "w", "multi-formats.md"),
    (228, "sasha", None, "w", "welcome.md"),
    (210, "sasha", None, "w", "features/own-your-data.md"),
    # — the recent build-up, clustered into active days —
    (54, "sasha", None, "w", "features/the-mind-graph.md"),
    (54, "theo", None, "w", "features/ai-native.md"),
    (47, "sasha", None, "w", "guides/install-and-setup.md"),
    (47, "theo", None, "w", "guides/markdown-showcase.md"),
    (47, "sasha", "claude", "w", "features/ai-native.md"),
    (41, "sasha", None, "w", "guides/wikilinks-and-backlinks.md"),
    (41, "theo", None, "w", "features/collaboration.md"),
    (41, "sasha", "claude", "w", "features/the-mind-graph.md"),
    (34, "mira", None, "w", "remotes/mira-garden/start-here.md"),
    (34, "mira", None, "w", "remotes/mira-garden/zettelkasten.md"),
    (34, "sasha", None, "w", "guides/hive-mind.md"),
    (22, "theo", None, "w", "decks/atlas-dashboard.html"),
    (22, "sasha", None, "w", MOVE_TMP),
    (22, "sasha", None, "w", "features/activity-and-attribution.md"),
    (13, "sasha", "claude", "w", "features/activity-and-attribution.md"),
    (13, "sasha", None, "mv", (MOVE_TMP, MOVE_FINAL)),
    (13, "sasha", None, "w", "welcome.md"),
    (6, "sasha", "claude", "w", "features/own-your-data.md"),
    (6, "bot", None, "w", "remotes/mira-garden/zettelkasten.md"),
    (6, "theo", None, "w", "features/collaboration.md"),
    (2, "sasha", None, "w", "features/the-mind-graph.md"),
]

NOW = dt.datetime.now()


def rel_no_ext(rel: str) -> str:
    return re.sub(r"\.(md|html)$", "", rel)


def _split_frontmatter(text: str):
    if text.startswith("---\n"):
        end = text.find("\n---\n", 4)
        if end != -1:
            cut = end + len("\n---\n")
            return text[:cut], text[cut:]
    return "", text


def grow_versions(text: str, n_edits: int) -> list:
    """n_edits+1 cumulative versions of `text`: the create holds back the last
    n_edits body paragraphs, each edit adds one back, the last == `text` exactly.
    Falls back to fewer edits when the body is too short to split."""
    if n_edits <= 0:
        return [text]
    fm, body = _split_frontmatter(text)
    paras = body.split("\n\n")
    n_edits = min(n_edits, max(0, len(paras) - 1))
    if n_edits == 0:
        return [text]
    base = len(paras) - n_edits
    out = [fm + "\n\n".join(paras[:base + k]) for k in range(n_edits + 1)]
    out[-1] = text
    return out


def git(repo: Path, *args, env=None):
    subprocess.run(["git", *args], cwd=repo, env=env, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def commit(repo: Path, days_ago: int, author_key: str, ai, subject: str, seq: int):
    """Commit staged changes with a back-dated author/committer identity (`seq`
    spaces same-day commits a minute apart so their order is stable), plus the AI
    trailer when `ai` is set (mirrors the engine's MCP-write attribution)."""
    name, email = AUTHORS[author_key]
    when = ((NOW - dt.timedelta(days=days_ago)).replace(
        hour=10, minute=0, second=0, microsecond=0) + dt.timedelta(minutes=seq))
    stamp = when.strftime("%Y-%m-%dT%H:%M:%S")
    env = dict(os.environ,
               GIT_AUTHOR_NAME=name, GIT_AUTHOR_EMAIL=email, GIT_AUTHOR_DATE=stamp,
               GIT_COMMITTER_NAME=name, GIT_COMMITTER_EMAIL=email,
               GIT_COMMITTER_DATE=stamp)
    msg = subject if not ai else f"{subject}\n\nX-Atlas-Author: ai/{ai}"
    git(repo, "commit", "-m", msg, env=env)


def build_history(repo: Path):
    (repo / "content").mkdir(parents=True, exist_ok=True)
    git(repo, "init", "-q")

    # Per-path version stream (create + grown-back edits). The move's working-name
    # file is seeded with the FINAL doc's content so the rename ends at the real doc.
    writes = {}
    for _d, _a, _ai, kind, arg in EVENTS:
        if kind == "w":
            writes[arg] = writes.get(arg, 0) + 1
    streams = {}
    for path, n in writes.items():
        src = MOVE_FINAL if path == MOVE_TMP else path
        streams[path] = iter(grow_versions((CONTENT / src).read_text(encoding="utf-8"), n - 1))

    created = set()
    for seq, (days_ago, author, ai, kind, arg) in enumerate(
            sorted(EVENTS, key=lambda e: -e[0])):
        if kind == "mv":
            frm, to = arg
            git(repo, "mv", f"content/{frm}", f"content/{to}")
            subject = f"moved: {rel_no_ext(frm)} → {rel_no_ext(to)}"
        else:
            dest = repo / "content" / arg
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(next(streams[arg]), encoding="utf-8")
            git(repo, "add", "-A")
            verb = "created" if arg not in created else "edited"
            created.add(arg)
            subject = f"{verb}: {rel_no_ext(arg)}"
        commit(repo, days_ago, author, ai, subject, seq)

    # Sidecar annotations + config ship as-is (read from disk by the build, not git).
    if (DEMO / ".notes").is_dir():
        shutil.copytree(DEMO / ".notes", repo / ".notes", dirs_exist_ok=True)
    shutil.copy2(DEMO / "atlas.toml", repo / "atlas.toml")


def trim_contradictions(html_path: Path, keep: int = 5):
    """The corpus yields ~50 contradiction CANDIDATES (every shared-tag pair). For
    the demo, keep only the few highest-overlap ones so Health/contradictions reads
    as a curated shortlist, not a wall. Rewrites the single EMBED_ACTIVITY line."""
    prefix = "const EMBED_ACTIVITY = "
    lines = html_path.read_text(encoding="utf-8").splitlines(keepends=True)
    for i, line in enumerate(lines):
        if not line.startswith(prefix):
            continue
        payload = line[len(prefix):].rstrip().rstrip(";")
        data = json.loads(payload)
        if isinstance(data, dict) and data.get("contradictions"):
            data["contradictions"] = data["contradictions"][:keep]
            enc = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
            lines[i] = f"{prefix}{enc};\n"
            html_path.write_text("".join(lines), encoding="utf-8")
        return


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="atlas-demo-"))
    try:
        repo = tmp / "mind"
        build_history(repo)
        env = dict(os.environ, ATLAS_MIND=str(repo))
        subprocess.run([sys.executable, str(SRC / "cli.py"), "build",
                        str(repo), "--offline"], cwd=REPO, env=env, check=True)
        OUT.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(repo / "dist" / "index-offline.html", OUT)
        trim_contradictions(OUT)
        print(f"Demo written -> {OUT.relative_to(REPO)} ({OUT.stat().st_size:,} bytes)")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
