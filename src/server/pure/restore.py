"""Getting a mind back after losing its instance, from the zip "Export my notes" made
(server.pure.export): its history bundle when it carries one — every version comes
back — else its files, laid over the notes already here. Replacing the history never
loses the current one: it stays under refs/atlas/before-restore."""
import os
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

from server.pure.export import REGISTRY_FILES

BUNDLES = ("historique.bundle", "history.bundle")
# The export's own readme, told apart from a note of the same name by its first line.
READMES = {"LISEZ-MOI.txt": "Tes notes Atlas.", "README.txt": "Your Atlas notes."}
MAX_UNPACKED = 1 << 30
BEFORE = "refs/atlas/before-restore"
_INCOMING = "refs/atlas/incoming"


class RestoreError(ValueError):
    """A backup that cannot be restored; `code` is what the screen explains."""

    def __init__(self, code, detail=""):
        super().__init__(detail or code)
        self.code = code


def _rel(name: str):
    """The member's path below the zip's top folder, None for one to skip; RestoreError
    for a path reaching outside it."""
    if name.endswith("/"):
        return None
    path = PurePosixPath(name)
    if "\\" in name or path.is_absolute() or ".." in path.parts or ":" in path.parts[0]:
        raise RestoreError("bad_zip", f"unsafe path in the zip: {name}")
    return path


def read_backup(zip_path: Path):
    """(bundle member or None, [(member, content-relative path)], [(member, registry file)])
    of an export zip; the registry only in a full backup."""
    try:
        z = zipfile.ZipFile(zip_path)
    except zipfile.BadZipFile:
        raise RestoreError("bad_zip", "not a zip file")
    with z:
        infos = [(i, _rel(i.filename)) for i in z.infolist()]
        infos = [(i, p) for i, p in infos if p is not None]
        if sum(i.file_size for i, _ in infos) > MAX_UNPACKED:
            raise RestoreError("too_large")
        tops = {p.parts[0] for _, p in infos if len(p.parts) > 1}
        strip = 1 if len(tops) == 1 and all(len(p.parts) > 1 for _, p in infos) else 0
        bundle, files, registry = None, [], []
        for info, path in infos:
            rel = PurePosixPath(*path.parts[strip:])
            if len(rel.parts) == 2 and rel.parts[0] == ".atlas" and rel.name in REGISTRY_FILES:
                registry.append((info.filename, rel.name))
                continue
            if any(part.startswith(".") for part in rel.parts):
                continue
            if len(rel.parts) == 1 and rel.name in BUNDLES:
                bundle = info.filename
            elif len(rel.parts) == 1 and rel.name in READMES and \
                    z.read(info).decode("utf-8", "replace").startswith(READMES[rel.name]):
                continue
            else:
                files.append((info.filename, rel.as_posix()))
    return bundle, files, registry


def _git(repo, *args, timeout=300):
    return subprocess.run(["git", *args], cwd=str(repo), capture_output=True, text=True,
                          timeout=timeout)


def adopt(repo: Path, ref: str) -> None:
    """Make `ref` (a fetched Atlas history) the mind's history, the current one kept
    under BEFORE. RestoreError when `ref` holds no Atlas mind."""
    if _git(repo, "cat-file", "-e", f"{ref}:content").returncode:
        raise RestoreError("not_atlas", "no content/ folder in that history")
    _git(repo, "update-ref", BEFORE, "HEAD")
    reset = _git(repo, "reset", "--hard", "--quiet", ref)
    if reset.returncode:
        raise RestoreError("other", reset.stderr.strip())


def restore_history(repo: Path, zip_path: Path, member: str) -> None:
    """The bundle's main branch becomes the mind's history."""
    with tempfile.TemporaryDirectory() as tmp:
        bundle = Path(tmp) / "history.bundle"
        with zipfile.ZipFile(zip_path) as z, z.open(member) as src, open(bundle, "wb") as dst:
            shutil.copyfileobj(src, dst)
        heads = _git(repo, "bundle", "list-heads", str(bundle))
        if heads.returncode:
            raise RestoreError("bad_zip", "the history in the zip is damaged")
        names = [line.split()[1] for line in heads.stdout.splitlines() if len(line.split()) == 2]
        head = next((n for n in ("refs/heads/main", "refs/heads/master", "HEAD") if n in names), None)
        if head is None:
            raise RestoreError("bad_zip", "no main branch in the zip's history")
        fetched = _git(repo, "fetch", "--quiet", "--no-tags", str(bundle), f"+{head}:{_INCOMING}")
        if fetched.returncode:
            raise RestoreError("bad_zip", fetched.stderr.strip())
        try:
            adopt(repo, _INCOMING)
        finally:
            _git(repo, "update-ref", "-d", _INCOMING)


def restore_registry(store_dir: Path, zip_path: Path, registry) -> None:
    """The registry as the full backup had it: its files put back, each replaced whole (a
    reader never sees half a file), and those it had not yet (tasks made since) gone."""
    store_dir.mkdir(parents=True, exist_ok=True)
    kept = {name for _, name in registry}
    for name in REGISTRY_FILES:
        if name not in kept:
            (store_dir / name).unlink(missing_ok=True)
    with zipfile.ZipFile(zip_path) as z:
        for member, name in registry:
            tmp = store_dir / (name + ".restoring")
            with z.open(member) as src, open(tmp, "wb") as dst:
                shutil.copyfileobj(src, dst)
            os.chmod(tmp, 0o600)
            os.replace(tmp, store_dir / name)


def restore_files(content_root: Path, zip_path: Path, files) -> int:
    """The zip's files laid over the notes: same path → the backup's version; the rest
    stays. Returns how many were written."""
    root = content_root.resolve()
    with zipfile.ZipFile(zip_path) as z:
        for member, rel in files:
            target = (root / rel).resolve()
            if root not in target.parents:
                raise RestoreError("bad_zip", f"unsafe path in the zip: {rel}")
            target.parent.mkdir(parents=True, exist_ok=True)
            with z.open(member) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst)
    return len(files)
