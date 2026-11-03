"""Admin routes behind Settings > Copies. On GitHub, with the instance's own deploy key
(server.pure.github_remote): show or make the key, connect an empty private repo (the
whole mind is pushed there) or take the mind back from one that holds it, disconnect;
the sync loop then keeps the copy current. On
the computer: the address to clone (routes/git.py), when the mind is this person's alone."""
import server as _s
from server.pure import github_remote, restore
from server.services.git_sync import mask_url


def _state(handler):
    url = _s._CTX.git_sync.remote_url()
    me = (handler._session() or {}).get("email")
    owner = bool(me) and _s.whole_mind_owner() == me
    return {"remote": mask_url(url) if url else None,
            "key": github_remote.existing_key(_s.CONFIG.store_dir),
            "owner": owner,
            "clone": handler._public_url("/git") if owner else None}


def get(handler):
    """GET /api/admin/github — the mind's remote (credentials masked), the deploy key,
    whether the mind is this person's alone (a copy on the computer, a restore), and the
    address that copy clones."""
    handler._send_json(200, _state(handler))


def make_key(handler):
    """POST /api/admin/github/key — make the instance's deploy key (once; then the same)."""
    try:
        github_remote.make_key(_s.CONFIG.store_dir, f"atlas@{_s.CONFIG.site_slug}")
    except RuntimeError as e:
        handler._send_json(500, {"error": "no_ssh", "detail": str(e)})
        return
    handler._send_json(200, _state(handler))


def _ready_repo(handler, owner_only=False):
    """The GitHub repo the request names, once the instance can reach it with its key;
    None when not (the reason already sent)."""
    repo = github_remote.parse_repo(handler._read_json().get("repo"))
    store_dir = _s.CONFIG.store_dir
    me = (handler._session() or {}).get("email")
    refusal = ((400, "dev_mode") if _s.CONFIG.dev_mode
               else (403, "shared") if owner_only and _s.whole_mind_owner() != me
               else (400, "bad_repo") if not repo
               else (409, "already_connected") if _s._CTX.git_sync.remote_url()
               else (400, "no_key") if not github_remote.existing_key(store_dir)
               else None)
    if refusal:
        handler._send_json(refusal[0], {"error": refusal[1]})
        return None
    try:
        github_remote.write_known_hosts(store_dir)
    except Exception as e:
        handler._send_json(502, {"error": "github_unreachable", "detail": str(e)})
        return None
    return repo


def connect(handler):
    """POST /api/admin/github {repo} — push the whole mind to that empty private repo,
    then keep syncing with it. The error is a cause the screen explains (key not added,
    write access unticked, repo not empty…), with git's own words beside it."""
    repo = _ready_repo(handler)
    if not repo:
        return
    ok, message = _s._CTX.git_sync.connect_remote(
        f"git@github.com:{repo}.git", github_remote.ssh_command(_s.CONFIG.store_dir))
    if not ok:
        handler._send_json(400, {"error": github_remote.hint(message), "detail": message})
        return
    handler._send_json(200, _state(handler))


def adopt(handler):
    """POST /api/admin/github/restore {repo} — take the mind back from its GitHub copy:
    the repo's history becomes this mind's (the current one stays reachable), then the
    sync goes on with it. The way back after losing an instance: a new one, the same repo."""
    repo = _ready_repo(handler, owner_only=True)
    if not repo:
        return
    try:
        ok, message = _s._CTX.git_sync.adopt_remote(
            f"git@github.com:{repo}.git", github_remote.ssh_command(_s.CONFIG.store_dir))
    except restore.RestoreError as e:
        handler._send_json(400, {"error": e.code})
        return
    if not ok:
        handler._send_json(400, {"error": github_remote.hint(message), "detail": message})
        return
    _s._CTX.git_sync.sync_now()
    handler._send_json(200, _state(handler))


def disconnect(handler):
    """DELETE /api/admin/github — stop syncing; the mind, its history and the key stay."""
    _s._CTX.git_sync.disconnect_remote()
    handler._send_json(200, _state(handler))
