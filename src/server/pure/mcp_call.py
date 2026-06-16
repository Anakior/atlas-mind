"""MCP tool dispatch + graph/tag/trash/search helpers backing the AI-native tools."""
import json
import sys
import time
from pathlib import Path

import server as _s


def _doc_corpus():
    """[(rel, name, text)] for every viewer-tracked doc, each file read once.

    utf-8-sig tolerates a BOM. Same source set as _iter_doc_files (dotfolders,
    EXCLUDED_NAMES and skill/tools/__pycache__ already filtered out)."""
    out = []
    for rel, path in _s._iter_doc_files():
        try:
            out.append((rel, path.name, path.read_text(encoding="utf-8-sig")))
        except (OSError, UnicodeDecodeError):
            continue
    return out


def _links_graph():
    """Wikilink graph {path: {"out": [...], "in": [...]}} over the whole mind.

    Single source of truth shared with the build/viewer: build_links_index only
    keeps docs that have at least one edge, so an isolated doc is simply absent."""
    return _s._import_build().build_links_index(
        [{"path": rel, "name": name, "body": text} for rel, name, text in _doc_corpus()])


def _tags_for(build, rel: str, text: str) -> list:
    """Folder-derived tags + frontmatter tags, merged and deduped — mirrors the
    tag computation of build.walk so the MCP tools never diverge from the viewer."""
    tags = list(build._folder_tags(rel))
    fm_tags, _ = build._parse_frontmatter(text)
    for t in fm_tags:
        if t not in tags:
            tags.append(t)
    return tags


def _soft_delete(target: Path) -> str:
    """Move a doc into content_root/.trash/ (reversible) instead of erasing it.

    delete_doc is called by an AI, not a human seeing a confirmation box, so a
    wrong call must stay recoverable. '.trash' is dot-prefixed → automatically
    hidden from tree/search/links (build EXCLUDED_PREFIXES and _iter_doc_files
    both skip dot-prefixed parts). Returns the trash-relative path."""
    content_root = _s.CONFIG.content_root
    rel = target.relative_to(content_root)
    dest = content_root / ".trash" / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    # Don't clobber an earlier trashed copy of the same doc: suffix -2, -3, …
    n = 2
    while dest.exists():
        dest = dest.with_name(f"{rel.stem}-{n}{rel.suffix}")
        n += 1
    target.replace(dest)
    return ".trash/" + rel.as_posix()


def _api_search(q: str, limit: int) -> list:
    """Scoring: weighted occurrences (name x3, content x1), with typo tolerance
    (a token that can't be found is corrected to the closest word in the
    vocabulary). Content read via the _doc_entry in-memory cache."""
    import difflib
    tokens = [t for t in _s._normalize_text(q).split() if t]
    if not tokens:
        return []
    entries = []
    for rel, path in _s._iter_doc_files():
        e = _s._doc_entry(rel, path)
        if e is not None:
            entries.append((rel, path, e))
    # Typo tolerance: a token of at least 4 letters absent from the vocabulary
    # (as a substring) is replaced by the closest known word. Restores the fuzzy
    # behavior MiniSearch had on the client side.
    vocab = set()
    for _, _, e in entries:
        vocab |= e["tokens"]
    corrected = []
    for t in tokens:
        if len(t) < 4 or any(t in w for w in vocab):
            corrected.append(t)
        else:
            near = difflib.get_close_matches(t, vocab, n=1, cutoff=0.78)
            corrected.append(near[0] if near else t)
    tokens = corrected
    hits = []
    for rel, path, e in entries:
        name_n = e["name_n"]
        content_n = e["content_n"]
        content = e["content"]
        score = 0
        first_idx = -1
        first_token = None
        for t in tokens:
            n_name = name_n.count(t)
            n_content = content_n.count(t)
            score += n_name * 3 + n_content
            if n_content:
                idx = content_n.find(t)
                if first_idx == -1 or (idx >= 0 and idx < first_idx):
                    first_idx = idx
                    first_token = t
        if score == 0:
            continue
        if first_idx >= 0 and first_token:
            start = max(0, first_idx - 60)
            end = min(len(content), first_idx + len(first_token) + 120)
            snippet = (("…" if start > 0 else "")
                       + content[start:end].replace("\n", " ").strip()
                       + ("…" if end < len(content) else ""))
        else:
            snippet = content[:160].replace("\n", " ").strip() + ("…" if len(content) > 160 else "")
        hits.append({
            "path": rel,
            "name": path.name,
            "score": score,
            "snippet": snippet,
            "mtime": int(e["mtime"]),
        })
    hits.sort(key=lambda h: (-h["score"], -h["mtime"]))
    return hits[:limit]


def _api_recent(days: int, limit: int) -> list:
    """Documents modified within the window, from most recent to oldest."""
    cutoff = time.time() - days * 86400
    items = []
    for rel, path in _s._iter_doc_files():
        st = path.stat()
        if st.st_mtime < cutoff:
            continue
        try:
            content = path.read_text(encoding="utf-8")
            preview = content[:160].replace("\n", " ").strip()
            if len(content) > 160:
                preview += "…"
        except (OSError, UnicodeDecodeError):
            preview = ""
        items.append({
            "path": rel,
            "name": path.name,
            "score": 0,
            "snippet": preview,
            "mtime": int(st.st_mtime),
        })
    items.sort(key=lambda h: -h["mtime"])
    return items[:limit]


def _mcp_call_tool(name: str, args: dict) -> dict:
    """Dispatch an MCP tool to the _api_* helpers. Returns MCP CallToolResult."""
    def text_result(s: str, is_error: bool = False) -> dict:
        out = {"content": [{"type": "text", "text": s}]}
        if is_error:
            out["isError"] = True
        return out

    if name == "search_docs":
        q = (args.get("q") or "").strip()
        if not q:
            return text_result("Error: missing 'q' parameter", is_error=True)
        try:
            limit = min(50, max(1, int(args.get("limit", 10))))
        except (ValueError, TypeError):
            limit = 10
        tag = (args.get("tag") or "").strip().lower()
        # Tag filter is additive: without it, identical to before. With it, over-fetch
        # then keep only the hits that also carry the tag (post-scoring, order kept).
        hits = _api_search(q, 50 if tag else limit)
        if tag:
            build = _s._import_build()
            kept = []
            for h in hits:
                fp = _s.CONFIG.content_root / h.get("path", "")
                try:
                    if tag in _tags_for(build, h.get("path", ""), fp.read_text(encoding="utf-8-sig")):
                        kept.append(h)
                except (OSError, UnicodeDecodeError):
                    continue
                if len(kept) >= limit:
                    break
            hits = kept
        if not hits:
            return text_result(f"No results for: {q}" + (f" (tag: {tag})" if tag else ""))
        return text_result(json.dumps(hits, ensure_ascii=False, indent=2))

    if name == "read_doc":
        rel = (args.get("path") or "").strip()
        target = _s._validate_doc_path(rel)
        if not target or not target.exists():
            return text_result(f"Document not found: {rel}", is_error=True)
        text = target.read_text(encoding="utf-8")
        return text_result(text)

    if name == "list_tree":
        try:
            tree = _s._import_build().walk(_s.CONFIG.content_root)
            return text_result(json.dumps(tree, ensure_ascii=False, indent=2))
        except Exception as e:
            print(f"[mcp] list_tree failed: {e}", file=sys.stderr)
            return text_result("Error listing the tree", is_error=True)

    if name == "recent_docs":
        try:
            days = max(1, int(args.get("days", 7)))
            limit = min(100, max(1, int(args.get("limit", 20))))
        except (ValueError, TypeError):
            days, limit = 7, 20
        hits = _api_recent(days, limit)
        if not hits:
            return text_result(f"No document modified in the last {days} days")
        return text_result(json.dumps(hits, ensure_ascii=False, indent=2))

    if name == "create_doc":
        rel = (args.get("path") or "").strip()
        content = args.get("content", "")
        target = _s._validate_doc_path(rel)
        if not target:
            return text_result("Invalid path (must be a relative .md or .html, no '..')", is_error=True)
        if _s._is_readonly_path(rel):
            return text_result("Read-only location (remote node mirror) — choose another path.", is_error=True)
        if target.exists():
            return text_result(f"Document already exists: {rel} (cannot overwrite with this token)", is_error=True)
        if not isinstance(content, str):
            return text_result("'content' must be a string", is_error=True)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        _s.trigger_sync()
        return text_result(f"Document created: {rel}")

    if name == "edit_doc":
        rel = (args.get("path") or "").strip()
        target = _s._validate_doc_path(rel)
        if not target:
            return text_result("Invalid path (must be a relative .md or .html, no '..')", is_error=True)
        if _s._is_readonly_path(rel):
            return text_result("Read-only document (remote node mirror). Use \"Appropriate\" to make an editable copy.", is_error=True)
        if not target.exists():
            return text_result(f"Document not found: {rel} (use create_doc to create a new one)", is_error=True)
        old_string = args.get("old_string")
        new_string = args.get("new_string")
        content = args.get("content")
        # Patch mode: targeted replacement, takes priority over the rewrite.
        if old_string is not None:
            if not isinstance(old_string, str) or not isinstance(new_string, str):
                return text_result("'old_string' and 'new_string' must be strings", is_error=True)
            if old_string == "":
                return text_result("'old_string' cannot be empty", is_error=True)
            current = target.read_text(encoding="utf-8")
            count = current.count(old_string)
            if count == 0:
                return text_result("'old_string' not found in the document (check it with read_doc)", is_error=True)
            if count > 1:
                return text_result(f"'old_string' appears {count} times — it must be unique. Add surrounding context to make it unique.", is_error=True)
            target.write_text(current.replace(old_string, new_string, 1), encoding="utf-8")
            _s.trigger_sync()
            return text_result(f"Document edited (targeted replacement): {rel}")
        # Full rewrite mode.
        if content is not None:
            if not isinstance(content, str):
                return text_result("'content' must be a string", is_error=True)
            target.write_text(content, encoding="utf-8")
            _s.trigger_sync()
            return text_result(f"Document rewritten: {rel}")
        return text_result("Provide either 'old_string'+'new_string' (patch) or 'content' (rewrite)", is_error=True)

    if name == "move_doc":
        src_rel = (args.get("from") or "").strip()
        dst_rel = (args.get("to") or "").strip()
        if not src_rel or not dst_rel:
            return text_result("'from' and 'to' are required", is_error=True)
        if _s._is_readonly_path(src_rel) or _s._is_readonly_path(dst_rel):
            return text_result("Read-only location (remote node mirror) — \"Appropriate\" it first to get an editable copy.", is_error=True)
        status, payload = _s._move_md_with_relink(src_rel, dst_rel)
        if status != "ok":
            return text_result(payload, is_error=True)
        _s.trigger_sync()
        n, files = payload["links_updated"], len(payload["rewrites"])
        msg = f"Moved: {payload['from']} -> {payload['to']}."
        msg += (f" {n} incoming wikilink(s) rewritten in {files} doc(s)."
                if n else " No incoming wikilink to fix.")
        return text_result(msg)

    if name == "get_links":
        rel = (args.get("path") or "").strip()
        target = _s._validate_doc_path(rel)
        if not target or not target.exists():
            return text_result(f"Document not found: {rel}", is_error=True)
        entry = _links_graph().get(rel) or {"out": [], "in": []}
        return text_result(json.dumps({"path": rel, "links": entry["out"]},
                                      ensure_ascii=False, indent=2))

    if name == "get_backlinks":
        rel = (args.get("path") or "").strip()
        target = _s._validate_doc_path(rel)
        if not target or not target.exists():
            return text_result(f"Document not found: {rel}", is_error=True)
        entry = _links_graph().get(rel) or {"out": [], "in": []}
        return text_result(json.dumps({"path": rel, "backlinks": entry["in"]},
                                      ensure_ascii=False, indent=2))

    if name == "get_mind_topology":
        build = _s._import_build()
        corpus = _doc_corpus()
        graph = build.build_links_index(
            [{"path": rel, "name": name_, "body": text} for rel, name_, text in corpus])
        all_paths = [rel for rel, _, _ in corpus]
        edges = sum(len(v["out"]) for v in graph.values())
        hubs = sorted(
            ({"path": p, "in_degree": len(v["in"])} for p, v in graph.items() if v["in"]),
            key=lambda h: (-h["in_degree"], h["path"]))[:10]
        linked = set(graph)
        orphans = [p for p in all_paths if p not in linked]
        tag_counts: dict = {}
        for rel, _, text in corpus:
            for t in _tags_for(build, rel, text):
                tag_counts[t] = tag_counts.get(t, 0) + 1
        top_tags = sorted(({"tag": t, "count": c} for t, c in tag_counts.items()),
                          key=lambda x: (-x["count"], x["tag"]))[:15]
        n = len(all_paths)
        payload = {
            "counts": {"docs": n, "edges": edges},
            "density": round(edges / n, 4) if n else 0,
            "hubs": hubs,
            "orphans": orphans[:50],
            "orphans_total": len(orphans),
            "top_tags": top_tags,
        }
        return text_result(json.dumps(payload, ensure_ascii=False, indent=2))

    if name == "list_by_tag":
        tag = (args.get("tag") or "").strip().lower()
        if not tag:
            return text_result("Error: missing 'tag' parameter", is_error=True)
        build = _s._import_build()
        matches = sorted(rel for rel, _, text in _doc_corpus()
                         if tag in _tags_for(build, rel, text))
        if not matches:
            return text_result(f"No document tagged: {tag}")
        return text_result(json.dumps({"tag": tag, "documents": matches},
                                      ensure_ascii=False, indent=2))

    if name == "delete_doc":
        rel = (args.get("path") or "").strip()
        target = _s._validate_doc_path(rel)
        if not target:
            return text_result("Invalid path (must be a relative .md or .html, no '..')", is_error=True)
        if _s._is_readonly_path(rel):
            return text_result("Read-only location (remote node mirror) — cannot delete.", is_error=True)
        if not target.exists():
            return text_result(f"Document not found: {rel}", is_error=True)
        trashed = _soft_delete(target)
        _s.trigger_sync()
        return text_result(f"Document moved to trash (reversible): {rel} -> {trashed}")

    return text_result(f"Unknown tool: {name}", is_error=True)


def _mcp_jsonrpc(req: dict):
    """Process an MCP JSON-RPC message. Returns response dict, or None for notifications."""
    method = req.get("method")
    params = req.get("params") or {}
    req_id = req.get("id")

    # Notifications have no id → no response
    if req_id is None:
        # We just log for debugging
        sys.stderr.write(f"[mcp] notification: {method}\n")
        sys.stderr.flush()
        return None

    def ok(result):
        return {"jsonrpc": "2.0", "id": req_id, "result": result}

    def err(code, message):
        return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}

    try:
        if method == "initialize":
            return ok({
                "protocolVersion": _s.MCP_PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                # Machine slug derived from site_name ("Atlas" → "atlas"): see
                # AtlasConfig.site_slug — neutral by default.
                "serverInfo": {"name": _s.CONFIG.site_slug, "version": "1.0.0"},
            })
        if method == "ping":
            return ok({})
        if method == "tools/list":
            return ok({"tools": _s._mcp_tools()})
        if method == "tools/call":
            tool_name = params.get("name", "")
            arguments = params.get("arguments") or {}
            sys.stderr.write(f"[mcp] tools/call name={tool_name}\n")
            sys.stderr.flush()
            return ok(_mcp_call_tool(tool_name, arguments))
        return err(-32601, f"method not found: {method}")
    except Exception as e:
        # Log the detail (which may carry server paths) to stderr only; the
        # client gets a generic message.
        sys.stderr.write(f"[mcp] error in {method}: {e}\n")
        sys.stderr.flush()
        return err(-32603, "internal error")
