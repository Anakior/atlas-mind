"""attribution_for(ctx, ai) → (author, trailers).

A human editing alone authors it with no trailer; an MCP write carries the AI family
the actor declares as an `X-Atlas-Author: ai/<family>` trailer (slugified, so it can't
inject); an api account has no human author (the bot authors); anonymous has neither."""
import sys
import unittest
from pathlib import Path

REPO_SRC = str(Path(__file__).resolve().parent.parent / "src")
if REPO_SRC not in sys.path:
    sys.path.insert(0, REPO_SRC)

import server as _s            # noqa: E402
from server.pure import acl    # noqa: E402

API = _s.API_ROLE
HUMAN = {"email": "ada@x", "first_name": "Ada", "last_name": "Lovelace", "role": "admin"}
BOT = {"email": "bot@api.local", "role": API}


class FakeStore:
    def __init__(self, users):
        self._users = users

    def get_user_by_email(self, email):
        return self._users.get(email)


def _ctx(primary, api=False):
    return acl.ViewerCtx(frozenset(), False, primary, api=api)


class TestAttribution(unittest.TestCase):
    def setUp(self):
        self.store = FakeStore({"ada@x": HUMAN, "bot@api.local": BOT})

    def test_human_alone_has_no_trailer(self):
        author, trailers = acl.attribution_for(_ctx("user:ada@x"), store=self.store)
        self.assertEqual(author, ("Ada Lovelace", "ada@x"))
        self.assertEqual(trailers, [])

    def test_mcp_write_marks_the_ai_family(self):
        author, trailers = acl.attribution_for(
            _ctx("user:ada@x", api=True), ai="claude", store=self.store)
        self.assertEqual(author, ("Ada Lovelace", "ada@x"))
        self.assertEqual(trailers, ["X-Atlas-Author: ai/claude"])

    def test_api_account_is_bot_authored(self):
        author, trailers = acl.attribution_for(
            _ctx("user:bot@api.local", api=True), ai="claude", store=self.store)
        self.assertIsNone(author)
        self.assertEqual(trailers, ["X-Atlas-Author: ai/claude"])

    def test_ai_value_is_slugified_so_it_cannot_inject(self):
        _, trailers = acl.attribution_for(
            _ctx("user:ada@x", api=True), ai="Claude\nFake-Trailer: x", store=self.store)
        self.assertEqual(len(trailers), 1)
        self.assertNotIn("\n", trailers[0])
        self.assertTrue(trailers[0].startswith("X-Atlas-Author: ai/"))

    def test_anonymous_has_no_attribution(self):
        self.assertEqual(acl.attribution_for(_ctx(None), store=self.store), (None, []))


if __name__ == "__main__":
    unittest.main()
