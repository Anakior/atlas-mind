"""Files put into the mind from outside it: which ones, under which name, and what a dropped
zip unpacks to. A file that runs as a page when opened on its own (.html, .svg) never comes
in this way: everything here is served from the mind's own origin."""
import zipfile
from pathlib import Path, PurePosixPath

MAX_FILE = 25 << 20
MAX_ZIP = 200 << 20
MAX_UNPACKED = 500 << 20

ALLOWED = frozenset((
    ".md", ".txt", ".csv", ".tsv", ".json", ".rtf", ".epub",
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp",
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".heic", ".bmp",
    ".mp3", ".m4a", ".wav", ".ogg", ".mp4", ".webm", ".mov",
))


class UploadError(Exception):
    def __init__(self, code, detail=""):
        super().__init__(detail or code)
        self.code = code


def clean_path(rel):
    """`rel` as a content path, or None. Same bar as a doc path (no markup or control
    characters, the viewer inlines names), no hidden segment, and nothing a Windows copy
    of the mind could not check out (a colon: also a drive letter)."""
    rel = (rel or "").strip().replace("\\", "/")
    if not rel or rel.startswith("/") or any(c in rel for c in '<>":'):
        return None
    if any(ord(c) < 0x20 or ord(c) == 0x7f for c in rel):
        return None
    if any(not p or p in (".", "..") or p.startswith(".") for p in rel.split("/")):
        return None
    return rel


def clean_rel(rel):
    """`rel` as the path of a file that may come in, or None."""
    rel = clean_path(rel)
    return rel if rel and PurePosixPath(rel).suffix.lower() in ALLOWED else None


def free_rel(content_root, rel):
    """`rel`, or the first "name (2).ext", "name (3).ext"… nobody uses yet: an upload
    never replaces a file."""
    p = PurePosixPath(rel)
    candidate, n = rel, 1
    while (Path(content_root) / candidate).exists():
        n += 1
        candidate = str(p.with_name(f"{p.stem} ({n}){p.suffix}"))
    return candidate


def zip_entries(zip_path, folder):
    """What `zip_path` unpacks to under `folder`: ([(member, rel)], [skipped names]).
    A single folder wrapping the whole archive is not doubled; a member whose name could
    land outside `folder` (zip-slip), isn't an allowed type, or is larger than one upload,
    is skipped."""
    try:
        zf = zipfile.ZipFile(zip_path)
    except (zipfile.BadZipFile, OSError):
        raise UploadError("bad_zip")
    with zf:
        members = [m for m in zf.infolist() if not m.is_dir()
                   and not m.filename.startswith("__MACOSX/")]
        names = [m.filename.replace("\\", "/") for m in members]
        tops = {n.split("/", 1)[0] for n in names}
        strip = len(tops) == 1 and all("/" in n for n in names)
        entries, skipped, total = [], [], 0
        for member, name in zip(members, names):
            inner = name.split("/", 1)[1] if strip else name
            rel = clean_rel(f"{folder}/{inner}" if folder else inner)
            if rel is None or member.file_size > MAX_FILE:
                skipped.append(name)
                continue
            total += member.file_size
            if total > MAX_UNPACKED:
                raise UploadError("too_large")
            entries.append((member, rel))
    return entries, skipped
