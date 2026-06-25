"""Tests of the Inbox Agents feature.

Covers the whole on-ramp: the inbox is SEALED from the corpus (search/topology) but listable
via /api/inbox; create_inbox_item routes to the PERSON the token acts for (multi-user:
inbox/<user>/<source>/, no source nor user spoofing) and pre-computes same-subject neighbors,
making the lane private to that person; and the triage actions (keep promotes into the graph,
trash and snooze flip the frontmatter in place, reversibly). Read tests share one server; the
mutating triage tests each get a fresh one (no inter-test coupling)."""
import hashlib
import os
import secrets
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

from harness import AtlasServer, DEFAULT_MIND  # noqa: E402
from test_cloud_filestore import cloud_env, API_EMAIL, ADMIN_EMAIL, file_store_of  # noqa: E402
from test_mcp_tools import _seed_api_token, _call  # noqa: E402


def _slug(s):  # mirrors store.slugify_token_label (no need to import src into the test process)
    out = "".join(c if c in "abcdefghijklmnopqrstuvwxyz0123456789._-" else "-"
                  for c in (s or "").strip().lower())
    while "--" in out:
        out = out.replace("--", "-")
    return out.strip("-.")


# An item lands in inbox/<user>/<source>/ : <user> is the PERSON the token acts for (acts_as),
# <source> is the token's own label. The seeded API token acts_as the admin, labelled "claude".
USER_SLUG = _slug(ADMIN_EMAIL)                  # "admin@test.local" -> "admin-test.local"
TOKEN_SOURCE = _slug(API_EMAIL.split("@")[0])   # "claude"
ALICE = "alice"  # the local-mode read/triage fixtures all live under one person's lane


def _item(source, slug, title, body, confidence=0.5, **fm):
    lines = ["---", "origin: inbox", f"source: {source}", f"confidence: {confidence}",
             f"inbox_status: {fm.pop('inbox_status', 'pending')}"]
    for k, v in fm.items():
        lines.append(f"{k}: {v}")
    lines += ["---", "", f"# {title}", "", body]
    return (f"inbox/{ALICE}/{source}/2026-06-25-{slug}.md", "\n".join(lines))


def _inbox_mind():
    """A fresh mind dict with a graph doc + a spread of inbox items (pending/trashed/snoozed)."""
    mind = dict(DEFAULT_MIND)
    mind["ops/oncall.md"] = "---\ntags: [ops]\n---\n# Astreinte oncall\n\nRotation oncall, escalade PagerDuty niveau 2."
    for rel, content in [
        _item("gmail", "keepme", "Astreinte rotation 6h",
              "La rotation d'astreinte oncall passe a 6h, escalade PagerDuty.",
              confidence=0.9, suggest_dest="ops/"),
        _item("sentry", "low", "Pic de timeouts", "x", confidence=0.3),
        _item("gmail", "sealed", "Note scellee", "marqueur unique zarbitoken9 ici.", confidence=0.7),
        _item("gmail", "trashed", "Spam", "x", confidence=0.5, inbox_status="trashed"),
        _item("gmail", "snoozed", "Plus tard", "x", confidence=0.6,
              inbox_status="snoozed", snooze_until="2099-01-01"),
    ]:
        mind[rel] = content
    return mind


KEEP = f"inbox/{ALICE}/gmail/2026-06-25-keepme.md"
LOW = f"inbox/{ALICE}/sentry/2026-06-25-low.md"


class TestInboxRead(unittest.TestCase):
    """Listing + sealing — read-only, so one shared server (local mode -> superuser sees all)."""

    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(mind=_inbox_mind())
        cls.srv.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def test_list_filters_trashed_and_snoozed(self):
        paths = [i["path"] for i in self.srv.get("/api/inbox").json()["inbox"]]
        self.assertIn(KEEP, paths)
        self.assertIn(LOW, paths)
        self.assertNotIn(f"inbox/{ALICE}/gmail/2026-06-25-trashed.md", paths)   # trashed hidden
        self.assertNotIn(f"inbox/{ALICE}/gmail/2026-06-25-snoozed.md", paths)   # snoozed-future hidden

    def test_list_sorted_by_confidence(self):
        items = self.srv.get("/api/inbox").json()["inbox"]
        confs = [i["confidence"] for i in items]
        self.assertEqual(confs, sorted(confs, reverse=True))
        self.assertEqual(items[0]["path"], KEEP)  # 0.9 on top

    def test_list_carries_fields(self):
        keep = next(i for i in self.srv.get("/api/inbox").json()["inbox"]
                    if i["path"].endswith("keepme.md"))
        self.assertEqual(keep["source"], "gmail")
        self.assertEqual(keep["suggest_dest"], "ops/")
        self.assertTrue(keep["title"])

    def test_inbox_sealed_from_search(self):
        # "zarbitoken9" lives only in an inbox item -> search must return it from NOWHERE.
        hits = self.srv.get("/api/search?q=zarbitoken9").json()
        self.assertFalse(any(h["path"].startswith("inbox/") for h in hits))


class TestInboxTriage(unittest.TestCase):
    """Keep / Trash / Snooze mutate state, so each test gets a fresh server."""

    def setUp(self):
        self.srv = AtlasServer(mind=_inbox_mind())
        self.srv.start()

    def tearDown(self):
        self.srv.stop()

    def _action(self, **body):
        return self.srv.post("/api/inbox/action", json_body=body)

    def test_keep_promotes_into_the_graph(self):
        r = self._action(action="keep", path=KEEP, dest="ops")
        self.assertEqual(r.status, 200)
        # gone from inbox, landed at ops/<stem-without-date>, envelope stripped + breadcrumb
        self.assertFalse(self.srv.path(KEEP).exists())
        self.assertTrue(self.srv.path("ops/keepme.md").exists())
        promoted = self.srv.path("ops/keepme.md").read_text(encoding="utf-8")
        self.assertNotIn("promoted_from", promoted)  # no inbox-path leak in the promoted doc
        self.assertNotIn("inbox_status", promoted)   # triage envelope stripped

    def test_trash_is_reversible(self):
        self.assertEqual(self._action(action="trash", path=LOW).status, 200)
        self.assertTrue(self.srv.path(LOW).exists())                       # NOT hard-deleted
        paths = [i["path"] for i in self.srv.get("/api/inbox").json()["inbox"]]
        self.assertNotIn(LOW, paths)                                       # hidden from the list
        self.assertEqual(self._action(action="untrash", path=LOW).status, 200)
        paths = [i["path"] for i in self.srv.get("/api/inbox").json()["inbox"]]
        self.assertIn(LOW, paths)                                          # back

    def test_snooze_hides_until_due(self):
        self.assertEqual(self._action(action="snooze", path=LOW, until="2099-01-01").status, 200)
        self.assertTrue(self.srv.path(LOW).exists())
        paths = [i["path"] for i in self.srv.get("/api/inbox").json()["inbox"]]
        self.assertNotIn(LOW, paths)

    def test_keep_rejects_non_inbox_path(self):
        self.assertEqual(self._action(action="keep", path="ops/oncall.md", dest="notes").status, 400)


class TestInboxMcp(unittest.TestCase):
    """create_inbox_item over MCP: advertised, routes to the acting PERSON's private lane, source
    bound to the token, neighbors pre-computed, and an unbound token gets no inbox."""

    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(mind=_inbox_mind(), extra_env=cloud_env())
        cls.srv.start()
        cls.token = _seed_api_token(cls.srv)  # bound to the admin (acts_as)

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def test_tools_list_advertises_create_inbox_item(self):
        resp = self.srv.post(f"/mcp/{self.token}", json_body={
            "jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        names = {t["name"] for t in resp.json()["result"]["tools"]}
        self.assertIn("create_inbox_item", names)

    def test_create_routes_to_the_person_and_owns_their_lane(self):
        err, _ = _call(self.srv, self.token, "create_inbox_item", {
            "title": "Astreinte rotation 6h",
            "content": "La rotation oncall passe a 6h, escalade PagerDuty.",
            "confidence": 0.8})
        self.assertFalse(err)
        created = list(self.srv.content_root.glob(f"inbox/{USER_SLUG}/{TOKEN_SOURCE}/*.md"))
        self.assertEqual(len(created), 1)
        text = created[0].read_text(encoding="utf-8")
        self.assertIn(f"source: {TOKEN_SOURCE}", text)
        self.assertRegex(text, r"neighbors: \[[^\]]*ops/oncall\.md")  # same-subject neighbor frozen
        # the person's lane is owned by them -> private (only they triage it)
        fs = file_store_of(self.srv)
        acl = fs._load(fs.ACL_FILE, dict)
        self.assertEqual(acl.get(f"inbox/{USER_SLUG}", {}).get("owner"), "user:" + ADMIN_EMAIL)

    def test_source_and_user_cannot_be_spoofed(self):
        err, _ = _call(self.srv, self.token, "create_inbox_item", {
            "title": "Tentative de spoof", "content": "x", "source": "evil-agent"})
        self.assertFalse(err)
        # the 'source' argument is ignored, and the path is forced to the acting person's lane
        self.assertFalse(list(self.srv.content_root.glob(f"inbox/{USER_SLUG}/evil-agent/*.md")))
        self.assertTrue(list(self.srv.content_root.glob(f"inbox/{USER_SLUG}/{TOKEN_SOURCE}/*.md")))

    def test_create_doc_cannot_plant_in_inbox(self):
        # direct create_doc under inbox/ is rejected (would land an unowned, commons item)
        err, msg = _call(self.srv, self.token, "create_doc",
                         {"path": "inbox/sneaky.md", "content": "x"})
        self.assertTrue(err)
        self.assertIn("create_inbox_item", str(msg).lower())
        self.assertFalse((self.srv.content_root / "inbox" / "sneaky.md").exists())

    def test_unbound_token_has_no_inbox(self):
        tok = secrets.token_hex(32)
        file_store_of(self.srv).upsert_user("loose@api.local", {
            "role": "api", "api_token_hash": hashlib.sha256(tok.encode()).hexdigest()})
        err, msg = _call(self.srv, tok, "create_inbox_item", {"title": "x", "content": "y"})
        self.assertTrue(err)
        self.assertIn("not bound", str(msg).lower())


if __name__ == "__main__":
    unittest.main()
