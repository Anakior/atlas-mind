"""attribution_for(ctx) → (author, trailers).

A human editing alone authors it with no trailer; an MCP token acting for a human
authors it to that human + an `X-Atlas-Author: ai/<label>` trailer; an autonomous token
has no human author (the bot authors) + the trailer; anonymous has neither."""
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
BOT = {"email": "bot@api.local", "role": API, "label": "bot"}


class FakeStore:
    def __init__(self, users, groups=None):
        self._users, self._groups = users, groups or {}

    def get_user_by_email(self, email):
        return self._users.get(email)

    def groups_for_email(self, email):
        return self._groups.get(email, [])


def _ctx(primary, agent=None, api=False):
    return acl.ViewerCtx(frozenset(), False, primary, api=api, agent=agent)


class TestAttribution(unittest.TestCase):
    def setUp(self):
        self.store = FakeStore({"ada@x": HUMAN, "bot@api.local": BOT})

    def test_human_alone_has_no_trailer(self):
        author, trailers = acl.attribution_for(_ctx("user:ada@x"), self.store)
        self.assertEqual(author, ("Ada Lovelace", "ada@x"))
        self.assertEqual(trailers, [])

    def test_mcp_for_a_human_marks_the_ai(self):
        author, trailers = acl.attribution_for(
            _ctx("user:ada@x", agent="claude", api=True), self.store)
        self.assertEqual(author, ("Ada Lovelace", "ada@x"))
        self.assertEqual(trailers, ["X-Atlas-Author: ai/claude"])

    def test_autonomous_ai_is_bot_authored_and_marked(self):
        author, trailers = acl.attribution_for(
            _ctx("user:bot@api.local", agent="bot", api=True), self.store)
        self.assertIsNone(author)
        self.assertEqual(trailers, ["X-Atlas-Author: ai/bot"])

    def test_anonymous_has_no_attribution(self):
        self.assertEqual(acl.attribution_for(_ctx(None), self.store), (None, []))

    def test_viewer_ctx_threads_token_label_into_agent(self):
        bound = acl.viewer_ctx({"email": "claude@api.local", "role": API,
                                "acts_as": "ada@x", "label": "claude"}, self.store)
        self.assertEqual(bound.agent, "claude")
        self.assertEqual(bound.primary, "user:ada@x")                # acts AS the human
        unbound = acl.viewer_ctx({"email": "bot@api.local", "role": API,
                                  "acts_as": None, "label": "bot"}, self.store)
        self.assertEqual(unbound.agent, "bot")


if __name__ == "__main__":
    unittest.main()
