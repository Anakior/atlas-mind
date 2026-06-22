// Activity card (home) — Journal + Constellation views over the attributed git history.
// Reads GET /api/activity (the read side of the attribution layer); reuses the real
// constellation avatars. Hidden offline / when there is nothing to show.
(function () {
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // CDC event types -> display label + tint + Heroicons-v2 outline path (clean line
  // icons, matching the rest of the app). Keyed by the type /api/activity returns.
  const TYPES = {
    create: { label: 'created', color: '#e8941c', d: 'M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z' },
    edit: { label: 'edited', color: '#1d9bd1', d: 'm16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.931-8.931Zm0 0L19.5 7.125' },
    move: { label: 'moved', color: '#1d9bd1', d: 'M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5' },
    delete: { label: 'deleted', color: '#868a90', d: 'm14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0' },
    check: { label: 'checked', color: '#5fd0a6', d: 'M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z' },
    revert: { label: 'reverted', color: '#e8941c', d: 'M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3' },
  };
  const TY = (t) => TYPES[t] || TYPES.edit;

  const AI = {
    claude: 'M12 2.6l1.6 5.9 5.9 1.6-5.9 1.6L12 21.4l-1.6-7.7L4.5 12l5.9-1.6L12 2.6Z',
    chatgpt: 'M12 3.2 18.5 7v8L12 18.8 5.5 15V7L12 3.2Z',
    gemini: 'M12 3c.6 4.5 2.4 6.3 6.9 6.9-4.5.6-6.3 2.4-6.9 6.9-.6-4.5-2.4-6.3-6.9-6.9C9.6 9.3 11.4 7.5 12 3Z',
    generic: 'M12 4l2 6 6 2-6 2-2 6-2-6-6-2 6-2 2-6Z',
  };

  const iconSvg = (type, size) => {
    const t = TY(type);
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${t.color}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="${t.d}"/></svg>`;
  };

  const aiBadge = (family) =>
    `<span class="activity-badge"><svg width="9" height="9" viewBox="0 0 24 24" fill="#e8941c"><path d="${AI[family] || AI.generic}"/></svg></span>`;

  const botAvatar = (size) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 40 40"><defs><radialGradient id="actbot" cx="42%" cy="38%"><stop offset="0" stop-color="#ffd9a0"/><stop offset="55%" stop-color="#e8941c"/><stop offset="100%" stop-color="#9a5a10"/></radialGradient></defs><rect width="40" height="40" rx="9" fill="#1a181e"/><path d="M8 27 q12 -7 24 0" stroke="rgba(232,148,28,.35)" stroke-width="1.2" fill="none"/><circle cx="20" cy="18" r="6.5" fill="url(#actbot)"/><circle cx="17.6" cy="15.6" r="1.8" fill="rgba(255,255,255,.6)"/></svg>`;

  const avatar = (e, size) => {
    if (e.bot) return botAvatar(size);
    try {
      return constellationSvg(avatarSeed(e.first, e.last, e.email), size);
    } catch (_) {
      return `<span class="inline-block rounded-lg" style="width:${size}px;height:${size}px;background:#23222a"></span>`;
    }
  };

  function rel(min) {
    if (min < 1) return "à l'instant";
    if (min < 60) return min + ' min';
    const h = Math.round(min / 60);
    if (h < 24) return h + ' h';
    const d = Math.round(min / 1440);
    return d === 1 ? 'hier' : 'il y a ' + d + ' j';
  }
  function dayKey(min) {
    const d = new Date(Date.now() - min * 60000);
    const now = new Date();
    const a = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const b = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diff = Math.round((a - b) / 86400000);
    if (diff <= 0) return "Aujourd'hui";
    if (diff === 1) return 'Hier';
    return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  // /api/activity event -> render item.
  function toItem(e) {
    const author = (e.author || e.email || '').trim();
    const parts = author.split(/\s+/);
    const t = Date.parse(e.date);
    return {
      who: author,
      first: parts[0] || e.email || '',
      last: parts.slice(1).join(' '),
      email: e.email || '',
      ai: e.ai || null,
      bot: /atlas bot/i.test(author),
      type: e.type,
      title: e.title || (e.paths && e.paths[0]) || '',
      agoMin: isNaN(t) ? 0 : Math.max(0, Math.round((Date.now() - t) / 60000)),
      sha: e.short_sha || (e.sha || '').slice(0, 7),
      path: (e.paths && e.paths[0]) || '',
    };
  }

  // Show the doc's history overlay in place ("voir les modifications") — no navigation,
  // the activity feed stays put. No-ops if the doc no longer exists (deleted/moved).
  function openDocHistory(path) {
    if (!path || typeof fileMap === 'undefined' || typeof openHistory !== 'function') return;
    const f = fileMap[path];
    if (f) openHistory(f);
  }

  let _items = null;

  async function load() {
    if (IS_OFFLINE_BUILD || !location.protocol.startsWith('http')) return null;
    try {
      const r = await fetch('/api/activity?since=60&limit=40');
      if (!r.ok) return null;
      const data = await r.json();
      return Array.isArray(data.events) ? data.events.map(toItem) : null;
    } catch (_) {
      return null;
    }
  }

  // Collapse a run of consecutive events on the SAME doc by the same actor + type into
  // one entry with a count — a burst of edits to one doc shouldn't read as N identical
  // lines (CDC §9). Events arrive newest-first, so the kept time is the most recent.
  function aggregate(items) {
    const out = [];
    for (const e of items) {
      const last = out[out.length - 1];
      if (last && last.title === e.title && last.who === e.who
          && last.type === e.type && last.ai === e.ai) {
        last.count += 1;
      } else {
        out.push(Object.assign({ count: 1 }, e));
      }
    }
    return out;
  }

  // ── Journal ───────────────────────────────────────────────────────────
  function row(e) {
    const ty = TY(e.type);
    const via = e.ai ? `<span class="text-ink-500 text-xs">· via ${esc(e.ai)}</span>` : '';
    return (
      `<div class="act-row flex items-center gap-3" data-path="${esc(e.path)}" title="Voir les modifications">
        <div class="relative shrink-0" style="line-height:0">${avatar(e, 30)}${e.ai ? aiBadge(e.ai) : ''}</div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5"><span class="text-sm font-semibold text-ink-100">${esc(e.who)}</span>${via}</div>
          <div class="flex items-center gap-1.5 text-sm mt-0.5">
            ${iconSvg(e.type, 14)}
            <span style="color:${ty.color};font-weight:600">${ty.label}</span>
            <span class="text-ink-300 truncate">${esc(e.title)}</span>
            ${e.count > 1 ? `<span class="text-ink-500 text-xs shrink-0">×${e.count}</span>` : ''}
          </div>
        </div>
        <div class="shrink-0 text-xs text-ink-500 font-mono" title="${esc(e.sha)}">${rel(e.agoMin)}</div>
      </div>`
    );
  }

  const JOURNAL_PREVIEW = 6;
  let _expanded = false;

  function journalHtml() {
    let out = '';
    let day = '';
    const shown = _expanded ? _items : _items.slice(0, JOURNAL_PREVIEW);
    shown.forEach((e) => {
      const k = dayKey(e.agoMin);
      if (k !== day) {
        day = k;
        out += `<div class="text-[11px] uppercase tracking-wider text-ink-500 font-semibold mt-3 mb-1 first:mt-0">${esc(day)}</div>`;
      }
      out += row(e);
    });
    // Toggle in place — no extra view to navigate to, the feed just unfolds.
    if (_items.length > JOURNAL_PREVIEW) {
      out += `<div class="text-right mt-3"><a class="act-seeall text-sm text-accent hover:underline cursor-pointer">${_expanded ? 'Réduire ↑' : 'Voir tout →'}</a></div>`;
    }
    return out;
  }

  // ── Constellation ─────────────────────────────────────────────────────
  const ORRERY_CAP = 18;  // aggregated entries (distinct doc-activities), not raw commits

  function orreryNodes() {
    const cx = 360, cy = 265;
    const radii = [104, 172, 236];
    // Cap + even split by recency RANK (not raw time): each ring gets a balanced share
    // so a burst of recent edits can't pile onto one ring. Inner = most recent.
    const items = _items.slice(0, ORRERY_CAP).map((e, i) => ({ e, i }));
    const perRing = Math.max(1, Math.ceil(items.length / 3));
    const rings = [[], [], []];
    items.forEach((it, idx) => rings[Math.min(2, Math.floor(idx / perRing))].push(it));
    let nodes = '';
    rings.forEach((arr, ri) => {
      const r = radii[ri];
      const off = ri * 0.7 + 0.15;  // stagger rings so nodes don't align radially
      arr.forEach((it, k) => {
        const ang = (k + 0.5) / arr.length * Math.PI * 2 - Math.PI / 2 + off;
        const x = cx + r * Math.cos(ang), y = cy + r * Math.sin(ang);
        const c = TY(it.e.type).color;
        nodes +=
          `<g class="act-node" data-i="${it.i}" tabindex="0" transform="translate(${x.toFixed(1)},${y.toFixed(1)})">
            <g class="act-node-inner">
              <circle r="19" fill="#14131a" stroke="${c}" stroke-opacity=".6"/>
              <svg x="-11" y="-11" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${TY(it.e.type).d}"/></svg>
              ${it.e.ai ? '<circle cx="13" cy="-13" r="5" fill="#14131a" stroke="#e8941c" stroke-opacity=".8"/><circle cx="13" cy="-13" r="1.8" fill="#e8941c"/>' : ''}
            </g>
          </g>`;
      });
    });
    const ringSvg = radii
      .map((r) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#6a7180" stroke-opacity=".4" stroke-width="1" stroke-dasharray="3 7"/>`)
      .join('');
    return { ringSvg, nodes, cx, cy };
  }

  function orreryHtml() {
    const { ringSvg, nodes, cx, cy } = orreryNodes();
    const legend = Object.keys(TYPES)
      .map((k) => `<span class="act-legend-chip">${iconSvg(k, 12)}<span>${TYPES[k].label}</span></span>`)
      .join('');
    return (
      `<div class="act-orrery flex items-start gap-4">
        <div class="act-sky relative flex-1 min-w-0">
          <svg viewBox="0 0 720 540" style="width:100%;height:auto;overflow:visible">
            <defs>
              <radialGradient id="actcore" cx="42%" cy="38%"><stop offset="0" stop-color="#ffd9a0"/><stop offset="55%" stop-color="#e8941c"/><stop offset="100%" stop-color="#8a4f0e"/></radialGradient>
              <radialGradient id="actglow" cx="50%" cy="50%"><stop offset="0" stop-color="rgba(232,148,28,.15)"/><stop offset="70%" stop-color="rgba(232,148,28,0)"/></radialGradient>
            </defs>
            <circle cx="${cx}" cy="${cy}" r="120" fill="url(#actglow)"/>
            <g class="act-spin">${ringSvg}${nodes}</g>
            <circle class="act-sun" cx="${cx}" cy="${cy}" r="27" fill="url(#actcore)"/>
          </svg>
          <div class="act-pop dialog-card hidden"></div>
          <div class="act-egg"></div>
        </div>
        <div class="act-legend">${legend}</div>
      </div>`
    );
  }

  function popHtml(e) {
    const ty = TY(e.type);
    const via = e.ai ? `<span class="text-ink-500 text-xs">· via ${esc(e.ai)}</span>` : '';
    return (
      `<div class="flex items-center gap-2 mb-1.5"><span style="line-height:0">${avatar(e, 26)}</span><span class="text-sm font-semibold text-ink-100">${esc(e.who)}</span>${via}</div>
       <div class="flex items-baseline gap-1.5 text-sm"><span style="color:${ty.color};font-weight:600;white-space:nowrap">${ty.label}</span><span class="text-ink-300" style="min-width:0;overflow-wrap:anywhere">${esc(e.title)}</span>${e.count > 1 ? `<span class="text-ink-500 text-xs" style="white-space:nowrap">×${e.count}</span>` : ''}</div>
       <div class="text-xs text-ink-500 font-mono mt-1.5">${rel(e.agoMin)} · ${esc(e.sha)}</div>`
    );
  }

  function wireOrreryHover(container) {
    const wrap = container.querySelector('.act-sky');
    const pop = container.querySelector('.act-pop');
    if (!wrap || !pop) return;
    const show = (node) => {
      const e = _items[+node.dataset.i];
      if (!e) return;
      pop.innerHTML = popHtml(e);
      pop.classList.remove('hidden');
      const nb = node.getBoundingClientRect(), wb = wrap.getBoundingClientRect();
      let left = nb.left - wb.left + nb.width / 2;
      const half = pop.offsetWidth / 2;
      left = Math.max(half + 4, Math.min(wb.width - half - 4, left));
      pop.style.left = left + 'px';
      // flip below the node when there isn't room above (keeps it off the toggle / top edge)
      if (nb.top - wb.top > pop.offsetHeight + 16) {
        pop.style.top = (nb.top - wb.top - 10) + 'px';
        pop.style.transform = 'translate(-50%, -100%)';
      } else {
        pop.style.top = (nb.bottom - wb.top + 10) + 'px';
        pop.style.transform = 'translate(-50%, 0)';
      }
    };
    const hide = () => pop.classList.add('hidden');
    wrap.querySelectorAll('.act-node').forEach((n) => {
      n.addEventListener('mouseenter', () => show(n));
      n.addEventListener('mouseleave', hide);
      n.addEventListener('focus', () => show(n));
      n.addEventListener('blur', hide);
      n.addEventListener('click', () => {
        const e = _items[+n.dataset.i];
        if (e) openDocHistory(e.path);
      });
    });
  }

  // Easter egg: flick the orrery (one full orbit) + bounce the sun on click; every 5th
  // click, a little supernova line floats up. Pure fun; reduced-motion gets just the line.
  const EGG_LINES = [
    '✨ tu as trouvé le cœur du mind',
    '🪐 Atlas porte le ciel… et ton bordel',
    '☄️ supernova !',
    '🌟 fais un vœu',
    '🔭 continue d’explorer',
  ];
  function wireSun(container) {
    const sun = container.querySelector('.act-sun');
    const spin = container.querySelector('.act-spin');
    const egg = container.querySelector('.act-egg');
    if (!sun) return;
    let n = 0;
    sun.addEventListener('click', () => {
      n += 1;
      if (spin) { spin.classList.remove('spinning'); void spin.getBBox(); spin.classList.add('spinning'); }
      sun.classList.remove('pop'); void sun.getBBox(); sun.classList.add('pop');
      if (n % 5 === 0 && egg) {
        egg.textContent = EGG_LINES[(n / 5 - 1) % EGG_LINES.length];
        egg.classList.remove('show'); void egg.offsetWidth; egg.classList.add('show');
      }
    });
  }

  // ── Card shell + view switch ──────────────────────────────────────────
  const segClass = (active) =>
    'activity-seg px-3 py-1 text-xs font-medium ' + (active ? 'is-active bg-accent text-white' : 'text-ink-300');

  function cardHtml() {
    return (
      `<div id="home-activity-card" class="border subtle-border rounded-lg p-4 bg-black/15">
        <div class="flex items-center justify-between mb-3">
          <h2 class="!mb-0 !mt-0">Activité</h2>
          <div class="inline-flex rounded-lg border subtle-border overflow-hidden">
            <button type="button" data-view="journal" class="${segClass(true)}">Journal</button>
            <button type="button" data-view="orrery" class="${segClass(false)}">Constellation</button>
          </div>
        </div>
        <div id="activity-journal">${journalHtml()}</div>
        <div id="activity-orrery" class="hidden"></div>
      </div>`
    );
  }

  function setView(card, v, persist) {
    const j = card.querySelector('#activity-journal');
    const o = card.querySelector('#activity-orrery');
    if (v === 'orrery') {
      if (!o.dataset.rendered) { o.innerHTML = orreryHtml(); o.dataset.rendered = '1'; wireOrreryHover(o); wireSun(o); }
      j.classList.add('hidden'); o.classList.remove('hidden');
    } else {
      o.classList.add('hidden'); j.classList.remove('hidden');
    }
    card.querySelectorAll('[data-view]').forEach((b) => { b.className = segClass(b.dataset.view === v); });
    if (persist) { try { localStorage.setItem('atlas:activityView', v); } catch (_) {} }
  }

  function wire(card) {
    let saved = 'journal';
    try { saved = localStorage.getItem('atlas:activityView') || 'journal'; } catch (_) {}
    const q = new URLSearchParams(location.search).get('view');
    if (q === 'journal' || q === 'orrery') saved = q;
    setView(card, saved, false);
    card.querySelectorAll('[data-view]').forEach((b) =>
      b.addEventListener('click', () => setView(card, b.dataset.view, true)));
    card.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-view]')) return;
      if (ev.target.closest('.act-seeall')) {
        _expanded = !_expanded;
        card.querySelector('#activity-journal').innerHTML = journalHtml();
        return;
      }
      const row = ev.target.closest('.act-row[data-path]');
      if (row && row.dataset.path) openDocHistory(row.dataset.path);
    });
  }

  // Fill the mount left by showWelcome(). Robust to load order (showWelcome may run at
  // boot before this file defines the renderer, so we also mount on our own load).
  window.mountActivity = async function () {
    const m = document.getElementById('home-activity-mount');
    if (!m) return;
    // Re-fetch on every mount: the feed must reflect edits made since the home was
    // last shown (e.g. a task toggle) — no caching, or it stays stale until reload.
    _expanded = false;
    const raw = await load();
    _items = raw ? aggregate(raw) : raw;
    if (!_items || !_items.length) { m.innerHTML = ''; return; }  // offline / nothing → no card
    m.innerHTML = cardHtml();
    wire(m.querySelector('#home-activity-card'));
  };
  window.mountActivity();

  const st = document.createElement('style');
  st.textContent = [
    '.activity-badge{position:absolute;right:-3px;bottom:-3px;display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:999px;background:#1a181e;border:1px solid rgba(232,148,28,.6)}',
    '.act-row{padding:7px 8px;margin:0 -8px;border-radius:8px;cursor:pointer;transition:background .12s}',
    '.act-row:hover{background:rgba(255,255,255,.035)}',
    '.activity-seg{cursor:pointer;transition:color .12s,background .12s}',
    '.activity-seg:not(.is-active):hover{color:#d1d2d3}',
    '.act-node{cursor:pointer}',
    '.act-node-inner{transform-box:fill-box;transform-origin:center;transition:transform .12s}',
    '.act-node:hover .act-node-inner,.act-node:focus .act-node-inner{transform:scale(1.22)}',
    '.act-node:focus{outline:none}',
    '.act-pop{position:absolute;transform:translate(-50%,-100%);min-width:200px;max-width:300px;padding:11px 13px;border-radius:14px;pointer-events:none;z-index:20}',
    '.act-pop.hidden{display:none}',
    '.act-legend{display:flex;flex-direction:column;gap:7px;flex-shrink:0;align-self:center}',
    '.act-legend-chip{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border:1px solid rgba(255,255,255,.08);border-radius:999px;background:rgba(255,255,255,.03);font-size:11px;color:#b0b1b5}',
    '.act-sun{transform-box:fill-box;transform-origin:center}',
    '.act-spin{transform-box:view-box;transform-origin:360px 265px}',
    '.act-egg{position:absolute;left:50%;top:calc(50% + 52px);transform:translate(-50%,0);font-size:13px;font-weight:600;color:#f3bd6a;opacity:0;pointer-events:none;white-space:nowrap;text-shadow:0 1px 6px rgba(0,0,0,.7)}',
    '@media (prefers-reduced-motion: no-preference){',
    '.act-spin.spinning{animation:act-orbit 1.1s cubic-bezier(.34,.1,.2,1)}',
    '@keyframes act-orbit{to{transform:rotate(360deg)}}',
    '.act-sun.pop{animation:act-sunpop .5s ease}',
    '@keyframes act-sunpop{0%{transform:scale(1)}40%{transform:scale(1.28)}100%{transform:scale(1)}}',
    '.act-egg.show{animation:act-egg 1.9s ease forwards}',
    '@keyframes act-egg{0%{opacity:0;transform:translate(-50%,8px)}15%{opacity:1;transform:translate(-50%,0)}72%{opacity:1}100%{opacity:0;transform:translate(-50%,-12px)}}',
    '}',
  ].join('');
  document.head.appendChild(st);
})();
