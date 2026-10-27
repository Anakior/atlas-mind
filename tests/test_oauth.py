"""Tests of OAuth 2.1 for the MCP endpoint: discovery, DCR, sign-in → consent → code,
PKCE, the token endpoint (code + rotating refresh with replay detection), Bearer /mcp
with audience and scope checks, revocation, the CIMD SSRF guard and the login `next`.
"""
import base64
import hashlib
import json
import secrets
import sys
import time
import unittest
from pathlib import Path
from urllib.parse import parse_qs, quote, urlencode, urlsplit

_TESTS_DIR = str(Path(__file__).resolve().parent)
if _TESTS_DIR not in sys.path:
    sys.path.insert(0, _TESTS_DIR)

from harness import AtlasServer  # noqa: E402
from test_cloud_filestore import (  # noqa: E402
    cloud_env, file_store_of, seed_default_users, session_cookie, csrf_of,
    ADMIN_EMAIL, ADMIN_PASSWORD,
)

REDIRECT = "http://localhost:9999/callback"


def _pkce():
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
    return verifier, challenge.rstrip(b"=").decode()


class _OAuth(unittest.TestCase):
    def setUp(self):
        self.srv = AtlasServer(extra_env=cloud_env())
        self.srv.start()
        seed_default_users(file_store_of(self.srv))
        self.cookie = session_cookie(self.srv, ADMIN_EMAIL, ADMIN_PASSWORD)
        self.base = f"http://127.0.0.1:{self.srv.port}"

    def tearDown(self):
        self.srv.stop()

    # ── helpers ──
    def register(self, name="Test Client"):
        resp = self.srv.post("/oauth/register", json_body={
            "client_name": name, "redirect_uris": [REDIRECT],
            "grant_types": ["authorization_code", "refresh_token"],
            "token_endpoint_auth_method": "none"})
        self.assertEqual(resp.status, 201, resp.text)
        return resp.json()["client_id"]

    def authorize_params(self, client_id, challenge, **extra):
        return {"response_type": "code", "client_id": client_id, "redirect_uri": REDIRECT,
                "state": "st4te", "code_challenge": challenge, "code_challenge_method": "S256",
                "resource": self.base + "/mcp", **extra}

    def consent(self, params, grant=("read", "inbox", "write"), decision="allow", csrf=None,
                origin="null"):
        """POST the consent form like a browser does under Atlas's no-referrer policy:
        `Origin: null`."""
        form = {**params, "csrf_token": csrf_of(self.srv, self.cookie) if csrf is None else csrf,
                "decision": decision}
        body = urlencode(list(form.items()) + [("grant", g) for g in grant]).encode()
        return self.srv.post("/oauth/authorize", data=body, headers={
            "Cookie": self.cookie, "Content-Type": "application/x-www-form-urlencoded",
            "Origin": origin})

    def token(self, **form):
        return self.srv.post("/oauth/token", data=urlencode(form).encode(),
                             headers={"Content-Type": "application/x-www-form-urlencoded"})

    def grant(self, scopes=("read", "inbox", "write")):
        """Run the whole flow; returns (client_id, token response)."""
        client_id = self.register()
        verifier, challenge = _pkce()
        resp = self.consent(self.authorize_params(client_id, challenge), grant=scopes)
        self.assertEqual(resp.status, 303)
        code = parse_qs(urlsplit(resp.headers["Location"]).query)["code"][0]
        tok = self.token(grant_type="authorization_code", code=code, client_id=client_id,
                         redirect_uri=REDIRECT, code_verifier=verifier, resource=self.base + "/mcp")
        self.assertEqual(tok.status, 200, tok.text)
        return client_id, tok.json()

    def mcp(self, access, method="tools/list", params=None):
        return self.srv.post("/mcp", headers={"Authorization": f"Bearer {access}"}, json_body={
            "jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}})


class TestDiscoveryAndChallenge(_OAuth):
    def test_metadata_documents(self):
        prm = self.srv.get("/.well-known/oauth-protected-resource/mcp")
        self.assertEqual(prm.headers.get("Access-Control-Allow-Origin"), "*")
        self.assertEqual(prm.json()["resource"], self.base + "/mcp")
        self.assertEqual(prm.json()["authorization_servers"], [self.base])
        asm = self.srv.get("/.well-known/oauth-authorization-server").json()
        self.assertEqual(asm["issuer"], self.base)
        self.assertEqual(asm["code_challenge_methods_supported"], ["S256"])
        self.assertTrue(asm["authorization_response_iss_parameter_supported"])
        self.assertEqual(asm["token_endpoint"], self.base + "/oauth/token")

    def test_mcp_without_token_points_at_the_metadata(self):
        resp = self.srv.post("/mcp", json_body={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        self.assertEqual(resp.status, 401)
        self.assertIn(f'resource_metadata="{self.base}/.well-known/oauth-protected-resource/mcp"',
                      resp.headers["WWW-Authenticate"])


class TestAuthorizationFlow(_OAuth):
    def test_full_flow_reaches_mcp(self):
        client_id = self.register("Claude Test")
        _, challenge = _pkce()
        path = "/oauth/authorize?" + urlencode(self.authorize_params(client_id, challenge))
        anon = self.srv.get(path)
        self.assertEqual(anon.status, 303)
        self.assertEqual(anon.headers["Location"], "/login?next=" + quote(path, safe=""))
        page = self.srv.get(path, headers={"Cookie": self.cookie})
        self.assertEqual(page.status, 200)
        self.assertIn("Claude Test", page.text)
        self.assertIn('value="write" checked', page.text)

        client_id, tok = self.grant()
        self.assertEqual((tok["token_type"], tok["expires_in"], tok["scope"]),
                         ("Bearer", 3600, "read inbox write"))
        tools = self.mcp(tok["access_token"]).json()["result"]["tools"]
        self.assertIn("edit_doc", [t["name"] for t in tools])
        mine = self.srv.get("/api/tokens", headers={"Cookie": self.cookie}).json()
        self.assertTrue(any(t["oauth"] and t["label"] == "Test Client" for t in mine))

    def test_code_is_single_use_and_pkce_bound(self):
        client_id = self.register()
        verifier, challenge = _pkce()
        loc = self.consent(self.authorize_params(client_id, challenge)).headers["Location"]
        query = parse_qs(urlsplit(loc).query)
        self.assertEqual((query["state"][0], query["iss"][0]), ("st4te", self.base))
        code = query["code"][0]
        bad = self.token(grant_type="authorization_code", code=code, client_id=client_id,
                         redirect_uri=REDIRECT, code_verifier=_pkce()[0])
        self.assertEqual(bad.json()["error"], "invalid_grant")
        again = self.token(grant_type="authorization_code", code=code, client_id=client_id,
                           redirect_uri=REDIRECT, code_verifier=verifier)
        self.assertEqual(again.json()["error"], "invalid_grant")  # burnt by the failed try

    def test_unregistered_redirect_gets_a_page_not_a_redirect(self):
        client_id = self.register()
        params = self.authorize_params(client_id, _pkce()[1], redirect_uri="https://evil.example/cb")
        resp = self.srv.get("/oauth/authorize?" + urlencode(params), headers={"Cookie": self.cookie})
        self.assertEqual(resp.status, 400)
        self.assertNotIn("Location", resp.headers)

    def test_missing_pkce_and_denial_go_back_as_errors(self):
        client_id = self.register()
        params = self.authorize_params(client_id, "")
        resp = self.srv.get("/oauth/authorize?" + urlencode(params), headers={"Cookie": self.cookie})
        self.assertIn("error=invalid_request", resp.headers["Location"])
        resp = self.consent(self.authorize_params(client_id, _pkce()[1]), decision="deny")
        self.assertTrue(resp.headers["Location"].startswith(REDIRECT + "?"))
        self.assertIn("error=access_denied", resp.headers["Location"])

    def test_consent_needs_the_session_csrf_token_and_no_foreign_origin(self):
        client_id = self.register()
        for kwargs in ({"csrf": "forged"}, {"origin": "https://evil.example"}):
            resp = self.consent(self.authorize_params(client_id, _pkce()[1]), **kwargs)
            self.assertEqual(resp.status, 403, kwargs)
            self.assertNotIn("Location", resp.headers)


class TestTokens(_OAuth):
    def test_narrowed_consent_and_step_up(self):
        _, tok = self.grant(scopes=("read",))
        self.assertEqual(tok["scope"], "read")
        names = [t["name"] for t in self.mcp(tok["access_token"]).json()["result"]["tools"]]
        self.assertNotIn("edit_doc", names)
        resp = self.mcp(tok["access_token"], "tools/call",
                        {"name": "edit_doc", "arguments": {"path": "accueil.md", "content": "x"}})
        self.assertEqual(resp.status, 403)
        self.assertIn('error="insufficient_scope"', resp.headers["WWW-Authenticate"])
        self.assertIn('scope="write"', resp.headers["WWW-Authenticate"])

    def test_refresh_rotates_and_a_replay_revokes_the_grant(self):
        client_id, first = self.grant()
        second = self.token(grant_type="refresh_token", refresh_token=first["refresh_token"],
                            client_id=client_id).json()
        self.assertEqual(self.mcp(second["access_token"]).status, 200)
        self.assertEqual(self.mcp(first["access_token"]).status, 401)  # replaced
        replay = self.token(grant_type="refresh_token", refresh_token=first["refresh_token"],
                            client_id=client_id)
        self.assertEqual(replay.json()["error"], "invalid_grant")
        self.assertEqual(self.mcp(second["access_token"]).status, 401)  # whole grant revoked

    def test_expired_access_token_is_refused(self):
        _, tok = self.grant()
        fs = file_store_of(self.srv)
        grant = next(u for u in fs.list_users() if u.get("oauth_client_id"))
        fs.upsert_user(grant["email"], {"api_token_expires_at": int(time.time()) - 1})
        self.assertEqual(self.mcp(tok["access_token"]).status, 401)

    def test_revoked_from_settings(self):
        client_id, tok = self.grant()
        email = next(t["email"] for t in self.srv.get("/api/tokens", headers={"Cookie": self.cookie}).json()
                     if t["oauth"])
        resp = self.srv.request("DELETE", "/api/tokens", json_body={"id": email}, headers={
            "Cookie": self.cookie, "X-CSRF-Token": csrf_of(self.srv, self.cookie)})
        self.assertEqual(resp.status, 200)
        self.assertEqual(self.mcp(tok["access_token"]).status, 401)
        refresh = self.token(grant_type="refresh_token", refresh_token=tok["refresh_token"],
                             client_id=client_id)
        self.assertEqual(refresh.json()["error"], "invalid_grant")

    def test_oauth_token_only_works_as_bearer_on_mcp(self):
        _, tok = self.grant()
        in_path = self.srv.post(f"/mcp/{tok['access_token']}", json_body={
            "jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        self.assertEqual(in_path.status, 401)
        rest = self.srv.get("/api/v1/search?q=accueil",
                            headers={"Authorization": f"Bearer {tok['access_token']}"})
        self.assertEqual(rest.status, 401)


class TestClientsAndLogin(_OAuth):
    def test_metadata_url_on_a_private_address_is_refused(self):
        for client_id in ("https://127.0.0.1/client.json", "https://localhost/client.json"):
            params = self.authorize_params(client_id, _pkce()[1])
            resp = self.srv.get("/oauth/authorize?" + urlencode(params), headers={"Cookie": self.cookie})
            self.assertEqual(resp.status, 400, client_id)
            self.assertIn("not a public address", resp.text)

    def test_registration_refuses_unsafe_redirects(self):
        for uri in ("javascript:alert(1)", "http://example.com/cb", "https://x.example/cb#frag"):
            resp = self.srv.post("/oauth/register", json_body={"redirect_uris": [uri]})
            self.assertEqual(resp.status, 400, uri)

    def test_login_lands_on_a_local_next_only(self):
        target = "/oauth/authorize?client_id=x&state=y"
        page = self.srv.get("/login?next=" + quote(target, safe=""))
        self.assertIn(f'name="next" value="{target.replace("&", "&amp;")}"', page.text)
        for nxt, landing in ((target, target), ("//evil.example/x", "/"), ("https://evil.example", "/")):
            resp = self.srv.post("/login", json_body={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD,
                                                      "next": nxt})
            self.assertEqual(resp.headers["Location"], landing, nxt)


if __name__ == "__main__":
    unittest.main()
