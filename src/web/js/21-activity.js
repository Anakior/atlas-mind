// Activity card (home) — Journal / Constellation / Santé views over the attributed git history.
// Reads GET /api/activity (the read side of the attribution layer); reuses the real
// constellation avatars. Hidden offline / when there is nothing to show.
(function () {
  const esc = escapeHtml;  // canonical (escapes ' too), from 01-i18n-state.js

  // CDC event types -> display label + tint + Heroicons-v2 outline path (clean line
  // icons, matching the rest of the app). Keyed by the type /api/activity returns.
  const TYPES = {
    create: { label: 'created', color: '#e8941c', d: 'M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z' },
    edit: { label: 'edited', color: '#1d9bd1', d: 'm16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.931-8.931Zm0 0L19.5 7.125' },
    move: { label: 'moved', color: '#1d9bd1', d: 'M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5' },
    delete: { label: 'deleted', color: '#868a90', d: 'm14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0' },
    check: { label: 'checked', color: '#5fd0a6', d: 'M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z' },
    revert: { label: 'reverted', color: '#e8941c', d: 'M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3' },
    // Mental-node subscriptions: the share/nodes glyph, tinted green (added) / grey (removed).
    node_add: { label: 'added node', color: '#5fd0a6', d: 'M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.933-2.185 2.25 2.25 0 0 0-3.933 2.185Z' },
    node_remove: { label: 'removed node', color: '#868a90', d: 'M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.933-2.185 2.25 2.25 0 0 0-3.933 2.185Z' },
  };
  const TY = (t) => TYPES[t] || TYPES.edit;

  // Verb labels by UI language (LANG from 01-i18n-state.js). A local map (vs t()) keeps
  // them next to TYPES and avoids colliding with existing STRINGS keys (create/edit…).
  const VERB = {
    fr: { create: 'créé', edit: 'édité', move: 'déplacé', delete: 'supprimé', check: 'coché', revert: 'restauré', node_add: 'ajouté le nœud', node_remove: 'retiré le nœud' },
    en: { create: 'created', edit: 'edited', move: 'moved', delete: 'deleted', check: 'checked', revert: 'reverted', node_add: 'added the node', node_remove: 'removed the node' },
  };
  const verb = (type) => (VERB[LANG] || VERB.fr)[type] || type;
  // In a sentence ("Ludovic a créé X"), French wants the auxiliary; English doesn't.
  // The bare verb() stays for the orrery legend, where chips read as labels, not sentences.
  const verbPhrase = (type) => (LANG === 'en' ? '' : 'a ') + verb(type);
  const docTitle = (p) => ((p || '').split('/').pop() || p).replace(/\.(md|html)$/i, '');

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

  // Atlas Bot (the app's own automated writes) shows the application logo itself.
  const botAvatar = (size) =>
    `<img src="/icon.svg" width="${size}" height="${size}" alt="Atlas" style="display:block">`;

  const avatar = (e, size) => {
    if (e.bot) return botAvatar(size);
    try {
      return constellationSvg(avatarSeed(e.first, e.last, e.email), size);
    } catch (_) {
      return `<span class="inline-block rounded-lg" style="width:${size}px;height:${size}px;background:#23222a"></span>`;
    }
  };

  function rel(min) {
    const en = LANG === 'en';
    if (min < 1) return en ? 'just now' : "à l'instant";
    if (min < 60) return min + ' min';
    const h = Math.round(min / 60);
    if (h < 24) return h + ' h';
    const d = Math.round(min / 1440);
    if (d === 1) return en ? 'yesterday' : 'hier';
    return en ? d + 'd ago' : 'il y a ' + d + ' j';
  }
  function dayKey(min) {
    const d = new Date(Date.now() - min * 60000);
    const now = new Date();
    const a = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const b = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diff = Math.round((a - b) / 86400000);
    if (diff <= 0) return LANG === 'en' ? 'Today' : "Aujourd'hui";
    if (diff === 1) return LANG === 'en' ? 'Yesterday' : 'Hier';
    return d.toLocaleDateString(LANG === 'en' ? 'en-US' : 'fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  }

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
      subject: e.subject || '',
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
  let _orreryItems = [];   // the list the constellation nodes index into (respects the filter)
  let _aiOnly = false;     // 13d: filter the feed to AI-authored events only
  let _digest = null;      // 13b: factual digest of the last 7 days (computed from the events)
  let _health = null;      // 13c: { stale, cands } for the Santé view
  let _healthExpanded = false;
  let _candExpanded = false;
  let _healthTab = (() => { try { return localStorage.getItem('atlas:healthTab') || 'stale'; } catch (_) { return 'stale'; } })();  // 13c: persisted Santé sub-view
  const shownItems = () => (_aiOnly ? _items.filter((i) => i.ai) : _items);

  async function load() {
    if (IS_OFFLINE_BUILD || !location.protocol.startsWith('http')) return null;
    try {
      const r = await fetch('/api/activity?since=60&limit=200');
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
      if (last && last.path === e.path && last.who === e.who
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
      `<div class="act-row flex items-center gap-3" data-path="${esc(e.path)}" data-tip="${esc(t('actSeeChanges'))}">
        <div class="relative shrink-0" style="line-height:0">${avatar(e, 30)}${e.ai ? aiBadge(e.ai) : ''}</div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5"><span class="text-sm font-semibold text-ink-100">${esc(e.who)}</span>${via}</div>
          <div class="flex items-center gap-1.5 text-sm mt-0.5">
            <span class="shrink-0" style="line-height:0">${iconSvg(e.type, 14)}</span>
            <span class="shrink-0" style="color:${ty.color};font-weight:600;white-space:nowrap">${verbPhrase(e.type)}</span>
            <span class="text-ink-300 truncate min-w-0">${esc(e.title)}</span>
            ${e.count > 1 ? `<span class="text-ink-500 text-xs shrink-0">×${e.count}</span>` : ''}
          </div>
        </div>
        <div class="shrink-0 text-xs text-ink-500 font-mono" title="${esc(e.sha)}">${rel(e.agoMin)}</div>
      </div>`
    );
  }

  const JOURNAL_PREVIEW = 8;
  let _expanded = false;

  function journalHtml() {
    const all = shownItems();
    if (!all.length) return `<div class="text-ink-500 text-sm py-4 text-center">${_aiOnly ? t('actEmptyAi') : t('actEmpty')}</div>`;
    let out = '';
    let day = '';
    const shown = _expanded ? all : all.slice(0, JOURNAL_PREVIEW);
    shown.forEach((e) => {
      const k = dayKey(e.agoMin);
      if (k !== day) {
        day = k;
        out += `<div class="text-[11px] uppercase tracking-wider text-ink-500 font-semibold mt-3 mb-1 first:mt-0">${esc(day)}</div>`;
      }
      out += row(e);
    });
    // Toggle in place — no extra view to navigate to, the feed just unfolds.
    if (all.length > JOURNAL_PREVIEW) {
      out += `<div class="text-right mt-3"><a class="act-seeall text-sm text-accent hover:underline cursor-pointer">${_expanded ? t('actCollapse') : t('actSeeAll')}</a></div>`;
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
    const items = (_orreryItems = shownItems()).slice(0, ORRERY_CAP).map((e, i) => ({ e, i }));
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
      .map((k) => `<span class="act-legend-chip">${iconSvg(k, 12)}<span>${verb(k)}</span></span>`)
      .join('');
    return (
      `<div class="act-orrery flex items-start gap-4">
        <div class="act-sky relative flex-1 min-w-0">
          <svg viewBox="0 0 720 540" style="width:100%;height:auto;overflow:visible">
            <defs>
              <radialGradient id="actcore" cx="42%" cy="38%"><stop offset="0" stop-color="#ffd9a0"/><stop offset="55%" stop-color="#e8941c"/><stop offset="100%" stop-color="#8a4f0e"/></radialGradient>
              <radialGradient id="actglow" cx="50%" cy="50%"><stop offset="0" stop-color="rgba(232,148,28,.15)"/><stop offset="70%" stop-color="rgba(232,148,28,0)"/></radialGradient>
              <radialGradient id="actsunlimb" cx="42%" cy="38%"><stop offset="58%" stop-color="rgba(0,0,0,0)"/><stop offset="100%" stop-color="rgba(70,35,5,.6)"/></radialGradient>
              <clipPath id="actsunclip"><circle cx="${cx}" cy="${cy}" r="27"/></clipPath>
              <filter id="actsunblur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2.3"/></filter>
            </defs>
            <circle class="act-glow" cx="${cx}" cy="${cy}" r="120" fill="url(#actglow)"/>
            <g class="act-spin">${ringSvg}${nodes}</g>
            <g class="act-sun"><g class="act-sun-pulse">
              <circle cx="${cx}" cy="${cy}" r="27" fill="url(#actcore)"/>
              <g clip-path="url(#actsunclip)" filter="url(#actsunblur)">
                <circle cx="${cx - 7}" cy="${cy - 8}" r="6" fill="#fff1d6" opacity=".5"/>
                <circle cx="${cx + 8}" cy="${cy - 3}" r="5.4" fill="#b86f12" opacity=".5"/>
                <circle cx="${cx - 3}" cy="${cy + 8}" r="6.7" fill="#a55f0f" opacity=".45"/>
                <circle cx="${cx - 11}" cy="${cy + 3}" r="4" fill="#ffe2b0" opacity=".4"/>
                <circle cx="${cx + 9}" cy="${cy + 9}" r="4.7" fill="#8a4f0e" opacity=".5"/>
                <circle cx="${cx + 2}" cy="${cy - 11}" r="3.4" fill="#ffe9c4" opacity=".4"/>
              </g>
              <circle cx="${cx}" cy="${cy}" r="27" fill="url(#actsunlimb)"/>
              <circle cx="${cx - 7}" cy="${cy - 9}" r="4" fill="#fff7e6" opacity=".55" filter="url(#actsunblur)"/>
            </g></g>
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
       <div class="flex items-baseline gap-1.5 text-sm"><span style="color:${ty.color};font-weight:600;white-space:nowrap">${verbPhrase(e.type)}</span><span class="text-ink-300" style="min-width:0;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(e.title)}</span>${e.count > 1 ? `<span class="text-ink-500 text-xs" style="white-space:nowrap">×${e.count}</span>` : ''}</div>
       <div class="text-xs text-ink-500 font-mono mt-1.5">${rel(e.agoMin)} · ${esc(e.sha)}</div>`
    );
  }

  function wireOrreryHover(container) {
    const wrap = container.querySelector('.act-sky');
    const pop = container.querySelector('.act-pop');
    if (!wrap || !pop) return;
    const show = (node) => {
      const e = _orreryItems[+node.dataset.i];
      if (!e) return;
      pop.innerHTML = popHtml(e);
      pop.classList.remove('hidden');
      if (window.matchMedia('(max-width:767px)').matches) {
        pop.style.left = pop.style.top = pop.style.transform = '';  // CSS bottom-sheet positions it
        return;
      }
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
    const noHover = window.matchMedia('(hover: none)').matches;  // touch: no hover → tap to reveal
    let activeNode = null;
    wrap.querySelectorAll('.act-node').forEach((n) => {
      n.addEventListener('mouseenter', () => show(n));
      n.addEventListener('mouseleave', hide);
      n.addEventListener('focus', () => show(n));
      n.addEventListener('blur', hide);
      n.addEventListener('click', () => {
        const e = _orreryItems[+n.dataset.i];
        if (!noHover) { if (e) openDocHistory(e.path); return; }
        if (activeNode === n) { if (e) openDocHistory(e.path); }   // 2nd tap on same node → open history
        else { activeNode = n; show(n); }                          // 1st tap → reveal the popover
      });
    });
    wrap.addEventListener('click', (ev) => {
      if (!ev.target.closest('.act-node')) { hide(); activeNode = null; }  // tap the empty sky → dismiss
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
    // Drop each one-shot class when its animation ends, so it doesn't persist and replay
    // when the hidden orrery is shown again (Journal ⇄ Constellation switch re-displays it).
    if (spin) spin.addEventListener('animationend', () => spin.classList.remove('spinning'));
    sun.addEventListener('animationend', () => sun.classList.remove('pop'));
    if (egg) egg.addEventListener('animationend', () => egg.classList.remove('show'));
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
  // A checkbox-style filter (small box + label), not a button — reads as "filter the feed".
  const aiFilterHtml = () =>
    `<button type="button" data-ai-filter class="flex items-center gap-1.5 text-xs transition ${_aiOnly ? 'text-accent' : 'text-ink-400 hover:text-ink-200'}" title="${t('actAiOnly')}">` +
    `<span style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:4px;font-size:10px;color:#fff;border:1.5px solid ${_aiOnly ? '#1d9bd1' : '#5e6066'};background:${_aiOnly ? '#1d9bd1' : 'transparent'}">${_aiOnly ? '✓' : ''}</span>` +
    `${t('actAiOnly')}</button>`;

  // 13b — factual digest over the last 7 days (deterministic, derived from the events;
  // the narrative side is the AI via the existing `activity` MCP tool, on demand).
  function computeDigest(items) {
    const WIN = 7 * 24 * 60; // minutes in 7 days
    const docs = new Set(), authors = new Set();
    let created = 0, checked = 0, ai = 0;
    for (const i of items) {
      if (i.agoMin > WIN) continue;
      if (i.path) docs.add(i.path);
      if (i.who) authors.add(i.who);
      if (i.type === 'create') created += 1;
      if (i.type === 'check' && /^checked/i.test(i.subject || '')) checked += 1;
      if (i.ai) ai += 1;
    }
    return { docs: docs.size, created, checked, contributors: authors.size, ai };
  }

  function digestHtml() {
    const d = _digest;
    if (!d) return '';
    const ic = (path, color) =>
      `<svg width="13" height="13" fill="none" stroke="${color}" stroke-width="1.9" viewBox="0 0 24 24" style="flex-shrink:0"><path stroke-linecap="round" stroke-linejoin="round" d="${path}"/></svg>`;
    const pill = (icon, n, label) =>
      `<span class="act-legend-chip">${icon}<span class="text-ink-100 font-semibold">${n}</span> ${label}</span>`;
    const parts = [];
    if (d.docs) parts.push(pill(ic('M9 12h6m-6 4h6m2 4H7a2 2 0 01-2-2V5a2 2 0 012-2h7l5 5v11a2 2 0 01-2 2z', '#5e6066'), d.docs, t('digestDocs', d.docs)));
    if (d.created) parts.push(pill(ic('M12 4v16m8-8H4', TY('create').color), d.created, t('digestCreated', d.created)));
    if (d.checked) parts.push(pill(ic('M5 13l4 4L19 7', TY('check').color), d.checked, t('digestChecked', d.checked)));
    if (d.contributors) parts.push(pill(ic('M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-1.13a4 4 0 10-4-4 4 4 0 004 4z', '#5e6066'), d.contributors, t('digestContributors', d.contributors)));
    if (d.ai) parts.push(pill(ic('M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9l4.2-1.4z', '#e8941c'), d.ai, t('digestViaAi', d.ai)));
    if (!parts.length) return '';
    const hr = '<hr style="border:none;border-top:1px solid #2a2a32;margin:0">';
    return (
      `<div style="position:relative;margin-bottom:12px">
        ${hr}
        <div style="display:flex;flex-wrap:wrap;justify-content:center;gap:6px;margin:10px 0 9px">${parts.join('')}</div>
        ${hr}
        <span class="act-digest-when text-ink-500" style="position:absolute;right:0;bottom:5px;font-size:10px;text-transform:uppercase;letter-spacing:.06em;pointer-events:none">${t('digestWeek')}</span>
      </div>`
    );
  }

  // 13c — Santé : obsolescence (déterministe serveur) + candidats de contradiction (pré-filtre
  // serveur ; l'IA juge via MCP). Les clics sur un doc rouvrent son historique.
  async function loadHealth(h) {
    let stale = [], cands = [];
    try {
      const [rs, rc] = await Promise.all([
        fetch('/api/stale?months=6&limit=40'),
        fetch('/api/contradictions?limit=50'),
      ]);
      if (rs.ok) stale = (await rs.json()).stale || [];
      if (rc.ok) cands = (await rc.json()).candidates || [];
    } catch (_) {}
    _health = { stale, cands };
    h.innerHTML = healthHtml();
  }

  function healthHtml() {
    const tab = (active, v, label) =>
      `<button type="button" data-htab="${v}" class="px-3 py-1.5 text-xs font-medium transition ${active ? 'text-accent' : 'text-ink-400 hover:text-ink-200'}" style="border-bottom:2px solid ${active ? '#1d9bd1' : 'transparent'};margin-bottom:-1px">${label}</button>`;
    const toggle =
      `<div class="flex mb-3" style="border-bottom:1px solid #2a2a32">`
      + tab(_healthTab === 'stale', 'stale', t('healthTabStale'))
      + tab(_healthTab === 'cont', 'cont', t('healthTabCont'))
      + `</div>`;
    // Keep the sub-toggle stable; only the body swaps skeleton → content on fetch.
    const body = !_health ? skelRows(3) : (_healthTab === 'stale' ? staleHtml() : contHtml());
    return toggle + body;
  }

  function staleHtml() {
    const stale = _health.stale;
    if (!stale.length) return `<div class="text-ink-500 text-sm py-1">${t('healthNoStale')}</div>`;
    const shown = _healthExpanded ? stale : stale.slice(0, 8);
    let out = shown.map((s) =>
      `<div class="act-row" data-path="${esc(s.path)}" data-tip="${esc(t('healthOpenHist'))}"><div class="flex items-center justify-between gap-3">`
      + `<div class="min-w-0"><div class="text-sm text-ink-200 truncate">${esc(docTitle(s.path))}</div>`
      + `<div class="text-xs text-ink-500 truncate">${esc(s.path)}</div></div>`
      + `<div class="shrink-0 text-xs text-ink-500">${t('healthMonthsAgo', Math.round(s.months_ago))}</div></div></div>`).join('');
    if (stale.length > 8) {
      out += `<div class="text-right mt-1"><a class="act-hsee text-sm text-accent hover:underline cursor-pointer">${_healthExpanded ? t('actCollapse') : t('actSeeAllN', stale.length)}</a></div>`;
    }
    return out;
  }

  function contHtml() {
    const cands = _health.cands;
    if (!cands.length) return `<div class="text-ink-500 text-sm py-1">${t('healthNoCand')}</div>`;
    const shown = _candExpanded ? cands : cands.slice(0, 8);
    let out = `<div class="text-xs text-ink-500 mb-2">${t('healthAskAi')}</div>`;
    out += shown.map((c) => {
      // Detector rows carry the conflicting values + their lines; cluster rows show the first
      // "à vérifier" evidence line if any, else the shared subject.
      const meta = c.kind === 'cluster'
        ? esc((c.evidence && c.evidence.length && c.evidence[0].text) || c.subject || '')
        : t('healthValueConflict', esc(c.subject || ''), esc(c.a_value || ''), esc(c.b_value || ''));
      const confPill = c.confidence === 'high'
        ? `<span class="shrink-0 text-xs px-1.5 py-0.5 rounded" style="background:#1d3a5b;color:#9ecbff" data-tip="${esc(t('healthConfHighHint'))}">${t('healthConfHigh')}</span>`
        : `<span class="shrink-0 text-xs px-1.5 py-0.5 rounded" style="background:#2a2a32;color:#9a9aa5" data-tip="${esc(t('healthReviewHint'))}">${t('healthReview')}</span>`;
      return `<div class="py-1.5"><div class="flex items-center gap-2 text-sm">`
        + `<div class="flex items-center gap-2 min-w-0 flex-1">`
        + (c.verdict === 'real' ? `<span class="shrink-0 text-xs px-1.5 py-0.5 rounded" style="background:#5b1d1d;color:#ffb4b4">${t('healthReal')}</span>` : confPill)
        + `<span class="text-ink-200 hover:text-accent cursor-pointer truncate" data-path="${esc(c.a)}">${esc(docTitle(c.a))}</span>`
        + `<span class="text-ink-500 shrink-0">⇄</span>`
        + `<span class="text-ink-200 hover:text-accent cursor-pointer truncate" data-path="${esc(c.b)}">${esc(docTitle(c.b))}</span></div>`
        + `<button type="button" class="act-cdismiss shrink-0 inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-lg border subtle-border bg-navy-600 hover:bg-navy-500 text-ink-300 hover:text-ink-100 transition" data-a="${esc(c.a)}" data-b="${esc(c.b)}" data-aline="${c.a_line || ''}" data-bline="${c.b_line || ''}" data-tip="${esc(t('healthDismissHint'))}">✓ ${t('healthDismiss')}</button></div>`
        + (meta ? `<div class="text-xs text-ink-500 mt-0.5 truncate">${meta}</div>` : '') + '</div>';
    }).join('');
    if (cands.length > 8) out += `<div class="text-right mt-1"><a class="act-csee text-sm text-accent hover:underline cursor-pointer">${_candExpanded ? t('actCollapse') : t('actSeeAllN', cands.length)}</a></div>`;
    return out;
  }

  function skelRow() {
    return '<div class="flex items-center gap-3 py-2">'
      + '<div class="act-skel" style="width:30px;height:30px;border-radius:8px"></div>'
      + '<div class="flex-1"><div class="act-skel" style="width:42%;height:10px"></div>'
      + '<div class="act-skel" style="width:26%;height:8px;margin-top:6px"></div></div>'
      + '<div class="act-skel" style="width:38px;height:8px"></div></div>';
  }
  function skelRows(n) {
    let s = '';
    for (let i = 0; i < n; i++) s += skelRow();
    return s;
  }
  function skeletonHtml() {
    return '<div class="border subtle-border rounded-lg p-4 bg-black/15">'
      + '<div class="flex items-center justify-between mb-4">'
      + '<div class="act-skel" style="width:90px;height:18px"></div>'
      + '<div class="act-skel" style="width:150px;height:26px;border-radius:8px"></div></div>'
      + skelRows(4) + '</div>';
  }

  function cardHtml() {
    return (
      `<div id="home-activity-card" class="border subtle-border rounded-lg p-4 bg-black/15">
        <div class="act-card-head flex items-center justify-between gap-3 mb-3">
          <h2 class="!mb-0 !mt-0">${t('actTitle')}</h2>
          <div class="act-card-controls flex items-center gap-2 shrink-0">
            ${aiFilterHtml()}
            <div class="act-seg-group inline-flex rounded-lg border subtle-border overflow-hidden">
              <button type="button" data-view="journal" class="${segClass(true)}">${t('actJournal')}</button>
              <button type="button" data-view="orrery" class="${segClass(false)}">${t('actConstellation')}</button>
              <button type="button" data-view="health" class="${segClass(false)}">${t('actHealth')}</button>
            </div>
          </div>
        </div>
        ${digestHtml()}
        <div id="activity-journal">${journalHtml()}</div>
        <div id="activity-orrery" class="hidden"></div>
        <div id="activity-health" class="hidden"></div>
      </div>`
    );
  }

  function setView(card, v, persist) {
    const j = card.querySelector('#activity-journal');
    const o = card.querySelector('#activity-orrery');
    const h = card.querySelector('#activity-health');
    if (v === 'orrery') {
      if (!o.dataset.rendered) { o.innerHTML = orreryHtml(); o.dataset.rendered = '1'; wireOrreryHover(o); wireSun(o); }
      // clear leftover one-shot animation classes so re-showing the tab never replays them
      o.querySelectorAll('.act-spin,.act-sun,.act-egg').forEach((el) => el.classList.remove('spinning', 'pop', 'show'));
    } else if (v === 'health' && !h.dataset.rendered) {
      h.dataset.rendered = '1'; h.innerHTML = healthHtml(); loadHealth(h);
    }
    j.classList.toggle('hidden', v !== 'journal');
    o.classList.toggle('hidden', v !== 'orrery');
    h.classList.toggle('hidden', v !== 'health');
    card.querySelectorAll('[data-view]').forEach((b) => { b.className = segClass(b.dataset.view === v); });
    if (persist) { try { localStorage.setItem('atlas:activityView', v); } catch (_) {} }
  }

  function wire(card) {
    let saved = 'journal';
    try { saved = localStorage.getItem('atlas:activityView') || 'journal'; } catch (_) {}
    const q = new URLSearchParams(location.search).get('view');
    if (q === 'journal' || q === 'orrery' || q === 'health') saved = q;
    setView(card, saved, false);
    card.querySelectorAll('[data-view]').forEach((b) =>
      b.addEventListener('click', () => setView(card, b.dataset.view, true)));
    card.addEventListener('click', (ev) => {
      const fbtn = ev.target.closest('[data-ai-filter]');
      if (fbtn) {
        _aiOnly = !_aiOnly;
        _expanded = false;
        fbtn.outerHTML = aiFilterHtml();
        card.querySelector('#activity-journal').innerHTML = journalHtml();
        const o = card.querySelector('#activity-orrery');
        if (o.dataset.rendered) { o.innerHTML = orreryHtml(); wireOrreryHover(o); wireSun(o); }
        return;
      }
      if (ev.target.closest('[data-view]')) return;
      if (ev.target.closest('.act-seeall')) {
        _expanded = !_expanded;
        card.querySelector('#activity-journal').innerHTML = journalHtml();
        return;
      }
      if (ev.target.closest('.act-hsee')) {
        _healthExpanded = !_healthExpanded;
        card.querySelector('#activity-health').innerHTML = healthHtml();
        return;
      }
      if (ev.target.closest('.act-csee')) {
        _candExpanded = !_candExpanded;
        card.querySelector('#activity-health').innerHTML = healthHtml();
        return;
      }
      const ht = ev.target.closest('[data-htab]');
      if (ht) {
        _healthTab = ht.dataset.htab;
        try { localStorage.setItem('atlas:healthTab', _healthTab); } catch (_) {}
        card.querySelector('#activity-health').innerHTML = healthHtml();
        return;
      }
      const cd = ev.target.closest('.act-cdismiss');
      if (cd) {
        // Human verdict "pas une contradiction" (13c) → POST none, drop the row. The global
        // fetch wrapper injects the CSRF token. The pair resurfaces only if a doc is edited.
        const { a, b, aline, bline } = cd.dataset;
        cd.disabled = true;
        // Pass the judged line numbers (value collisions carry them) so the verdict is
        // span-bound (F1): it survives edits ELSEWHERE in either doc, not just any edit.
        const body = { a, b, verdict: 'none' };
        if (aline) body.a_line = Number(aline);
        if (bline) body.b_line = Number(bline);
        fetch('/api/contradiction', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).then((r) => {
          if (r.ok) {
            _health.cands = _health.cands.filter((c) => !((c.a === a && c.b === b) || (c.a === b && c.b === a)));
            card.querySelector('#activity-health').innerHTML = healthHtml();
          } else { cd.disabled = false; }
        }).catch(() => { cd.disabled = false; });
        return;
      }
      const row = ev.target.closest('[data-path]');
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
    // Don't leave the card slot blank while /api/activity fetches: cached card
    // instantly on re-visit, a skeleton on the very first load.
    if (_items && _items.length) { m.innerHTML = cardHtml(); wire(m.querySelector('#home-activity-card')); }
    else if (_items === null) m.innerHTML = skeletonHtml();
    const raw = await load();
    _items = raw ? aggregate(raw) : raw;
    _digest = raw ? computeDigest(raw) : null;
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
    '.act-skel{background:rgba(255,255,255,.06);border-radius:5px}',
    '.activity-seg{cursor:pointer;transition:color .12s,background .12s}',
    '.activity-seg:not(.is-active):hover{color:#d1d2d3}',
    '.act-node{cursor:pointer}',
    '.act-node-inner{transform-box:fill-box;transform-origin:center;transition:transform .12s}',
    '.act-node:hover .act-node-inner,.act-node:focus .act-node-inner{transform:scale(1.22)}',
    '.act-node:focus{outline:none}',
    '.act-pop{position:absolute;transform:translate(-50%,-100%);width:280px;padding:11px 13px;border-radius:14px;pointer-events:none;z-index:20}',
    '.act-pop.hidden{display:none}',
    '.act-legend{display:flex;flex-direction:column;gap:7px;flex-shrink:0;align-self:center}',
    '.act-legend-chip{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border:1px solid rgba(255,255,255,.08);border-radius:999px;background:rgba(255,255,255,.03);font-size:11px;color:#b0b1b5}',
    '.act-sun{transform-box:view-box;transform-origin:360px 265px}',
    '.act-sun-pulse{transform-box:view-box;transform-origin:360px 265px}',
    '.act-spin{transform-box:view-box;transform-origin:360px 265px}',
    '.act-egg{position:absolute;left:50%;top:calc(50% + 52px);transform:translate(-50%,0);font-size:13px;font-weight:600;color:#f3bd6a;opacity:0;pointer-events:none;white-space:nowrap;text-shadow:0 1px 6px rgba(0,0,0,.7)}',
    '@media (prefers-reduced-motion: no-preference){',
    '.act-spin.spinning{animation:act-orbit 1.1s cubic-bezier(.34,.1,.2,1)}',
    '@keyframes act-orbit{to{transform:rotate(360deg)}}',
    '.act-sun.pop{animation:act-sunpop .5s ease}',
    '@keyframes act-sunpop{0%{transform:scale(1)}40%{transform:scale(1.28)}100%{transform:scale(1)}}',
    '.act-sun-pulse{animation:act-pulse 4s ease-in-out infinite}',
    '@keyframes act-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.06)}}',
    '.act-glow{animation:act-glowpulse 4s ease-in-out infinite}',
    '@keyframes act-glowpulse{0%,100%{opacity:.5}50%{opacity:1}}',
    '.act-egg.show{animation:act-egg 1.9s ease forwards}',
    '@keyframes act-egg{0%{opacity:0;transform:translate(-50%,8px)}15%{opacity:1;transform:translate(-50%,0)}72%{opacity:1}100%{opacity:0;transform:translate(-50%,-12px)}}',
    '.act-skel{animation:act-skel 1.3s ease-in-out infinite}',
    '@keyframes act-skel{0%,100%{opacity:.4}50%{opacity:.85}}',
    '}',
    '@media (max-width:767px){',
    '.act-digest-when{display:none}',
    '.act-orrery{flex-direction:column;gap:10px}',
    '.act-legend{flex-direction:row;flex-wrap:wrap;justify-content:center;align-self:stretch}',
    '.act-pop{position:fixed;left:8px;right:8px;bottom:8px;top:auto;width:auto;transform:none;z-index:50}',
    // Header tabs overflow on narrow screens. Flatten the controls wrapper
    // (display:contents) so the title, the AI filter and the segmented control are
    // siblings of one wrapping row: title + "IA seulement" stay on the first line
    // (justify-between), the tabs drop full-width onto the next.
    '.act-card-head{flex-wrap:wrap}',
    '.act-card-controls{display:contents}',
    '.act-seg-group{flex:0 0 100%}',
    '.act-seg-group>button{flex:1 1 0;padding-left:0;padding-right:0;text-align:center}',
    '}',
  ].join('');
  document.head.appendChild(st);
})();
