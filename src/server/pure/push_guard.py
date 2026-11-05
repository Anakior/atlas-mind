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


def refusal(updates, changed, linked=lambda old, new: ()) -> str:
    """Why this push is refused, or "" — `updates` the (old, new, ref) triples, `changed`
    lists the paths that differ between two commits, `linked` those it makes a symbolic
    link or a submodule."""
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
        links = list(linked(old, new))
        if links:  # the server would follow it out of the mind
            return f"a link or a submodule cannot be pushed among your notes: {links[0]}"
    return ""


def _changed(old, new):
    out = subprocess.run(["git", "diff", "--no-renames", "--name-only", "-z", old, new],
                         capture_output=True, check=True).stdout
    return [p.decode("utf-8", "surrogateescape") for p in out.split(b"\0") if p]


def _linked(old, new):
    out = subprocess.run(["git", "diff", "--no-renames", "--raw", "-z", old, new],
                         capture_output=True, check=True).stdout.split(b"\0")
    return [path.decode("utf-8", "surrogateescape") for meta, path in zip(out[0::2], out[1::2])
            if meta.split(b" ")[1:2] in ([b"120000"], [b"160000"])]


def main() -> int:
    updates = [tuple(line.split()) for line in sys.stdin if line.strip()]
    reason = refusal(updates, _changed, _linked)
    if reason:
        print(f"Atlas: {reason}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
