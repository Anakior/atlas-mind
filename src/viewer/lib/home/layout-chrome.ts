// The viewer's layout chrome: sidebar collapse + per-doc TOC panel visibility. State (the collapsed
// flag, the per-doc toc-hidden map) lives in LayoutChrome; the bare-name entry points (toggleSidebar /
// toggleToc / applyToc / isMobile) stay top-level globals because sibling modules (11-palette,
// 12b-shortcuts, the 04/05 TOC rebuilders, 12-todo-surface) call them by name.
class LayoutChrome {
  private sidebarCollapsed = localStorage.getItem('sidebar-collapsed') === '1';
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

  applySidebar(): void {
    if (this.isMobile()) {
      sidebarEl.style.marginLeft = '';
      sidebarShowInline.classList.remove('hidden');

      return;
    }

    if (this.sidebarCollapsed) {
      sidebarEl.style.marginLeft = '-20rem';
      sidebarShowInline.classList.remove('hidden');
    } else {
      sidebarEl.style.marginLeft = '';
      sidebarShowInline.classList.add('hidden');
    }
  }

  toggleSidebar(): void {
    if (this.isMobile()) {
      document.body.classList.toggle('sidebar-open');

      return;
    }

    this.sidebarCollapsed = !this.sidebarCollapsed;
    localStorage.setItem('sidebar-collapsed', this.sidebarCollapsed ? '1' : '0');
    this.applySidebar();
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

// Sidebar + TOC chrome refs (markup-guaranteed). tocShow is also read by sibling modules
// (07-frames, 09-editor) via `typeof tocShow`, so it must stay a top-level global.
const sidebarEl = document.getElementById('sidebar')!;
const sidebarToggle = document.getElementById('sidebar-toggle')!;
const sidebarShowInline = document.getElementById('sidebar-show-inline')!;
const tocClose = document.getElementById('toc-close')!;
const tocShow = document.getElementById('toc-show')!;
const sidebarBackdrop = document.getElementById('sidebar-backdrop')!;

const layoutChrome = new LayoutChrome();

// Thin top-level wrappers: sibling modules call these by bare name.
function toggleSidebar(): void {
  layoutChrome.toggleSidebar();
}

function toggleToc(): void {
  layoutChrome.toggleToc();
}

function applyToc(): void {
  layoutChrome.applyToc();
}

function isMobile(): boolean {
  return layoutChrome.isMobile();
}

sidebarBackdrop.addEventListener('click', () => document.body.classList.remove('sidebar-open'));
treeEl.addEventListener('click', (e) => {
  if (layoutChrome.isMobile() && (e.target as Element).closest('a[data-path]')) document.body.classList.remove('sidebar-open');
});
window.addEventListener('resize', () => {
  if (!layoutChrome.isMobile()) document.body.classList.remove('sidebar-open');
  layoutChrome.applySidebar();
  layoutChrome.applyToc();
});

sidebarToggle.addEventListener('click', toggleSidebar);
sidebarShowInline.addEventListener('click', toggleSidebar);
tocClose.addEventListener('click', toggleToc);
tocShow.addEventListener('click', toggleToc);
layoutChrome.applySidebar();
