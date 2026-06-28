// To-do widget shared surface (cross-cutting top-level glue, kept in the 12-* family for now). The DOM
// refs, the collapse state, todoFilter/showDoneTodos, the favicon/tab badge and the
// tcat/TODO_FILTER_LABELS/renderTodoFilterTabs/updateHomeTodoStat/updateTabBadge helpers are read AND
// reassigned by 13-todos.ts, so they are shared globals (loaded before 13), not class state. The
// read-only demo-banner IIFE rides along at the tail (it was the original file's last block). A later
// pass relocates this surface to 13-todos / 01-state (plan items B1/B12).
import { layoutChrome } from '../home/layout-chrome';
import { todos } from '../content/content-tree';
import { escapeHtml } from '../core/utils';
import { SITE_NAME, IS_OFFLINE_BUILD } from '../core/data-csrf';

declare const __TODO_CATEGORIES_JSON__: Array<{ cat: string; label: string }>;

export const todoWidget = document.getElementById('todo-widget')!;
export const todoHeader = document.getElementById('todo-header')!;
export const todoBody = document.getElementById('todo-body')!;
export const todoChevron = document.getElementById('todo-chevron')!;
export const todoList = document.getElementById('todo-list')!;
export const todoForm = document.getElementById('todo-form')!;
export const todoInput = document.getElementById('todo-input')!;
export const todoCount = document.getElementById('todo-count')!;
export const todoBubbleCount = document.getElementById('todo-bubble-count')!;
export const todoStatus = document.getElementById('todo-status')!;

export let collapsed: boolean;

{
  const stored = localStorage.getItem('todo-collapsed');

  collapsed = stored === null ? layoutChrome.isMobile() : stored === '1';
}

export function applyCollapsed(): void {
  if (collapsed) {
    todoBody.classList.add('hidden');
    todoChevron.style.transform = 'rotate(-90deg)';
    todoWidget.classList.add('is-collapsed');
  } else {
    todoBody.classList.remove('hidden');
    todoChevron.style.transform = '';
    todoWidget.classList.remove('is-collapsed');
  }
}

applyCollapsed();

todoHeader.addEventListener('click', () => {
  collapsed = !collapsed;
  localStorage.setItem('todo-collapsed', collapsed ? '1' : '0');
  applyCollapsed();
});

export function updateHomeTodoStat(): void {
  const el = document.getElementById('home-todo-stat');

  if (!el) return;
  el.textContent = todos.length ? `${todos.filter((td) => td.done).length}/${todos.length}` : '–';
}

export function buildFavicon(count: number): string {
  const badge =
    count > 0
      ? "<circle cx='23' cy='9' r='8' fill='#ef4444' stroke='#0e0d12' stroke-width='1.5'/>" +
        "<text x='23' y='12.5' font-family='system-ui,Arial,sans-serif' font-size='" +
        (count > 9 ? '8.5' : '10') +
        "' font-weight='800' fill='white' text-anchor='middle'>" +
        (count > 9 ? '9+' : count) +
        '</text>'
      : '';
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>" +
    '<defs>' +
    "<radialGradient id='sky' cx='50%' cy='40%' r='65%'><stop offset='0%' stop-color='#1f1d2a'/><stop offset='100%' stop-color='#0a0a12'/></radialGradient>" +
    "<radialGradient id='glow' cx='50%' cy='50%' r='50%'><stop offset='0%' stop-color='#fbc678' stop-opacity='0.75'/><stop offset='100%' stop-color='#fbc678' stop-opacity='0'/></radialGradient>" +
    '</defs>' +
    "<rect width='32' height='32' rx='7' fill='url(#sky)'/>" +
    "<circle cx='16' cy='16' r='9' fill='none' stroke='#fff' stroke-width='0.7' opacity='0.4'/>" +
    "<circle cx='16' cy='16' r='1.2' fill='#fff' opacity='0.85'/>" +
    "<circle cx='22.36' cy='9.64' r='4' fill='url(#glow)'/>" +
    "<circle cx='22.36' cy='9.64' r='1.9' fill='#fbc678'/>" +
    badge +
    '</svg>';

  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

export function updateTabBadge(): void {
  const pending = todos.filter((td) => !td.done).length;

  document.title = pending > 0 ? '(' + pending + ') ' + SITE_NAME : SITE_NAME;
  const link = document.querySelector("link[rel='icon']") as HTMLLinkElement | null;

  if (link) link.href = buildFavicon(pending);
}

export let showDoneTodos = localStorage.getItem('todo-show-done') === '1';

export function setShowDoneTodos(v: boolean): void {
  showDoneTodos = v;
}
// Todo categories injected at build time from atlas.toml ([todo].categories); tabs, labels and filter
// all derive from them.
export const TODO_CATEGORIES = __TODO_CATEGORIES_JSON__;
export const TODO_CATS = TODO_CATEGORIES.map((c) => c.cat);
export const TODO_FILTER_LABELS: Record<string, string> = Object.fromEntries(
  TODO_CATEGORIES.map((c): [string, string] => [c.cat, c.label]),
);
// An unknown cat (todo from a category removed from the config) falls back to the first configured
// category (the default), instead of a hard-coded "work".
export function tcat(td: Todo): string {
  return TODO_CATS.includes(td.cat) ? td.cat : TODO_CATS[0];
}
export let todoFilter = localStorage.getItem('todo-filter');

export function setTodoFilter(v: string | null): void {
  todoFilter = v;
}

if (!todoFilter || !TODO_CATS.includes(todoFilter)) todoFilter = TODO_CATS[0];
(function buildTodoFilterTabs(): void {
  const wrap = document.getElementById('todo-filter');

  if (!wrap) return;
  wrap.innerHTML = TODO_CATEGORIES.map(
    (c) =>
      `<button type="button" data-cat="${escapeHtml(c.cat)}" class="todo-filter-btn flex-1 px-3 py-2 transition hover:bg-white/5 text-ink-500">${escapeHtml(c.label)}</button>`,
  ).join('');
})();

export function renderTodoFilterTabs(): void {
  document.querySelectorAll('.todo-filter-btn').forEach((btn) => {
    const cat = (btn as HTMLElement).dataset.cat;
    const active = cat === todoFilter;
    const pending = todos.filter((td) => tcat(td) === cat && !td.done).length;

    btn.classList.toggle('text-accent', active);
    btn.classList.toggle('bg-accent/10', active);
    btn.classList.toggle('text-ink-500', !active);
    btn.textContent = pending > 0 ? `${TODO_FILTER_LABELS[cat!]} (${pending})` : TODO_FILTER_LABELS[cat!];
  });
}

// ── Read-only demo banner ────────────────────────────────────────────────────────────────────────
// Shown ONLY on the static/offline build (the demo) — the live server has working write features, so
// it never appears there. Dismissible per tab session: a new visitor still sees it, but it doesn't nag
// while browsing.
(function (): void {
  if (!IS_OFFLINE_BUILD || window.__viewerMode) return;
  // Don't nag inside an embed: the landing page iframes the demo (./demo/#mind) as a live hero, where
  // the banner would be noise. Any iframe → skip it.
  try {
    if (window.self !== window.top) return;
  } catch (e) {
    return; // cross-origin embed (can't read window.top) → definitely embedded
  }
  const banner = document.getElementById('demo-banner');

  if (!banner) return;
  try {
    if (sessionStorage.getItem('demoBannerDismissed') === '1') return;
  } catch (e) {
    /* sessionStorage unavailable (file://, private mode) → just show it */
  }
  banner.classList.remove('hidden');
  document.getElementById('demo-banner-close')?.addEventListener('click', () => {
    banner.classList.add('hidden');
    try {
      sessionStorage.setItem('demoBannerDismissed', '1');
    } catch (e) {
      /* ignore */
    }
  });
})();
