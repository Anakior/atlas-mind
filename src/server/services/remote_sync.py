"""Federation subscriber: pull remote nodes' content into remotes/<name>/.

RemoteSync mirrors the manifest + file delta of each subscribed node, serialized by
a single lock so the periodic loop and a manual admin /sync never corrupt the same
mirror concurrently. Best-effort: any error (network, publisher offline, revoked
token) lands in the subscription's last_error without crashing — the subscriber
keeps its last good copy. Built once by AppContext (needs the store for the
subscription registry/status; the path/IO/HTTP helpers are shared module-level
infra in server/__init__, imported lazily to avoid an import cycle).
"""
import hashlib
import json
import sys
import threading
import time
from urllib.parse import quote


class RemoteSync:
    def __init__(self, *, store):
        self._store = store
        self._lock = threading.Lock()

    def sync_one(self, remote: dict) -> dict:
        """Pulls the manifest + the delta of a remote node into remotes/<name>/.

        Best-effort: any error (network, publisher offline, revoked token) is
        captured in last_error without crashing — the subscriber keeps its last
        copy. Serialized by the lock so the periodic loop and a manual admin /sync
        cannot corrupt the same mirror concurrently."""
        from server import (_remote_mirror_root, _is_safe_node_name,
                            _mirror_is_under_remotes, _http_get_bearer,
                            _atomic_write_bytes, _prune_empty_dirs)
        store = self._store
        name = remote["name"]
        url = (remote.get("url") or "").rstrip("/")
        token = remote.get("token", "")
        mirror = _remote_mirror_root(name)
        # A malformed/hostile name must never let the mirror escape its own subdir:
        # a "." name would make the mirror the whole remotes/ tree, so the delete
        # pass below would wipe every sibling subscription.
        if not _is_safe_node_name(name) or not _mirror_is_under_remotes(mirror):
            store.update_remote_status(name, {"last_error": "unsafe remote name"})
            return {"ok": False, "error": "unsafe remote name"}
        with self._lock:
            try:
                manifest = json.loads(_http_get_bearer(url + "/api/node/manifest", token))
                files = manifest.get("files", [])
                manifest_hash = hashlib.sha256(json.dumps(
                    sorted((f.get("path", ""), f.get("sha256", "")) for f in files)
                ).encode()).hexdigest()
                wanted = {}
                for f in files:
                    rel = f.get("path", "")
                    if not rel or rel.startswith("/") or ".." in rel.split("/"):
                        continue  # anti-traversal guard on paths coming from the remote
                    wanted[rel] = f.get("sha256", "")
                mirror.mkdir(parents=True, exist_ok=True)
                mirror_resolved = mirror.resolve()
                # 1. Download the delta (file missing or sha differs).
                for rel, sha in wanted.items():
                    dest = mirror / rel
                    try:
                        dest.resolve().relative_to(mirror_resolved)
                    except (ValueError, OSError):
                        continue
                    if dest.exists() and hashlib.sha256(dest.read_bytes()).hexdigest() == sha:
                        continue
                    body = _http_get_bearer(url + "/api/node/file?path=" + quote(rel), token)
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    _atomic_write_bytes(dest, body)
                # 2. Delete locally whatever disappeared from the remote manifest.
                #    Guard: an empty manifest while the mirror still holds files is
                #    almost always a transient publisher error — keep the last good
                #    copy (else the deletion gets committed/pushed). Self-heals on
                #    the next good sync.
                existing = [p for p in mirror.rglob("*") if p.is_file()]
                if wanted or not existing:
                    for path in existing:
                        if path.relative_to(mirror).as_posix() not in wanted:
                            path.unlink()
                    _prune_empty_dirs(mirror)
                else:
                    print(f"[sync] {name}: empty manifest, keeping "
                          f"{len(existing)} existing file(s)", file=sys.stderr)
                store.update_remote_status(name, {
                    "last_sync_at": int(time.time()),
                    "last_manifest_hash": manifest_hash,
                    "last_error": "",
                })
                return {"ok": True, "files": len(wanted)}
            except Exception as e:
                store.update_remote_status(name, {"last_error": str(e)[:200]})
                return {"ok": False, "error": str(e)}

    def sync_all(self) -> bool:
        """Resyncs all subscriptions (periodic loop). Best-effort; returns True if
        at least one mirror could be refreshed (→ index rebuild)."""
        try:
            remotes = self._store.list_remotes(include_token=True)
        except Exception as e:
            print(f"[sync_all_remotes] list failed: {e}", file=sys.stderr, flush=True)
            return False
        refreshed = False
        for remote in remotes:
            if self.sync_one(remote).get("ok"):
                refreshed = True
        return refreshed
