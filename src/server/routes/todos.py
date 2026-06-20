"""Per-member todo routes: list, create, patch (toggle/edit), delete.

Each account keeps its OWN private list (.atlas/todos.json keyed by email, never
git-committed). A non-admin member manages only their own list. A legacy global
list is migrated to the first admin lazily (see todos_md.load_todos)."""
import server as _s


def _identity(handler):
    """(email, is_admin) of the caller, for the per-member list. Local mode (no
    auth) = the solo operator → a stable "_local" key, admin-level."""
    sess = handler._session() or {}
    return (sess.get("email") or "_local",
            (not _s.CONFIG.auth_enabled) or sess.get("role") == "admin")


def list_todos(handler):
    """GET /api/todos — the CALLER's own todo list (auth)."""
    email, is_admin = _identity(handler)
    handler._send_json(200, _s.load_todos(email, is_admin))


def create(handler):
    """POST /api/todos — append a todo to the caller's own list."""
    email, is_admin = _identity(handler)
    data = handler._read_json()
    text = (data.get("text") or "").strip()
    if not text:
        handler._send_json(400, {"error": "empty text"})
        return
    todos = _s.load_todos(email, is_admin)
    todos.append({"id": len(todos), "text": text, "done": False,
                  "cat": _s._norm_cat(data.get("cat"))})
    _s.write_todos(email, todos)
    _s.trigger_sync()  # local mode: commit the markdown list; no-op in cloud (.atlas gitignored)
    handler._send_json(200, _s.load_todos(email, is_admin))


def patch(handler):
    """PATCH /api/todos/<idx> — toggle done / edit text or category, in the
    caller's own list."""
    email, is_admin = _identity(handler)
    idx = handler._todo_index_from_path()
    data = handler._read_json()
    todos = _s.load_todos(email, is_admin)
    if idx < 0 or idx >= len(todos):
        handler._send_json(404, {"error": "not found"})
        return
    if "done" in data:
        todos[idx]["done"] = bool(data["done"])
    if "text" in data and data["text"].strip():
        todos[idx]["text"] = data["text"].strip()
    if "cat" in data:
        todos[idx]["cat"] = _s._norm_cat(data["cat"])
    _s.write_todos(email, todos)
    _s.trigger_sync()  # local mode: commit the markdown list; no-op in cloud (.atlas gitignored)
    handler._send_json(200, _s.load_todos(email, is_admin))


def delete(handler):
    """DELETE /api/todos/<idx> — remove a todo from the caller's own list."""
    email, is_admin = _identity(handler)
    idx = handler._todo_index_from_path()
    todos = _s.load_todos(email, is_admin)
    if idx < 0 or idx >= len(todos):
        handler._send_json(404, {"error": "not found"})
        return
    todos.pop(idx)
    _s.write_todos(email, todos)
    _s.trigger_sync()  # local mode: commit the markdown list; no-op in cloud (.atlas gitignored)
    handler._send_json(200, _s.load_todos(email, is_admin))
