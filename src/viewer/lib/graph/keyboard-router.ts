// App-wide keyboard router: the global-shortcut dispatcher plus its document keydown listener. It
// imports and dispatches to the mindGraph (graph-boot.ts) / tasksOverlay (tasks-overlay.ts) instances,
// the historyOverlay (content/history-panel.ts) and the commandPalette (command-palette.ts); the
// handlers reach those instances at keydown time, never at construction.

import { currentFile, editMode } from '../core/state';
import { searchEl } from '../core/dom-refs';
import { editor } from '../editor/editor';
import { layoutChrome } from '../home/layout-chrome';
import { historyOverlay, historyPanel } from '../content/history-panel';
import { commandPalette } from './command-palette';
import { tasksOverlay } from './tasks-overlay';
import { mindGraph } from './graph-boot';

export class KeyboardRouter {
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
      historyPanel.close();

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
      editor.enterEditMode();
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
      e.preventDefault();
      layoutChrome.toggleSidebar();
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'j') {
      e.preventDefault();
      layoutChrome.toggleToc();
    }
  }
}

export const keyboardRouter = new KeyboardRouter();
