"""The lines of documents a pattern matches, for grep_docs. A literal runs in the server; an
agent's regex runs this file as a child (python -I grep_lines.py): `re` backtracks, holds the
GIL while it does, and a pattern like (a+)+$ would freeze the whole server, where a child can
be killed on a timeout. Stdlib only, nothing of the engine: the child imports none of it."""
import json
import re
import sys

# Matched per line: bounds what one long line gives a pattern to backtrack over.
LINE_MAX = 1000


def line_hits(rx, docs, limit) -> list:
    """[(rel, line number, text)] of the lines of `docs` [(rel, text)] that `rx` matches, in
    order, `limit` + 1 at most (one more says there are more)."""
    hits = []
    for rel, text in docs:
        for n, line in enumerate(text.splitlines(), 1):
            if rx.search(line[:LINE_MAX]):
                hits.append((rel, n, line.strip()[:240]))
                if len(hits) > limit:
                    return hits
    return hits


if __name__ == "__main__":
    pattern, flags, limit, docs = json.load(sys.stdin)
    json.dump(line_hits(re.compile(pattern, flags), docs, limit), sys.stdout)
