"""Leaving with one's notes: a zip of the mind's files a person may read — plain files,
readable anywhere — plus, for whoever owns the whole mind, its history as a git bundle.
The trash never goes in, nor the registry (accounts, tokens: .atlas/) but in a full backup,
which carries it under .atlas/ for a restore to put back."""
import subprocess
import tempfile
import zipfile
from pathlib import Path

import store
from server.pure import github_remote

# The registry files a full backup carries: the durable ones and the instance's GitHub key
# (back on a new instance, the same repository connects again with nothing to redo there).
REGISTRY_FILES = store.FileStore.DURABLE_FILES + (
    github_remote.KEY_FILE, github_remote.KEY_FILE + ".pub", github_remote.KNOWN_HOSTS_FILE)

_README = {
    "fr": ("LISEZ-MOI.txt", "historique.bundle", """Tes notes Atlas.

Ce sont des fichiers ordinaires, rangés dans les dossiers de ton Atlas : les notes
(.md) s'ouvrent avec n'importe quel éditeur de texte, ou dans Obsidian, VS Code…
"""),
    "en": ("README.txt", "history.bundle", """Your Atlas notes.

These are ordinary files, in your Atlas's folders: the notes (.md) open in any
text editor, or in Obsidian, VS Code…
"""),
}
_HISTORY_NOTE = {
    "fr": """
{bundle} contient tout l'historique : chaque version de chaque note. Pour le
retrouver, avec git : git clone {bundle} mes-notes
""",
    "en": """
{bundle} holds the whole history: every version of every note. To get it back,
with git: git clone {bundle} my-notes
""",
}
_REGISTRY_NOTE = {
    "fr": """
.atlas/ contient ton compte, tes accès, ta connexion à Claude, tes tâches et tes
réglages. Ce sont des secrets : garde ce fichier en lieu sûr. « Restaurer », dans les
réglages d'un Atlas, remet tout en place.
""",
    "en": """
.atlas/ holds your account, your accesses, your Claude connection, your tasks and your
settings. These are secrets: keep this file somewhere safe. "Restore", in an Atlas's
settings, puts it all back.
""",
}


def exportable(content_root: Path, can_read) -> list:
    """Content-relative paths of the files `can_read` allows, dot-folders left out."""
    out = []
    for path in sorted(content_root.rglob("*")):
        rel = path.relative_to(content_root).as_posix()
        if path.is_file() and not any(p.startswith(".") for p in rel.split("/")) and can_read(rel):
            out.append(rel)
    return out


def write_export(fileobj, content_root: Path, rels: list, top: str, lang: str,
                 repo_root: Path = None, registry: Path = None) -> None:
    """Zip `rels` under `top/`, with a short readme; with `repo_root`, the whole
    history too (git bundle --all); with `registry`, its REGISTRY_FILES under .atlas/."""
    readme_name, bundle_name, readme = _README.get(lang, _README["en"])
    with zipfile.ZipFile(fileobj, "w", zipfile.ZIP_DEFLATED) as z:
        if repo_root is not None:
            with tempfile.TemporaryDirectory() as tmp:
                bundle = Path(tmp) / bundle_name
                made = subprocess.run(["git", "bundle", "create", str(bundle), "--all"],
                                      cwd=str(repo_root), capture_output=True, timeout=300)
                if made.returncode == 0:
                    z.write(bundle, f"{top}/{bundle_name}")
                    readme += _HISTORY_NOTE.get(lang, _HISTORY_NOTE["en"]).format(bundle=bundle_name)
        if registry is not None:
            for name in REGISTRY_FILES:
                if (registry / name).is_file():
                    z.write(registry / name, f"{top}/.atlas/{name}")
            readme += _REGISTRY_NOTE.get(lang, _REGISTRY_NOTE["en"])
        z.writestr(f"{top}/{readme_name}", readme)
        for rel in rels:
            z.write(content_root / rel, f"{top}/{rel}")
