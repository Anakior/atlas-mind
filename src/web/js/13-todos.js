function renderTodos() {
  const inCat = todos.filter(t => tcat(t) === todoFilter);
  const total = inCat.length;
  const done = inCat.filter(t => t.done).length;
  const pendingAll = todos.filter(t => !t.done).length;
  // The title always shows the cumulative total (both categories), collapsed or
  // expanded: a single, unambiguous behavior. The remaining count per category is
  // already visible on the Work/Personal tabs (renderTodoFilterTabs).
  todoCount.textContent = pendingAll ? t('nPending', pendingAll) : '';
  todoBubbleCount.textContent = pendingAll > 9 ? '9+' : String(pendingAll);
  todoBubbleCount.classList.toggle('empty', pendingAll === 0);
  renderTodoFilterTabs();
  if (todoInput) todoInput.placeholder = t('addTodoIn', TODO_FILTER_LABELS[todoFilter]);
  updateHomeTodoStat();
  updateTabBadge();

  // Controls bar: visible as soon as there is at least one completed task
  const controls = document.getElementById('todo-controls');
  const toggleLabel = document.getElementById('todo-toggle-label');
  const toggleIcon = document.getElementById('todo-toggle-icon');
  if (done > 0) {
    controls.classList.remove('hidden');
    controls.classList.add('flex');
    toggleLabel.textContent = showDoneTodos
      ? t('hideDone', done)
      : t('showDone', done);
    // Chevron rotation: down when hidden (can reveal), up when shown
    toggleIcon.style.transform = showDoneTodos ? 'rotate(180deg)' : '';
  } else {
    controls.classList.add('hidden');
    controls.classList.remove('flex');
  }

  if (inCat.length === 0) {
    todoList.innerHTML = `<li class="px-3 py-4 text-center text-xs text-ink-500">${t('noTasksIn', TODO_FILTER_LABELS[todoFilter])}</li>`;
    return;
  }

  const visible = showDoneTodos ? inCat : inCat.filter(t => !t.done);
  if (visible.length === 0) {
    todoList.innerHTML = `<li class="px-3 py-4 text-center text-xs text-ink-500">${t('allDone', done)}</li>`;
    return;
  }
  todoList.innerHTML = visible.map(item => `
    <li class="todo-row group flex items-start gap-2 px-3 py-2 hover:bg-navy-800/40" data-id="${item.id}">
      <input type="checkbox" ${item.done ? 'checked' : ''}
        class="todo-check mt-0.5 w-4 h-4 rounded border-navy-600 bg-navy-900 text-blue-500 focus:ring-blue-400/40 cursor-pointer accent-blue-500">
      <span class="todo-text flex-1 text-sm leading-snug ${item.done ? 'line-through text-ink-500' : 'text-ink-100'} cursor-pointer">${escapeHtml(item.text)}</span>
      <button class="todo-del opacity-0 group-hover:opacity-100 text-ink-500 hover:text-rose-400 text-base leading-none transition-opacity" title="${escapeHtml(t('del'))}">&times;</button>
    </li>
  `).join('');
}

function startInlineEdit(row) {
  const id = parseInt(row.dataset.id);
  const item = todos.find(t => t.id === id);
  if (!item) return;
  const textSpan = row.querySelector('.todo-text');
  if (!textSpan) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = item.text;
  input.className = 'todo-edit flex-1 px-2 py-0.5 text-sm bg-navy-900 border border-blue-400 rounded text-ink-100 focus:outline-none focus:ring-1 focus:ring-blue-400/40';
  textSpan.replaceWith(input);
  input.focus();
  input.select();
  let committed = false;
  const commit = async (save) => {
    if (committed) return;
    committed = true;
    const newText = input.value.trim();
    if (save && newText && newText !== item.text) {
      try {
        todos = await api('PATCH', '/api/todos/' + id, { text: newText });
        renderTodos();
        setStatus(t('updated'), 'ok');
        return;
      } catch (e) { setStatus(t('err', e.message), 'err'); }
    }
    renderTodos();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  input.addEventListener('blur', () => commit(true));
}
function setStatus(msg, kind) {
  const colors = { ok: 'text-emerald-400', err: 'text-rose-400', info: 'text-ink-500' };
  todoStatus.innerHTML = `<span class="${colors[kind] || colors.info}">${msg}</span><span class="text-ink-600">${location.host}</span>`;
}

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function refresh() {
  if (!isServerMode) return;
  try {
    todos = await api('GET', '/api/todos');
    renderTodos();
    setStatus(t('synced'), 'info');
  } catch (e) {
    setStatus(t('offlinePrefix', e.message), 'err');
  }
}

todoForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = todoInput.value.trim();
  if (!text) return;
  todoInput.value = '';
  if (!isServerMode) { setStatus(t('fileModeTodoStatus'), 'err'); return; }
  try {
    setStatus(t('adding'), 'info');
    todos = await api('POST', '/api/todos', { text, cat: todoFilter });
    renderTodos();
    setStatus(t('added'), 'ok');
  } catch (e) {
    setStatus(t('err', e.message), 'err');
  }
});

todoList.addEventListener('click', async (e) => {
  const row = e.target.closest('.todo-row');
  if (!row) return;
  const id = parseInt(row.dataset.id);
  if (e.target.closest('.todo-check')) {
    const check = e.target.closest('.todo-check');
    try {
      todos = await api('PATCH', '/api/todos/' + id, { done: check.checked });
      renderTodos();
      setStatus(check.checked ? t('doneStatus') : t('reopened'), 'ok');
    } catch (e) { setStatus(t('err', e.message), 'err'); check.checked = !check.checked; }
    return;
  }
  if (e.target.closest('.todo-del')) {
    try {
      todos = await api('DELETE', '/api/todos/' + id);
      renderTodos();
      setStatus(t('deletedStatus'), 'ok');
    } catch (e) { setStatus(t('err', e.message), 'err'); }
    return;
  }
  if (e.target.closest('.todo-text')) {
    startInlineEdit(row);
  }
});

// Work / Personal filter — stored in localStorage
document.getElementById('todo-filter').addEventListener('click', (e) => {
  const btn = e.target.closest('.todo-filter-btn');
  if (!btn || btn.dataset.cat === todoFilter) return;
  todoFilter = btn.dataset.cat;
  localStorage.setItem('todo-filter', todoFilter);
  renderTodos();
});

// Toggle display of completed tasks
document.getElementById('todo-toggle-done').addEventListener('click', () => {
  showDoneTodos = !showDoneTodos;
  localStorage.setItem('todo-show-done', showDoneTodos ? '1' : '0');
  renderTodos();
});

// Clear all completed tasks
document.getElementById('todo-clear-done').addEventListener('click', async () => {
  const doneTodos = todos.filter(t => t.done && tcat(t) === todoFilter);
  if (doneTodos.length === 0) return;
  const ok = await confirmDialog({
    title: t('clearDoneConfirmTitle', doneTodos.length),
    message: t('clearDoneConfirmMsg'),
    confirmLabel: t('clearBtn'),
    destructive: true,
  });
  if (!ok) return;
  // Delete by descending id (the server indexes by position in the list,
  // so deleting index N first shifts all > N — we take the largest
  // ones first to keep indices stable on the server side).
  const idsDesc = doneTodos.map(t => t.id).sort((a, b) => b - a);
  try {
    setStatus(t('clearing'), 'info');
    for (const id of idsDesc) {
      todos = await api('DELETE', '/api/todos/' + id);
    }
    renderTodos();
    setStatus(t('nCleared', idsDesc.length), 'ok');
  } catch (e) {
    setStatus(t('err', e.message), 'err');
  }
});

// ── More actions menu + Rename modal (admin) ─────────────────────────────────
const btnMore = document.getElementById('btn-more');
const btnMoreMenu = document.getElementById('btn-more-menu');
const renameBackdrop = document.getElementById('rename-backdrop');
const renameForm = document.getElementById('rename-form');
const renameTitle = document.getElementById('rename-title');
const renameDir = document.getElementById('rename-dir');
const renameDirWrap = document.getElementById('rename-dir-wrap');
const renameName = document.getElementById('rename-name');
const renameDirs = document.getElementById('rename-dirs');
const renameError = document.getElementById('rename-error');
const renameCancel = document.getElementById('rename-cancel');

let renameMode = null;

