"""Characterization tests for the /api/todos endpoints (src/server.py).

Scope: GET/POST /api/todos, PATCH/DELETE /api/todos/:id, persistence in
content/notes/quick.md (H2 Travail/Personnel sections, GFM checkboxes).

Behaviors ENCODED AS-IS (bugs/quirks included):
- A todo's id is its INDEX in the file order (parse_todos reassigns
  id = position on every read): any write can renumber the others.
- write_todos groups by section (Travail first, then Personnel): a "travail"
  POST is inserted BEFORE the personnel items -> their ids are shifted.
- A PATCH cat moves the item to another section -> its own id changes in the
  response.
- Unknown category (POST or PATCH) -> silently falls back to "travail".
- A text containing a newline + "- [ ]" injects extra todos into the markdown
  (no sanitization).
"""
import time
import unittest

from harness import AtlasServer, DEFAULT_MIND, TODO_REL

TODO_HEADER = (
    "# To-do\n\n"
    "Liste éditable depuis le widget en bas à droite du viewer.\n\n"
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

    def test_get_returns_items_with_index_ids(self):
        status, headers, _ = resp = self.srv.get("/api/todos")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Content-Type"),
                         "application/json; charset=utf-8")
        # The ids are positions in the file (0..n-1), not stable identifiers.
        self.assertEqual(resp.json(), [
            {"id": 0, "text": "Préparer le bilan mensuel", "done": False,
             "cat": "travail"},
            {"id": 1, "text": "Review the draft", "done": True,
             "cat": "travail"},
            {"id": 2, "text": "Tester le build PoE", "done": False,
             "cat": "personnel"},
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
        "## PERSONNEL\n\n"
        "- [ ] sous personnel en majuscules\n\n"
        "## Divers\n\n"
        "- [x] sous un header inconnu\n\n"
        "## Travail\n\n"
        "- [ ] sous travail\n"
    )

    @classmethod
    def setUpClass(cls):
        mind = dict(DEFAULT_MIND)
        mind[TODO_REL] = cls.QUICK_MD
        cls.srv = AtlasServer(mind=mind)
        cls.addClassCleanup(cls.srv.stop)
        cls.srv.start()
        cls.todos = cls.srv.get("/api/todos").json()

    def test_items_before_any_section_default_to_travail(self):
        self.assertEqual(self.todos[0]["text"], "avant toute section")
        self.assertEqual(self.todos[0]["cat"], "travail")

    def test_section_header_matching_is_case_insensitive(self):
        # "## PERSONNEL" is recognized as the personnel section.
        self.assertEqual(self.todos[1]["text"], "sous personnel en majuscules")
        self.assertEqual(self.todos[1]["cat"], "personnel")

    def test_unknown_section_header_keeps_previous_category(self):
        # "## Divers" is neither Travail nor Personnel: the CURRENT category is
        # kept (personnel, inherited from the previous section) -- it does NOT
        # fall back to the travail default.
        self.assertEqual(self.todos[2]["text"], "sous un header inconnu")
        self.assertEqual(self.todos[2]["cat"], "personnel")
        self.assertTrue(self.todos[2]["done"])
        self.assertEqual(self.todos[3]["cat"], "travail")


class TestCreateTodo(unittest.TestCase):
    """POST /api/todos -- one server per test (each test writes)."""

    def test_post_without_cat_defaults_to_travail_and_shifts_personnel_ids(self):
        with AtlasServer() as srv:
            resp = srv.post("/api/todos", json_body={"text": "Nouvelle tâche"})
            self.assertEqual(resp.status, 200)
            todos = resp.json()
            self.assertEqual(len(todos), 4)
            # The new "travail" item is written at the end of the Travail
            # section, hence BEFORE the personnel items: it takes id 2 and the
            # existing personnel item moves from id 2 to id 3 (silent
            # renumbering).
            self.assertEqual(todos[2], {"id": 2, "text": "Nouvelle tâche",
                                        "done": False, "cat": "travail"})
            self.assertEqual(todos[3], {"id": 3, "text": "Tester le build PoE",
                                        "done": False, "cat": "personnel"})

    def test_post_personnel_category_accepts_mixed_case(self):
        with AtlasServer() as srv:
            # _norm_cat strips and lowercases the received category.
            todos = srv.post("/api/todos", json_body={
                "text": "Course du soir", "cat": "  PerSonNel "}).json()
            self.assertEqual(todos[-1], {"id": 3, "text": "Course du soir",
                                         "done": False, "cat": "personnel"})

    def test_post_unknown_cat_falls_back_to_travail(self):
        with AtlasServer() as srv:
            todos = srv.post("/api/todos", json_body={
                "text": "Catégorie exotique", "cat": "boulot"}).json()
            created = [t for t in todos if t["text"] == "Catégorie exotique"]
            self.assertEqual(len(created), 1)
            self.assertEqual(created[0]["cat"], "travail")

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
            srv.post("/api/todos", json_body={"text": "Nouvelle tâche"})
            self.assertEqual(read_quick_md(srv), TODO_HEADER + (
                "## Travail\n\n"
                "- [ ] Préparer le bilan mensuel\n"
                "- [x] Review the draft\n"
                "- [ ] Nouvelle tâche\n"
                "\n"
                "## Personnel\n\n"
                "- [ ] Tester le build PoE\n"
                "\n"
            ))

    def test_post_creates_quick_md_when_missing(self):
        # Custom mind without quick.md: GET -> [], POST creates the full file
        # (header + BOTH sections, even the empty one).
        with AtlasServer(mind={"accueil.md": "# Accueil\n"}) as srv:
            self.assertEqual(srv.get("/api/todos").json(), [])
            todos = srv.post("/api/todos",
                             json_body={"text": "Premier item"}).json()
            self.assertEqual(todos, [{"id": 0, "text": "Premier item",
                                      "done": False, "cat": "travail"}])
            self.assertEqual(read_quick_md(srv), TODO_HEADER + (
                "## Travail\n\n"
                "- [ ] Premier item\n"
                "\n"
                "## Personnel\n\n"
                "\n"
            ))

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
            self.assertEqual(todos[0]["text"], "Texte révisé")
            self.assertIn("- [ ] Texte révisé\n", read_quick_md(srv))

    def test_patch_blank_text_is_silently_ignored(self):
        with AtlasServer() as srv:
            # "if "text" in data and data["text"].strip()": an empty text does
            # NOT trigger an error, it is just ignored (200, item unchanged).
            resp = srv.patch("/api/todos/0", json_body={"text": "   "})
            self.assertEqual(resp.status, 200)
            self.assertEqual(resp.json()[0]["text"], "Préparer le bilan mensuel")

    def test_patch_cat_moves_item_and_changes_its_id(self):
        with AtlasServer() as srv:
            # SURPRISE: moving id 0 (travail) to personnel relocates it into the
            # Personnel section, hence AFTER the remaining travail item -> its id
            # becomes 1 in the response, and the old id 1 becomes id 0.
            todos = srv.patch("/api/todos/0",
                              json_body={"cat": "personnel"}).json()
            self.assertEqual(todos[0]["text"], "Review the draft")
            self.assertEqual(todos[1], {"id": 1,
                                        "text": "Préparer le bilan mensuel",
                                        "done": False, "cat": "personnel"})
            self.assertEqual(read_quick_md(srv), TODO_HEADER + (
                "## Travail\n\n"
                "- [x] Review the draft\n"
                "\n"
                "## Personnel\n\n"
                "- [ ] Préparer le bilan mensuel\n"
                "- [ ] Tester le build PoE\n"
                "\n"
            ))

    def test_patch_unknown_cat_recategorizes_to_travail(self):
        with AtlasServer() as srv:
            # SURPRISE: PATCH {"cat": "inconnu"} on a personnel item silently
            # flips it back to travail (_norm_cat falls back to the default).
            todos = srv.patch("/api/todos/2", json_body={"cat": "inconnu"}).json()
            moved = [t for t in todos if t["text"] == "Tester le build PoE"]
            self.assertEqual(moved[0]["cat"], "travail")

    def test_patch_combines_done_and_text(self):
        with AtlasServer() as srv:
            todos = srv.patch("/api/todos/0", json_body={
                "done": True, "text": "Bilan envoyé"}).json()
            self.assertEqual(todos[0], {"id": 0, "text": "Bilan envoyé",
                                        "done": True, "cat": "travail"})

    def test_patch_invalid_ids_return_404(self):
        with AtlasServer() as srv:
            # Out-of-bounds index -> 404 JSON.
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

    def test_delete_reindexes_remaining_items(self):
        with AtlasServer() as srv:
            todos = srv.delete("/api/todos/0").json()
            # The survivors are renumbered: the old id 1 becomes id 0.
            self.assertEqual(todos, [
                {"id": 0, "text": "Review the draft", "done": True,
                 "cat": "travail"},
                {"id": 1, "text": "Tester le build PoE", "done": False,
                 "cat": "personnel"},
            ])

    def test_delete_keeps_empty_section_in_markdown(self):
        with AtlasServer() as srv:
            resp = srv.delete("/api/todos/2")
            self.assertEqual(resp.status, 200)
            # The Personnel section is re-emitted even when empty (header +
            # blank line).
            self.assertEqual(read_quick_md(srv), TODO_HEADER + (
                "## Travail\n\n"
                "- [ ] Préparer le bilan mensuel\n"
                "- [x] Review the draft\n"
                "\n"
                "## Personnel\n\n"
                "\n"
            ))

    def test_delete_out_of_range_returns_404_json(self):
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


if __name__ == "__main__":
    unittest.main()
