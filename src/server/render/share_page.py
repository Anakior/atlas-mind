"""The page a note becomes for someone outside the mind: behind a share link (/s/<token>), or
as a file to send (`sender` given: its libraries, fonts and the pictures the sender may read
inside it, so it opens from an email or a USB key, with no Atlas to reach)."""
import base64
import html
import json
import mimetypes
import posixpath
import re
from urllib.parse import unquote

import server as _s
from server.pure import docs

_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\((<[^>\n]+>|[^)\s]+)\)")
_MAX_IMAGE = 5 << 20


def render(rel: str, target, *, sender=None) -> bytes:
    build = _s._import_build()
    text = target.read_text(encoding="utf-8")
    # Frontmatter left in would render as a setext heading in the page and its contents list.
    _, content = build._parse_frontmatter(text)
    if sender is not None:
        content = _IMAGE_RE.sub(lambda m: _inline_image(m, rel, sender), content)
    extensions_css, extensions_js = _s.share_extension_assets()
    page = _s.render_page(
        "share",
        title=html.escape(build._doc_title(text, ".md") or target.name),
        # `</` → `<\/`: a doc containing "</script>" must not close the <script> tag.
        content_json=json.dumps(content).replace("</", "<\\/"),
        extensions_css=extensions_css,
        extensions_js=extensions_js,
        lang=html.escape(_s.CONFIG.lang, quote=True),
        footer_label=_s._t("share_footer").format(site_name=html.escape(_s.CONFIG.site_name, quote=True)),
        toc_title=_s._t("share_toc_title"),
    )
    if sender is not None:
        page = build.inline_vendor_assets(page, _s.CONFIG.web_dir)
    return page.encode("utf-8")


def _inline_image(match, rel, sender):
    """A picture of the note, beside it in the mind, carried inside the page."""
    dest = match.group(2).strip("<>")
    if re.match(r"^[a-z][a-z0-9+.-]*:|^/|^#", dest, re.I):
        return match.group(0)
    path = posixpath.normpath(posixpath.join(posixpath.dirname(rel), unquote(dest)))
    target = docs.content_file(path, _s.CONFIG.content_root)
    mime = mimetypes.guess_type(path)[0] or ""
    if (target is None or not mime.startswith("image/") or target.stat().st_size > _MAX_IMAGE
            or not (sender.superuser or _s.can_read(path, sender))):
        return match.group(0)
    data = base64.b64encode(target.read_bytes()).decode("ascii")
    return f"![{match.group(1)}](data:{mime};base64,{data})"
