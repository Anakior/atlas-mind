import { currentFile, tocHasLinks, tocHasNotes } from '../core/state';
import { tocPanel, tocList, treeEl } from '../core/dom-refs';
import { t } from '../core/i18n';

// The viewer's layout chrome: the menu folded to a column of icons (Ctrl+B) + per-doc TOC panel
// visibility. State (the folded flag, the per-doc toc-hidden map) lives in LayoutChrome; its entry points (toggleSidebar / toggleToc
// / applyToc / isMobile) are public methods on the exported layoutChrome singleton, imported by the
// modules that drive the chrome (graph/command-palette.ts, graph/keyboard-router.ts, content/toc.ts,
// graph/todo-surface.ts).
const MORPH_MS = 190; // the menu's width transition (12-shell.css), plus a frame

export class LayoutChrome {
  private sidebarCollapsed = localStorage.getItem('sidebar-collapsed') === '1';
  private morphTimer = 0;
  private tocHiddenMap: Record<string, boolean> = {};

  constructor() {
    try {
      this.tocHiddenMap = JSON.parse(localStorage.getItem('toc-hidden-per-doc') || '{}');
    } catch {
      // corrupt JSON -> start from an empty per-doc map
    }
  }

  isMobile(): boolean {
    return window.matchMedia('(max-width: 767px)').matches;
  }

  // Folded, the menu stays as a column of icons (a drawer on a phone, never folded there). Its
  // entries lose their labels, so the labels become their tooltips.
  applySidebar(): void {
    const rail = this.sidebarCollapsed && !this.isMobile();

    sidebarEl.classList.toggle('is-rail', rail);
    sidebarShowInline.classList.toggle('hidden', !this.isMobile());
    sidebarToggle.dataset.tip = t(rail ? 'expandSidebar' : 'collapseSidebar');
    sidebarEl.querySelectorAll<HTMLElement>('.side-link:not([data-i18n-tip])').forEach((a) => {
      if (rail) a.dataset.tip = a.querySelector('span:not(.side-badge)')?.textContent?.trim() || '';
      else delete a.dataset.tip;
    });
  }

  toggleSidebar(): void {
    if (this.isMobile()) {
      document.body.classList.toggle('sidebar-open');

      return;
    }

    this.sidebarCollapsed = !this.sidebarCollapsed;
    localStorage.setItem('sidebar-collapsed', this.sidebarCollapsed ? '1' : '0');
    // Only the width moves: the content is hidden while it does (it would reflow on the way), then
    // fades back in at its new layout.
    sidebarEl.classList.add('is-morphing');
    this.applySidebar();
    clearTimeout(this.morphTimer);
    this.morphTimer = window.setTimeout(() => sidebarEl.classList.remove('is-morphing'), MORPH_MS);
  }

  private isTocHiddenForCurrent(): boolean {
    if (!currentFile) return false;

    return this.tocHiddenMap[currentFile.path] === true;
  }

  applyToc(): void {
    if (!currentFile) {
      tocPanel.classList.add('hidden');
      tocPanel.classList.remove('flex');
      tocShow.classList.add('hidden');

      return;
    }

    const hasContent = tocList.children.length >= 2 || tocHasLinks || tocHasNotes;

    if (this.isMobile()) {
      tocPanel.classList.add('hidden');
      tocPanel.classList.remove('flex');
      tocShow.classList.toggle('hidden', !hasContent);

      return;
    }

    const hidden = this.isTocHiddenForCurrent();

    if (hidden || !hasContent) {
      tocPanel.classList.add('hidden');
      tocPanel.classList.remove('flex');
      tocShow.classList.toggle('hidden', !hasContent || !hidden);
    } else {
      tocPanel.classList.remove('hidden');
      tocPanel.classList.add('flex');
      tocShow.classList.add('hidden');
    }
  }

  toggleToc(): void {
    if (!currentFile) return;

    if (this.isMobile()) {
      const wasHidden = tocPanel.classList.contains('hidden');

      tocPanel.classList.toggle('hidden', !wasHidden);
      tocPanel.classList.toggle('flex', wasHidden);
      tocShow.classList.toggle('hidden', wasHidden);

      return;
    }

    const path = currentFile.path;

    this.tocHiddenMap[path] = !this.isTocHiddenForCurrent();
    if (!this.tocHiddenMap[path]) delete this.tocHiddenMap[path];
    localStorage.setItem('toc-hidden-per-doc', JSON.stringify(this.tocHiddenMap));
    this.applyToc();
  }
}

// Sidebar + TOC chrome refs (markup-guaranteed). tocShow is exported because content/frames.ts and
// editor/editor.ts also import it to hide the TOC handle.
export const sidebarEl = document.getElementById('sidebar')!;
export const sidebarToggle = document.getElementById('sidebar-toggle')!;
export const sidebarShowInline = document.getElementById('sidebar-show-inline')!;
export const tocClose = document.getElementById('toc-close')!;
export const tocShow = document.getElementById('toc-show')!;
export const sidebarBackdrop = document.getElementById('sidebar-backdrop')!;

export const layoutChrome = new LayoutChrome();

sidebarBackdrop.addEventListener('click', () => document.body.classList.remove('sidebar-open'));
treeEl.addEventListener('click', (e) => {
  if (layoutChrome.isMobile() && (e.target as Element).closest('a[data-path]')) document.body.classList.remove('sidebar-open');
});
window.addEventListener('resize', () => {
  if (!layoutChrome.isMobile()) document.body.classList.remove('sidebar-open');
  layoutChrome.applySidebar();
  layoutChrome.applyToc();
});

sidebarToggle.addEventListener('click', () => layoutChrome.toggleSidebar());
sidebarShowInline.addEventListener('click', () => layoutChrome.toggleSidebar());
tocClose.addEventListener('click', () => layoutChrome.toggleToc());
tocShow.addEventListener('click', () => layoutChrome.toggleToc());
layoutChrome.applySidebar();
