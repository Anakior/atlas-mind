"""The mind's own git over HTTPS, for a copy on your computer without GitHub:
`git clone https://<instance>/git`, the password being one of your access tokens.
git's http-backend speaks the protocol; Atlas authenticates, lets only the owner of a
mind that is theirs alone in (a clone carries every file and the whole history), runs
pushes under the repo lock, and refuses one that changes anything but the notes
(server.pure.push_guard). A push lands in the working tree, then the mind rebuilds."""
import base64
import binascii
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import server as _s
from server.pure import push_guard

_SERVICES = ("/info/refs", "/git-upload-pack", "/git-receive-pack")
_MAX_PUSH_BYTES = 1 << 30
_HOOK = '#!/bin/sh\nexec "$ATLAS_PYTHON" "$ATLAS_PUSH_GUARD"\n'
_CONFIG = {
    "http.receivepack": "true",
    "receive.denyCurrentBranch": "updateInstead",
    "receive.denyNonFastForwards": "true",
    "receive.denyDeletes": "true",
}


def _token(authorization: str) -> str:
    scheme, _, value = (authorization or "").partition(" ")
    if scheme.lower() != "basic":
        return ""
    try:
        return base64.b64decode(value.strip(), validate=True).decode("utf-8").partition(":")[2]
    except (binascii.Error, UnicodeDecodeError):
        return ""


def _owner(handler, need):
    """The email behind the Basic password when it is an access token of the mind's only
    account with the `need` scope (read to copy, write to push), None otherwise (the
    reason already sent)."""
    token = _token(handler.headers.get("Authorization"))
    ident = _s.verify_api_bearer("Bearer " + token) if token else None
    if not ident:
        handler.send_response(401)
        handler.send_header("WWW-Authenticate", f'Basic realm="{_s.CONFIG.site_name}"')
        handler.send_header("Content-Length", "0")
        handler.end_headers()
        return None
    if not _s.api_rate_limit_ok(_s._hash_api_token(token)):
        _plain(handler, 429, "Too many requests, try again in a minute.")
        return None
    owner = _s.whole_mind_owner()
    if not owner or ident.get("acts_as") != owner:
        _plain(handler, 403, "Only the owner of a mind with a single account can copy it with git: "
                             "a copy carries every file and the whole history.")
        return None
    scopes = _s.viewer_ctx(ident).scopes
    if scopes is not None and need not in scopes:
        _plain(handler, 403, "This access token is limited to " + ", ".join(sorted(scopes))
                             + (": it may not send changes." if need == "write" else ": it may not copy the mind."))
        return None
    return owner


def _plain(handler, status, text):
    body = (text + "\n").encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "text/plain; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _hooks_dir() -> Path:
    hooks = Path(_s.CONFIG.store_dir) / "git-hooks"
    hook = hooks / "pre-receive"
    if not hook.exists() or hook.read_text(encoding="utf-8") != _HOOK:
        hooks.mkdir(parents=True, exist_ok=True)
        hook.write_text(_HOOK, encoding="utf-8", newline="\n")
        hook.chmod(0o755)
    return hooks


def _env(handler, path_info, email, length):
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    config = {**_CONFIG, "core.hooksPath": _hooks_dir().as_posix()}
    env.update({
        "GIT_PROJECT_ROOT": str(_s.CONFIG.root),
        "GIT_HTTP_EXPORT_ALL": "1",
        "PATH_INFO": path_info,
        "REQUEST_METHOD": handler.command,
        "QUERY_STRING": urlsplit(handler.path).query,
        "CONTENT_TYPE": handler.headers.get("Content-Type", ""),
        "CONTENT_LENGTH": str(length),
        "REMOTE_USER": email,
        "REMOTE_ADDR": handler._client_ip(),
        "ATLAS_PYTHON": sys.executable,
        "ATLAS_PUSH_GUARD": push_guard.__file__,
        "GIT_CONFIG_COUNT": str(len(config)),
    })
    for i, (key, value) in enumerate(config.items()):
        env[f"GIT_CONFIG_KEY_{i}"] = key
        env[f"GIT_CONFIG_VALUE_{i}"] = value
    for header, var in (("Content-Encoding", "HTTP_CONTENT_ENCODING"), ("Git-Protocol", "GIT_PROTOCOL")):
        if handler.headers.get(header):
            env[var] = handler.headers[header]
    return env


def _relay(handler, proc):
    """http-backend's CGI answer to the client: its headers, then the body as it comes
    (HTTP/1.0: the closed connection ends it, a clone is never held in memory)."""
    status, headers = 200, []
    for line in iter(proc.stdout.readline, b""):
        line = line.rstrip(b"\r\n").decode("latin-1")
        if not line:
            break
        name, _, value = line.partition(":")
        if name.lower() == "status":
            status = int(value.split()[0])
        else:
            headers.append((name, value.strip()))
    handler.send_response(status)
    for name, value in headers:
        handler.send_header(name, value)
    handler.end_headers()
    handler.close_connection = True
    while block := proc.stdout.read1(1 << 16):
        handler.wfile.write(block)


def handle(handler):
    """GET /git/info/refs, POST /git/git-upload-pack and /git/git-receive-pack."""
    path_info = urlsplit(handler.path).path[len("/git"):]
    if _s.CONFIG.dev_mode or path_info not in _SERVICES or shutil.which("git") is None:
        _plain(handler, 404, "Not found.")
        return
    # A push is announced on GET /info/refs (?service=) before its POST: both need write.
    push = (path_info == "/git-receive-pack"
            or "git-receive-pack" in parse_qs(urlsplit(handler.path).query).get("service", []))
    email = _owner(handler, "write" if push else "read")
    if not email:
        return
    with tempfile.TemporaryFile() as body:
        length = handler._spool_body_or_4xx(body, _MAX_PUSH_BYTES)
        if length is None:
            return
        body.seek(0)

        def backend():
            proc = subprocess.Popen(["git", "http-backend"], stdin=body, stdout=subprocess.PIPE,
                                    env=_env(handler, path_info, email, length), cwd=str(_s.CONFIG.root))
            try:
                _relay(handler, proc)
            finally:
                proc.stdout.close()
                proc.wait()

        if not push:
            backend()
            return
        _s._CTX.git_sync.settled(backend)
    _s._CTX.git_sync.sync_now()

