"""Tests of the agent-session MCP tools: brief (context pack), changes_since (cursor),
agent_runs / undo_run (group an agent's commits, undo them as one), and token scopes
(MCP tool filtering + REST v1).

MCP requires an 'api'-role Bearer token → cloud-mode harness, like test_mcp_tools.
"""
import hashlib
import secrets
import sys
import unittest
from pathlib import Path

_TESTS_DIR = str(Path(__file__).resolve().parent)
if _TESTS_DIR not in sys.path:
    sys.path.insert(0, _TESTS_DIR)

from harness import AtlasServer  # noqa: E402
from test_cloud_filestore import (  # noqa: E402
    cloud_env, file_store_of, session_cookie, auth_headers, ADMIN_EMAIL, VIEWER_EMAIL,
)
from test_mcp_tools import _call  # noqa: E402
import store  # noqa: E402  (importable once test_cloud_filestore put src/ on sys.path)

PASSWORD = "secret-password-123"
ALPHA = "# Projet Alpha\n\n## Pricing\n\nLe tarif mensuel est de 49 euros.\n\n## Suite\n\nRien.\n"
MIND = {
    "accueil.md": "# Accueil\n\nVoir [[projets/alpha]].\n",
    "projets/alpha.md": ALPHA,
    "projets/beta.md": "# Projet Beta\n\nLe tarif mensuel est de 59 euros.\n",
    "notes/old.md": "# Old\n\nA keeper.\n",
}


def _token(srv, email, acts_as, role="admin", scopes=None):
    """Seed a human (`acts_as`, with `role`) and an API token acting for them."""
    fs = file_store_of(srv)
    fs.upsert_user(acts_as, {"role": role})
    token = secrets.token_hex(32)
    fs.upsert_user(email, {"role": "api", "acts_as": acts_as, "scopes": scopes,
                           "api_token_hash": hashlib.sha256(token.encode()).hexdigest(),
                           "password_hash": "$2b$12$" + "x" * 53})
    return token


class _Server(unittest.TestCase):
    def setUp(self):
        self.srv = AtlasServer(extra_env=cloud_env(), mind=MIND)
        self.srv.start()
        self.token = _token(self.srv, "claude@api.local", ADMIN_EMAIL)

    def tearDown(self):
        self.srv.stop()

    def call(self, tool, token=None, **args):
        return _call(self.srv, token or self.token, tool, args)

    def text(self, rel):
        return self.srv.path(rel).read_text(encoding="utf-8")

    def _agent_session(self):
        self.call("edit_doc", path="projets/alpha.md", old_string="49", new_string="45", ai="claude")
        self.call("create_doc", path="notes/new.md", content="# New", ai="claude")
        self.call("move_doc", **{"from": "projets/beta.md", "to": "projets/gamma.md"}, ai="claude")
        self.call("delete_doc", path="notes/old.md", ai="claude")
        _, data = self.call("agent_runs")
        runs = [r for r in data["runs"] if r["ai"]]
        self.assertEqual(len(runs), 1)
        return runs[0]


class TestBriefAndChanges(_Server):
    def test_brief_packs_sections_within_budget(self):
        err, data = self.call("brief", topic="tarif mensuel", budget_tokens=300)
        self.assertFalse(err, data)
        alpha = next(s for s in data["sources"] if s["path"] == "projets/alpha.md")
        self.assertEqual((alpha["section"], alpha["lines"]), ("Projet Alpha > Pricing", "3-6"))
        self.assertEqual(alpha["text"], "## Pricing\n\nLe tarif mensuel est de 49 euros.")
        self.assertIn("last_modified", alpha)
        self.assertIn("accueil.md", data["related"])  # links to alpha, didn't match itself
        self.assertLessEqual(sum(len(s["text"]) for s in data["sources"]), 300 * 4)

    def test_changes_since_reports_net_doc_changes(self):
        _, first = self.call("changes_since")
        cursor = first["cursor"]
        self.call("edit_doc", path="projets/alpha.md", old_string="49", new_string="45", ai="claude")
        self.call("create_doc", path="notes/new.md", content="# New", ai="claude")
        self.call("create_doc", path="notes/tmp.md", content="# Tmp", ai="claude")
        self.call("delete_doc", path="notes/tmp.md", ai="claude")
        self.call("move_doc", **{"from": "projets/beta.md", "to": "projets/gamma.md"}, ai="claude")
        self.call("delete_doc", path="notes/old.md", ai="claude")

        _, data = self.call("changes_since", cursor=cursor)
        docs = {d["path"]: d for d in data["documents"]}
        self.assertEqual((docs["projets/alpha.md"]["change"], docs["projets/alpha.md"]["ai"]),
                         ("modified", "claude"))
        self.assertEqual(docs["notes/new.md"]["change"], "added")
        self.assertEqual((docs["projets/gamma.md"]["change"], docs["projets/gamma.md"]["from"]),
                         ("moved", "projets/beta.md"))
        self.assertEqual(docs["notes/old.md"]["change"], "deleted")
        self.assertNotIn("notes/tmp.md", docs)  # created then deleted: no net change
        self.assertNotEqual(data["cursor"], cursor)
        _, again = self.call("changes_since", cursor=data["cursor"])
        self.assertEqual(again["documents"], [])

    def test_unknown_cursor(self):
        err, text = self.call("changes_since", cursor="deadbeef")
        self.assertTrue(err)
        self.assertIn("Unknown cursor", text)


class TestAgentRuns(_Server):
    def test_run_groups_the_session_and_undoes_it_whole(self):
        file_store_of(self.srv).set_owner("projets/beta.md", "user:" + ADMIN_EMAIL)
        run = self._agent_session()
        self.assertEqual((run["ai"], run["token"], run["commits"]), ("claude", "claude", 4))

        err, text = self.call("undo_run", run=run["id"], dry_run=True, ai="claude")
        self.assertFalse(err)
        self.assertIn("projets/gamma.md (moved)", text)
        self.assertTrue(self.srv.path("notes/new.md").exists())

        err, text = self.call("undo_run", run=run["id"], ai="claude")
        self.assertFalse(err, text)
        self.assertEqual(self.text("projets/alpha.md"), ALPHA)
        self.assertFalse(self.srv.path("notes/new.md").exists())
        self.assertTrue(self.srv.path("projets/beta.md").exists())
        self.assertFalse(self.srv.path("projets/gamma.md").exists())
        self.assertIn("A keeper.", self.text("notes/old.md"))
        fs = file_store_of(self.srv)
        self.assertEqual(fs.get_acl("projets/beta.md")["owner"], "user:" + ADMIN_EMAIL)
        self.assertIsNone(fs.get_acl("projets/gamma.md"))

    def test_conflicting_undo_changes_nothing(self):
        run = self._agent_session()
        # A later, non-AI edit on the very line the agent changed.
        self.call("edit_doc", path="projets/alpha.md", old_string="45", new_string="40")
        err, text = self.call("undo_run", run=run["id"], ai="claude")
        self.assertTrue(err)
        self.assertIn("Nothing was changed", text)
        self.assertIn("40 euros", self.text("projets/alpha.md"))
        self.assertTrue(self.srv.path("projets/gamma.md").exists())
        self.assertEqual(self.srv.git("status", "--porcelain", "--", "content").stdout, "")

    def test_run_lists_its_commits(self):
        run = self._agent_session()
        # The list already says what each commit was, so one call answers (each call is a view).
        self.assertEqual([c["subject"].split(":")[0] for c in run["log"]], ["deleted", "moved", "created", "edited"])
        self.assertNotIn("documents", run["log"][0])
        self.assertNotIn("log_more", run)
        _, data = self.call("agent_runs", run=run["id"])
        self.assertEqual([c["documents"] for c in data["runs"][0]["log"]],
                         [["notes/old.md"], ["projets/beta.md", "projets/gamma.md"],
                          ["notes/new.md"], ["projets/alpha.md"]])
        err, text = self.call("agent_runs", run="0" * 25)
        self.assertTrue(err)
        self.assertIn("No run", text)

    def test_a_write_naming_no_ai_is_still_an_agents_run(self):
        # A token writes for an agent, whether or not it says which: it is never taken for the
        # person, and its run stays apart from theirs and undoable.
        self.call("edit_doc", path="projets/alpha.md", old_string="49", new_string="40")
        _, data = self.call("agent_runs")
        run = next(r for r in data["runs"] if any(d["path"] == "projets/alpha.md" for d in r["documents"]))
        self.assertEqual((run["ai"], run["token"]), ("unknown", "claude"))
        err, text = self.call("undo_run", run=run["id"], paths=["projets/alpha.md"], ai="claude")
        self.assertFalse(err, text)
        self.assertEqual(self.text("projets/alpha.md"), ALPHA)

    def test_a_human_run_is_listed_and_undone(self):
        # A commit with no trailer, as an agent committing from a clone writes it.
        self.srv.path("projets/alpha.md").write_text(ALPHA.replace("49", "40"), encoding="utf-8", newline="")
        self.srv.git("commit", "-qam", "edited: alpha")
        _, data = self.call("agent_runs")
        run = next(r for r in data["runs"] if any(d["path"] == "projets/alpha.md" for d in r["documents"]))
        self.assertIsNone(run["ai"])
        err, text = self.call("undo_run", run=run["id"], paths=["projets/alpha.md"], ai="claude")
        self.assertFalse(err, text)
        self.assertEqual(self.text("projets/alpha.md"), ALPHA)

    def test_a_view_relayed_undo_is_the_persons_own(self):
        # The run view relays the person's click without `ai`: theirs, not an agent's.
        run = self._agent_session()
        err, text = self.call("undo_run", run=run["id"], paths=["notes/new.md"])
        self.assertFalse(err, text)
        trailers = self.srv.git("log", "-1", "--format=%(trailers)").stdout
        self.assertNotIn("X-Atlas", trailers)
        self.assertEqual(self.srv.git("log", "-1", "--format=%ae").stdout.strip(), ADMIN_EMAIL)

    def test_undo_from_a_commit_keeps_what_came_before(self):
        run = self._agent_session()
        _, data = self.call("agent_runs", run=run["id"])
        create = data["runs"][0]["log"][2]["sha"]
        err, text = self.call("undo_run", run=run["id"], ai="claude", **{"from": create})
        self.assertFalse(err, text)
        self.assertIn("45 euros", self.text("projets/alpha.md"))
        self.assertFalse(self.srv.path("notes/new.md").exists())
        self.assertTrue(self.srv.path("projets/beta.md").exists())
        self.assertIn("A keeper.", self.text("notes/old.md"))

    def test_undo_only_some_docs(self):
        file_store_of(self.srv).set_owner("projets/beta.md", "user:" + ADMIN_EMAIL)
        run = self._agent_session()
        err, text = self.call("undo_run", run=run["id"], paths=["projets/gamma.md", "notes/old.md"],
                              dry_run=True, ai="claude")
        reverted = set(text.partition("would be reverted for: ")[2].rstrip(".").split(", "))
        self.assertEqual(reverted, {"notes/old.md (deleted)", "projets/gamma.md (moved)"})
        err, text = self.call("undo_run", run=run["id"], paths=["projets/gamma.md", "notes/old.md"],
                              ai="claude")
        self.assertFalse(err, text)
        self.assertTrue(self.srv.path("projets/beta.md").exists())
        self.assertFalse(self.srv.path("projets/gamma.md").exists())
        self.assertIn("A keeper.", self.text("notes/old.md"))
        self.assertFalse(self.srv.path(".trash/notes/old.md").exists())  # out of the trash, not copied
        self.assertIn("45 euros", self.text("projets/alpha.md"))
        self.assertTrue(self.srv.path("notes/new.md").exists())
        self.assertEqual(file_store_of(self.srv).get_acl("projets/beta.md")["owner"], "user:" + ADMIN_EMAIL)

    def test_partial_undo_names_what_it_cannot_find(self):
        run = self._agent_session()
        err, text = self.call("undo_run", run=run["id"], paths=["accueil.md"], ai="claude")
        self.assertTrue(err)
        self.assertIn("does not change accueil.md", text)
        err, text = self.call("undo_run", run=run["id"], ai="claude", **{"from": "abcdef0"})
        self.assertTrue(err)
        self.assertIn("is not a commit of run", text)

    def test_a_commons_writer_may_undo_edits_there(self):
        self.call("edit_doc", path="projets/alpha.md", old_string="49", new_string="40")
        _, data = self.call("agent_runs")
        run = next(r for r in data["runs"] if any(d["path"] == "projets/alpha.md" for d in r["documents"]))
        unbound = secrets.token_hex(32)
        file_store_of(self.srv).upsert_user("bot@api.local", {
            "role": "api", "api_token_hash": hashlib.sha256(unbound.encode()).hexdigest(),
            "password_hash": "$2b$12$" + "x" * 53})
        err, text = self.call("undo_run", token=unbound, run=run["id"], paths=["projets/alpha.md"],
                              ai="claude")
        self.assertFalse(err, text)
        self.assertEqual(self.text("projets/alpha.md"), ALPHA)

    def test_others_may_undo_only_what_they_could_change_by_hand(self):
        file_store_of(self.srv).set_owner("projets/beta.md", "user:" + ADMIN_EMAIL)
        run = self._agent_session()
        other = _token(self.srv, "bot@api.local", VIEWER_EMAIL, role="viewer")
        err, text = self.call("undo_run", token=other, run=run["id"], ai="claude")
        self.assertTrue(err)
        self.assertIn("Only the person", text)
        self.assertTrue(self.srv.path("projets/gamma.md").exists())
        err, text = self.call("undo_run", token=other, run=run["id"], paths=["projets/alpha.md"],
                              ai="claude")
        self.assertFalse(err, text)
        self.assertEqual(self.text("projets/alpha.md"), ALPHA)


class TestUndoFromActivity(_Server):
    """The viewer's Activity: a change in the feed opens its run, undone there in part."""

    def session(self, email, role):
        file_store_of(self.srv).upsert_user(email, {"password_hash": store.hash_password(PASSWORD),
                                                    "role": role})
        return auth_headers(self.srv, session_cookie(self.srv, email, PASSWORD))

    def run_of(self, path, headers):
        events = self.srv.get("/api/activity?since=7", headers=headers).json()["events"]
        sha = next(e["short_sha"] for e in events if path in e["paths"])
        return self.srv.get("/api/run?sha=" + sha, headers=headers)

    def test_a_change_opens_its_run_undone_for_some_docs(self):
        run = self._agent_session()
        headers = self.session(ADMIN_EMAIL, "admin")
        shown = self.run_of("notes/new.md", headers).json()
        self.assertEqual((shown["id"], shown["ai"], shown["commits"]), (run["id"], "claude", 4))
        self.assertEqual({d["path"]: (d["change"], d["may_undo"]) for d in shown["documents"]},
                         {"projets/alpha.md": ("modified", True), "notes/new.md": ("added", True),
                          "projets/gamma.md": ("moved", True), "notes/old.md": ("deleted", True)})
        resp = self.srv.post("/api/run/undo", headers=headers,
                             json_body={"run": run["id"], "paths": ["notes/new.md"]})
        self.assertEqual(resp.status, 200, resp.text)
        self.assertFalse(self.srv.path("notes/new.md").exists())
        self.assertIn("45 euros", self.text("projets/alpha.md"))
        # The undo is the person's own click: their name, no AI.
        self.assertEqual(self.srv.git("log", "-1", "--format=%ae|%(trailers:key=X-Atlas-Author,valueonly)")
                         .stdout.strip(), ADMIN_EMAIL + "|")
        gone = self.srv.post("/api/run/undo", headers=headers, json_body={"run": "0" * 25})
        self.assertEqual(gone.status, 404)
        self.assertEqual(self.srv.get("/api/run?sha=nothex", headers=headers).status, 400)

    def test_someone_else_undoes_only_what_they_could_change_by_hand(self):
        fs = file_store_of(self.srv)
        fs.set_owner("projets/beta.md", "user:" + ADMIN_EMAIL)
        fs.grant("projets/alpha.md", "user:" + VIEWER_EMAIL, "edit")
        run = self._agent_session()
        headers = self.session(VIEWER_EMAIL, "viewer")
        may = {d["path"]: d["may_undo"] for d in self.run_of("notes/new.md", headers).json()["documents"]}
        self.assertTrue(may["projets/alpha.md"])
        self.assertNotIn("projets/gamma.md", may)  # its owner's alone
        resp = self.srv.post("/api/run/undo", headers=headers, json_body={"run": run["id"]})
        self.assertEqual(resp.status, 403)
        self.assertTrue(self.srv.path("projets/gamma.md").exists())
        resp = self.srv.post("/api/run/undo", headers=headers,
                             json_body={"run": run["id"], "paths": ["projets/alpha.md"]})
        self.assertEqual(resp.status, 200, resp.text)
        self.assertEqual(self.text("projets/alpha.md"), ALPHA)


class TestScopes(_Server):
    def setUp(self):
        super().setUp()
        self.scoped = _token(self.srv, "triage@api.local", ADMIN_EMAIL, scopes=["read", "inbox"])

    def test_scoped_token_sees_and_calls_only_its_tools(self):
        resp = self.srv.post(f"/mcp/{self.scoped}", json_body={
            "jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        names = {t["name"] for t in resp.json()["result"]["tools"]}
        self.assertTrue({"search_docs", "brief", "create_inbox_item"} <= names)
        self.assertFalse({"edit_doc", "delete_doc", "undo_run"} & names)
        err, text = self.call("edit_doc", token=self.scoped, path="projets/alpha.md",
                              content="# x", ai="claude")
        self.assertTrue(err)
        self.assertIn("outside its scopes", text)
        self.assertEqual(self.text("projets/alpha.md"), ALPHA)

    def test_rest_api_honours_scopes(self):
        auth = {"Authorization": f"Bearer {self.scoped}"}
        self.assertEqual(self.srv.get("/api/v1/search?q=tarif", headers=auth).status, 200)
        resp = self.srv.post("/api/v1/file", headers=auth,
                             json_body={"path": "notes/x.md", "content": "# x"})
        self.assertEqual(resp.status, 403)
        self.assertFalse(self.srv.path("notes/x.md").exists())

    def test_normalize_scopes(self):
        self.assertEqual(store.normalize_scopes(" inbox, READ "), ["read", "inbox"])
        for bad in ("", "admin", ["read", "delete"]):
            with self.assertRaises(ValueError):
                store.normalize_scopes(bad)


if __name__ == "__main__":
    unittest.main()
