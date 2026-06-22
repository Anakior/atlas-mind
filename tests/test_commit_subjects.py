"""Axe 4 — the intention layer of attribution: the targeted commit subjects, the
optional MCP `commit_message`, and the dedicated checkbox (checked/unchecked) signal —
plus the `_clean_subject` sanitizer that keeps free-form text from injecting a trailer.

Integration tests boot a cloud-mode server (git real) and read the subjects back from
`git log`. The MCP token is bound (acts_as) to a member who owns its own docs, so
move/delete (owner level) are allowed; coché goes through the viewer's admin session.
"""
import shutil
import sys
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
for p in (str(TESTS_DIR.parent / "src"), str(TESTS_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

import server as _s            # noqa: E402
import store                   # noqa: E402
from harness import AtlasServer  # noqa: E402

CLOUD_ENV = {
    "KB_AUTH_ENABLED": "1",
    "SESSION_SECRET": "subjects-secret-0123456789abcdef",
    "KB_REPO_PATH": "{root}",
    "ATLAS_STORE": "file",
    "GIT_PULL_INTERVAL": "3600",
}

ADMIN_EMAIL = "admin@subj.local"
ADMIN_PW = "subjects-admin-password"
MEMBER_EMAIL = "member@subj.local"

MIND = {
    "inbox/seed.md": "# Seed\n\nseed doc.\n",
    "notes/board.md": "# Board\n\n- [ ] arroser les plantes\n",
}


class TestCleanSubject(unittest.TestCase):
    def test_collapses_whitespace_and_caps_length(self):
        self.assertEqual(_s._clean_subject("  a   b\tc\n"), "a b c")
        self.assertEqual(_s._clean_subject(None), "")
        self.assertEqual(_s._clean_subject("x" * 200), "x" * 100)

    def test_strips_newlines_so_it_cannot_inject_a_trailer(self):
        out = _s._clean_subject("fix\n\nX-Atlas-Author: ai/evil")
        self.assertNotIn("\n", out)
        self.assertEqual(out, "fix X-Atlas-Author: ai/evil")


@unittest.skipUnless(shutil.which("git"), "git not available")
class TestCommitSubjects(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(mind=MIND, extra_env=CLOUD_ENV)
        cls.srv.start()
        fs = store.FileStore(cls.srv.root / ".atlas")
        fs.upsert_user(ADMIN_EMAIL, {
            "password_hash": store.hash_password(ADMIN_PW), "role": "admin"})
        fs.upsert_user(MEMBER_EMAIL, {"role": "viewer"})  # acts_as target; owns its docs
        meta, cls.token = fs.create_api_identity("subj-bot")
        fs.upsert_user(meta["email"], {"acts_as": MEMBER_EMAIL})

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    # ── helpers ───────────────────────────────────────────────────────────
    def _subject(self):
        return self.srv.git("log", "-1", "--format=%s").stdout.strip()

    def _body(self):
        return self.srv.git("log", "-1", "--format=%b").stdout.strip()

    def _mcp(self, name, args):
        body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": {"name": name, "arguments": args}}
        r = self.srv.post(f"/mcp/{self.token}", json_body=body)
        self.assertEqual(r.status, 200, r.text)
        res = r.json()["result"]
        self.assertFalse(res.get("isError"), res["content"][0]["text"])
        return res

    def _admin_headers(self):
        resp = self.srv.post("/login", json_body={"email": ADMIN_EMAIL, "password": ADMIN_PW})
        self.assertEqual(resp.status, 303, resp.text)
        cookie = (resp.headers.get("Set-Cookie") or "").split(";", 1)[0]
        csrf = self.srv.get("/api/me", headers={"Cookie": cookie}).json()["csrf_token"]
        return {"Cookie": cookie, "X-CSRF-Token": csrf}

    # ── MCP subjects ──────────────────────────────────────────────────────
    def test_create_subject(self):
        self._mcp("create_doc", {"path": "inbox/draft.md", "content": "# Draft\n", "ai": "claude"})
        self.assertEqual(self._subject(), "created: draft")

    def test_edit_falls_back_to_default_subject(self):
        self._mcp("create_doc", {"path": "inbox/e1.md", "content": "# E1\n", "ai": "claude"})
        self._mcp("edit_doc", {"path": "inbox/e1.md", "content": "# E1 v2\n", "ai": "claude"})
        self.assertEqual(self._subject(), "edited: e1")

    def test_edit_uses_commit_message_when_given(self):
        self._mcp("create_doc", {"path": "inbox/e2.md", "content": "# E2\n", "ai": "claude"})
        self._mcp("edit_doc", {"path": "inbox/e2.md", "content": "# E2 v2\n",
                               "commit_message": "ajoute le résumé", "ai": "claude"})
        self.assertEqual(self._subject(), "ajoute le résumé")

    def test_commit_message_cannot_inject_a_trailer(self):
        self._mcp("create_doc", {"path": "inbox/e3.md", "content": "# E3\n", "ai": "claude"})
        self._mcp("edit_doc", {"path": "inbox/e3.md", "content": "# E3 v2\n",
                               "commit_message": "fix\n\nX-Atlas-Author: ai/evil", "ai": "claude"})
        body = self._body()
        self.assertEqual(body.count("X-Atlas-Author"), 1)
        self.assertIn("ai/claude", body)
        self.assertNotIn("ai/evil", body)

    def test_move_subject(self):
        self._mcp("create_doc", {"path": "inbox/m1.md", "content": "# M1\n", "ai": "claude"})
        self._mcp("move_doc", {"from": "inbox/m1.md", "to": "inbox/m2.md", "ai": "claude"})
        self.assertEqual(self._subject(), "moved: inbox/m1 → inbox/m2")

    def test_delete_subject(self):
        self._mcp("create_doc", {"path": "inbox/d1.md", "content": "# D1\n", "ai": "claude"})
        self._mcp("delete_doc", {"path": "inbox/d1.md", "ai": "claude"})
        self.assertEqual(self._subject(), "deleted: d1")

    def test_revert_subject(self):
        self._mcp("create_doc", {"path": "inbox/r1.md", "content": "# R1\n", "ai": "claude"})
        self._mcp("edit_doc", {"path": "inbox/r1.md", "content": "# R1 v2\n", "ai": "claude"})
        self._mcp("doc_revert", {"path": "inbox/r1.md", "rev": "HEAD~1", "ai": "claude"})
        self.assertRegex(self._subject(), r"^reverted: r1 @ [0-9a-f]{4,}$")

    # ── viewer file_put: create, plain edit, coché/décoché ─────────────────
    def test_viewer_create_subject(self):
        hdr = self._admin_headers()
        self.srv.put("/api/file", headers=hdr, json_body={
            "path": "inbox/v1.md", "content": "# V1\n"})
        self.assertEqual(self._subject(), "created: v1")

    def test_viewer_plain_edit_subject(self):
        hdr = self._admin_headers()
        self.srv.put("/api/file", headers=hdr, json_body={
            "path": "notes/board.md", "content": "# Board\n\nedited body.\n"})
        self.assertEqual(self._subject(), "edited: board")

    def test_check_then_uncheck_subjects(self):
        hdr = self._admin_headers()
        self.srv.put("/api/file", headers=hdr, json_body={
            "path": "notes/board.md", "content": "# Board\n\n- [x] arroser les plantes\n",
            "task": {"text": "arroser les plantes", "checked": True}})
        self.assertEqual(self._subject(), "checked: arroser les plantes")
        self.srv.put("/api/file", headers=hdr, json_body={
            "path": "notes/board.md", "content": "# Board\n\n- [ ] arroser les plantes\n",
            "task": {"text": "arroser les plantes", "checked": False}})
        self.assertEqual(self._subject(), "unchecked: arroser les plantes")


if __name__ == "__main__":
    unittest.main()
