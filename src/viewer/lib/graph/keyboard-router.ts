// App-wide keyboard router: the global-shortcut dispatcher plus its document keydown listener. High
// prefix on purpose — it dispatches to the mindGraph / tasksOverlay instances owned by 12-tasks-graph
// and the historyOverlay owned by 06, and opens the commandPalette owned by 11, so it must load after
// all of them (the references resolve at keydown time, never at construction).

class KeyboardRouter {
  constructor() {
    document.addEventListener('keydown', (e) => this.onKey(e));
  }

  // App-wide keyboard router. Ctrl/Cmd+K opens the palette; Escape closes the topmost open overlay
  // (history → tasks → graph, the owners' priority); the rest are global shortcuts, suppressed while
  // an input/textarea is focused.
  private onKey(e: KeyboardEvent): void {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      commandPalette.open();

      return;
    }

    if (e.key === 'Escape' && !historyOverlay.classList.contains('hidden')) {
      closeHistory();

      return;
    }

    if (e.key === 'Escape' && tasksOverlay.isOpen()) {
      tasksOverlay.close();

      return;
    }

    if (e.key === 'Escape' && mindGraph.isOpen()) {
      mindGraph.close();

      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') {
      e.preventDefault();
      mindGraph.open();

      return;
    }

    const active = document.activeElement;

    if (active && ['INPUT', 'TEXTAREA'].includes(active.tagName)) {
      if (e.key === 'Escape' && active === searchEl) {
        (searchEl as HTMLInputElement).value = '';
        searchEl.dispatchEvent(new Event('input'));
        searchEl.blur();
      }

      return;
    }

    if (e.key === '/') {
      e.preventDefault();
      searchEl.focus();
    }

    if (e.key === 'e' && currentFile && !editMode && !window.__viewerMode) {
      e.preventDefault();
      enterEditMode();
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
      e.preventDefault();
      toggleSidebar();
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'j') {
      e.preventDefault();
      toggleToc();
    }
  }
}

const keyboardRouter = new KeyboardRouter();
