"""The mind's weather, region by region (a top folder, and its subfolders): how busy it has been
lately (sun), what is going unread (fog: the docs nobody looked at for `months`, as stale counts
them), the contradictions to settle (storms) and how much of the writing came from an AI (wind).
With the periodic docs that went missing and the docs flagged outdated: a week's review in one
call."""
from collections import defaultdict

import server as _s
from server.pure import contradictions, rhythms
from server.pure.queries import _activity_events, _api_outdated, _api_stale, _visible

_MAX_EVENTS = 2000
_MAX_STORMS = 30


def _regions(rel: str) -> list:
    """The regions a doc counts in: its top folder, and its subfolder below it ('' at the root)."""
    parts = rel.split("/")[:-1]
    return ["/".join(parts[:depth]) for depth in (1, 2) if len(parts) >= depth] or [""]


def weather(weeks: int, months: int, ctx=None) -> dict:
    regions = defaultdict(lambda: {"docs": 0, "commits": set(), "ai": set(), "changed": set(),
                                   "fog": 0, "storms": 0, "outdated": 0})
    for rel, _ in _s._iter_doc_files():
        if _visible(rel, ctx):
            for r in _regions(rel):
                regions[r]["docs"] += 1
    commits, ai_commits = set(), set()
    for event in _activity_events(weeks * 7, _MAX_EVENTS, None, None, ctx) or []:
        commits.add(event["sha"])
        if event["ai"]:
            ai_commits.add(event["sha"])
        for rel in event["paths"]:
            for r in _regions(rel):
                if r in regions:  # a doc since deleted no longer has a region of its own
                    regions[r]["commits"].add(event["sha"])
                    regions[r]["changed"].add(rel)
                    if event["ai"]:
                        regions[r]["ai"].add(event["sha"])
    fog = _api_stale(months, 100_000, ctx)
    for doc in fog:
        for r in _regions(doc["path"]):
            regions[r]["fog"] += 1
    outdated = _api_outdated(ctx)
    for doc in outdated:
        for r in _regions(doc["path"]):
            regions[r]["outdated"] += 1
    # The ones worth a human's time: precise detectors and pairs already judged real.
    storms = contradictions.find_contradictions(ctx, _MAX_STORMS, solid_only=True)
    for pair in storms:
        for r in set(_regions(pair["a"])) | set(_regions(pair["b"])):
            if r in regions:
                regions[r]["storms"] += 1

    def card(path):
        m = regions[path]
        return {"path": path, "docs": m["docs"], "commits": len(m["commits"]), "changed": len(m["changed"]),
                "ai_share": round(len(m["ai"]) / len(m["commits"]), 2) if m["commits"] else 0,
                "fog": m["fog"], "storms": m["storms"], "outdated": m["outdated"]}

    tops = sorted((p for p in regions if "/" not in p), key=lambda p: -regions[p]["docs"])
    return {
        "weeks": weeks,
        "months": months,
        "totals": {"docs": sum(regions[p]["docs"] for p in tops), "commits": len(commits),
                   "ai_share": round(len(ai_commits) / len(commits), 2) if commits else 0,
                   "fog": len(fog), "storms": len(storms), "outdated": len(outdated)},
        "regions": [{**card(top), "children": [card(p) for p in sorted(
            (p for p in regions if p.startswith(top + "/")), key=lambda p: -regions[p]["docs"])]}
            for top in tops],
        "storms": [{k: pair[k] for k in ("a", "b", "kind", "subject", "confidence") if k in pair} for pair in storms],
        "outdated": outdated,
        "missed": rhythms.missed(ctx),
    }
