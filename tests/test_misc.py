"""Miscellaneous characterization tests: SSE /api/events, /.well-known/openapi.json,
cloud endpoints called in LOCAL mode (/login, /api/share, /api/v1/*) and
POST /webhook/github.

Findings encoded here (CURRENT behavior, not necessarily desirable):
- In local mode, _session() fabricates a fake admin session {'email': 'local',
  'role': 'admin'}: everything guarded by _require_admin_or_403 is ACTIVE
  WITHOUT ANY AUTH, including POST /api/share (creation of signed public links).
- Share tokens are signed with SESSION_SECRET, which is the default
  'dev-secret-change-me' locally -> forgeable by anyone who knows the code.
- /login and /logout simply do not exist locally (the route is guarded by
  `if AUTH_ENABLED and ...`): GET falls back to the static handler (404 HTML
  http.server), POST falls back to the bare 404 at the end of do_POST (empty
  body).
- /api/v1/* requires a Bearer even locally (no fake session here); a Bearer that
  is present but bogus ALSO fails with 401 because it is not found in the registry
  (fail-closed, identical message).
- /webhook/github without GITHUB_WEBHOOK_SECRET in the env -> dry 503 (empty
  body), even before reading the body or the signature.
"""
import base64
import hashlib
import hmac
import json
import socket
import time
import unittest

from harness import AtlasServer

# Hardcoded default in server.py (SESSION_SECRET) -- the harness purges
# SESSION_SECRET from the env in local mode, so THIS secret is the one signing
# the share tokens of the test server.
LOCAL_DEFAULT_SECRET = b"dev-secret-change-me"

WEBHOOK_SECRET = "atlas-test-webhook-secret"


def _forge_share_token(path: str, expires_at: int, secret: bytes) -> str:
    """Exact replica of make_share_token() from server.py."""
    payload = json.dumps({"p": path, "e": expires_at}).encode()
    sig = hmac.new(secret, payload, hashlib.sha256).digest()
    return (base64.urlsafe_b64encode(payload).decode().rstrip("=")
            + "."
            + base64.urlsafe_b64encode(sig).decode().rstrip("="))


def _raw_sse_request(port: int, path: str, deadline: float = 4.0) -> bytes:
    """GET over a raw socket (urllib would block: the SSE response never ends).

    Reads until the first `: connected` frame is seen or the deadline expires,
    and returns everything received (status line + headers + start of the body).
    """
    with socket.create_connection(("127.0.0.1", port), timeout=deadline) as sock:
        sock.settimeout(deadline)
        sock.sendall(
            f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n".encode()
        )
        received = b""
        end = time.monotonic() + deadline
        while b": connected\n\n" not in received and time.monotonic() < end:
            try:
                chunk = sock.recv(4096)
            except socket.timeout:
                break
            if not chunk:
                break
            received += chunk
        return received


def _wait_log_contains(srv: AtlasServer, needle: str, timeout: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if needle in srv.read_log():
            return True
        time.sleep(0.05)
    return False


class TestMiscLocal(unittest.TestCase):
    """Shared local server: none of these tests write into content/
    (POST /api/share does not touch the mind and does not trigger trigger_sync)."""

    srv: AtlasServer

    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer()
        cls.srv.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    # ── /api/events (SSE) ────────────────────────────────────────────────────

    def test_sse_events_content_type_and_first_frame(self):
        started = time.monotonic()
        received = _raw_sse_request(self.srv.port, "/api/events")
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, 5.0, "the first SSE frame must arrive quickly")

        head, _, body = received.partition(b"\r\n\r\n")
        status_line, *header_lines = head.split(b"\r\n")
        # BaseHTTPRequestHandler's default protocol_version -> HTTP/1.0.
        self.assertEqual(status_line, b"HTTP/1.0 200 OK")
        headers = {}
        for line in header_lines:
            name, _, value = line.partition(b":")
            headers[name.strip().lower()] = value.strip()
        self.assertEqual(headers[b"content-type"], b"text/event-stream")
        self.assertEqual(headers[b"cache-control"], b"no-cache")
        self.assertEqual(headers[b"connection"], b"keep-alive")
        # end_headers() adds the security headers even on the SSE stream.
        self.assertEqual(headers[b"x-content-type-options"], b"nosniff")
        # First frame: an SSE comment `: connected`, sent immediately after the
        # headers (the next ping only arrives 20 s later).
        self.assertEqual(body, b": connected\n\n")

    # ── /.well-known/openapi.json ────────────────────────────────────────────

    def test_openapi_json_is_public_valid_json(self):
        resp = self.srv.get("/.well-known/openapi.json")
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.headers.get("Content-Type"),
                         "application/json; charset=utf-8")
        # The only server response with a public Cache-Control.
        self.assertEqual(resp.headers.get("Cache-Control"), "public, max-age=300")
        spec = resp.json()  # raises if JSON is invalid
        self.assertEqual(spec["openapi"], "3.1.0")
        # Phase 2a (de-personalization): the OpenAPI title reads CONFIG.site_name,
        # neutral ("Atlas") without atlas.toml -- no more personal branding by
        # default.
        self.assertEqual(spec["info"]["title"], "Atlas Mind")
        self.assertEqual(
            set(spec["paths"]),
            {"/api/v1/search", "/api/v1/file", "/api/v1/tree", "/api/v1/recent"},
        )
        self.assertEqual(spec["security"], [{"bearerAuth": []}])
        # In local mode the advertised scheme is http (https only in cloud), and
        # the host reflects the Host header sent by the client.
        self.assertEqual(
            spec["servers"],
            [{"url": f"http://127.0.0.1:{self.srv.port}"}],
        )

    def test_openapi_servers_echo_arbitrary_host_header(self):
        # Characterization: the host in `servers` is copied verbatim from the
        # request's Host header, without validation.
        resp = self.srv.get("/.well-known/openapi.json",
                            headers={"Host": "example.test:1234"})
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.json()["servers"],
                         [{"url": "http://example.test:1234"}])

    # ── /login & /logout in local mode ────────────────────────────────────────

    def test_login_get_falls_through_to_static_404(self):
        # The /login route is guarded by `if AUTH_ENABLED`: locally it does not
        # exist. GET traverses the whole routing, passes the fake auth, then
        # looks for content/login on disk -> 404 HTML from http.server (no JSON,
        # no login form).
        resp = self.srv.get("/login")
        self.assertEqual(resp.status, 404)
        self.assertTrue(resp.headers.get("Content-Type", "").startswith("text/html"))
        self.assertIn("File not found", resp.text)
        self.assertNotIn("password", resp.text.lower())

    def test_login_post_returns_bare_404_empty_body(self):
        # POST /login hits the bare 404 at the end of do_POST: no body at all.
        resp = self.srv.post("/login", json_body={"email": "a@b.c", "password": "x"})
        self.assertEqual(resp.status, 404)
        self.assertEqual(resp.body, b"")

    def test_logout_get_falls_through_to_static_404(self):
        resp = self.srv.get("/logout")
        self.assertEqual(resp.status, 404)
        self.assertIn("File not found", resp.text)

    def test_api_me_fakes_local_admin_session(self):
        # _session() returns a fake cookieless admin session locally: it is what
        # opens up all the "admin" endpoints without auth.
        resp = self.srv.get("/api/me")
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.json(), {
            "authenticated": True,
            "email": "local",
            "role": "admin",
            "cloud": False,
        })

    # ── POST /api/share in local mode ─────────────────────────────────────────

    def test_share_create_works_without_auth_in_local_mode(self):
        # SURPRISING: a "cloud" endpoint fully ACTIVE locally, without auth (fake
        # admin session). Only persistence is skipped -> id null.
        resp = self.srv.post("/api/share", json_body={"path": "accueil.md"})
        self.assertEqual(resp.status, 200)
        payload = resp.json()
        self.assertIsNone(payload["id"])  # local fake session has no persisted registry id
        self.assertEqual(payload["path"], "accueil.md")
        self.assertEqual(payload["expires_at"], 0)  # without expires_days -> unlimited
        self.assertTrue(payload["token"])
        self.assertIn(".", payload["token"])  # format payload_b64.sig_b64

    def test_share_create_rejects_dotdot_path(self):
        resp = self.srv.post("/api/share", json_body={"path": "../secrets.md"})
        self.assertEqual(resp.status, 400)
        self.assertEqual(resp.json(), {"error": "invalid path"})

    def test_share_create_unknown_doc_404(self):
        resp = self.srv.post("/api/share", json_body={"path": "nope/inexistant.md"})
        self.assertEqual(resp.status, 404)
        self.assertEqual(resp.json(), {"error": "document not found"})

    def test_share_link_round_trip_without_auth(self):
        # The link created locally is served by GET /share/<token> (public
        # route): the doc content is embedded as JSON in the standalone page.
        token = self.srv.post(
            "/api/share", json_body={"path": "accueil.md"}).json()["token"]
        resp = self.srv.get(f"/share/{token}")
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.headers.get("Content-Type"), "text/html; charset=utf-8")
        self.assertEqual(resp.headers.get("X-Robots-Tag"), "noindex, nofollow")
        self.assertEqual(resp.headers.get("Cache-Control"), "no-store")
        self.assertIn("accueil.md", resp.text)  # title = file name
        self.assertIn("Bienvenue dans le mind de test.", resp.text)

    def test_share_link_garbage_token_404_invalid_page(self):
        resp = self.srv.get("/share/pas-un-token")
        self.assertEqual(resp.status, 404)
        self.assertIn("Lien invalide", resp.text)

    def test_share_token_forgeable_with_default_secret_and_expired_410(self):
        # SURPRISING: locally SESSION_SECRET keeps its public default
        # 'dev-secret-change-me' -> anyone can forge a valid token. Here we forge
        # an EXPIRED token (e=1, epoch 1970) to also characterize the 410 "Lien
        # expiré" page.
        forged = _forge_share_token("accueil.md", 1, LOCAL_DEFAULT_SECRET)
        resp = self.srv.get(f"/share/{forged}")
        self.assertEqual(resp.status, 410)
        self.assertIn("expir", resp.text)  # "Lien expir&eacute;"

        # And a token forged without expiration is served outright (signature
        # OK). The share page's <title> = the file name alone (not the path).
        forged_valid = _forge_share_token("projets/beta.md", 0, LOCAL_DEFAULT_SECRET)
        resp = self.srv.get(f"/share/{forged_valid}")
        self.assertEqual(resp.status, 200)
        self.assertIn("<title>beta.md</title>", resp.text)
        self.assertIn("Aucun lien sortant ici.", resp.text)

    def test_share_list_ok_with_file_store(self):
        # Public default = file store (no dependency): GET /api/share/list passes
        # the fake auth then reads shares.json (absent -> empty list) -> 200.
        resp = self.srv.get("/api/share/list")
        self.assertEqual(resp.status, 200)
        self.assertIsInstance(resp.json(), list)

    # ── /api/v1/* in local mode ───────────────────────────────────────────────

    def test_api_v1_search_requires_bearer_even_in_local_mode(self):
        # Unlike the rest of the API, /api/v1/* does NOT benefit from the fake
        # admin session: without Authorization -> 401 even locally.
        resp = self.srv.get("/api/v1/search?q=alpha")
        self.assertEqual(resp.status, 401)
        self.assertEqual(resp.json(), {"error": "invalid or missing bearer token"})

    def test_api_v1_bogus_bearer_fails_closed_401(self):
        # A Bearer that is present but unknown cannot be found in the file store
        # (users.json absent -> no identity) -> the SAME 401 as a missing token
        # (fail-closed).
        resp = self.srv.get("/api/v1/search?q=alpha",
                            headers={"Authorization": "Bearer bidon"})
        self.assertEqual(resp.status, 401)
        self.assertEqual(resp.json(), {"error": "invalid or missing bearer token"})

    def test_api_v1_all_endpoints_401_without_bearer(self):
        for path in ("/api/v1/file?path=accueil.md", "/api/v1/tree",
                     "/api/v1/recent"):
            with self.subTest(path=path):
                resp = self.srv.get(path)
                self.assertEqual(resp.status, 401)
        # Creation is protected the same way.
        resp = self.srv.post("/api/v1/file",
                             json_body={"path": "x.md", "content": "# X\n"})
        self.assertEqual(resp.status, 401)
        self.assertFalse(self.srv.path("x.md").exists())

    # ── /webhook/github without secret ────────────────────────────────────────

    def test_webhook_github_503_when_secret_unset(self):
        # Without GITHUB_WEBHOOK_SECRET (the default local case), the webhook is
        # disabled: empty-body 503, returned BEFORE reading the body or the
        # signature.
        resp = self.srv.post(
            "/webhook/github", data=b'{"zen": "test"}',
            headers={"X-Hub-Signature-256": "sha256=deadbeef",
                     "X-GitHub-Event": "push"})
        self.assertEqual(resp.status, 503)
        self.assertEqual(resp.body, b"")


class TestGithubWebhookWithSecret(unittest.TestCase):
    """Dedicated server: GITHUB_WEBHOOK_SECRET injected via the env (local mode otherwise)."""

    srv: AtlasServer

    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer(extra_env={"GITHUB_WEBHOOK_SECRET": WEBHOOK_SECRET})
        cls.srv.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    @staticmethod
    def _signature(body: bytes) -> str:
        return "sha256=" + hmac.new(
            WEBHOOK_SECRET.encode(), body, hashlib.sha256).hexdigest()

    def test_missing_signature_401(self):
        resp = self.srv.post("/webhook/github", data=b'{"zen": "test"}')
        self.assertEqual(resp.status, 401)
        self.assertEqual(resp.body, b"")

    def test_bad_signature_401(self):
        resp = self.srv.post(
            "/webhook/github", data=b'{"zen": "test"}',
            headers={"X-Hub-Signature-256": "sha256=" + "0" * 64})
        self.assertEqual(resp.status, 401)
        self.assertEqual(resp.body, b"")

    def test_valid_signature_non_push_event_200_ok(self):
        # Valid signature but event != push: the server still responds 200 "ok"
        # (the event is just ignored, no pull_and_rebuild).
        body = b'{"zen": "ping"}'
        resp = self.srv.post(
            "/webhook/github", data=body,
            headers={"X-Hub-Signature-256": self._signature(body),
                     "X-GitHub-Event": "ping"})
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.body, b"ok")
        self.assertEqual(resp.headers.get("Content-Type"), "text/plain")
        self.assertNotIn("[pull_and_rebuild]", self.srv.read_log())

    def test_valid_signature_push_event_triggers_pull_and_rebuild(self):
        body = b'{"ref": "refs/heads/main"}'
        resp = self.srv.post(
            "/webhook/github", data=body,
            headers={"X-Hub-Signature-256": self._signature(body),
                     "X-GitHub-Event": "push"})
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.body, b"ok")
        # pull_and_rebuild starts in a background thread AFTER the response: we
        # poll the log. In a mind without a remote, the pull fails best-effort
        # but the sequence does start.
        self.assertTrue(
            _wait_log_contains(self.srv, "[pull_and_rebuild] start"),
            "the push event must trigger pull_and_rebuild in the background",
        )


if __name__ == "__main__":
    unittest.main()
