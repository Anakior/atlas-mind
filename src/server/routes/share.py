"""Share-link routes: public shared page + admin list/create/revoke of signed links."""
import re
import sys
import time
import server as _s


def page(handler):
    """GET /share/<token…> — public shared link, validated by HMAC signature."""
    handler._serve_share(handler.path[len("/share/"):])


def list_shares(handler):
    """GET /api/share/list — admin: the share links (token regenerated for a
    copyable public link, never stored in plaintext)."""
    from urllib.parse import urlparse, parse_qs as _pqs
    query = _pqs(urlparse(handler.path).query)
    filter_path = (query.get("path", [""])[0] or "").strip()
    include_revoked = query.get("include_revoked", ["0"])[0] == "1"
    try:
        # The store never keeps the token in plaintext (FileStore: SHA256
        # only). But the token is a deterministic HMAC of
        # (path, expires_at, SESSION_SECRET) — we REGENERATE it here to
        # display a copyable public link, without storing anything sensitive.
        docs = _s.get_store().list_shares(
            path=filter_path or None,
            include_revoked=include_revoked,
            limit=200,
        )
        for doc in docs:
            if doc.get("token") is None and doc.get("path"):
                doc["token"] = _s.make_share_token(
                    doc["path"], int(doc.get("expires_at") or 0)
                )
        handler._send_json(200, docs)
    except Exception as e:
        handler._send_json(500, {"error": str(e)})


def create(handler):
    """POST /api/share — mint a signed share link for a doc."""
    data = handler._read_json()
    rel = (data.get("path") or "").strip()
    days = _s._safe_int(data.get("expires_days"))
    if not rel or rel.endswith("/") or ".." in rel.split("/"):
        handler._send_json(400, {"error": "invalid path"})
        return
    target = (_s.CONFIG.content_root / rel).resolve()
    try:
        target.relative_to(_s.CONFIG.content_root)
    except ValueError:
        handler._send_json(403, {"error": "outside root"})
        return
    if not target.exists() or target.suffix.lower() not in (".md", ".html"):
        handler._send_json(404, {"error": "document not found"})
        return
    exp = int(time.time() + days * 86400) if days > 0 else 0
    token = _s.make_share_token(rel, exp)
    doc_id = None
    if _s.CONFIG.auth_enabled:
        try:
            sess = handler._session()
            doc_id = _s.get_store().insert_share({
                "path": rel,
                "token": token,
                "expires_at": exp,
                "created_at": int(time.time()),
                "created_by": (sess or {}).get("email"),
                "revoked": False,
            })
        except Exception as e:
            print(f"[share insert] {e}", file=sys.stderr)
    handler._send_json(200, {
        "id": doc_id, "token": token, "path": rel, "expires_at": exp,
    })


def revoke(handler):
    """DELETE /api/share/<id> — soft-delete (revoke) a share link (admin + CSRF
    already enforced by the verb-level guard in do_DELETE). The id is an EXACT
    24-hex legacy id or a uuid4 8-4-4-4-12 (matched by _SHARE_ID_DELETE_PATTERN,
    re-read here from the path)."""
    m = re.match(_s._SHARE_ID_DELETE_PATTERN, handler.path)
    try:
        if not _s.get_store().revoke_share(m.group(1)):
            handler._send_json(404, {"error": "not found or already revoked"})
            return
        handler._send_json(200, {"ok": True})
    except Exception as e:
        handler._send_json(500, {"error": str(e)})
