"""MCP Apps views (web/apps/<name>.html): one self-contained page per view, served as a ui://
resource and rendered by the host inline in the conversation. At serve time the page gets the
shared bridge (web/apps/bridge.js) and its labels in the instance's language (the i18n keys
app_<name>_*), so it loads nothing from anywhere. Cache is module-level (the files ship with
the package)."""
import json

import server as _s
from server.render.i18n import _strings
from server.render.pages import fill

_APPS_CACHE = {}


def render_app(name: str) -> str:
    lang = _s.CONFIG.lang if _s.CONFIG is not None else "fr"
    if (name, lang) not in _APPS_CACHE:
        apps = _s.CONFIG.web_dir / "apps"
        prefix = f"app_{name}_"
        labels = {k[len(prefix):]: v for k, v in _strings(lang).items() if k.startswith(prefix)}
        _APPS_CACHE[(name, lang)] = fill(
            (apps / f"{name}.html").read_text(encoding="utf-8"),
            lang=lang,
            bridge=(apps / "bridge.js").read_text(encoding="utf-8"),
            i18n=json.dumps(labels, ensure_ascii=False).replace("</", "<\\/"))
    return _APPS_CACHE[(name, lang)]
