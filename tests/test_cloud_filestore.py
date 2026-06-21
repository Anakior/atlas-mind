"""Tests of cloud mode with the file store (ATLAS_STORE=file).

Server in KB_AUTH_ENABLED=1 + ATLAS_STORE=file: auth (login cookie, roles,
Bearer, share-links) works with users/shares living in JSON files
under <ROOT>/.atlas/. The git clone at boot is bypassed via KB_REPO_PATH={root}
(ensure_repo_cloned returns early because <root>/.git exists — harness git_init=True).

Behaviors characterized here (current contract, not necessarily ideal):
- A failed login (wrong password OR unknown email) returns the SAME 401
  "Invalid credentials" (anti-enumeration, dummy scrypt hash consumed).
- An account with role 'api' CANNOT log in via password, even a correct one.
- /api/share/list returns the cleartext token: a share link is a capability URL
  (kept in cleartext so the admin can re-copy it), not an auth secret.
- A token absent from the registry resolves to nothing → 404 (fail-CLOSED: the
  registry is the single source of truth for a share's target and validity).
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
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from harness import AtlasServer, TODO_REL

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


class TestAccountNames(unittest.TestCase):
    """Optional first_name/last_name on accounts (CDC brick): two DISTINCT fields,
    schemaless on the FileStore, surfaced through upsert/get, display_name,
    accept_invite and list_admin_facing_users. A name-less account is unchanged."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.fs = store.FileStore(self.tmp.name)

    def test_upsert_stores_both_halves_distinctly(self):
        self.fs.upsert_user("named@x.fr", {
            "password_hash": "x", "role": "viewer",
            "first_name": "Ada", "last_name": "Lovelace"})
        user = self.fs.get_user_by_email("named@x.fr")
        # Two separate keys — never a single merged "name".
        self.assertEqual(user["first_name"], "Ada")
        self.assertEqual(user["last_name"], "Lovelace")
        self.assertNotIn("name", user)

    def test_first_and_last_are_independent(self):
        # Only a first name: the last stays absent (no implicit merge/split).
        self.fs.upsert_user("first@x.fr", {
            "role": "viewer", "first_name": "Grace"})
        only_first = self.fs.get_user_by_email("first@x.fr")
        self.assertEqual(only_first["first_name"], "Grace")
        self.assertNotIn("last_name", only_first)
        # Only a last name.
        self.fs.upsert_user("last@x.fr", {"role": "viewer", "last_name": "Hopper"})
        only_last = self.fs.get_user_by_email("last@x.fr")
        self.assertEqual(only_last["last_name"], "Hopper")
        self.assertNotIn("first_name", only_last)

    def test_display_name_is_first_then_last(self):
        self.assertEqual(
            store.display_name({"first_name": "Ada", "last_name": "Lovelace",
                                "email": "a@x.fr"}),
            "Ada Lovelace")

    def test_display_name_collapses_a_missing_half(self):
        self.assertEqual(
            store.display_name({"first_name": "Ada", "email": "a@x.fr"}), "Ada")
        self.assertEqual(
            store.display_name({"last_name": "Lovelace", "email": "a@x.fr"}),
            "Lovelace")

    def test_display_name_falls_back_to_email_when_both_absent(self):
        self.assertEqual(store.display_name({"email": "anon@x.fr"}), "anon@x.fr")
        # Empty strings count as absent → still the email.
        self.assertEqual(
            store.display_name({"first_name": "", "last_name": "",
                                "email": "anon@x.fr"}),
            "anon@x.fr")

    def test_nameless_account_behaves_identically(self):
        # An account created without names exposes "" for both halves and is
        # otherwise indistinguishable from a legacy record.
        self.fs.upsert_user("plain@x.fr", {"password_hash": "x", "role": "viewer"})
        user = self.fs.get_user_by_email("plain@x.fr")
        self.assertNotIn("first_name", user)
        self.assertNotIn("last_name", user)
        listed = next(u for u in self.fs.list_admin_facing_users()
                      if u["email"] == "plain@x.fr")
        self.assertEqual(listed["first_name"], "")
        self.assertEqual(listed["last_name"], "")

    def test_accept_invite_carries_first_and_last(self):
        token, fields = store.new_invite_fields("viewer")
        self.fs.upsert_user("invitee@x.fr", fields)
        result = self.fs.accept_invite(
            store.hash_api_token(token), store.hash_password("chosen-pw-strong"),
            first_name="Katherine", last_name="Johnson")
        self.assertEqual(result["email"], "invitee@x.fr")
        user = self.fs.get_user_by_email("invitee@x.fr")
        self.assertEqual(user["first_name"], "Katherine")
        self.assertEqual(user["last_name"], "Johnson")
        # The invite is consumed (names did not interfere with single-use).
        self.assertNotIn("invite_token_hash", user)

    def test_accept_invite_without_names_leaves_them_absent(self):
        token, fields = store.new_invite_fields("viewer")
        self.fs.upsert_user("noname@x.fr", fields)
        self.fs.accept_invite(
            store.hash_api_token(token), store.hash_password("chosen-pw-strong"))
        user = self.fs.get_user_by_email("noname@x.fr")
        self.assertNotIn("first_name", user)
        self.assertNotIn("last_name", user)

    def test_list_admin_facing_users_exposes_names(self):
        self.fs.upsert_user("dev@x.fr", {
            "role": "admin", "first_name": "Alan", "last_name": "Turing"})
        entry = next(u for u in self.fs.list_admin_facing_users()
                     if u["email"] == "dev@x.fr")
        self.assertEqual(entry["first_name"], "Alan")
        self.assertEqual(entry["last_name"], "Turing")

    def test_valid_name_guard(self):
        # Reuses the shared guard: empty/None allowed, control chars rejected,
        # 1..100 chars after strip.
        self.assertTrue(store.valid_name(None))
        self.assertTrue(store.valid_name(""))
        self.assertTrue(store.valid_name("Ada"))
        self.assertTrue(store.valid_name("x" * 100))
        self.assertFalse(store.valid_name("x" * 101))
        self.assertFalse(store.valid_name("a\x00b"))    # NUL
        self.assertFalse(store.valid_name("a\x7fb"))    # DEL
        self.assertFalse(store.valid_name("line\nbreak"))
        self.assertFalse(store.valid_name("a\x85b"))    # C1 (NEL)
        self.assertFalse(store.valid_name("a" + chr(0x202e) + "b"))  # bidi override (spoof)


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

    def test_viewer_writes_in_commons_but_not_others(self):
        # Model B: a member (viewer) reads the commons, and MAY create there (its
        # new doc is private to it by default). It may NOT delete a commons doc it
        # does not own, nor reach admin-only routes.
        headers = {"Cookie": self.viewer_cookie}
        self.assertEqual(self.srv.get("/api/tree", headers=headers).status, 200)
        self.assertEqual(self.srv.get("/accueil.md", headers=headers).status, 200)

        # A bare write (no CSRF token) is refused by the CSRF guard.
        nocsrf = self.srv.put(
            "/api/file",
            json_body={"path": "inbox/no-csrf.md", "content": "# x\n"},
            headers=headers)
        self.assertEqual(nocsrf.status, 403)
        self.assertFalse(self.srv.path("inbox/no-csrf.md").exists())

        # With CSRF: the member CREATES in the commons (now allowed — model B).
        put = self.srv.put(
            "/api/file",
            json_body={"path": "inbox/cloud-viewer.md", "content": "# Mine\n"},
            headers=auth_headers(self.srv, self.viewer_cookie))
        self.assertEqual(put.status, 200)
        self.assertTrue(self.srv.path("inbox/cloud-viewer.md").exists())

        # But it cannot DELETE a commons doc it does not own (needs owner).
        delete = self.srv.delete(
            "/api/file", json_body={"path": "accueil.md"},
            headers=auth_headers(self.srv, self.viewer_cookie))
        self.assertEqual(delete.status, 403)
        self.assertTrue(self.srv.path("accueil.md").exists())

        # Todos are now PER-MEMBER (not admin-only): a member writes its OWN list.
        todo = self.srv.post(
            "/api/todos", json_body={"text": "ma tâche"},
            headers=auth_headers(self.srv, self.viewer_cookie))
        self.assertEqual(todo.status, 200)
        # But the genuinely admin-only routes stay closed.
        admin_del = self.srv.delete(
            "/api/admin/users", json_body={"email": "x@y.z"},
            headers=auth_headers(self.srv, self.viewer_cookie))
        self.assertEqual(admin_del.status, 403)


class TestAclWriteSecurity(unittest.TestCase):
    """Regression tests for the model-B write/security model: the P0 leaks
    (history/revision/diff, double-slash), the M1/M2 creator semantics, the M5
    member write ladder, and the adversarial-review HIGH fixes (canonical ACL key
    on create). Each asserts a property a real exploit would have broken."""

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

    def _git_commit_content(self):
        """Force-commit content/ so /api/revision|history|diff have a HEAD to read
        (the server also commits via trigger_sync, but async — make it deterministic)."""
        root = str(self.srv.root)
        subprocess.run(["git", "-C", root, "add", "-A"], check=True, capture_output=True)
        subprocess.run(
            ["git", "-C", root, "-c", "user.email=t@t", "-c", "user.name=t",
             "commit", "-m", "test", "--allow-empty"], check=True, capture_output=True)

    # ── S1 + S2 (read side): private doc never leaks via history/revision/diff ──
    def test_history_revision_diff_gated_for_private_doc(self):
        path = "team/secret.md"
        put = self.srv.put(
            "/api/file", json_body={"path": path, "content": "# Secret\nconfidential\n"},
            headers=auth_headers(self.srv, self.admin_cookie))
        self.assertEqual(put.status, 200)
        self._git_commit_content()
        self.fs.set_owner(path, "user:" + ADMIN_EMAIL)  # private to admin

        vh = {"Cookie": self.viewer_cookie}
        rev = self.srv.get(f"/api/revision?path={path}&rev=HEAD", headers=vh)
        self.assertEqual(rev.status, 404)
        self.assertNotIn("confidential", rev.text)
        self.assertEqual(self.srv.get(f"/api/history?path={path}", headers=vh).status, 404)
        self.assertEqual(
            self.srv.get(f"/api/diff?path={path}&from=HEAD&to=HEAD", headers=vh).status, 404)
        # double-slash must not dodge the ACL key (S2 on the web read path)
        self.assertEqual(
            self.srv.get(f"/api/revision?path=team//secret.md&rev=HEAD", headers=vh).status, 404)
        # the owner still reads it (proves the 404s are the ACL gate, not git absence)
        self.assertEqual(
            self.srv.get(f"/api/revision?path={path}&rev=HEAD",
                         headers={"Cookie": self.admin_cookie}).status, 200)

    # ── M1/M2: a member's new doc is private to them and invisible to the admin ──
    def test_member_create_is_private_and_invisible_to_admin(self):
        path = "inbox/member-private.md"
        put = self.srv.put(
            "/api/file", json_body={"path": path, "content": "# mine\n"},
            headers=auth_headers(self.srv, self.viewer_cookie))
        self.assertEqual(put.status, 200)
        acl = self.srv.get(f"/api/acl?path={path}",
                           headers={"Cookie": self.viewer_cookie}).json()
        self.assertEqual(acl["owner"], "user:" + VIEWER_EMAIL)
        self.assertEqual(acl["creator"], "user:" + VIEWER_EMAIL)
        self.assertTrue(acl["can_manage"])
        # admin does NOT see another user's private doc (404, no-existence-oracle)
        self.assertEqual(self.srv.get(f"/api/acl?path={path}",
                                      headers={"Cookie": self.admin_cookie}).status, 404)

    # ── M2: a member's COMMONS doc is managed by its creator, NOT the admin ──
    def test_commons_doc_managed_by_creator_not_admin(self):
        path = "inbox/member-commons.md"
        self.srv.put("/api/file", json_body={"path": path, "content": "# c\n"},
                     headers=auth_headers(self.srv, self.viewer_cookie))
        mk = self.srv.post("/api/acl", json_body={"path": path, "action": "make_commons"},
                           headers=auth_headers(self.srv, self.viewer_cookie))
        self.assertEqual(mk.status, 200)
        admin_view = self.srv.get(f"/api/acl?path={path}",
                                  headers={"Cookie": self.admin_cookie}).json()
        self.assertIsNone(admin_view["owner"])                  # commons (visible)
        self.assertEqual(admin_view["creator"], "user:" + VIEWER_EMAIL)
        self.assertFalse(admin_view["can_manage"])              # admin does NOT manage it
        member_view = self.srv.get(f"/api/acl?path={path}",
                                   headers={"Cookie": self.viewer_cookie}).json()
        self.assertTrue(member_view["can_manage"])              # its creator does

    # ── Review HIGH: create via a non-canonical path keys the ACL canonically ──
    def test_create_double_slash_keys_canonically_and_stays_private(self):
        self.srv.put("/api/file", json_body={"path": "inbox//ds.md", "content": "# x\n"},
                     headers=auth_headers(self.srv, self.viewer_cookie))
        entry = self.fs.get_acl("inbox/ds.md")  # canonical key, not "inbox//ds.md"
        self.assertIsNotNone(entry)
        self.assertEqual(entry.get("owner"), "user:" + VIEWER_EMAIL)
        # admin (non-owner) cannot read it → it is private, NOT leaked as commons
        self.assertEqual(self.srv.get("/api/acl?path=inbox/ds.md",
                                      headers={"Cookie": self.admin_cookie}).status, 404)

    # ── M5: a member may not edit/delete another user's private doc ──
    def test_member_cannot_edit_or_delete_admins_private_doc(self):
        path = "admin-only.md"
        self.srv.put("/api/file", json_body={"path": path, "content": "# a\n"},
                     headers=auth_headers(self.srv, self.admin_cookie))
        self.fs.set_owner(path, "user:" + ADMIN_EMAIL)  # private to admin
        vh = auth_headers(self.srv, self.viewer_cookie)
        self.assertEqual(self.srv.put(
            "/api/file", json_body={"path": path, "content": "# hack\n"}, headers=vh).status, 404)
        self.assertEqual(self.srv.delete(
            "/api/file", json_body={"path": path}, headers=vh).status, 404)
        self.assertEqual(self.srv.path(path).read_text(encoding="utf-8"), "# a\n")

    # ── S3: an in-app move carries the ACL — a private doc stays private ──
    def test_move_keeps_a_private_doc_private(self):
        self.srv.put(
            "/api/file",
            json_body={"path": "team/to-move.md", "content": "# s\nSECRETMOVE\n"},
            headers=auth_headers(self.srv, self.admin_cookie))
        self.fs.set_owner("team/to-move.md", "user:" + ADMIN_EMAIL)
        moved = self.srv.post(
            "/api/file/move",
            json_body={"from": "team/to-move.md", "to": "archive/moved.md"},
            headers=auth_headers(self.srv, self.admin_cookie))
        self.assertEqual(moved.status, 200)
        # The ACL followed: still private at the NEW path, invisible to a viewer…
        self.assertEqual(
            (self.fs.get_acl("archive/moved.md") or {}).get("owner"),
            "user:" + ADMIN_EMAIL)
        self.assertEqual(self.srv.get("/api/acl?path=archive/moved.md",
                                      headers={"Cookie": self.viewer_cookie}).status, 404)
        # …and no phantom owner entry is left behind at the OLD path.
        self.assertIsNone((self.fs.get_acl("team/to-move.md") or {}).get("owner"))

    # ── Groups: membership resolves regardless of the email's case ──
    def test_group_membership_is_case_insensitive(self):
        self.fs.set_group("squad", ["Alice@Example.COM", "bob@x.fr"])
        self.assertIn("squad", self.fs.groups_for_email("alice@example.com"))
        self.assertIn("squad", self.fs.groups_for_email("ALICE@EXAMPLE.COM"))
        self.assertNotIn("squad", self.fs.groups_for_email("carol@x.fr"))

    # ── Cross-platform: a case/trailing-dot path variant must not bypass the ACL ──
    def test_case_and_dot_variants_do_not_bypass_acl(self):
        # A private doc must 404 under ANY spelling — different case, trailing dot —
        # not only its canonical path. On a case-insensitive FS (Windows/macOS) the
        # variant opens the SAME file (the ACL is canonicalized to the real key); on
        # a case-sensitive FS (Linux) the variant simply does not exist. Either way
        # it is never served as commons, and the content never leaks.
        self.srv.put("/api/file",
                     json_body={"path": "team/cased.md", "content": "# c\nCASEDSECRET\n"},
                     headers=auth_headers(self.srv, self.admin_cookie))
        self.fs.set_owner("team/cased.md", "user:" + ADMIN_EMAIL)  # private to admin
        vh = {"Cookie": self.viewer_cookie}
        for spelling in ("team/cased.md", "team/CASED.md", "team/cased.md."):
            r = self.srv.get("/" + spelling, headers=vh)
            self.assertEqual(r.status, 404, f"{spelling} should 404, got {r.status}")
            self.assertNotIn("CASEDSECRET", r.text)

    # ── D4/D6: a grant carries who issued it + an optional expiry ──
    def test_grant_records_author_and_expiry(self):
        self.srv.put("/api/file", json_body={"path": "team/shareme.md", "content": "# s\n"},
                     headers=auth_headers(self.srv, self.admin_cookie))
        self.fs.set_owner("team/shareme.md", "user:" + ADMIN_EMAIL)
        r = self.srv.post("/api/acl",
                          json_body={"path": "team/shareme.md", "action": "grant",
                                     "principal": "user:" + VIEWER_EMAIL,
                                     "level": "view", "expires_days": 7},
                          headers=auth_headers(self.srv, self.admin_cookie))
        self.assertEqual(r.status, 200)
        g = next(x for x in self.fs.list_grants("team/shareme.md")
                 if x["principal"] == "user:" + VIEWER_EMAIL)
        self.assertEqual(g["granted_by"], "user:" + ADMIN_EMAIL)
        self.assertGreater(g["expires_at"], int(time.time()))

    # ── D1: a member discovers docs shared WITH them (not their own / commons) ──
    def test_shared_with_me_lists_received_grants(self):
        self.srv.put("/api/file", json_body={"path": "team/forviewer.md", "content": "# v\n"},
                     headers=auth_headers(self.srv, self.admin_cookie))
        self.fs.set_owner("team/forviewer.md", "user:" + ADMIN_EMAIL)
        self.fs.grant("team/forviewer.md", "user:" + VIEWER_EMAIL, "view",
                      by="user:" + ADMIN_EMAIL)
        seen = self.srv.get("/api/shared-with-me",
                            headers={"Cookie": self.viewer_cookie}).json()
        self.assertIn("team/forviewer.md", [d["path"] for d in seen])
        # The owner does NOT see their own doc as "shared with me".
        admin_seen = self.srv.get("/api/shared-with-me",
                                  headers={"Cookie": self.admin_cookie}).json()
        self.assertNotIn("team/forviewer.md", [d["path"] for d in admin_seen])


class TestAclLifecycleCleanup(unittest.TestCase):
    """Audit Lot 1: deleting a user/group/doc must not leave orphaned ACL/share
    state that a re-created principal or a recycled path could silently inherit."""

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

    def test_dir_rename_keeps_private_docs_private(self):
        # A private doc stays private at its new path after the folder is renamed:
        # the ACL is copied to the destination BEFORE the disk move and dropped from
        # the source AFTER (no commons-leak window), and the old key is gone.
        self.srv.put("/api/file",
                     json_body={"path": "lcfold/secret.md", "content": "# s\nLCFOLD\n"},
                     headers=auth_headers(self.srv, self.admin_cookie))
        self.fs.set_owner("lcfold/secret.md", "user:" + ADMIN_EMAIL)
        r = self.srv.post("/api/dir/rename",
                          json_body={"from": "lcfold", "to": "lcfold-renamed"},
                          headers=auth_headers(self.srv, self.admin_cookie))
        self.assertEqual(r.status, 200)
        self.assertEqual((self.fs.get_acl("lcfold-renamed/secret.md") or {}).get("owner"),
                         "user:" + ADMIN_EMAIL)
        self.assertIsNone(self.fs.get_acl("lcfold/secret.md"))  # no stale source key
        self.assertEqual(self.srv.get("/api/acl?path=lcfold-renamed/secret.md",
                                      headers={"Cookie": self.viewer_cookie}).status, 404)

    def test_delete_user_reassigns_owned_to_admin_and_purges_grants(self):
        self.fs.upsert_user("mem1@x.fr", {"password_hash": "x", "role": "viewer"})
        self.fs.set_owner("lc/owned.md", "user:mem1@x.fr")
        self.fs.grant("lc/other.md", "user:mem1@x.fr", "view")
        self.assertTrue(self.fs.delete_user("mem1@x.fr"))
        # Owned doc transferred to a surviving admin — still private, NOT commons.
        self.assertEqual(self.fs.get_acl("lc/owned.md").get("owner"), "user:" + ADMIN_EMAIL)
        # The grant elsewhere is purged.
        self.assertEqual(self.fs.list_grants("lc/other.md"), [])

    def test_no_privilege_resurrection_on_reinvite(self):
        self.fs.upsert_user("mem2@x.fr", {"password_hash": "x", "role": "viewer"})
        self.fs.grant("lc/secret.md", "user:mem2@x.fr", "edit")
        self.fs.delete_user("mem2@x.fr")
        self.fs.upsert_user("mem2@x.fr", {"password_hash": "x", "role": "viewer"})  # same email
        principals = [g["principal"] for g in self.fs.list_grants("lc/secret.md")]
        self.assertNotIn("user:mem2@x.fr", principals)

    def test_delete_group_purges_group_grants(self):
        self.fs.set_group("lcteam", ["a@x.fr"])
        self.fs.grant("lc/gdoc.md", "group:lcteam", "view")
        self.assertTrue(self.fs.delete_group("lcteam"))
        principals = [g["principal"] for g in self.fs.list_grants("lc/gdoc.md")]
        self.assertNotIn("group:lcteam", principals)

    def test_delete_doc_revokes_its_shares(self):
        self.srv.put("/api/file", json_body={"path": "lc/share-me.md", "content": "# s\n"},
                     headers=auth_headers(self.srv, self.admin_cookie))
        token = self.srv.post("/api/share", json_body={"path": "lc/share-me.md"},
                              headers=auth_headers(self.srv, self.admin_cookie)).json()["token"]
        self.assertEqual(self.srv.get(f"/s/{token}").status, 200)
        self.srv.delete("/api/file", json_body={"path": "lc/share-me.md"},
                        headers=auth_headers(self.srv, self.admin_cookie))
        self.assertEqual(self.srv.get(f"/s/{token}").status, 410)  # revoked → gone

    def test_recycled_path_starts_with_clean_acl(self):
        # A stale ACL entry (e.g. left by a failed delete) with grants but no owner
        # (commons) must NOT be inherited by a new doc created at the same path.
        self.fs.grant("lc/recycle.md", "user:ghost@x.fr", "edit")
        self.srv.put("/api/file", json_body={"path": "lc/recycle.md", "content": "# new\n"},
                     headers=auth_headers(self.srv, self.admin_cookie))
        entry = self.fs.get_acl("lc/recycle.md") or {}
        self.assertFalse([g for g in entry.get("grants", []) if g["principal"] == "user:ghost@x.fr"])

    def test_registry_doctor_detects_and_repairs_orphans(self):
        # A grant on a path with no file → orphan ACL entry + dead grant (the
        # principal is not a real account). The doctor reports both and --fix cleans.
        self.fs.grant("lc/doctor-ghost.md", "user:nobody@x.fr", "view")
        root = self.srv.root / "content"
        report = self.fs.audit_registry(root)
        self.assertIn("lc/doctor-ghost.md", report["acl_no_file"])
        self.assertTrue(any(b["principal"] == "user:nobody@x.fr" for b in report["bad_grant"]))
        fixed = self.fs.repair_registry(report)
        self.assertGreaterEqual(fixed["acl_dropped"], 1)
        self.assertIsNone(self.fs.get_acl("lc/doctor-ghost.md"))  # orphan cleaned

    def test_doctor_preserves_owned_orphan_entry(self):
        # repair_registry must NOT drop an ACL entry that still names an owner: the
        # file may come back (git restore) and the privacy info would be lost. Only
        # pure-grant/empty orphans are auto-dropped.
        self.fs.set_owner("lc/owned-orphan.md", "user:" + ADMIN_EMAIL)  # owner, no file
        report = self.fs.audit_registry(self.srv.root / "content")
        self.assertIn("lc/owned-orphan.md", report["acl_no_file"])
        self.fs.repair_registry(report)
        self.assertEqual((self.fs.get_acl("lc/owned-orphan.md") or {}).get("owner"),
                         "user:" + ADMIN_EMAIL)  # preserved, not deleted

    def test_group_post_rejects_invalid_email(self):
        # C6: a non-email member is refused (would be a dead grant matching no login).
        bad = self.srv.post("/api/admin/groups",
                            json_body={"name": "lcg", "members": ["notanemail"]},
                            headers=auth_headers(self.srv, self.admin_cookie))
        self.assertEqual(bad.status, 400)
        ok = self.srv.post("/api/admin/groups",
                           json_body={"name": "lcg", "members": ["real@x.fr"]},
                           headers=auth_headers(self.srv, self.admin_cookie))
        self.assertEqual(ok.status, 200)

    def test_note_records_author_in_cloud(self):
        # In cloud mode a shared annotation records its admin author (so several
        # admins' notes are distinguishable).
        r = self.srv.post("/api/notes",
                          json_body={"path": "accueil.md", "exact": "hi", "note": "n1", "pos": 0},
                          headers=auth_headers(self.srv, self.admin_cookie))
        self.assertEqual(r.status, 200)
        self.assertEqual(r.json().get("author"), ADMIN_EMAIL)


class TestPerMemberTodos(unittest.TestCase):
    """Cloud: each account keeps its OWN private todo list (.atlas/todos.json), and
    the legacy global markdown is migrated to the first admin (non-destructively)."""

    def setUp(self):
        self.srv = AtlasServer(extra_env=cloud_env())
        self.srv.start()
        self.fs = file_store_of(self.srv)
        seed_default_users(self.fs)
        self.admin = session_cookie(self.srv, ADMIN_EMAIL, ADMIN_PASSWORD)
        self.viewer = session_cookie(self.srv, VIEWER_EMAIL, VIEWER_PASSWORD)

    def tearDown(self):
        self.srv.stop()

    def test_each_member_has_its_own_list(self):
        r = self.srv.post("/api/todos", json_body={"text": "Tâche de Fabien"},
                          headers=auth_headers(self.srv, self.viewer))
        self.assertEqual(r.status, 200)
        viewer_list = self.srv.get("/api/todos", headers={"Cookie": self.viewer}).json()
        self.assertTrue(any(t["text"] == "Tâche de Fabien" for t in viewer_list))
        # The admin's list is SEPARATE — it never sees the member's todo.
        admin_list = self.srv.get("/api/todos", headers={"Cookie": self.admin}).json()
        self.assertFalse(any(t["text"] == "Tâche de Fabien" for t in admin_list))

    def test_legacy_global_migrates_to_admin_not_to_member(self):
        # The default mind ships a legacy quick.md. First admin load → migrated to
        # the admin's private list; the legacy file is KEPT; a member inherits none.
        admin_list = self.srv.get("/api/todos", headers={"Cookie": self.admin}).json()
        self.assertTrue(any(t["text"] == "Préparer le bilan mensuel" for t in admin_list))
        self.assertTrue(self.srv.path(TODO_REL).exists())  # non-destructive
        viewer_list = self.srv.get("/api/todos", headers={"Cookie": self.viewer}).json()
        self.assertFalse(any(t["text"] == "Préparer le bilan mensuel" for t in viewer_list))


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

    def test_share_on_private_doc_serves_publicly_no_api_leak(self):
        # R3: a PRIVATE doc (owned by the admin) shared by link. The /s/<token>
        # link serves it publicly — evaluated through the UNIFIED ACL path (the
        # share is an anon:<token_sha256> view-grant) — but the share grants NO
        # access to a logged-in viewer who has no grant of their own.
        from server.pure import acl
        doc = self.srv.root / "content" / "r3-secret.md"
        doc.write_text("# Secret\nR3PRIVATEMARK only via the link.\n", encoding="utf-8")
        self.fs.set_owner("r3-secret.md", "user:" + ADMIN_EMAIL)
        token = self._create_share("r3-secret.md")["token"]
        public = self.srv.get(f"/s/{token}")
        self.assertEqual(public.status, 200)
        self.assertIn("R3PRIVATEMARK", public.text)
        # No leak: a logged-in viewer (no grant) resolves to None — the anon: share
        # grant only matches the token's principal, never a member's ctx.
        viewer = acl.viewer_ctx({"email": VIEWER_EMAIL, "role": "viewer"}, self.fs)
        self.assertIsNone(acl.effective_level("r3-secret.md", viewer, self.fs))

    def test_share_is_an_anon_grant_in_effective_level(self):
        # R3: the unified eval — a share resolves as an anon:<token_sha256> view-grant.
        from server.pure import acl
        doc = self.srv.root / "content" / "r3-unit.md"
        doc.write_text("# U\nx\n", encoding="utf-8")
        self.fs.set_owner("r3-unit.md", "user:" + ADMIN_EMAIL)
        token = self._create_share("r3-unit.md")["token"]
        self.assertEqual(
            acl.effective_level("r3-unit.md", acl.share_ctx(token), self.fs), "view")
        # A different token grants nothing; an anonymous visitor sees nothing.
        self.assertIsNone(
            acl.effective_level("r3-unit.md", acl.share_ctx("not-the-token"), self.fs))
        self.assertIsNone(acl.effective_level("r3-unit.md", acl.ANON, self.fs))

    def test_share_lifecycle_create_list_revoke(self):
        created = self._create_share("accueil.md")
        share_id, token = created["id"], created["token"]
        # uuid4 id (36 characters, 4 dashes) — not a legacy 24-hex id.
        self.assertEqual(len(share_id), 36)
        self.assertEqual(share_id.count("-"), 4)
        self.assertEqual(created["path"], "accueil.md")

        # On disk: the cleartext token (capability URL) AND its SHA256 index.
        record = next(s for s in self._shares_on_disk() if s["id"] == share_id)
        self.assertEqual(record["token"], token)
        self.assertEqual(
            record["token_sha256"],
            hashlib.sha256(token.encode()).hexdigest())
        self.assertEqual(record["created_by"], ADMIN_EMAIL)

        # Public link served without a cookie.
        public = self.srv.get(f"/s/{token}")
        self.assertEqual(public.status, 200)
        self.assertIn("Bienvenue dans le mind de test.", public.text)

        # Admin listing returns the stored cleartext token so the admin can
        # re-copy the link, with file_exists telling the UI it is still live.
        listing = self.srv.get(
            "/api/share/list", headers={"Cookie": self.admin_cookie}).json()
        entry = next(d for d in listing if d["id"] == share_id)
        self.assertEqual(entry["token"], token)
        self.assertEqual(entry["path"], "accueil.md")
        self.assertFalse(entry["revoked"])
        self.assertTrue(entry["file_exists"])
        # The listed link actually works.
        relink = self.srv.get(f"/s/{entry['token']}")
        self.assertEqual(relink.status, 200)
        self.assertIn("Bienvenue dans le mind de test.", relink.text)

        # Revocation → link 410, then re-revocation → 404.
        revoke = self.srv.delete(
            f"/api/share/{share_id}",
            headers=auth_headers(self.srv, self.admin_cookie))
        self.assertEqual(revoke.status, 200)
        self.assertEqual(revoke.json(), {"ok": True})

        gone = self.srv.get(f"/s/{token}")
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

    def test_token_is_short_and_opaque(self):
        # The link is a short opaque capability key (no signed `payload.sig`),
        # ~22 url-safe chars — and it resolves.
        created = self._create_share("accueil.md")
        token = created["token"]
        self.assertNotIn(".", token)
        self.assertLessEqual(len(token), 24)
        self.assertEqual(self.srv.get(f"/s/{token}").status, 200)

    def test_move_via_app_auto_repoints_share(self):
        # An in-app move re-points the share automatically: the link keeps working
        # with no broken window, and the stored path follows the doc.
        self.srv.put("/api/file",
                     json_body={"path": "movable.md", "content": "# Movable\n"},
                     headers=auth_headers(self.srv, self.admin_cookie))
        created = self._create_share("movable.md")
        moved = self.srv.post(
            "/api/file/move",
            json_body={"from": "movable.md", "to": "archive/movable.md"},
            headers=auth_headers(self.srv, self.admin_cookie))
        self.assertEqual(moved.status, 200)
        served = self.srv.get(f"/s/{created['token']}")
        self.assertEqual(served.status, 200)
        self.assertIn("Movable", served.text)
        record = next(s for s in self._shares_on_disk() if s["id"] == created["id"])
        self.assertEqual(record["path"], "archive/movable.md")

    def test_dir_rename_auto_repoints_share(self):
        # Renaming a folder in-app re-points the links of the docs it contains.
        self.srv.put("/api/file",
                     json_body={"path": "folder/inside.md", "content": "# Inside\n"},
                     headers=auth_headers(self.srv, self.admin_cookie))
        created = self._create_share("folder/inside.md")
        renamed = self.srv.post(
            "/api/dir/rename",
            json_body={"from": "folder", "to": "folder-renamed"},
            headers=auth_headers(self.srv, self.admin_cookie))
        self.assertEqual(renamed.status, 200)
        self.assertEqual(self.srv.get(f"/s/{created['token']}").status, 200)
        record = next(s for s in self._shares_on_disk() if s["id"] == created["id"])
        self.assertEqual(record["path"], "folder-renamed/inside.md")

    def test_broken_link_detected_then_reactivated(self):
        # A move OUTSIDE the app (raw rename on disk) breaks the link: the public
        # page 404s and the admin list flags it broken (file_exists False).
        # Reactivating (PATCH) re-points it → the SAME URL works again.
        self.srv.put("/api/file",
                     json_body={"path": "stray.md", "content": "# Stray\n"},
                     headers=auth_headers(self.srv, self.admin_cookie))
        created = self._create_share("stray.md")
        (self.srv.content_root / "moved-stray.md").write_text(
            self.srv.path("stray.md").read_text(encoding="utf-8"), encoding="utf-8")
        self.srv.path("stray.md").unlink()

        self.assertEqual(self.srv.get(f"/s/{created['token']}").status, 404)
        listing = self.srv.get(
            "/api/share/list?path=stray.md",
            headers={"Cookie": self.admin_cookie}).json()
        entry = next(d for d in listing if d["id"] == created["id"])
        self.assertFalse(entry["file_exists"])

        reactivated = self.srv.patch(
            f"/api/share/{created['id']}",
            json_body={"path": "moved-stray.md"},
            headers=auth_headers(self.srv, self.admin_cookie))
        self.assertEqual(reactivated.status, 200)
        served = self.srv.get(f"/s/{created['token']}")
        self.assertEqual(served.status, 200)
        self.assertIn("Stray", served.text)

    def test_reactivate_rejects_unknown_target(self):
        created = self._create_share("accueil.md")
        resp = self.srv.patch(
            f"/api/share/{created['id']}",
            json_body={"path": "does/not/exist.md"},
            headers=auth_headers(self.srv, self.admin_cookie))
        self.assertEqual(resp.status, 404)
        self.assertEqual(resp.json(), {"error": "document not found"})

    def test_reactivate_requires_admin(self):
        created = self._create_share("accueil.md")
        resp = self.srv.patch(
            f"/api/share/{created['id']}",
            json_body={"path": "projets/beta.md"},
            headers={"Cookie": self.viewer_cookie})
        self.assertEqual(resp.status, 403)

    def test_reactivate_unknown_or_revoked_404(self):
        # An unknown share id, AND a revoked share, both refuse reactivation: a
        # revoked link must not be silently resurrected.
        unknown = self.srv.patch(
            "/api/share/00000000-0000-4000-8000-000000000000",
            json_body={"path": "accueil.md"},
            headers=auth_headers(self.srv, self.admin_cookie))
        self.assertEqual(unknown.status, 404)
        self.assertEqual(unknown.json(), {"error": "not found or revoked"})

        created = self._create_share("accueil.md")
        self.srv.delete(f"/api/share/{created['id']}",
                        headers=auth_headers(self.srv, self.admin_cookie))
        revoked = self.srv.patch(
            f"/api/share/{created['id']}",
            json_body={"path": "accueil.md"},
            headers=auth_headers(self.srv, self.admin_cookie))
        self.assertEqual(revoked.status, 404)
        self.assertEqual(revoked.json(), {"error": "not found or revoked"})

    def test_create_with_future_expiry(self):
        # A positive expires_days yields a sane FUTURE expires_at (server-computed)
        # and the link serves before it lapses.
        before = int(time.time())
        created = self._create_share("accueil.md", expires_days=30)
        horizon = before + 30 * 86400
        self.assertGreaterEqual(created["expires_at"], horizon - 5)
        self.assertLessEqual(created["expires_at"], horizon + 5)
        self.assertEqual(self.srv.get(f"/s/{created['token']}").status, 200)

    def test_mcp_move_doc_auto_repoints_share(self):
        # The MCP move_doc tool re-points share links too — a code path distinct
        # from the HTTP /api/file/move route (its own try/except in mcp_call.py).
        api_token = secrets.token_hex(32)
        self.fs.upsert_user(API_EMAIL, {
            "role": "api",
            "api_token_hash": hashlib.sha256(api_token.encode()).hexdigest(),
            "password_hash": "$2b$12$" + "x" * 53,
            "acts_as": ADMIN_EMAIL,  # bound to admin → may move (owner-level write)
        })
        self.srv.put(
            "/api/file",
            json_body={"path": "mcp-movable.md", "content": "# MCP movable\n"},
            headers=auth_headers(self.srv, self.admin_cookie))
        created = self._create_share("mcp-movable.md")
        resp = self.srv.post(f"/mcp/{api_token}", json_body={
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": "move_doc",
                       "arguments": {"from": "mcp-movable.md",
                                     "to": "kept/mcp-movable.md"}},
        })
        self.assertEqual(resp.status, 200)
        self.assertFalse(resp.json()["result"].get("isError"), resp.text)
        self.assertEqual(self.srv.get(f"/s/{created['token']}").status, 200)
        record = next(s for s in self._shares_on_disk() if s["id"] == created["id"])
        self.assertEqual(record["path"], "kept/mcp-movable.md")

    def test_broken_link_suggests_path_via_git_history(self):
        # An out-of-app `git mv` breaks the link; the admin listing surfaces a
        # suggested_path resolved from git rename history (one-click reactivation).
        # Isolated server: no background trigger_sync to race with the git commands.
        with AtlasServer(extra_env=cloud_env()) as srv:
            seed_default_users(file_store_of(srv))
            cookie = session_cookie(srv, ADMIN_EMAIL, ADMIN_PASSWORD)
            (srv.content_root / "gitmoved.md").write_text(
                "# Git moved\n", encoding="utf-8", newline="")
            srv.git("add", "content/gitmoved.md", check=True)
            srv.git("commit", "-q", "-m", "add gitmoved", check=True)
            created = srv.post(
                "/api/share", json_body={"path": "gitmoved.md"},
                headers=auth_headers(srv, cookie)).json()
            srv.git("mv", "content/gitmoved.md", "content/renamed-by-git.md",
                    check=True)
            srv.git("commit", "-q", "-m", "git mv gitmoved", check=True)

            entry = next(
                d for d in srv.get("/api/share/list?path=gitmoved.md",
                                   headers={"Cookie": cookie}).json()
                if d["id"] == created["id"])
            self.assertFalse(entry["file_exists"])
            self.assertEqual(entry.get("suggested_path"), "renamed-by-git.md")

    def test_viewer_cannot_create_share_nor_list(self):
        headers = {"Cookie": self.viewer_cookie}
        create = self.srv.post(
            "/api/share", json_body={"path": "accueil.md"}, headers=headers)
        self.assertEqual(create.status, 403)
        listing = self.srv.get("/api/share/list", headers=headers)
        self.assertEqual(listing.status, 403)

    def test_expired_share_410(self):
        # Expiry is read from the registry record (not the token): a share whose
        # stored expires_at is in the past → 410 "expired".
        created = self._create_share("accueil.md")
        shares_file = self.srv.root / ".atlas" / "shares.json"
        shares = json.loads(shares_file.read_text(encoding="utf-8"))
        for share in shares:
            if share["id"] == created["id"]:
                share["expires_at"] = int(time.time()) - 60
        shares_file.write_text(json.dumps(shares), encoding="utf-8")
        resp = self.srv.get(f"/s/{created['token']}")
        self.assertEqual(resp.status, 410)
        self.assertIn("expir", resp.text)  # "Lien expir&eacute;" (expired)

    def test_unregistered_token_404_fail_closed(self):
        # A token absent from the registry resolves to nothing → 404. The registry
        # is the single source of truth (fail-CLOSED), so a forged/guessed key
        # cannot be served.
        resp = self.srv.get(f"/s/{secrets.token_urlsafe(16)}")
        self.assertEqual(resp.status, 404)
        self.assertIn("Invalid link", resp.text)

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
        # Share tokens are random (opaque capability keys), so there is no token
        # collision to engineer between tests: just create a share and assert its
        # registry file never enters git.
        self._create_share("accueil.md")
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
        token = secrets.token_urlsafe(16)
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

        self.assertEqual(self.srv.get(f"/s/{token}").status, 200)
        revoke = self.srv.delete(
            f"/api/share/{migrated_id}",
            headers=auth_headers(self.srv, self.admin_cookie))
        self.assertEqual(revoke.status, 200)
        self.assertEqual(self.srv.get(f"/s/{token}").status, 410)


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
        self.assertEqual(self.srv.get(f"/s/{token}").status, 410)

        original = self._corrupt("shares.json")
        try:
            resp = self.srv.get(f"/s/{token}")
            self.assertEqual(resp.status, 503)
            self.assertIn("unavailable", resp.text)
        finally:
            self._registry_path("shares.json").write_text(
                original, encoding="utf-8")
        # Registry restored: the revoked link returns 410 again.
        self.assertEqual(self.srv.get(f"/s/{token}").status, 410)

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
