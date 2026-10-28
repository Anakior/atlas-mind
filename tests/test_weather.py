"""Tests of mind_weather: the mind region by region (activity, fog, storms, the AI's share), the
periodic docs gone missing and the docs flagged outdated. The mind's first commit is dated 2025, so
everything starts in the fog; its monthly reports are named relative to today, so one is late.
"""
import datetime as dt
import sys
import unittest
from pathlib import Path

_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

from harness import AtlasServer  # noqa: E402
from test_cloud_filestore import cloud_env, ADMIN_EMAIL  # noqa: E402
from test_mcp_tools import _call  # noqa: E402
from test_mcp_sessions import _token  # noqa: E402

_MONTHS = ["janvier", "fevrier", "mars", "avril", "mai", "juin", "juillet", "aout", "septembre",
           "octobre", "novembre", "decembre"]


def months_ago(n: int) -> tuple:
    """(file-name period, label) of the month n months before this one."""
    today = dt.date.today()
    index = today.year * 12 + today.month - 1 - n
    year, month = divmod(index, 12)
    return f"{_MONTHS[month]}-{year}", f"{year}-{month + 1:02d}"


MIND = {
    "accueil.md": "# Accueil\n",
    "specs/relances.md": "# Relances\n\nTrois relances, à J+1, J+3 et J+7.\n",
    "specs/tarifs.md": "# Tarifs\n\nLe plan Pro est à 29 €.\n",
    "specs/api/auth.md": "# Auth\n\nDes jetons de 30 jours.\n",
    **{f"rapports/bilan-{months_ago(n)[0]}.md": f"# Bilan\n\nLe mois {n}.\n" for n in (6, 5, 4)},
}


def old_mind():
    """A server on MIND whose first commit is old; the ones the server makes are today's."""
    srv = AtlasServer(extra_env=cloud_env(), mind=MIND, seed_date="2025-01-15T12:00:00")
    srv.start()
    return srv


class TestWeather(unittest.TestCase):
    def setUp(self):
        self.srv = old_mind()
        self.token = _token(self.srv, "claude@api.local", ADMIN_EMAIL)

    def tearDown(self):
        self.srv.stop()

    def call(self, tool, **args):
        err, data = _call(self.srv, self.token, tool, args)
        self.assertFalse(err, data)
        return data

    def regions(self, data):
        return {r["path"]: r for top in data["regions"] for r in (top, *top["children"])}

    def test_the_map(self):
        data = self.call("mind_weather")
        self.assertEqual((data["weeks"], data["months"]), (4, 3))
        self.assertEqual(data["totals"]["docs"], 7)
        self.assertEqual(data["totals"]["fog"], 7)  # nothing looked at since 2025
        regions = self.regions(data)
        self.assertEqual({p: regions[p]["docs"] for p in ("specs", "specs/api", "rapports", "")},
                         {"specs": 3, "specs/api": 1, "rapports": 3, "": 1})
        specs = next(r for r in data["regions"] if r["path"] == "specs")
        self.assertEqual([c["path"] for c in specs["children"]], ["specs/api"])

    def test_activity_and_what_was_settled(self):
        self.call("edit_doc", path="specs/relances.md", old_string="J+7", new_string="J+10", ai="claude")
        self.call("confirm_doc", path="specs/tarifs.md", verdict="outdated", note="le Pro est à 35 €")
        data = self.call("mind_weather")
        specs = self.regions(data)["specs"]
        self.assertEqual((specs["commits"], specs["changed"], specs["ai_share"]), (1, 1, 1.0))
        self.assertEqual((specs["fog"], specs["outdated"]), (1, 1))  # api/auth only: edited, flagged
        self.assertEqual([d["path"] for d in data["outdated"]], ["specs/tarifs.md"])
        self.assertEqual(data["totals"]["fog"], 5)

    def test_a_late_report(self):
        late = self.call("mind_weather")["missed"]
        self.assertEqual([s["series"] for s in late], ["rapports/bilan"])
        self.assertEqual(late[0]["every"], "month")
        self.assertEqual(late[0]["missed"][:2], [months_ago(3)[1], months_ago(2)[1]])

    def test_a_region_to_review(self):
        data = self.call("stale", months=3, prefix="specs")
        self.assertEqual(sorted(s["path"] for s in data["stale"]),
                         ["specs/api/auth.md", "specs/relances.md", "specs/tarifs.md"])
        self.assertEqual([s["path"] for s in self.call("stale", months=3, prefix="specs/api")["stale"]],
                         ["specs/api/auth.md"])


if __name__ == "__main__":
    unittest.main()
