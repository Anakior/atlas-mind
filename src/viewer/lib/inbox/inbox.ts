// Inbox triage — the home Activity card's "Inbox" tab, on the Atlas DOM runtime.
//
// Agents pre-triage upstream and drop ready-to-file items into a per-person inbox lane via the MCP;
// you keep / trash / snooze them here. The Activity card (admin/activity/activity-card.ts) owns only the tab button,
// the #inbox-badge and the empty #activity-inbox slot, and calls AtlasInbox.{mount,show,hide}.
// CSS lives in styles/10-inbox.css.
//
// A single stateful component: state lives in the instance, and mutate-then-render(view) drives the
// keyed reconciler. It keeps the focus card and each queue row as stable DOM nodes (keyed by path),
// so an open destination editor, its caret and uncommitted value, and the scroll position all
// survive the 5s poll. The sub region (source + type filter chips) above the focus card is frozen while
// an inline editor is open, so the input never shifts and the body-level combobox popup stays anchored.

import { escapeHtml } from '../core/utils';
import { t } from '../core/i18n';
import { raw, h, createApp } from '../runtime/atlas-dom';
import { folderTagsOf } from '../content/tags';
import { AtlasCombobox } from '../ui/combobox';
import { getAllDirs } from '../modals/new-file-modal';

export const esc = escapeHtml;

export class Inbox {
  // ---- icons (Heroicons v2 outline, the viewer's set) ----
  private static readonly ISRC: Record<string, { tint: string; d: string }> = {
    gmail: { tint: '#5db5e8', d: 'M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75' },
    sentry: { tint: '#e8941c', d: 'M14.857 17.082a23.85 23.85 0 0 0 5.454-1.31A8.97 8.97 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.97 8.97 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.26 24.26 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0' },
    scraper: { tint: '#5fd0a6', d: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0 0a8.95 8.95 0 0 0 0-18m0 18a8.95 8.95 0 0 1 0-18M3 12h18' },
    webhook: { tint: '#b58be8', d: 'M3.75 13.5 14.25 2.25 12 10.5h8.25L9.75 21.75 12 13.5H3.75Z' },
    slack: { tint: '#e85b8b', d: 'M2.25 12.76c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.184-4.183a1.14 1.14 0 0 1 .778-.332 48.3 48.3 0 0 0 5.83-.498c1.585-.233 2.708-1.626 2.708-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.4 48.4 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z' },
    manual: { tint: '#b0b1b5', d: 'm16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.931-8.931Zm0 0L19.5 7.125' },
  };
  private static readonly IDOC = 'M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z';
  private static readonly ILINK = 'M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244';
  private static readonly ICHECK = 'M4.5 12.75l6 6 9-13.5';
  private static readonly ITRASH = 'M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.1 48.1 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.1 48.1 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.96 51.96 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.67 48.67 0 0 0-7.5 0';
  private static readonly ISNOOZE = 'M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5';
  private static readonly IPENCIL = 'm16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.931-8.931Zm0 0L19.5 7.125';
  private static readonly SKEY: Record<string, keyof SessionStats> = { keep: 'kept', trash: 'trashed', snooze: 'snoozed' };

  // ---- state ----
  private inbox: InboxItemEdited[] | null = null; // the queue | []
  private activePath: string | null = null; // the focused item's path; null falls back to the first in queue
  private filter: Set<string> | null = null; // enabled source keys (null = all on)
  private typeFilter: Set<string> | null = null; // enabled type keys (null = all on)
  private session: SessionStats = { kept: 0, trashed: 0, snoozed: 0 };
  private overrides: Record<string, Override> = {}; // path -> edits, re-applied across reloads
  private leaving = false; // an action is mid-flight (swipe-out guard)
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private box: Element | null = null; // the #activity-inbox container, owned after mount
  private app: { render(): void; unmount(): void } | null = null;
  private keyHandler: ((ev: KeyboardEvent) => void) | null = null;

  // inline-editor state — replaces the old DOM-sniffing editing() guard
  private editingDest = false;
  private editingTag = false;
  private cb: { destroy(): void } | null = null; // AtlasCombobox controller while the dest editor is open
  private destInput: HTMLInputElement | null = null;
  private tagInput: HTMLInputElement | null = null;

  // the sub region snapshot, refreshed only while NOT editing (the don't-move-the-input invariant)
  private subSources: string[] = [];
  private subTypes: string[] = [];

  // toast state (a keyed vnode, not an appended node)
  private toastN = 0;
  private toastShow = false;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  private editing(): boolean {
    return this.editingDest || this.editingTag;
  }

  private draw(): void {
    if (this.app) this.app.render();
  }

  // ---- small helpers ----
  private svg(d: string): VNode {
    return raw('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="' + d + '"/></svg>');
  }

  private rel(min: number): string {
    if (min < 1) return t('relJustNow');

    if (min < 60) return Math.round(min) + ' min';

    const h = Math.round(min / 60);

    if (h < 24) return h + ' h';

    const d = Math.round(min / 1440);

    if (d === 1) return t('relYesterday');

    return t('relDaysAgo', d);
  }

  private srcMeta(src: string): { tint: string; d: string } {
    const s = Inbox.ISRC[src];

    return s ? { tint: s.tint, d: s.d } : { tint: '#868a90', d: Inbox.IDOC };
  }

  private srcIc(src: string): VNode {
    const m = this.srcMeta(src);

    return h('span', { class: 'ibx-ic', style: 'background:' + m.tint + '22;color:' + m.tint }, this.svg(m.d));
  }

  private tier(c: number): string {
    return c >= 0.75 ? 'hi' : c >= 0.4 ? 'md' : 'lo';
  }

  private tierLabel(c: number): string {
    return c >= 0.75 ? t('inboxConfHigh') : c >= 0.4 ? t('inboxConfMed') : t('inboxConfLow');
  }

  private ago(it: InboxItem): string {
    return this.rel(it.captured_at ? Math.max(0, (Date.now() / 1000 - it.captured_at) / 60) : 0);
  }

  // Destination Keep promotes to: your edited override, else the agent's suggest_dest, else the FOLDER
  // of the top same-subject neighbour. Editable, and the promoted doc inherits the chosen folder's ACL.
  private suggestDest(it: InboxItemEdited): string {
    if (it._dest != null) return it._dest;

    if (it.suggest_dest) return it.suggest_dest;

    const nb = it.neighbors && it.neighbors[0];

    return nb && nb.indexOf('/') >= 0 ? nb.replace(/\/[^/]*$/, '') + '/' : '';
  }

  private tags(it: InboxItemEdited): string[] {
    return it._tags != null ? it._tags : it.suggest_tags || [];
  }

  private storeOverride(it: InboxItemEdited): void {
    this.overrides[it.path] = { dest: it._dest, tags: it._tags };
  }

  // Tags the destination folder auto-derives, so they aren't offered again (the folder IS a tag).
  private folderTags(it: InboxItemEdited): string[] {
    const d = this.suggestDest(it);

    return d && typeof folderTagsOf === 'function' ? folderTagsOf(d.replace(/\/+$/, '') + '/_.md') : [];
  }

  private queue(): InboxItemEdited[] {
    if (!this.inbox) return [];

    let q = this.inbox;

    if (this.filter) q = q.filter((i) => this.filter!.has(i.source));
    if (this.typeFilter) q = q.filter((i) => this.typeFilter!.has(this.itemType(i)));

    return q;
  }

  // Index of the focused item within the (filtered) queue. activePath pins it; when it's unset or the
  // pinned item is gone (acted on, or hidden by a filter), the focus falls back to the first visible row.
  private activeIdx(q: InboxItemEdited[]): number {
    if (this.activePath) {
      const i = q.findIndex((x) => x.path === this.activePath);

      if (i >= 0) return i;
    }

    return 0;
  }

  // The item's KIND, normalized for display + filtering. Defaults to "note" for legacy items the
  // build emitted before the type field existed.
  private itemType(it: InboxItem): string {
    return (it.type || 'note').trim() || 'note';
  }

  // A stable hue (0-359) derived from the type string, so each type keeps one consistent colour for
  // its badge + filter chip without hardcoding a palette (the vocabulary is open-ended).
  private typeHue(ty: string): number {
    let n = 0;

    for (let i = 0; i < ty.length; i++) n = (n * 31 + ty.charCodeAt(i)) & 0xffffff;

    return n % 360;
  }

  private typeBadge(it: InboxItem): VNode {
    const ty = this.itemType(it);

    return h('span', { class: 'ibx-type', style: '--th:' + this.typeHue(ty), title: t('inboxTypeTitle', ty) }, ty);
  }

  private snoozeDate(): string {
    const d = new Date();

    d.setDate(d.getDate() + 3);

    return d.toISOString().slice(0, 10);
  }

  private updateBadge(): void {
    const b = document.getElementById('inbox-badge');

    if (b) {
      const n = this.queue().length;

      b.textContent = String(n);
      b.classList.toggle('hidden', !n);
    }
  }

  // ---- views (vnode trees; the keyed reconciler reuses live nodes by key) ----
  private tagsView(it: InboxItemEdited): VNode[] {
    const fset = new Set(this.folderTags(it));
    const custom = this.tags(it).filter((tg) => !fset.has(tg));
    const out: VNode[] = [];

    for (const tg of fset) {
      out.push(h('span', { key: 'f:' + tg, class: 'doc-tag doc-tag-folder', title: esc(t('folderTagTitle')) }, '#' + tg));
    }
    for (const tg of custom) {
      out.push(
        h('span', { key: 'c:' + tg, class: 'doc-tag' }, '#' + tg,
          h('button', { class: 'doc-tag-x ibx-rmtag', title: esc(t('removeTag')), onClick: () => this.removeTag(it, tg) }, '×')),
      );
    }
    out.push(
      this.editingTag
        ? h('input', {
            key: 'tagedit',
            class: 'ibx-tagedit-input',
            autocomplete: 'off',
            placeholder: t('inboxNewTag'),
            ref: (el: HTMLInputElement | null) => {
              this.tagInput = el;
              if (el) el.focus();
            },
            onKeydown: (e: KeyboardEvent) => {
              if (e.key === 'Enter') { e.preventDefault(); this.commitTag(it); }
              else if (e.key === 'Escape') { e.preventDefault(); this.endEdit(); }
            },
            onBlur: () => setTimeout(() => { if (this.editingTag) this.commitTag(it); }, 150),
          })
        : h('button', { key: 'addtag', type: 'button', class: 'doc-tag-add ibx-addtag', title: esc(t('addTag')), onClick: () => { this.editingTag = true; this.draw(); } }, '+'),
    );

    return out;
  }

  private destView(it: InboxItemEdited): VNode[] {
    if (this.editingDest) {
      return [
        h('span', { class: 'ibx-lbl' }, t('inboxFileUnder')),
        h('input', {
          key: 'destedit',
          class: 'ibx-destedit',
          value: this.suggestDest(it),
          autocomplete: 'off',
          placeholder: t('inboxPickOrType'),
          ref: (el: HTMLInputElement | null) => this.destEditorRef(it, el),
          onKeydown: (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); this.endEdit(); } },
          onBlur: () => setTimeout(() => { if (this.editingDest) this.commitDest(it); }, 180),
        }),
      ];
    }

    const sd = this.suggestDest(it);
    const chip = sd
      ? h('span', { class: 'ibx-destchip editable', onClick: () => this.openDest() }, this.svg(Inbox.IDOC), sd, this.svg(Inbox.IPENCIL))
      : h('span', { class: 'ibx-destchip editable empty', onClick: () => this.openDest() }, t('inboxChooseFolder'), this.svg(Inbox.IPENCIL));

    return [h('span', { class: 'ibx-lbl' }, t('inboxFileUnder')), chip];
  }

  private focusView(it: InboxItemEdited): VNode {
    const tr = this.tier(it.confidence);
    const sd = this.suggestDest(it);
    const nb = it.neighbors && it.neighbors[0];

    return h(
      'div',
      { key: 'focus:' + it.path, class: 'ibx-focus' + (this.leaving ? ' ibx-leaving' : ' ibx-entering'), id: 'ibx-focus' },
      h('div', { class: 'ibx-frow' },
        this.typeBadge(it),
        h('span', { class: 'ibx-pill ' + tr, title: Math.round(it.confidence * 100) + '%' }, this.tierLabel(it.confidence)),
        h('span', { class: 'ibx-spacer' }),
        h('span', { class: 'ibx-ago' }, this.ago(it))),
      h('div', { class: 'ibx-title' }, it.title),
      it.preview ? h('p', { class: 'ibx-body' }, it.preview) : null,
      nb
        ? h('div', { class: 'ibx-signal' },
            h('span', { class: 'sic' }, this.svg(Inbox.ILINK)),
            h('div', null, h('b', null, t('inboxSameSubject')), ' ', h('span', { class: 'doc' }, nb)))
        : null,
      h('div', { class: 'ibx-dest' }, this.destView(it), h('span', { class: 'ibx-lbl' }, 'tags'), h('span', { class: 'ibx-tags' }, this.tagsView(it))),
      h('div', { class: 'ibx-actions' },
        h('button', { type: 'button', class: 'ibx-btn keep' + (sd ? '' : ' disabled'), disabled: !sd, title: sd ? null : t('inboxPickFolderFirst'), onClick: () => this.act('keep') },
          this.svg(Inbox.ICHECK), t('inboxKeep') + ' ', h('span', { class: 'k' }, 'K')),
        h('button', { type: 'button', class: 'ibx-btn trash', onClick: () => this.act('trash') },
          this.svg(Inbox.ITRASH), t('inboxTrash') + ' ', h('span', { class: 'k' }, 'X')),
        h('button', { type: 'button', class: 'ibx-btn snooze', onClick: () => this.act('snooze') },
          this.svg(Inbox.ISNOOZE), t('inboxSnooze') + ' ', h('span', { class: 'k' }, 'S')),
        h('span', { class: 'ibx-spacer' }),
        h('button', { type: 'button', class: 'ibx-btn ghost', onClick: () => this.act('next') }, t('inboxNext') + ' ', h('span', { class: 'k' }, 'J'))),
    );
  }

  private qRowView(it: InboxItemEdited, active: boolean): VNode {
    return h('div', { key: 'row:' + it.path, class: 'ibx-qrow' + (active ? ' active' : ''), 'data-ipath': it.path, 'aria-current': active ? 'true' : null, onClick: () => this.select(it.path) },
      this.srcIc(it.source),
      h('span', { class: 'ibx-qt' }, it.title),
      this.typeBadge(it),
      h('span', { class: 'ibx-mini ' + this.tier(it.confidence), title: this.tierLabel(it.confidence) }),
      h('span', { class: 'ibx-qa' }, this.ago(it)));
  }

  private chipsView(): VNode {
    return h('div', { class: 'ibx-chips' },
      this.subSources.map((s) => {
        const on = !this.filter || this.filter.has(s);
        const m = this.srcMeta(s);

        return h('button', { key: s, type: 'button', class: 'ibx-chip ' + (on ? 'on' : ''), onClick: () => this.toggleFilter(s) },
          h('span', { class: 'g', style: 'color:' + m.tint }, this.svg(m.d)), s);
      }));
  }

  // Type filter chips (mirror the source chips). Only meaningful once the inbox holds more than one
  // kind, so the caller renders this group only then — a lone "note" chip would be noise.
  private typeChipsView(): VNode {
    return h('div', { class: 'ibx-chips ibx-tchips' },
      this.subTypes.map((ty) => {
        const on = !this.typeFilter || this.typeFilter.has(ty);

        return h('button', { key: 't:' + ty, type: 'button', class: 'ibx-chip ' + (on ? 'on' : ''), style: '--th:' + this.typeHue(ty), onClick: () => this.toggleTypeFilter(ty) },
          h('span', { class: 'tdot' }), ty);
      }));
  }

  private subView(): VNode {
    return h('div', { key: 'sub', class: 'ibx-sub', id: 'ibx-sub' },
      h('div', { id: 'ibx-chips-wrap', class: 'ibx-chips-wrap' },
        // Source chips only matter once items come from more than one source — a lone source chip is
        // just the MCP's own name and filters nothing. Keep it while a source filter is active so it
        // can still be cleared. Same rule as the type chips below.
        this.subSources.length > 1 || this.filter ? this.chipsView() : null,
        // Show type chips once there is variety to sort — but ALSO whenever a type filter is active,
        // so the escape hatch survives the queue collapsing to a single still-excluded type (else the
        // filter would soft-lock with no in-UI way to clear it).
        this.subTypes.length > 1 || this.typeFilter ? this.typeChipsView() : null));
  }

  private zeroView(): VNode {
    const s = this.session;
    const total = s.kept + s.trashed + s.snoozed;
    const dp = (d: string, n: number, l: string, col: string) =>
      h('span', { class: 'ibx-dpill' }, h('span', { style: 'color:' + col }, this.svg(d)), h('b', null, String(n)), ' ' + l);

    return h('div', { key: 'zero', class: 'ibx-zero' },
      h('div', { class: 'ibx-mark' }, this.svg(Inbox.ICHECK)),
      h('h3', null, t('inboxZeroTitle')),
      h('p', null, t('inboxZeroSub')),
      total
        ? h('div', { class: 'ibx-digest' },
            dp(Inbox.ICHECK, s.kept, t('inboxKept'), '#5fd0a6'),
            dp(Inbox.ITRASH, s.trashed, t('inboxTrashed'), '#868a90'),
            dp(Inbox.ISNOOZE, s.snoozed, t('inboxSnoozed'), '#e8941c'))
        : null);
  }

  // Every item is filtered out (source and/or type chips) while the inbox still holds some. Distinct
  // from inbox-zero: the sub bar above stays mounted so the chips remain clickable to clear it.
  private emptyFilteredView(): VNode {
    return h('div', { key: 'zerofilt', class: 'ibx-zero ibx-zero-filtered' },
      h('div', { class: 'ibx-mark' }, this.svg(Inbox.IDOC)),
      h('h3', null, t('inboxZeroTitle')),
      h('p', null, t('inboxNoMatch')));
  }

  private skelView(): VNode {
    const row = (i: number) =>
      h('div', { key: 'sk:' + i, class: 'ibx-skelrow' },
        h('div', { class: 'ibx-skel', style: 'width:30px;height:30px;border-radius:8px' }),
        h('div', { style: 'flex:1' },
          h('div', { class: 'ibx-skel', style: 'width:42%;height:10px' }),
          h('div', { class: 'ibx-skel', style: 'width:26%;height:8px;margin-top:6px' })));

    return h('div', { key: 'skel' }, [0, 1, 2].map(row));
  }

  private toastView(): VNode | null {
    if (!this.toastN) return null;

    return h('div', { key: 'toast', id: 'ibx-toast', class: 'ibx-toast' + (this.toastShow ? ' show' : '') }, t('inboxNew', this.toastN));
  }

  private nextView(items: InboxItemEdited[], activePath: string): VNode {
    return h('div', { key: 'next', id: 'ibx-next' },
      h('div', { class: 'ibx-next-h', id: 'ibx-next-h', style: items.length ? null : 'display:none' }, items.length ? t('inboxQueue') + ' · ' + items.length : ''),
      h('div', { id: 'ibx-next-rows' }, items.map((it) => this.qRowView(it, it.path === activePath))));
  }

  // Refresh the sub snapshot (source + type chips). Skipped while editing so the input never shifts.
  private refreshSub(): void {
    const srcs: string[] = [];
    const types: string[] = [];

    (this.inbox || []).forEach((i) => {
      if (srcs.indexOf(i.source) < 0) srcs.push(i.source);
      const ty = this.itemType(i);

      if (types.indexOf(ty) < 0) types.push(ty);
    });
    this.subSources = srcs;
    this.subTypes = types;
  }

  private view(): Child {
    if (this.inbox === null) return this.skelView();
    if (!this.editing()) this.refreshSub();

    const q = this.queue();

    if (!q.length) {
      // A filter can hide every item while the inbox still holds some — keep the filter bar visible
      // so the user can clear it, instead of the misleading "inbox zero" screen.
      if ((this.filter || this.typeFilter) && this.inbox.length) return [this.subView(), this.emptyFilteredView()];

      return this.zeroView();
    }

    // The focused item is the active one (activePath, defaulting to the first); the list (nextView)
    // shows the WHOLE queue with that item marked active, IN PLACE — clicking a row just moves the
    // focus pin, it never reorders the list.
    const active = q[this.activeIdx(q)];

    return [this.subView(), this.focusView(active), this.nextView(q, active.path), this.toastView()];
  }

  // ---- data + live poll ----
  private applyOverride(it: InboxItemEdited): void {
    const o = this.overrides[it.path];

    if (o) {
      if (o.dest != null) it._dest = o.dest;
      if (o.tags != null) it._tags = o.tags;
    }
  }

  private async load(force: boolean): Promise<void> {
    // A re-mount (e.g. an SSE soft-reload after a Keep) must NOT re-fetch and re-sort: that would yank
    // the focus card to the highest-confidence item. Reuse the loaded state; the poll brings new items.
    if (this.inbox && !force) {
      this.draw();

      return;
    }

    let inbox: InboxItemEdited[] = [];

    try {
      const r = await fetch('/api/inbox?limit=200');

      if (r.ok) inbox = (await r.json()).inbox || [];
    } catch (_) {}
    inbox.forEach((it) => this.applyOverride(it));
    this.inbox = inbox;
    this.session = { kept: 0, trashed: 0, snoozed: 0 };
    this.activePath = null;
    this.filter = null;
    this.typeFilter = null;
    this.draw();
  }

  // Detect new items and grow ONLY the list; while an editor is open the sub region stays frozen, so
  // the input never shifts and the combobox popup stays anchored.
  private poll(): void {
    if (!this.box || this.box.classList.contains('hidden') || !this.inbox) return;
    fetch('/api/inbox?limit=200')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;

        const have = new Set(this.inbox!.map((i) => i.path));
        const fresh: InboxItemEdited[] = (d.inbox || []).filter((i: InboxItem) => !have.has(i.path));

        if (!fresh.length) return;
        fresh.forEach((it) => this.applyOverride(it));
        this.inbox = this.inbox!.concat(fresh); // to the BACK: the focus item never moves
        this.updateBadge();
        if (!this.editing()) this.showToast(fresh.length); // sub refresh happens via view() when not editing
        this.draw();
      })
      .catch(() => {});
  }

  private startPoll(): void {
    this.stopPoll();
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), 5000);
  }

  private stopPoll(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private showToast(n: number): void {
    this.toastN = n;
    this.toastShow = true;
    this.draw();
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toastShow = false;
      this.draw();
    }, 3200);
  }

  // ---- actions ----
  private act(kind: 'keep' | 'trash' | 'snooze' | 'next'): void {
    const q = this.queue();

    if (!q.length || this.leaving) return;

    const idx = this.activeIdx(q);
    const it = q[idx];

    if (kind === 'next') {
      this.activePath = q[(idx + 1) % q.length].path; // advance the focus pin, cycling — no reorder
      this.draw();

      return;
    }
    if (kind === 'keep' && !this.suggestDest(it)) return; // no destination -> Keep is inert

    // Once `it` leaves, the focus moves to the row that followed it (or the previous one if it was
    // last). Captured now, from the visible queue, so it's whatever the user sees come next.
    const next = q[idx + 1] || q[idx - 1] || null;
    const nextPath = next ? next.path : null;

    const body: ActionBody = { action: kind, path: it.path };

    if (kind === 'keep') {
      body.dest = this.suggestDest(it);

      const fset = new Set(this.folderTags(it)); // folder auto-tags at build; don't write them twice

      body.tags = this.tags(it).filter((tg) => !fset.has(tg));
    }
    if (kind === 'snooze') body.until = this.snoozeDate();
    this.leaving = true;
    this.draw(); // the focus card (same key) gains .ibx-leaving and the swipe-out plays
    fetch('/api/inbox/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then((r) => {
        if (r.ok) {
          // Hold leaving for the WHOLE swipe-out: the next item isn't shown yet, so releasing now
          // would let a second K/X/S act on it blind. Drop + repin + render after the animation.
          if (Inbox.SKEY[kind]) this.session[Inbox.SKEY[kind]]++;
          setTimeout(() => {
            this.inbox = this.inbox!.filter((x) => x.path !== it.path);
            delete this.overrides[it.path];
            this.activePath = nextPath;
            this.leaving = false;
            this.draw();
          }, 180);
        } else {
          this.leaving = false;
          this.draw();
        }
      })
      .catch(() => {
        this.leaving = false;
        this.draw();
      });
  }

  private select(path: string): void {
    if (!this.inbox || !this.inbox.some((x) => x.path === path)) return;
    this.activePath = path; // pin the focus on the clicked row, leaving the list order untouched
    this.draw();
  }

  private toggleFilter(src: string): void {
    if (!this.filter) this.filter = new Set(this.inbox!.map((i) => i.source));
    if (this.filter.has(src) && this.filter.size > 1) this.filter.delete(src);
    else this.filter.add(src);
    this.draw();
  }

  private toggleTypeFilter(ty: string): void {
    if (!this.typeFilter) this.typeFilter = new Set(this.inbox!.map((i) => this.itemType(i)));
    if (this.typeFilter.has(ty) && this.typeFilter.size > 1) this.typeFilter.delete(ty);
    else this.typeFilter.add(ty);
    this.draw();
  }

  // ---- inline editors ----
  private openDest(): void {
    this.editingDest = true;
    this.draw();
  }

  // Mount/tear the folder combobox on the dest input as it enters/leaves the DOM. ref fires after the
  // node is attached, so getBoundingClientRect (the popup anchor) is valid.
  private destEditorRef(it: InboxItemEdited, el: HTMLInputElement | null): void {
    if (el) {
      this.destInput = el;
      // Create the combobox BEFORE focusing, so its focus listener is attached and the popup opens.
      if (typeof AtlasCombobox === 'function' && typeof getAllDirs === 'function') {
        this.cb = AtlasCombobox(el, { source: getAllDirs, creatable: true, onSelect: (v: string) => this.commitDest(it, v) });
      }
      el.focus();
      el.select();
    } else {
      this.destInput = null;
      if (this.cb) {
        this.cb.destroy();
        this.cb = null;
      }
    }
  }

  private commitDest(it: InboxItemEdited, v?: string): void {
    it._dest = (v != null ? v : this.destInput ? this.destInput.value : '').trim();
    this.storeOverride(it);
    this.endEdit();
  }

  private removeTag(it: InboxItemEdited, tg: string): void {
    it._tags = this.tags(it).filter((x) => x !== tg);
    this.storeOverride(it);
    this.draw();
  }

  private commitTag(it: InboxItemEdited): void {
    const tg = (this.tagInput ? this.tagInput.value : '').trim().replace(/^#/, '');
    const cur = this.tags(it);

    it._tags = tg && cur.indexOf(tg) < 0 ? cur.concat([tg]) : cur.slice();
    this.storeOverride(it);
    this.endEdit();
  }

  // Close any open inline editor and re-render (the sub region catches up to the live state).
  private endEdit(): void {
    this.editingDest = false;
    this.editingTag = false;
    this.draw();
  }

  // ---- document keyboard shortcuts (K/X/S/J) ----
  private onKey(ev: KeyboardEvent): void {
    const ae = document.activeElement as HTMLElement | null;

    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
    if (!this.box || this.box.classList.contains('hidden') || !this.queue().length) return;

    const k = ev.key.toLowerCase();
    const a = k === 'k' ? 'keep' : k === 'x' ? 'trash' : k === 's' ? 'snooze' : k === 'j' || ev.key === 'ArrowDown' ? 'next' : null;

    if (!a) return;
    ev.preventDefault();
    this.act(a as 'keep' | 'trash' | 'snooze' | 'next');
  }

  // ---- public API (called by the Activity card's setView) ----
  mount(container: Element): void {
    this.box = container;
    this.app = createApp(container, () => this.view());
    if (this.keyHandler) document.removeEventListener('keydown', this.keyHandler);
    this.keyHandler = (ev) => this.onKey(ev);
    document.addEventListener('keydown', this.keyHandler);
    this.load(false);
  }

  show(): void {
    this.startPoll();
  }

  hide(): void {
    this.stopPoll();
  }

  // Keep the header count live without opening the tab. If the tab is on screen the poll owns the
  // badge, so skip. Seeds inbox so a later open is instant. No-op offline (the fetch just fails).
  async refreshBadge(): Promise<void> {
    const live = document.querySelector('#activity-inbox');

    if (live && !live.classList.contains('hidden')) return;
    try {
      const r = await fetch('/api/inbox?limit=200');

      if (!r.ok) return;

      const fresh: InboxItemEdited[] = (await r.json()).inbox || [];

      fresh.forEach((it) => this.applyOverride(it));
      this.inbox = fresh;
      this.updateBadge();
    } catch (_) {}
  }
}

// viewer core absent (some headless shells)
if (typeof escapeHtml === 'function') {
  window.AtlasInbox = new Inbox();
}
