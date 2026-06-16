"""Served-page i18n: load + cache web/i18n/<lang>.json; _t resolves a key in the
instance language (CONFIG.lang), French fallback. Cache is module-level (read once
per language; the JSON ships with the package)."""
import json

import server as _s

_STRINGS_CACHE = {}


def _strings(lang: str) -> dict:
    """Load (and cache) the served-page translations for <lang> from
    web/i18n/<lang>.json. An unknown language falls back to French."""
    if lang not in _STRINGS_CACHE:
        path = _s.CONFIG.web_dir / "i18n" / (lang + ".json")
        if not path.is_file():
            return _strings("fr")
        _STRINGS_CACHE[lang] = json.loads(path.read_text(encoding="utf-8"))
    return _STRINGS_CACHE[lang]


def _t(key: str) -> str:
    """HTML page label in the instance's language (CONFIG.lang), French fallback."""
    lang = _s.CONFIG.lang if _s.CONFIG is not None else "fr"
    return _strings(lang)[key]
