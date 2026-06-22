// ── Atlas combobox — one reusable "search + create" field ───────────────────
// Factory (the viewer is concatenated IIFEs, not ES modules):
// AtlasCombobox(input, opts) -> controller.
//
//   opts.source     : () => string[] | async () => string[]   current suggestions
//   opts.creatable  : bool   offer « Créer "X" » when the typed value has no match
//   opts.multi      : bool   chips mode (tags, group members); getValue() -> array
//   opts.separator  : ','    serialize/parse a CSV string (setValue in multi)
//   opts.normalize  : v=>v   e.g. lowercase emails (ACL)
//   opts.format     : v=>html  row rendering (default escapeHtml)
//   opts.maxItems   : 50     display cap
//   opts.onSelect   : v=>{}  callback on pick (else writes to the input)
//
// controller: getValue/setValue/refresh/clear/focus/open/close/destroy.

// Shared dialog/button class tokens (design system) — used by the combobox AND to
// stop duplicating Tailwind strings in confirmDialog / acl grant-rows / history.
window.AtlasUI = {
  btnPrimary: 'px-3 py-1.5 text-sm bg-accent hover:brightness-110 text-white rounded font-medium',
  btnDanger: 'px-3 py-1.5 text-sm bg-rose-500/80 hover:bg-rose-500 text-white rounded font-medium',
  btnSecondary: 'px-3 py-1.5 text-sm bg-navy-700 hover:bg-navy-600 text-ink-200 rounded',
  input: 'w-full px-3 py-2 text-sm bg-navy-900 border subtle-border rounded text-ink-100 placeholder-ink-500 focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent',
  label: 'text-[11px] uppercase tracking-wider text-ink-500 font-semibold mb-1 block',
};

(function () {
  function AtlasCombobox(input, opts) {
    opts = opts || {};
    input.removeAttribute('list'); // kill the native datalist
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'false');

    const pop = document.createElement('div');
    pop.className =
      'atlas-cb-pop fixed hidden max-h-64 overflow-y-auto scrollbar-thin ' +
      'rounded-md border subtle-border shadow-2xl shadow-black/70 text-sm';
    // z-index set inline, NOT via a Tailwind class: the arbitrary `z-[70]` lived only in
    // this JS string, which the CSS build doesn't scan, so it compiled to z-index:auto →
    // the dropdown rendered BEHIND the dialog (backdrops go up to z-[65]). Inline wins.
    pop.style.zIndex = '80';
    document.body.appendChild(pop);

    const norm = opts.normalize || ((v) => v);
    const fmt = opts.format || ((v) => escapeHtml(v));
    let all = [];
    let items = []; // strings, plus an optional {__create} sentinel at the end
    let active = 0;
    let isOpen = false;
    let chipBox = null;
    let values = []; // multi mode

    async function load() {
      try {
        all = (await (opts.source ? opts.source() : [])) || [];
      } catch (_) {
        all = [];
      }
    }

    function compute() {
      const raw = input.value.trim();
      const q = raw.toLowerCase();
      let res = q ? all.filter((v) => String(v).toLowerCase().includes(q)) : all.slice();
      if (q) {
        const rk = (v) => (String(v).toLowerCase().startsWith(q) ? 0 : 1);
        res.sort((a, b) => rk(a) - rk(b));
      }
      res = res.slice(0, opts.maxItems || 50).filter((v) => !(opts.multi && values.includes(v)));
      const exact = all.some((v) => String(v).toLowerCase() === q);
      return { res, create: opts.creatable && raw && !exact ? raw : null };
    }

    function render() {
      const { res, create } = compute();
      items = res.slice();
      let html = res
        .map(
          (v, i) =>
            '<div class="atlas-cb-opt px-3 py-1.5 cursor-pointer hover:bg-white/5 ' +
            (i === active ? 'bg-white/10' : '') +
            '" data-i="' + i + '">' + fmt(v) + '</div>',
        )
        .join('');
      if (create) {
        const ci = res.length;
        html +=
          '<div class="atlas-cb-create px-3 py-1.5 cursor-pointer hover:bg-white/5 text-accent ' +
          'flex items-center gap-2 ' + (active === ci ? 'bg-white/10' : '') +
          '" data-create="1"><span class="text-base leading-none">+</span>' +
          escapeHtml(t('comboCreate', create)) + '</div>';
        items.push({ __create: create });
      }
      if (!items.length) {
        pop.innerHTML = '<div class="px-3 py-1.5 text-ink-500">' + escapeHtml(t('noResults')) + '</div>';
      } else {
        pop.innerHTML = html;
      }
      const r = input.getBoundingClientRect();
      pop.style.left = r.left + 'px';
      pop.style.top = r.bottom + 4 + 'px';
      pop.style.width = r.width + 'px';
      pop.classList.remove('hidden');
      isOpen = true;
      input.setAttribute('aria-expanded', 'true');
      const a = pop.children[active];
      if (a && a.scrollIntoView) a.scrollIntoView({ block: 'nearest' });
    }

    function close() {
      pop.classList.add('hidden');
      isOpen = false;
      input.setAttribute('aria-expanded', 'false');
    }

    function choose(it) {
      if (it == null) return;
      const val = norm(typeof it === 'object' && it.__create != null ? it.__create : it);
      if (opts.multi) {
        addChip(val);
        input.value = '';
      } else {
        input.value = val;
      }
      close();
      if (opts.onSelect) opts.onSelect(val);
    }

    // chips (multi) — reuse the existing .doc-tag / .doc-tag-x styling.
    function ensureChipBox() {
      if (opts.multi && !chipBox) {
        chipBox = document.createElement('div');
        chipBox.className = 'flex flex-wrap gap-1.5 mb-1.5 empty:hidden';
        input.parentNode.insertBefore(chipBox, input);
        chipBox.addEventListener('click', (e) => {
          const b = e.target.closest('[data-rm]');
          if (b) {
            values = values.filter((x) => x !== b.dataset.rm);
            renderChips();
          }
        });
      }
    }
    function renderChips() {
      if (!chipBox) return;
      chipBox.innerHTML = values
        .map(
          (v) =>
            '<span class="doc-tag">' + escapeHtml(v) +
            '<button type="button" class="doc-tag-x ml-1" data-rm="' + escapeHtml(v) + '">×</button></span>',
        )
        .join('');
    }
    function addChip(v) {
      ensureChipBox();
      if (!v || values.includes(v)) return;
      values.push(v);
      renderChips();
    }

    input.addEventListener('focus', async () => {
      await load();
      active = 0;
      render();
    });
    input.addEventListener('input', () => {
      active = 0;
      render();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && opts.multi && !input.value && values.length) {
        values.pop();
        renderChips();
        return;
      }
      if (!isOpen) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        active = Math.min(active + 1, items.length - 1);
        render();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        active = Math.max(active - 1, 0);
        render();
      } else if (e.key === 'Enter') {
        if (items[active] != null) {
          e.preventDefault();
          choose(items[active]);
        }
      } else if (e.key === 'Escape') {
        e.stopPropagation(); // close the dropdown, NOT the dialog
        close();
      }
    });
    pop.addEventListener('mousedown', (e) => {
      const el = e.target.closest('[data-i],[data-create]');
      if (!el) return;
      e.preventDefault(); // keep focus on the input
      choose(el.dataset.create ? items[items.length - 1] : items[+el.dataset.i]);
    });
    input.addEventListener('blur', () => setTimeout(close, 120));

    return {
      getValue: () => (opts.multi ? values.slice() : input.value.trim()),
      setValue: (v) => {
        if (opts.multi) {
          values = Array.isArray(v)
            ? v.slice()
            : String(v || '').split(opts.separator || ',').map((s) => s.trim()).filter(Boolean);
          ensureChipBox();
          renderChips();
        } else {
          input.value = v || '';
        }
      },
      refresh: async () => {
        await load();
        if (isOpen) render();
      },
      clear: () => {
        if (opts.multi) {
          values = [];
          renderChips();
        } else {
          input.value = '';
        }
      },
      focus: () => input.focus(),
      open: () => render(),
      close,
      destroy: () => {
        pop.remove();
        if (chipBox) chipBox.remove();
      },
    };
  }

  window.AtlasCombobox = AtlasCombobox;
})();
