"""Tests of resume_session: recognising session saves (and not their model or a prompt), reading
one (resume line, open points with their wrapped lines, groups and links), dating the points by
the save's history and the points closed along the way, what changed since (commits by AI, the
linked docs), the chain of saves tied by wikilinks, the topic search and the errors.

MCP requires an 'api'-role Bearer token → cloud-mode harness, like test_mcp_tools.
"""
import sys
import unittest
from pathlib import Path

_TESTS_DIR = str(Path(__file__).resolve().parent)
if _TESTS_DIR not in sys.path:
    sys.path.insert(0, _TESTS_DIR)

from harness import AtlasServer  # noqa: E402
from test_cloud_filestore import cloud_env, ADMIN_EMAIL  # noqa: E402
from test_mcp_tools import _call  # noqa: E402
from test_mcp_sessions import _token  # noqa: E402

SAVE = """# Save Claude — Refonte de l'auth

> On remplace les sessions maison par OAuth. Ce doc est la reprise.

## 0. Comment reprendre

- **Machine** : `ROLEPLAY` · **Projet** : `C:\\workspace\\shop`
- **Même machine** : `cd C:\\workspace\\shop && claude --resume 1234-abcd`

## 7. Points en suspens

- Migrer les jetons existants : un script par lot, à lancer
  hors des heures de pointe.
- Purger les vieilles sessions.
- Ouverts à la clôture :
  - le jeton expire trop tôt sur mobile ;
  - la révocation n'atteint pas
    les sessions déjà ouvertes.

### Deux questions à trancher

- Durée des jetons de rafraîchissement ?
- Révocation à la déconnexion ?

### ⭐ La page de consentement

Elle reste à dessiner, voir [[notes/plan]].

```bash
- pas un point
```

## 8. Pointeurs

- Suite : [[ai-sessions/refonte-auth-suite]]

---

*Session du 2026-10-01 (Claude Opus). État : à mi-chemin, rien de déployé.*
"""
SUITE = """# Save — Refonte de l'auth, suite

## How to resume
- Machine: laptop.

## Next steps
- Ship it.
"""
HOSTING = """# Save — Hébergement

## How to resume
- Machine: laptop.

## Next steps
- Choisir l'hébergeur.
"""
MIND = {
    "accueil.md": "# Accueil\n",
    "notes/plan.md": "# Plan\n\nLe plan de l'auth.\n",
    "ai-sessions/refonte-auth.md": SAVE,
    "ai-sessions/refonte-auth-suite.md": SUITE,
    "ai-sessions/hebergement.md": HOSTING,
    "ai-sessions/TEMPLATE.md": "# MODÈLE — Save\n\n## Comment reprendre\n- Machine / projet.\n",
    "agents/prompts/save-session.md": "# Sauvegarder\n\nAvec une section ## Comment reprendre\n\n## Comment reprendre\n",
}
PATH = "ai-sessions/refonte-auth.md"


class TestResumeSession(unittest.TestCase):
    def setUp(self):
        self.srv = AtlasServer(extra_env=cloud_env(), mind=MIND)
        self.srv.start()
        self.token = _token(self.srv, "claude@api.local", ADMIN_EMAIL)

    def tearDown(self):
        self.srv.stop()

    def call(self, **args):
        return _call(self.srv, self.token, "resume_session", args)

    def edit(self, path, old, new):
        err, text = _call(self.srv, self.token, "edit_doc", {
            "path": path, "old_string": old, "new_string": new, "ai": "claude"})
        self.assertFalse(err, text)

    def test_lists_the_saves_only(self):
        # One line per piece of work: the two linked refonte saves show as the latest of them.
        self.edit("ai-sessions/refonte-auth-suite.md", "- Ship it.", "- Ship it now.")
        _, data = self.call()
        self.assertEqual({s["path"]: s.get("steps") for s in data["saves"]},
                         {"ai-sessions/refonte-auth-suite.md": 2, "ai-sessions/hebergement.md": None})

    def test_reads_a_save(self):
        _, data = self.call(path=PATH)
        save = data["save"]
        self.assertEqual((save["machine"], save["project"], save["resume"]),
                         ("ROLEPLAY", "C:\\workspace\\shop", "cd C:\\workspace\\shop && claude --resume 1234-abcd"))
        self.assertEqual((save["title"], save["session_date"], save["state"]),
                         ("Refonte de l'auth", "2026-10-01", "à mi-chemin, rien de déployé."))
        self.assertIn("sessions maison par OAuth", save["summary"])
        points = {p["text"]: p for p in data["open_points"]}
        self.assertIn("Migrer les jetons existants : un script par lot, à lancer hors des heures de pointe.",
                      points)  # its wrapped line joined back
        self.assertEqual(points["Révocation à la déconnexion ?"]["group"], "Deux questions à trancher")
        self.assertNotIn("Deux questions à trancher", points)  # a heading over a list only groups it
        self.assertEqual(points["⭐ La page de consentement"]["refs"], ["notes/plan.md"])
        self.assertNotIn("pas un point", points)  # inside a code fence
        # An item ending with a colon introduces the real points, in its sub-items.
        self.assertNotIn("Ouverts à la clôture :", points)
        self.assertEqual(points["la révocation n'atteint pas les sessions déjà ouvertes."]["group"],
                         "Ouverts à la clôture")
        self.assertIn("le jeton expire trop tôt sur mobile ;", points)

    def test_history_and_what_changed_since(self):
        self.edit(PATH, "- Purger les vieilles sessions.\n", "- Documenter le flux.\n")
        self.edit("notes/plan.md", "Le plan de l'auth.", "Le plan de l'auth, revu.")
        _, data = self.call(path=PATH)
        self.assertEqual([c["text"] for c in data["closed_points"]], ["Purger les vieilles sessions."])
        texts = [p["text"] for p in data["open_points"]]
        self.assertIn("Documenter le flux.", texts)
        since = data["since"]
        self.assertEqual((since["commits"], since["by_ai"]), (1, {"claude": 1}))
        self.assertEqual([(d["path"], d["ai"]) for d in since["linked"]], [("notes/plan.md", "claude")])
        self.assertRegex(since["linked"][0]["diff"], r"^\+\d+ −\d+$")  # what moved, without a doc_diff
        self.assertIn("+Le plan de l'auth, revu.", since["linked"][0]["excerpt"])
        self.assertEqual(since["unchanged"], ["ai-sessions/refonte-auth-suite.md"])
        consent = next(p for p in data["open_points"] if p["text"] == "⭐ La page de consentement")
        self.assertEqual([r["path"] for r in consent["refs_changed"]], ["notes/plan.md"])

    def test_chain_and_topic(self):
        _, data = self.call(topic="refonte auth suite")
        self.assertEqual(data["save"]["path"], "ai-sessions/refonte-auth-suite.md")
        self.assertEqual({c["path"] for c in data["chain"]}, {PATH, "ai-sessions/refonte-auth-suite.md"})
        self.assertEqual([m["path"] for m in data["other_matches"]], [PATH])

    def test_a_newer_save_is_flagged(self):
        # The best match is an older step of the work: the save written after it is named
        # first, so the agent can resume where the work actually is.
        self.edit("ai-sessions/refonte-auth-suite.md", "- Ship it.", "- Ship it this week.")
        _, data = self.call(topic="refonte auth sessions maison")
        self.assertEqual(data["save"]["path"], PATH)
        self.assertEqual(data["other_matches"][0], {
            "path": "ai-sessions/refonte-auth-suite.md", "title": "Refonte de l'auth, suite",
            "last_commit": data["other_matches"][0]["last_commit"], "newer": True})

    def test_the_resume_prompt(self):
        def text(**arguments):
            resp = self.srv.post(f"/mcp/{self.token}", json_body={
                "jsonrpc": "2.0", "id": 1, "method": "prompts/get",
                "params": {"name": "resume", "arguments": arguments}}).json()
            return resp["result"]["messages"][0]["content"]["text"]
        with_topic = text(topic="auth")
        self.assertIn("resume_session", with_topic)
        self.assertIn("auth", with_topic)
        self.assertIn("(no arguments)", text())

    def test_errors(self):
        err, text = self.call(path="notes/plan.md")
        self.assertTrue(err)
        self.assertIn("not a session save", text)
        err, text = self.call(topic="kubernetes")
        self.assertTrue(err)
        self.assertIn("without arguments", text)


if __name__ == "__main__":
    unittest.main()
