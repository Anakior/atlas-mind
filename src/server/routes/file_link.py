"""GET /f/<expiry>.<signature>/<path> — one file of the mind through a link read_doc handed
out (server.pure.file_links). No session: the signature is the permission, for that file
and until the expiry."""
import mimetypes
import shutil
from urllib.parse import quote

import server as _s
from server.pure import docs, file_links

# What a browser shows as is; anything else could run as a page on the mind's origin.
_INERT = ("image/", "audio/", "video/", "application/pdf", "text/plain", "text/csv")


def serve(handler):
    rel = file_links.verify(handler.path)
    target = docs.content_file(rel, _s.CONFIG.content_root) if rel else None
    if target is None:
        handler._send_json(404, {"error": "not found"})
        return
    mime = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    handler.send_response(200)
    handler.send_header("Content-Type", mime)
    handler.send_header("Content-Length", str(target.stat().st_size))
    handler.send_header("Content-Disposition", f"inline; filename*=UTF-8''{quote(target.name)}")
    handler.send_header("Cache-Control", "private, no-store")
    handler.send_header("X-Robots-Tag", "noindex")
    if not mime.startswith(_INERT) or mime == "image/svg+xml":
        handler.send_header("Content-Security-Policy", "sandbox")
    handler.end_headers()
    with open(target, "rb") as f:
        shutil.copyfileobj(f, handler.wfile)
