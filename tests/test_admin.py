"""Administration backend (cloud mode, KB_AUTH_ENABLED=1, ATLAS_STORE=file).

Covers batch 2c:
- First-boot: an install token (setup-token) is printed on stderr when no admin
  exists; /api/setup requires it (wrong token → 403, drive-by without a token →
  refused), correct token → admin created + session; the /setup window then
  closes (404 + 409).
- Account CRUD: /api/admin/users (admin OK, viewer → 403, last admin not
  deletable, hash never exposed).
- API tokens: /api/tokens (creation → working Bearer on /api/v1/search,
  revocation → 401, listing without the secret).
- Basic CSRF: non-JSON Content-Type refused, third-party origin refused (403).

Cloud harness identical to test_cloud_filestore: KB_AUTH_ENABLED=1, non-default
SESSION_SECRET, git clone bypassed via KB_REPO_PATH={root}. The file registry
(.atlas/) is seeded/read directly by a FileStore pointed at srv.root/.atlas.
"""
import hashlib
import re
import sys
import time
import unittest
from pathlib import Path

from harness import AtlasServer

REPO_SRC = Path(__file__).resolve().parent.parent / "src"
if str(REPO_SRC) not in sys.path:
    sys.path.insert(0, str(REPO_SRC))

import store  # noqa: E402

SESSION_SECRET = "atlas-test-admin-secret-0123456789abcdef"

ADMIN_EMAIL = "admin@test.local"
ADMIN_PASSWORD = "correct-horse-battery"
VIEWER_EMAIL = "viewer@test.local"
VIEWER_PASSWORD = "viewer-password-42"


def _assert_i18n(tc, haystack, entry):
    # The viewer STRINGS catalog ships from .ts now; esbuild re-quotes string literals
    # (single→double) when bundling, so match each "key: 'value'" entry regardless of the
    # surrounding quote style.
    tc.assertRegex(haystack, re.escape(entry).replace("'", "[\"']"))


def cloud_env() -> dict:
    return {
        "KB_AUTH_ENABLED": "1",
        "SESSION_SECRET": SESSION_SECRET,
        "KB_REPO_PATH": "{root}",   # bypasses the git clone at boot
        "ATLAS_STORE": "file",
        "GIT_PULL_INTERVAL": "3600",
    }


def file_store_of(srv: AtlasServer) -> store.FileStore:
    return store.FileStore(srv.root / ".atlas")


def seed_admin_and_viewer(fs: store.FileStore) -> None:
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
    """Login → valid Cookie header. The 0x2e cookie bug is fixed (batch 2d), no
    more retry/sleep: a single login is enough. Returns the kb_session header."""
    resp = login(srv, email, password)
    assert resp.status == 303, f"login {email}: {resp.status}"
    cookie = (resp.headers.get("Set-Cookie") or "").split(";", 1)[0]
    me = srv.get("/api/me", headers={"Cookie": cookie}).json()
    assert me.get("authenticated"), f"invalid cookie for {email}"
    return cookie


def csrf_token_for(srv: AtlasServer, cookie: str) -> str:
    """Session CSRF token (batch 2d): exposed by /api/me, to be replayed in the
    X-CSRF-Token header on authenticated mutating requests."""
    return srv.get("/api/me", headers={"Cookie": cookie}).json()["csrf_token"]


def wait_for_setup_token(srv: AtlasServer, timeout: float = 5.0) -> str:
    """Retrieve the setup-token printed on stderr (server.log) at boot."""
    deadline = time.monotonic() + timeout
    pattern = re.compile(r"Atlas setup token:\s*(\S+)")
    while time.monotonic() < deadline:
        match = pattern.search(srv.read_log())
        if match:
            return match.group(1)
        time.sleep(0.05)
    raise AssertionError("setup-token never printed on stderr")


class TestFirstBoot(unittest.TestCase):
    """First start: no admin → /setup window protected by a token."""

    def test_setup_token_printed_and_setup_page_open(self):
        with AtlasServer(extra_env=cloud_env()) as srv:
            token = wait_for_setup_token(srv)
            self.assertTrue(token)
            page = srv.get("/setup")
            self.assertEqual(page.status, 200)
            self.assertIn("text/html", page.headers.get("Content-Type", ""))
            self.assertIn("/api/setup", page.text)

    def test_root_redirects_to_setup_before_any_admin(self):
        with AtlasServer(extra_env=cloud_env()) as srv:
            wait_for_setup_token(srv)
            resp = srv.get("/")
            self.assertEqual(resp.status, 303)
            self.assertEqual(resp.headers.get("Location"), "/setup")

    def test_drive_by_without_token_refused(self):
        # Reaching the URL is not enough: without a token, no admin is created.
        with AtlasServer(extra_env=cloud_env()) as srv:
            wait_for_setup_token(srv)
            resp = srv.post("/api/setup", json_body={
                "email": "intruder@test.local", "password": "x" * 12})
            self.assertEqual(resp.status, 403)
            self.assertFalse(file_store_of(srv).has_admin())

    def test_wrong_token_403(self):
        with AtlasServer(extra_env=cloud_env()) as srv:
            wait_for_setup_token(srv)
            resp = srv.post("/api/setup", json_body={
                "email": "intruder@test.local", "password": "x" * 12,
                "setup_token": "wrong-token"})
            self.assertEqual(resp.status, 403)
            self.assertFalse(file_store_of(srv).has_admin())

    def test_short_password_400(self):
        with AtlasServer(extra_env=cloud_env()) as srv:
            token = wait_for_setup_token(srv)
            resp = srv.post("/api/setup", json_body={
                "email": "boss@test.local", "password": "short",
                "setup_token": token})
            self.assertEqual(resp.status, 400)
            self.assertFalse(file_store_of(srv).has_admin())

    def test_good_token_creates_admin_and_session_then_window_closes(self):
        with AtlasServer(extra_env=cloud_env()) as srv:
            token = wait_for_setup_token(srv)
            resp = srv.post("/api/setup", json_body={
                "email": "boss@test.local",
                "password": "boss-strong-password",
                "setup_token": token})
            self.assertEqual(resp.status, 200)
            self.assertTrue(resp.json()["ok"])
            # A session is opened (cookie set). The cookie may be one of the
            # ~12% self-invalid ones from the known HMAC bug (batch 2d): we do
            # not rely on it for /api/me — we re-check via a retried login.
            set_cookie = resp.headers.get("Set-Cookie") or ""
            self.assertTrue(set_cookie.startswith("kb_session="))
            self.assertIn("HttpOnly", set_cookie)
            self.assertIn("Secure", set_cookie)

            fs = file_store_of(srv)
            self.assertTrue(fs.has_admin())
            created = fs.get_user_by_email("boss@test.local")
            self.assertEqual(created["role"], "admin")
            # Password stored hashed (native scrypt), never in cleartext.
            self.assertTrue(created["password_hash"].startswith("scrypt$"))

            # The created account can log in and access the viewer as admin.
            cookie = session_cookie(srv, "boss@test.local", "boss-strong-password")
            me = srv.get("/api/me", headers={"Cookie": cookie}).json()
            self.assertTrue(me["authenticated"])
            self.assertEqual(me["role"], "admin")

            # Window closed: /setup → 404, /api/setup → 409.
            self.assertEqual(srv.get("/setup").status, 404)
            again = srv.post("/api/setup", json_body={
                "email": "second@test.local", "password": "another-strong-pw",
                "setup_token": token})
            self.assertEqual(again.status, 409)

    def test_no_setup_window_when_admin_already_seeded(self):
        # An admin seeded before the 1st request: the window does not open (boot
        # already noticed it; even if the token was printed, setup_is_open
        # re-checks the existence of an admin).
        with AtlasServer(extra_env=cloud_env()) as srv:
            seed_admin_and_viewer(file_store_of(srv))
            self.assertEqual(srv.get("/setup").status, 404)
            # Normal login available.
            self.assertEqual(srv.get("/login").status, 200)


class TestAdminUsers(unittest.TestCase):
    """Account CRUD via /api/admin/users."""

    srv: AtlasServer

    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(extra_env=cloud_env())
        cls.srv.start()
        cls.fs = file_store_of(cls.srv)
        seed_admin_and_viewer(cls.fs)
        cls.admin_cookie = session_cookie(cls.srv, ADMIN_EMAIL, ADMIN_PASSWORD)
        cls.admin_csrf = csrf_token_for(cls.srv, cls.admin_cookie)
        cls.viewer_cookie = session_cookie(cls.srv, VIEWER_EMAIL, VIEWER_PASSWORD)

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def _admin(self):
        return {"Cookie": self.admin_cookie, "X-CSRF-Token": self.admin_csrf}

    def test_list_users_admin_only_no_hash(self):
        resp = self.srv.get("/api/admin/users", headers=self._admin())
        self.assertEqual(resp.status, 200)
        users = resp.json()
        emails = {u["email"] for u in users}
        self.assertIn(ADMIN_EMAIL, emails)
        self.assertIn(VIEWER_EMAIL, emails)
        # Never a password hash in the response.
        self.assertNotIn("password_hash", resp.text)

    def test_viewer_forbidden_on_list(self):
        resp = self.srv.get("/api/admin/users",
                            headers={"Cookie": self.viewer_cookie})
        self.assertEqual(resp.status, 403)

    def test_anonymous_unauthorized_on_list(self):
        resp = self.srv.get("/api/admin/users")
        self.assertEqual(resp.status, 401)

    def test_invite_user_then_accept_then_login(self):
        # Admin invites (no password) → gets a one-time invite link; the pending
        # account cannot log in until the invitee accepts and sets a password.
        resp = self.srv.post("/api/admin/users", headers=self._admin(),
                             json_body={"email": "new@test.local",
                                        "role": "viewer"})
        self.assertEqual(resp.status, 201)
        body = resp.json()
        self.assertEqual(body["role"], "viewer")
        self.assertIn("/invite/", body["invite_url"])
        token = body["invite_url"].rsplit("/invite/", 1)[1]
        # Pending account: login refused (no usable password yet).
        self.assertEqual(login(self.srv, "new@test.local", "anything-at-all").status, 401)
        # Accept: the invitee sets their OWN password and is logged in.
        accept = self.srv.post("/api/invite",
                               json_body={"token": token,
                                          "password": "invitee-chosen-pw"})
        self.assertEqual(accept.status, 200)
        self.assertEqual(accept.json()["email"], "new@test.local")
        # The account now logs in normally with that password.
        cookie = session_cookie(self.srv, "new@test.local", "invitee-chosen-pw")
        me = self.srv.get("/api/me", headers={"Cookie": cookie}).json()
        self.assertEqual(me["email"], "new@test.local")

    def test_create_duplicate_409(self):
        resp = self.srv.post("/api/admin/users", headers=self._admin(),
                             json_body={"email": ADMIN_EMAIL,
                                        "password": "whatever-strong",
                                        "role": "admin"})
        self.assertEqual(resp.status, 409)

    def test_create_invalid_role_400(self):
        resp = self.srv.post("/api/admin/users", headers=self._admin(),
                             json_body={"email": "weird@test.local",
                                        "password": "long-enough-pw",
                                        "role": "superuser"})
        self.assertEqual(resp.status, 400)

    def test_create_user_needs_no_password(self):
        # The admin no longer sets a password: creation mints an invite link and
        # the account is PENDING (no usable password) until the invitee accepts.
        resp = self.srv.post("/api/admin/users", headers=self._admin(),
                             json_body={"email": "nopw@test.local", "role": "viewer"})
        self.assertEqual(resp.status, 201)
        self.assertIn("/invite/", resp.json()["invite_url"])
        user = self.fs.get_user_by_email("nopw@test.local")
        self.assertNotIn("password_hash", user)
        self.assertIn("invite_token_hash", user)

    def test_reset_password(self):
        # An ACTIVE account (seeded directly with a real password) — a pending
        # invite has no password to reset (covered in TestInviteFlow).
        self.fs.upsert_user("reset@test.local", {
            "password_hash": store.hash_password("first-password-x"),
            "role": "viewer",
        })
        resp = self.srv.post("/api/admin/users/password", headers=self._admin(),
                             json_body={"email": "reset@test.local",
                                        "password": "second-password-y"})
        self.assertEqual(resp.status, 200)
        # The old password no longer works, the new one does.
        old = login(self.srv, "reset@test.local", "first-password-x")
        self.assertEqual(old.status, 401)
        cookie = session_cookie(self.srv, "reset@test.local", "second-password-y")
        self.assertTrue(cookie.startswith("kb_session="))

    def test_delete_user(self):
        self.srv.post("/api/admin/users", headers=self._admin(),
                      json_body={"email": "doomed@test.local",
                                 "password": "doomed-password",
                                 "role": "viewer"})
        resp = self.srv.delete("/api/admin/users", headers=self._admin(),
                               json_body={"email": "doomed@test.local"})
        self.assertEqual(resp.status, 200)
        self.assertIsNone(self.fs.get_user_by_email("doomed@test.local"))

    def test_cannot_delete_last_admin(self):
        # ADMIN_EMAIL is the only admin of this mind: deletion refused (409).
        self.assertEqual(self.fs.count_admins(), 1)
        resp = self.srv.delete("/api/admin/users", headers=self._admin(),
                               json_body={"email": ADMIN_EMAIL})
        self.assertEqual(resp.status, 409)
        self.assertIn("last admin", resp.json()["error"])
        self.assertIsNotNone(self.fs.get_user_by_email(ADMIN_EMAIL))

    def test_viewer_cannot_create_user(self):
        resp = self.srv.post("/api/admin/users",
                             headers={"Cookie": self.viewer_cookie},
                             json_body={"email": "x@test.local",
                                        "password": "pw-long-enough",
                                        "role": "viewer"})
        self.assertEqual(resp.status, 403)

    def test_create_user_null_byte_email_400(self):
        # Repro 2c: a NUL (0x00) slipped through the [^@\s] pattern (\s only
        # covers whitespace) and landed in users.json.
        resp = self.srv.post("/api/admin/users", headers=self._admin(),
                             json_body={"email": "a\x00b@evil.z",
                                        "password": "long-enough-pw",
                                        "role": "viewer"})
        self.assertEqual(resp.status, 400)
        self.assertIsNone(self.fs.get_user_by_email("a\x00b@evil.z"))
        # No email with a control character in the durable registry.
        for user in self.fs.list_users():
            self.assertFalse(any(ord(c) < 0x20 or ord(c) == 0x7f
                                 for c in (user.get("email") or "")))

    def test_create_user_del_char_email_400(self):
        resp = self.srv.post("/api/admin/users", headers=self._admin(),
                             json_body={"email": "a\x7fb@evil.z",
                                        "password": "long-enough-pw",
                                        "role": "viewer"})
        self.assertEqual(resp.status, 400)

    def test_create_user_overlong_email_400(self):
        # Repro 2c: no length bound (5000 chars accepted). RFC 5321 caps at 254.
        huge = ("a" * 5000) + "@x.z"
        resp = self.srv.post("/api/admin/users", headers=self._admin(),
                             json_body={"email": huge,
                                        "password": "long-enough-pw",
                                        "role": "viewer"})
        self.assertEqual(resp.status, 400)
        self.assertIsNone(self.fs.get_user_by_email(huge))

    def test_create_token_overlong_label_400(self):
        # Repro 2c: a 5000-char label became a giant <slug>@api.local email in
        # the registry.
        huge = "x" * 5000
        resp = self.srv.post("/api/tokens", headers=self._admin(),
                             json_body={"label": huge})
        self.assertEqual(resp.status, 400)

    def test_create_token_control_char_label_400(self):
        resp = self.srv.post("/api/tokens", headers=self._admin(),
                             json_body={"label": "tok\x00en"})
        self.assertEqual(resp.status, 400)

    def test_delete_user_refuses_last_admin_at_store_level(self):
        # The anti-lockout guard lives INSIDE delete_user(protect_last_admin=True),
        # not only in the handler's pre-check: a FileStore with a single admin
        # must raise LastAdminError even when called directly.
        with self.assertRaises(store.LastAdminError):
            self.fs.delete_user(ADMIN_EMAIL, protect_last_admin=True)
        self.assertIsNotNone(self.fs.get_user_by_email(ADMIN_EMAIL))
        # Without the guard (CLI recovery path), deletion is allowed.
        self.fs.upsert_user("cli-admin@test.local", {
            "password_hash": store.hash_password("cli-admin-pw"),
            "role": "admin",
        })
        self.assertTrue(self.fs.delete_user("cli-admin@test.local"))


class TestInviteFlow(unittest.TestCase):
    """C1 — the admin mints a SINGLE-USE invite link (no password); the invitee
    opens /invite/<token> and sets their OWN password, which activates + logs in
    the account. Covers: the accept page, password rule, single-use, expiry, the
    pending state (no admin reset, listed as pending), and re-invite."""

    srv: AtlasServer

    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(extra_env=cloud_env())
        cls.srv.start()
        cls.fs = file_store_of(cls.srv)
        seed_admin_and_viewer(cls.fs)
        cls.admin_cookie = session_cookie(cls.srv, ADMIN_EMAIL, ADMIN_PASSWORD)
        cls.admin_csrf = csrf_token_for(cls.srv, cls.admin_cookie)

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def _admin(self):
        return {"Cookie": self.admin_cookie, "X-CSRF-Token": self.admin_csrf}

    def _mint(self, email: str, role: str = "viewer") -> str:
        """Admin mints an invite for `email`; returns the opaque token from the URL."""
        resp = self.srv.post("/api/admin/users", headers=self._admin(),
                             json_body={"email": email, "role": role})
        self.assertEqual(resp.status, 201, resp.text)
        return resp.json()["invite_url"].rsplit("/invite/", 1)[1]

    def test_invite_page_live_then_404_for_unknown(self):
        token = self._mint("page@test.local")
        page = self.srv.get(f"/invite/{token}")
        self.assertEqual(page.status, 200)
        self.assertIn("/api/invite", page.text)
        self.assertIn("page@test.local", page.text)
        # Unknown token → 404, same as an absent invite (no existence oracle).
        self.assertEqual(self.srv.get("/invite/not-a-real-token-xyz").status, 404)

    def test_accept_short_password_400(self):
        token = self._mint("short@test.local")
        resp = self.srv.post("/api/invite",
                             json_body={"token": token, "password": "short"})
        self.assertEqual(resp.status, 400)

    def test_accept_unknown_token_409(self):
        resp = self.srv.post("/api/invite",
                             json_body={"token": "nope-nope-nope",
                                        "password": "long-enough-pw"})
        self.assertEqual(resp.status, 409)

    def test_accept_is_single_use(self):
        token = self._mint("once@test.local")
        first = self.srv.post("/api/invite",
                              json_body={"token": token, "password": "first-pw-strong"})
        self.assertEqual(first.status, 200)
        # The same token cannot be redeemed twice.
        second = self.srv.post("/api/invite",
                               json_body={"token": token, "password": "second-pw-strong"})
        self.assertEqual(second.status, 409)
        # The account logs in with the FIRST password only.
        self.assertEqual(login(self.srv, "once@test.local", "second-pw-strong").status, 401)
        self.assertTrue(session_cookie(self.srv, "once@test.local", "first-pw-strong"))

    def test_pending_account_password_reset_404(self):
        self._mint("pending@test.local")
        # An admin cannot set a pending account's password — that's the invite's job.
        resp = self.srv.post("/api/admin/users/password", headers=self._admin(),
                             json_body={"email": "pending@test.local",
                                        "password": "admin-set-this-pw"})
        self.assertEqual(resp.status, 404)

    def test_expired_invite_refused(self):
        token = self._mint("expired@test.local")
        # Force the invite into the past.
        self.fs.upsert_user("expired@test.local", {"invite_expires_at": 1})
        self.assertEqual(self.srv.get(f"/invite/{token}").status, 404)
        resp = self.srv.post("/api/invite",
                             json_body={"token": token, "password": "long-enough-pw"})
        self.assertEqual(resp.status, 409)

    def test_resend_invalidates_old_link(self):
        first = self._mint("resend@test.local")
        second = self._mint("resend@test.local")  # re-invite a pending account
        self.assertNotEqual(first, second)
        # The OLD link no longer works; the NEW one does.
        self.assertEqual(self.srv.get(f"/invite/{first}").status, 404)
        self.assertEqual(self.srv.get(f"/invite/{second}").status, 200)

    def test_active_account_cannot_be_re_invited_409(self):
        # ADMIN_EMAIL is active (real password): re-inviting it is refused.
        resp = self.srv.post("/api/admin/users", headers=self._admin(),
                             json_body={"email": ADMIN_EMAIL, "role": "admin"})
        self.assertEqual(resp.status, 409)

    def test_list_marks_pending(self):
        self._mint("listed@test.local")
        users = self.srv.get("/api/admin/users", headers=self._admin()).json()
        entry = next(u for u in users if u["email"] == "listed@test.local")
        self.assertTrue(entry["pending"])

    def test_accept_with_names_shows_them_in_admin_listing(self):
        # End-to-end name brick: invite → accept carrying first+last → the admin
        # users endpoint surfaces both halves (distinct fields).
        token = self._mint("named-invitee@test.local")
        accept = self.srv.post("/api/invite", json_body={
            "token": token, "password": "invitee-chosen-pw",
            "first_name": "Grace", "last_name": "Hopper"})
        self.assertEqual(accept.status, 200, accept.text)
        users = self.srv.get("/api/admin/users", headers=self._admin()).json()
        entry = next(u for u in users if u["email"] == "named-invitee@test.local")
        self.assertEqual(entry["first_name"], "Grace")
        self.assertEqual(entry["last_name"], "Hopper")
        self.assertFalse(entry["pending"])  # activated by the accept

    def test_accept_rejects_invalid_name(self):
        token = self._mint("badname@test.local")
        resp = self.srv.post("/api/invite", json_body={
            "token": token, "password": "invitee-chosen-pw",
            "first_name": "a\x00b"})
        self.assertEqual(resp.status, 400)
        # The account stays pending (the bad accept did not activate it).
        self.assertIsNotNone(
            self.fs.get_user_by_email("badname@test.local").get("invite_token_hash"))


class TestProfile(unittest.TestCase):
    """Self-service profile (/api/account/profile): a member reads and edits its
    OWN first/last name only — never another account's."""

    srv: AtlasServer

    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(extra_env=cloud_env())
        cls.srv.start()
        cls.fs = file_store_of(cls.srv)
        seed_admin_and_viewer(cls.fs)
        cls.viewer_cookie = session_cookie(cls.srv, VIEWER_EMAIL, VIEWER_PASSWORD)
        cls.viewer_csrf = csrf_token_for(cls.srv, cls.viewer_cookie)

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def _viewer(self):
        return {"Cookie": self.viewer_cookie, "X-CSRF-Token": self.viewer_csrf}

    def test_get_own_profile(self):
        # Dedicated name-less account so the assertion does not depend on the
        # mutations the other tests apply to the shared viewer record.
        self.fs.upsert_user("getme@test.local", {
            "password_hash": store.hash_password("getme-strong-pw"),
            "role": "viewer"})
        cookie = session_cookie(self.srv, "getme@test.local", "getme-strong-pw")
        resp = self.srv.get("/api/account/profile", headers={"Cookie": cookie})
        self.assertEqual(resp.status, 200)
        body = resp.json()
        self.assertEqual(body["email"], "getme@test.local")
        # Name-less by default → both halves empty, never absent keys.
        self.assertEqual(body["first_name"], "")
        self.assertEqual(body["last_name"], "")

    def test_post_updates_own_first_and_last(self):
        resp = self.srv.post("/api/account/profile", headers=self._viewer(),
                             json_body={"first_name": "Grace", "last_name": "Hopper"})
        self.assertEqual(resp.status, 200, resp.text)
        stored = self.fs.get_user_by_email(VIEWER_EMAIL)
        self.assertEqual(stored["first_name"], "Grace")
        self.assertEqual(stored["last_name"], "Hopper")
        body = self.srv.get("/api/account/profile",
                            headers={"Cookie": self.viewer_cookie}).json()
        self.assertEqual(body["first_name"], "Grace")
        self.assertEqual(body["last_name"], "Hopper")

    def test_post_clears_a_field_with_empty_string(self):
        self.fs.upsert_user(VIEWER_EMAIL, {"first_name": "X", "last_name": "Y"})
        resp = self.srv.post("/api/account/profile", headers=self._viewer(),
                             json_body={"first_name": ""})
        self.assertEqual(resp.status, 200)
        stored = self.fs.get_user_by_email(VIEWER_EMAIL)
        self.assertIsNone(stored.get("first_name"))
        self.assertEqual(stored.get("last_name"), "Y")  # untouched

    def test_post_rejects_invalid_name(self):
        resp = self.srv.post("/api/account/profile", headers=self._viewer(),
                             json_body={"first_name": "a\x00b"})
        self.assertEqual(resp.status, 400)
        self.assertIn("invalid first_name", resp.json()["error"])

    def test_cannot_set_another_accounts_name(self):
        # The route writes ONLY the session user's record: a target email in the
        # body is ignored, the admin's name is never touched.
        before = self.fs.get_user_by_email(ADMIN_EMAIL)
        resp = self.srv.post("/api/account/profile", headers=self._viewer(),
                             json_body={"email": ADMIN_EMAIL,
                                        "first_name": "Mallory",
                                        "last_name": "Intruder"})
        self.assertEqual(resp.status, 200)
        admin_after = self.fs.get_user_by_email(ADMIN_EMAIL)
        self.assertEqual(admin_after.get("first_name"), before.get("first_name"))
        self.assertEqual(admin_after.get("last_name"), before.get("last_name"))
        self.assertNotEqual(admin_after.get("first_name"), "Mallory")
        # The write landed on the CALLER (the viewer) instead.
        self.assertEqual(
            self.fs.get_user_by_email(VIEWER_EMAIL).get("first_name"), "Mallory")

    def test_profile_requires_auth(self):
        self.assertEqual(self.srv.get("/api/account/profile").status, 401)


class TestAdminTokens(unittest.TestCase):
    """API tokens via /api/tokens."""

    srv: AtlasServer

    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(extra_env=cloud_env())
        cls.srv.start()
        cls.fs = file_store_of(cls.srv)
        seed_admin_and_viewer(cls.fs)
        cls.admin_cookie = session_cookie(cls.srv, ADMIN_EMAIL, ADMIN_PASSWORD)
        cls.admin_csrf = csrf_token_for(cls.srv, cls.admin_cookie)
        cls.viewer_cookie = session_cookie(cls.srv, VIEWER_EMAIL, VIEWER_PASSWORD)

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def _admin(self):
        return {"Cookie": self.admin_cookie, "X-CSRF-Token": self.admin_csrf}

    def test_create_token_bearer_works_then_revoke_401(self):
        resp = self.srv.post("/api/tokens", headers=self._admin(),
                             json_body={"label": "claude"})
        self.assertEqual(resp.status, 201)
        body = resp.json()
        token = body["token"]
        self.assertEqual(len(token), 64)  # 32 bytes hex
        self.assertIn("/mcp/" + token, body["mcp_url"])
        self.assertEqual(body["label"], "claude")

        # Working Bearer on /api/v1/search.
        bearer = {"Authorization": f"Bearer {token}"}
        search = self.srv.get("/api/v1/search?q=alpha", headers=bearer)
        self.assertEqual(search.status, 200)

        # Revocation → 401.
        revoke = self.srv.delete("/api/tokens", headers=self._admin(),
                                 json_body={"label": "claude"})
        self.assertEqual(revoke.status, 200)
        after = self.srv.get("/api/v1/search?q=alpha", headers=bearer)
        self.assertEqual(after.status, 401)

    def test_list_tokens_no_secret(self):
        self.srv.post("/api/tokens", headers=self._admin(),
                      json_body={"label": "lister"})
        resp = self.srv.get("/api/tokens", headers=self._admin())
        self.assertEqual(resp.status, 200)
        identities = resp.json()
        entry = next(i for i in identities if i["label"] == "lister")
        self.assertTrue(entry["email"].endswith(".api.local"))  # per-owner namespaced
        self.assertEqual(entry["acts_as"], ADMIN_EMAIL)         # bound to its creator
        self.assertEqual(entry["role"], "api")
        # Neither cleartext token nor hash exposed.
        self.assertNotIn("token", entry)
        self.assertNotIn("api_token_hash", entry)
        self.assertNotIn("token_hash", entry)
        self.assertNotIn("api_token_hash", resp.text)

    def test_revoke_unknown_404(self):
        resp = self.srv.delete("/api/tokens", headers=self._admin(),
                               json_body={"label": "never-emitted"})
        self.assertEqual(resp.status, 404)

    def test_create_token_missing_label_400(self):
        resp = self.srv.post("/api/tokens", headers=self._admin(),
                             json_body={})
        self.assertEqual(resp.status, 400)

    def test_viewer_manages_only_own_tokens(self):
        # A member creates a token bound to THEMSELVES and sees only their own —
        # never the admin's (tokens are personal, no cross-account visibility).
        vh = {"Cookie": self.viewer_cookie,
              "X-CSRF-Token": csrf_token_for(self.srv, self.viewer_cookie)}
        create = self.srv.post("/api/tokens", headers=vh,
                               json_body={"label": "mine"})
        self.assertEqual(create.status, 201)
        self.assertEqual(create.json()["acts_as"], VIEWER_EMAIL)
        self.srv.post("/api/tokens", headers=self._admin(),
                      json_body={"label": "admins-token"})
        listing = self.srv.get("/api/tokens", headers=vh)
        self.assertEqual(listing.status, 200)
        labels = {t["label"] for t in listing.json()}
        self.assertIn("mine", labels)
        self.assertNotIn("admins-token", labels)


class TestAdminCsrf(unittest.TestCase):
    """Basic CSRF defense on mutating admin endpoints."""

    srv: AtlasServer

    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(extra_env=cloud_env())
        cls.srv.start()
        cls.fs = file_store_of(cls.srv)
        seed_admin_and_viewer(cls.fs)
        cls.admin_cookie = session_cookie(cls.srv, ADMIN_EMAIL, ADMIN_PASSWORD)
        cls.admin_csrf = csrf_token_for(cls.srv, cls.admin_cookie)

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def _admin(self):
        return {"Cookie": self.admin_cookie, "X-CSRF-Token": self.admin_csrf}

    def test_non_json_content_type_refused_415(self):
        # A cross-site HTML <form> only emits urlencoded: refused even with a
        # valid admin cookie (the browser would send it on a CSRF attack).
        resp = self.srv.post(
            "/api/admin/users",
            data=b"email=x@test.local&password=long-enough-pw&role=viewer",
            headers={**self._admin(),
                     "Content-Type": "application/x-www-form-urlencoded"})
        self.assertEqual(resp.status, 415)
        self.assertIsNone(self.fs.get_user_by_email("x@test.local"))

    def test_cross_origin_refused_403(self):
        resp = self.srv.post(
            "/api/admin/users",
            json_body={"email": "evil@test.local",
                       "password": "evil-strong-pw", "role": "admin"},
            headers={**self._admin(), "Origin": "https://evil.example.com"})
        self.assertEqual(resp.status, 403)
        self.assertIn("cross-origin", resp.json()["error"])
        self.assertIsNone(self.fs.get_user_by_email("evil@test.local"))

    def test_same_origin_accepted(self):
        host = self.srv.base_url.split("://", 1)[1]
        resp = self.srv.post(
            "/api/admin/users",
            json_body={"email": "ok-origin@test.local",
                       "password": "good-strong-pw", "role": "viewer"},
            headers={**self._admin(), "Origin": f"http://{host}"})
        self.assertEqual(resp.status, 201)

    def test_cross_origin_refused_on_token_delete(self):
        self.srv.post("/api/tokens", headers=self._admin(),
                      json_body={"label": "csrf-target"})
        resp = self.srv.delete(
            "/api/tokens",
            json_body={"label": "csrf-target"},
            headers={**self._admin(), "Referer": "https://evil.example.com/x"})
        self.assertEqual(resp.status, 403)
        # The token was NOT revoked.
        identities = self.srv.get("/api/tokens",
                                  headers=self._admin()).json()
        entry = next(i for i in identities if i["label"] == "csrf-target")
        self.assertFalse(entry["revoked"])


class TestAdminUiPanel(unittest.TestCase):
    """Frontend of batch 2c: the Settings panel is present in the built viewer
    (dist/index.html), bilingual (fr AND en keys in the single STRINGS), and its
    entry point only appears in an admin+cloud context.

    We read dist/index.html from disk (like test_branding): the viewer's markup
    and STRINGS are independent of auth — no session is needed to check they
    were emitted."""

    srv: AtlasServer

    @classmethod
    def setUpClass(cls):
        # Local mode is enough: the panel lives in the template, the build is the
        # same. (The admin-cloud runtime gating is checked on the CSS/JS side below.)
        cls.srv = AtlasServer()
        cls.srv.start()
        cls.index = (cls.srv.dist_dir / "index.html").read_text(encoding="utf-8")

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def test_baked_tree_not_indexed_in_server_mode(self):
        # ACL: the baked FULL tree is indexed into fileMap ONLY in the offline
        # build (IS_OFFLINE_BUILD). In server mode that boot-time index would leak
        # private doc names + the total count through every fileMap consumer
        # (Recent, search, the Mind, stats) BEFORE the per-account filtered
        # softReload(). Gated on IS_OFFLINE_BUILD, not the protocol — a static
        # offline build is served over https on Pages. Mirrors 02-content-tree.js.
        self.assertIn(
            "if (IS_OFFLINE_BUILD) {\n  index(TREE);",
            self.index)
        # softReload still rebuilds fileMap from the FILTERED /api/tree.
        self.assertRegex(self.index, r"await fetch\([\"']/api/tree[\"']\)")  # quote-agnostic: esbuild re-quotes the .ts literal

    def test_settings_panel_markup_present(self):
        # Panel container + its three tabs + the gear entry point.
        self.assertIn('id="settings-backdrop"', self.index)
        self.assertIn('id="settings-panel"', self.index)
        self.assertIn('id="settings-btn"', self.index)
        # Batch 2d: a fourth "Security" tab (2FA + sessions) is added.
        for tab in ("users", "tokens", "shares", "security"):
            self.assertIn(f'data-tab="{tab}"', self.index)
        # The corresponding panes.
        for pane in ("users", "tokens", "shares", "security"):
            self.assertIn(f'id="settings-pane-{pane}"', self.index)

    def test_settings_token_one_time_display_present(self):
        # One-time display of the cleartext token + MCP connector URL.
        self.assertIn('id="settings-token-result"', self.index)
        self.assertIn('id="settings-token-plain"', self.index)
        self.assertIn('id="settings-token-mcp"', self.index)
        self.assertIn('data-i18n="settingsTokenOnce"', self.index)
        self.assertIn('data-i18n="settingsMcpUrl"', self.index)

    def test_settings_i18n_keys_in_both_languages(self):
        # The viewer's STRINGS embeds fr AND en: both labels of the tabs (and
        # of the title) must be present in the same file.
        for fr_value in ("settingsTitle: 'Paramètres'",
                         "settingsTabUsers: 'Utilisateurs'",
                         "settingsTabTokens: 'Tokens'",
                         "settingsTabShares: 'Partages'"):
            _assert_i18n(self, self.index, fr_value)
        for en_value in ("settingsTitle: 'Settings'",
                         "settingsTabUsers: 'Users'",
                         "settingsTabShares: 'Shares'",
                         "settingsMcpUrl: 'MCP connector URL'"):
            _assert_i18n(self, self.index, en_value)

    def test_settings_entry_point_gated_on_admin_cloud(self):
        # Batch 2d change: the gear is now revealed for ANY authenticated account
        # in cloud mode (body.cloud-authed class) — a reader finds the Security
        # tab there (their 2FA + their sessions). The administration tabs stay
        # reserved for the admin (body.admin-cloud).
        self.assertIn('id="settings-btn"', self.index)
        self.assertIn("body.cloud-authed #settings-btn", self.index)
        self.assertRegex(self.index, r"classList\.add\([\"']cloud-authed[\"']\)")
        # body.admin-cloud stays set to manage the visibility of admin tabs.
        self.assertRegex(self.index, r"classList\.add\([\"']admin-cloud[\"']\)")
        self.assertRegex(self.index, r"data\.role === [\"']admin[\"']")
        # Admin-only tabs stay hidden outside admin-cloud — a member must not see a tab
        # it cannot use (e.g. Groups, whose /api/admin/groups is admin-gated).
        for tab in ("users", "nodes", "groups", "shares"):
            self.assertIn(
                'body:not(.admin-cloud) .settings-tab[data-tab="%s"]' % tab,
                self.index)
        # Tokens is per-account (a member manages their own) → gated on cloud-auth, not
        # admin, like the Profile tab.
        self.assertIn(
            'body:not(.cloud-authed) .settings-tab[data-tab="tokens"]', self.index)

    def test_settings_uses_admin_endpoints_via_fetch(self):
        # The panel talks to the admin endpoints (no CLI-only logic).
        self.assertIn("/api/admin/users", self.index)
        self.assertIn("/api/admin/users/password", self.index)
        self.assertIn("/api/tokens", self.index)
        self.assertIn("/api/share/list", self.index)

    def test_settings_panel_is_mobile_responsive(self):
        # Fullscreen on mobile: the media query rule targets #settings-panel.
        self.assertIn("#settings-panel {", self.index)
        # Only one mobile media query in the viewer; the fullscreen rule lives there.
        mobile_block = self.index.split("@media (max-width: 767px)", 1)[1]
        self.assertIn("#settings-panel", mobile_block)

    def test_no_native_prompt_in_admin_viewer(self):
        # Anti-regression guard from the UX batch: password reset used to go
        # through a native window.prompt(). No native prompt must remain in the
        # built viewer (an in-app modal instead).
        self.assertNotIn("window.prompt", self.index)

    def test_reset_password_modal_markup_present(self):
        # The in-app reset modal replaces the native prompt: field + confirmation
        # field, show/hide toggle, role=dialog, success feedback.
        self.assertIn('id="reset-pw-backdrop"', self.index)
        self.assertIn('role="dialog"', self.index)
        self.assertIn('id="reset-pw-input"', self.index)
        self.assertIn('id="reset-pw-confirm"', self.index)
        self.assertIn('id="reset-pw-toggle"', self.index)
        self.assertIn('id="reset-pw-success"', self.index)
        # The "Reset" click handler opens the modal (no more prompt).
        self.assertIn("openResetPassword(", self.index)

    def test_reset_password_i18n_keys_in_both_languages(self):
        # Every added label is bilingual (fr AND en in the single STRINGS).
        for fr_value in ("settingsConfirmPasswordLabel: 'Confirmer le mot de passe'",
                         "settingsPasswordMismatch:",
                         "settingsPasswordUpdated: 'Mot de passe mis à jour.'"):
            _assert_i18n(self, self.index, fr_value)
        for en_value in ("settingsConfirmPasswordLabel: 'Confirm password'",
                         "settingsPasswordMismatch:",
                         "settingsPasswordUpdated: 'Password updated.'"):
            _assert_i18n(self, self.index, en_value)

    def test_token_reveal_has_close_and_warning(self):
        # The one-time token reveal: strong warning + Close button + the secret
        # is purged from the DOM when hidden (SettingsTokens.hideResult).
        self.assertIn('id="settings-token-close"', self.index)
        self.assertIn("hideResult(", self.index)
        self.assertIn("token-warning-text", self.index)


class TestSecurityUi(unittest.TestCase):
    """Frontend of the auth hardening (batch 2d): Security tab (2FA + sessions),
    in-app 2FA modal with a client-side rendered QR (no external lib), CSRF token
    wiring on all mutating requests, zero native dialogs. We read the built
    viewer (dist/index.html) — markup and JS independent of auth."""

    srv: AtlasServer

    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer()
        cls.srv.start()
        cls.index = (cls.srv.dist_dir / "index.html").read_text(encoding="utf-8")

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def test_security_pane_and_actions_present(self):
        # Security tab + pane, 2FA status, enable/disable buttons, sign out of
        # all sessions.
        self.assertIn('data-tab="security"', self.index)
        self.assertIn('id="settings-pane-security"', self.index)
        self.assertIn('id="security-totp-status"', self.index)
        self.assertIn('id="security-totp-enable"', self.index)
        self.assertIn('id="security-totp-disable"', self.index)
        self.assertIn('id="security-logout-all"', self.index)

    def test_totp_modal_markup_present(self):
        # In-app 2FA modal: QR, copyable secret, verification code, recovery
        # codes shown once, disable step.
        self.assertIn('id="totp-backdrop"', self.index)
        self.assertIn('id="totp-qr"', self.index)
        self.assertIn('id="totp-secret-value"', self.index)
        self.assertIn('id="totp-verify-code"', self.index)
        self.assertIn('id="totp-recovery-list"', self.index)
        self.assertIn('id="totp-disable-code"', self.index)

    def test_account_endpoints_wired(self):
        # The frontend talks to the three account routes of batch 2d.
        self.assertIn('/api/account/totp/init', self.index)
        self.assertIn('/api/account/totp/enable', self.index)
        self.assertIn('/api/account/totp/disable', self.index)
        self.assertIn('/api/account/logout-all', self.index)

    def test_csrf_token_wired_into_fetch(self):
        # The CSRF token is read (kb_csrf cookie + /api/me csrf_token) and set as
        # the X-CSRF-Token header on mutating requests via a fetch wrapper.
        self.assertIn('X-CSRF-Token', self.index)
        self.assertIn('kb_csrf', self.index)
        self.assertIn('csrf_token', self.index)
        # The wrapper wraps window.fetch (centralized wiring, not scattered).
        self.assertIn('window.fetch =', self.index)

    def test_qr_generator_is_self_contained(self):
        # QR rendered client-side WITHOUT an external lib (Reed-Solomon +
        # homemade mask): no CDN dependency, the QR code lives in the viewer.
        self.assertIn('Gf256', self.index)  # the homemade GF(256) Reed-Solomon field
        self.assertIn('rsEncode', self.index)
        # No QR via a third-party lib/CDN.
        self.assertNotIn('qrcode.min.js', self.index)
        self.assertNotIn('cdn.', self.index.split('Gf256')[1][:6000])

    def test_no_native_dialogs_for_security_actions(self):
        # logout-all and the confirmations go through the in-app confirmDialog,
        # not through native confirm()/alert()/prompt().
        self.assertNotIn('window.confirm', self.index)
        self.assertNotIn('window.alert', self.index)
        self.assertNotIn('window.prompt', self.index)
        self.assertIn('confirmDialog(', self.index)

    def test_security_i18n_keys_in_both_languages(self):
        for fr_value in ("settingsTabProfile: 'Profil'",
                         "securityTotpEnable: 'Activer le 2FA'",
                         "securityLogoutAll: 'Déconnecter toutes mes sessions'",
                         "totpRecoveryWarn:"):
            _assert_i18n(self, self.index, fr_value)
        for en_value in ("settingsTabProfile: 'Profile'",
                         "securityTotpEnable: 'Enable 2FA'",
                         "securityLogoutAll: 'Sign out all my sessions'",
                         "totpRecoveryWarn:"):
            _assert_i18n(self, self.index, en_value)


class TestLoginPageTwoStepUi(unittest.TestCase):
    """Server-rendered /login page: 2-step flow (password then second factor
    TOTP / recovery code), bilingual, JS-driven JSON submission with a form
    fallback."""

    def test_login_page_has_two_step_markup(self):
        with AtlasServer(extra_env=cloud_env()) as srv:
            seed_admin_and_viewer(file_store_of(srv))
            page = srv.get("/login")
            self.assertEqual(page.status, 200)
            html = page.text
            # Step 1 (credentials) + step 2 (TOTP) + recovery step.
            self.assertIn('id="login-step-credentials"', html)
            self.assertIn('id="login-step-totp"', html)
            self.assertIn('id="login-step-recovery"', html)
            self.assertIn('id="login-totp-code"', html)
            self.assertIn('id="login-recovery-code"', html)
            # The "use a recovery code" link.
            self.assertIn('id="login-to-recovery"', html)
            # JS-driven JSON submission (reads totp_required from the backend).
            self.assertIn('totp_required', html)
            self.assertIn('submitLogin', html)
            # Step 2 subtitle (EN by default).
            self.assertIn('Two-step verification', html)


class TestSetupPageUi(unittest.TestCase):
    """Redesign of the /setup page (first boot): polished card, labelled fields,
    explanation of the setup-token, bilingual. We check the HTML served by
    /setup (French by default)."""

    def test_setup_page_has_labelled_fields_and_token_help(self):
        with AtlasServer(extra_env=cloud_env()) as srv:
            wait_for_setup_token(srv)
            page = srv.get("/setup")
            self.assertEqual(page.status, 200)
            html = page.text
            # Labelled fields (each input has a <label for=…>).
            self.assertIn('for="setup-token"', html)
            self.assertIn('for="setup-email"', html)
            self.assertIn('for="setup-password"', html)
            # Explanation of where to find the token (server logs).
            self.assertIn("Atlas setup token", html)
            # Atlas wordmark + JSON submission preserved.
            self.assertIn("atlas", html.lower())
            self.assertIn("/api/setup", html)


class TestLastAdminConcurrency(unittest.TestCase):
    """Targeted repro of the batch 2c TOCTOU: two concurrent deletions of the
    LAST TWO admins must NEVER leave zero admins (total lockout).

    At the store level (not HTTP) to target exactly the count→delete window on a
    fresh FileStore with exactly 2 admins — the only case where the race can
    actually lead to a lockout."""

    def _fresh_store(self, tmp):
        fs = store.FileStore(Path(tmp) / ".atlas")
        for name in ("admin-a@x.local", "admin-b@x.local"):
            fs.upsert_user(name, {
                "password_hash": store.hash_password("strong-admin-pw"),
                "role": "admin",
            })
        return fs

    def test_two_concurrent_deletes_never_zero_admin(self):
        import tempfile
        import threading
        for _ in range(20):  # barrier + repetitions: we force the race
            with tempfile.TemporaryDirectory() as tmp:
                fs = self._fresh_store(tmp)
                self.assertEqual(fs.count_admins(), 2)
                barrier = threading.Barrier(2)
                refused = []

                def attempt(email):
                    barrier.wait()
                    try:
                        fs.delete_user(email, protect_last_admin=True)
                    except store.LastAdminError:
                        refused.append(email)

                threads = [threading.Thread(target=attempt, args=(e,))
                           for e in ("admin-a@x.local", "admin-b@x.local")]
                for thread in threads:
                    thread.start()
                for thread in threads:
                    thread.join()

                # Hard invariant: there is ALWAYS at least one admin left.
                self.assertGreaterEqual(
                    fs.count_admins(), 1,
                    f"lockout: zero admin after race (refused={refused})")


class TestUpdateCheck(unittest.TestCase):
    """Admin update-available endpoint: admin-gated, opt-out, and no network
    when disabled (the tests never hit PyPI)."""

    def test_requires_admin(self):
        with AtlasServer(extra_env=cloud_env()) as srv:
            seed_admin_and_viewer(file_store_of(srv))
            r = srv.get("/api/admin/update-check")  # no cookie
            self.assertIn(r.status, (401, 403))

    def test_disabled_returns_no_update_without_network(self):
        env = cloud_env()
        env["ATLAS_UPDATE_CHECK"] = "0"
        with AtlasServer(extra_env=env) as srv:
            seed_admin_and_viewer(file_store_of(srv))
            cookie = session_cookie(srv, ADMIN_EMAIL, ADMIN_PASSWORD)
            r = srv.get("/api/admin/update-check", headers={"Cookie": cookie})
            self.assertEqual(r.status, 200, r.body)
            body = r.json()
            self.assertFalse(body["update_available"])
            self.assertTrue(body.get("disabled"))
            self.assertTrue(body["current"])  # running version is reported

    def test_version_compare_is_numeric(self):
        import server
        self.assertTrue(server._is_newer("0.1.10", "0.1.9"))   # numeric, not lexicographic
        self.assertTrue(server._is_newer("0.2.0", "0.1.9"))
        self.assertFalse(server._is_newer("0.1.4", "0.1.4"))
        self.assertFalse(server._is_newer("0.1.3", "0.1.4"))
        self.assertFalse(server._is_newer(None, "0.1.4"))


class TestRateLimitEviction(unittest.TestCase):
    """The rate-limit dicts must shed fully-expired keys (no unbounded growth)."""

    def test_evict_stale_buckets_keeps_only_active(self):
        import time
        import server
        now = time.time()
        buckets = {
            "active": [now],                       # in window → keep
            "stale": [now - 120],                  # all older than cutoff → drop
            "empty": [],                           # nothing left → drop
            "expired-multi": [now - 90, now - 70],  # newest still < cutoff → drop
        }
        server._evict_stale_buckets(buckets, now - 60)
        self.assertEqual(set(buckets), {"active"})


if __name__ == "__main__":
    unittest.main()
