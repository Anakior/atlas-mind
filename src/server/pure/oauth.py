"""OAuth 2.1 authorization server for the MCP endpoint (MCP 2026-07-28 authorization):
discovery metadata, client resolution, PKCE-bound authorization codes and scopes.

A client is identified either by the HTTPS URL of its metadata document (CIMD), fetched
over an SSRF-guarded call pinned to the address it was checked against, or by a
client_id it registered here (DCR). The grants themselves are 'api' identities in the
store, so everything downstream of a token (ACL, scopes, attribution) is unchanged."""
import base64
import hashlib
import hmac
import http.client
import ipaddress
import json
import secrets
import socket
import ssl
import threading
import time
from urllib.parse import urlencode, urlsplit

import server as _s
from store import API_SCOPES, normalize_scopes

ACCESS_TTL = 3600            # an access token lives an hour, then the client refreshes
REFRESH_TTL = 30 * 86400     # a grant unused for 30 days asks the person again
CODE_TTL = 60                # an authorization code must be redeemed within a minute

_CIMD_TTL = 600
_CIMD_MAX_BYTES = 16384
_CIMD_TIMEOUT = 5
_LOOPBACK_HOSTS = ("localhost", "127.0.0.1", "[::1]", "::1")


class ClientError(Exception):
    """The client could not be identified or verified; the message says why."""


# ── discovery ────────────────────────────────────────────────────────────────

def resource_url(base: str) -> str:
    """The canonical URI of this MCP server, the audience every token is bound to."""
    return base + "/mcp"


def protected_resource_metadata(base: str) -> dict:
    """RFC 9728 document: where to get a token for the MCP endpoint, and which scopes."""
    return {
        "resource": resource_url(base),
        "authorization_servers": [base],
        "scopes_supported": list(API_SCOPES),
        "bearer_methods_supported": ["header"],
        "resource_name": _s.CONFIG.site_name,
    }


def authorization_server_metadata(base: str) -> dict:
    """RFC 8414 document. Public clients only: PKCE S256, no client secret."""
    return {
        "issuer": base,
        "authorization_endpoint": base + "/oauth/authorize",
        "token_endpoint": base + "/oauth/token",
        "registration_endpoint": base + "/oauth/register",
        "scopes_supported": list(API_SCOPES),
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
        "client_id_metadata_document_supported": bool(_s.CONFIG.oauth_client_metadata_fetch),
        "authorization_response_iss_parameter_supported": True,
    }


def challenge_header(base: str, error: str = "", scope: str = "") -> str:
    """WWW-Authenticate value pointing a client at the resource metadata: on a 401 it
    starts the OAuth flow, on a 403 insufficient_scope it asks for more scopes."""
    params = [f'resource_metadata="{base}/.well-known/oauth-protected-resource/mcp"']
    if error:
        params.insert(0, f'error="{error}"')
    params.append(f'scope="{scope or " ".join(API_SCOPES)}"')
    return "Bearer " + ", ".join(params)


def same_resource(a: str, b: str) -> bool:
    """RFC 8707 comparison: scheme and host case-insensitive, trailing slash ignored."""
    def canon(u):
        p = urlsplit((u or "").strip())
        return (p.scheme.lower(), p.netloc.lower(), p.path.rstrip("/"))
    return bool(a) and canon(a) == canon(b)


def parse_scope(raw) -> list:
    """Requested scopes (space-separated) → the canonical list; all when none is asked.
    Raises ValueError on an unknown scope."""
    return normalize_scopes(raw.split()) if (raw or "").strip() else list(API_SCOPES)


def redirect_with(uri: str, **params) -> str:
    """`uri` with the response parameters appended (empty values left out)."""
    query = urlencode({k: v for k, v in params.items() if v})
    return uri + ("&" if "?" in uri else "?") + query


# ── PKCE + authorization codes ──────────────────────────────────────────────

def pkce_ok(verifier: str, challenge: str) -> bool:
    """S256: base64url(sha256(verifier)) == challenge, verifier 43..128 characters."""
    if not (43 <= len(verifier or "") <= 128) or not challenge:
        return False
    digest = hashlib.sha256(verifier.encode("ascii", "replace")).digest()
    expected = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return hmac.compare_digest(expected, challenge)


_CODES: dict = {}
_CODES_LOCK = threading.Lock()


def issue_code(**grant) -> str:
    """A single-use authorization code carrying `grant`, valid CODE_TTL seconds. Kept in
    memory: it lives a minute, and a restart only makes the person click Allow again."""
    code = secrets.token_urlsafe(32)
    now = time.time()
    with _CODES_LOCK:
        for key in [k for k, v in _CODES.items() if v["expires"] <= now]:
            del _CODES[key]
        _CODES[hashlib.sha256(code.encode()).hexdigest()] = {**grant, "expires": now + CODE_TTL}
    return code


def redeem_code(code: str):
    """The grant behind `code`, consumed (a second redemption finds nothing); None when
    unknown or expired."""
    with _CODES_LOCK:
        entry = _CODES.pop(hashlib.sha256((code or "").encode()).hexdigest(), None)
    return entry if entry and entry["expires"] > time.time() else None


# ── clients ─────────────────────────────────────────────────────────────────

def valid_redirect_uri(uri) -> bool:
    """https anywhere, plain http only back to this machine (native/CLI clients); never
    a fragment, credentials or another scheme (javascript:, data:…)."""
    if not isinstance(uri, str) or len(uri) > 2000:
        return False
    p = urlsplit(uri)
    if p.fragment or p.username or p.password or not p.hostname:
        return False
    return p.scheme == "https" or (p.scheme == "http" and p.hostname in _LOOPBACK_HOSTS)


def resolve_client(client_id: str) -> dict:
    """{client_id, client_name, redirect_uris, host} of a CIMD URL or a DCR client_id.
    Raises ClientError when it can't be identified."""
    if client_id.startswith("https://"):
        if not _s.CONFIG.oauth_client_metadata_fetch:
            raise ClientError("this Atlas does not fetch client metadata documents")
        return _cimd_client(client_id)
    client = _s.get_store().get_oauth_client(client_id) if client_id else None
    if client is None:
        raise ClientError("unknown client")
    hosts = {urlsplit(u).hostname for u in client["redirect_uris"]}
    return {**client, "host": ", ".join(sorted(h for h in hosts if h))}


_CIMD_CACHE: dict = {}
_CIMD_LOCK = threading.Lock()


def _cimd_client(url: str) -> dict:
    with _CIMD_LOCK:
        hit = _CIMD_CACHE.get(url)
    if hit and hit[0] > time.time():
        return hit[1]
    client = client_from_metadata(url, _fetch_metadata(url))
    with _CIMD_LOCK:
        _CIMD_CACHE[url] = (time.time() + _CIMD_TTL, client)
    return client


def client_from_metadata(url: str, doc) -> dict:
    """The client a metadata document describes, checked. Atlas authenticates clients as
    public only (PKCE binds the code): a client preferring another method is accepted
    when it also lists none, as ChatGPT does next to its private_key_jwt."""
    if not isinstance(doc, dict) or doc.get("client_id") != url:
        raise ClientError("the metadata document does not name this client_id")
    uris = doc.get("redirect_uris")
    if not isinstance(uris, list) or not uris or not all(valid_redirect_uri(u) for u in uris):
        raise ClientError("the metadata document has no valid redirect_uris")
    supported = doc.get("token_endpoint_auth_methods_supported")
    if (doc.get("token_endpoint_auth_method", "none") != "none"
            and not (isinstance(supported, list) and "none" in supported)):
        raise ClientError("only public clients are supported (token_endpoint_auth_method none)")
    host = urlsplit(url).hostname
    name = doc.get("client_name") if isinstance(doc.get("client_name"), str) else ""
    return {"client_id": url, "client_name": (name.strip() or host)[:100],
            "redirect_uris": uris, "host": host}


def _public_address(addr: str) -> bool:
    """True for a globally routable unicast address; loopback, private, link-local,
    shared, multicast and reserved ranges (and their IPv4-mapped forms) are refused."""
    ip = ipaddress.ip_address(addr.split("%", 1)[0])
    if ip.version == 6 and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast


class _PinnedHTTPS(http.client.HTTPSConnection):
    """HTTPS to `hostname` (SNI + certificate checked against it) over a socket opened
    to the already-vetted `ip`, so a second DNS answer can't swap in an internal one."""

    def __init__(self, hostname, ip, port, timeout):
        super().__init__(hostname, port, timeout=timeout, context=ssl.create_default_context())
        self._ip = ip

    def connect(self):
        sock = socket.create_connection((self._ip, self.port), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


def _fetch_metadata(url: str) -> dict:
    """GET a client metadata document: https only, public addresses only, no redirect,
    size and time capped."""
    p = urlsplit(url)
    if p.scheme != "https" or not p.hostname or p.username or p.password or p.fragment:
        raise ClientError("client_id must be a plain https URL")
    port = p.port or 443
    try:
        addrs = {info[4][0] for info in socket.getaddrinfo(p.hostname, port, type=socket.SOCK_STREAM)}
    except OSError:
        raise ClientError("the client metadata host does not resolve") from None
    if not addrs or not all(_public_address(a) for a in addrs):
        raise ClientError("the client metadata host is not a public address")
    conn = _PinnedHTTPS(p.hostname, sorted(addrs)[0], port, _CIMD_TIMEOUT)
    try:
        conn.request("GET", (p.path or "/") + (f"?{p.query}" if p.query else ""),
                     headers={"Accept": "application/json", "User-Agent": "atlas-mind"})
        resp = conn.getresponse()
        body = resp.read(_CIMD_MAX_BYTES + 1)
    except (OSError, http.client.HTTPException):
        raise ClientError("the client metadata document could not be fetched") from None
    finally:
        conn.close()
    if resp.status != 200 or len(body) > _CIMD_MAX_BYTES:
        raise ClientError("the client metadata document could not be fetched")
    try:
        return json.loads(body)
    except ValueError:
        raise ClientError("the client metadata document is not JSON") from None
