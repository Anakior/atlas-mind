// Home todo widget — the sidebar #todo-list, on the live /api/todos contract. List rendering and the
// inline edit stay imperative (innerHTML + a swapped <input>), byte-for-behaviour with the pre-migration
// DOM; the Atlas DOM runtime port is a later pass. State (todos/todoFilter/showDoneTodos) lives in the
// shared globals owned by 02/12, since 12-tasks-graph.js still reads them.
//
// refresh stays a top-level function: it is polled by 99-bootstrap, so it must remain a hoisted bundle
// global, not a class method. (setStatus + api — the app-wide status writer + fetch wrapper — live in
// 01-net.ts.)

import { todos, setTodos } from '../content/content-tree';
import {
  tcat,
  todoFilter,
  setTodoFilter,
  showDoneTodos,
  setShowDoneTodos,
  todoForm,
  todoList,
  todoCount,
  todoBubbleCount,
  todoInput,
  TODO_FILTER_LABELS,
  renderTodoFilterTabs,
  updateHomeTodoStat,
  updateTabBadge,
} from './todo-surface';
import { escapeHtml } from '../core/utils';
import { t } from '../core/i18n';
import { isServerMode } from '../core/state';
import { setStatus, api } from '../core/net';
import { Dialogs } from '../modals/dialogs';

export class Todos {
  constructor() {
    todoForm!.addEventListener('submit', (e) => this.onSubmit(e));
    todoList!.addEventListener('click', (e) => this.onListClick(e));
    document.getElementById('todo-filter')!.addEventListener('click', (e) => this.onFilterClick(e));
    document.getElementById('todo-toggle-done')!.addEventListener('click', () => this.onToggleDone());
    document.getElementById('todo-clear-done')!.addEventListener('click', () => this.onClearDone());
  }

  render(): void {
    const inCat = todos.filter((it) => tcat(it) === todoFilter);
    const done = inCat.filter((it) => it.done).length;
    const pendingAll = todos.filter((it) => !it.done).length;

    // Title shows the cumulative total across both categories; the per-category
    // remaining count already lives on the Work/Personal tabs.
    todoCount!.textContent = pendingAll ? t('nPending', pendingAll) : '';
    todoBubbleCount!.textContent = pendingAll > 9 ? '9+' : String(pendingAll);
    todoBubbleCount!.classList.toggle('empty', pendingAll === 0);
    renderTodoFilterTabs();

    if (todoInput) (todoInput as HTMLInputElement).placeholder = t('addTodoIn', TODO_FILTER_LABELS[todoFilter!]);
    updateHomeTodoStat();
    updateTabBadge();

    const controls = document.getElementById('todo-controls')!;
    const toggleLabel = document.getElementById('todo-toggle-label')!;
    const toggleIcon = document.getElementById('todo-toggle-icon')!;

    if (done > 0) {
      controls.classList.remove('hidden');
      controls.classList.add('flex');
      toggleLabel.textContent = showDoneTodos ? t('hideDone', done) : t('showDone', done);
      toggleIcon.style.transform = showDoneTodos ? 'rotate(180deg)' : '';
    } else {
      controls.classList.add('hidden');
      controls.classList.remove('flex');
    }

    if (inCat.length === 0) {
      todoList!.innerHTML = `<li class="px-3 py-4 text-center text-xs text-ink-500">${t('noTasksIn', TODO_FILTER_LABELS[todoFilter!])}</li>`;

      return;
    }

    const visible = showDoneTodos ? inCat : inCat.filter((it) => !it.done);

    if (visible.length === 0) {
      todoList!.innerHTML = `<li class="px-3 py-4 text-center text-xs text-ink-500">${t('allDone', done)}</li>`;

      return;
    }

    todoList!.innerHTML = visible
      .map(
        (item) => `
    <li class="todo-row group flex items-start gap-2 px-3 py-2 hover:bg-navy-800/40" data-id="${item.id}">
      <input type="checkbox" ${item.done ? 'checked' : ''}
        class="todo-check mt-0.5 w-4 h-4 rounded border-navy-600 bg-navy-900 text-blue-500 focus:ring-blue-400/40 cursor-pointer accent-blue-500">
      <span class="todo-text flex-1 text-sm leading-snug ${item.done ? 'line-through text-ink-500' : 'text-ink-100'} cursor-pointer">${escapeHtml(item.text)}</span>
      <button class="todo-del opacity-0 group-hover:opacity-100 text-ink-500 hover:text-rose-400 text-base leading-none transition-opacity" title="${escapeHtml(t('del'))}">&times;</button>
    </li>
  `,
      )
      .join('');
  }

  private async onSubmit(e: Event): Promise<void> {
    e.preventDefault();
    const input = todoInput as HTMLInputElement;
    const text = input.value.trim();

    if (!text) return;
    input.value = '';

    if (!isServerMode) {
      setStatus(t('fileModeTodoStatus'), 'err');

      return;
    }

    try {
      setStatus(t('adding'), 'info');
      setTodos(await api('POST', '/api/todos', { text, cat: todoFilter }));
      this.render();
      setStatus(t('added'), 'ok');
    } catch (err) {
      setStatus(t('err', (err as Error).message), 'err');
    }
  }

  private async onListClick(e: Event): Promise<void> {
    const target = e.target as HTMLElement;
    const row = target.closest('.todo-row') as HTMLElement | null;

    if (!row) return;
    const id = parseInt(row.dataset.id!);
    const check = target.closest('.todo-check') as HTMLInputElement | null;

    if (check) {
      try {
        setTodos(await api('PATCH', '/api/todos/' + id, { done: check.checked }));
        this.render();
        setStatus(check.checked ? t('doneStatus') : t('reopened'), 'ok');
      } catch (err) {
        setStatus(t('err', (err as Error).message), 'err');
        check.checked = !check.checked;
      }

      return;
    }

    if (target.closest('.todo-del')) {
      try {
        setTodos(await api('DELETE', '/api/todos/' + id));
        this.render();
        setStatus(t('deletedStatus'), 'ok');
      } catch (err) {
        setStatus(t('err', (err as Error).message), 'err');
      }

      return;
    }

    if (target.closest('.todo-text')) {
      this.startInlineEdit(row);
    }
  }

  private onFilterClick(e: Event): void {
    const btn = (e.target as HTMLElement).closest('.todo-filter-btn') as HTMLElement | null;

    if (!btn || btn.dataset.cat === todoFilter) return;
    setTodoFilter(btn.dataset.cat!);
    localStorage.setItem('todo-filter', todoFilter!);
    this.render();
  }

  private onToggleDone(): void {
    setShowDoneTodos(!showDoneTodos);
    localStorage.setItem('todo-show-done', showDoneTodos ? '1' : '0');
    this.render();
  }

  private async onClearDone(): Promise<void> {
    const doneTodos = todos.filter((it) => it.done && tcat(it) === todoFilter);

    if (doneTodos.length === 0) return;
    const ok = await Dialogs.confirm({
      title: t('clearDoneConfirmTitle', doneTodos.length),
      message: t('clearDoneConfirmMsg'),
      confirmLabel: t('clearBtn'),
      destructive: true,
    });

    if (!ok) return;
    // Delete largest id first: the server indexes by position, so deleting N shifts
    // all > N; descending order keeps the remaining indices valid.
    const idsDesc = doneTodos.map((it) => it.id).sort((a: number, b: number) => b - a);

    try {
      setStatus(t('clearing'), 'info');

      for (const id of idsDesc) {
        setTodos(await api('DELETE', '/api/todos/' + id));
      }

      this.render();
      setStatus(t('nCleared', idsDesc.length), 'ok');
    } catch (err) {
      setStatus(t('err', (err as Error).message), 'err');
    }
  }

  // Swap the row's text span for a live <input>, commit on Enter/blur, revert on Escape. A 99-bootstrap
  // poll that re-renders mid-edit destroys this input — the keyed runtime port fixes that later.
  private startInlineEdit(row: HTMLElement): void {
    const id = parseInt(row.dataset.id!);
    const item = todos.find((it) => it.id === id);

    if (!item) return;
    const textSpan = row.querySelector('.todo-text');

    if (!textSpan) return;
    const input = document.createElement('input');

    input.type = 'text';
    input.value = item.text;
    input.className =
      'todo-edit flex-1 px-2 py-0.5 text-sm bg-navy-900 border border-blue-400 rounded text-ink-100 focus:outline-none focus:ring-1 focus:ring-blue-400/40';
    textSpan.replaceWith(input);
    input.focus();
    input.select();
    let committed = false;
    const commit = async (save: boolean): Promise<void> => {
      if (committed) return;
      committed = true;
      const newText = input.value.trim();

      if (save && newText && newText !== item.text) {
        try {
          setTodos(await api('PATCH', '/api/todos/' + id, { text: newText }));
          this.render();
          setStatus(t('updated'), 'ok');

          return;
        } catch (err) {
          setStatus(t('err', (err as Error).message), 'err');
        }
      }

      this.render();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        commit(false);
      }
    });
    input.addEventListener('blur', () => commit(true));
  }
}

export const todosWidget = new Todos();

export async function refresh(): Promise<void> {
  if (!isServerMode) return;

  try {
    setTodos(await api('GET', '/api/todos'));
    todosWidget.render();
    setStatus(t('synced'), 'info');
  } catch (err) {
    setStatus(t('offlinePrefix', (err as Error).message), 'err');
  }
}
