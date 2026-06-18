"""Unit tests for the pure ACL core (model B): effective_level resolution —
socle commun / privé / partages / héritage de dossier + le cas-piège
(enfant privé sous dossier partagé). No HTTP server: a real FileStore in a temp
dir + the pure functions. Run: python tests/test_acl_unit.py
"""
import sys
import tempfile
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
SRC = TESTS_DIR.parent / "src"
for p in (str(SRC), str(TESTS_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

import store  # noqa: E402
from server.pure import acl  # noqa: E402


class TestEffectiveLevel(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.fs = store.FileStore(Path(self._tmp.name) / ".atlas")

    def tearDown(self):
        self._tmp.cleanup()

    def ctx(self, email, role="viewer"):
        return acl.viewer_ctx({"email": email, "role": role}, self.fs)

    def lvl(self, rel, ctx):
        return acl.effective_level(rel, ctx, self.fs)

    # ── socle commun ──────────────────────────────────────────────────────
    def test_common_visible_to_authenticated_human(self):
        self.assertEqual(self.lvl("a/b.md", self.ctx("u@x")), "view")

    def test_anonymous_sees_nothing(self):
        self.assertIsNone(self.lvl("a/b.md", acl.ANON))

    def test_common_is_view_only_for_non_admin(self):
        self.assertFalse(acl.can_write("a/b.md", self.ctx("u@x"), "edit", self.fs))

    # ── admin (curates commons, NOT others' private) + superuser ──────────
    def test_admin_curates_commons_not_others_private(self):
        admin = acl.viewer_ctx({"email": "boss@x", "role": "admin"}, self.fs)
        self.assertEqual(self.lvl("a/b.md", admin), "owner")        # commons → curate
        self.fs.set_owner("secret.md", "user:owner@x")
        self.assertIsNone(self.lvl("secret.md", admin))             # other's private → hidden
        self.fs.set_owner("mine.md", "user:boss@x")
        self.assertEqual(self.lvl("mine.md", admin), "owner")       # own doc → owner

    def test_superuser_sees_everything(self):
        su = acl.ViewerCtx(set(), True, None, superuser=True)
        self.fs.set_owner("secret.md", "user:owner@x")
        self.assertEqual(self.lvl("secret.md", su), "owner")        # local bypass

    # ── privé / owner ─────────────────────────────────────────────────────
    def test_private_hidden_from_others(self):
        self.fs.set_owner("secret.md", "user:owner@x")
        self.assertIsNone(self.lvl("secret.md", self.ctx("intruder@x")))

    def test_owner_sees_own(self):
        self.fs.set_owner("secret.md", "user:owner@x")
        self.assertEqual(self.lvl("secret.md", self.ctx("owner@x")), "owner")

    # ── partages ──────────────────────────────────────────────────────────
    def test_direct_grant(self):
        self.fs.set_owner("doc.md", "user:owner@x")
        self.fs.grant("doc.md", "user:fab@x", "edit")
        self.assertEqual(self.lvl("doc.md", self.ctx("fab@x")), "edit")

    def test_group_grant_member_and_outsider(self):
        self.fs.set_group("wizishop", ["fab@x", "lea@x"])
        self.fs.set_owner("doc.md", "user:owner@x")
        self.fs.grant("doc.md", "group:wizishop", "view")
        self.assertEqual(self.lvl("doc.md", self.ctx("lea@x")), "view")
        self.assertIsNone(self.lvl("doc.md", self.ctx("out@x")))

    def test_most_permissive_grant_wins(self):
        self.fs.set_group("g", ["fab@x"])
        self.fs.set_owner("doc.md", "user:o@x")
        self.fs.grant("doc.md", "user:fab@x", "view")
        self.fs.grant("doc.md", "group:g", "edit")
        self.assertEqual(self.lvl("doc.md", self.ctx("fab@x")), "edit")

    def test_expired_grant_ignored(self):
        self.fs.set_owner("doc.md", "user:o@x")
        self.fs.grant("doc.md", "user:fab@x", "view", expires_at=1)  # epoch 1 = long past
        self.assertIsNone(self.lvl("doc.md", self.ctx("fab@x")))

    # ── héritage de dossier ───────────────────────────────────────────────
    def test_folder_inheritance_additive(self):
        self.fs.set_group("team", ["fab@x"])
        self.fs.set_owner("wizishop", "user:o@x")
        self.fs.grant("wizishop", "group:team", "view")
        self.assertEqual(self.lvl("wizishop/notes.md", self.ctx("fab@x")), "view")

    def test_inheritance_cut_for_private_child(self):
        # THE trap: a private child under a shared folder must NOT be re-exposed.
        self.fs.set_group("team", ["fab@x"])
        self.fs.set_owner("wizishop", "user:o@x")
        self.fs.grant("wizishop", "group:team", "view")
        self.fs.set_owner("wizishop/secret.md", "user:o@x")  # explicit private child
        self.assertIsNone(self.lvl("wizishop/secret.md", self.ctx("fab@x")))
        self.assertEqual(self.lvl("wizishop/secret.md", self.ctx("o@x")), "owner")

    def test_child_can_add_grant_under_owned_folder(self):
        self.fs.set_owner("wizishop", "user:o@x")
        self.fs.set_owner("wizishop/doc.md", "user:o@x")
        self.fs.grant("wizishop/doc.md", "user:fab@x", "edit")
        self.assertEqual(self.lvl("wizishop/doc.md", self.ctx("fab@x")), "edit")

    # ── tokens api / acts_as (decision §11.2) ─────────────────────────────
    def test_acts_as_inherits_human(self):
        self.fs.upsert_user("human@x", {"role": "viewer"})
        self.fs.set_owner("doc.md", "user:human@x")
        c = acl.viewer_ctx(
            {"email": "tok@api.local", "role": "api", "acts_as": "human@x"}, self.fs)
        self.assertEqual(self.lvl("doc.md", c), "owner")

    def test_bare_api_token_sees_commons_not_private(self):
        c = acl.viewer_ctx({"email": "tok@api.local", "role": "api"}, self.fs)
        self.assertEqual(self.lvl("a/b.md", c), "view")   # commons visible
        self.fs.set_owner("secret.md", "user:o@x")
        self.assertIsNone(self.lvl("secret.md", c))       # private stays hidden
        # an explicit grant on its own principal elevates a specific doc
        self.fs.set_owner("doc.md", "user:o@x")
        self.fs.grant("doc.md", "user:tok@api.local", "view")
        self.assertEqual(self.lvl("doc.md", c), "view")

    # ── repoint (move/rename) ─────────────────────────────────────────────
    def test_repoint_acl_by_path(self):
        self.fs.set_owner("old.md", "user:o@x")
        self.fs.grant("old.md", "user:fab@x", "edit")
        self.assertTrue(self.fs.repoint_acl_by_path("old.md", "new.md"))
        self.assertIsNone(self.fs.get_acl("old.md"))
        self.assertEqual(self.lvl("new.md", self.ctx("fab@x")), "edit")

    def test_repoint_acl_under_folder(self):
        self.fs.set_owner("dir", "user:o@x")
        self.fs.set_owner("dir/a.md", "user:o@x")
        self.fs.set_owner("other.md", "user:o@x")
        moved = self.fs.repoint_acl_under("dir", "dir2")
        self.assertEqual(moved, 2)
        self.assertIsNotNone(self.fs.get_acl("dir2"))
        self.assertIsNotNone(self.fs.get_acl("dir2/a.md"))
        self.assertIsNotNone(self.fs.get_acl("other.md"))  # untouched

    # ── revoke / delete ───────────────────────────────────────────────────
    def test_revoke_grant(self):
        self.fs.set_owner("doc.md", "user:o@x")
        self.fs.grant("doc.md", "user:fab@x", "edit")
        self.assertTrue(self.fs.revoke_grant("doc.md", "user:fab@x"))
        self.assertIsNone(self.lvl("doc.md", self.ctx("fab@x")))
        self.assertFalse(self.fs.revoke_grant("doc.md", "user:fab@x"))


if __name__ == "__main__":
    unittest.main()
