"""Brick 13a — the read side: /api/activity + the MCP activity tool over the attributed
git history. End-to-end: MCP writes produce attributed commits (author + ai trailer +
typed subject); the activity feed must map them to the CDC event model
{author, email, ai, date(UTC), type, title}. ACL-scrubbed; never anonymous.
"""
import json
import shutil
import sys
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
for p in (str(TESTS_DIR.parent / "src"), str(TESTS_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

import store  # noqa: E402
from harness import AtlasServer  # noqa: E402

CLOUD_ENV = {
    "KB_AUTH_ENABLED": "1",
    "SESSION_SECRET": "activity-secret-0123456789abcdef",
    "KB_REPO_PATH": "{root}",
    "ATLAS_STORE": "file",
    "GIT_PULL_INTERVAL": "3600",
}
ADMIN_EMAIL = "admin@act.local"
ADMIN_PW = "activity-admin-password"
MEMBER_EMAIL = "member@act.local"
MIND = {"inbox/seed.md": "# Seed\n\nseed.\n"}


@unittest.skipUnless(shutil.which("git"), "git not available")
class TestActivity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(mind=MIND, extra_env=CLOUD_ENV)
        cls.srv.start()
        fs = store.FileStore(cls.srv.root / ".atlas")
        fs.upsert_user(ADMIN_EMAIL, {
            "password_hash": store.hash_password(ADMIN_PW), "role": "admin"})
        fs.upsert_user(MEMBER_EMAIL, {
            "role": "viewer", "first_name": "Ada", "last_name": "Lovelace"})
        meta, cls.token = fs.create_api_identity("act-bot")
        fs.upsert_user(meta["email"], {"acts_as": MEMBER_EMAIL})
        # Generate attributed history through the real write path.
        cls._mcp("create_doc", {"path": "inbox/alpha.md", "content": "# A\n", "ai": "claude"})
        cls._mcp("create_doc", {"path": "inbox/beta.md", "content": "# B\n", "ai": "chatgpt"})
        cls._mcp("edit_doc", {"path": "inbox/alpha.md", "content": "# A v2\n", "ai": "claude"})
        cls._mcp("move_doc", {"from": "inbox/alpha.md", "to": "inbox/alpha2.md", "ai": "claude"})
        cls._mcp("delete_doc", {"path": "inbox/beta.md", "ai": "chatgpt"})

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    @classmethod
    def _mcp(cls, name, args):
        body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": {"name": name, "arguments": args}}
        r = cls.srv.post(f"/mcp/{cls.token}", json_body=body)
        assert r.status == 200, r.text
        res = r.json()["result"]
        assert not res.get("isError"), res["content"][0]["text"]
        return res

    def _admin_cookie(self):
        resp = self.srv.post("/login", json_body={"email": ADMIN_EMAIL, "password": ADMIN_PW})
        self.assertEqual(resp.status, 303, resp.text)
        return (resp.headers.get("Set-Cookie") or "").split(";", 1)[0]

    def _events(self):
        r = self.srv.get("/api/activity?since=7&limit=50",
                         headers={"Cookie": self._admin_cookie()})
        self.assertEqual(r.status, 200, r.text)
        return r.json()["events"]

    # ── tests ──────────────────────────────────────────────────────────────
    def test_events_carry_type_ai_author_and_utc(self):
        events = self._events()
        self.assertTrue(events, "no events")
        for e in events:
            self.assertIn("type", e)
            self.assertIn("date", e)
            self.assertTrue(e["date"].endswith("+00:00") or e["date"].endswith("Z"),
                            f"date not UTC: {e['date']}")
        by_type = {}
        for e in events:
            by_type.setdefault(e["type"], []).append(e)
        # the burst of MCP writes maps to the CDC types
        self.assertIn("create", by_type)
        self.assertIn("move", by_type)
        self.assertIn("delete", by_type)
        # the AI family rides through the trailer, and the human (acts_as) is the author
        a_create = next(e for e in by_type["create"] if e["title"] == "alpha")
        self.assertEqual(a_create["ai"], "claude")
        self.assertEqual(a_create["author"], "Ada Lovelace")
        self.assertTrue(a_create["email"])

    def test_human_write_has_no_ai(self):
        # a viewer (admin session) file_put carries no ai trailer
        cookie = self._admin_cookie()
        csrf = self.srv.get("/api/me", headers={"Cookie": cookie}).json()["csrf_token"]
        self.srv.put("/api/file", headers={"Cookie": cookie, "X-CSRF-Token": csrf},
                     json_body={"path": "inbox/human.md", "content": "# Human\n"})
        ev = next(e for e in self._events() if e["title"] == "human")
        self.assertIsNone(ev["ai"])
        self.assertEqual(ev["type"], "create")

    def test_type_filter(self):
        r = self.srv.get("/api/activity?since=7&type=move",
                         headers={"Cookie": self._admin_cookie()})
        self.assertEqual(r.status, 200)
        evs = r.json()["events"]
        self.assertTrue(evs)
        self.assertTrue(all(e["type"] == "move" for e in evs))

    def test_anonymous_refused(self):
        # no session → AUTH guard refuses (never exposed to anon / share links)
        r = self.srv.get("/api/activity?since=7")
        self.assertIn(r.status, (401, 403))

    def test_mcp_activity_tool(self):
        res = self._mcp("activity", {"days": 7, "limit": 50})
        payload = json.loads(res["content"][0]["text"])
        self.assertIn("events", payload)
        self.assertTrue(any(e["ai"] == "claude" for e in payload["events"]))

    def test_checkbox_toggle_types_as_check_even_without_task_text(self):
        # A checkbox tick sends the `task` signal; the event must type as 'check' even
        # when the task text is empty (e.g. the checkbox wasn't inside an <li>).
        cookie = self._admin_cookie()
        csrf = self.srv.get("/api/me", headers={"Cookie": cookie}).json()["csrf_token"]
        hdr = {"Cookie": cookie, "X-CSRF-Token": csrf}
        self.srv.put("/api/file", headers=hdr,
                     json_body={"path": "notes/todo.md", "content": "# T\n\n- [ ] a\n"})
        self.srv.put("/api/file", headers=hdr, json_body={
            "path": "notes/todo.md", "content": "# T\n\n- [x] a\n",
            "task": {"text": "", "checked": True}})
        ev = next(e for e in self._events() if e["title"] == "todo")
        self.assertEqual(ev["type"], "check")


if __name__ == "__main__":
    unittest.main()
