"""Every change to the mind runs under one lock (server.writing): two edit_doc calls made from
the same base_version give one edit and one conflict, never two successes where one silently
overwrites the other; a write route reads its body before it takes the lock.
Run: python tests/test_write_lock.py"""
import concurrent.futures
import contextlib
import io
import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

SRC = Path(__file__).resolve().parent.parent / "src"
sys.path.insert(0, str(SRC))

import server  # noqa: E402
from server.app import router  # noqa: E402
from server.app.handler import Handler  # noqa: E402
from server.pure import mcp_call  # noqa: E402

TOOLS = json.loads((SRC / "viewer" / "mcp-tools.json").read_text(encoding="utf-8"))


class TestWriteLock(unittest.TestCase):
    def test_two_edits_from_one_version_give_one_conflict(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "note.md"
            path.write_text("# Original\n", encoding="utf-8")
            base = mcp_call._version(path.read_text(encoding="utf-8"))
            real_read, reading = Path.read_text, threading.Event()

            def slow_first_read(target, *args, **kwargs):
                text = real_read(target, *args, **kwargs)
                if target == path and not reading.is_set():
                    reading.set()
                    time.sleep(0.3)  # time enough for the other edit to read the same version
                return text

            def edit(label):
                return mcp_call._mcp_call_tool("edit_doc", {
                    "path": "notes/note.md", "base_version": base, "content": f"# {label}\n"})

            with mock.patch.object(server, "_validate_doc_path", return_value=path), \
                    mock.patch.object(server, "_is_readonly_path", return_value=False), \
                    mock.patch.object(server, "_mcp_tools", return_value=TOOLS), \
                    mock.patch.object(server, "commit_change"), \
                    mock.patch.object(server, "writing", return_value=threading.RLock()), \
                    mock.patch.object(Path, "read_text", slow_first_read):
                with concurrent.futures.ThreadPoolExecutor(2) as pool:
                    first = pool.submit(edit, "A")
                    reading.wait(5)
                    second = pool.submit(edit, "B")
                    results = [first.result(), second.result()]
            self.assertEqual([bool(r.get("isError")) for r in results], [False, True])
            self.assertIn("changed since you read it", results[1]["content"][0]["text"])
            self.assertEqual(path.read_text(encoding="utf-8"), "# A\n")

    def test_a_write_route_reads_its_body_before_the_lock(self):
        handler = SimpleNamespace(path="/x", headers={"content-length": "2"}, rfile=io.BytesIO(b"{}"),
                                  _body_ahead=None, close_connection=False)
        handler._read_body = lambda: Handler._read_body(handler)
        seen = []

        @contextlib.contextmanager
        def writing():
            seen.append(handler.rfile.tell())
            yield

        route = router.Route(router.RouteKind.EXACT, "/x", lambda h: seen.append(h._read_body()), writes=True)
        with mock.patch.object(server, "writing", writing):
            router.dispatch(handler, [route])
        self.assertEqual(seen, [2, b"{}"])
        self.assertIsNone(handler._body_ahead)


if __name__ == "__main__":
    unittest.main()
