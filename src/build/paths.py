"""Engine paths and identity defaults for the build pipeline.

build/ is a sub-package: __file__ is src/build/paths.py, so the engine src dir
(viewer/, templates/, the atlas_mind package __init__) is two levels up. These are
the engine-relative defaults; mind-relative paths come from AtlasConfig at
runtime (the engine never runs in place inside a mind repo)."""
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parent.parent
WEB_DIR = SRC_DIR / "viewer"
TEMPLATE = WEB_DIR / "viewer.html"
TEMPLATES_DIR = SRC_DIR / "templates"

# Split viewer sources, concatenated back into the shell viewer.html at build time
# (build.assets.concat_sources): styles/*.css → the main <style>, partials/*.html →
# the <body>, lib/*.js → the app <script>. Each is filled in by name order.
STYLES_DIR = WEB_DIR / "styles"
PARTIALS_DIR = WEB_DIR / "partials"
JS_DIR = WEB_DIR / "lib"

# Default identity (mirror of the defaults in src/config.py): the runtime defaults
# used by render_template / render_manifest when the config does not override them.
# "Atlas" is THE BRAND, fixed: only the optional prefix comes from the config.
SITE_WORDMARK = "Atlas Mind"
DEFAULT_SITE_PREFIX = ""
DEFAULT_TAGLINE = "Personal knowledge base."
DEFAULT_LANG = "en"
# Todo categories injected into the viewer (tabs + filter); replaced by the
# atlas.toml [todo].categories. Shape: [{"cat": <key>, "label": <header>}].
DEFAULT_TODO_CATEGORIES = [
    {"cat": "work", "label": "Work"},
    {"cat": "personal", "label": "Personal"},
]
