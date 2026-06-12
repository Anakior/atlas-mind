"""Auth hardening in cloud mode (batch 2d).

Covers:
- FIX for the 0x2e session-cookie bug (forging cookies whose signature contains
  a 0x2e -> now accepted; no self-invalidating cookie).
- Bounded-lifetime cookie (CONFIG.session_max_age): an expired cookie is rejected.
- Server-side revocable sessions via the session epoch:
  POST /api/account/logout-all bumps the epoch -> old cookies 401; an (admin)
  password reset also invalidates the old sessions.
- TOTP 2FA: enrollment (init->enable), two-step login, wrong code refused,
  single-use recovery code consumed (replay refused), disabling.
- Per-account lockout: N failures -> temporary lock; one success resets it.
- CSRF synchronizer: a mutating POST without X-CSRF-Token -> 403; with the right
  token -> OK; a token from another session refused.

Cloud harness (KB_AUTH_ENABLED=1, ATLAS_STORE=file) identical to test_admin /
test_cloud_filestore: file registry seeded directly via a FileStore pointed at
srv.root/.atlas.
"""
import base64
import hashlib
import hmac
import json
import struct
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

from harness import AtlasServer

REPO_SRC = Path(__file__).resolve().parent.parent / "src"
if str(REPO_SRC) not in sys.path:
    sys.path.insert(0, str(REPO_SRC))

import store  # noqa: E402

SESSION_SECRET = "atlas-test-hardening-secret-0123456789abcdef"

ADMIN_EMAIL = "admin@test.local"
ADMIN_PASSWORD = "correct-horse-battery"
VIEWER_EMAIL = "viewer@test.local"
VIEWER_PASSWORD = "viewer-password-42"

TOTP_STEP_SECONDS = 30
TOTP_DIGITS = 6


def cloud_env(**overrides) -> dict:
    env = {
        "KB_AUTH_ENABLED": "1",
        "SESSION_SECRET": SESSION_SECRET,
        "KB_REPO_PATH": "{root}",
        "ATLAS_STORE": "file",
        "GIT_PULL_INTERVAL": "3600",
    }
    env.update(overrides)
    return env


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


def login(srv: AtlasServer, email: str, password: str, **fields):
    body = {"email": email, "password": password}
    body.update(fields)
    return srv.post("/login", json_body=body)


def session_cookie(srv: AtlasServer, email: str, password: str) -> str:
    """Valid kb_session Cookie header (0x2e bug fixed: a single login)."""
    resp = login(srv, email, password)
    assert resp.status == 303, f"login {email}: {resp.status}"
    cookie = (resp.headers.get("Set-Cookie") or "").split(";", 1)[0]
    me = srv.get("/api/me", headers={"Cookie": cookie}).json()
    assert me.get("authenticated"), f"invalid cookie for {email}"
    return cookie


def me_of(srv: AtlasServer, cookie: str) -> dict:
    return srv.get("/api/me", headers={"Cookie": cookie}).json()


def auth_headers(srv: AtlasServer, cookie: str) -> dict:
    """Cookie + X-CSRF-Token: everything needed for a mutating request."""
    csrf = me_of(srv, cookie)["csrf_token"]
    return {"Cookie": cookie, "X-CSRF-Token": csrf}


# ── crypto helpers (server replicas, identical secret/algorithms) ──────────────


def mint_session_token(email: str, role: str, ts: int, epoch: int = 0) -> str:
    """Replica of make_token() AFTER the 0x2e fix: base64url(payload) + '.' +
    base64url(sig), padding stripped."""
    payload = json.dumps(
        {"email": email, "role": role, "ep": epoch, "ts": ts}).encode()
    sig = hmac.new(SESSION_SECRET.encode(), payload, hashlib.sha256).digest()
    return (base64.urlsafe_b64encode(payload).decode().rstrip("=")
            + "." + base64.urlsafe_b64encode(sig).decode().rstrip("="))


def mint_session_token_with_raw_sig(email: str, role: str):
    """Finds a ts whose RAW SIGNATURE contains a 0x2e byte ('.'): the case that
    broke the old rsplit. Returns (token, ts)."""
    now = int(time.time())
    for ts in range(now, now + 5000):
        payload = json.dumps(
            {"email": email, "role": role, "ep": 0, "ts": ts}).encode()
        sig = hmac.new(SESSION_SECRET.encode(), payload, hashlib.sha256).digest()
        if b"." in sig:
            token = (base64.urlsafe_b64encode(payload).decode().rstrip("=")
                     + "." + base64.urlsafe_b64encode(sig).decode().rstrip("="))
            return token, ts
    raise AssertionError("no ts with a signature containing 0x2e")


def totp_code(secret_b32: str, at: int = None) -> str:
    """Generates the current TOTP code for a base32 secret (without padding)."""
    if at is None:
        at = int(time.time())
    padded = secret_b32.strip().upper()
    padded += "=" * (-len(padded) % 8)
    secret_bytes = base64.b32decode(padded)
    counter = at // TOTP_STEP_SECONDS
    cb = struct.pack(">Q", counter)
    digest = hmac.new(secret_bytes, cb, hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    binary = ((digest[offset] & 0x7F) << 24
              | (digest[offset + 1] & 0xFF) << 16
              | (digest[offset + 2] & 0xFF) << 8
              | (digest[offset + 3] & 0xFF))
    return str(binary % (10 ** TOTP_DIGITS)).zfill(TOTP_DIGITS)


# ─── 0x2e cookie fix ────────────────────────────────────────────────────────


class TestCookieDotFix(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(extra_env=cloud_env())
        cls.srv.start()
        seed_admin_and_viewer(file_store_of(cls.srv))

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def test_cookie_with_dot_in_raw_sig_is_accepted(self):
        token, _ = mint_session_token_with_raw_sig(ADMIN_EMAIL, "admin")
        me = me_of(self.srv, f"kb_session={token}")
        self.assertTrue(me["authenticated"],
                        "the 0x2e fix must accept this cookie")

    def test_no_self_invalidation_over_many_timestamps(self):
        now = int(time.time())
        rejected = 0
        with_dot = 0
        for ts in range(now, now + 200):
            payload = json.dumps(
                {"email": ADMIN_EMAIL, "role": "admin", "ep": 0, "ts": ts}).encode()
            sig = hmac.new(SESSION_SECRET.encode(), payload, hashlib.sha256).digest()
            if b"." in sig:
                with_dot += 1
            token = mint_session_token(ADMIN_EMAIL, "admin", ts)
            if not me_of(self.srv, f"kb_session={token}")["authenticated"]:
                rejected += 1
        self.assertEqual(rejected, 0, f"{rejected} self-invalidating cookies")
        self.assertGreaterEqual(with_dot, 5, "sample does not cover the 0x2e")

    def test_share_tokens_unaffected(self):
        # Share tokens (make_share_token) keep their format: admin sharing must
        # still produce a servable link.
        headers = auth_headers(self.srv, session_cookie(
            self.srv, ADMIN_EMAIL, ADMIN_PASSWORD))
        resp = self.srv.post("/api/share", headers=headers,
                             json_body={"path": "accueil.md"})
        self.assertEqual(resp.status, 200)
        token = resp.json()["token"]
        served = self.srv.get(f"/share/{token}")
        self.assertEqual(served.status, 200)


# ─── expired cookie ─────────────────────────────────────────────────────────


class TestCookieExpiry(unittest.TestCase):
    def test_expired_cookie_rejected(self):
        # session_max_age deliberately short (2 s): a cookie dated well before
        # must be rejected.
        with AtlasServer(extra_env=cloud_env(SESSION_MAX_AGE="2")) as srv:
            seed_admin_and_viewer(file_store_of(srv))
            old_ts = int(time.time()) - 3600
            token = mint_session_token(ADMIN_EMAIL, "admin", old_ts)
            me = me_of(srv, f"kb_session={token}")
            self.assertFalse(me["authenticated"])
            # A fresh cookie (current ts) passes.
            fresh = mint_session_token(ADMIN_EMAIL, "admin", int(time.time()))
            self.assertTrue(me_of(srv, f"kb_session={fresh}")["authenticated"])


# ─── revocation: session epoch ──────────────────────────────────────────────


class TestSessionRevocation(unittest.TestCase):
    def setUp(self):
        self.srv = AtlasServer(extra_env=cloud_env())
        self.srv.start()
        self.fs = file_store_of(self.srv)
        seed_admin_and_viewer(self.fs)

    def tearDown(self):
        self.srv.stop()

    def test_logout_all_invalidates_existing_cookie(self):
        cookie = session_cookie(self.srv, ADMIN_EMAIL, ADMIN_PASSWORD)
        self.assertTrue(me_of(self.srv, cookie)["authenticated"])
        headers = auth_headers(self.srv, cookie)
        resp = self.srv.post("/api/account/logout-all", headers=headers,
                             json_body={})
        self.assertEqual(resp.status, 200)
        # The old cookie is now worthless.
        self.assertFalse(me_of(self.srv, cookie)["authenticated"])
        # But a fresh login works.
        new_cookie = session_cookie(self.srv, ADMIN_EMAIL, ADMIN_PASSWORD)
        self.assertTrue(me_of(self.srv, new_cookie)["authenticated"])

    def test_logout_all_requires_csrf(self):
        cookie = session_cookie(self.srv, ADMIN_EMAIL, ADMIN_PASSWORD)
        resp = self.srv.post("/api/account/logout-all",
                             headers={"Cookie": cookie}, json_body={})
        self.assertEqual(resp.status, 403)
        # Without CSRF, the session stays valid.
        self.assertTrue(me_of(self.srv, cookie)["authenticated"])

    def test_password_reset_invalidates_old_sessions(self):
        victim = "victim@test.local"
        self.fs.upsert_user(victim, {
            "password_hash": store.hash_password("old-strong-pw"),
            "role": "viewer",
        })
        stolen = session_cookie(self.srv, victim, "old-strong-pw")
        self.assertTrue(me_of(self.srv, stolen)["authenticated"])
        # An admin resets the password (compromised account).
        admin_headers = auth_headers(self.srv, session_cookie(
            self.srv, ADMIN_EMAIL, ADMIN_PASSWORD))
        resp = self.srv.post("/api/admin/users/password", headers=admin_headers,
                             json_body={"email": victim,
                                        "password": "brand-new-pw-123"})
        self.assertEqual(resp.status, 200)
        # The stolen cookie is now invalid.
        self.assertFalse(me_of(self.srv, stolen)["authenticated"])


# ─── 2FA TOTP ───────────────────────────────────────────────────────────────


class TestTotp(unittest.TestCase):
    def setUp(self):
        self.srv = AtlasServer(extra_env=cloud_env())
        self.srv.start()
        self.fs = file_store_of(self.srv)
        seed_admin_and_viewer(self.fs)
        self.cookie = session_cookie(self.srv, ADMIN_EMAIL, ADMIN_PASSWORD)

    def tearDown(self):
        self.srv.stop()

    def _enroll(self):
        """init -> enable: returns (secret, recovery_codes)."""
        headers = auth_headers(self.srv, self.cookie)
        init = self.srv.post("/api/account/totp/init", headers=headers,
                             json_body={})
        self.assertEqual(init.status, 200)
        secret = init.json()["secret"]
        self.assertTrue(init.json()["otpauth_uri"].startswith("otpauth://totp/"))
        # enable bumps the epoch -> we must take the NEW cookies from the
        # response to keep acting with a valid session.
        enable = self.srv.post("/api/account/totp/enable", headers=headers,
                               json_body={"code": totp_code(secret)})
        self.assertEqual(enable.status, 200)
        codes = enable.json()["recovery_codes"]
        self.assertGreaterEqual(len(codes), 8)
        # Retrieve the new session cookie set by enable.
        for sc in enable.headers.get_all("Set-Cookie"):
            if sc.startswith("kb_session="):
                self.cookie = sc.split(";", 1)[0]
        return secret, codes

    def test_enroll_and_two_step_login(self):
        secret, _ = self._enroll()
        # Login without a 2nd factor: no cookie, totp_required signal. The
        # password was correct -- this is NOT an auth failure but a progress
        # signal, hence 200 (and not 401, which would spawn a console.error
        # "Failed to load resource: 401" on the browser side).
        resp = login(self.srv, ADMIN_EMAIL, ADMIN_PASSWORD)
        self.assertEqual(resp.status, 200)
        self.assertTrue(resp.json().get("totp_required"))
        self.assertIsNone(resp.headers.get("Set-Cookie"))
        # Login with the right code: 303 + cookie.
        resp = login(self.srv, ADMIN_EMAIL, ADMIN_PASSWORD,
                     totp_code=totp_code(secret))
        self.assertEqual(resp.status, 303)
        cookie = (resp.headers.get("Set-Cookie") or "").split(";", 1)[0]
        self.assertTrue(me_of(self.srv, cookie)["authenticated"])

    def test_wrong_totp_code_refused(self):
        self._enroll()
        resp = login(self.srv, ADMIN_EMAIL, ADMIN_PASSWORD, totp_code="000000")
        self.assertEqual(resp.status, 401)
        self.assertIsNone(resp.headers.get("Set-Cookie"))

    def test_totp_code_not_replayable(self):
        # Anti-replay: a valid code, used a second time within its window, is
        # refused (the accepted step is remembered per account).
        secret, _ = self._enroll()
        at = int(time.time())
        code = totp_code(secret, at)
        first = login(self.srv, ADMIN_EMAIL, ADMIN_PASSWORD, totp_code=code)
        self.assertEqual(first.status, 303)
        replay = login(self.srv, ADMIN_EMAIL, ADMIN_PASSWORD, totp_code=code)
        self.assertEqual(replay.status, 401)
        self.assertIsNone(replay.headers.get("Set-Cookie"))

    def test_recovery_code_single_use(self):
        _, codes = self._enroll()
        code = codes[0]
        # 1st use: OK.
        resp = login(self.srv, ADMIN_EMAIL, ADMIN_PASSWORD, recovery_code=code)
        self.assertEqual(resp.status, 303)
        # Replay of the SAME code: refused (consumed).
        replay = login(self.srv, ADMIN_EMAIL, ADMIN_PASSWORD, recovery_code=code)
        self.assertEqual(replay.status, 401)
        self.assertIsNone(replay.headers.get("Set-Cookie"))
        # ANOTHER recovery code still works.
        other = login(self.srv, ADMIN_EMAIL, ADMIN_PASSWORD,
                      recovery_code=codes[1])
        self.assertEqual(other.status, 303)

    def test_enable_requires_valid_code(self):
        headers = auth_headers(self.srv, self.cookie)
        self.srv.post("/api/account/totp/init", headers=headers, json_body={})
        bad = self.srv.post("/api/account/totp/enable", headers=headers,
                            json_body={"code": "000000"})
        self.assertEqual(bad.status, 400)
        # 2FA is NOT enabled: password-only login still works.
        self.assertEqual(login(self.srv, ADMIN_EMAIL, ADMIN_PASSWORD).status, 303)

    def test_disable_with_totp_code(self):
        secret, _ = self._enroll()
        headers = auth_headers(self.srv, self.cookie)
        resp = self.srv.post("/api/account/totp/disable", headers=headers,
                             json_body={"code": totp_code(secret)})
        self.assertEqual(resp.status, 200)
        # 2FA disabled: password-only login is enough again.
        self.assertEqual(login(self.srv, ADMIN_EMAIL, ADMIN_PASSWORD).status, 303)

    def test_me_reports_totp_state(self):
        self.assertFalse(me_of(self.srv, self.cookie)["totp_enabled"])
        self._enroll()
        self.assertTrue(me_of(self.srv, self.cookie)["totp_enabled"])


# ─── per-account lockout ────────────────────────────────────────────────────


class TestAccountLockout(unittest.TestCase):
    def setUp(self):
        self.srv = AtlasServer(extra_env=cloud_env())
        self.srv.start()
        self.fs = file_store_of(self.srv)
        seed_admin_and_viewer(self.fs)

    def tearDown(self):
        self.srv.stop()

    def test_lockout_after_threshold_blocks_even_good_password(self):
        # 5 password failures on an EXISTING account -> lock (429-locked). The IP
        # rate-limit is 10/min, so the account lock (threshold 5) strikes BEFORE
        # the IP rate-limit: we tell them apart by the locked flag.
        locked_seen = False
        for _ in range(6):
            resp = login(self.srv, ADMIN_EMAIL, "mauvais-mot-de-passe")
            if resp.status == 429 and resp.json().get("locked"):
                locked_seen = True
                break
        self.assertTrue(locked_seen, "the account should have locked")
        # Even with the RIGHT password, the locked account is refused.
        good = login(self.srv, ADMIN_EMAIL, ADMIN_PASSWORD)
        self.assertEqual(good.status, 429)
        self.assertTrue(good.json().get("locked"))

    def test_unknown_email_does_not_lock(self):
        # An unknown email accumulates no counter (no state that swells, no lock
        # on an arbitrary account). Over 8 attempts (< IP rate-limit of 10)
        # everything stays 401: never a 429-locked (the account lock only affects
        # EXISTING accounts).
        for _ in range(8):
            resp = login(self.srv, "inconnu@test.local", "peu-importe")
            self.assertEqual(resp.status, 401,
                             "an unknown email must not lock")

    def test_lockout_resets_after_successful_login(self):
        # 4 failures (< threshold 5) then a success: the counter drops back to
        # zero, so a new burst of 4 failures still does not lock.
        for _ in range(4):
            self.assertEqual(login(self.srv, VIEWER_EMAIL, "faux").status, 401)
        self.assertEqual(login(self.srv, VIEWER_EMAIL, VIEWER_PASSWORD).status, 303)
        for _ in range(4):
            resp = login(self.srv, VIEWER_EMAIL, "faux")
            self.assertEqual(resp.status, 401,
                             "the success should have reset the counter")

    def test_lockout_logs_fail2ban_line(self):
        login(self.srv, ADMIN_EMAIL, "encore-faux")
        time.sleep(0.2)
        log = self.srv.read_log()
        self.assertRegex(log, r"auth fail email=admin@test\.local ip=\S+ count=\d+")
        # No password must ever appear in the logs.
        self.assertNotIn("encore-faux", log)


# ─── CSRF synchronizer ──────────────────────────────────────────────────────


class TestCsrfSynchronizer(unittest.TestCase):
    # setUp per test (not setUpClass): some tests bump the session epoch
    # (logout-all), which would invalidate an admin cookie shared across tests.
    def setUp(self):
        self.srv = AtlasServer(extra_env=cloud_env())
        self.srv.start()
        self.fs = file_store_of(self.srv)
        seed_admin_and_viewer(self.fs)
        self.admin_cookie = session_cookie(self.srv, ADMIN_EMAIL, ADMIN_PASSWORD)

    def tearDown(self):
        self.srv.stop()

    def test_mutation_without_csrf_header_refused(self):
        resp = self.srv.post("/api/admin/users",
                             headers={"Cookie": self.admin_cookie},
                             json_body={"email": "nocsrf@test.local",
                                        "password": "strong-enough-pw",
                                        "role": "viewer"})
        self.assertEqual(resp.status, 403)
        self.assertIn("CSRF", resp.json()["error"])
        self.assertIsNone(self.fs.get_user_by_email("nocsrf@test.local"))

    def test_mutation_with_csrf_header_accepted(self):
        headers = auth_headers(self.srv, self.admin_cookie)
        resp = self.srv.post("/api/admin/users", headers=headers,
                             json_body={"email": "withcsrf@test.local",
                                        "password": "strong-enough-pw",
                                        "role": "viewer"})
        self.assertEqual(resp.status, 201)

    def test_csrf_token_of_another_session_refused(self):
        # The CSRF token of ANOTHER account (viewer) must not validate a mutation
        # made with the admin cookie (token bound to email|epoch).
        viewer_cookie = session_cookie(self.srv, VIEWER_EMAIL, VIEWER_PASSWORD)
        viewer_csrf = me_of(self.srv, viewer_cookie)["csrf_token"]
        resp = self.srv.post("/api/admin/users",
                             headers={"Cookie": self.admin_cookie,
                                      "X-CSRF-Token": viewer_csrf},
                             json_body={"email": "crossed@test.local",
                                        "password": "strong-enough-pw",
                                        "role": "viewer"})
        self.assertEqual(resp.status, 403)
        self.assertIsNone(self.fs.get_user_by_email("crossed@test.local"))

    def test_csrf_token_rotates_on_epoch_bump(self):
        # After logout-all (epoch bump), the old CSRF token is worthless even
        # when reused on a new session (the token is bound to the epoch).
        cookie = session_cookie(self.srv, ADMIN_EMAIL, ADMIN_PASSWORD)
        old_csrf = me_of(self.srv, cookie)["csrf_token"]
        self.srv.post("/api/account/logout-all",
                      headers=auth_headers(self.srv, cookie), json_body={})
        new_cookie = session_cookie(self.srv, ADMIN_EMAIL, ADMIN_PASSWORD)
        new_csrf = me_of(self.srv, new_cookie)["csrf_token"]
        self.assertNotEqual(old_csrf, new_csrf)


class TestCsrfOnContentRoutes(unittest.TestCase):
    """Batch 2d regression: the CSRF synchronizer guard must cover ALL the
    authenticated CONTENT mutation routes (file/notes/todos/share/move/rename),
    not just /api/admin/* and /api/account/*. The frontend (viewer.html) already
    wires X-CSRF-Token on every mutating fetch; the backend had omitted to check
    it on the document surface (edit/delete/move/share)."""

    def setUp(self):
        self.srv = AtlasServer(extra_env=cloud_env())
        self.srv.start()
        self.fs = file_store_of(self.srv)
        seed_admin_and_viewer(self.fs)
        self.cookie = session_cookie(self.srv, ADMIN_EMAIL, ADMIN_PASSWORD)
        self.no_csrf = {"Cookie": self.cookie, "Content-Type": "application/json"}

    def tearDown(self):
        self.srv.stop()

    def test_content_post_routes_without_csrf_refused(self):
        # Valid admin cookie BUT no X-CSRF-Token -> 403 (not 200).
        cases = [
            ("/api/todos", {"text": "x"}),
            ("/api/notes",
             {"path": "accueil.md", "note": "n", "exact": "Bienvenue"}),
            ("/api/share", {"path": "accueil.md"}),
            ("/api/file/move", {"from": "accueil.md", "to": "deplace.md"}),
            ("/api/dir/rename", {"from": "projets", "to": "projets2"}),
        ]
        for path, body in cases:
            resp = self.srv.post(path, json_body=body, headers=self.no_csrf)
            self.assertEqual(resp.status, 403, f"{path} should require CSRF")
            self.assertIn("CSRF", resp.json().get("error", ""))

    def test_content_put_patch_delete_without_csrf_refused(self):
        put = self.srv.put(
            "/api/file", json_body={"path": "inbox/x.md", "content": "x"},
            headers=self.no_csrf)
        self.assertEqual(put.status, 403)
        self.assertFalse(self.srv.path("inbox/x.md").exists())

        patch = self.srv.patch(
            "/api/todos/0", json_body={"done": True}, headers=self.no_csrf)
        self.assertEqual(patch.status, 403)

        delete = self.srv.delete(
            "/api/file", json_body={"path": "accueil.md"}, headers=self.no_csrf)
        self.assertEqual(delete.status, 403)
        self.assertTrue(self.srv.path("accueil.md").exists())

    def test_content_mutation_with_valid_csrf_accepted(self):
        headers = auth_headers(self.srv, self.cookie)
        headers["Content-Type"] = "application/json"
        put = self.srv.put(
            "/api/file", json_body={"path": "inbox/ok.md", "content": "ok"},
            headers=headers)
        self.assertEqual(put.status, 200)
        self.assertEqual(
            self.srv.path("inbox/ok.md").read_text(encoding="utf-8"), "ok")

    def test_cross_origin_content_mutation_refused(self):
        # Even with a valid CSRF token, a third-party origin is rejected.
        headers = auth_headers(self.srv, self.cookie)
        headers["Origin"] = "http://evil.example"
        headers["Content-Type"] = "application/json"
        resp = self.srv.post("/api/todos", json_body={"text": "x"},
                             headers=headers)
        self.assertEqual(resp.status, 403)


class TestRecoveryCodeAtomicConsume(unittest.TestCase):
    """Batch 2d: consuming a single-use recovery code goes through the atomic
    primitive store.consume_recovery_hash (a single atomic critical section in
    the FileStore). Two concurrent consumptions of the
    SAME code can no longer both succeed (the old get_user_by_email +
    upsert_user released the lock between the read and the write)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.fs = store.FileStore(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def _seed(self, codes):
        hashes = [hashlib.sha256(c.encode()).hexdigest() for c in codes]
        self.fs.upsert_user("u@test.local", {"totp_recovery_hashes": hashes})
        return hashes

    def test_single_use_sequential(self):
        h = self._seed(["aaaaa-11111", "bbbbb-22222"])[0]
        self.assertTrue(self.fs.consume_recovery_hash("u@test.local", h))
        # Replay: already consumed -> False, and the other code remains.
        self.assertFalse(self.fs.consume_recovery_hash("u@test.local", h))
        remaining = self.fs.get_user_by_email("u@test.local")[
            "totp_recovery_hashes"]
        self.assertEqual(len(remaining), 1)

    def test_concurrent_same_code_consumed_once(self):
        # Window forced INSIDE the critical section: we patch _write to sleep. If
        # the section were not atomic (lock released), several threads would read
        # the still-present code and all consume it. With the single critical
        # section, a SINGLE thread wins.
        h = self._seed(["ccccc-33333", "ddddd-44444"])[0]
        original_write = self.fs._write

        def slow_write(*args, **kwargs):
            time.sleep(0.05)
            return original_write(*args, **kwargs)

        self.fs._write = slow_write
        wins = []

        def attempt():
            wins.append(self.fs.consume_recovery_hash("u@test.local", h))

        threads = [threading.Thread(target=attempt) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(sum(1 for w in wins if w), 1,
                         "a recovery code must be consumed only once")


if __name__ == "__main__":
    unittest.main()
