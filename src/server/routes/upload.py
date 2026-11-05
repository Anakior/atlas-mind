"""POST /api/upload?path=<where>[&beside=<note>] — one file from the viewer, its bytes as
the body: dropped on the tree, picked from the new-document dialog, pasted or dropped into a
note being written. Never replaces a file: a taken name gets " (2)". A .zip is unpacked into
a folder named after it. A file put `beside` a note (an image pasted into it) is exactly as
private as that note, so whoever reads the note sees it, and nobody else."""
import shutil
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

import server as _s
from server.pure import uploads


def put(handler):
    query = handler._query()
    wanted = (query.get("path") or [""])[0]
    beside = uploads.clean_path((query.get("beside") or [""])[0])
    ctx = handler._viewer_ctx()
    if beside and not _s.can_read(beside, ctx):
        beside = None
    is_zip = wanted.lower().endswith(".zip")
    rel = uploads.clean_path(wanted[:-4]) if is_zip else uploads.clean_rel(wanted)
    if rel is None:
        handler._send_json(400, {"error": "bad_type" if uploads.clean_path(wanted) else "bad_path"})
        return
    if not _allowed(rel, ctx):
        handler._send_json(403, {"error": "forbidden"})
        return
    with tempfile.TemporaryDirectory() as tmp:
        body = Path(tmp) / "body"
        with open(body, "wb") as f:
            if handler._spool_body_or_4xx(f, uploads.MAX_ZIP if is_zip else uploads.MAX_FILE) is None:
                return
        with _s.writing():  # received first: the free name picked stays free until the file is there
            try:
                written, skipped = _unzip(body, rel, ctx) if is_zip else ([_place(body, rel, ctx, beside)], [])
            except uploads.UploadError as e:
                handler._send_json(400, {"error": e.code})
                return
            if written:
                what = PurePosixPath(rel).name + (f" ({len(written)})" if is_zip else "")
                _s.commit_change(ctx, f"created: {what}", *(_s.CONFIG.content_root / p for p in written))
    handler._send_json(200, {"paths": written, "skipped": skipped})


def _allowed(rel, ctx):
    return not _s._is_readonly_path(rel) and (ctx.superuser or _s.can_create(rel, ctx))


def _place(src, rel, ctx, beside):
    rel = uploads.free_rel(_s.CONFIG.content_root, rel)
    target = _s.CONFIG.content_root / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), target)
    _stamp(rel, ctx, beside)
    return rel


def _unzip(body, folder, ctx):
    entries, skipped = uploads.zip_entries(body, folder)
    written = []
    with zipfile.ZipFile(body) as zf:
        for member, rel in entries:
            rel = uploads.free_rel(_s.CONFIG.content_root, rel)
            if not _allowed(rel, ctx):
                skipped.append(member.filename)
                continue
            target = _s.CONFIG.content_root / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(member) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst)
            _stamp(rel, ctx, None)
            written.append(rel)
    return written, skipped


def _stamp(rel, ctx, beside):
    """Who made the file and who may read it: a new doc's default, or the note's own."""
    if not ctx.primary:
        return
    store = _s.get_store()
    store.delete_acl(rel)  # a path recycled after a delete starts clean
    if beside is None:
        _s._stamp_new_doc(rel, ctx)
        return
    store.set_creator(rel, ctx.primary)
    note = store.get_acl(beside) or {}
    if note.get("owner"):
        store.set_owner(rel, note["owner"])
        for g in note.get("grants", []):
            store.grant(rel, g["principal"], g["level"], expires_at=g.get("expires_at") or 0,
                        by=g.get("granted_by"))
