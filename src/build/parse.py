"""Pure parsing and indexing for the build pipeline — no IO, no config, no paths.

Frontmatter/tags, the [[wikilink]] graph and the GFM task rollup. Every function
here is pure, so it is unit-testable in isolation. The build facade re-exports
this surface: server.py reaches several via _import_build (_parse_frontmatter,
_folder_tags, _resolve_wikilink, _WIKILINK_RE, build_links_index,
build_tasks_index) and the tests import build.build_tasks_index."""
from __future__ import annotations

import re

_FM_RE = re.compile(r"^---[ \t]*\r?\n(.*?)\r?\n---[ \t]*\r?\n?", re.S)


def _parse_frontmatter(text: str) -> tuple[list[str], str]:
    """Separate the leading YAML frontmatter (--- ... ---) from the body.

    Returns (tags, body). Without frontmatter: ([], text)."""
    m = _FM_RE.match(text)
    if not m:
        return [], text
    return _parse_tags(m.group(1)), text[m.end():]


def _parse_tags(block: str) -> list[str]:
    """Parse the `tags:` key of a frontmatter block. Supports `tags: [a, b]`,
    `tags: a, b` and the indented list (`- a`). Normalizes to lowercase, dedupes."""
    lines = block.splitlines()
    raw: list[str] = []
    for i, line in enumerate(lines):
        m = re.match(r"^tags[ \t]*:[ \t]*(.*)$", line, re.I)
        if not m:
            continue
        val = m.group(1).strip()
        if val.startswith("[") and val.endswith("]"):
            raw = val[1:-1].split(",")
        elif val:
            raw = val.split(",")
        else:  # indented list on the following lines
            for ln in lines[i + 1:]:
                lm = re.match(r"^[ \t]*-[ \t]+(.*)$", ln)
                if lm:
                    raw.append(lm.group(1))
                elif ln.strip():
                    break
        break
    seen: set[str] = set()
    out: list[str] = []
    for t in raw:
        t = t.strip().strip('"\'').lower()
        if t and t not in seen:
            seen.add(t)
            out.append(t)
    return out


# Inbox triage envelope keys (cf. CDC inbox). Scalar whitelist, no YAML dependency.
_INBOX_KEYS = ("origin", "source", "captured_at", "confidence", "suggest_dest",
               "suggest_tags", "inbox_status", "snooze_until", "neighbors",
               "dedupe_key", "promoted_from", "supersedes")
_INBOX_LIST_KEYS = ("suggest_tags", "neighbors")
_INBOX_KEY_RE = re.compile(r"^([a-z_]+)[ \t]*:[ \t]*(.*)$", re.I)


def _inbox_meta(text: str) -> dict:
    """The inbox triage envelope read from a doc's frontmatter (defensive, whitelist only).

    Reads the leading --- block line by line, keeps known keys, defaults the rest
    (status -> 'pending', confidence -> 0.0). List values ([a, b] or a, b) split on
    commas. Unknown/malformed lines are ignored. Pure; no YAML dependency."""
    out: dict = {"inbox_status": "pending", "confidence": 0.0}
    m = _FM_RE.match(text)
    if not m:
        return out
    for line in m.group(1).splitlines():
        km = _INBOX_KEY_RE.match(line)
        if not km:
            continue
        key, val = km.group(1).lower(), km.group(2).strip()
        if key not in _INBOX_KEYS:
            continue
        if key in _INBOX_LIST_KEYS:
            out[key] = [x.strip().strip("'\"") for x in val.strip("[]").split(",") if x.strip()]
        elif key == "confidence":
            try:
                out[key] = float(val)
            except ValueError:
                out[key] = 0.0
        else:
            out[key] = val.strip("'\"")
    return out


def _rewrite_inbox_fm(text: str, updates: dict) -> str:
    """Return `text` with the frontmatter scalar keys in `updates` applied (a value of None
    deletes the key) in the leading --- block; a block is created if absent. Only the listed
    keys are touched, every other line is preserved verbatim. Used by Trash/Snooze, which
    flip inbox_status / snooze_until without rebuilding the doc. Pure."""
    m = _FM_RE.match(text)
    body = text[m.end():] if m else ("\n" + text if text else text)
    lines = m.group(1).splitlines() if m else []
    remaining = dict(updates)
    out = []
    for line in lines:
        km = _INBOX_KEY_RE.match(line)
        key = km.group(1).lower() if km else None
        if key in remaining:
            val = remaining.pop(key)
            if val is not None:
                out.append(f"{key}: {val}")
        else:
            out.append(line)
    for key, val in remaining.items():
        if val is not None:
            out.append(f"{key}: {val}")
    return "---\n" + "\n".join(out) + "\n---" + body


def _folder_tags(rel: str) -> list[str]:
    """Tags derived from parent folders (fallback when no explicit tag).

    `projets/alpha/doc.md` → ['projets', 'alpha']. Doc at the root → []."""
    parts = rel.split("/")[:-1]  # excludes the file name
    # Mirrors of remote nodes (remotes/<source>/…) don't pollute the tag space:
    # they already have their dedicated region in the Mind.
    if parts and parts[0] == "remotes":
        return []
    return [p.strip().lower() for p in parts if p.strip()]


_WIKILINK_RE = re.compile(r"\[\[([^\[\]\n]+?)\]\]")


def _resolve_wikilink(target: str, by_path: dict, by_stem: dict):
    """Resolve a [[...]] target (optional alias `target|text`) to a path, or None."""
    t = target.split("|", 1)[0].strip().lower()
    if not t:
        return None
    for cand in (t, t + ".md"):
        if cand in by_path:
            return by_path[cand]
    stem = t.rsplit("/", 1)[-1]
    if stem.endswith(".md"):
        stem = stem[:-3]
    return by_stem.get(stem)


def build_links_index(md_files: list[dict]) -> dict:
    """Graph of [[wikilinks]]: {path: {"out": [...], "in": [...]}}.

    Replaces the old index based on matching file names within the content
    (noisy): only explicit references between docs count now."""
    by_path = {f["path"].lower(): f["path"] for f in md_files}
    by_stem: dict[str, str] = {}
    for f in md_files:
        stem = re.sub(r"\.md$", "", f["name"], flags=re.I).lower()
        by_stem.setdefault(stem, f["path"])  # first wins on name ambiguity
    out_map: dict[str, set] = {f["path"]: set() for f in md_files}
    for f in md_files:
        for m in _WIKILINK_RE.finditer(f["body"]):
            tgt = _resolve_wikilink(m.group(1), by_path, by_stem)
            if tgt and tgt != f["path"]:
                out_map[f["path"]].add(tgt)
    in_map: dict[str, set] = {f["path"]: set() for f in md_files}
    for src, outs in out_map.items():
        for dst in outs:
            in_map[dst].add(src)
    index = {}
    for f in md_files:
        p = f["path"]
        o, i = sorted(out_map[p]), sorted(in_map[p])
        if o or i:
            index[p] = {"out": o, "in": i}
    return index


_TASK_RE = re.compile(r"^\s*[-*+]\s+\[([ xX])\]\s+(.+?)\s*$")


def build_tasks_index(md_files: list) -> list:
    """Flat rollup of every GFM checkbox across the mind: [{path, line, text, done}].

    Lines inside fenced code blocks (``` / ~~~) are ignored. Source = the same
    md_files as build_links_index, so excluded_names / dotfolders are already
    filtered out (and the dedicated [todo] file is in EXCLUDED_NAMES) — leaving a
    transversal view of the tasks scattered through the content. `line` is 1-based
    within the doc body and informational: the viewer navigates by matching text."""
    tasks = []
    for f in md_files:
        in_fence = False
        for i, line in enumerate((f.get("body") or "").split("\n"), start=1):
            stripped = line.lstrip()
            if stripped.startswith("```") or stripped.startswith("~~~"):
                in_fence = not in_fence
                continue
            if in_fence:
                continue
            m = _TASK_RE.match(line)
            if m:
                tasks.append({
                    "path": f["path"],
                    "line": i,
                    "text": m.group(2).strip(),
                    "done": m.group(1).lower() == "x",
                })
    return tasks

