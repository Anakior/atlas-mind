"""Tests of cloud mode with the file store (ATLAS_STORE=file).

Server in KB_AUTH_ENABLED=1 + ATLAS_STORE=file: auth (login cookie, roles,
Bearer, share-links) works with users/shares living in JSON files
under <ROOT>/.atlas/. The git clone at boot is bypassed via KB_REPO_PATH={root}
(ensure_repo_cloned returns early because <root>/.git exists — harness git_init=True).

Behaviors characterized here (current contract, not necessarily ideal):
- A failed login (wrong password OR unknown email) returns the SAME 401
  "Invalid credentials" (anti-enumeration, dummy scrypt hash consumed).
- An account with role 'api' CANNOT log in via password, even a correct one.
- /api/share/list with a FileStore returns "token": null: the cleartext token
  is never stored (only its SHA256), the key stays present to preserve the
  historical response shape.
- A share token forged with the correct SESSION_SECRET but NEVER recorded in
  the registry is SERVED (fail-open: only a record marked revoked blocks; the
  absence of a record does not block).
- The DELETE /api/share/<id> route accepts uuid4 ids (36 chars) AND legacy
  24-hex ids (the FileStore matches by equality, with no imposed format).
- last_used_at of Bearer tokens goes into .atlas/state.json (volatile), never
  into users.json (durable).
"""
import base64
import hashlib
import hmac
import json
import secrets
import sys
import tempfile
import time
import unittest
from pathlib import Path

from harness import AtlasServer

# The src/store.py module is imported directly to seed the test mind's users
# (same code as the one copied into the server's tmpdir).
REPO_SRC = Path(__file__).resolve().parent.parent / "src"
if str(REPO_SRC) not in sys.path:
    sys.path.insert(0, str(REPO_SRC))

import store  # noqa: E402

SESSION_SECRET = "atlas-test-cloud-secret-0123456789abcdef"

ADMIN_EMAIL = "admin@test.local"
ADMIN_PASSWORD = "correct-horse-battery"
VIEWER_EMAIL = "viewer@test.local"
VIEWER_PASSWORD = "viewer-password-42"
API_EMAIL = "claude@api.local"
API_PASSWORD = "api-password-never-usable"


def cloud_env() -> dict:
    return {
        "KB_AUTH_ENABLED": "1",
        "SESSION_SECRET": SESSION_SECRET,
        "KB_REPO_PATH": "{root}",   # bypasses the git clone at boot
        "ATLAS_STORE": "file",
        "GIT_PULL_INTERVAL": "3600",  # no periodic pull during the tests
    }


def file_store_of(srv: AtlasServer) -> store.FileStore:
    """Test FileStore pointed at the server's .atlas/: external writes are seen
    by the server on the next request (mtime re-read)."""
    return store.FileStore(srv.root / ".atlas")


def seed_default_users(fs: store.FileStore) -> None:
    fs.upsert_user(ADMIN_EMAIL, {
        "password_hash": store.hash_password(ADMIN_PASSWORD),
        "role": "admin",
    })
    fs.upsert_user(VIEWER_EMAIL, {
        "password_hash": store.hash_password(VIEWER_PASSWORD),
        "role": "viewer",
    })


def login(srv: AtlasServer, email: str, password: str):
    return srv.post("/login", json_body={"email": email, "password": password})


def session_cookie(srv: AtlasServer, email: str, password: str) -> str:
    """Log in and return a VALID Cookie header ("kb_session=<token>").

    The 0x2e cookie bug is fixed (batch 2d): make_token encodes payload and
    signature SEPARATELY in base64url (alphabet without '.'), so no cookie is
    self-invalid anymore. The retry/sleep of the old helpers is no longer
    needed — a single login is enough."""
    resp = login(srv, email, password)
    assert resp.status == 303, f"login {email} expected 303, got {resp.status}"
    set_cookie = resp.headers.get("Set-Cookie") or ""
    assert set_cookie.startswith("kb_session="), set_cookie
    cookie = set_cookie.split(";", 1)[0]
    me = srv.get("/api/me", headers={"Cookie": cookie}).json()
    assert me.get("authenticated"), f"invalid session cookie for {email}"
    return cookie


def csrf_of(srv: AtlasServer, cookie: str) -> str:
    """Session synchronizer CSRF token (read from /api/me, set by the backend).
    Every authenticated mutating request must carry it as X-CSRF-Token (batch
    2d: the CSRF guard now applies ALSO to content routes —
    file/notes/todos/share/move/rename — not just admin routes)."""
    return srv.get("/api/me", headers={"Cookie": cookie}).json()["csrf_token"]


def auth_headers(srv: AtlasServer, cookie: str) -> dict:
    """Cookie + X-CSRF-Token: the minimum for a mutating request in cloud mode.

    Requests without a JSON body (DELETE) also receive Content-Type
    application/json, required by the first line of the CSRF guard (a cross-site
    <form> cannot emit this type without a CORS preflight)."""
    return {
        "Cookie": cookie,
        "X-CSRF-Token": csrf_of(srv, cookie),
        "Content-Type": "application/json",
    }


def mint_session_token(email: str, role: str, ts: int, epoch: int = 0):
    """Exact replica of server.py's make_token() AFTER the 0x2e fix (batch 2d):
    base64url(payload) + '.' + base64url(sig), padding stripped. Returns
    (token, raw_signature)."""
    payload = json.dumps(
        {"email": email, "role": role, "ep": epoch, "ts": ts}).encode()
    sig = hmac.new(SESSION_SECRET.encode(), payload, hashlib.sha256).digest()
    token = (base64.urlsafe_b64encode(payload).decode().rstrip("=")
             + "." + base64.urlsafe_b64encode(sig).decode().rstrip("="))
    return token, sig


def forge_share_token(path: str, expires_at: int, secret: bytes) -> str:
    """Exact replica of server.py's make_share_token()."""
    payload = json.dumps({"p": path, "e": expires_at}).encode()
    sig = hmac.new(secret, payload, hashlib.sha256).digest()
    return (base64.urlsafe_b64encode(payload).decode().rstrip("=")
            + "."
            + base64.urlsafe_b64encode(sig).decode().rstrip("="))


class TestPasswordHelpers(unittest.TestCase):
    """Hash helpers of src/store.py, without a server."""

    def test_hash_password_scrypt_format(self):
        hashed = store.hash_password("mypass")
        parts = hashed.split("$")
        self.assertEqual(len(parts), 6)
        self.assertEqual(parts[0], "scrypt")
        self.assertEqual(parts[1], str(2 ** 14))
        self.assertEqual(parts[2], "8")
        self.assertEqual(parts[3], "1")
        base64.b64decode(parts[4])  # salt decodable
        base64.b64decode(parts[5])  # digest decodable

    def test_verify_password_roundtrip(self):
        hashed = store.hash_password("été-à-Paris")
        self.assertTrue(store.verify_password("été-à-Paris", hashed))
        self.assertFalse(store.verify_password("ete-a-Paris", hashed))

    def test_hash_password_salted(self):
        # Two hashes of the same password differ (random salt).
        self.assertNotEqual(store.hash_password("x"), store.hash_password("x"))

    def test_verify_password_accepts_bytes_hash(self):
        hashed = store.hash_password("secret").encode("utf-8")
        self.assertTrue(store.verify_password("secret", hashed))

    def test_verify_password_rejects_garbage_and_empty(self):
        self.assertFalse(store.verify_password("x", ""))
        self.assertFalse(store.verify_password("x", None))
        self.assertFalse(store.verify_password("x", "md5$deadbeef"))
        self.assertFalse(store.verify_password("x", "scrypt$pas$des$nombres$a$b"))

    def test_bcrypt_fallback_roundtrip_or_fail_closed(self):
        # Legacy "$2…" hash: verified via bcrypt if importable, rejected (False,
        # without raising) if bcrypt is absent — never an exception.
        try:
            import bcrypt
        except ImportError:
            self.assertFalse(store.verify_password("legacy", "$2b$12$" + "x" * 53))
            return
        hashed = bcrypt.hashpw(b"legacy", bcrypt.gensalt(rounds=4)).decode()
        self.assertTrue(store.verify_password("legacy", hashed))
        self.assertFalse(store.verify_password("other", hashed))

    def test_dummy_verify_never_raises(self):
        self.assertIsNone(store.dummy_verify("whatever"))

    def test_filestore_dummy_verify_never_raises(self):
        # FileStore dummy: scrypt (native scheme) + bcrypt if importable
        # (legacy "$2…" hashes possible). Without bcrypt, scrypt alone, no raise.
        with tempfile.TemporaryDirectory() as tmp:
            fs = store.FileStore(tmp)
            self.assertIsNone(fs.dummy_verify("whatever"))


class TestCloudFileStoreAuth(unittest.TestCase):
    """Cookie login + roles in cloud mode, 100% file-based registry."""

    srv: AtlasServer

    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(extra_env=cloud_env())
        cls.srv.start()
        cls.fs = file_store_of(cls.srv)
        seed_default_users(cls.fs)
        # Account with role 'api' WITH a real hash: proves the login refusal
        # comes from the role, not from an unusable hash.
        cls.fs.upsert_user(API_EMAIL, {
            "password_hash": store.hash_password(API_PASSWORD),
            "role": "api",
        })
        cls.admin_cookie = session_cookie(cls.srv, ADMIN_EMAIL, ADMIN_PASSWORD)
        cls.viewer_cookie = session_cookie(cls.srv, VIEWER_EMAIL, VIEWER_PASSWORD)

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    # ── pages & access without cookie ────────────────────────────────────────

    def test_login_page_is_public_200(self):
        resp = self.srv.get("/login")
        self.assertEqual(resp.status, 200)
        self.assertIn("text/html", resp.headers.get("Content-Type", ""))
        self.assertIn('action="/login"', resp.text)
        self.assertIn("Sign in", resp.text)

    def test_root_redirects_to_login_without_cookie(self):
        resp = self.srv.get("/")
        self.assertEqual(resp.status, 303)
        self.assertEqual(resp.headers.get("Location"), "/login")

    def test_static_doc_redirects_without_cookie(self):
        resp = self.srv.get("/accueil.md")
        self.assertEqual(resp.status, 303)
        self.assertEqual(resp.headers.get("Location"), "/login")

    def test_api_tree_401_without_cookie(self):
        resp = self.srv.get("/api/tree")
        self.assertEqual(resp.status, 401)
        self.assertEqual(resp.json(), {"error": "unauthorized"})

    # ── login ────────────────────────────────────────────────────────────────

    def test_login_wrong_password_401(self):
        resp = login(self.srv, ADMIN_EMAIL, "wrong-password")
        self.assertEqual(resp.status, 401)
        self.assertIn("Invalid credentials", resp.text)
        self.assertIsNone(resp.headers.get("Set-Cookie"))

    def test_login_unknown_email_same_401_as_wrong_password(self):
        # Anti-enumeration: unknown email (dummy scrypt path) → exactly the same
        # 401 as the wrong password.
        resp = login(self.srv, "nobody@test.local", "x" * 12)
        self.assertEqual(resp.status, 401)
        self.assertIn("Invalid credentials", resp.text)

    def test_login_success_sets_session_cookie(self):
        resp = login(self.srv, ADMIN_EMAIL, ADMIN_PASSWORD)
        self.assertEqual(resp.status, 303)
        self.assertEqual(resp.headers.get("Location"), "/")
        set_cookie = resp.headers.get("Set-Cookie") or ""
        self.assertTrue(set_cookie.startswith("kb_session="))
        self.assertIn("HttpOnly", set_cookie)
        self.assertIn("SameSite=Lax", set_cookie)
        self.assertIn("Secure", set_cookie)  # set in cloud mode (AUTH_ENABLED)

    def test_api_role_cannot_login_even_with_correct_password(self):
        resp = login(self.srv, API_EMAIL, API_PASSWORD)
        self.assertEqual(resp.status, 401)
        self.assertIn("Invalid credentials", resp.text)

    def test_login_with_legacy_bcrypt_hash(self):
        try:
            import bcrypt
        except ImportError:
            self.skipTest("bcrypt not installed: legacy fallback not testable here")
        hashed = bcrypt.hashpw(b"legacy-password", bcrypt.gensalt(rounds=4)).decode()
        self.fs.upsert_user("legacy@test.local", {
            "password_hash": hashed, "role": "admin"})
        resp = login(self.srv, "legacy@test.local", "legacy-password")
        self.assertEqual(resp.status, 303)
        self.assertTrue((resp.headers.get("Set-Cookie") or "").startswith("kb_session="))

    def test_cookie_with_dot_in_raw_sig_now_accepted(self):
        # FIX of the 0x2e bug (batch 2d): before, make_token concatenated
        # payload + b"." + raw_sig BEFORE the base64, and verify_token re-split
        # via rsplit — a 0x2e ('.') byte in the signature broke the split
        # (~12% of cookies self-invalid). Now payload and signature are encoded
        # SEPARATELY in base64url (never a '.'), so a cookie whose raw signature
        # contains a 0x2e MUST now be accepted.
        now = int(time.time())
        with_dot = None
        for ts in range(now, now + 5000):
            token, sig = mint_session_token(ADMIN_EMAIL, "admin", ts)
            if b"." in sig:
                with_dot = token
                break
        self.assertIsNotNone(with_dot, "no ts with a signature containing 0x2e")
        accepted = self.srv.get(
            "/api/me", headers={"Cookie": f"kb_session={with_dot}"}).json()
        self.assertTrue(accepted["authenticated"],
                        "the 0x2e fix must accept this cookie")

    def test_no_cookie_self_invalidates_over_many_timestamps(self):
        # Anti-regression guard: over 200 varied ts of which >=20 have a
        # signature containing a 0x2e (the case that broke the old rsplit), NO
        # cookie forged with the correct secret must be rejected. 200
        # round-trips stays fast; we also check the sample covers the 0x2e case.
        now = int(time.time())
        rejected = 0
        with_dot = 0
        for ts in range(now, now + 200):
            token, sig = mint_session_token(ADMIN_EMAIL, "admin", ts)
            if b"." in sig:
                with_dot += 1
            me = self.srv.get(
                "/api/me", headers={"Cookie": f"kb_session={token}"}).json()
            if not me.get("authenticated"):
                rejected += 1
        self.assertEqual(rejected, 0, f"{rejected} self-invalid cookies")
        self.assertGreaterEqual(with_dot, 5,
                                "sample does not cover the 0x2e case enough")

    # ── roles ────────────────────────────────────────────────────────────────

    def test_api_me_reflects_cloud_and_role(self):
        anonymous = self.srv.get("/api/me").json()
        self.assertEqual(anonymous, {"authenticated": False, "cloud": True})
        as_viewer = self.srv.get(
            "/api/me", headers={"Cookie": self.viewer_cookie}).json()
        self.assertEqual(as_viewer["role"], "viewer")
        self.assertEqual(as_viewer["email"], VIEWER_EMAIL)

    def test_admin_can_read_and_write(self):
        headers = {"Cookie": self.admin_cookie}
        self.assertEqual(self.srv.get("/", headers=headers).status, 200)
        self.assertEqual(self.srv.get("/api/tree", headers=headers).status, 200)
        resp = self.srv.put(
            "/api/file",
            json_body={"path": "inbox/cloud-admin.md", "content": "# Cloud\n"},
            headers=auth_headers(self.srv, self.admin_cookie))
        self.assertEqual(resp.status, 200)
        self.assertTrue(resp.json()["ok"])
        self.assertEqual(
            self.srv.path("inbox/cloud-admin.md").read_text(encoding="utf-8"),
            "# Cloud\n")

    def test_viewer_can_read_but_not_write(self):
        headers = {"Cookie": self.viewer_cookie}
        self.assertEqual(self.srv.get("/api/tree", headers=headers).status, 200)
        self.assertEqual(self.srv.get("/accueil.md", headers=headers).status, 200)

        put = self.srv.put(
            "/api/file",
            json_body={"path": "inbox/cloud-viewer.md", "content": "# Nope\n"},
            headers=headers)
        self.assertEqual(put.status, 403)
        self.assertEqual(put.json(), {"error": "forbidden"})
        self.assertFalse(self.srv.path("inbox/cloud-viewer.md").exists())

        todo = self.srv.post(
            "/api/todos", json_body={"text": "forbidden"}, headers=headers)
        self.assertEqual(todo.status, 403)

        delete = self.srv.delete(
            "/api/file", json_body={"path": "accueil.md"}, headers=headers)
        self.assertEqual(delete.status, 403)
        self.assertTrue(self.srv.path("accueil.md").exists())


class TestCloudFileStoreShares(unittest.TestCase):
    """Share links: shares.json registry (tokens stored as SHA256)."""

    srv: AtlasServer

    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(extra_env=cloud_env())
        cls.srv.start()
        cls.fs = file_store_of(cls.srv)
        seed_default_users(cls.fs)
        cls.admin_cookie = session_cookie(cls.srv, ADMIN_EMAIL, ADMIN_PASSWORD)
        cls.viewer_cookie = session_cookie(cls.srv, VIEWER_EMAIL, VIEWER_PASSWORD)

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def _create_share(self, path: str, expires_days: int = 0) -> dict:
        resp = self.srv.post(
            "/api/share",
            json_body={"path": path, "expires_days": expires_days},
            headers=auth_headers(self.srv, self.admin_cookie))
        self.assertEqual(resp.status, 200)
        return resp.json()

    def _shares_on_disk(self) -> list:
        return json.loads(
            (self.srv.root / ".atlas" / "shares.json").read_text(encoding="utf-8"))

    def test_share_lifecycle_create_list_revoke(self):
        created = self._create_share("accueil.md")
        share_id, token = created["id"], created["token"]
        # uuid4 id (36 characters, 4 dashes) — not a legacy 24-hex id.
        self.assertEqual(len(share_id), 36)
        self.assertEqual(share_id.count("-"), 4)
        self.assertEqual(created["path"], "accueil.md")

        # On disk: SHA256 of the token only, never the cleartext token.
        record = next(s for s in self._shares_on_disk() if s["id"] == share_id)
        self.assertEqual(
            record["token_sha256"],
            hashlib.sha256(token.encode()).hexdigest())
        self.assertNotIn("token", record)
        self.assertEqual(record["created_by"], ADMIN_EMAIL)

        # Public link served without a cookie.
        public = self.srv.get(f"/share/{token}")
        self.assertEqual(public.status, 200)
        self.assertIn("Bienvenue dans le mind de test.", public.text)

        # Admin listing: the token is NOT stored in cleartext, but since it is a
        # deterministic HMAC of (path, expires_at, SESSION_SECRET) the server
        # REGENERATES it on the fly → the list exposes a valid, copyable public
        # link (no longer None, which produced "/share/null" URLs).
        listing = self.srv.get(
            "/api/share/list", headers={"Cookie": self.admin_cookie}).json()
        entry = next(d for d in listing if d["id"] == share_id)
        self.assertEqual(entry["token"], token)  # regenerated, identical to creation
        self.assertEqual(entry["path"], "accueil.md")
        self.assertFalse(entry["revoked"])
        # The regenerated link actually works.
        relink = self.srv.get(f"/share/{entry['token']}")
        self.assertEqual(relink.status, 200)
        self.assertIn("Bienvenue dans le mind de test.", relink.text)

        # Revocation → link 410, then re-revocation → 404.
        revoke = self.srv.delete(
            f"/api/share/{share_id}",
            headers=auth_headers(self.srv, self.admin_cookie))
        self.assertEqual(revoke.status, 200)
        self.assertEqual(revoke.json(), {"ok": True})

        gone = self.srv.get(f"/share/{token}")
        self.assertEqual(gone.status, 410)
        self.assertIn("revoked", gone.text)  # EN: "Link revoked"

        again = self.srv.delete(
            f"/api/share/{share_id}",
            headers=auth_headers(self.srv, self.admin_cookie))
        self.assertEqual(again.status, 404)
        self.assertEqual(again.json(), {"error": "not found or already revoked"})

    def test_share_list_path_filter_and_include_revoked(self):
        created = self._create_share("projets/alpha.md")
        headers = {"Cookie": self.admin_cookie}

        filtered = self.srv.get(
            "/api/share/list?path=projets/alpha.md", headers=headers).json()
        self.assertTrue(all(d["path"] == "projets/alpha.md" for d in filtered))
        self.assertIn(created["id"], [d["id"] for d in filtered])

        self.srv.delete(f"/api/share/{created['id']}",
                        headers=auth_headers(self.srv, self.admin_cookie))
        default_list = self.srv.get(
            "/api/share/list?path=projets/alpha.md", headers=headers).json()
        self.assertNotIn(created["id"], [d["id"] for d in default_list])

        with_revoked = self.srv.get(
            "/api/share/list?path=projets/alpha.md&include_revoked=1",
            headers=headers).json()
        entry = next(d for d in with_revoked if d["id"] == created["id"])
        self.assertTrue(entry["revoked"])
        self.assertIsInstance(entry["revoked_at"], int)

    def test_viewer_cannot_create_share_nor_list(self):
        headers = {"Cookie": self.viewer_cookie}
        create = self.srv.post(
            "/api/share", json_body={"path": "accueil.md"}, headers=headers)
        self.assertEqual(create.status, 403)
        listing = self.srv.get("/api/share/list", headers=headers)
        self.assertEqual(listing.status, 403)

    def test_forged_expired_token_410(self):
        # Expiration is checked BEFORE the registry (within the signature itself).
        forged = forge_share_token("accueil.md", int(time.time()) - 60,
                                   SESSION_SECRET.encode())
        resp = self.srv.get(f"/share/{forged}")
        self.assertEqual(resp.status, 410)
        self.assertIn("expir", resp.text)  # "Lien expir&eacute;" (expired)

    def test_forged_unregistered_token_is_served_fail_open(self):
        # Characterization: a validly signed token that is ABSENT from the
        # registry is served (only a revoked record blocks) — fail-open.
        forged = forge_share_token("projets/beta.md", 0, SESSION_SECRET.encode())
        resp = self.srv.get(f"/share/{forged}")
        self.assertEqual(resp.status, 200)
        self.assertIn("Aucun lien sortant ici.", resp.text)

    def test_revoke_unknown_uuid_404(self):
        resp = self.srv.delete(
            "/api/share/00000000-0000-4000-8000-000000000000",
            headers=auth_headers(self.srv, self.admin_cookie))
        self.assertEqual(resp.status, 404)

    def test_revoke_bodyless_delete_without_content_type(self):
        # Regression (prod bug): the browser sends the revocation DELETE WITHOUT
        # a body, thus WITHOUT a Content-Type. The CSRF guard must not require
        # application/json on a bodyless request — otherwise 415 and revocation
        # impossible from the UI. The X-CSRF-Token stays the real defense.
        # DEDICATED doc + path: unique token (HMAC path+exp), zero collision
        # with the shared state of the other share tests in this class.
        self.srv.put(
            "/api/file",
            json_body={"path": "share-revoke-ct.md", "content": "# x\n"},
            headers=auth_headers(self.srv, self.admin_cookie))
        created = self._create_share("share-revoke-ct.md")
        headers = {  # NO Content-Type, like a browser fetch without a body
            "Cookie": self.admin_cookie,
            "X-CSRF-Token": csrf_of(self.srv, self.admin_cookie),
        }
        resp = self.srv.delete(f"/api/share/{created['id']}", headers=headers)
        self.assertEqual(
            resp.status, 200,
            f"DELETE with no body or Content-Type must succeed, got {resp.status}")

    def test_revoke_25_hex_id_falls_through_to_todos_bare_404(self):
        # The share route only matches EXACT 24-hex (legacy id) or uuid4
        # 8-4-4-4-12. A 25-hex id falls into the todos route → bare 404, empty
        # body (not the JSON 404 {"error": "not found or already revoked"}).
        resp = self.srv.delete(
            "/api/share/" + "a" * 25,
            headers=auth_headers(self.srv, self.admin_cookie))
        self.assertEqual(resp.status, 404)
        self.assertEqual(resp.body, b"")

    def test_registry_never_enters_git(self):
        # The .atlas/ registry (password hashes, api_token_hash, SHA256 of
        # share-tokens, volatile state.json) must NEVER be staged by the
        # `git add -A` of trigger_sync/pull_and_rebuild — otherwise it ends up
        # in the git history pushed to GitHub. Two server-side mechanisms:
        # .atlas/.gitignore = "*" (written by FileStore) and /.atlas/ added to
        # .git/info/exclude (written by get_store()).
        # NON-zero expires_days: tokens are deterministic (HMAC of the
        # path+expiration pair, with no nonce) — a share accueil.md/exp=0 here
        # would have exactly the same token as the one in the lifecycle test,
        # and its non-revoked record would mask the other's revocation
        # (find_share_by_token returns the first match).
        self._create_share("accueil.md", expires_days=30)
        atlas_dir = self.srv.root / ".atlas"
        self.assertTrue((atlas_dir / "shares.json").exists())
        self.assertEqual(
            (atlas_dir / ".gitignore").read_text(encoding="utf-8"), "*\n")
        exclude_path = self.srv.root / ".git" / "info" / "exclude"
        self.assertIn("/.atlas/",
                      exclude_path.read_text(encoding="utf-8").splitlines())

        self.srv.git("add", "-A", check=True)
        staged = self.srv.git("diff", "--cached", "--name-only").stdout
        self.assertNotIn(".atlas", staged)
        self.assertNotIn(".atlas", self.srv.git("ls-files").stdout)

    def test_revoke_migrated_24hex_id_accepted(self):
        # Simulates a legacy record: a 24-hex id injected directly into
        # shares.json. The route AND the store accept it.
        token = forge_share_token("projets/beta.md", 0, SESSION_SECRET.encode())
        migrated_id = "5f2b8c9d1e3a4b5c6d7e8f90"
        shares = self._shares_on_disk() if (
            self.srv.root / ".atlas" / "shares.json").exists() else []
        shares.append({
            "id": migrated_id,
            "path": "projets/beta.md",
            "token_sha256": hashlib.sha256(token.encode()).hexdigest(),
            "expires_at": 0,
            "created_at": int(time.time()),
            "created_by": ADMIN_EMAIL,
            "revoked": False,
        })
        (self.srv.root / ".atlas" / "shares.json").write_text(
            json.dumps(shares), encoding="utf-8")

        self.assertEqual(self.srv.get(f"/share/{token}").status, 200)
        revoke = self.srv.delete(
            f"/api/share/{migrated_id}",
            headers=auth_headers(self.srv, self.admin_cookie))
        self.assertEqual(revoke.status, 200)
        self.assertEqual(self.srv.get(f"/share/{token}").status, 410)


class TestCloudFileStoreBearer(unittest.TestCase):
    """API v1 + MCP: Bearer token verified via the FileStore (SHA256)."""

    srv: AtlasServer
    api_token: str

    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(extra_env=cloud_env())
        cls.srv.start()
        cls.fs = file_store_of(cls.srv)
        cls.api_token = secrets.token_hex(32)
        cls.fs.upsert_user(API_EMAIL, {
            "role": "api",
            "api_token_hash": hashlib.sha256(cls.api_token.encode()).hexdigest(),
            # Unusable sentinel, like create_api_token.py.
            "password_hash": "$2b$12$" + "x" * 53,
        })

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def _bearer(self) -> dict:
        return {"Authorization": f"Bearer {self.api_token}"}

    def test_bearer_search_200(self):
        resp = self.srv.get("/api/v1/search?q=alpha", headers=self._bearer())
        self.assertEqual(resp.status, 200)
        hits = resp.json()
        self.assertIn("projets/alpha.md", [h["path"] for h in hits])

    def test_bearer_missing_or_wrong_401(self):
        missing = self.srv.get("/api/v1/search?q=alpha")
        self.assertEqual(missing.status, 401)
        self.assertEqual(missing.json(), {"error": "invalid or missing bearer token"})

        wrong = self.srv.get("/api/v1/search?q=alpha",
                             headers={"Authorization": "Bearer " + "0" * 64})
        self.assertEqual(wrong.status, 401)
        self.assertEqual(wrong.json(), {"error": "invalid or missing bearer token"})

    def test_bearer_create_doc_201(self):
        resp = self.srv.post(
            "/api/v1/file",
            json_body={"path": "inbox/from-bearer.md", "content": "# Bearer\n"},
            headers=self._bearer())
        self.assertEqual(resp.status, 201)
        self.assertTrue(self.srv.path("inbox/from-bearer.md").exists())

    def test_last_used_in_state_json_not_users_json(self):
        self.assertEqual(
            self.srv.get("/api/v1/tree", headers=self._bearer()).status, 200)
        token_hash = hashlib.sha256(self.api_token.encode()).hexdigest()
        state = json.loads(
            (self.srv.root / ".atlas" / "state.json").read_text(encoding="utf-8"))
        self.assertIsInstance(state.get(token_hash), int)
        # users.json (durable) does not churn: no last_used in it.
        users_text = (self.srv.root / ".atlas" / "users.json").read_text(
            encoding="utf-8")
        self.assertNotIn("last_used", users_text)

    def test_mcp_initialize_via_store_token(self):
        resp = self.srv.post(
            f"/mcp/{self.api_token}",
            json_body={"jsonrpc": "2.0", "id": 1, "method": "initialize"})
        self.assertEqual(resp.status, 200)
        # Phase 2a (de-personalization): the MCP serverInfo name is the slug of
        # the configured site_name — neutral ("atlas") without atlas.toml.
        self.assertEqual(resp.json()["result"]["serverInfo"]["name"],
                         "atlas-mind")

        bad = self.srv.post(
            "/mcp/" + "0" * 64,
            json_body={"jsonrpc": "2.0", "id": 1, "method": "initialize"})
        self.assertEqual(bad.status, 401)
        self.assertEqual(bad.json(), {"error": "invalid mcp token"})


class TestCloudFileStoreCorruptRegistry(unittest.TestCase):
    """Corrupt registry → fail-CLOSED on an unreadable registry (exception →
    503/401), never treated as an empty registry.
    Without this, corrupting shares.json re-served a REVOKED link (fail-open
    revocation) and corrupting users.json turned every login into a 401
    "Invalid credentials" (silent lockout) instead of a clean 503."""

    srv: AtlasServer
    api_token: str

    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(extra_env=cloud_env())
        cls.srv.start()
        cls.fs = file_store_of(cls.srv)
        seed_default_users(cls.fs)
        cls.api_token = secrets.token_hex(32)
        cls.fs.upsert_user(API_EMAIL, {
            "role": "api",
            "api_token_hash": hashlib.sha256(cls.api_token.encode()).hexdigest(),
            "password_hash": "$2b$12$" + "x" * 53,
        })
        cls.admin_cookie = session_cookie(cls.srv, ADMIN_EMAIL, ADMIN_PASSWORD)

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def _registry_path(self, name: str) -> Path:
        return self.srv.root / ".atlas" / name

    def _corrupt(self, name: str, garbage: str = "{ not json") -> str:
        path = self._registry_path(name)
        original = path.read_text(encoding="utf-8")
        path.write_text(garbage, encoding="utf-8")
        return original

    def test_corrupt_shares_json_revoked_link_stays_blocked_503(self):
        created = self.srv.post(
            "/api/share",
            json_body={"path": "accueil.md", "expires_days": 0},
            headers=auth_headers(self.srv, self.admin_cookie)).json()
        token = created["token"]
        revoke = self.srv.delete(
            f"/api/share/{created['id']}",
            headers=auth_headers(self.srv, self.admin_cookie))
        self.assertEqual(revoke.status, 200)
        self.assertEqual(self.srv.get(f"/share/{token}").status, 410)

        original = self._corrupt("shares.json")
        try:
            resp = self.srv.get(f"/share/{token}")
            self.assertEqual(resp.status, 503)
            self.assertIn("unavailable", resp.text)
        finally:
            self._registry_path("shares.json").write_text(
                original, encoding="utf-8")
        # Registry restored: the revoked link returns 410 again.
        self.assertEqual(self.srv.get(f"/share/{token}").status, 410)

    def test_corrupt_users_json_login_503_not_401(self):
        original = self._corrupt("users.json")
        try:
            resp = login(self.srv, ADMIN_EMAIL, ADMIN_PASSWORD)
            self.assertEqual(resp.status, 503)
            self.assertIn("unavailable", resp.text)
            # Unexpected root type (dict instead of list): same fail-closed.
            self._registry_path("users.json").write_text("{}", encoding="utf-8")
            resp = login(self.srv, ADMIN_EMAIL, ADMIN_PASSWORD)
            self.assertEqual(resp.status, 503)
        finally:
            self._registry_path("users.json").write_text(
                original, encoding="utf-8")

    def test_corrupt_users_json_bearer_401(self):
        bearer = {"Authorization": f"Bearer {self.api_token}"}
        self.assertEqual(self.srv.get("/api/v1/tree", headers=bearer).status, 200)
        original = self._corrupt("users.json")
        try:
            resp = self.srv.get("/api/v1/tree", headers=bearer)
            self.assertEqual(resp.status, 401)
            self.assertEqual(resp.json(),
                             {"error": "invalid or missing bearer token"})
        finally:
            self._registry_path("users.json").write_text(
                original, encoding="utf-8")
        self.assertEqual(self.srv.get("/api/v1/tree", headers=bearer).status, 200)


class TestAtlasStoreDirOverride(unittest.TestCase):
    """ATLAS_STORE_DIR moves the registry out of ROOT/.atlas (e.g. a persistent
    Fly volume, outside the content git repo): the server reads users/shares at
    that location and never creates ROOT/.atlas."""

    def test_login_uses_custom_registry_location(self):
        env = cloud_env()
        env["ATLAS_STORE_DIR"] = "{root}/registry"
        with AtlasServer(extra_env=env) as srv:
            fs = store.FileStore(srv.root / "registry")
            fs.upsert_user(ADMIN_EMAIL, {
                "password_hash": store.hash_password(ADMIN_PASSWORD),
                "role": "admin",
            })
            resp = login(srv, ADMIN_EMAIL, ADMIN_PASSWORD)
            self.assertEqual(resp.status, 303)
            self.assertFalse((srv.root / ".atlas").exists())
            # The custom directory is INSIDE the test repo: it too is excluded
            # from git (info/exclude) by get_store().
            exclude = (srv.root / ".git" / "info" / "exclude").read_text(
                encoding="utf-8")
            self.assertIn("/registry/", exclude.splitlines())


if __name__ == "__main__":
    unittest.main()
