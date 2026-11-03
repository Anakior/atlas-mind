"""pre-receive hook for a push to the mind's own git (/git): the notes may change, the
instance may not. Only `main` moves, only forward, and only content/ and AGENTS.md
differ once it has. Run by git as a standalone script (stdlib, no engine imports): it
reads "<old> <new> <ref>" lines and refuses the whole push with a reason on stdout."""
import subprocess
import sys

ALLOWED_FILES = {"AGENTS.md"}
ALLOWED_DIR = "content/"


def allowed(path: str) -> bool:
    return path in ALLOWED_FILES or (path.startswith(ALLOWED_DIR) and "/.git" not in "/" + path)


def refusal(updates, changed) -> str:
    """Why this push is refused, or "" — `updates` the (old, new, ref) triples, `changed`
    lists the paths that differ between two commits."""
    for old, new, ref in updates:
        if ref != "refs/heads/main":
            return f"only the main branch can be pushed here, not {ref}"
        if not new.strip("0"):
            return "main cannot be deleted"
        if not old.strip("0"):
            return "main already exists here: pull it first"
        outside = [p for p in changed(old, new) if not allowed(p)]
        if outside:
            shown = ", ".join(outside[:5]) + (" …" if len(outside) > 5 else "")
            return ("only your notes (content/ and AGENTS.md) can change from a copy; "
                    f"this push also changes {shown}")
    return ""


def _changed(old, new):
    out = subprocess.run(["git", "diff", "--no-renames", "--name-only", "-z", old, new],
                         capture_output=True, check=True).stdout
    return [p.decode("utf-8", "surrogateescape") for p in out.split(b"\0") if p]


def main() -> int:
    updates = [tuple(line.split()) for line in sys.stdin if line.strip()]
    reason = refusal(updates, _changed)
    if reason:
        print(f"Atlas: {reason}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
