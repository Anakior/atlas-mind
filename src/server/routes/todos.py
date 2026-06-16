"""Todo list routes: list, create, patch (toggle/edit), and delete items."""
import server as _s


def list_todos(handler):
    """GET /api/todos — the todo list (auth)."""
    handler._send_json(200, _s.load_todos())


def create(handler):
    """POST /api/todos — append a todo item."""
    data = handler._read_json()
    text = (data.get("text") or "").strip()
    if not text:
        handler._send_json(400, {"error": "empty text"})
        return
    todos = _s.load_todos()
    todos.append({"id": len(todos), "text": text, "done": False,
                  "cat": _s._norm_cat(data.get("cat"))})
    _s.write_todos(todos)
    _s.trigger_sync()
    handler._send_json(200, _s.load_todos())


def patch(handler):
    """PATCH /api/todos/<idx> — toggle done / edit text or category (admin +
    CSRF already enforced by the verb-level guard in do_PATCH)."""
    idx = handler._todo_index_from_path()
    data = handler._read_json()
    todos = _s.load_todos()
    if idx < 0 or idx >= len(todos):
        handler._send_json(404, {"error": "not found"})
        return
    if "done" in data:
        todos[idx]["done"] = bool(data["done"])
    if "text" in data and data["text"].strip():
        todos[idx]["text"] = data["text"].strip()
    if "cat" in data:
        todos[idx]["cat"] = _s._norm_cat(data["cat"])
    _s.write_todos(todos)
    _s.trigger_sync()
    handler._send_json(200, _s.load_todos())


def delete(handler):
    """DELETE /api/todos/<idx> — remove a todo (admin + CSRF already enforced by
    the verb-level guard in do_DELETE)."""
    idx = handler._todo_index_from_path()
    todos = _s.load_todos()
    if idx < 0 or idx >= len(todos):
        handler._send_json(404, {"error": "not found"})
        return
    todos.pop(idx)
    _s.write_todos(todos)
    _s.trigger_sync()
    handler._send_json(200, _s.load_todos())
