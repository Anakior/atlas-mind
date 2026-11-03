"""Connecting a mind to GitHub without a token or a central app: the instance makes its own
SSH key (kept with the registry, never in git), the person adds its public half to an
empty private repo as a deploy key with write access, and the mind is pushed there."""
import json
import re
import shutil
import subprocess
import urllib.request
from pathlib import Path

KEY_FILE = "github_deploy_ed25519"
KNOWN_HOSTS_FILE = "github_known_hosts"
_REPO = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}")

# What the person can do about a refused first push, from git's own words.
_HINTS = (
    ("read only", "write_access"),
    ("read-only", "write_access"),
    ("permission denied", "key_missing"),
    ("repository not found", "repo_not_found"),
    ("couldn't find remote ref", "repo_empty"),
    ("fetch first", "repo_not_empty"),
    ("non-fast-forward", "repo_not_empty"),
    ("rejected", "repo_not_empty"),
)


def parse_repo(text):
    """'owner/name' from what people paste: the pair itself, an https or git@ URL, a
    trailing .git. None when it isn't one."""
    t = (text or "").strip()
    m = re.search(r"github\.com[:/]+([^/\s]+/[^/\s]+?)/?$", t)
    if m:
        t = m.group(1)
    t = t.removesuffix(".git")
    return t if _REPO.fullmatch(t) else None


def existing_key(store_dir: Path):
    pub = Path(store_dir) / (KEY_FILE + ".pub")
    return pub.read_text(encoding="utf-8").strip() if pub.exists() else None


def make_key(store_dir: Path, comment: str) -> str:
    """The instance's deploy key, made on first ask. RuntimeError when the server has
    no OpenSSH client."""
    if existing_key(store_dir):
        return existing_key(store_dir)
    if shutil.which("ssh-keygen") is None:
        raise RuntimeError("ssh-keygen not found on this server")
    Path(store_dir).mkdir(parents=True, exist_ok=True)
    r = subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", comment,
                        "-f", str(Path(store_dir) / KEY_FILE)],
                       capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or "ssh-keygen failed")
    return existing_key(store_dir)


def write_known_hosts(store_dir: Path) -> None:
    """GitHub's SSH host keys, from its published meta — fetched when the person
    connects, so the first push checks whom it talks to."""
    with urllib.request.urlopen("https://api.github.com/meta", timeout=15) as resp:
        keys = json.load(resp)["ssh_keys"]
    (Path(store_dir) / KNOWN_HOSTS_FILE).write_text(
        "".join(f"github.com {k}\n" for k in keys), encoding="utf-8")


def ssh_command(store_dir: Path) -> str:
    key = (Path(store_dir) / KEY_FILE).as_posix()
    hosts = (Path(store_dir) / KNOWN_HOSTS_FILE).as_posix()
    return (f'ssh -i "{key}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes '
            f'-o UserKnownHostsFile="{hosts}"')


def hint(message: str) -> str:
    low = (message or "").lower()
    return next((h for needle, h in _HINTS if needle in low), "other")
