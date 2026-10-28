"""Tests of the weather view (MCP Apps): mind_weather names it, the server serves it, and the
stand-in host renders it on a live result: the folders ranked by their fog and the late reports,
then a folder's fog cleared one doc at a time, each verdict recorded through confirm_doc in the
user's name and told to the model. See appview.py.
"""
import sys
import unittest
from pathlib import Path

_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

from appview import ViewTestCase  # noqa: E402
from test_weather import MIND  # noqa: E402


class TestWeatherView(ViewTestCase):
    MIND, VIEW, TOOL, SEED_DATE = MIND, "ui://atlas/weather", "mind_weather", "2025-01-15T12:00:00"

    def test_the_tool_names_its_view(self):
        self.assert_served()

    def test_the_fog_is_cleared(self):
        report = self.host({}, theme="dark")
        self.assertEqual(report["title"], "The Atlas weather")
        # The folders ranked by their fog, each with its number: all of the mind is in it.
        self.assertEqual(report["regions"][-1], "root")
        self.assertEqual(set(report["regions"]), {"specs", "rapports", "root"})
        self.assertEqual(report["values"][-1], "1 of 1")
        self.assertTrue(report["missed"])  # the late monthly report
        calls = [m["params"] for m in self.sent(report, "tools/call")]
        stale = next(c["arguments"] for c in calls if c["name"] == "stale")
        self.assertEqual(stale["prefix"], report["panel"])  # the region picked on the map
        confirm = next(c["arguments"] for c in calls if c["name"] == "confirm_doc")
        self.assertEqual(confirm["verdict"], "holds")
        self.assertNotIn("ai", confirm)  # the user's own decision
        self.assertTrue(confirm["path"].startswith(report["panel"] + "/"))
        self.assertIn(confirm["path"], self.sent(report, "ui/update-model-context")[-1]["params"]["content"][0]["text"])
        # The verdict is recorded: the doc left the fog.
        fog = self.rpc("tools/call", {"name": "stale", "arguments": {"months": 3}})["structuredContent"]["stale"]
        self.assertNotIn(confirm["path"], [d["path"] for d in fog])


if __name__ == "__main__":
    unittest.main()
