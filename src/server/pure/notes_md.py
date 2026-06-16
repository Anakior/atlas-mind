"""Pass-through annotations stored as sidecar JSON under CONFIG.notes_dir
(.notes/<rel>.json). Pure path resolution + IO; the config is read via the server
facade at call time."""
import json

import server as _s


def _notes_path(rel: str):
    """Resolves a doc's notes sidecar → Path under CONFIG.notes_dir, or None if
    rel is invalid / escapes the tree. `rel` is the POSIX path of the .md
    (e.g. notes/quick.md) → .notes/notes/quick.md.json."""
    rel = (rel or "").strip()
    if not rel or rel.startswith("/") or ".." in rel.split("/"):
        return None
    notes_dir = _s.CONFIG.notes_dir
    target = (notes_dir / (rel + ".json")).resolve()
    try:
        target.relative_to(notes_dir.resolve())
    except ValueError:
        return None
    return target


def load_notes(rel: str) -> list:
    """List of a doc's annotations (empty if no sidecar / unreadable)."""
    p = _notes_path(rel)
    if not p or not p.exists():
        return []
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    notes = data.get("notes") if isinstance(data, dict) else data
    return notes if isinstance(notes, list) else []


def save_notes(rel: str, notes: list) -> bool:
    """Writes (or deletes if empty) a doc's sidecar. True if written/deleted."""
    p = _notes_path(rel)
    if not p:
        return False
    if not notes:
        if p.exists():
            p.unlink()
        return True
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"version": 1, "notes": notes},
                            ensure_ascii=False, indent=1), encoding="utf-8")
    return True
