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
