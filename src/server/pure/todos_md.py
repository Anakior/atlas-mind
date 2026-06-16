"""Todo persistence as GFM checkboxes in CONFIG.todo_file, grouped by H2 section
(## Travail / ## Personnel). Pure parse + IO; the config is read via the server
facade at call time."""
import re

import server as _s

TODO_HEADER = "# To-do\n\nEditable from the widget in the bottom-right of the viewer.\n\n"


def _norm_cat(value):
    # Todo categories (CONFIG.todo_categories, default "travail"/"personnel"):
    # stored in the todo file under H2 sections (## Travail / ## Personnel);
    # the widget filters by category. See parse_todos / write_todos.
    v = (value or "").strip().lower()
    return v if v in _s.CONFIG.todo_categories else _s.CONFIG.todo_cat_default


def parse_todos(text):
    items = []
    cat = _s.CONFIG.todo_cat_default
    header_to_cat = {label.lower(): key
                     for key, label in _s.CONFIG.todo_cat_headers.items()}
    for line in text.splitlines():
        hm = re.match(r"^##\s+(.+?)\s*$", line)
        if hm:
            cat = header_to_cat.get(hm.group(1).strip().lower(), cat)
            continue
        m = re.match(r"^- \[([ xX])\] (.+)$", line)
        if not m:
            continue
        items.append({
            "id": len(items),
            "text": m.group(2).strip(),
            "done": m.group(1).lower() == "x",
            "cat": cat,
        })
    return items


def write_todos(todos):
    # Grouped by H2 section (## Travail / ## Personnel). We always emit every
    # section to keep the todo file readable and stable, even when empty.
    parts = []
    for cat in _s.CONFIG.todo_categories:
        parts.append("## {}\n\n".format(_s.CONFIG.todo_cat_headers[cat]))
        for t in todos:
            if _norm_cat(t.get("cat")) == cat:
                parts.append("- [{m}] {txt}\n".format(
                    m="x" if t["done"] else " ", txt=t["text"]))
        parts.append("\n")
    _s.CONFIG.todo_file.parent.mkdir(parents=True, exist_ok=True)
    _s.CONFIG.todo_file.write_text(TODO_HEADER + "".join(parts), encoding="utf-8")


def load_todos():
    if not _s.CONFIG.todo_file.exists():
        return []
    return parse_todos(_s.CONFIG.todo_file.read_text(encoding="utf-8"))
