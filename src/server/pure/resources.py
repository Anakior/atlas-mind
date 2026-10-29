"""MCP resources: the mind's documents, addressable as doc://<path>. A client lists them
and attaches one to the conversation (`@atlas:doc://notes/x.md` in Claude Code); tool
results link to them (search hits). ACL-scrubbed and provenance-fenced like every other read.

Also the MCP Apps views (ui://atlas/<name>): a tool names one in its _meta.ui.resourceUri
and a host that renders apps reads it. They hold no mind data (it comes in the tool result)
and stay out of the listing, which is for documents."""
from urllib.parse import quote, unquote

import server as _s
from server.pure import provenance
from server.pure.queries import _visible
from server.render.apps import render_app

PAGE_SIZE = 200
SCHEME = "doc://"
APPS = {"ui://atlas/resume": "resume", "ui://atlas/weather": "weather", "ui://atlas/shift": "shift",
        "ui://atlas/montage": "montage"}
APP_MIME = "text/html;profile=mcp-app"
APP_EXTENSION = "io.modelcontextprotocol/ui"
# Sent with the server instructions: a host with many connectors may look tools up by keyword,
# and "did I change my mind" finds search_docs before then_and_now.
APP_RULE = ("Some answers are views the user works in: resume_session to pick up saved work, "
            "mind_weather for how the mind is doing, then_and_now then show_shift for what the "
            "user thought before or whether they changed their mind on something, and agent_runs for "
            "what was written lately (by an AI or not), to review it or undo part of it. For those "
            "questions, call these tools by name and let the view answer, rather than rebuilding "
            "the answer from searches.")
TEMPLATE = {"uriTemplate": SCHEME + "{+path}", "name": "document",
            "title": "A document of the mind, by its path", "mimeType": "text/markdown"}


class ResourceError(ValueError):
    """The URI names no document this caller can read."""


def uri_for(rel: str) -> str:
    return SCHEME + quote(rel)


def _mime(rel: str) -> str:
    return "text/html" if rel.lower().endswith(".html") else "text/markdown"


def _title(rel: str, path) -> str:
    """The first Markdown heading, else the file name."""
    text = _s._doc_text(rel, path) if rel.lower().endswith(".md") else None
    for line in (text or "").splitlines():
        if line.startswith("# "):
            return line[2:].strip()
    return path.stem


def link(rel: str) -> dict:
    """A resource_link content block pointing at a document."""
    return {"type": "resource_link", "uri": uri_for(rel), "name": rel, "mimeType": _mime(rel)}


def list_resources(ctx, cursor: str = "") -> dict:
    """One page of the documents ctx can read, by path; `nextCursor` while more remain."""
    docs = sorted((rel, path) for rel, path in _s._iter_doc_files() if _visible(rel, ctx))
    start = int(cursor) if cursor.isdigit() else 0
    page = docs[start:start + PAGE_SIZE]
    result = {"resources": [{"uri": uri_for(rel), "name": rel, "title": _title(rel, path),
                             "mimeType": _mime(rel), "size": path.stat().st_size}
                            for rel, path in page]}
    if start + PAGE_SIZE < len(docs):
        result["nextCursor"] = str(start + PAGE_SIZE)
    return result


def read_resource(uri: str, ctx) -> dict:
    """The document behind a doc:// URI, or an app's view. Raises ResourceError."""
    if uri in APPS:
        # Everything is inline (no domain to declare); the view copies a resume command.
        return {"contents": [{"uri": uri, "mimeType": APP_MIME, "text": render_app(APPS[uri]),
                              "_meta": {"ui": {"prefersBorder": True,
                                               "permissions": {"clipboardWrite": {}}}}}]}
    rel = unquote(uri[len(SCHEME):]) if (uri or "").startswith(SCHEME) else ""
    target = _s._validate_doc_path(rel)
    if not (target and target.exists() and _visible(rel, ctx)):
        raise ResourceError(f"no readable document at {uri}")
    return {"contents": [{"uri": uri_for(rel), "mimeType": _mime(rel),
                          "text": provenance.fence(target.read_text(encoding="utf-8"), rel)}]}
