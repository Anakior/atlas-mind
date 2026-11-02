// The menu's panels: Inbox, Journal and Récents open over whatever is on screen, the way Tâches does,
// so each is a click away from any doc; Dossiers too, when the menu is folded to its column. One
// overlay; the panel asked for fills its body. The Inbox has a single live box, so it moves into the
// panel and back to the home's card on close; Dossiers borrows the menu's own tree (its open folders
// with it) and gives it back.

import { t, LANG } from '../core/i18n';
import { fileMap } from '../core/tree';
import { escapeHtml, relativeDate } from '../core/utils';
import { docRenderer } from '../content/doc-renderer';
import { activityCard } from '../admin/activity/activity-boot';

export type SidePanel = 'inbox' | 'journal' | 'recent' | 'folders';

const TITLES: Record<SidePanel, string> = { inbox: 'actInbox', journal: 'actJournal', recent: 'recentHeader', folders: 'treeContentHeader' };
const BORROWED = ['pinned-section', 'shared-section', 'tree-header', 'tree']; // the menu's folder parts
const RECENT_SHOWN = 40;
const OPENED_WITHIN_MS = 5000; // a doc rendered this soon after a click in the panel was opened from it

class SidePanels {
  private readonly overlay = document.getElementById('side-panel')!;
  private readonly title = document.getElementById('side-panel-title')!;
  private readonly sub = document.getElementById('side-panel-sub')!;
  private readonly body = document.getElementById('side-panel-body')!;
  private current: SidePanel | null = null;
  private clickedAt = 0;
  private borrowed: { el: HTMLElement; parent: Node; next: Node | null }[] = [];

  constructor() {
    document.getElementById('side-panel-close')!.addEventListener('click', () => this.close());
    this.body.addEventListener('click', (e) => {
      this.clickedAt = Date.now();
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-recent-doc]');
      const f = row ? fileMap[row.dataset.recentDoc!] : undefined;

      if (!f) return;
      e.preventDefault();
      docRenderer.show(f);
      history.replaceState(null, '', '#' + encodeURIComponent(f.path));
    });
    // A doc opened from the panel (a Journal title, a recent doc) takes its place.
    document.addEventListener('atlas:doc-rendered', () => {
      if (this.current && Date.now() - this.clickedAt < OPENED_WITHIN_MS) this.close();
    });
  }

  isOpen(): boolean {
    return this.current !== null;
  }

  open(panel: SidePanel): void {
    this.leave();
    this.current = panel;
    this.title.textContent = t(TITLES[panel]);
    this.sub.textContent = '';
    this.body.replaceChildren();
    this.overlay.classList.remove('hidden');
    if (panel === 'inbox' && window.AtlasInbox) {
      window.AtlasInbox.mount(this.body);
      window.AtlasInbox.show();
    } else if (panel === 'journal') {
      activityCard.openJournal(this.body);
    } else if (panel === 'folders') {
      this.borrowTree();
    } else {
      this.renderRecent();
    }
  }

  close(): void {
    if (!this.current) return;
    this.leave();
    this.current = null;
    this.overlay.classList.add('hidden');
  }

  // What the panel on screen took, given back.
  private leave(): void {
    if (this.current === 'inbox') this.returnInbox();
    for (const b of this.borrowed.reverse()) b.parent.insertBefore(b.el, b.next);
    this.borrowed = [];
  }

  private borrowTree(): void {
    for (const id of BORROWED) {
      const el = document.getElementById(id)!;

      this.borrowed.push({ el, parent: el.parentNode!, next: el.nextSibling });
      this.body.append(el);
    }
  }

  // Back to the home's card when the home is behind the panel, asleep otherwise.
  private returnInbox(): void {
    const home = document.getElementById('activity-inbox');

    if (!window.AtlasInbox) return;
    if (home) {
      window.AtlasInbox.mount(home);
      window.AtlasInbox.show();
    } else {
      window.AtlasInbox.hide();
    }
  }

  // The docs changed last, by day, like the Journal.
  private renderRecent(): void {
    const docs = Object.values(fileMap)
      .filter((f) => (f.ext === '.md' || f.ext === '.html') && f.mtime)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, RECENT_SHOWN);
    const dayOf = (mtime: number): string => {
      const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(mtime * 1000).setHours(0, 0, 0, 0)) / 86400000);

      if (days <= 0) return t('dayToday');
      if (days === 1) return t('dayYesterday');

      return new Date(mtime * 1000).toLocaleDateString(LANG, { weekday: 'long', day: 'numeric', month: 'long' });
    };
    let day = '';

    this.sub.textContent = t('recentPanelSub', docs.length);
    this.body.innerHTML = docs
      .map((f) => {
        const k = dayOf(f.mtime);
        const head = k === day ? '' : `<div class="panel-day">${escapeHtml((day = k))}</div>`;
        const dir = f.path.split('/').slice(0, -1).join('/') || t('rootLabel');

        return head + `<a href="#" class="home-row" data-recent-doc="${escapeHtml(f.path)}"><span class="home-row-t"><b>${escapeHtml(f.name)}</b><em>${escapeHtml(dir)}</em></span><span class="home-row-w">${relativeDate(f.mtime)}</span></a>`;
      })
      .join('') || `<p class="home-empty">${t('noRecentDocs')}</p>`;
  }
}

export const sidePanels = new SidePanels();
