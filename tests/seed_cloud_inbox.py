#!/usr/bin/env python3
"""Stream inbox items (plus a real contradiction) to your LOCAL atlas-dev-cloud, paced, so you
watch them land one by one in the Inbox tab and see a contradiction surface in Sante.

Two terminals:
    1)  atlas-dev-cloud                      # your zsh function: http://127.0.0.1:8798, login dev@local/dev
    2)  python3 tests/seed_cloud_inbox.py    # this script (defaults already point at it)

It mints one API token per source (gmail, sentry, ...) bound to dev@local by writing to the
sandbox's .atlas store (the running server reads it live), so you get real, varied source chips.
Then it seeds two docs that disagree (a contradiction) and streams the inbox items.

Env overrides: ATLAS_URL, ATLAS_MIND, ATLAS_BOSS, DELAY (seconds, default 4), NO_SEED=1,
ATLAS_TOKEN (use this single token for everything instead of minting -> one source chip).
Prereq: the sandbox runs the local code, so it must be on the inbox branch (it is, here)."""
import hashlib
import json
import os
import secrets
import sys
import time
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
URL = os.environ.get("ATLAS_URL", "http://127.0.0.1:8798").rstrip("/")
MIND = os.environ.get("ATLAS_MIND", "/tmp/atlas-dev-cloud-mind")
BOSS = os.environ.get("ATLAS_BOSS", "dev@local")
TOKEN = os.environ.get("ATLAS_TOKEN", "")
DELAY = float(os.environ.get("DELAY", "4"))


def mcp(token, tool, args):
    payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                          "params": {"name": tool, "arguments": args}}).encode()
    req = urllib.request.Request(f"{URL}/mcp/{token}", data=payload,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            res = json.loads(r.read())
    except Exception as e:
        return True, str(e)
    out = res.get("result") or {}
    text = ((out.get("content") or [{}])[0]).get("text", "")
    return bool(out.get("isError")), text


def mint_tokens(sources):
    """One API token per source, bound to BOSS, written into the sandbox's .atlas store (the
    running server reads it live, same mechanism the tests use). Returns {source: token}."""
    sys.path.insert(0, str(REPO / "src"))
    import store
    from config import AtlasConfig
    cfg = AtlasConfig.load(root=Path(MIND))
    fs = store.FileStore(cfg.store_dir)
    if fs.get_user_by_email(BOSS) is None:
        sys.exit(f"No account {BOSS} in {MIND}. Launch `atlas-dev-cloud` first (it seeds dev@local), "
                 "or set ATLAS_BOSS / ATLAS_MIND.")
    out = {}
    for s in sources:
        tok = secrets.token_hex(32)
        fs.upsert_user(store.token_email(s, BOSS), {
            "role": "api", "acts_as": BOSS,
            "api_token_hash": hashlib.sha256(tok.encode()).hexdigest()})
        out[s] = tok
    return out


# Two corpus docs that disagree on the SAME metric -> a contradiction shows in Sante (the proven
# 22-vs-24 pair). Plus an oncall doc the inbox items echo (so the "meme sujet" signal fires).
SEED_DOCS = [
    ("notes/atlas-by-the-numbers.md",
     "---\ntags: [note, reference]\n---\n# Atlas en chiffres\n\nFiche memo des chiffres cles.\n\n"
     "| metrique | valeur |\n|---|---|\n| outils MCP | 22 |\n| langues | 2 |\n"),
    ("guides/whats-inside.md",
     "---\ntags: [guide, reference]\n---\n# Ce qu'il y a dedans\n\nApercu pour qui decouvre Atlas.\n\n"
     "| metrique | valeur |\n|---|---|\n| outils MCP | 24 |\n| langues | 2 |\n"),
    ("ops/oncall.md",
     "---\ntags: [ops]\n---\n# Astreinte oncall\n\nRotation oncall du week-end, escalade PagerDuty "
     "niveau 2, runbook incidents production.\n\n| parametre | valeur |\n|---|---|\n"
     "| rotation week-end | 4 h |\n"),
]

ITEMS = [
    {"source": "sentry", "title": "Astreinte week-end : rotation passee a 6 h", "confidence": 0.92,
     "suggest_dest": "ops/", "suggest_tags": ["ops", "astreinte"],
     "content": "Ticket OPS-4127 : la rotation d'astreinte oncall du week-end passe a 6 h par "
                "creneau (au lieu de 4 h). Escalade PagerDuty inchangee.\n\n"
                "| parametre | valeur |\n|---|---|\n| rotation week-end | 6 h |\n"},
    {"source": "manual", "title": "Penser a migrer le cache Redis en cluster", "confidence": 0.9,
     "suggest_dest": "projets/", "content": "Capture : Redis doit passer en cluster avant la v0.9, "
                                            "sinon saturation memoire en prod. A planifier ce sprint."},
    {"source": "gmail", "title": "Recap reunion produit : decisions pricing Q3", "confidence": 0.7,
     "suggest_dest": "reunions/", "suggest_tags": ["produit", "pricing"],
     "content": "Synthese : palier intermediaire a 29 euros, suppression de l'offre annuelle, essai 30 j."},
    {"source": "sentry", "title": "Pic de timeouts sur /api/checkout", "confidence": 0.81,
     "content": "3 occurrences en 1 h, p95 a 8 s, correle au deploiement de 14 h."},
    {"source": "scraper", "title": "Concurrent Klayn lance une offre a 19 euros/mois", "confidence": 0.55,
     "suggest_dest": "veille/", "suggest_tags": ["veille", "klayn"],
     "content": "Page tarifs de Klayn : entree de gamme a 19 euros/mois, studio photo IA inclus."},
    {"source": "webhook", "title": "Deploiement prod v0.8.7 reussi", "confidence": 0.95,
     "suggest_dest": "ops/", "suggest_tags": ["ops", "deploy"],
     "content": "Webhook CI : v0.8.7 en production, build vert, 0 regression, duree 4 min 12 s."},
    {"source": "slack", "title": "Idee : mode hors-ligne pour le viewer mobile", "confidence": 0.3,
     "content": "Message produit : cache hors-ligne pour consulter sa KB sans reseau. A creuser."},
    {"source": "webhook", "title": "PagerDuty : escalade astreinte niveau 2 cette nuit", "confidence": 0.88,
     "suggest_dest": "ops/", "suggest_tags": ["ops", "astreinte"],
     "content": "Webhook PagerDuty : une escalade oncall niveau 2 a eu lieu cette nuit, incident reformule."},
    {"source": "gmail", "title": "Demande de partenariat : agence Onyx", "confidence": 0.62,
     "content": "Mail entrant : l'agence Onyx propose un partenariat revendeur, a qualifier."},
    {"source": "sentry", "title": "Astreinte : numero secondaire a mettre a jour", "confidence": 0.79,
     "suggest_dest": "ops/", "suggest_tags": ["ops", "astreinte"],
     "content": "Le numero d'astreinte oncall secondaire a change, a repercuter dans la fiche oncall."},
]


def main():
    sources = sorted({it["source"] for it in ITEMS})
    if TOKEN:
        tokens = {s: TOKEN for s in sources}
        print(f"single-token mode: all items use ATLAS_TOKEN (one source chip)\ntarget: {URL}\n")
    else:
        tokens = mint_tokens(sources)
        print(f"target: {URL}\nminted {len(tokens)} source tokens in {MIND}, bound to {BOSS}: "
              f"{', '.join(sources)}\n")
    seed_tok = next(iter(tokens.values()))
    if not os.environ.get("NO_SEED"):
        print("seeding the corpus (a contradiction for Sante + neighbours for the inbox signal):")
        for path, content in SEED_DOCS:
            err, msg = mcp(seed_tok, "create_doc", {"path": path, "content": content, "ai": "seed"})
            print(f"  {'FAIL' if err else 'ok  '} {path}" + (f"  -> {msg[:70]}" if err else ""))
        print()
    print(f"streaming {len(ITEMS)} inbox items every {DELAY:g}s (open Activite -> Inbox, watch):")
    for i, it in enumerate(ITEMS, 1):
        args = {k: v for k, v in it.items() if k != "source"}
        err, msg = mcp(tokens[it["source"]], "create_inbox_item", args)
        print(f"  [{i:>2}/{len(ITEMS)}] {'FAIL' if err else it['source']:<8} {it['title'][:48]}"
              + (f"  -> {msg[:70]}" if err else ""))
        if err and "Unknown tool" in msg:
            sys.exit("\nThe sandbox has no create_inbox_item: it is not on the inbox branch.")
        if i < len(ITEMS):
            time.sleep(DELAY)
    print("\ndone. Inbox tab = the items (sources as chips); Sante tab = the 'outils MCP 22 vs 24' "
          "contradiction; keep the rotation item to make a 6 h vs 4 h contradiction appear too.")


if __name__ == "__main__":
    main()
