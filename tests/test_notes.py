"""Characterization tests for inline annotations: /api/notes.

Scope: GET (listing per doc), POST (creation), PATCH (text editing),
DELETE (deletion), plus the JSON sidecar .notes/<rel>.json and the size
limits (exact 2000, note 5000, prefix/suffix 120).

Current behaviors encoded as-is (server.py, _notes_path/load_notes/
save_notes + do_GET/do_POST/do_PATCH/do_DELETE routes):
- The annotated doc does NOT need to exist under content/: no existence or
  extension check (.txt, phantom path... anything goes).
- POST /api/notes matches the path EXACTLY: a query string (?path=...)
  drops the request into do_POST's final 404.
- exact/note are strip()ed THEN truncated; prefix/suffix are truncated to 120
  WITHOUT strip (edge whitespace survives).
- pos goes through _safe_int: non-numeric → 0 (never an error).
- Corrupt sidecar (invalid JSON) → load_notes returns [] without error, and the
  next POST silently OVERWRITES the corrupt file.
- save_notes([]) deletes the sidecar: deleting the last note unlinks the
  file.

All writes use rel paths unique per test → a single server shared across the
whole module (boot ~150 ms, harmless background trigger_sync).
"""
import json
import time
import unittest

from harness import AtlasServer

SRV: AtlasServer = None


def setUpModule():
    global SRV
    SRV = AtlasServer()
    SRV.start()


def tearDownModule():
    SRV.stop()


def create_note(rel: str, **overrides):
    """POST /api/notes with a valid default payload, overridden per test."""
    payload = {
        "path": rel,
        "exact": "Bienvenue dans le mind",
        "prefix": "# Accueil ",
        "suffix": " de test",
        "pos": 12,
        "note": "ma remarque",
    }
    payload.update(overrides)
    # An override set to None removes the key (characterizes absent fields).
    payload = {k: v for k, v in payload.items() if v is not None}
    return SRV.post("/api/notes", json_body=payload)


def sidecar_path(rel: str):
    """The sidecar lives under <root>/.notes/<rel>.json (NOT under content/)."""
    return SRV.root / ".notes" / (rel + ".json")


class TestNotesCreate(unittest.TestCase):
    def test_create_returns_note_payload(self):
        before = int(time.time())
        resp = create_note("projets/alpha.md")
        self.assertEqual(resp.status, 200)
        note = resp.json()
        # Exact shape of the note object returned by the POST.
        self.assertEqual(
            set(note),
            {"id", "exact", "prefix", "suffix", "pos", "note", "created"},
        )
        # id = uuid4().hex[:12] → 12 lowercase hexadecimal characters.
        self.assertEqual(len(note["id"]), 12)
        int(note["id"], 16)
        self.assertEqual(note["exact"], "Bienvenue dans le mind")
        self.assertEqual(note["prefix"], "# Accueil ")
        self.assertEqual(note["suffix"], " de test")
        self.assertEqual(note["pos"], 12)
        self.assertEqual(note["note"], "ma remarque")
        self.assertGreaterEqual(note["created"], before)
        self.assertLessEqual(note["created"], int(time.time()) + 1)

    def test_create_writes_sidecar_json_under_dot_notes(self):
        rel = "sidecar/cible.md"
        note = create_note(rel).json()
        sidecar = sidecar_path(rel)
        self.assertTrue(sidecar.exists())
        # The sidecar is outside content/ (under <root>/.notes/, mirroring rel).
        self.assertNotIn("content", sidecar.relative_to(SRV.root).parts)
        data = json.loads(sidecar.read_text(encoding="utf-8"))
        self.assertEqual(data, {"version": 1, "notes": [note]})

    def test_create_appends_in_insertion_order(self):
        rel = "sidecar/append.md"
        first = create_note(rel, note="première").json()
        second = create_note(rel, note="seconde").json()
        self.assertNotEqual(first["id"], second["id"])
        listed = SRV.get(f"/api/notes?path={rel}").json()
        self.assertEqual(listed, [first, second])

    def test_create_ignores_doc_existence_and_extension(self):
        # No existence or extension check: you can annotate a phantom doc,
        # and even a non-.md path.
        rel = "fantome/inexistant.txt"
        self.assertFalse(SRV.path(rel).exists())
        resp = create_note(rel)
        self.assertEqual(resp.status, 200)
        self.assertTrue(sidecar_path(rel).exists())

    def test_create_requires_note_and_exact(self):
        for overrides in (
            {"note": None},          # note absent
            {"exact": None},         # exact absent
            {"note": "   "},         # note = spaces → strip() → empty
            {"exact": "\n\t "},      # exact = whitespace → strip() → empty
        ):
            with self.subTest(overrides=overrides):
                resp = create_note("validation/cible.md", **overrides)
                self.assertEqual(resp.status, 400)
                self.assertEqual(resp.json(), {"error": "note and exact required"})

    def test_create_rejects_invalid_paths(self):
        for bad in ("", "/absolu.md", "../evasion.md", "a/../b.md"):
            with self.subTest(path=bad):
                resp = create_note("place-holder.md", path=bad)
                self.assertEqual(resp.status, 400)
                self.assertEqual(resp.json(), {"error": "invalid path"})

    def test_create_truncates_exact_at_2000(self):
        rel = "bornes/exact.md"
        # Strip first, truncate after: leading spaces do not count.
        note = create_note(rel, exact="  " + "x" * 2500).json()
        self.assertEqual(note["exact"], "x" * 2000)
        # Exact boundary: 2000 characters pass through intact.
        note = create_note(rel, exact="y" * 2000).json()
        self.assertEqual(note["exact"], "y" * 2000)

    def test_create_truncates_note_at_5000(self):
        rel = "bornes/note.md"
        note = create_note(rel, note="n" * 6000).json()
        self.assertEqual(note["note"], "n" * 5000)
        # The truncation is also what gets persisted in the sidecar.
        stored = json.loads(sidecar_path(rel).read_text(encoding="utf-8"))
        self.assertEqual(stored["notes"][0]["note"], "n" * 5000)

    def test_create_truncates_prefix_suffix_at_120_without_strip(self):
        rel = "bornes/contexte.md"
        note = create_note(rel, prefix="p" * 200, suffix="  fin  ").json()
        self.assertEqual(note["prefix"], "p" * 120)
        # Unlike exact/note, prefix/suffix are NOT strip()ed:
        # edge whitespace is kept as-is.
        self.assertEqual(note["suffix"], "  fin  ")

    def test_create_pos_falls_back_to_zero(self):
        rel = "bornes/pos.md"
        # pos goes through _safe_int: non-numeric → 0, absent → 0, negative kept.
        self.assertEqual(create_note(rel, pos="abc").json()["pos"], 0)
        self.assertEqual(create_note(rel, pos=None).json()["pos"], 0)
        self.assertEqual(create_note(rel, pos=-7).json()["pos"], -7)

    def test_create_with_query_string_is_404(self):
        # do_POST matches self.path == "/api/notes" EXACTLY: with a query
        # string the request traverses all routes and ends in the generic
        # 404 (without a JSON body).
        resp = SRV.post(
            "/api/notes?path=projets/alpha.md",
            json_body={"path": "projets/alpha.md", "exact": "x", "note": "y"},
        )
        self.assertEqual(resp.status, 404)

    def test_create_non_json_body_is_invalid_path(self):
        # _read_json() swallows invalid bodies into {} → empty path → 400
        # "invalid path" (not a parsing error).
        resp = SRV.post("/api/notes", data=b"pas du json")
        self.assertEqual(resp.status, 400)
        self.assertEqual(resp.json(), {"error": "invalid path"})


class TestNotesList(unittest.TestCase):
    def test_list_empty_without_sidecar(self):
        resp = SRV.get("/api/notes?path=projets/beta.md")
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.json(), [])
        self.assertEqual(
            resp.headers.get("Content-Type"), "application/json; charset=utf-8")

    def test_list_missing_or_invalid_path_400(self):
        for query in ("", "?path=", "?path=/absolu.md", "?path=a/../b.md"):
            with self.subTest(query=query):
                resp = SRV.get(f"/api/notes{query}")
                self.assertEqual(resp.status, 400)
                self.assertEqual(resp.json(), {"error": "invalid path"})

    def test_list_is_scoped_per_doc(self):
        note_a = create_note("scope/doc-a.md", note="sur A").json()
        note_b = create_note("scope/doc-b.md", note="sur B").json()
        self.assertEqual(SRV.get("/api/notes?path=scope/doc-a.md").json(), [note_a])
        self.assertEqual(SRV.get("/api/notes?path=scope/doc-b.md").json(), [note_b])

    def test_list_corrupt_sidecar_is_empty_and_post_overwrites(self):
        rel = "corrompu/doc.md"
        sidecar = sidecar_path(rel)
        sidecar.parent.mkdir(parents=True, exist_ok=True)
        sidecar.write_text("{pas du json", encoding="utf-8")
        # Invalid JSON → load_notes returns [] without error or 500.
        resp = SRV.get(f"/api/notes?path={rel}")
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.json(), [])
        # And a POST starts over from []: the corrupt sidecar is silently
        # overwritten (the unreadable notes are lost).
        note = create_note(rel).json()
        stored = json.loads(sidecar.read_text(encoding="utf-8"))
        self.assertEqual(stored["notes"], [note])

    def test_list_accepts_legacy_bare_list_sidecar(self):
        # load_notes also accepts a sidecar that is a bare JSON array
        # (legacy format without the {"version", "notes"} envelope).
        rel = "legacy/doc.md"
        legacy = [{"id": "abcdef012345", "exact": "x", "note": "ancienne"}]
        sidecar = sidecar_path(rel)
        sidecar.parent.mkdir(parents=True, exist_ok=True)
        sidecar.write_text(json.dumps(legacy), encoding="utf-8")
        self.assertEqual(SRV.get(f"/api/notes?path={rel}").json(), legacy)


class TestNotesEdit(unittest.TestCase):
    def test_patch_updates_text_only(self):
        rel = "edition/doc.md"
        created = create_note(rel, note="avant").json()
        before = int(time.time())
        resp = SRV.patch(
            f"/api/notes?path={rel}&id={created['id']}",
            # exact in the body is ignored: only "note" is read by the PATCH.
            json_body={"note": "  après  ", "exact": "tentative ignorée"},
        )
        self.assertEqual(resp.status, 200)
        updated = resp.json()
        self.assertEqual(updated["note"], "après")  # strip() applied
        self.assertEqual(updated["exact"], created["exact"])
        self.assertEqual(updated["id"], created["id"])
        self.assertEqual(updated["created"], created["created"])
        self.assertGreaterEqual(updated["updated"], before)
        # Persisted: the GET reflects the edit.
        self.assertEqual(SRV.get(f"/api/notes?path={rel}").json(), [updated])

    def test_patch_truncates_note_at_5000(self):
        rel = "edition/borne.md"
        created = create_note(rel).json()
        resp = SRV.patch(
            f"/api/notes?path={rel}&id={created['id']}",
            json_body={"note": "z" * 6000},
        )
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.json()["note"], "z" * 5000)

    def test_patch_validation(self):
        rel = "edition/validation.md"
        created = create_note(rel).json()
        # Missing id or invalid path → same grouped message.
        for path in (f"/api/notes?path={rel}",
                     f"/api/notes?path=../evasion.md&id={created['id']}"):
            with self.subTest(path=path):
                resp = SRV.patch(path, json_body={"note": "x"})
                self.assertEqual(resp.status, 400)
                self.assertEqual(resp.json(), {"error": "path and id required"})
        # Empty note after strip → dedicated 400.
        resp = SRV.patch(f"/api/notes?path={rel}&id={created['id']}",
                         json_body={"note": "   "})
        self.assertEqual(resp.status, 400)
        self.assertEqual(resp.json(), {"error": "empty note"})
        # Unknown id → 404.
        resp = SRV.patch(f"/api/notes?path={rel}&id=000000000000",
                         json_body={"note": "x"})
        self.assertEqual(resp.status, 404)
        self.assertEqual(resp.json(), {"error": "not found"})


class TestNotesDelete(unittest.TestCase):
    def test_delete_removes_one_note_keeps_sidecar(self):
        rel = "suppression/doc.md"
        first = create_note(rel, note="à supprimer").json()
        second = create_note(rel, note="à garder").json()
        resp = SRV.delete(f"/api/notes?path={rel}&id={first['id']}")
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.json(), {"ok": True})
        self.assertEqual(SRV.get(f"/api/notes?path={rel}").json(), [second])
        self.assertTrue(sidecar_path(rel).exists())

    def test_delete_last_note_unlinks_sidecar(self):
        rel = "suppression/dernier.md"
        note = create_note(rel).json()
        self.assertTrue(sidecar_path(rel).exists())
        resp = SRV.delete(f"/api/notes?path={rel}&id={note['id']}")
        self.assertEqual(resp.status, 200)
        # save_notes([]) deletes the file: no empty sidecar left lying around.
        self.assertFalse(sidecar_path(rel).exists())
        self.assertEqual(SRV.get(f"/api/notes?path={rel}").json(), [])

    def test_delete_validation(self):
        rel = "suppression/validation.md"
        created = create_note(rel).json()
        for path in (f"/api/notes?path={rel}",            # missing id
                     f"/api/notes?id={created['id']}"):   # missing path
            with self.subTest(path=path):
                resp = SRV.delete(path)
                self.assertEqual(resp.status, 400)
                self.assertEqual(resp.json(), {"error": "path and id required"})
        resp = SRV.delete(f"/api/notes?path={rel}&id=ffffffffffff")
        self.assertEqual(resp.status, 404)
        self.assertEqual(resp.json(), {"error": "not found"})
        # The original note has not moved.
        self.assertEqual(SRV.get(f"/api/notes?path={rel}").json(), [created])


if __name__ == "__main__":
    unittest.main()
