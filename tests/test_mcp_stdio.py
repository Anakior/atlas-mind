"""`atlas mcp <dir>`: MCP over stdio, the transport an MCP directory's generated config uses
(`uvx atlas-mind mcp <dir>`). The CLI runs in a subprocess, its stdin/stdout piped: stdout
must carry JSON-RPC and nothing else, a write is the agent's (AI trailers), a cloud mind is
refused."""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

_TESTS_DIR = str(Path(__file__).resolve().parent)
if _TESTS_DIR not in sys.path:
    sys.path.insert(0, _TESTS_DIR)

from test_cli import CLI, clean_env  # noqa: E402

_GIT_ID = {"GIT_AUTHOR_NAME": "T", "GIT_AUTHOR_EMAIL": "t@example.com",
           "GIT_COMMITTER_NAME": "T", "GIT_COMMITTER_EMAIL": "t@example.com"}


def _rpc(id_, method, params=None) -> bytes:
    return json.dumps({"jsonrpc": "2.0", "id": id_, "method": method,
                       "params": params or {}}).encode() + b"\n"


def _call(id_, tool, arguments) -> bytes:
    return _rpc(id_, "tools/call", {"name": tool, "arguments": arguments})


def _session(mind, *lines, **env):
    """Send `lines` then close stdin, as a client does on quit → (exit code, answers by id, stderr)."""
    proc = subprocess.run([sys.executable, str(CLI), "mcp", str(mind)], input=b"".join(lines),
                          capture_output=True, timeout=90, env=clean_env(**_GIT_ID, **env))
    # Every stdout line is a JSON-RPC message: a stray print would break the client.
    answers = [json.loads(line) for line in proc.stdout.splitlines()]
    return proc.returncode, {a.get("id"): a for a in answers}, proc.stderr.decode("utf-8", "replace")


@unittest.skipUnless(shutil.which("git"), "git not available")
class TestMcpStdio(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="atlas-stdio-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.mind = self.tmp / "mind"

    def test_a_missing_folder_becomes_a_mind_and_stdout_stays_protocol(self):
        code, by_id, err = _session(
            self.mind,
            _rpc(1, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                   "clientInfo": {"name": "t", "version": "0"}}),
            b'{"jsonrpc":"2.0","method":"notifications/initialized"}\n',
            b"not json\n",
            _rpc(2, "tools/list"))
        self.assertEqual(code, 0, err)
        self.assertTrue((self.mind / "content").is_dir())
        self.assertEqual(by_id[1]["result"]["protocolVersion"], "2025-06-18")
        self.assertEqual(by_id[None]["error"]["code"], -32700)  # a bad line, and it goes on
        names = {t["name"] for t in by_id[2]["result"]["tools"]}
        self.assertTrue({"read_doc", "create_doc", "create_inbox_item"} <= names)
        self.assertIn("creating one", err)  # the scaffold's report went to stderr

    def test_a_write_is_the_agents_and_reads_back(self):
        code, by_id, err = _session(
            self.mind,
            _call(1, "create_doc", {"path": "notes/hello.md", "content": "# Hello\n\nbody\n",
                                    "ai": "claude"}),
            _call(2, "read_doc", {"path": "notes/hello.md"}),
            _call(3, "create_inbox_item", {"title": "An idea", "content": "later"}))
        self.assertEqual(code, 0, err)
        for i in (1, 2, 3):
            self.assertFalse(by_id[i]["result"].get("isError"), by_id[i])
        self.assertIn("body", by_id[2]["result"]["content"][0]["text"])
        self.assertTrue((self.mind / "content" / "notes" / "hello.md").is_file())
        self.assertTrue(any((self.mind / "content" / "inbox" / "shared" / "stdio").glob("*.md")))
        log = subprocess.run(["git", "-C", str(self.mind), "log", "--format=%B"],
                             capture_output=True, text=True).stdout
        self.assertIn("X-Atlas-Author: ai/claude", log)
        self.assertIn("X-Atlas-Token: stdio", log)

    def test_a_machine_without_git_identity_still_commits(self):
        env = clean_env()
        for var in _GIT_ID:
            env.pop(var, None)
        proc = subprocess.run([sys.executable, str(CLI), "mcp", str(self.mind)],
                              input=_call(1, "create_doc", {"path": "a.md", "content": "# A\n"}),
                              capture_output=True, timeout=90, env=env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        log = subprocess.run(["git", "-C", str(self.mind), "log", "-1", "--format=%s"],
                             capture_output=True, text=True, env=env).stdout
        self.assertEqual(log.strip(), "created: a")

    def test_a_cloud_mind_is_refused(self):
        code, by_id, err = _session(self.mind, _rpc(1, "tools/list"),
                                    KB_AUTH_ENABLED="1", ATLAS_STORE="file",
                                    SESSION_SECRET="stdio-test-secret-0123456789abcdef")
        self.assertNotEqual(code, 0)
        self.assertEqual(by_id, {})
        self.assertIn("/mcp", err)


if __name__ == "__main__":
    unittest.main()
