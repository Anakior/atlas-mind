"""PoB extension — Path of Building passive-tree resolution.

PoB codes only store the allocated nodes as opaque numeric ids
(nodes="13375,23471,..."). Turning them into names (keystones, notables,
masteries) requires the per-version tree data, published as Lua tables by the
Path of Building Community repositories. This module downloads them once,
caches them next to the installed file, parses them with regex (no Lua runtime)
and resolves a build's spec into a structured breakdown.

Installation: copy pob.py (+ pob.js, pob.css) into
<mind>/.atlas/extensions/. At boot, the server calls register(context), which
registers POST /api/pob-tree (admin role) — the endpoint pob.js calls when
importing a PoB build to enrich the "Passive tree" section.
"""

from __future__ import annotations

import re
import urllib.request
from pathlib import Path

# Cache for the downloaded tree.lua files: next to the installed module, i.e.
# <mind>/.atlas/extensions/_tree_cache/ — .atlas/ is already outside git, and
# the extension loader only reads *.py files (the cache directory is ignored).
CACHE_DIR = Path(__file__).resolve().parent / "_tree_cache"

# Per-version passive-tree data as Lua tables.
POB_TREE_URLS = {
    "poe1": "https://raw.githubusercontent.com/PathOfBuildingCommunity/PathOfBuilding/master/src/TreeData/{ver}/tree.lua",
    "poe2": "https://raw.githubusercontent.com/PathOfBuildingCommunity/PathOfBuilding-PoE2/dev/src/TreeData/{ver}/tree.lua",
}


def detect_game(tree_version: str) -> str:
    """PoE1 tree versions look like '3_28'; PoE2 like '0_3'."""
    return "poe1" if (tree_version or "").startswith("3_") else "poe2"


def fetch_tree_data(game: str, version: str, *, allow_download: bool = True) -> str | None:
    """Return the tree.lua text for game+version, downloading + caching on
    demand. Returns None if unavailable (unknown game, network error, offline
    miss, or a version the repo doesn't carry)."""
    if game not in POB_TREE_URLS or not version:
        return None
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache = CACHE_DIR / f"{game}_{version}.lua"
    if cache.exists():
        return cache.read_text(encoding="utf-8")
    if not allow_download:
        return None
    url = POB_TREE_URLS[game].format(ver=version)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "decode_pob/1.0"})
        with urllib.request.urlopen(req, timeout=20) as r:
            text = r.read().decode("utf-8")
    except Exception:
        return None
    cache.write_text(text, encoding="utf-8")
    return text


# ─── Lua parsing (regex-based; the data is machine-generated and regular) ─────

def _extract_stats(blk: str) -> list[str]:
    """First stats string list inside a node block — handles both the PoE1
    layout (`["stats"]= { ... }`) and the PoE2 one (`stats={ ... }`)."""
    m = re.search(r'(?:\["stats"\]=\s*|stats=)\{(.*?)\}', blk, re.S)
    if not m:
        return []
    return [s.replace("\\n", " / ") for s in re.findall(r'"((?:[^"\\]|\\.)*)"', m.group(1))]


def parse_classes(tree_lua: str) -> list[dict]:
    """Ordered list of {name, ascendancies:[names]} — index == classId."""
    start = tree_lua.find('["classes"]=')
    if start == -1:
        return []
    rest = tree_lua[start:]
    end = re.search(r'\n    \["(?!classes)', rest)  # next top-level (4-space) key
    block = rest[: end.start()] if end else rest
    classes: list[dict] = []
    starts = [m.start() for m in re.finditer(r"\n        \{", block)]
    starts.append(len(block))
    for i in range(len(starts) - 1):
        chunk = block[starts[i]: starts[i + 1]]
        names = re.findall(r'\["name"\]= "([^"]*)"', chunk)
        if names:
            # first name = class, remaining = its ascendancies in order
            classes.append({"name": names[0], "ascendancies": names[1:]})
    return classes


def parse_nodes(tree_lua: str) -> dict[str, dict]:
    """Map node-id -> {name, keystone, notable, mastery, jewel, ascendancy, stats}."""
    nstart = tree_lua.find('["nodes"]=')
    section = tree_lua[nstart:] if nstart != -1 else tree_lua
    nodes: dict[str, dict] = {}
    matches = list(re.finditer(r"\n        \[(\d+)\]=\s*\{", section))
    for i, m in enumerate(matches):
        nid = m.group(1)
        end = matches[i + 1].start() if i + 1 < len(matches) else len(section)
        blk = section[m.end(): end]
        name_m = re.search(r'\["name"\]= "((?:[^"\\]|\\.)*)"', blk)
        asc_m = re.search(r'\["ascendancyName"\]= "([^"]*)"', blk)
        is_mastery = '["isMastery"]= true' in blk
        nodes[nid] = {
            "name": name_m.group(1) if name_m else None,
            "keystone": '["isKeystone"]= true' in blk,
            "notable": '["isNotable"]= true' in blk,
            "mastery": is_mastery,
            "jewel": '["isJewelSocket"]= true' in blk,
            "ascendancy": asc_m.group(1) if asc_m else None,
            "stats": [] if is_mastery else _extract_stats(blk),
        }
    return nodes


def parse_nodes_poe2(tree_lua: str) -> dict[str, dict]:
    """PoE2 variant — tab-indented, bare keys (`name=`, `isKeystone=true`,
    `[id]={`). PoE2 has no mastery system, so no mastery nodes here.

    Node entries sit at 2 tabs inside the top-level `nodes={ ... }` table; we
    bound to that table so we don't pick up `[id]={` entries from sibling tables
    (classes, groups). Inner `connections` entries are deeper-indented and so
    don't match the 2-tab node header."""
    m = re.search(r"\n\tnodes=\{", tree_lua)
    if not m:
        return {}
    start = m.end()
    end_m = re.search(r"\n\t[A-Za-z_]+=", tree_lua[start:])  # next top-level (1-tab) key
    section = tree_lua[start: start + end_m.start()] if end_m else tree_lua[start:]
    nodes: dict[str, dict] = {}
    matches = list(re.finditer(r"\n\t\t\[(\d+)\]=\{", section))
    for i, mm in enumerate(matches):
        nid = mm.group(1)
        end = matches[i + 1].start() if i + 1 < len(matches) else len(section)
        blk = section[mm.end(): end]
        name_m = re.search(r'\bname="((?:[^"\\]|\\.)*)"', blk)
        asc_m = re.search(r'\bascendancyName="([^"]*)"', blk)
        nodes[nid] = {
            "name": name_m.group(1) if name_m else None,
            "keystone": "isKeystone=true" in blk,
            "notable": "isNotable=true" in blk,
            "mastery": False,
            "jewel": "isJewelSocket=true" in blk,
            "ascendancy": asc_m.group(1) if asc_m else None,
            "stats": _extract_stats(blk),
        }
    return nodes


def parse_mastery_effects(tree_lua: str) -> dict[str, str]:
    """Map mastery-effect-id -> its stat text."""
    effects: dict[str, str] = {}
    for m in re.finditer(r'\["effect"\]=\s*(\d+),\s*\["stats"\]=\s*\{(.*?)\}', tree_lua, re.S):
        stats = re.findall(r'"((?:[^"\\]|\\.)*)"', m.group(2))
        if stats:
            effects[m.group(1)] = " / ".join(s.replace("\\n", " / ") for s in stats)
    return effects


# ─── High-level resolution ────────────────────────────────────────────────────

def resolve_spec(
    *,
    game: str | None,
    version: str,
    nodes: str,
    class_id: str = "",
    ascend_class_id: str = "",
    mastery_effects: str = "",
    allow_download: bool = True,
) -> dict:
    """Resolve a build's tree spec into a structured, named breakdown.

    `nodes` is the raw comma-separated id string from the Spec. Returns a dict
    with `resolved` False (counts only) when the tree data can't be loaded, so
    callers can always render *something*."""
    node_ids = [n for n in (nodes or "").split(",") if n]
    game = game or detect_game(version)
    mastery_pairs = re.findall(r"\{(\d+),(\d+)\}", mastery_effects or "")

    base = {
        "resolved": False,
        "game": game,
        "version": version,
        "counts": {"allocated": len(node_ids), "masteries": len(mastery_pairs)},
    }

    tree_lua = fetch_tree_data(game, version, allow_download=allow_download)
    if not tree_lua:
        return base

    # The two games store tree.lua differently (PoE1: space-indented, ["key"]=
    # style; PoE2: tab-indented, bare keys, no mastery system). PoE2 class names
    # are already shown in the doc's overview table, so we don't re-resolve them
    # from the deeply-nested PoE2 classes table — node names are what matter.
    if game == "poe2":
        classes = []
        tree_nodes = parse_nodes_poe2(tree_lua)
        effects = {}
    else:
        classes = parse_classes(tree_lua)
        tree_nodes = parse_nodes(tree_lua)
        effects = parse_mastery_effects(tree_lua)

    # If parsing yields nothing (unexpected/changed layout), degrade to
    # counts-only rather than emit an empty breakdown.
    if not tree_nodes:
        return base

    cls_name = asc_name = None
    if class_id.isdigit() and int(class_id) < len(classes):
        c = classes[int(class_id)]
        cls_name = c["name"]
        if ascend_class_id.isdigit() and 0 < int(ascend_class_id) <= len(c["ascendancies"]):
            asc_name = c["ascendancies"][int(ascend_class_id) - 1]

    def named(nd):
        return {"name": nd["name"] or "?", "stats": "; ".join(nd["stats"])}

    keystones, notables, asc_notables, jewels, smalls, unknown = [], [], [], [], [], []
    small_stats = {}  # stat -> count (aggregation of the small passives)
    for nid in node_ids:
        nd = tree_nodes.get(nid)
        if nd is None:
            unknown.append(nid)
        elif nd["mastery"]:
            continue  # surfaced via masteryEffects below
        elif nd["jewel"]:
            jewels.append(nid)
        elif nd["keystone"]:
            keystones.append(named(nd))
        elif nd["notable"]:
            (asc_notables if nd["ascendancy"] else notables).append(named(nd))
        else:
            smalls.append(nid)
            for st in nd["stats"]:
                small_stats[st] = small_stats.get(st, 0) + 1

    masteries = []
    for node_id, eff_id in mastery_pairs:
        masteries.append({
            "name": (tree_nodes.get(node_id) or {}).get("name") or "Mastery",
            "effect": effects.get(eff_id, f"effect #{eff_id}"),
        })

    return {
        "resolved": True,
        "game": game,
        "version": version,
        "class": cls_name,
        "ascendancy": asc_name,
        "counts": {
            "allocated": len(node_ids),
            "keystones": len(keystones),
            "notables": len(notables),
            "ascNotables": len(asc_notables),
            "masteries": len(masteries),
            "jewels": len(jewels),
            "small": len(smalls),
            "unknown": len(unknown),
        },
        "keystones": keystones,
        "notables": sorted(notables, key=lambda n: n["name"]),
        "ascNotables": asc_notables,
        "masteries": masteries,
        # Small passives aggregated by stat: [{stat, count}] sorted by descending count.
        "smallsBreakdown": [
            {"stat": s, "count": c}
            for s, c in sorted(small_stats.items(), key=lambda kv: (-kv[1], kv[0]))
        ],
    }

# ─── Extension registration (Atlas server hook) ───────────────────────────────


def register(context):
    """Register POST /api/pob-tree (admin role, the default for POSTs).

    Expected JSON body: {game?, version, nodes, classId?, ascendClassId?,
    masteryEffects?} — the same keys as the engine's former native endpoint.
    Response: the resolve_spec dict (resolved True/False + breakdown)."""

    def pob_tree_route(handler, match):
        data = handler._read_json()
        try:
            result = resolve_spec(
                game=(data.get("game") or "").strip() or None,
                version=(data.get("version") or "").strip(),
                nodes=data.get("nodes") or "",
                class_id=str(data.get("classId") or ""),
                ascend_class_id=str(data.get("ascendClassId") or ""),
                mastery_effects=data.get("masteryEffects") or "",
            )
            handler._send_json(200, result)
        except Exception as e:
            handler._send_json(500, {"error": str(e)})

    context.add_route("POST", r"^/api/pob-tree$", pob_tree_route, role="admin")
