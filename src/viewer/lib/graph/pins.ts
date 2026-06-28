// Pinned favorites: the sidebar's "Pinned" section, persisted to localStorage. Keeps its imperative
// DOM (innerHTML + rebind). 06-view-history calls the updatePinButton wrapper when a doc opens to
// refresh the header pin button.

class Pins {
  private section = document.getElementById('pinned-section')!;
  private list = document.getElementById('pinned-list')!;
  private btn = document.getElementById('btn-pin')!;
  private btnIcon = document.getElementById('btn-pin-icon')!;
  private pins: string[] = [];

  constructor() {
    try {
      this.pins = (JSON.parse(localStorage.getItem('kb-pins') || '[]') || []).filter((p: string) => fileMap[p]);
    } catch (e) {
      this.pins = [];
    }
    this.btn.addEventListener('click', () => {
      if (currentFile) this.toggle(currentFile.path);
    });
    this.render();
  }

  private save(): void {
    try {
      localStorage.setItem('kb-pins', JSON.stringify(this.pins));
    } catch (e) {}
  }

  private isPinned(path: string): boolean {
    return this.pins.includes(path);
  }

  private toggle(path: string): void {
    if (!path) return;
    const i = this.pins.indexOf(path);

    if (i >= 0) this.pins.splice(i, 1);
    else this.pins.unshift(path);
    this.save();
    this.render();

    if (currentFile) this.updateButton(currentFile);
  }

  updateButton(file: FileNode | null): void {
    if (!file || file.ext !== '.md') {
      this.btn.classList.add('hidden');

      return;
    }

    this.btn.classList.remove('hidden');
    const on = this.isPinned(file.path);

    this.btnIcon.setAttribute('fill', on ? 'currentColor' : 'none');
    this.btn.classList.toggle('text-amber-300', on);
    this.btn.title = on ? t('unpin') : t('pin');
  }

  private render(): void {
    const items = this.pins.map((p) => fileMap[p]).filter((f): f is FileNode => !!f);

    if (!items.length) {
      this.section.classList.add('hidden');
      this.list.innerHTML = '';

      return;
    }

    this.section.classList.remove('hidden');
    this.list.innerHTML = items
      .map(
        (f) => `
    <li class="overflow-hidden group flex items-center">
      <a class="tree-item flex-1 min-w-0 flex items-center px-2 py-1 rounded cursor-pointer" data-pinpath="${escapeHtml(f.path)}">
        <span class="block text-xs text-ink-200 truncate w-full">${escapeHtml(f.name)}</span>
      </a>
      <button class="px-1.5 text-ink-600 hover:text-rose-300 opacity-0 group-hover:opacity-100 transition-opacity" data-unpin="${escapeHtml(f.path)}" title="${escapeHtml(t('unpin'))}">&times;</button>
    </li>`,
      )
      .join('');
    this.list.querySelectorAll('[data-pinpath]').forEach((a) =>
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const f = fileMap[(a as HTMLElement).dataset.pinpath!];

        if (f) {
          showMarkdown(f);
          history.replaceState(null, '', '#' + encodeURIComponent(f.path));
        }
      }),
    );
    this.list.querySelectorAll('[data-unpin]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.toggle((b as HTMLElement).dataset.unpin!);
      }),
    );
  }
}

const pins = new Pins();

// 06-view-history calls updatePinButton(file) when a doc opens.
function updatePinButton(file: FileNode | null): void {
  pins.updateButton(file);
}

// Embed mode (#mind): the landing page iframes this viewer as a chrome-less Mind hero — build the base
// view here; the graph hero opens (controls hidden) in 12-tasks-graph.
if (EMBED_MIND) {
  showWelcome();
} else {
  routeFromHash();
}
