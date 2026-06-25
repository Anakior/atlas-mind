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
  __EMBED_ACTIVITY__    : null (online) | {events, stale, contradictions} (offline,
                          public mind only) — the frozen activity-layer snapshot
  __BUILD_TS__          : ISO timestamp
  __SITE_NAME__         : full name "<prefix> Atlas" (raw <title> text)
  __SITE_PREFIX__       : the prefix alone, HTML-escaped (sidebar H1 span)
  __SITE_PREFIX_JSON__  : the same, JSON-encoded (viewer JS constant)
  __SITE_SHORT_NAME__   : short variant (PWA icon) — the "Atlas" brand
  __TAGLINE__           : home-page baseline, HTML-escaped
  __TAGLINE_JSON__      : the same, JSON-encoded (viewer JS constant)
  __LANG__              : interface language (<html lang>), "fr" or "en"
  __HEAD_META__         : SEO/social <head> block — a meta description always,
                          canonical + Open Graph/Twitter only if [site].url set
  __TEMPLATES__         : new-document skeletons {label: md content} — see
                          load_doc_templates.
  __EXTENSIONS_CSS__    : the mind's extension CSS, inlined in a <style> (both
                          modes). See load_extension_assets.
  __EXTENSIONS_JS__     : same for the *.js, inlined in a <script>. `</script`
                          and `</head` are neutralized so an extension JS string
                          can neither close the tag nor hijack the offline
                          MiniSearch `</head>` injection (inline_vendor_assets).

dist/manifest.json (PWA) is GENERATED from the config; the server serves it from
dist/. Paths/exclusions: main() resolves them via AtlasConfig (src/config.py).
The engine-relative constants below plus EXCLUDED_NAMES and the identity defaults
are the runtime defaults, and a contract consumed by server.py (walk,
EXCLUDED_NAMES, _WIKILINK_RE, _resolve_wikilink).
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
        # Readable fatal exit rather than a traceback on a malformed atlas.toml.
        sys.exit(f"FATAL: {e}")


def _offline_keep(cfg, as_email):
    """Predicate deciding which content-relative doc paths are embedded in the
    offline monolith — privacy of a STATIC, access-control-free artifact.

    Default (as_email None): the COMMON SOCLE only — docs with NO owner anywhere
    on their ancestor chain. EVERY account's PRIVATE docs are excluded. With
    --as <email>: that account's full visible set (socle + shared + owned), via
    the SAME ACL evaluation the server uses (no second code path). Reuses
    server.pure.acl with an explicit FileStore, so it needs no running server.

    Returns None (no filtering) for a mind with no acl.json and no --as: with no
    ACL registry nothing is private, so the socle IS everything — the legacy
    'embed all' behaviour is preserved and the server import is skipped."""
    if as_email is None and not (cfg.store_dir / "acl.json").is_file():
        return None
    if str(SRC_DIR) not in sys.path:
        sys.path.insert(0, str(SRC_DIR))
    import store as _store
    from server.pure import acl
    fs = _store.FileStore(cfg.store_dir)
    if as_email:
        user = fs.get_user_by_email(as_email)
        if user is None:
            sys.exit(f"FATAL: --as {as_email}: no such account in this mind.")
        ctx = acl.viewer_ctx(
            {"email": as_email, "role": user.get("role", "viewer")}, fs)
        return lambda rel: acl.can_read(rel, ctx, fs)
    return lambda rel: not acl.in_private_space(rel, fs)


def _snapshot_activity(cfg):
    """Freeze the activity layer (journal + obsolescence + contradiction
    candidates) at build time so the OFFLINE viewer renders the same home the
    server serves live — from the embedded snapshot instead of /api/*.

    Reuses the server's read functions VERBATIM (one source of truth, no
    divergence) by standing up a minimal, listener-less context over the same
    mind, exactly as _offline_keep reaches into server.pure for the ACL. It runs
    only in the `python -m build` subprocess, so setting the module globals
    cannot collide with a live server. Returns None on git failure (the viewer
    then simply omits the activity card, just like online with no history)."""
    if str(SRC_DIR) not in sys.path:
        sys.path.insert(0, str(SRC_DIR))
    import server as _s
    import store as _store
    from server.context import AppContext
    _s.CONFIG = cfg
    _s._CTX = AppContext.build(cfg, _store.FileStore(cfg.store_dir))
    events = _s._activity_events(60, 200, None, None, None)  # days, limit, no filter
    if events is None:
        return None
    # Seal the inbox from this embedded, public-facing snapshot (ctx=None does not ACL-filter):
    # drop inbox/ paths, and any event left with no path (its subject could name an inbox doc).
    for e in events:
        e["paths"] = [p for p in e.get("paths", []) if p.split("/")[0] != "inbox"]
    events = [e for e in events if e["paths"]]
    return {
        "events": events,
        "stale": _s._api_stale(6, 40, None),               # months, limit, no ACL
        # solid_only mirrors the /api/contradictions route the live viewer hits, so the
        # offline card shows the same feed (high-confidence detectors + confirmed pairs),
        # not the raw cosine clusters that are the AI's on-demand material via MCP.
        "contradictions": _s.find_contradictions(None, 50, False, solid_only=True),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--offline", action="store_true",
                        help="Generate the monolithic index-offline.html (file://-ready).")
    parser.add_argument("--as", dest="as_email", default=None, metavar="EMAIL",
                        help="Offline only: export ONE account's visible view "
                             "(socle + shared + owned). Default offline build = "
                             "the common socle only (no account's private docs).")
    args = parser.parse_args()
    if args.as_email and not args.offline:
        sys.exit("FATAL: --as <email> only applies to an --offline build.")

    cfg = _load_config()
    content_root, dist_dir, notes_dir = cfg.content_root, cfg.dist_dir, cfg.notes_dir
    template_path = cfg.web_dir / "viewer.html"
    excluded_names = cfg.excluded_names
    site_prefix, tagline, lang = cfg.prefix, cfg.tagline, cfg.lang
    site_url, site_description, og_image = (cfg.site_url, cfg.site_description,
                                            cfg.og_image)
    extensions_dir, web_dir = cfg.extensions_dir, cfg.web_dir
    todo_cats = [{"cat": c, "label": cfg.todo_cat_headers.get(c, c.capitalize())}
                 for c in cfg.todo_categories]
    out_online = dist_dir / "index.html"
    out_offline = dist_dir / "index-offline.html"
    backlinks_data = dist_dir / "_backlinks.json"
    notes_index_path = dist_dir / "_notes-index.json"
    manifest_path = dist_dir / "manifest.json"
    # Skeletons: engine (TEMPLATES_DIR) then mind (<mind>/templates) which
    # add/override; co-located engine+mind → idempotent merge.
    doc_templates = load_doc_templates(TEMPLATES_DIR,
                                       content_root.parent / "templates")
    extensions_css, extensions_js = load_extension_assets(extensions_dir)

    build_ts = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    dist_dir.mkdir(parents=True, exist_ok=True)

    # PWA manifest generated from the config, written in both modes.
    manifest_path.write_text(
        json.dumps(render_manifest(site_prefix=site_prefix, tagline=tagline,
                                   lang=lang),
                   ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8")

    if args.offline:
        # Filter the offline export to the common socle (or --as <email>'s
        # view). One predicate threaded through walk() filters the tree AND
        # md_files at the source, so embed_content / backlinks / tasks / the
        # MiniSearch index all inherit it; notes (loaded separately) match it.
        keep = _offline_keep(cfg, args.as_email)
        accum = {"md_files": []}
        tree = walk(content_root, embed_content=True, _accum=accum,
                    excluded_names=excluded_names, keep=keep)
        embed_content = {f["path"]: f["content"] for f in accum["md_files"]}
        backlinks = build_links_index(accum["md_files"])
        notes = load_all_notes(notes_dir)
        if keep is not None:
            notes = {rel: ns for rel, ns in notes.items() if keep(rel)}
        # Activity snapshot embedded ONLY for a fully-public mind (no ACL): a
        # filtered export (common socle / --as <email>) would need the activity
        # scrubbed to the same visible set, so we keep it online-only there
        # rather than risk leaking a private doc's history into a static file.
        embed_activity = _snapshot_activity(cfg) if keep is None else None
        html = render_template(
            tree=tree,
            embed_content=embed_content,
            embed_backlinks=backlinks,
            embed_notes=notes,
            embed_tasks=build_tasks_index(accum["md_files"]),
            embed_activity=embed_activity,
            build_ts=build_ts,
            template_path=template_path,
            site_prefix=site_prefix,
            tagline=tagline,
            lang=lang,
            site_url=site_url,
            site_description=site_description,
            og_image=og_image,
            todo_categories=todo_cats,
            doc_templates=doc_templates,
            extensions_css=extensions_css,
            extensions_js=extensions_js,
        )
        # Inline /vendor/ assets so index-offline.html works in file:// offline.
        html = inline_vendor_assets(html, web_dir)
        out_offline.write_text(html, encoding="utf-8")
        size = out_offline.stat().st_size
        if args.as_email:
            scope = f"view of {args.as_email}"
        elif keep is not None:
            scope = "common socle"
        else:
            scope = "all content"
        print(f"Generated {out_offline.name} ({size:,} bytes, "
              f"{len(accum['md_files'])} .md inline — {scope})")
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
        site_url=site_url,
        site_description=site_description,
        og_image=og_image,
        todo_categories=todo_cats,
        doc_templates=doc_templates,
        extensions_css=extensions_css,
        extensions_js=extensions_js,
    )
    out_online.write_text(html, encoding="utf-8")

    # Online search is served by /api/search (no static _search-data.json).
    backlinks = build_links_index(accum["md_files"])
    backlinks_data.write_text(json.dumps(backlinks, ensure_ascii=False), encoding="utf-8")

    # Annotations index (disposable, gitignored): {rel_doc: nb_notes}, for the
    # tree's note-count badges; the data lives in .notes/.
    notes_index = {rel: len(ns) for rel, ns in load_all_notes(notes_dir).items()}
    notes_index_path.write_text(json.dumps(notes_index, ensure_ascii=False), encoding="utf-8")

    # The task rollup is served LIVE by the server (/_tasks-index.json); no static
    # snapshot here. The offline build embeds it via __EMBED_TASKS__.

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
