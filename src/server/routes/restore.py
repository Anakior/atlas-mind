"""POST /api/admin/restore — a mind back from the zip "Export my notes" or a full backup
made (server.pure.restore): its whole history when the zip carries it, else its files laid
over the notes here; a full backup's registry too (the account comes back as it was: one
signs in again with its password). For the owner of a mind that is theirs alone, and not
while a GitHub copy is connected: a replaced history would part ways with it (disconnect
it first)."""
import tempfile
import zipfile
from pathlib import Path

import server as _s
from server.pure import restore


def from_backup(handler):
    me = (handler._session() or {}).get("email")
    if not me or _s.whole_mind_owner() != me:
        handler._send_json(403, {"error": "shared"})
        return
    git_sync = _s._CTX.git_sync
    with tempfile.TemporaryDirectory() as tmp:
        backup = Path(tmp) / "backup.zip"
        with open(backup, "wb") as f:
            if handler._spool_body_or_4xx(f, restore.MAX_UNPACKED) is None:
                return
        try:
            bundle, files, registry = restore.read_backup(backup)  # whole zip checked first
            if bundle and git_sync.remote_url():
                handler._send_json(409, {"error": "github_connected"})
                return

            def apply():  # history (or files) and registry in one step under the repo lock
                count = None
                if bundle:
                    restore.restore_history(_s.CONFIG.root, backup, bundle)
                else:
                    count = restore.restore_files(_s.CONFIG.content_root, backup, files)
                if registry:
                    restore.restore_registry(Path(_s.CONFIG.store_dir), backup, registry)
                return count

            count = git_sync.settled(apply)
            if not bundle:
                _s.commit_change(handler._viewer_ctx(), "restored: notes from a backup",
                                 _s.CONFIG.content_root)
            result = {"mode": "history" if bundle else "files", "count": count,
                      "registry": bool(registry)}
        except restore.RestoreError as e:
            handler._send_json(400, {"error": e.code, "detail": str(e)})
            return
        except (OSError, zipfile.BadZipFile) as e:
            handler._send_json(400, {"error": "bad_zip", "detail": str(e)})
            return
    git_sync.sync_now()
    handler._send_json(200, result)
