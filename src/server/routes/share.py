"""Share-link routes: public shared page + admin list/create/revoke/reactivate.

A share link is an opaque CAPABILITY token (random key, no signed payload) served
at /s/<token>. Its target path lives in the registry, not in the token — so a link
survives the doc being moved/renamed: auto re-pointed on an in-app move (see
routes.docs), or reactivated from the admin UI (repoint) when the doc moved outside
the app. Old path-encoded tokens are not supported (clean cutover).
"""
import re
import sys
import time
import server as _s


def page(handler):
    """GET /s/<token> — a public shared link. The token is an opaque capability
    key resolved against the registry (the target path lives there, not in it)."""
    handler._serve_share(handler.path[len("/s/"):])


def _suggest_current_path(old_rel: str):
    """Best-effort: where did `old_rel` move to? Find the most recent git rename
    whose SOURCE is `old_rel` and return its target if that file exists today.
    Returns a current relative path (≠ old_rel) or None — only to pre-fill the
    admin reactivation prompt, never authoritative."""
    repo_old = "content/" + old_rel
    try:
        # No pathspec: restricting to the old path before rename detection would
        # degrade the rename to a plain delete. -M over the full tree keeps the
        # "R<score>\t<src>\t<dst>" rows; log is newest-first, so the first row whose
        # source is repo_old is the latest move.
        out = _s.git("log", "-M", "--diff-filter=R", "--name-status", "--format=")
    except Exception:
        return None
    if out.returncode != 0:
        return None
    for line in out.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) != 3 or not parts[0].startswith("R") or parts[1] != repo_old:
            continue
        if not parts[2].startswith("content/"):
            continue
        candidate = parts[2][len("content/"):]
        target = _s._validate_doc_path(candidate)
        if candidate != old_rel and target and target.exists():
            return candidate
    return None


def _annotate_share(doc):
    """Annotate a share record for the admin UI with target liveness: `file_exists`
    and, when the target moved/disappeared, a `suggested_path` (git rename history)
    so a broken link can be reactivated in one click."""
    rel = doc.get("path") or ""
    target = _s._validate_doc_path(rel)
    doc["file_exists"] = bool(target and target.exists())
    if not doc["file_exists"] and rel:
        suggestion = _suggest_current_path(rel)
        if suggestion:
            doc["suggested_path"] = suggestion


def list_shares(handler):
    """GET /api/share/list — admin: the share links, each with a copyable token and
    a `file_exists` flag (a moved/deleted target is flagged broken, with a
    `suggested_path` so it can be reactivated)."""
    from urllib.parse import urlparse, parse_qs as _pqs
    query = _pqs(urlparse(handler.path).query)
    filter_path = (query.get("path", [""])[0] or "").strip()
    include_revoked = query.get("include_revoked", ["0"])[0] == "1"
    try:
        docs = _s.get_store().list_shares(
            path=filter_path or None,
            include_revoked=include_revoked,
            limit=200,
        )
        for doc in docs:
            _annotate_share(doc)
        handler._send_json(200, docs)
    except Exception as e:
        handler._send_json(500, {"error": str(e)})


def _resolve_target(handler, rel):
    """Validate `rel` as an existing in-root .md/.html doc. On failure, send the
    granular error (400 invalid path / 403 outside root / 404 not found) and return
    None; otherwise return the resolved Path. Shared by create() and repoint()."""
    if not rel or rel.endswith("/") or ".." in rel.split("/"):
        handler._send_json(400, {"error": "invalid path"})
        return None
    target = (_s.CONFIG.content_root / rel).resolve()
    try:
        target.relative_to(_s.CONFIG.content_root)
    except ValueError:
        handler._send_json(403, {"error": "outside root"})
        return None
    if not target.exists() or target.suffix.lower() not in (".md", ".html"):
        handler._send_json(404, {"error": "document not found"})
        return None
    return target


def create(handler):
    """POST /api/share — mint an opaque capability link for a doc.

    The token is random; the target path is persisted in the registry (the single
    source of truth), so the link survives the doc being moved/renamed. Nothing is
    written into the document content."""
    data = handler._read_json()
    rel = (data.get("path") or "").strip()
    days = _s._safe_int(data.get("expires_days"))
    if _resolve_target(handler, rel) is None:
        return
    exp = int(time.time() + days * 86400) if days > 0 else 0
    token = _s.new_share_token()
    sess = handler._session()
    try:
        # The registry is the source of truth in BOTH modes — persist before
        # returning, so the link resolves (no stateless fallback any more).
        doc_id = _s.get_store().insert_share({
            "path": rel,
            "token": token,
            "expires_at": exp,
            "created_at": int(time.time()),
            "created_by": (sess or {}).get("email"),
            "revoked": False,
        })
    except Exception as e:
        print(f"[share create] {e}", file=sys.stderr)
        handler._send_json(500, {"error": "could not create share link"})
        return
    handler._send_json(200, {
        "id": doc_id, "token": token, "path": rel, "expires_at": exp,
    })


def repoint(handler):
    """PATCH /api/share/<id> {path} — reactivate a link by pointing it at a new
    target (admin + CSRF already enforced at the verb level in do_PATCH). The link
    URL (token) is unchanged: only the stored target moves. The id is an EXACT
    24-hex legacy id or a uuid4 (matched by _SHARE_ID_PATTERN, re-read here)."""
    m = re.match(_s._SHARE_ID_PATTERN, handler.path)
    data = handler._read_json()
    rel = (data.get("path") or "").strip()
    if _resolve_target(handler, rel) is None:
        return
    try:
        if not _s.get_store().repoint_share(m.group(1), rel):
            handler._send_json(404, {"error": "not found or revoked"})
            return
        handler._send_json(200, {"ok": True, "path": rel})
    except Exception as e:
        handler._send_json(500, {"error": str(e)})


def revoke(handler):
    """DELETE /api/share/<id> — soft-delete (revoke) a share link (admin + CSRF
    already enforced by the verb-level guard in do_DELETE). The id is an EXACT
    24-hex legacy id or a uuid4 8-4-4-4-12 (matched by _SHARE_ID_PATTERN,
    re-read here from the path)."""
    m = re.match(_s._SHARE_ID_PATTERN, handler.path)
    try:
        if not _s.get_store().revoke_share(m.group(1)):
            handler._send_json(404, {"error": "not found or already revoked"})
            return
        handler._send_json(200, {"ok": True})
    except Exception as e:
        handler._send_json(500, {"error": str(e)})
