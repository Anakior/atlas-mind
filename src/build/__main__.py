"""Generate the knowledge-base viewer from viewer.html template.

Two modes:

  python -m build              → online mode (default)
    - index.html       : lightweight shell (tree metadata only, ~120 KB stable)
    - _backlinks.json   : index path → [{path, name, term, snippet}, ...]
    Contents are loaded on demand from the server (server.py).
    Online search is served by /api/search (server.py), not by a client-side
    index: the viewer only sends the query and receives the results.

  python -m build --offline    → offline mode (self-contained monolith)
    - index-offline.html : everything embedded (contents + search data + backlinks).
    For file:// troubleshooting / travel. Not rebuilt by the auto push.

The viewer.html template defines the placeholders:
  __DATA__              : tree JSON (metadata)
  __EMBED_CONTENT__     : null (online) | {path: content} (offline)
  __EMBED_BACKLINKS__   : null (online) | backlinks index (offline)
  __BUILD_TS__          : ISO timestamp
  __SITE_NAME__         : full name derived as "<prefix> Atlas" (raw text of the
                          <title>; "Atlas" alone without a prefix)
  __SITE_PREFIX__       : the prefix alone, HTML-escaped (styled span before the
                          "Atlas" wordmark of the sidebar H1)
  __SITE_PREFIX_JSON__  : the same, JSON-encoded (viewer JS constant for the
                          home page — never raw text inside a template
                          literal)
  __SITE_SHORT_NAME__   : short variant (PWA icon / iOS home screen) — the
                          "Atlas" brand, always
  __TAGLINE__           : home-page baseline, HTML-escaped (HTML context)
  __TAGLINE_JSON__      : the same, JSON-encoded (viewer JS constant)
  __LANG__              : interface language (<html lang>), "fr" or "en"
  __TEMPLATES__         : new-document skeletons {label: md content},
                          discovered in templates/ (engine) merged with
                          <mind>/templates/ — see load_doc_templates.
  __EXTENSIONS_CSS__    : CSS of the mind's extensions (concatenation of
                          <mind>/.atlas/extensions/*.css, alphabetical order),
                          inlined in a <style> of the viewer — both online AND
                          offline modes. See load_extension_assets.
  __EXTENSIONS_JS__     : same for the *.js, inlined in a <script> at the end of
                          <body>. `</script` is escaped there to `<\\/script`
                          (same protection as the JSON placeholders) so that
                          an extension JS string can never close the tag.
                          `</head` is neutralized the same way in both the CSS
                          AND the JS of extensions: the offline build injects
                          MiniSearch by replacing the template's `</head>`,
                          which must stay the FIRST one in the document (see
                          inline_vendor_assets).

dist/manifest.json (PWA) is GENERATED from the config (name/short_name): there
is no longer a static manifest in web/. The server serves it from dist/.

Paths and exclusions: main() resolves them via AtlasConfig (src/config.py) —
ATLAS_MIND mind, optional atlas.toml, env takes priority. The engine-relative
constants below (WEB_DIR, TEMPLATE) plus EXCLUDED_NAMES and the identity
defaults are the runtime defaults, and a contract consumed by server.py
(walk, EXCLUDED_NAMES, _WIKILINK_RE, _resolve_wikilink).
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import sys

from build import (
    walk, build_links_index, build_tasks_index, load_all_notes,
    load_doc_templates, load_extension_assets, inline_vendor_assets,
    render_template, render_manifest,
)
from build.paths import SRC_DIR, TEMPLATES_DIR

# ─── Main ─────────────────────────────────────────────────────────────────────


def _load_config():
    """AtlasConfig of the current mind (ATLAS_MIND, atlas.toml, env).

    config.py always ships next to build.py inside the atlas_mind package, so
    the import cannot fail in any real run."""
    if str(SRC_DIR) not in sys.path:
        sys.path.insert(0, str(SRC_DIR))
    from config import AtlasConfig, AtlasConfigError
    try:
        return AtlasConfig.load()
    except AtlasConfigError as e:
        # Explicit config error (malformed atlas.toml…): a readable fatal exit
        # rather than a traceback.
        sys.exit(f"FATAL: {e}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--offline", action="store_true",
                        help="Generate the monolithic index-offline.html (file://-ready).")
    args = parser.parse_args()

    cfg = _load_config()
    content_root, dist_dir, notes_dir = cfg.content_root, cfg.dist_dir, cfg.notes_dir
    template_path = cfg.web_dir / "viewer.html"
    excluded_names = cfg.excluded_names
    site_prefix, tagline, lang = cfg.prefix, cfg.tagline, cfg.lang
    extensions_dir, web_dir = cfg.extensions_dir, cfg.web_dir
    todo_cats = [{"cat": c, "label": cfg.todo_cat_headers.get(c, c.capitalize())}
                 for c in cfg.todo_categories]
    out_online = dist_dir / "index.html"
    out_offline = dist_dir / "index-offline.html"
    backlinks_data = dist_dir / "_backlinks.json"
    notes_index_path = dist_dir / "_notes-index.json"
    manifest_path = dist_dir / "manifest.json"
    # Skeletons: those of the engine (TEMPLATES_DIR, next to src/) then those of
    # the mind (<mind>/templates, sibling of content/) which add/override.
    # Mind co-located with the engine: both paths coincide, idempotent merge.
    doc_templates = load_doc_templates(TEMPLATES_DIR,
                                       content_root.parent / "templates")
    # Viewer-side extensions hook: the mind's CSS/JS inlined in both modes
    # (online and offline).
    extensions_css, extensions_js = load_extension_assets(extensions_dir)

    build_ts = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    dist_dir.mkdir(parents=True, exist_ok=True)

    # PWA manifest generated from the config — written in both modes (the
    # server serves dist/manifest.json, no longer the static web/ one).
    manifest_path.write_text(
        json.dumps(render_manifest(site_prefix=site_prefix, tagline=tagline,
                                   lang=lang),
                   ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8")

    if args.offline:
        accum = {"md_files": []}
        tree = walk(content_root, embed_content=True, _accum=accum,
                    excluded_names=excluded_names)
        embed_content = {f["path"]: f["content"] for f in accum["md_files"]}
        backlinks = build_links_index(accum["md_files"])
        html = render_template(
            tree=tree,
            embed_content=embed_content,
            embed_backlinks=backlinks,
            embed_notes=load_all_notes(notes_dir),
            embed_tasks=build_tasks_index(accum["md_files"]),
            build_ts=build_ts,
            template_path=template_path,
            site_prefix=site_prefix,
            tagline=tagline,
            lang=lang,
            todo_categories=todo_cats,
            doc_templates=doc_templates,
            extensions_css=extensions_css,
            extensions_js=extensions_js,
        )
        # Self-contained monolith: the /vendor/ assets (libs, CSS, fonts) are
        # inlined — index-offline.html works in file:// without network.
        html = inline_vendor_assets(html, web_dir)
        out_offline.write_text(html, encoding="utf-8")
        size = out_offline.stat().st_size
        print(f"Generated {out_offline.name} ({size:,} bytes, {len(accum['md_files'])} .md inline)")
        return 0

    # Online mode (default)
    accum = {"md_files": []}
    tree = walk(content_root, embed_content=False, _accum=accum,
                excluded_names=excluded_names)
    html = render_template(
        tree=tree,
        embed_content=None,
        embed_backlinks=None,
        embed_notes=None,
        embed_tasks=None,
        build_ts=build_ts,
        template_path=template_path,
        site_prefix=site_prefix,
        tagline=tagline,
        lang=lang,
        todo_categories=todo_cats,
        doc_templates=doc_templates,
        extensions_css=extensions_css,
        extensions_js=extensions_js,
    )
    out_online.write_text(html, encoding="utf-8")

    # No more _search-data.json: online search is served by /api/search
    # (server.py) — O(results) transfer, not the whole corpus on the client side.
    backlinks = build_links_index(accum["md_files"])
    backlinks_data.write_text(json.dumps(backlinks, ensure_ascii=False), encoding="utf-8")

    # Aggregated annotations index (disposable, gitignored): {rel_doc: nb_notes}.
    # Used only for the tree's "📝 n" badges; the data lives in .notes/.
    notes_index = {rel: len(ns) for rel, ns in load_all_notes(notes_dir).items()}
    notes_index_path.write_text(json.dumps(notes_index, ensure_ascii=False), encoding="utf-8")

    # The task rollup is served LIVE by the server (/_tasks-index.json, computed
    # from the current files) — no static snapshot to write here. The offline
    # build still embeds it via __EMBED_TASKS__ (read-only there anyway).

    html_size = out_online.stat().st_size
    backlinks_size = backlinks_data.stat().st_size
    print(
        f"Generated:\n"
        f"  {out_online.name:24} {html_size:>10,} bytes  (shell + tree metadata)\n"
        f"  {backlinks_data.name:24} {backlinks_size:>10,} bytes  ({len(backlinks)} entries)\n"
        f"  {notes_index_path.name:24} {notes_index_path.stat().st_size:>10,} bytes  ({len(notes_index)} annotated docs)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
