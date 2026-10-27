"""Unit tests of the OAuth helpers that need no running server: client metadata documents
(the real ChatGPT and claude.ai shapes), the SSRF address guard, redirect URIs and PKCE."""
import sys
import unittest
from pathlib import Path

REPO_SRC = Path(__file__).resolve().parent.parent / "src"
if str(REPO_SRC) not in sys.path:
    sys.path.insert(0, str(REPO_SRC))

from server.pure import oauth  # noqa: E402

CHATGPT = "https://chatgpt.com/oauth/client.json"
CHATGPT_DOC = {  # as served on 2026-10-27
    "client_id": CHATGPT,
    "client_uri": "https://chatgpt.com/",
    "redirect_uris": ["https://chatgpt.com/connector_platform_oauth_redirect"],
    "token_endpoint_auth_method": "private_key_jwt",
    "token_endpoint_auth_methods_supported": ["none", "private_key_jwt"],
    "grant_types": ["authorization_code", "refresh_token"],
    "response_types": ["code"],
    "client_name": "ChatGPT",
    "token_endpoint_auth_signing_alg": "RS256",
    "jwks_uri": "https://chatgpt.com/oauth/jwks.json",
}


class TestClientMetadata(unittest.TestCase):
    def test_a_client_that_also_supports_none_is_accepted(self):
        client = oauth.client_from_metadata(CHATGPT, CHATGPT_DOC)
        self.assertEqual((client["client_name"], client["host"]), ("ChatGPT", "chatgpt.com"))

    def test_public_client_is_accepted(self):
        url = "https://claude.ai/oauth/mcp-oauth-client-metadata"
        doc = {"client_id": url, "client_name": "Claude",
               "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
               "token_endpoint_auth_method": "none"}
        self.assertEqual(oauth.client_from_metadata(url, doc)["client_name"], "Claude")

    def test_refusals(self):
        jwt_only = {**CHATGPT_DOC, "token_endpoint_auth_methods_supported": ["private_key_jwt"]}
        for doc, reason in ((jwt_only, "public clients"),
                            ({**CHATGPT_DOC, "client_id": "https://evil.example/c.json"}, "client_id"),
                            ({**CHATGPT_DOC, "redirect_uris": ["http://evil.example/cb"]}, "redirect_uris"),
                            ("not a dict", "client_id")):
            with self.assertRaises(oauth.ClientError) as ctx:
                oauth.client_from_metadata(CHATGPT, doc)
            self.assertIn(reason, str(ctx.exception))


class TestGuards(unittest.TestCase):
    def test_only_public_addresses(self):
        for addr in ("127.0.0.1", "10.0.0.5", "192.168.1.1", "169.254.169.254", "100.64.0.1",
                     "::1", "fe80::1", "::ffff:127.0.0.1", "224.0.0.1", "0.0.0.0"):
            self.assertFalse(oauth._public_address(addr), addr)
        for addr in ("8.8.8.8", "2606:4700:4700::1111"):
            self.assertTrue(oauth._public_address(addr), addr)

    def test_redirect_uris(self):
        for uri in ("https://chatgpt.com/cb", "http://localhost:3000/cb", "http://127.0.0.1:9/cb"):
            self.assertTrue(oauth.valid_redirect_uri(uri), uri)
        for uri in ("http://chatgpt.com/cb", "javascript:alert(1)", "https://x.example/cb#f",
                    "https://user:pw@x.example/cb", 42):
            self.assertFalse(oauth.valid_redirect_uri(uri), uri)

    def test_pkce_rfc7636_vector(self):
        verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        self.assertTrue(oauth.pkce_ok(verifier, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"))
        self.assertFalse(oauth.pkce_ok(verifier, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cX"))
        self.assertFalse(oauth.pkce_ok("short", "anything"))


if __name__ == "__main__":
    unittest.main()
