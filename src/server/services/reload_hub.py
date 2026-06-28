"""Live-reload SSE fan-out + the file watcher driving it (local-dev convenience,
harmless in cloud).

ReloadHub holds the open Server-Sent-Events clients; broadcast() pushes
'data: reload' to each and drops the dead connections. watch_loop() (started as a
daemon thread by run()) polls dist/index.html's hash every second and broadcasts
when it changes. Built once by AppContext; the /api/events handler register()s /
unregister()s the live Handler.
"""
import hashlib
import threading
import time


class ReloadHub:
    def __init__(self):
        self._clients = []
        self._lock = threading.Lock()

    def register(self, client) -> None:
        with self._lock:
            self._clients.append(client)

    def unregister(self, client) -> None:
        with self._lock:
            if client in self._clients:
                self._clients.remove(client)

    def broadcast(self) -> None:
        """Push a reload event to every open client; drop the ones that died."""
        with self._lock:
            dead = []
            for client in self._clients:
                try:
                    client.wfile.write(b"data: reload\n\n")
                    client.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, OSError):
                    dead.append(client)
            for d in dead:
                self._clients.remove(d)

    @staticmethod
    def _index_hash(index_file):
        try:
            return hashlib.md5(index_file.read_bytes()).hexdigest()
        except (FileNotFoundError, OSError):
            return None

    def watch_loop(self, config) -> None:
        """Poll dist/index.html's hash every second and broadcast a reload when it
        changes (local-dev live reload). Run as a daemon thread by run()."""
        last_hash = self._index_hash(config.index_file)
        while True:
            time.sleep(1)
            current = self._index_hash(config.index_file)
            if current is None or current == last_hash:
                continue
            last_hash = current
            self.broadcast()

    # Editable viewer-source subdirs (never vendor/ or tailwind/node_modules, which
    # would make the mtime poll crawl over thousands of files every second).
    _WATCHED_SUBDIRS = ('partials', 'styles', 'lib', 'pages', 'i18n')

    def _sources_sig(self, config) -> float:
        """Newest mtime across the engine's editable viewer sources (config.web_dir):
        its top-level files + the editable subdirs, recursively."""
        latest = 0.0
        candidates = []
        try:
            candidates += [p for p in config.web_dir.iterdir() if p.is_file()]
        except OSError:
            pass
        for sub in self._WATCHED_SUBDIRS:
            d = config.web_dir / sub
            if d.is_dir():
                candidates += [p for p in d.rglob('*') if p.is_file()]
        for p in candidates:
            try:
                latest = max(latest, p.stat().st_mtime)
            except OSError:
                pass
        return latest

    def watch_sources_loop(self, config, build_fn) -> None:
        """Dev-only: poll the editable web sources and rebuild on change, so editing
        a partial/js/css/page refreshes the viewer without a manual `atlas build`.
        The rebuild rewrites dist/index.html, which watch_loop() then detects to push
        the reload event to the browser. A build error is logged but never kills the
        watcher. Run as a daemon thread by run() when config.dev_mode."""
        last = self._sources_sig(config)
        while True:
            time.sleep(1)
            current = self._sources_sig(config)
            if current == last:
                continue
            last = current
            try:
                result = build_fn()
                if getattr(result, 'returncode', 0) != 0:
                    print(f"[dev-watch] build exited {result.returncode}", flush=True)
                else:
                    print("[dev-watch] sources changed -> rebuilt viewer", flush=True)
            except Exception as e:  # a transient build failure must not stop the loop
                print(f"[dev-watch] rebuild failed: {e}", flush=True)
