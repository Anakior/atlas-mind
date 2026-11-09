"""Todo persistence as GFM checkboxes in CONFIG.todo_file, grouped by H2 section
(## Travail / ## Personnel). Pure parse + IO; the config is read via the server
facade at call time.

Each todo keeps its id for good (`- [ ] text <!-- id:N -->` in the markdown, an
HTML comment the rendered doc doesn't show): a toggle or a delete sent from a
device whose list is out of date reaches that todo or none, never its neighbour."""
import re
import time

import server as _s

TODO_HEADER = "# To-do\n\nEditable from the widget in the bottom-right of the viewer.\n\n"
_ID_MARK = re.compile(r"^(.*?)\s*<!--\s*id:(\d+)\s*-->\s*$")


def _norm_cat(value):
    # Categories (CONFIG.todo_categories) stored under H2 sections; unknown
    # values fall back to the default.
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
        text, tid = m.group(2), None
        marked = _ID_MARK.match(text)
        if marked:
            text, tid = marked.group(1), int(marked.group(2))
        items.append({
            "id": tid,
            "text": text.strip(),
            "done": m.group(1).lower() == "x",
            "cat": cat,
        })
    return stable_ids(items)


def stable_ids(todos):
    """Give each todo a unique id, kept across writes. One without (written by
    hand, or stored when ids were positions) or repeating an earlier one gets the
    next free number in list order: the same on every device until the next
    write records it."""
    valid = [t["id"] for t in todos if type(t.get("id")) is int and t["id"] >= 0]
    nxt = max(valid, default=-1) + 1
    seen = set()
    for t in todos:
        tid = t.get("id")
        if type(tid) is not int or tid < 0 or tid in seen:
            t["id"] = tid = nxt
            nxt += 1
        seen.add(tid)
    return todos


def new_todo_id(todos):
    """An id this list never had: the clock in ms, or past the highest id if the
    clock is behind. Never a deleted todo's id, which a stale device may still send."""
    return max(int(time.time() * 1000), max((t["id"] for t in todos), default=-1) + 1)


def find_todo(todos, tid):
    return next((t for t in todos if t["id"] == tid), None)


def _write_todos_md(todos):
    # LEGACY single-list storage (LOCAL mode): GFM checkboxes grouped by H2 section,
    # git-versioned in CONFIG.todo_file. Every section is always emitted (even empty)
    # to keep the file stable.
    parts = []
    for cat in _s.CONFIG.todo_categories:
        parts.append("## {}\n\n".format(_s.CONFIG.todo_cat_headers[cat]))
        for t in todos:
            if _norm_cat(t.get("cat")) == cat:
                parts.append("- [{m}] {txt} <!-- id:{id} -->\n".format(
                    m="x" if t["done"] else " ", txt=t["text"], id=t["id"]))
        parts.append("\n")
    _s.CONFIG.todo_file.parent.mkdir(parents=True, exist_ok=True)
    _s.CONFIG.todo_file.write_text(TODO_HEADER + "".join(parts), encoding="utf-8", newline="\n")


def _load_todos_md():
    if not _s.CONFIG.todo_file.exists():
        return []
    return parse_todos(_s.CONFIG.todo_file.read_text(encoding="utf-8"))


def write_todos(email, todos):
    """Persist a todo list. LOCAL mode (solo operator, no auth) → the legacy single
    markdown list (git-versioned). CLOUD → the member's OWN private list in
    .atlas/todos.json (never git-committed)."""
    if not _s.CONFIG.auth_enabled:
        _write_todos_md(todos)
    else:
        _s.get_store().save_user_todos(email, todos)


def load_todos(email, is_admin=False):
    """A todo list. LOCAL mode → the legacy single markdown list. CLOUD → the
    member's OWN private list.

    PREPARED lazy migration (cloud, non-destructive): the legacy GLOBAL markdown
    (`CONFIG.todo_file`, pre-per-member) seeds the FIRST admin whose per-account
    entry is still absent — runs once, automatically, the first time an admin loads
    their todos on the new version, and KEEPS the legacy file intact (nothing
    deleted). An instance that never deploys this sees nothing happen."""
    if not _s.CONFIG.auth_enabled:
        return _load_todos_md()
    store = _s.get_store()
    todos = store.load_user_todos(email)
    if todos is not None:
        # A list stored when ids were positions can hold repeats: repaired here,
        # recorded by the next write.
        return stable_ids(todos)
    if is_admin and _s.CONFIG.todo_file.exists():
        legacy = _load_todos_md()
        if legacy:
            store.save_user_todos(email, legacy)  # migrate; legacy markdown untouched
            return legacy
    return []
