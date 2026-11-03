"""POST /api/admin/restore — a mind back from the zip "Export my notes" or a full backup
made (server.pure.restore): its whole history when the zip carries it, else its files laid
over the notes here; a full backup's registry too (the account comes back as it was: one
signs in again with its password). For the owner of a mind that is theirs alone, and not
while a GitHub copy is connected: a replaced history would part ways with it (disconnect
it first)."""
import tempfile
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
            bundle, files, registry = restore.read_backup(backup)
            if bundle and git_sync.remote_url():
                handler._send_json(409, {"error": "github_connected"})
                return
            if bundle:
                git_sync.settled(lambda: restore.restore_history(_s.CONFIG.root, backup, bundle))
                result = {"mode": "history", "count": None}
            else:
                count = git_sync.settled(lambda: restore.restore_files(_s.CONFIG.content_root, backup, files))
                result = {"mode": "files", "count": count}
            if registry:
                restore.restore_registry(Path(_s.CONFIG.store_dir), backup, registry)
            result["registry"] = bool(registry)
        except restore.RestoreError as e:
            handler._send_json(400, {"error": e.code, "detail": str(e)})
            return
    git_sync.sync_now()
    handler._send_json(200, result)
