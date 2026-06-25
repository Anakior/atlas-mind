"""Local live preview of the Inbox tab, seeded with one item of every kind.

Run it, open the printed URL, go to the "Activité" card on the home and click the "Inbox" tab:

    python3 tests/preview_inbox.py

It boots a throwaway Atlas (local mode, so you are superuser and see every lane), seeds a spread
of inbox items (sources, confidence tiers, suggested destinations, cosine neighbors, snoozed and
trashed), then waits. Keep/Trash/Snooze and the K/X/S shortcuts are live. Ctrl-C (or Enter) stops
it and deletes everything. Optional: `--shot out.png` screenshots the tab and exits (needs node
playwright)."""
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import AtlasServer, DEFAULT_MIND  # noqa: E402

USER = "demo"  # one person's lane (local mode shows every lane anyway)


def _item(source, slug, title, body, confidence=0.5, **fm):
    lines = ["---", "origin: inbox", f"source: {source}", f"confidence: {confidence}",
             f"inbox_status: {fm.pop('inbox_status', 'pending')}"]
    for k, v in fm.items():
        lines.append(f"{k}: {v}")
    lines += ["---", "", f"# {title}", "", body]
    return (f"inbox/{USER}/{source}/2026-06-25-{slug}.md", "\n".join(lines))


def _mind():
    mind = dict(DEFAULT_MIND)
    # A couple of graph docs so the pre-computed neighbors below actually resolve.
    mind["ops/oncall.md"] = "---\ntags: [ops]\n---\n# Astreinte oncall\n\nRotation oncall, escalade PagerDuty niveau 2, runbook incidents production."
    mind["projets/pricing.md"] = "---\ntags: [produit]\n---\n# Pricing\n\nGrille tarifaire, paliers, promotions saisonnieres."
    items = [
        # high confidence (green pill) + agent-suggested destination
        _item("gmail", "astreinte", "Astreinte week-end : rotation passee a 6h",
              "Ticket OPS-4127 : la rotation d'astreinte du week-end est desormais de 6h par "
              "creneau (au lieu de 4h). Reformule depuis le fil Sentry et le commentaire infra.",
              confidence=0.92, suggest_dest="ops/", suggest_tags="[ops, astreinte]"),
        # high confidence + NO suggest_dest but a cosine neighbor -> the tab proposes ops/
        _item("sentry", "timeouts", "Pic de timeouts sur /api/checkout",
              "3 occurrences en 1h, p95 a 8s. Correle au deploiement de 14h. Escalade possible.",
              confidence=0.81, neighbors="[ops/oncall.md]"),
        # medium confidence (grey pill)
        _item("scraper", "klayn", "Concurrent Klayn lance une offre a 19 euros par mois",
              "Veille : Klayn annonce un plan a 19 euros/mois avec onboarding guide. A comparer "
              "a notre pricing.", confidence=0.55, neighbors="[projets/pricing.md]"),
        # medium + suggested folder + tags
        _item("webhook", "deploy", "Deploiement prod v0.8.7 reussi",
              "Build vert, 0 regression sur la suite (709 tests). Duree 4 min 12 s.",
              confidence=0.5, suggest_dest="ops/", suggest_tags="[deploiement]"),
        # low confidence (pale pill), no hints
        _item("slack", "idee", "Idee : mode hors-ligne pour le viewer mobile",
              "Quelqu'un a propose un cache offline cote mobile. A creuser, pas prioritaire.",
              confidence=0.3),
        # the human's own quick capture (manual source), high confidence
        _item("manual", "redis", "Penser a migrer le cache Redis en cluster",
              "Avant la v0.9, sinon risque de saturation memoire en prod. A planifier ce sprint.",
              confidence=0.9, suggest_dest="projets/"),
        # long preview to show truncation
        _item("gmail", "partenariat", "Demande de partenariat : agence Onyx",
              "L'agence Onyx propose un partenariat de revente avec marge degressive selon le "
              "volume, un co-marketing sur deux trimestres, un webinaire commun et un acces "
              "anticipe a la roadmap. Ils demandent un retour avant la fin du mois.",
              confidence=0.62),
        # a snoozed item that is already DUE (past) -> visible
        _item("sentry", "revenu", "Rapport hebdo : revenu en hausse",
              "MRR +4,2% cette semaine. Rien d'alarmant.", confidence=0.45,
              inbox_status="snoozed", snooze_until="2020-01-01"),
        # hidden states (won't appear in the list) -> proves the filtering
        _item("gmail", "snoozed", "Rappel snooze a 2099 (cache)", "x",
              confidence=0.7, inbox_status="snoozed", snooze_until="2099-01-01"),
        _item("gmail", "trashed", "Spam jete (cache mais conserve)", "x",
              confidence=0.5, inbox_status="trashed"),
    ]
    mind.update(dict(items))
    return mind


def main():
    shot = None
    if "--shot" in sys.argv:
        shot = sys.argv[sys.argv.index("--shot") + 1]
    srv = AtlasServer(mind=_mind())
    srv.start()
    url = srv.base_url
    try:
        if shot:
            node = ("/home/anakior/.volta/tools/image/packages/playwright/lib/node_modules")
            js = (
                "const{chromium}=require('playwright');(async()=>{const[,,u,o]=process.argv;"
                "const b=await chromium.launch();const p=await b.newPage({viewport:{width:900,"
                "height:1000},deviceScaleFactor:2});await p.goto(u,{waitUntil:'domcontentloaded'});"
                "await p.waitForSelector('[data-view=\"inbox\"]',{timeout:15000});"
                "await p.click('[data-view=\"inbox\"]');await p.waitForSelector('.ibx-focus',"
                "{timeout:8000});await p.waitForTimeout(500);"
                "const c=await p.$('#home-activity-card');await(c||p).screenshot({path:o});"
                "console.log('shot OK');await b.close();})().catch(e=>{console.error(e.message);"
                "process.exit(1)});")
            tmp = os.path.join(os.path.dirname(shot), "_shot_inbox.cjs")
            with open(tmp, "w") as f:
                f.write(js)
            r = subprocess.run(["node", tmp, url, shot],
                               env=dict(os.environ, NODE_PATH=node),
                               capture_output=True, text=True, timeout=60)
            print(r.stdout.strip() or r.stderr.strip())
            return
        print(f"\n  Inbox preview: {url}")
        print("  -> open it, 'Activite' card, click the 'Inbox' tab. Keep/Trash/Snooze and K/X/S are live.")
        print("  -> hidden items (snoozed-future, trashed) are NOT listed: that is the filtering.")
        print("  Ctrl-C or Enter to stop.\n")
        try:
            input()
        except (EOFError, KeyboardInterrupt):
            pass
    finally:
        srv.stop()


if __name__ == "__main__":
    main()
