"""Annotation (note) routes: list / create / patch / delete a doc's annotations."""
import time
import uuid
import server as _s


def list_notes(handler):
    """GET /api/notes?path=<rel> — the annotations of a doc (auth)."""
    from urllib.parse import urlparse, parse_qs as _pqs
    rel = (_pqs(urlparse(handler.path).query).get("path", [""])[0] or "").strip()
    if _s._notes_path(rel) is None:
        handler._send_json(400, {"error": "invalid path"})
        return
    handler._send_json(200, _s.load_notes(rel))


def create(handler):
    """POST /api/notes — attach an annotation to a doc selection."""
    data = handler._read_json()
    rel = (data.get("path") or "").strip()
    if _s._notes_path(rel) is None:
        handler._send_json(400, {"error": "invalid path"})
        return
    note_text = (data.get("note") or "").strip()
    exact = (data.get("exact") or "").strip()
    if not note_text or not exact:
        handler._send_json(400, {"error": "note and exact required"})
        return
    note = {
        "id": uuid.uuid4().hex[:12],
        "exact": exact[:2000],
        "prefix": (data.get("prefix") or "")[:120],
        "suffix": (data.get("suffix") or "")[:120],
        "pos": _s._safe_int(data.get("pos")),
        "note": note_text[:5000],
        "created": int(time.time()),
    }
    # Notes are SHARED (git-tracked, visible to every member) — record who wrote it,
    # so with several admins you can tell annotations apart. Only in cloud mode:
    # local mode is single-operator (the synthetic "local" admin) — no real author.
    if _s.CONFIG.auth_enabled:
        author = (handler._session() or {}).get("email")
        if author:
            note["author"] = author
    notes = _s.load_notes(rel)
    notes.append(note)
    _s.save_notes(rel, notes)
    _s.trigger_sync()
    handler._send_json(200, note)


def patch(handler):
    """PATCH /api/notes?path=<rel>&id=<id> — edit an annotation's text
    (admin + CSRF already enforced by the verb-level guard in do_PATCH)."""
    from urllib.parse import urlparse, parse_qs as _pqs
    q = _pqs(urlparse(handler.path).query)
    rel = (q.get("path", [""])[0] or "").strip()
    note_id = (q.get("id", [""])[0] or "").strip()
    if _s._notes_path(rel) is None or not note_id:
        handler._send_json(400, {"error": "path and id required"})
        return
    note_text = (handler._read_json().get("note") or "").strip()
    if not note_text:
        handler._send_json(400, {"error": "empty note"})
        return
    notes = _s.load_notes(rel)
    hit = next((n for n in notes if n.get("id") == note_id), None)
    if hit is None:
        handler._send_json(404, {"error": "not found"})
        return
    hit["note"] = note_text[:5000]
    hit["updated"] = int(time.time())
    _s.save_notes(rel, notes)
    _s.trigger_sync()
    handler._send_json(200, hit)


def delete(handler):
    """DELETE /api/notes?path=<rel>&id=<id> — remove an annotation (admin +
    CSRF already enforced by the verb-level guard in do_DELETE)."""
    from urllib.parse import urlparse, parse_qs as _pqs
    q = _pqs(urlparse(handler.path).query)
    rel = (q.get("path", [""])[0] or "").strip()
    note_id = (q.get("id", [""])[0] or "").strip()
    if _s._notes_path(rel) is None or not note_id:
        handler._send_json(400, {"error": "path and id required"})
        return
    notes = _s.load_notes(rel)
    kept = [n for n in notes if n.get("id") != note_id]
    if len(kept) == len(notes):
        handler._send_json(404, {"error": "not found"})
        return
    _s.save_notes(rel, kept)
    _s.trigger_sync()
    handler._send_json(200, {"ok": True})
