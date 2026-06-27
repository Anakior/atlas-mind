// The tasks rollup overlay: a modal listing every checkbox across the mind (GET /_tasks-index.json); a
// row click opens its doc and scrolls to the task. Imperative DOM (innerHTML + createElement), byte-for-
// behaviour with the pre-migration view — the Atlas DOM runtime port is a later pass. Self-contained
// (no graph state), so the singleton is constructed right here; 11-palette-pins reads it by name.
class TasksOverlay {
  private overlay = document.getElementById('tasks-overlay')!;
  private list = document.getElementById('tasks-list')!;
  private stats = document.getElementById('tasks-stats')!;
  private showDoneBox = document.getElementById('tasks-show-done') as HTMLInputElement;
  private index: Task[] = []; // kept for the "show done" toggle re-render

  constructor() {
    document.getElementById('tasks-btn')!.addEventListener('click', () => this.open());
    document.getElementById('tasks-close')!.addEventListener('click', () => this.close());
    this.showDoneBox.addEventListener('change', () => this.render(this.index));
  }

  isOpen(): boolean {
    return !this.overlay.classList.contains('hidden');
  }

  async open(): Promise<void> {
    this.overlay.classList.remove('hidden');
    this.showLoading(); // skeleton first → never flash the stale previous list
    this.index = await this.loadIndex();
    this.render(this.index);
  }

  close(): void {
    this.overlay.classList.add('hidden');
  }

  private async loadIndex(): Promise<Task[]> {
    if (IS_OFFLINE_BUILD) return EMBED_TASKS || [];

    // Let in-flight checkbox PUTs land first, then fetch fresh: the rollup is read live from disk,
    // so fetching mid-write would return the pre-toggle state.
    await sse.drainTaskWrites();

    try {
      const res = await fetch('/_tasks-index.json', { cache: 'no-cache' });

      return res.ok ? await res.json() : [];
    } catch (e) {
      return [];
    }
  }

  // Skeleton mirrors render() layout (no jump on swap). Seeded LCG → same skeleton each open.
  private renderSkeleton(): string {
    let state = 0x9e3779b9 >>> 0;
    const next = () => (state = (state * 1664525 + 1013904223) >>> 0);
    const range = (min: number, max: number) => min + (next() % (max - min + 1));
    const sections: string[] = [];

    for (let s = 0; s < 3; s++) {
      const rows: string[] = [];

      for (let r = 0, n = range(2, 4); r < n; r++) {
        rows.push(
          '<div style="display:flex;align-items:flex-start;gap:0.75rem;padding:0.5rem 0.75rem;">' +
            '<span class="skeleton" style="flex-shrink:0;width:19px;height:19px;border-radius:5px;margin-top:3px;"></span>' +
            '<span class="skeleton" style="height:0.95rem;width:' +
            range(45, 90) +
            '%;margin-top:5px;"></span>' +
            '</div>',
        );
      }

      sections.push(
        '<div style="margin-bottom:1.75rem;">' +
          '<div class="skeleton" style="height:0.7rem;width:' +
          range(22, 42) +
          '%;border-radius:4px;margin-bottom:0.6rem;"></div>' +
          rows.join('') +
          '</div>',
      );
    }

    return sections.join('');
  }

  private showLoading(): void {
    this.stats.innerHTML =
      '<span class="skeleton" style="display:inline-block;height:0.7rem;width:9rem;border-radius:4px;vertical-align:middle;"></span>';
    this.list.innerHTML =
      '<div aria-busy="true" aria-label="' + t('tasksLoading') + '">' + this.renderSkeleton() + '</div>';
  }

  // Normalize a task line for matching against rendered text: the index stores raw markdown, the
  // rendered doc shows plain text. Drop wikilink/link syntax + inline marks, lowercase, collapse spaces.
  private normTask(s: string): string {
    return (s || '')
      .toLowerCase()
      .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[*_`~]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Scroll the open doc to the checkbox of `task` and flash it. Primary = the Nth rendered checkbox
  // (task._docIndex); on rare index/render drift, fall back to matching by text, then a loose highlight.
  private scrollToCheckbox(task: Task): void {
    const want = this.normTask(task.text);
    const boxes = [...contentEl.querySelectorAll('input[type=checkbox]')];
    const liOf = (b: Element | undefined): Element | null => (b ? b.closest('li') || b.parentElement : null);
    let li = liOf(boxes[task._docIndex ?? -1]);

    if (!(li && want && this.normTask(li.textContent || '').includes(want))) {
      li = null;

      if (want) {
        for (const b of boxes) {
          const candidate = liOf(b);

          if (candidate && this.normTask(candidate.textContent || '').includes(want)) {
            li = candidate;
            break;
          }
        }
      }
    }

    if (!li) {
      highlightFirstMatch(contentEl, task.text);

      return;
    }

    const el = li as HTMLElement;

    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.style.transition = 'background-color 0.4s';
    el.style.backgroundColor = 'rgba(89,208,207,0.18)';
    el.style.borderRadius = '4px';
    setTimeout(() => {
      el.style.backgroundColor = '';
    }, 1600);
  }

  // Render a task's inline markdown like the rest of the app. Links/images stripped to text (the row
  // is itself a button — no nested navigation). Any error falls back to ESCAPED text, never raw HTML.
  private renderTaskText(s: string): string {
    try {
      return DOMPurify.sanitize(marked.parseInline(s), { FORBID_TAGS: ['a', 'img'] });
    } catch (e) {
      return escapeHtml(s);
    }
  }

  private render(tasks: Task[]): void {
    // _docIndex = position among its OWN doc's tasks → matches the Nth rendered checkbox, so a click
    // scrolls straight to it regardless of the "show done" filter.
    const perDoc: Record<string, number> = {};

    for (const tk of tasks) tk._docIndex = perDoc[tk.path] = (perDoc[tk.path] ?? -1) + 1;
    const open = tasks.filter((x) => !x.done).length;

    this.stats.textContent = t('tasksStats', open, tasks.length);
    const visible = this.showDoneBox.checked ? tasks : tasks.filter((x) => !x.done);

    this.list.innerHTML = '';

    if (!visible.length) {
      const empty = document.createElement('div');

      empty.className = 'text-ink-500 text-sm font-sans';
      empty.textContent = t('tasksEmpty');
      this.list.appendChild(empty);

      return;
    }

    const byDoc: Record<string, Task[]> = {};

    for (const task of visible) (byDoc[task.path] = byDoc[task.path] || []).push(task);

    for (const p of Object.keys(byDoc).sort()) {
      const file = fileMap[p];
      const section = document.createElement('div');

      section.style.marginBottom = '1.75rem';
      const head = document.createElement('div');

      head.className = 'text-[11px] uppercase tracking-[0.12em] text-ink-500 font-bold font-mono';
      head.style.marginBottom = '0.6rem';
      head.textContent = p;
      section.appendChild(head);

      for (const task of byDoc[p]) {
        const row = document.createElement('button');

        row.type = 'button';
        row.className =
          'flex items-start gap-3 w-full text-left px-3 py-2 rounded-lg hover:bg-white/5 text-base font-sans';
        const box = document.createElement('span');

        box.className = 'flex-shrink-0';
        box.style.marginTop = '3px';
        box.innerHTML = task.done
          ? '<svg viewBox="0 0 24 24" fill="none" class="text-accent" style="width:19px;height:19px"><rect x="3" y="3" width="18" height="18" rx="5" fill="currentColor"/><path d="M7.4 12.4l3 3 6.2-6.7" fill="none" stroke="#0e0d12" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
          : '<svg viewBox="0 0 24 24" fill="none" class="text-ink-500" style="width:19px;height:19px"><rect x="3" y="3" width="18" height="18" rx="5" stroke="currentColor" stroke-width="2"/></svg>';
        const txt = document.createElement('span');

        txt.className = task.done ? 'text-ink-500' : 'text-ink-100';

        if (task.done) txt.style.textDecoration = 'line-through';
        txt.innerHTML = this.renderTaskText(task.text);
        row.appendChild(box);
        row.appendChild(txt);
        row.addEventListener('click', async () => {
          this.close();

          if (!file) return;
          await showMarkdown(file);
          history.replaceState(null, '', '#' + encodeURIComponent(file.path));
          this.scrollToCheckbox(task);
        });
        section.appendChild(row);
      }

      this.list.appendChild(section);
    }
  }
}

const tasksOverlay = new TasksOverlay();
