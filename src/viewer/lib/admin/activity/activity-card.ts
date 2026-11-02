// Activity on the home — the shell / controller: Journal / Constellation / Santé views over the
// attributed git history, beside the Inbox. Reads GET /api/activity (the read side of the attribution
// layer); reuses the real constellation avatars. The home (home/home-view.ts) lays out one card per
// view; this shell fills them all at once, no tabs, so the week reads at a glance.
//
// The card is split across the sibling ./activity-*.ts modules: static registries live in
// ./activity-icons, the pure projections in ./activity-model, and the three views in
// ./activity-{journal,orrery,health}. This shell owns the data lifecycle (load → aggregate →
// digest), the shared state + helper cluster, the chrome (skeleton, highlights, AI filter, wiring),
// and hands each view a render context (see ActivityRenderCtx) so the helpers are defined once and can
// never diverge between views. The single instance is constructed in ./activity-boot; the imports above
// guarantee every class is defined before `new ActivityCard()` runs.

import { EMBED_ACTIVITY, IS_OFFLINE_BUILD } from '../../core/data-csrf';
import { LANG, t } from '../../core/i18n';
import { escapeHtml } from '../../core/utils';
import { fileMap } from '../../core/tree';
import { avatarSeed, constellationSvg } from '../../ui/avatar';
import { historyPanel } from '../../content/history-panel';
import { docRenderer } from '../../content/doc-renderer';
import { ActivityIcons } from './activity-icons';
import { ActivityModel } from './activity-model';
import { ActivityJournal } from './activity-journal';
import { ActivityOrrery } from './activity-orrery';
import { ActivityHealth } from './activity-health';
import { ActivityUndo } from './activity-undo';

export class ActivityCard {
  // ---- state ----
  private items: ActivityItem[] | null = null;
  private aiOnly = false; // 13d: filter the feed to AI-authored events only
  private digest: ActivityDigest | null = null; // 13b: factual digest of the last 7 days
  private expanded = false;
  private panelJournal: HTMLElement | null = null; // the Journal in the menu's panel, while open

  // ---- views (each renders from the shared helper cluster + live state via the render context) ----
  private readonly journalView: ActivityJournal;
  private readonly orreryView: ActivityOrrery;
  private readonly healthView: ActivityHealth;
  // After an undo the tree and the feed both moved: the soft reload patches the tree, then the feed.
  private readonly undo = new ActivityUndo(() => (window.softReload ? window.softReload() : this.refreshData()));

  constructor() {
    // `self` (not `this`): the context's getters are plain object-literal getters whose own `this` is
    // the context object, so they reach the shell through this captured reference. The feed + helpers
    // stay single-sourced here; the views only ever read through this object.
    const self = this;
    const ctx: ActivityRenderCtx = {
      shownItems: () => self.shownItems(),
      get expanded() {
        return self.expanded;
      },
      get aiOnly() {
        return self.aiOnly;
      },
      TY: (type) => self.TY(type),
      iconSvg: (type, size) => self.iconSvg(type, size),
      verb: (type) => self.verb(type),
      verbPhrase: (type) => self.verbPhrase(type),
      avatar: (e, size) => self.avatar(e, size),
      aiBadge: (family) => self.aiBadge(family),
      rel: (min) => self.rel(min),
      dayKey: (min) => self.dayKey(min),
      docTitle: (p) => self.docTitle(p),
      skelRows: (n) => self.skelRows(n),
      openDocHistory: (path) => self.openDocHistory(path),
      hasDoc: (path) => typeof fileMap !== 'undefined' && !!fileMap[path],
    };

    this.journalView = new ActivityJournal(ctx);
    this.orreryView = new ActivityOrrery(ctx);
    this.healthView = new ActivityHealth(ctx);
  }

  // ---- small render helpers (the shared cluster; the views reach these through the render context) ----
  private TY(type: string) {
    return ActivityIcons.TYPES[type] || ActivityIcons.TYPES.edit;
  }

  private verb(type: string): string {
    return (ActivityIcons.VERB[LANG] || ActivityIcons.VERB.fr)[type] || type;
  }

  // In a sentence ("Ludovic a créé X"), French wants the auxiliary; English doesn't. The bare
  // verb() stays for the orrery legend, where chips read as labels, not sentences.
  private verbPhrase(type: string): string {
    return (LANG === 'en' ? '' : 'a ') + this.verb(type);
  }

  private docTitle(p: string): string {
    return ((p || '').split('/').pop() || p).replace(/\.(md|html)$/i, '');
  }

  private iconSvg(type: string, size: number): string {
    const ty = this.TY(type);

    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${ty.color}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="${ty.d}"/></svg>`;
  }

  private aiBadge(family: string): string {
    return `<span class="activity-badge"><svg width="9" height="9" viewBox="0 0 24 24" fill="#e8941c"><path d="${ActivityIcons.AI[family] || ActivityIcons.AI.generic}"/></svg></span>`;
  }

  // Atlas Bot (the app's own automated writes) shows the application logo itself.
  private botAvatar(size: number): string {
    return `<img src="/icon.svg" width="${size}" height="${size}" alt="Atlas" style="display:block">`;
  }

  private avatar(e: ActivityItem, size: number): string {
    // The bot shows the app logo, served at /icon.svg. That URL 404s in a single-file OFFLINE
    // build (the img src is built at runtime, so the offline inliner can't rewrite it), so there
    // we fall back to a constellation glyph rather than a broken image.
    if (e.bot && !IS_OFFLINE_BUILD) return this.botAvatar(size);

    try {
      return constellationSvg(avatarSeed(e.first, e.last, e.email), size);
    } catch (_) {
      return `<span class="inline-block rounded-lg" style="width:${size}px;height:${size}px;background:rgb(var(--raise))"></span>`;
    }
  }

  private rel(min: number): string {
    const en = LANG === 'en';

    if (min < 1) return en ? 'just now' : "à l'instant";
    if (min < 60) return Math.round(min) + ' min';

    const hrs = Math.round(min / 60);

    if (hrs < 24) return hrs + ' h';

    const d = Math.round(min / 1440);

    if (d === 1) return en ? 'yesterday' : 'hier';

    return en ? d + 'd ago' : 'il y a ' + d + ' j';
  }

  private dayKey(min: number): string {
    const d = new Date(Date.now() - min * 60000);
    const now = new Date();
    const a = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const b = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diff = Math.round((a.getTime() - b.getTime()) / 86400000);

    if (diff <= 0) return LANG === 'en' ? 'Today' : "Aujourd'hui";
    if (diff === 1) return LANG === 'en' ? 'Yesterday' : 'Hier';

    return d.toLocaleDateString(LANG === 'en' ? 'en-US' : 'fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  // The feed honoring the AI-only filter — the source both the Journal and the Orrery index into.
  private shownItems(): ActivityItem[] {
    return this.aiOnly ? this.items!.filter((i) => i.ai) : this.items!;
  }

  // Show the doc's history overlay in place ("voir les modifications"), no navigation, the activity
  // feed stays put. No-ops if the doc no longer exists (deleted/moved).
  private openDocHistory(path: string): void {
    if (!path || typeof fileMap === 'undefined' || typeof historyPanel.open !== 'function') return;

    const f = fileMap[path];

    if (f) historyPanel.open(f);
  }

  // Go straight to the doc a change touched, the way the tree opens it.
  private openDoc(path: string): void {
    const f = typeof fileMap !== 'undefined' ? fileMap[path] : undefined;

    if (!f) return;
    docRenderer.show(f);
    history.replaceState(null, '', '#' + encodeURIComponent(f.path));
  }

  // ── Digest (the weekly summary above the Journal) ─────────────────────────
  // The hero's week: a bar per day (the AI's share on top), the figures, the busiest folder. Nothing
  // when nothing happened.
  private highlightsHtml(): string {
    const d = this.digest;

    if (!d || !d.docs) return '';

    const max = Math.max(1, ...d.days.map((x) => x.human + x.ai));
    const weekday = new Intl.DateTimeFormat(LANG, { weekday: 'narrow' });
    const bars = d.days
      .map((x, k) => {
        const n = x.human + x.ai;
        const day = weekday.format(new Date(Date.now() - (6 - k) * 86400000));

        return `<div class="hl-day${k === 6 ? ' is-today' : ''}" data-tip="${escapeHtml(t('hlDayTip', n, x.ai))}">`
          + `<i class="hl-bar"><em style="height:${n ? Math.max(6, Math.round((100 * n) / max)) : 0}%"><b class="hl-ai" style="flex:${x.ai}"></b><b style="flex:${x.human}"></b></em></i>`
          + `<span>${escapeHtml(day)}</span></div>`;
      })
      .join('');
    const stat = (n: number, label: string, cls = ''): string => `<div class="hl-stat${cls}"><b>${n}</b><span>${label}</span></div>`;

    return `<div class="hl-head"><span class="hl-label">${t('digestWeek')}</span>`
      + (d.top ? `<span class="hl-top">${t('hlTop')} <b>${escapeHtml(d.top.folder)}</b> · ${t('hlTopN', d.top.n)}</span>` : '')
      + `</div><div class="hl-body"><div class="hl-bars">${bars}</div>`
      + `<div class="hl-stats">${stat(d.docs, t('hlDocs', d.docs))}${stat(d.created, t('hlCreated', d.created))}${stat(d.ai, t('hlAi'), ' is-ai')}</div></div>`;
  }

  // ── Skeletons (first-load placeholder; also lent to the Health view via the context) ──────────────
  private skelRow(): string {
    return '<div class="flex items-center gap-3 py-2">'
      + '<div class="act-skel" style="width:30px;height:30px;border-radius:8px"></div>'
      + '<div class="flex-1"><div class="act-skel" style="width:42%;height:10px"></div>'
      + '<div class="act-skel" style="width:26%;height:8px;margin-top:6px"></div></div>'
      + '<div class="act-skel" style="width:38px;height:8px"></div></div>';
  }

  // The week panel and the orrery while the feed loads: their own frame, empty, so nothing jumps.
  private skelHighlights(): string {
    const day = '<div class="hl-day"><i class="hl-bar"></i><span>&nbsp;</span></div>';
    const stat = '<div class="hl-stat"><b class="act-skel" style="width:2.2rem">&nbsp;</b><span>&nbsp;</span></div>';

    return `<div class="hl-head"><span class="hl-label">${t('digestWeek')}</span></div>`
      + `<div class="hl-body"><div class="hl-bars">${day.repeat(7)}</div><div class="hl-stats">${stat.repeat(3)}</div></div>`;
  }

  private skelOrrery(): string {
    const ring = (r: number) => `<circle cx="0" cy="0" r="${r}"/>`;

    // The orrery's own layout (a square sky beside the legend column), so the card keeps its height.
    return `<div class="act-orrery flex items-start gap-4"><div class="act-sky relative flex-1 min-w-0">`
      + `<svg class="act-orrery-skel" viewBox="-266 -266 532 532">${ring(104)}${ring(172)}${ring(236)}<circle class="act-orrery-skel-sun" r="26"/></svg>`
      + '</div><div class="act-legend"></div></div>';
  }

  private skelRows(n: number): string {
    let s = '';

    for (let i = 0; i < n; i++) s += this.skelRow();

    return s;
  }

  // ── Chrome: the AI filter, the slots, the wiring ─────────────────────
  // A switch, not a button: it filters the Journal and the Constellation to what an AI wrote.
  private aiFilterHtml(): string {
    return `<button type="button" data-ai-filter class="home-switch" role="switch" aria-checked="${this.aiOnly}">${t('actAiOnly')}<span class="home-switch-knob"></span></button>`;
  }

  private renderOrrery(el: HTMLElement): void {
    el.innerHTML = this.orreryView.html();
    this.orreryView.wireHover(el);
    this.orreryView.wireSun(el);
  }

  // The Journal, and its card's open state ("See all" lets it grow past the card).
  private renderJournal(root: HTMLElement): void {
    root.querySelector('#activity-journal')!.innerHTML = this.journalView.html();
    root.querySelector('#home-card-journal')!.classList.toggle('is-open', this.expanded);
  }

  // The hero's highlights sit outside the root, at the top of the home.
  private renderHighlights(): void {
    const el = document.getElementById('activity-highlights');

    if (el) el.innerHTML = this.highlightsHtml();
  }

  // The feed's views: the hero's highlights, the AI filter, the Journal and the Constellation.
  private fill(root: HTMLElement): void {
    this.renderHighlights();
    root.querySelector('#activity-ai')!.innerHTML = this.aiFilterHtml();
    this.renderJournal(root);
    this.renderOrrery(root.querySelector<HTMLElement>('#activity-orrery')!);
  }

  private wire(root: HTMLElement): void {
    root.addEventListener('click', (ev) => {
      const fbtn = (ev.target as HTMLElement).closest<HTMLElement>('[data-ai-filter]');

      if (fbtn) {
        this.aiOnly = !this.aiOnly;
        this.expanded = false;
        this.fill(root);

        return;
      }
      if ((ev.target as HTMLElement).closest('.act-seeall')) {
        this.expanded = !this.expanded;
        this.renderJournal(root);

        return;
      }
      if ((ev.target as HTMLElement).closest('.act-hsee')) {
        this.healthView.toggleStale(root.querySelector<HTMLElement>('#activity-health')!);

        return;
      }
      if ((ev.target as HTMLElement).closest('.act-csee')) {
        this.healthView.toggleCand(root.querySelector<HTMLElement>('#activity-health')!);

        return;
      }

      const ht = (ev.target as HTMLElement).closest<HTMLElement>('[data-htab]');

      if (ht) {
        this.healthView.setTab(ht.dataset.htab!, root.querySelector<HTMLElement>('#activity-health')!);

        return;
      }

      const cd = (ev.target as HTMLElement).closest<HTMLButtonElement>('.act-cdismiss');

      if (cd) {
        this.healthView.dismiss(cd, root.querySelector<HTMLElement>('#activity-health')!);

        return;
      }

      const undoBtn = (ev.target as HTMLElement).closest<HTMLElement>('.act-undo');

      if (undoBtn) {
        this.undo.toggle(undoBtn.closest<HTMLElement>('.act-row')!, undoBtn.dataset.sha!);

        return;
      }
      if ((ev.target as HTMLElement).closest('.act-undo-panel')) return;

      const openEl = (ev.target as HTMLElement).closest<HTMLElement>('.act-open');

      if (openEl) {
        ev.preventDefault();
        this.openDoc(openEl.closest<HTMLElement>('[data-path]')!.dataset.path!);

        return;
      }
      if ((ev.target as HTMLElement).closest('#activity-inbox')) return; // the Inbox handles its own clicks

      const rowEl = (ev.target as HTMLElement).closest<HTMLElement>('.act-journal [data-path], #activity-health [data-path], #activity-orrery [data-path]');

      if (rowEl && rowEl.dataset.path) this.openDocHistory(rowEl.dataset.path);
    });
  }

  // ── Data ──────────────────────────────────────────────────────────────
  private async load(): Promise<ActivityItem[] | null> {
    // Offline build: read the activity snapshot frozen into the page at build time (public minds
    // only) instead of hitting /api/activity.
    if (IS_OFFLINE_BUILD) {
      return EMBED_ACTIVITY ? (EMBED_ACTIVITY as ActivitySnapshot).events.map(ActivityModel.toItem) : null;
    }
    if (!location.protocol.startsWith('http')) return null;

    try {
      const r = await fetch('/api/activity?since=60&limit=200');

      if (!r.ok) return null;

      const data = (await r.json()) as ActivitySnapshot;

      return Array.isArray(data.events) ? data.events.map(ActivityModel.toItem) : null;
    } catch (_) {
      return null;
    }
  }

  // The menu's Journal panel (home/side-panels.ts): the whole feed in a fresh box, wired like the
  // home's (open a doc, its history, undo).
  async openJournal(host: HTMLElement): Promise<void> {
    const box = document.createElement('div');

    box.className = 'act-journal';
    host.replaceChildren(box);
    this.wire(box);
    this.panelJournal = box;
    if (!this.items) {
      box.innerHTML = this.skelRows(8);
      const loaded = await this.load();

      this.items = loaded ? ActivityModel.aggregate(loaded) : [];
      this.digest = loaded ? ActivityModel.computeDigest(loaded) : null;
    }
    if (box.isConnected) box.innerHTML = this.journalView.html(true);
  }

  // ── Public API (mountActivity / refreshActivityData) ──────────────────
  // Fill the slots showWelcome() just laid out. Robust to evaluation order: showWelcome guards on
  // window.mountActivity, and ./activity-boot also self-calls mountActivity on load.
  async mount(): Promise<void> {
    const root = document.getElementById('home-activity-card');

    if (!root || root.dataset.mounted) return;
    root.dataset.mounted = '1';
    this.expanded = false;
    this.wire(root);
    root.querySelector('#activity-ai')!.innerHTML = this.aiFilterHtml(); // no data needed: in place from the start

    // The Santé and the Inbox load on their own; the feed fills the rest.
    const health = root.querySelector<HTMLElement>('#activity-health')!;

    health.innerHTML = this.healthView.html();
    this.healthView.load(health);

    const inbox = root.querySelector<HTMLElement>('#activity-inbox');

    if (inbox && window.AtlasInbox) {
      window.AtlasInbox.mount(inbox);
      window.AtlasInbox.show();
    }
    // Re-fetch on every mount (the feed must show edits made since the home was last shown), with
    // the last feed or a skeleton meanwhile.
    if (this.items && this.items.length) this.fill(root);
    else {
      const hl = document.getElementById('activity-highlights');

      if (hl) hl.innerHTML = this.skelHighlights();
      root.querySelector('#activity-journal')!.innerHTML = this.skelRows(8);
      root.querySelector('#activity-orrery')!.innerHTML = this.skelOrrery();
    }

    const loaded = await this.load();

    if (!root.isConnected) return; // the home was left meanwhile
    this.items = loaded ? ActivityModel.aggregate(loaded) : [];
    this.digest = loaded ? ActivityModel.computeDigest(loaded) : null;
    this.fill(root);
  }

  // Live-reload refresh: the feed's views update in place; the Inbox and the Santé manage themselves,
  // so an inbox item being edited is never touched.
  async refreshData(): Promise<void> {
    const root = document.getElementById('home-activity-card');

    if (!IS_OFFLINE_BUILD && window.AtlasInbox) window.AtlasInbox.refreshBadge(); // the menu's count, home or not
    if (!root) return;

    const loaded = await this.load();

    if (!loaded || !root.isConnected) return;
    this.items = ActivityModel.aggregate(loaded);
    this.digest = ActivityModel.computeDigest(loaded);
    this.renderHighlights();
    this.renderJournal(root);
    this.renderOrrery(root.querySelector<HTMLElement>('#activity-orrery')!);
    if (this.panelJournal?.isConnected) this.panelJournal.innerHTML = this.journalView.html(true);
  }
}
