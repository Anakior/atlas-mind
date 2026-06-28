// Activity card (home) — the shell / controller: Journal / Constellation / Santé views over the
// attributed git history. Reads GET /api/activity (the read side of the attribution layer); reuses the
// real constellation avatars. Hidden offline / when there is nothing to show.
//
// The card is split across the sibling ./activity-*.ts modules: static registries live in
// ./activity-icons, the pure projections in ./activity-model, and the three views in
// ./activity-{journal,orrery,health}. This shell owns the data lifecycle (load → aggregate →
// digest), the shared state + helper cluster, the card chrome (skeleton, digest, view switch, wiring),
// and hands each view a render context (see ActivityRenderCtx) so the helpers are defined once and can
// never diverge between views. The single instance is constructed in ./activity-boot; the imports above
// guarantee every class is defined before `new ActivityCard()` runs.

import { EMBED_ACTIVITY, IS_OFFLINE_BUILD } from '../../core/data-csrf';
import { LANG, t } from '../../core/i18n';
import { fileMap } from '../../core/tree';
import { avatarSeed, constellationSvg } from '../../ui/avatar';
import { historyPanel } from '../../content/history-panel';
import { ActivityIcons } from './activity-icons';
import { ActivityModel } from './activity-model';
import { ActivityJournal } from './activity-journal';
import { ActivityOrrery } from './activity-orrery';
import { ActivityHealth } from './activity-health';

export class ActivityCard {
  // ---- state ----
  private items: ActivityItem[] | null = null;
  private aiOnly = false; // 13d: filter the feed to AI-authored events only
  private digest: ActivityDigest | null = null; // 13b: factual digest of the last 7 days
  private expanded = false;

  // ---- views (each renders from the shared helper cluster + live state via the render context) ----
  private readonly journalView: ActivityJournal;
  private readonly orreryView: ActivityOrrery;
  private readonly healthView: ActivityHealth;

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
      return `<span class="inline-block rounded-lg" style="width:${size}px;height:${size}px;background:#23222a"></span>`;
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

  // ── Digest (the weekly summary above the Journal) ─────────────────────────
  private digestHtml(): string {
    const d = this.digest;

    if (!d) return '';

    const ic = (path: string, color: string): string =>
      `<svg width="13" height="13" fill="none" stroke="${color}" stroke-width="1.9" viewBox="0 0 24 24" style="flex-shrink:0"><path stroke-linecap="round" stroke-linejoin="round" d="${path}"/></svg>`;
    const pill = (icon: string, n: number, label: string): string =>
      `<span class="act-legend-chip">${icon}<span class="text-ink-100 font-semibold">${n}</span> ${label}</span>`;
    const parts: string[] = [];

    if (d.docs) parts.push(pill(ic('M9 12h6m-6 4h6m2 4H7a2 2 0 01-2-2V5a2 2 0 012-2h7l5 5v11a2 2 0 01-2 2z', '#5e6066'), d.docs, t('digestDocs', d.docs)));
    if (d.created) parts.push(pill(ic('M12 4v16m8-8H4', this.TY('create').color), d.created, t('digestCreated', d.created)));
    if (d.checked) parts.push(pill(ic('M5 13l4 4L19 7', this.TY('check').color), d.checked, t('digestChecked', d.checked)));
    if (d.contributors) parts.push(pill(ic('M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-1.13a4 4 0 10-4-4 4 4 0 004 4z', '#5e6066'), d.contributors, t('digestContributors', d.contributors)));
    if (d.ai) parts.push(pill(ic('M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9l4.2-1.4z', '#e8941c'), d.ai, t('digestViaAi', d.ai)));
    if (!parts.length) return '';

    const hr = '<hr style="border:none;border-top:1px solid #2a2a32;margin:0">';

    return (
      `<div style="position:relative;margin-bottom:12px">
        ${hr}
        <div style="display:flex;flex-wrap:wrap;justify-content:center;gap:6px;margin:10px 0 9px">${parts.join('')}</div>
        ${hr}
        <span class="act-digest-when text-ink-500" style="position:absolute;right:0;bottom:5px;font-size:10px;text-transform:uppercase;letter-spacing:.06em;pointer-events:none">${t('digestWeek')}</span>
      </div>`
    );
  }

  // ── Skeletons (first-load placeholder; also lent to the Health view via the context) ──────────────
  private skelRow(): string {
    return '<div class="flex items-center gap-3 py-2">'
      + '<div class="act-skel" style="width:30px;height:30px;border-radius:8px"></div>'
      + '<div class="flex-1"><div class="act-skel" style="width:42%;height:10px"></div>'
      + '<div class="act-skel" style="width:26%;height:8px;margin-top:6px"></div></div>'
      + '<div class="act-skel" style="width:38px;height:8px"></div></div>';
  }

  private skelRows(n: number): string {
    let s = '';

    for (let i = 0; i < n; i++) s += this.skelRow();

    return s;
  }

  private skeletonHtml(): string {
    return '<div class="border subtle-border rounded-lg p-4 bg-black/15">'
      + '<div class="flex items-center justify-between mb-4">'
      + '<div class="act-skel" style="width:90px;height:18px"></div>'
      + '<div class="act-skel" style="width:150px;height:26px;border-radius:8px"></div></div>'
      + this.skelRows(4) + '</div>';
  }

  // ── Card shell + view switch ──────────────────────────────────────────
  private segClass(active: boolean): string {
    return 'activity-seg px-3 py-1 text-xs font-medium ' + (active ? 'is-active bg-accent text-white' : 'text-ink-300');
  }

  // A checkbox-style filter (small box + label), not a button, reads as "filter the feed".
  private aiFilterHtml(): string {
    return `<button type="button" data-ai-filter class="flex items-center gap-1.5 text-xs transition ${this.aiOnly ? 'text-accent' : 'text-ink-400 hover:text-ink-200'}" title="${t('actAiOnly')}">` +
      `<span style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:4px;font-size:10px;color:#fff;border:1.5px solid ${this.aiOnly ? '#1d9bd1' : '#5e6066'};background:${this.aiOnly ? '#1d9bd1' : 'transparent'}">${this.aiOnly ? '✓' : ''}</span>` +
      `${t('actAiOnly')}</button>`;
  }

  private cardHtml(): string {
    return (
      `<div id="home-activity-card" class="border subtle-border rounded-lg p-4 bg-black/15">
        <div class="act-card-head flex items-center justify-between gap-3 mb-3">
          <h2 class="!mb-0 !mt-0">${t('actTitle')}</h2>
          <div class="act-card-controls flex items-center gap-2 shrink-0">
            ${this.aiFilterHtml()}
            <div class="act-seg-group inline-flex rounded-lg border subtle-border overflow-hidden">
              <button type="button" data-view="journal" class="${this.segClass(true)}">${t('actJournal')}</button>
              <button type="button" data-view="orrery" class="${this.segClass(false)}">${t('actConstellation')}</button>
              <button type="button" data-view="health" class="${this.segClass(false)}">${t('actHealth')}</button>
              ${IS_OFFLINE_BUILD ? '' : `<button type="button" data-view="inbox" class="${this.segClass(false)}">${t('actInbox')} <span id="inbox-badge" class="act-ibadge hidden"></span></button>`}
            </div>
          </div>
        </div>
        <div id="activity-digest">${this.digestHtml()}</div>
        <div id="activity-journal">${this.journalView.html()}</div>
        <div id="activity-orrery" class="hidden"></div>
        <div id="activity-health" class="hidden"></div>
        <div id="activity-inbox" class="hidden"></div>
      </div>`
    );
  }

  private setView(card: HTMLElement, v: string, persist: boolean): void {
    const journalEl = card.querySelector('#activity-journal')!;
    const orreryEl = card.querySelector<HTMLElement>('#activity-orrery')!;
    const healthEl = card.querySelector<HTMLElement>('#activity-health')!;
    const inboxEl = card.querySelector<HTMLElement>('#activity-inbox');
    const digestEl = card.querySelector('#activity-digest'); // the weekly digest belongs to Journal only

    if (digestEl) digestEl.classList.toggle('hidden', v !== 'journal');
    if (v === 'orrery') {
      if (!orreryEl.dataset.rendered) { orreryEl.innerHTML = this.orreryView.html(); orreryEl.dataset.rendered = '1'; this.orreryView.wireHover(orreryEl); this.orreryView.wireSun(orreryEl); }
      // clear leftover one-shot animation classes so re-showing the tab never replays them
      orreryEl.querySelectorAll('.act-spin,.act-sun,.act-egg').forEach((el) => el.classList.remove('spinning', 'pop', 'show'));
    } else if (v === 'health' && !healthEl.dataset.rendered) {
      healthEl.dataset.rendered = '1'; healthEl.innerHTML = this.healthView.html(); this.healthView.load(healthEl);
    } else if (v === 'inbox' && inboxEl && !inboxEl.dataset.rendered && window.AtlasInbox) {
      inboxEl.dataset.rendered = '1'; window.AtlasInbox.mount(inboxEl); // the Inbox is its own module (inbox/inbox.ts)
    }
    journalEl.classList.toggle('hidden', v !== 'journal');
    orreryEl.classList.toggle('hidden', v !== 'orrery');
    healthEl.classList.toggle('hidden', v !== 'health');
    if (inboxEl) inboxEl.classList.toggle('hidden', v !== 'inbox');
    if (window.AtlasInbox) { if (v === 'inbox') window.AtlasInbox.show(); else window.AtlasInbox.hide(); }
    card.querySelectorAll<HTMLElement>('[data-view]').forEach((b) => { b.className = this.segClass(b.dataset.view === v); });
    if (persist) { try { localStorage.setItem('atlas:activityView', v); } catch (_) {} }
  }

  private wire(card: HTMLElement): void {
    let saved = 'journal';

    try { saved = localStorage.getItem('atlas:activityView') || 'journal'; } catch (_) {}

    const q = new URLSearchParams(location.search).get('view');

    if (q === 'journal' || q === 'orrery' || q === 'health' || q === 'inbox') saved = q;
    if (saved === 'inbox' && IS_OFFLINE_BUILD) saved = 'journal'; // inbox tab is online-only
    this.setView(card, saved, false);
    card.querySelectorAll<HTMLElement>('[data-view]').forEach((b) =>
      b.addEventListener('click', () => this.setView(card, b.dataset.view!, true)));
    card.addEventListener('click', (ev) => {
      const fbtn = (ev.target as HTMLElement).closest<HTMLElement>('[data-ai-filter]');

      if (fbtn) {
        this.aiOnly = !this.aiOnly;
        this.expanded = false;
        fbtn.outerHTML = this.aiFilterHtml();
        card.querySelector('#activity-journal')!.innerHTML = this.journalView.html();

        const orreryEl = card.querySelector<HTMLElement>('#activity-orrery')!;

        if (orreryEl.dataset.rendered) { orreryEl.innerHTML = this.orreryView.html(); this.orreryView.wireHover(orreryEl); this.orreryView.wireSun(orreryEl); }

        return;
      }
      if ((ev.target as HTMLElement).closest('[data-view]')) return;
      if ((ev.target as HTMLElement).closest('.act-seeall')) {
        this.expanded = !this.expanded;
        card.querySelector('#activity-journal')!.innerHTML = this.journalView.html();

        return;
      }
      if ((ev.target as HTMLElement).closest('.act-hsee')) {
        this.healthView.toggleStale(card.querySelector<HTMLElement>('#activity-health')!);

        return;
      }
      if ((ev.target as HTMLElement).closest('.act-csee')) {
        this.healthView.toggleCand(card.querySelector<HTMLElement>('#activity-health')!);

        return;
      }

      const ht = (ev.target as HTMLElement).closest<HTMLElement>('[data-htab]');

      if (ht) {
        this.healthView.setTab(ht.dataset.htab!, card.querySelector<HTMLElement>('#activity-health')!);

        return;
      }

      const cd = (ev.target as HTMLElement).closest<HTMLButtonElement>('.act-cdismiss');

      if (cd) {
        this.healthView.dismiss(cd, card.querySelector<HTMLElement>('#activity-health')!);

        return;
      }

      const rowEl = (ev.target as HTMLElement).closest<HTMLElement>('[data-path]');

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

  // ── Public API (mountActivity / refreshActivityData) ──────────────────
  // Fill the mount left by showWelcome(). Robust to evaluation order: showWelcome guards on
  // window.mountActivity, and ./activity-boot also self-calls mountActivity on load, so the card
  // mounts whichever runs first.
  async mount(): Promise<void> {
    const m = document.getElementById('home-activity-mount');

    if (!m) return;
    // Re-fetch on every mount: the feed must reflect edits made since the home was last shown
    // (e.g. a task toggle), no caching, or it stays stale until reload.
    this.expanded = false;
    // Don't leave the card slot blank while /api/activity fetches: cached card instantly on
    // re-visit, a skeleton on the very first load.
    if (this.items && this.items.length) { m.innerHTML = this.cardHtml(); this.wire(m.querySelector<HTMLElement>('#home-activity-card')!); }
    else if (this.items === null) m.innerHTML = this.skeletonHtml();

    const loaded = await this.load();

    this.items = loaded ? ActivityModel.aggregate(loaded) : loaded;
    this.digest = loaded ? ActivityModel.computeDigest(loaded) : null;
    if (!this.items || !this.items.length) { m.innerHTML = ''; return; } // offline / nothing → no card
    m.innerHTML = this.cardHtml();
    this.wire(m.querySelector<HTMLElement>('#home-activity-card')!);
    if (!IS_OFFLINE_BUILD && window.AtlasInbox) window.AtlasInbox.refreshBadge(); // light count without opening the tab
  }

  // Live-reload refresh that does NOT re-mount the card: softReload() calls this so only the active
  // tab updates in place. Dormant tabs and the self-managing Inbox are left untouched.
  async refreshData(): Promise<void> {
    const card = document.getElementById('home-activity-card');

    if (!card) return;

    const inbox = card.querySelector('#activity-inbox');

    if (inbox && !inbox.classList.contains('hidden')) return; // Inbox active: it manages itself
    if (!IS_OFFLINE_BUILD && window.AtlasInbox) window.AtlasInbox.refreshBadge(); // keep the home badge live

    const loaded = await this.load();

    if (!loaded) return;
    this.items = ActivityModel.aggregate(loaded);
    this.digest = ActivityModel.computeDigest(loaded);

    const journal = card.querySelector('#activity-journal');

    if (journal && !journal.classList.contains('hidden')) {
      journal.innerHTML = this.journalView.html();

      const dg = card.querySelector('#activity-digest');

      if (dg && !dg.classList.contains('hidden')) dg.innerHTML = this.digestHtml();

      return;
    }

    const orrery = card.querySelector<HTMLElement>('#activity-orrery');

    if (orrery && !orrery.classList.contains('hidden') && orrery.dataset.rendered) {
      orrery.innerHTML = this.orreryView.html(); this.orreryView.wireHover(orrery); this.orreryView.wireSun(orrery);
    }
  }
}
