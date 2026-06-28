// Santé ("health") view of the home Activity card (13c): obsolescence (deterministic, server-side) +
// contradiction candidates (server pre-filter, the AI judges via MCP). It owns its own state — the two
// fetched lists, the persisted sub-tab and the per-list expand flags — and the contradiction-dismiss
// POST that used to live in the shell's wire(). Renders deterministic helpers (docTitle, skelRows)
// through the ActivityRenderCtx; doc clicks are routed by the shell's delegated [data-path] handler.
// Top-level (no IIFE) so it is a shared symbol in the concat scope.

import { EMBED_ACTIVITY, IS_OFFLINE_BUILD } from '../../core/data-csrf';
import { t } from '../../core/i18n';
import { escapeHtml } from '../../core/utils';

export class ActivityHealth {
  private health: { stale: StaleDoc[]; cands: ContradictionCand[] } | null = null;
  private healthExpanded = false;
  private candExpanded = false;
  // 13c: persisted Santé sub-view.
  private healthTab: string = (() => { try { return localStorage.getItem('atlas:healthTab') || 'stale'; } catch (_) { return 'stale'; } })();

  constructor(private readonly ctx: ActivityRenderCtx) {}

  // 13c: Santé, obsolescence (déterministe serveur) + candidats de contradiction (pré-filtre
  // serveur ; l'IA juge via MCP). Les clics sur un doc rouvrent son historique.
  async load(container: HTMLElement): Promise<void> {
    let stale: StaleDoc[] = [];
    let cands: ContradictionCand[] = [];

    if (IS_OFFLINE_BUILD) {
      // Offline: from the embedded snapshot (same shape as /api/stale and the
      // /api/contradictions candidates), no network.
      stale = (EMBED_ACTIVITY && EMBED_ACTIVITY.stale) || [];
      cands = (EMBED_ACTIVITY && EMBED_ACTIVITY.contradictions) || [];
    } else {
      try {
        const [rs, rc] = await Promise.all([
          fetch('/api/stale?months=6&limit=40'),
          fetch('/api/contradictions?limit=50'),
        ]);

        if (rs.ok) stale = (await rs.json()).stale || [];
        if (rc.ok) cands = (await rc.json()).candidates || [];
      } catch (_) {}
    }
    this.health = { stale, cands };
    container.innerHTML = this.html();
  }

  html(): string {
    const tab = (active: boolean, v: string, label: string): string =>
      `<button type="button" data-htab="${v}" class="px-3 py-1.5 text-xs font-medium transition ${active ? 'text-accent' : 'text-ink-400 hover:text-ink-200'}" style="border-bottom:2px solid ${active ? '#1d9bd1' : 'transparent'};margin-bottom:-1px">${label}</button>`;
    const toggle =
      `<div class="flex mb-3" style="border-bottom:1px solid #2a2a32">`
      + tab(this.healthTab === 'stale', 'stale', t('healthTabStale'))
      + tab(this.healthTab === 'cont', 'cont', t('healthTabCont'))
      + `</div>`;
    // Keep the sub-toggle stable; only the body swaps skeleton → content on fetch.
    const body = !this.health ? this.ctx.skelRows(3) : (this.healthTab === 'stale' ? this.staleHtml() : this.contHtml());

    return toggle + body;
  }

  private staleHtml(): string {
    const stale = this.health!.stale;

    if (!stale.length) return `<div class="text-ink-500 text-sm py-1">${t('healthNoStale')}</div>`;

    const shown = this.healthExpanded ? stale : stale.slice(0, 8);
    let out = shown.map((s) =>
      `<div class="act-row" data-path="${escapeHtml(s.path)}" data-tip="${escapeHtml(t('healthOpenHist'))}"><div class="flex items-center justify-between gap-3">`
      + `<div class="min-w-0"><div class="text-sm text-ink-200 truncate">${escapeHtml(this.ctx.docTitle(s.path))}</div>`
      + `<div class="text-xs text-ink-500 truncate">${escapeHtml(s.path)}</div></div>`
      + `<div class="shrink-0 text-xs text-ink-500">${t('healthMonthsAgo', Math.round(s.months_ago))}</div></div></div>`).join('');

    if (stale.length > 8) {
      out += `<div class="text-right mt-1"><a class="act-hsee text-sm text-accent hover:underline cursor-pointer">${this.healthExpanded ? t('actCollapse') : t('actSeeAllN', stale.length)}</a></div>`;
    }

    return out;
  }

  private contHtml(): string {
    const cands = this.health!.cands;

    if (!cands.length) return `<div class="text-ink-500 text-sm py-1">${t('healthNoCand')}</div>`;

    const shown = this.candExpanded ? cands : cands.slice(0, 8);
    let out = `<div class="text-xs text-ink-500 mb-2">${t('healthAskAi')}</div>`;

    out += shown.map((c) => {
      // Detector rows carry the conflicting values + their lines; cluster rows show the first
      // "à vérifier" evidence line if any, else the shared subject.
      const meta = c.kind === 'cluster'
        ? escapeHtml((c.evidence && c.evidence.length && c.evidence[0].text) || c.subject || '')
        : t('healthValueConflict', escapeHtml(c.subject || ''), escapeHtml(c.a_value || ''), escapeHtml(c.b_value || ''));
      const confPill = c.confidence === 'high'
        ? `<span class="shrink-0 text-xs px-1.5 py-0.5 rounded" style="background:#1d3a5b;color:#9ecbff" data-tip="${escapeHtml(t('healthConfHighHint'))}">${t('healthConfHigh')}</span>`
        : `<span class="shrink-0 text-xs px-1.5 py-0.5 rounded" style="background:#2a2a32;color:#9a9aa5" data-tip="${escapeHtml(t('healthReviewHint'))}">${t('healthReview')}</span>`;

      return `<div class="py-1.5"><div class="flex items-center gap-2 text-sm">`
        + `<div class="flex items-center gap-2 min-w-0 flex-1">`
        + (c.verdict === 'real' ? `<span class="shrink-0 text-xs px-1.5 py-0.5 rounded" style="background:#5b1d1d;color:#ffb4b4">${t('healthReal')}</span>` : confPill)
        + `<span class="text-ink-200 hover:text-accent cursor-pointer truncate" data-path="${escapeHtml(c.a)}">${escapeHtml(this.ctx.docTitle(c.a))}</span>`
        + `<span class="text-ink-500 shrink-0">⇄</span>`
        + `<span class="text-ink-200 hover:text-accent cursor-pointer truncate" data-path="${escapeHtml(c.b)}">${escapeHtml(this.ctx.docTitle(c.b))}</span></div>`
        + `<button type="button" class="act-cdismiss shrink-0 inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-lg border subtle-border bg-navy-600 hover:bg-navy-500 text-ink-300 hover:text-ink-100 transition" data-a="${escapeHtml(c.a)}" data-b="${escapeHtml(c.b)}" data-aline="${c.a_line || ''}" data-bline="${c.b_line || ''}" data-tip="${escapeHtml(t('healthDismissHint'))}">✓ ${t('healthDismiss')}</button></div>`
        + (meta ? `<div class="text-xs text-ink-500 mt-0.5 truncate">${meta}</div>` : '') + '</div>';
    }).join('');
    if (cands.length > 8) out += `<div class="text-right mt-1"><a class="act-csee text-sm text-accent hover:underline cursor-pointer">${this.candExpanded ? t('actCollapse') : t('actSeeAllN', cands.length)}</a></div>`;

    return out;
  }

  toggleStale(host: HTMLElement): void {
    this.healthExpanded = !this.healthExpanded;
    host.innerHTML = this.html();
  }

  toggleCand(host: HTMLElement): void {
    this.candExpanded = !this.candExpanded;
    host.innerHTML = this.html();
  }

  setTab(tab: string, host: HTMLElement): void {
    this.healthTab = tab;
    try { localStorage.setItem('atlas:healthTab', this.healthTab); } catch (_) {}
    host.innerHTML = this.html();
  }

  // Human verdict "pas une contradiction" (13c) → POST none, drop the row. The global fetch
  // wrapper injects the CSRF token. The pair resurfaces only if a doc is edited.
  dismiss(cd: HTMLButtonElement, host: HTMLElement): void {
    const { a, b, aline, bline } = cd.dataset;

    cd.disabled = true;

    // Pass the judged line numbers (value collisions carry them) so the verdict is span-bound
    // (F1): it survives edits ELSEWHERE in either doc, not just any edit.
    const body: { a?: string; b?: string; verdict: string; a_line?: number; b_line?: number } = { a, b, verdict: 'none' };

    if (aline) body.a_line = Number(aline);
    if (bline) body.b_line = Number(bline);
    fetch('/api/contradiction', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => {
      if (r.ok) {
        this.health!.cands = this.health!.cands.filter((c) => !((c.a === a && c.b === b) || (c.a === b && c.b === a)));
        host.innerHTML = this.html();
      } else { cd.disabled = false; }
    }).catch(() => { cd.disabled = false; });
  }
}
