"""Characterization tests: navigation and reading.

Scope: static serving of the mind's .md/.html (with ?v=mtime), viewer on /,
PWA assets (manifest.json, icon.svg, sw.js), GET /api/tree (structure,
exclusions), GET /api/search (name>content scoring, fuzzy, snippets,
accents/case), "recent", /_backlinks.json, /_notes-index.json, and the
dotfile/.py guard of the static handler.

These tests encode the CURRENT server behavior (bugs and quirks included): they
do not validate a spec, they photograph what exists.
"""
import json
import os
import sys
import time
import unittest
import urllib.parse
from pathlib import Path

# `python3 -m unittest tests.test_browse` does not put tests/ on sys.path
# (unlike `discover -s tests`): we add it to import harness.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from harness import AtlasServer, DEFAULT_MIND  # noqa: E402


def _collect_files(node, acc=None):
    """Flatten the /api/tree tree → {path: file_node}."""
    if acc is None:
        acc = {}
    if node.get("type") == "file":
        acc[node["path"]] = node
    for child in node.get("children", []):
        _collect_files(child, acc)
    return acc


def _quoted_search(srv, q, extra=""):
    return srv.get("/api/search?q=" + urllib.parse.quote(q) + extra)


DECK_HTML = (
    "<!DOCTYPE html>\n"
    "<html><head><title>Deck</title>\n"
    "<style>.qpwxvzk { color: red; }</style>\n"
    "<script>var zzxcvqj = 1;</script>\n"
    "</head><body><h1>Présentation flamboyante</h1>"
    "<p>Contenu visible du deck.</p></body></html>\n"
)

# Long document to characterize the snippet window: the target is ~317
# characters from the start (> 60) and there are > 120 characters after it.
LONG_MD = (
    "# Document long\n\n"
    + "remplissage " * 25
    + "tresorcache au milieu du texte. "
    + "conclusion " * 30
)

BROWSE_MIND = dict(DEFAULT_MIND)
BROWSE_MIND.update({
    # Dotfile guard: present on disk, never served or indexed.
    ".secret.md": "# Secret\n\nJamais servi au navigateur.\n",
    # Code extension guard: present on disk, never served statically.
    "outil.py": "print('code source')\n",
    # skill/: out of the tree and out of search, but served statically.
    "skill/persona.md": "# Persona\n\nZanzibar mot introuvable via la recherche.\n",
    # Standalone first-class HTML document.
    "projets/deck.html": DECK_HTML,
    # File that is neither .md nor .html: listed by walk() but not indexed.
    "projets/notes.txt": "fichier texte hors viewer\n",
    # Deterministic search corpus.
    "recherche/girafe.md": "# Animal au long cou\n\nAucun rappel du nom dans le corps.\n",
    "recherche/savane.md": "# Savane\n\nLa girafe broute haut, la girafe domine.\n",
    "recherche/zebre.md": "# Zèbre\n\nLe zèbre raye la savane et broute des pissenlits zélés.\n",
    "recherche/longue.md": LONG_MD,
})


class TestBrowseMind(unittest.TestCase):
    """Read-only over an extended mind: a single server for the whole class."""

    srv: AtlasServer

    @classmethod
    def setUpClass(cls):
        # Explicitly exclude skill/ from the viewer (the engine default no longer
        # ships a personal "skill" name): this exercises the exclusion mechanism
        # via an opt-in [build].excluded_names at the mind ROOT, not a default.
        cls.srv = AtlasServer(
            mind=BROWSE_MIND,
            extra_files={"atlas.toml": '[build]\nexcluded_names = ["skill", "quick.md"]\n'})
        cls.srv.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    # ── static ───────────────────────────────────────────────────────────────

    def test_md_served_with_version_query_param(self):
        # The viewer requests docs as /<path>.md?v=<mtime> (cache-busting): the
        # static handler ignores the query string and serves the raw file.
        resp = self.srv.get("/accueil.md?v=1718000000")
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.body, BROWSE_MIND["accueil.md"].encode("utf-8"))
        self.assertEqual(resp.headers.get("Content-Type"), "text/markdown")

    def test_dotfile_doc_never_served_nor_indexed(self):
        self.assertTrue(self.srv.path(".secret.md").is_file())
        resp = self.srv.get("/.secret.md")
        self.assertEqual(resp.status, 404)
        self.assertNotIn("Jamais servi", resp.text)
        # The guard decodes the URL: %2E does not bypass the dotfile filter.
        self.assertEqual(self.srv.get("/%2Esecret.md").status, 404)
        # And search does not index it either (dotfiles out of _iter_doc_files).
        self.assertEqual(_quoted_search(self.srv, "jamais").json(), [])

    def test_python_file_not_served(self):
        # content/outil.py exists but the *.py guard returns 404 (protects code).
        self.assertTrue(self.srv.path("outil.py").is_file())
        self.assertEqual(self.srv.get("/outil.py").status, 404)

    def test_skill_doc_served_statically_but_invisible(self):
        # skill/ is excluded from the tree and from search... but is still
        # served statically (it is not a dotfile): "hidden from the viewer",
        # not private.
        resp = self.srv.get("/skill/persona.md")
        self.assertEqual(resp.status, 200)
        self.assertIn("Zanzibar", resp.text)
        tree = self.srv.get("/api/tree").json()
        self.assertNotIn("skill/persona.md", _collect_files(tree))
        self.assertEqual(_quoted_search(self.srv, "zanzibar").json(), [])

    def test_content_html_doc_served_raw(self):
        # A mind .html absent from dist/ falls back to static: served as-is,
        # Content-Type "text/html" WITHOUT charset (mimetypes Python 3.14),
        # unlike dist/ .html sent as "text/html; charset=utf-8".
        resp = self.srv.get("/projets/deck.html")
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.body, DECK_HTML.encode("utf-8"))
        self.assertEqual(resp.headers.get("Content-Type"), "text/html")

    def test_directory_listing_exposed(self):
        # Characterization (surprising): GET /<dir>/ hits no dist/ index.html →
        # SimpleHTTPRequestHandler generates a listing of the corresponding
        # content/ directory (the mind's files are exposed).
        resp = self.srv.get("/projets/")
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.headers.get("Content-Type"), "text/html; charset=utf-8")
        self.assertIn("alpha.md", resp.text)
        self.assertIn("notes.txt", resp.text)
        # Without trailing slash: 301 redirect from the stdlib handler.
        resp = self.srv.get("/projets")
        self.assertEqual(resp.status, 301)
        self.assertEqual(resp.headers.get("Location"), "/projets/")

    def test_pwa_assets(self):
        # manifest.json is GENERATED by build.py into dist/ from the config
        # (Phase 2a) and routed by translate_path, served by the static handler
        # (mimetype guessed, no charset); icon.svg always comes from web/.
        resp = self.srv.get("/manifest.json")
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.headers.get("Content-Type"), "application/json")
        self.assertEqual(resp.json()["name"], "Atlas Mind")  # neutral default
        resp = self.srv.get("/icon.svg")
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.headers.get("Content-Type"), "image/svg+xml")
        # sw.js has its dedicated route: no-cache + explicit root scope.
        resp = self.srv.get("/sw.js")
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.headers.get("Content-Type"),
                         "application/javascript; charset=utf-8")
        self.assertEqual(resp.headers.get("Cache-Control"), "no-cache")
        self.assertEqual(resp.headers.get("Service-Worker-Allowed"), "/")
        # CACHE_VERSION is stamped with the engine version at serve time so each
        # release busts the worker's cache (otherwise unversioned vendored assets
        # like tailwind.css are served stale forever after a deploy).
        sw_body = resp.text
        self.assertNotIn("__ENGINE_VERSION__", sw_body)
        self.assertIn("atlas-cache-", sw_body)
        # Characterization: /favicon.ico is routed to web/favicon.ico... which
        # does not exist (web/ contains only icon.svg) → 404.
        self.assertEqual(self.srv.get("/favicon.ico").status, 404)

    # ── /api/tree ────────────────────────────────────────────────────────────

    def test_tree_root_order_and_pruning(self):
        tree = self.srv.get("/api/tree").json()
        names = [child["name"] for child in tree["children"]]
        # Order: directories first (case-insensitive alpha), then files.
        # skill/ and .secret.md are excluded; notes/ disappears ENTIRELY because
        # its only content (quick.md, the to-do) is excluded → empty dir pruned.
        self.assertEqual(names, ["projets", "recherche", "accueil.md", "outil.py"])
        projets = next(c for c in tree["children"] if c["name"] == "projets")
        self.assertEqual([c["name"] for c in projets["children"]],
                         ["alpha.md", "beta.md", "deck.html", "notes.txt"])

    def test_tree_file_metadata(self):
        files = _collect_files(self.srv.get("/api/tree").json())
        alpha = files["projets/alpha.md"]
        self.assertEqual(alpha["ext"], ".md")
        self.assertEqual(alpha["tags"], ["projets"])  # tags = parent dirs
        self.assertEqual(alpha["words"],
                         len(BROWSE_MIND["projets/alpha.md"].split()))
        self.assertIsInstance(alpha["mtime"], int)
        # Doc at the root: no parent dir → no "tags" key at all.
        self.assertNotIn("tags", files["accueil.md"])
        # A .html is a first-class doc: words counted (tags stripped).
        deck = files["projets/deck.html"]
        self.assertEqual(deck["ext"], ".html")
        self.assertEqual(deck["tags"], ["projets"])
        self.assertIn("words", deck)
        # Characterization: walk() lists ALL files, even non-servable ones.
        # outil.py (404 as static) and notes.txt appear in the tree, without
        # words/tags metadata (reserved for .md/.html).
        self.assertEqual(files["outil.py"]["ext"], ".py")
        self.assertNotIn("words", files["outil.py"])
        self.assertEqual(files["projets/notes.txt"]["ext"], ".txt")
        self.assertNotIn("words", files["projets/notes.txt"])

    # ── /api/search ──────────────────────────────────────────────────────────

    def test_search_name_weighted_over_content(self):
        resp = _quoted_search(self.srv, "girafe")
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.headers.get("Content-Type"),
                         "application/json; charset=utf-8")
        hits = resp.json()
        # Occurrence in the name = 3 points, in the content = 1 point:
        # girafe.md (name only, 3) beats savane.md (2 content occurrences, 2).
        self.assertEqual([(h["path"], h["score"]) for h in hits],
                         [("recherche/girafe.md", 3), ("recherche/savane.md", 2)])

    def test_search_accent_and_case_insensitive(self):
        # Uppercase + accent query, accented content: everything is normalized
        # NFD/lowercase. Score = name (1×3) + content ("# Zèbre" + "Le zèbre" = 2).
        for q in ("ZÈBRE", "zebre"):
            hits = _quoted_search(self.srv, q).json()
            self.assertEqual(len(hits), 1, q)
            self.assertEqual(hits[0]["path"], "recherche/zebre.md")
            self.assertEqual(hits[0]["score"], 5)

    def test_search_fuzzy_typo_correction(self):
        # "pissenlots" exists nowhere: token of ≥ 4 letters absent from the
        # vocabulary → corrected via difflib to "pissenlits" (cutoff 0.78).
        hits = _quoted_search(self.srv, "pissenlots").json()
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["path"], "recherche/zebre.md")
        self.assertIn("pissenlits", hits[0]["snippet"])

    def test_search_snippet_window_with_ellipses(self):
        hits = _quoted_search(self.srv, "tresorcache").json()
        self.assertEqual(hits[0]["path"], "recherche/longue.md")
        snippet = hits[0]["snippet"]
        # Window: 60 characters before the 1st occurrence, 120 after, ellipses
        # on both sides when truncated, newlines flattened into spaces.
        self.assertTrue(snippet.startswith("…"))
        self.assertTrue(snippet.endswith("…"))
        self.assertIn("tresorcache au milieu du texte.", snippet)
        self.assertNotIn("\n", snippet)
        self.assertNotIn("# Document long", snippet)

    def test_search_snippet_for_name_only_match(self):
        # Match only in the name → no position in the content: the snippet is
        # the start of the document (160 characters max, no ellipsis here).
        hits = _quoted_search(self.srv, "girafe").json()
        girafe = next(h for h in hits if h["path"] == "recherche/girafe.md")
        expected = (BROWSE_MIND["recherche/girafe.md"][:160]
                    .replace("\n", " ").strip())
        self.assertEqual(girafe["snippet"], expected)

    def test_search_empty_query_and_limit(self):
        self.assertEqual(self.srv.get("/api/search?q=").json(), [])
        self.assertEqual(self.srv.get("/api/search").json(), [])
        # limit clamped to [1, 50]; limit=1 keeps only the best score.
        hits = _quoted_search(self.srv, "girafe", "&limit=1").json()
        self.assertEqual([h["path"] for h in hits], ["recherche/girafe.md"])
        # non-numeric limit: silently falls back to 50.
        resp = _quoted_search(self.srv, "girafe", "&limit=abc")
        self.assertEqual(resp.status, 200)
        self.assertEqual(len(resp.json()), 2)

    def test_search_html_indexes_visible_text_only(self):
        # .html files are indexed on their visible text: <script> and <style>
        # are removed wholesale, the tags stripped.
        hits = _quoted_search(self.srv, "flamboyante").json()
        self.assertEqual(hits[0]["path"], "projets/deck.html")
        self.assertNotIn("<", hits[0]["snippet"])
        self.assertIn("Présentation flamboyante", hits[0]["snippet"])
        self.assertEqual(_quoted_search(self.srv, "zzxcvqj").json(), [])  # script
        self.assertEqual(_quoted_search(self.srv, "qpwxvzk").json(), [])  # style

    def test_search_no_match_returns_empty(self):
        # Short token (< 4) never corrected; nor a long token with no near neighbor.
        self.assertEqual(_quoted_search(self.srv, "zq").json(), [])
        self.assertEqual(_quoted_search(self.srv, "wxkjvzqrn").json(), [])

    # ── recent ───────────────────────────────────────────────────────────────

    def test_api_recent_session_route_does_not_exist(self):
        # Characterization (surprising): there is NO session route /api/recent —
        # the feature exists only via Bearer (/api/v1/recent) and via MCP
        # (recent_docs). The path falls back to the static handler →
        # http.server's HTML 404 page, not JSON.
        resp = self.srv.get("/api/recent")
        self.assertEqual(resp.status, 404)
        self.assertEqual(resp.headers.get("Content-Type"), "text/html;charset=utf-8")

    def test_api_v1_recent_requires_bearer_even_in_local_mode(self):
        # Unlike session routes (simulated admin auth in local mode),
        # /api/v1/* requires a Bearer even in local mode.
        resp = self.srv.get("/api/v1/recent")
        self.assertEqual(resp.status, 401)
        self.assertEqual(resp.json(), {"error": "invalid or missing bearer token"})
        # With any token: a bogus Bearer is not found in the registry → 401
        # fail-closed in local mode.
        resp = self.srv.get("/api/v1/recent",
                            headers={"Authorization": "Bearer anything"})
        self.assertEqual(resp.status, 401)

    # ── /_backlinks.json ─────────────────────────────────────────────────────

    def test_backlinks_graph(self):
        resp = self.srv.get("/_backlinks.json")
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.headers.get("Content-Type"),
                         "application/json; charset=utf-8")
        self.assertEqual(resp.headers.get("Cache-Control"), "no-cache")
        self.assertIsNotNone(resp.headers.get("ETag"))
        # Graph of [[wikilinks]]: resolution by path ([[projets/alpha]]), by
        # full path ([[projets/beta.md]]), by stem ([[accueil]]) and with an
        # alias ([[beta|le projet Bêta]]). Only linked docs have an entry:
        # girafe.md & co (no links) are absent from the index.
        self.assertEqual(resp.json(), {
            "accueil.md": {"out": ["projets/alpha.md", "projets/beta.md"],
                           "in": ["projets/alpha.md"]},
            "projets/alpha.md": {"out": ["accueil.md", "projets/beta.md"],
                                 "in": ["accueil.md"]},
            "projets/beta.md": {"out": [],
                                "in": ["accueil.md", "projets/alpha.md"]},
        })

    def test_backlinks_etag_revalidation(self):
        first = self.srv.get("/_backlinks.json")
        etag = first.headers.get("ETag")
        again = self.srv.get("/_backlinks.json", headers={"If-None-Match": etag})
        self.assertEqual(again.status, 304)
        self.assertEqual(again.body, b"")

    # ── /_notes-index.json ───────────────────────────────────────────────────

    def test_notes_index_served_from_dist(self):
        # Index of the tree's "📝 n" badges, generated by build.py into dist/:
        # served by the same gzip+ETag route as _backlinks.json. Without any
        # annotation at build time the index is an empty object, but the route
        # answers 200 — a 404 would make the badges disappear silently (the
        # viewer falls back to {} when res.ok is false).
        resp = self.srv.get("/_notes-index.json")
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.headers.get("Content-Type"),
                         "application/json; charset=utf-8")
        self.assertEqual(resp.headers.get("Cache-Control"), "no-cache")
        self.assertIsNotNone(resp.headers.get("ETag"))
        self.assertEqual(resp.json(), {})

    def test_notes_index_etag_revalidation(self):
        first = self.srv.get("/_notes-index.json")
        etag = first.headers.get("ETag")
        again = self.srv.get("/_notes-index.json",
                             headers={"If-None-Match": etag})
        self.assertEqual(again.status, 304)
        self.assertEqual(again.body, b"")


class TestBrowseDiskState(unittest.TestCase):
    """Tests that mutate the mind's disk: a fresh server per test."""

    def setUp(self):
        self.srv = AtlasServer()
        self.srv.start()
        self.addCleanup(self.srv.stop)

    def test_uncommitted_file_appears_in_tree_with_stat_mtime(self):
        # /api/tree reads the disk live: a doc written outside the server (never
        # committed) appears immediately, mtime = st_mtime (no git date).
        target = self.srv.path("inbox/brouillon.md")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("# Brouillon\n\nNon committé.\n", encoding="utf-8")
        files = _collect_files(self.srv.get("/api/tree").json())
        self.assertIn("inbox/brouillon.md", files)
        self.assertEqual(files["inbox/brouillon.md"]["mtime"],
                         int(target.stat().st_mtime))

    def test_tree_uses_git_commit_date_but_search_uses_stat_mtime(self):
        # Characterization: the two endpoints do not mean the same "mtime".
        # /api/tree = date of the last git commit touching the file (fallback to
        # st_mtime if uncommitted); /api/search = raw disk st_mtime.
        ancient = 1_000_000_000  # 2001-09-09, far from the commit date
        path = self.srv.path("projets/alpha.md")
        os.utime(path, (ancient, ancient))
        files = _collect_files(self.srv.get("/api/tree").json())
        tree_mtime = files["projets/alpha.md"]["mtime"]
        self.assertGreater(tree_mtime, time.time() - 3600)  # harness commit
        hits = _quoted_search(self.srv, "heterogene").json()
        self.assertEqual(hits[0]["path"], "projets/alpha.md")
        self.assertEqual(hits[0]["mtime"], ancient)

    def test_notes_index_counts_sidecar_notes_after_rebuild(self):
        # build.py aggregates the .notes/**/*.json sidecars into
        # {rel_doc: note_count}: after a rebuild, the route serves the counters
        # of the tree's badges.
        sidecar = self.srv.root / ".notes" / "projets" / "alpha.md.json"
        sidecar.parent.mkdir(parents=True, exist_ok=True)
        notes = [{"id": "a" * 12, "exact": "déjà", "note": "première"},
                 {"id": "b" * 12, "exact": "café", "note": "seconde"}]
        sidecar.write_text(json.dumps({"version": 1, "notes": notes}),
                           encoding="utf-8")
        self.srv.build()
        resp = self.srv.get("/_notes-index.json")
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.json(), {"projets/alpha.md": 2})

    def test_dist_html_takes_precedence_over_content(self):
        # For a .html path, dist/ is consulted before content/: on a name
        # collision, the build artifact wins over the mind's doc.
        self.srv.path("page.html").write_text("STATIC-CONTENT", encoding="utf-8")
        dist_page = self.srv.dist_dir / "page.html"
        dist_page.write_text("DIST-CONTENT", encoding="utf-8")
        resp = self.srv.get("/page.html")
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.body, b"DIST-CONTENT")
        self.assertEqual(resp.headers.get("Content-Type"), "text/html; charset=utf-8")
        # dist/ gone → falls back to content/, served by the static handler
        # (Content-Type without charset this time).
        dist_page.unlink()
        resp = self.srv.get("/page.html")
        self.assertEqual(resp.body, b"STATIC-CONTENT")
        self.assertEqual(resp.headers.get("Content-Type"), "text/html")


if __name__ == "__main__":
    unittest.main()
