"""Characterization tests for the /api/todos endpoints (src/server.py).

Scope: GET/POST /api/todos, PATCH/DELETE /api/todos/:id, persistence in
content/notes/quick.md (H2 Work/Personal sections, GFM checkboxes).

Behaviors ENCODED AS-IS (quirks included):
- A todo's id is its own and stable: a write never renumbers the others, so a
  toggle or a delete sent from a device whose list is out of date reaches that
  todo or none (404), never its neighbour. The markdown records it as an HTML
  comment (`- [ ] text <!-- id:N -->`), invisible in the rendered doc.
- A file written before ids were stored (no comment) still reads: its todos get
  0..n-1 in file order, the same on every device, recorded by the next write.
- A new todo's id is one the list never had (the clock in ms): a deleted id is
  never handed out again.
- write_todos groups by section (Work first, then Personal): a "work" POST is
  written BEFORE the personal items; a PATCH cat moves the item to its section.
- Unknown category (POST or PATCH) -> silently falls back to "work".
- A text containing a newline + "- [ ]" injects extra todos into the markdown
  (no sanitization).
"""
import time
import unittest

from harness import AtlasServer, DEFAULT_MIND, TODO_REL

TODO_HEADER = (
    "# To-do\n\n"
    "Editable from the widget in the bottom-right of the viewer.\n\n"
)


def read_quick_md(srv: AtlasServer) -> str:
    return srv.path(TODO_REL).read_text(encoding="utf-8")


class TestReadTodos(unittest.TestCase):
    """GET /api/todos on the default mind (read-only -> shared server)."""

    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer()
        cls.addClassCleanup(cls.srv.stop)
        cls.srv.start()

    def test_get_numbers_a_file_without_ids_in_file_order(self):
        status, headers, _ = resp = self.srv.get("/api/todos")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Content-Type"),
                         "application/json; charset=utf-8")
        # The default quick.md predates stored ids: 0..n-1 in file order.
        self.assertEqual(resp.json(), [
            {"id": 0, "text": "Préparer le bilan mensuel", "done": False,
             "cat": "work"},
            {"id": 1, "text": "Review the draft", "done": True,
             "cat": "work"},
            {"id": 2, "text": "Tester le build PoE", "done": False,
             "cat": "personal"},
        ])

    def test_get_item_url_is_not_routed(self):
        # No GET /api/todos/:id route: the path falls back to the static
        # handler (content/api/todos/0 does not exist) -> 404 HTML page from
        # http.server, not JSON.
        status, headers, body = self.srv.get("/api/todos/0")
        self.assertEqual(status, 404)
        self.assertIn("text/html", headers.get("Content-Type", ""))
        self.assertNotIn(b'"error"', body)


class TestParseQuirks(unittest.TestCase):
    """Characterization of parse_todos via a custom quick.md (read-only)."""

    QUICK_MD = (
        "# To-do\n\n"
        "- [ ] avant toute section\n\n"
        "## PERSONAL\n\n"
        "- [ ] sous personal en majuscules\n\n"
        "## Divers\n\n"
        "- [x] sous un header inconnu\n\n"
        "## Work\n\n"
        "- [ ] sous work\n"
    )

    @classmethod
    def setUpClass(cls):
        mind = dict(DEFAULT_MIND)
        mind[TODO_REL] = cls.QUICK_MD
        cls.srv = AtlasServer(mind=mind)
        cls.addClassCleanup(cls.srv.stop)
        cls.srv.start()
        cls.todos = cls.srv.get("/api/todos").json()

    def test_items_before_any_section_default_to_work(self):
        self.assertEqual(self.todos[0]["text"], "avant toute section")
        self.assertEqual(self.todos[0]["cat"], "work")

    def test_section_header_matching_is_case_insensitive(self):
        # "## PERSONAL" is recognized as the personal section.
        self.assertEqual(self.todos[1]["text"], "sous personal en majuscules")
        self.assertEqual(self.todos[1]["cat"], "personal")

    def test_unknown_section_header_keeps_previous_category(self):
        # "## Divers" is neither Work nor Personal: the CURRENT category is
        # kept (personal, inherited from the previous section) -- it does NOT
        # fall back to the work default.
        self.assertEqual(self.todos[2]["text"], "sous un header inconnu")
        self.assertEqual(self.todos[2]["cat"], "personal")
        self.assertTrue(self.todos[2]["done"])
        self.assertEqual(self.todos[3]["cat"], "work")


class TestStoredIds(unittest.TestCase):
    """Ids recorded in the markdown, mixed with lines written by hand."""

    QUICK_MD = TODO_HEADER + (
        "## Work\n\n"
        "- [ ] gardé <!-- id:7 -->\n"
        "- [ ] ajouté à la main\n"
        "- [x] copié-collé <!-- id:7 -->\n"
        "\n"
        "## Personal\n\n"
        "- [ ] perso <!--id:3-->\n"
        "\n"
    )

    @classmethod
    def setUpClass(cls):
        mind = dict(DEFAULT_MIND)
        mind[TODO_REL] = cls.QUICK_MD
        cls.srv = AtlasServer(mind=mind)
        cls.addClassCleanup(cls.srv.stop)
        cls.srv.start()

    def test_recorded_ids_are_read_and_the_comment_left_out_of_the_text(self):
        todos = self.srv.get("/api/todos").json()
        self.assertEqual([(t["id"], t["text"]) for t in todos], [
            (7, "gardé"),
            # No id, or one already taken: the next free numbers, in file order.
            (8, "ajouté à la main"),
            (9, "copié-collé"),
            (3, "perso"),
        ])

    def test_the_same_ids_on_every_read(self):
        first = self.srv.get("/api/todos").json()
        self.assertEqual(self.srv.get("/api/todos").json(), first)


class TestCreateTodo(unittest.TestCase):
    """POST /api/todos -- one server per test (each test writes)."""

    def test_post_without_cat_defaults_to_work_and_leaves_other_ids(self):
        with AtlasServer() as srv:
            resp = srv.post("/api/todos", json_body={"text": "Nouvelle tâche"})
            self.assertEqual(resp.status, 200)
            todos = resp.json()
            self.assertEqual(len(todos), 4)
            # Written at the end of the Work section, hence BEFORE the personal
            # item -- which keeps its id 2.
            created = todos[2]
            self.assertEqual({k: created[k] for k in ("text", "done", "cat")},
                             {"text": "Nouvelle tâche", "done": False, "cat": "work"})
            self.assertNotIn(created["id"], (0, 1, 2))
            self.assertEqual(todos[3], {"id": 2, "text": "Tester le build PoE",
                                        "done": False, "cat": "personal"})

    def test_post_personal_category_accepts_mixed_case(self):
        with AtlasServer() as srv:
            # _norm_cat strips and lowercases the received category.
            todos = srv.post("/api/todos", json_body={
                "text": "Course du soir", "cat": "  PerSonAl "}).json()
            self.assertEqual((todos[-1]["text"], todos[-1]["cat"]),
                             ("Course du soir", "personal"))

    def test_post_unknown_cat_falls_back_to_work(self):
        with AtlasServer() as srv:
            todos = srv.post("/api/todos", json_body={
                "text": "Catégorie exotique", "cat": "boulot"}).json()
            created = [t for t in todos if t["text"] == "Catégorie exotique"]
            self.assertEqual(len(created), 1)
            self.assertEqual(created[0]["cat"], "work")

    def test_post_empty_or_blank_text_returns_400(self):
        with AtlasServer() as srv:
            resp = srv.post("/api/todos", json_body={})
            self.assertEqual(resp.status, 400)
            self.assertEqual(resp.json(), {"error": "empty text"})
            resp = srv.post("/api/todos", json_body={"text": "   "})
            self.assertEqual(resp.status, 400)
            self.assertEqual(resp.json(), {"error": "empty text"})
            # Nothing was written to disk.
            self.assertEqual(len(srv.get("/api/todos").json()), 3)

    def test_post_writes_exact_markdown(self):
        with AtlasServer() as srv:
            todos = srv.post("/api/todos", json_body={"text": "Nouvelle tâche"}).json()
            new_id = todos[2]["id"]
            # The ids the old file was read with are recorded along the way.
            self.assertEqual(read_quick_md(srv), TODO_HEADER + (
                "## Work\n\n"
                "- [ ] Préparer le bilan mensuel <!-- id:0 -->\n"
                "- [x] Review the draft <!-- id:1 -->\n"
                f"- [ ] Nouvelle tâche <!-- id:{new_id} -->\n"
                "\n"
                "## Personal\n\n"
                "- [ ] Tester le build PoE <!-- id:2 -->\n"
                "\n"
            ))

    def test_post_creates_quick_md_when_missing(self):
        # Custom mind without quick.md: GET -> [], POST creates the full file
        # (header + BOTH sections, even the empty one).
        with AtlasServer(mind={"accueil.md": "# Accueil\n"}) as srv:
            self.assertEqual(srv.get("/api/todos").json(), [])
            todos = srv.post("/api/todos",
                             json_body={"text": "Premier item"}).json()
            self.assertEqual(len(todos), 1)
            self.assertEqual(todos[0]["text"], "Premier item")
            self.assertEqual(read_quick_md(srv), TODO_HEADER + (
                "## Work\n\n"
                f"- [ ] Premier item <!-- id:{todos[0]['id']} -->\n"
                "\n"
                "## Personal\n\n"
                "\n"
            ))

    def test_a_deleted_id_is_never_handed_out_again(self):
        with AtlasServer(mind={"accueil.md": "# Accueil\n"}) as srv:
            first = srv.post("/api/todos", json_body={"text": "a"}).json()[0]["id"]
            srv.delete(f"/api/todos/{first}")
            again = srv.post("/api/todos", json_body={"text": "b"}).json()[0]["id"]
            self.assertNotEqual(again, first)

    def test_post_text_with_checkbox_newline_injects_extra_todo(self):
        with AtlasServer() as srv:
            # SURPRISE: the text is not sanitized. A newline followed by
            # "- [ ]" is written as-is into the markdown, then re-read as TWO
            # distinct todos -- POSTing one item creates two.
            todos = srv.post("/api/todos", json_body={
                "text": "vrai item\n- [ ] item injecté"}).json()
            self.assertEqual(len(todos), 5)
            self.assertEqual(todos[2]["text"], "vrai item")
            self.assertEqual(todos[3]["text"], "item injecté")
            self.assertEqual(len({t["id"] for t in todos}), 5)

    def test_post_triggers_background_git_commit(self):
        with AtlasServer() as srv:
            srv.post("/api/todos", json_body={"text": "Commit-moi"})
            # trigger_sync is asynchronous: the response returns before the commit.
            deadline = time.monotonic() + 10
            log = ""
            while time.monotonic() < deadline:
                log = srv.git("log", "--oneline").stdout
                if "docs: update via viewer" in log:
                    break
                time.sleep(0.1)
            self.assertIn("docs: update via viewer", log)
            show = srv.git("show", "--stat", "HEAD").stdout
            self.assertIn(TODO_REL, show)


class TestPatchTodo(unittest.TestCase):
    """PATCH /api/todos/:id -- one server per test."""

    def test_patch_toggles_done_and_persists_marker(self):
        with AtlasServer() as srv:
            todos = srv.patch("/api/todos/0", json_body={"done": True}).json()
            self.assertTrue(todos[0]["done"])
            self.assertIn("- [x] Préparer le bilan mensuel", read_quick_md(srv))
            todos = srv.patch("/api/todos/1", json_body={"done": False}).json()
            self.assertFalse(todos[1]["done"])
            self.assertIn("- [ ] Review the draft", read_quick_md(srv))

    def test_patch_done_coerces_any_truthy_value(self):
        with AtlasServer() as srv:
            # bool(1) -> True: no type validation.
            todos = srv.patch("/api/todos/0", json_body={"done": 1}).json()
            self.assertIs(todos[0]["done"], True)

    def test_patch_edits_text_stripped(self):
        with AtlasServer() as srv:
            resp = srv.patch("/api/todos/0",
                             json_body={"text": "  Texte révisé  "})
            self.assertEqual(resp.status, 200)
            todos = resp.json()
            self.assertEqual(todos[0], {"id": 0, "text": "Texte révisé",
                                        "done": False, "cat": "work"})
            self.assertIn("- [ ] Texte révisé <!-- id:0 -->\n", read_quick_md(srv))

    def test_patch_blank_text_is_silently_ignored(self):
        with AtlasServer() as srv:
            # "if "text" in data and data["text"].strip()": an empty text does
            # NOT trigger an error, it is just ignored (200, item unchanged).
            resp = srv.patch("/api/todos/0", json_body={"text": "   "})
            self.assertEqual(resp.status, 200)
            self.assertEqual(resp.json()[0]["text"], "Préparer le bilan mensuel")

    def test_patch_cat_moves_item_and_keeps_its_id(self):
        with AtlasServer() as srv:
            # Moving id 0 (work) to personal relocates it into the Personal
            # section, AFTER the remaining work item -- under the same id.
            todos = srv.patch("/api/todos/0",
                              json_body={"cat": "personal"}).json()
            self.assertEqual(todos[0]["text"], "Review the draft")
            self.assertEqual(todos[1], {"id": 0,
                                        "text": "Préparer le bilan mensuel",
                                        "done": False, "cat": "personal"})
            self.assertEqual(read_quick_md(srv), TODO_HEADER + (
                "## Work\n\n"
                "- [x] Review the draft <!-- id:1 -->\n"
                "\n"
                "## Personal\n\n"
                "- [ ] Préparer le bilan mensuel <!-- id:0 -->\n"
                "- [ ] Tester le build PoE <!-- id:2 -->\n"
                "\n"
            ))

    def test_patch_unknown_cat_recategorizes_to_work(self):
        with AtlasServer() as srv:
            # SURPRISE: PATCH {"cat": "inconnu"} on a personal item silently
            # flips it back to work (_norm_cat falls back to the default).
            todos = srv.patch("/api/todos/2", json_body={"cat": "inconnu"}).json()
            moved = [t for t in todos if t["text"] == "Tester le build PoE"]
            self.assertEqual(moved[0]["cat"], "work")

    def test_patch_combines_done_and_text(self):
        with AtlasServer() as srv:
            todos = srv.patch("/api/todos/0", json_body={
                "done": True, "text": "Bilan envoyé"}).json()
            self.assertEqual(todos[0], {"id": 0, "text": "Bilan envoyé",
                                        "done": True, "cat": "work"})

    def test_patch_invalid_ids_return_404(self):
        with AtlasServer() as srv:
            # An id the list doesn't have -> 404 JSON.
            resp = srv.patch("/api/todos/99", json_body={"done": True})
            self.assertEqual(resp.status, 404)
            self.assertEqual(resp.json(), {"error": "not found"})
            # Non-numeric id (or negative: the regex only accepts \d+) -> bare
            # 404, empty body, no JSON.
            resp = srv.patch("/api/todos/abc", json_body={"done": True})
            self.assertEqual(resp.status, 404)
            self.assertEqual(resp.body, b"")


class TestDeleteTodo(unittest.TestCase):
    """DELETE /api/todos/:id -- one server per test."""

    def test_delete_leaves_the_other_ids(self):
        with AtlasServer() as srv:
            todos = srv.delete("/api/todos/0").json()
            self.assertEqual(todos, [
                {"id": 1, "text": "Review the draft", "done": True,
                 "cat": "work"},
                {"id": 2, "text": "Tester le build PoE", "done": False,
                 "cat": "personal"},
            ])

    def test_an_out_of_date_device_reaches_the_todo_it_shows_or_none(self):
        with AtlasServer() as srv:
            # Two devices load the same list; the phone deletes the first todo.
            stale = srv.get("/api/todos").json()
            srv.delete(f"/api/todos/{stale[0]['id']}")
            # The laptop, still showing the old list, deletes "Review the draft":
            # that one goes, not the todo that moved into its place.
            after = srv.delete(f"/api/todos/{stale[1]['id']}").json()
            self.assertEqual([t["text"] for t in after], ["Tester le build PoE"])
            # And the todo the phone already removed is gone, not a neighbour.
            resp = srv.patch(f"/api/todos/{stale[0]['id']}", json_body={"done": True})
            self.assertEqual(resp.status, 404)

    def test_delete_keeps_empty_section_in_markdown(self):
        with AtlasServer() as srv:
            resp = srv.delete("/api/todos/2")
            self.assertEqual(resp.status, 200)
            # The Personal section is re-emitted even when empty (header +
            # blank line).
            self.assertEqual(read_quick_md(srv), TODO_HEADER + (
                "## Work\n\n"
                "- [ ] Préparer le bilan mensuel <!-- id:0 -->\n"
                "- [x] Review the draft <!-- id:1 -->\n"
                "\n"
                "## Personal\n\n"
                "\n"
            ))

    def test_delete_unknown_id_returns_404_json(self):
        with AtlasServer() as srv:
            resp = srv.delete("/api/todos/3")
            self.assertEqual(resp.status, 404)
            self.assertEqual(resp.json(), {"error": "not found"})
            # Nothing deleted.
            self.assertEqual(len(srv.get("/api/todos").json()), 3)

    def test_delete_collection_url_returns_bare_404(self):
        with AtlasServer() as srv:
            # DELETE /api/todos (without id) matches no route -> bare 404 with
            # no body (send_response + end_headers).
            resp = srv.delete("/api/todos")
            self.assertEqual(resp.status, 404)
            self.assertEqual(resp.body, b"")


class TestCloudTodoIds(unittest.TestCase):
    """Cloud per-member todos.json: the same stable ids as the markdown path.
    Regression for the '404 on validating a todo' bug (positional ids drifting
    after a delete) and for its fix, which renumbered the list so a stale device
    hit the wrong todo."""

    def _auth(self, srv):
        # Use the VIEWER (non-admin): it never triggers the legacy-markdown
        # migration in load_todos, so its list starts empty and deterministic.
        from test_admin import (seed_admin_and_viewer, file_store_of,
                                session_cookie, csrf_token_for,
                                VIEWER_EMAIL, VIEWER_PASSWORD)
        seed_admin_and_viewer(file_store_of(srv))
        cookie = session_cookie(srv, VIEWER_EMAIL, VIEWER_PASSWORD)
        return {"Cookie": cookie,
                "X-CSRF-Token": csrf_token_for(srv, cookie)}

    def test_ids_survive_a_delete_and_a_toggle_reaches_its_todo(self):
        from test_admin import cloud_env
        with AtlasServer(extra_env=cloud_env()) as srv:
            h = self._auth(srv)
            for text in ("a", "b", "c", "d"):
                self.assertEqual(
                    srv.post("/api/todos", headers=h,
                             json_body={"text": text, "cat": "personal"}).status, 200)
            ids = [t["id"] for t in srv.get("/api/todos", headers=h).json()]
            self.assertEqual(len(set(ids)), 4)
            after = srv.delete(f"/api/todos/{ids[0]}", headers=h).json()
            self.assertEqual([t["id"] for t in after], ids[1:])
            self.assertEqual([t["id"] for t in srv.get("/api/todos", headers=h).json()], ids[1:])
            resp = srv.patch(f"/api/todos/{ids[-1]}", headers=h, json_body={"done": True})
            self.assertEqual(resp.status, 200)
            self.assertEqual([t["text"] for t in resp.json() if t["done"]], ["d"])
            # The deleted id stays gone.
            self.assertEqual(srv.delete(f"/api/todos/{ids[0]}", headers=h).status, 404)

    def test_a_list_stored_with_repeated_ids_is_repaired_on_read(self):
        from test_admin import cloud_env, file_store_of, VIEWER_EMAIL
        with AtlasServer(extra_env=cloud_env()) as srv:
            h = self._auth(srv)
            # What positional ids left behind: [0, 1, 2], delete 1, create -> [0, 2, 2].
            file_store_of(srv).save_user_todos(VIEWER_EMAIL, [
                {"id": 0, "text": "a", "done": False, "cat": "work"},
                {"id": 2, "text": "b", "done": False, "cat": "work"},
                {"id": 2, "text": "c", "done": False, "cat": "work"},
            ])
            todos = srv.get("/api/todos", headers=h).json()
            self.assertEqual([(t["id"], t["text"]) for t in todos], [(0, "a"), (2, "b"), (3, "c")])
            resp = srv.delete("/api/todos/3", headers=h)
            self.assertEqual([t["text"] for t in resp.json()], ["a", "b"])


if __name__ == "__main__":
    unittest.main()
