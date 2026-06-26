// Inbox triage: the home Activity card's "Inbox" tab, as its own module.
//
// Agents pre-triage upstream and drop ready-to-file items into a per-person inbox lane via the MCP;
// you keep / trash / snooze them here. The Activity card (21-activity.js) owns only the tab button,
// the #inbox-badge and the empty #activity-inbox slot, and calls AtlasInbox.{mount,show,hide}.
// CSS lives in styles/10-inbox.css.
//
// Component-based, not a re-render-the-world blob: the focus card and each queue row are stable DOM
// nodes. The poll only appends rows to the list; the focus card is rebuilt only on a real selection
// change (click a row, Keep/Trash/Snooze, Next). This split is the whole reason an open editor or the
// scroll position survives a live update.
(function () {
  if (typeof escapeHtml !== 'function') return;  // viewer core absent (some headless shells)
  const esc = escapeHtml;

  // ---- state ----
  let _inbox = null;       // [{path,title,preview,source,confidence,suggest_dest,neighbors,...}] | []
  let _total = 0;          // baseline queue length, for the "X / Y traités" progress
  let _filter = null;      // Set of enabled source keys (null = all sources on)
  let _session = { kept: 0, trashed: 0, snoozed: 0 };
  let _overrides = {};     // path -> {dest, tags}: your edits, re-applied across any reload
  let _focusPath = null;   // animate the focus card only when it actually changes
  let _leaving = false;    // an action is mid-flight (swipe-out animation guard)
  let _poll = null;        // live-poll interval while the tab is open
  let _box = null;         // the #activity-inbox container (owned after mount)
  let _keyHandler = null;  // document keydown for K/X/S/J (swapped per mount, no leak)

  // ---- icons (Heroicons v2 outline, the viewer's set) ----
  const _ISRC = {
    gmail: { tint: '#5db5e8', d: 'M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75' },
    sentry: { tint: '#e8941c', d: 'M14.857 17.082a23.85 23.85 0 0 0 5.454-1.31A8.97 8.97 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.97 8.97 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.26 24.26 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0' },
    scraper: { tint: '#5fd0a6', d: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0 0a8.95 8.95 0 0 0 0-18m0 18a8.95 8.95 0 0 1 0-18M3 12h18' },
    webhook: { tint: '#b58be8', d: 'M3.75 13.5 14.25 2.25 12 10.5h8.25L9.75 21.75 12 13.5H3.75Z' },
    slack: { tint: '#e85b8b', d: 'M2.25 12.76c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.184-4.183a1.14 1.14 0 0 1 .778-.332 48.3 48.3 0 0 0 5.83-.498c1.585-.233 2.708-1.626 2.708-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.4 48.4 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z' },
    manual: { tint: '#b0b1b5', d: 'm16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.931-8.931Zm0 0L19.5 7.125' },
  };
  const _IDOC = 'M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z';
  const _ILINK = 'M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244';
  const _ICHECK = 'M4.5 12.75l6 6 9-13.5';
  const _ITRASH = 'M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.1 48.1 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.1 48.1 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.96 51.96 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.67 48.67 0 0 0-7.5 0';
  const _ISNOOZE = 'M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5';
  const _IPENCIL = 'm16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.931-8.931Zm0 0L19.5 7.125';
  const _SKEY = { keep: 'kept', trash: 'trashed', snooze: 'snoozed' };
  const _isvg = (d) =>
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="' + d + '"/></svg>';

  // ---- small helpers ----
  // Relative time (own copy; the activity card's is in a separate scope).
  function rel(min) {
    const en = LANG === 'en';
    if (min < 1) return en ? 'just now' : "à l'instant";
    if (min < 60) return Math.round(min) + ' min';
    const h = Math.round(min / 60);
    if (h < 24) return h + ' h';
    const d = Math.round(min / 1440);
    if (d === 1) return en ? 'yesterday' : 'hier';
    return en ? d + 'd ago' : 'il y a ' + d + ' j';
  }
  function srcMeta(src) {
    const s = _ISRC[src];
    return s ? { tint: s.tint, d: s.d } : { tint: '#868a90', d: _IDOC };
  }
  function srcIc(src) {
    const m = srcMeta(src);
    return `<span class="ibx-ic" style="background:${m.tint}22;color:${m.tint}">${_isvg(m.d)}</span>`;
  }
  const tier = (c) => (c >= 0.75 ? 'hi' : c >= 0.4 ? 'md' : 'lo');
  const tierLabel = (c) => (c >= 0.75 ? t('inboxConfHigh') : c >= 0.4 ? t('inboxConfMed') : t('inboxConfLow'));
  const ago = (it) => rel(it.captured_at ? Math.max(0, (Date.now() / 1000 - it.captured_at) / 60) : 0);

  // Destination Keep promotes to: your edited override, else the agent's suggest_dest, else the FOLDER
  // of the top same-subject neighbour. Editable, and the promoted doc inherits the chosen folder's ACL
  // (so filing into a private folder keeps it private).
  function suggestDest(it) {
    if (it._dest != null) return it._dest;
    if (it.suggest_dest) return it.suggest_dest;
    const nb = it.neighbors && it.neighbors[0];
    // The folder of the top neighbour, or '' (root) if it sits at the root: a bare filename is not a
    // destination folder.
    return nb && nb.indexOf('/') >= 0 ? nb.replace(/\/[^/]*$/, '') + '/' : '';
  }
  const tags = (it) => (it._tags != null ? it._tags : (it.suggest_tags || []));
  const storeOverride = (it) => { _overrides[it.path] = { dest: it._dest, tags: it._tags }; };
  // Tags the destination folder auto-derives, so they aren't offered again (the folder IS a tag).
  function folderTags(it) {
    const d = suggestDest(it);
    return d && typeof folderTagsOf === 'function' ? folderTagsOf(d.replace(/\/+$/, '') + '/_.md') : [];
  }
  // Tags as doc-tag chips (the doc view's component), inline in the focus row: folder tags greyed,
  // custom tags removable, a + to add.
  function tagsHtml(it) {
    const fset = new Set(folderTags(it));
    const custom = tags(it).filter((tg) => !fset.has(tg));
    const fchips = [...fset].map((tg) =>
      `<span class="doc-tag doc-tag-folder" title="${esc(t('folderTagTitle'))}">#${esc(tg)}</span>`).join('');
    const cchips = custom.map((tg) =>
      `<span class="doc-tag">#${esc(tg)}<button class="doc-tag-x ibx-rmtag" data-tag="${esc(tg)}" title="${esc(t('removeTag'))}">×</button></span>`).join('');
    return fchips + cchips + `<button type="button" class="doc-tag-add ibx-addtag" title="${esc(t('addTag'))}">+</button>`;
  }
  function queue() {
    if (!_inbox) return [];
    return _filter ? _inbox.filter((i) => _filter.has(i.source)) : _inbox;
  }
  function snoozeDate() {
    const d = new Date();
    d.setDate(d.getDate() + 3);
    return d.toISOString().slice(0, 10);
  }
  const editing = () => !!(_box && _box.querySelector('.ibx-destedit, .ibx-tagedit-input'));
  function updateBadge() {
    const b = document.getElementById('inbox-badge');
    if (b) { const n = queue().length; b.textContent = n; b.classList.toggle('hidden', !n); }
  }

  // ---- component HTML ----
  function focusHtml(it) {
    const en = LANG === 'en';
    const tr = tier(it.confidence);
    const sd = suggestDest(it);
    const nb = it.neighbors && it.neighbors[0];
    const sig = nb
      ? `<div class="ibx-signal"><span class="sic">${_isvg(_ILINK)}</span><div><b>`
        + `${en ? 'Same subject as a filed doc:' : "Même sujet qu'un doc déjà classé :"}</b> `
        + `<span class="doc">${esc(nb)}</span></div></div>` : '';
    const destChip = sd
      ? `<span class="ibx-destchip editable" data-act="editdest">${_isvg(_IDOC)}${esc(sd)}${_isvg(_IPENCIL)}</span>`
      : `<span class="ibx-destchip editable empty" data-act="editdest">${en ? 'choose a folder' : 'choisir un dossier'}${_isvg(_IPENCIL)}</span>`;
    const dest = `<span class="ibx-lbl">${en ? 'file under' : 'classer dans'}</span>${destChip}`;
    const animate = it.path !== _focusPath;  // only a NEW focus pops in
    _focusPath = it.path;
    return `<div class="ibx-focus${animate ? ' ibx-entering' : ''}" id="ibx-focus">`
      + `<div class="ibx-frow"><span class="ibx-src">${srcIc(it.source)}${esc(it.source)}</span>`
      + `<span class="ibx-pill ${tr}" title="${Math.round(it.confidence * 100)}%">${tierLabel(it.confidence)}</span>`
      + `<span class="ibx-spacer"></span><span class="ibx-ago">${ago(it)}</span></div>`
      + `<div class="ibx-title">${esc(it.title)}</div>`
      + (it.preview ? `<p class="ibx-body">${esc(it.preview)}</p>` : '')
      + sig
      + `<div class="ibx-dest">${dest}<span class="ibx-lbl">tags</span>`
      + `<span class="ibx-tags">${tagsHtml(it)}</span></div>`
      + `<div class="ibx-actions">`
      + `<button type="button" class="ibx-btn keep${sd ? '' : ' disabled'}" data-act="keep"${sd ? '' : ' disabled title="' + (en ? 'pick a folder first' : "choisis d'abord un dossier") + '"'}>${_isvg(_ICHECK)}${t('inboxKeep')} <span class="k">K</span></button>`
      + `<button type="button" class="ibx-btn trash" data-act="trash">${_isvg(_ITRASH)}${t('inboxTrash')} <span class="k">X</span></button>`
      + `<button type="button" class="ibx-btn snooze" data-act="snooze">${_isvg(_ISNOOZE)}${t('inboxSnooze')} <span class="k">S</span></button>`
      + `<span class="ibx-spacer"></span><button type="button" class="ibx-btn ghost" data-act="next">${en ? 'Next' : 'Suivant'} <span class="k">J</span></button>`
      + `</div></div>`;
  }
  function qRowHtml(it) {
    return `<div class="ibx-qrow" data-ipath="${esc(it.path)}">${srcIc(it.source)}`
      + `<span class="ibx-qt">${esc(it.title)}</span>`
      + `<span class="ibx-mini ${tier(it.confidence)}" title="${tierLabel(it.confidence)}"></span>`
      + `<span class="ibx-qa">${ago(it)}</span></div>`;
  }
  function chipsHtml() {
    const srcs = [];
    _inbox.forEach((i) => { if (srcs.indexOf(i.source) < 0) srcs.push(i.source); });
    let c = '<div class="ibx-chips">';
    srcs.forEach((s) => {
      const on = !_filter || _filter.has(s);
      const m = srcMeta(s);
      c += `<button type="button" class="ibx-chip ${on ? 'on' : ''}" data-src="${esc(s)}">`
        + `<span class="g" style="color:${m.tint}">${_isvg(m.d)}</span>${esc(s)}</button>`;
    });
    return c + '</div>';
  }
  function subInner() {
    const en = LANG === 'en';
    const done = Math.max(0, _total - _inbox.length);
    const pct = _total ? Math.round(done / _total * 100) : 0;
    return `<div class="ibx-progress"><b id="ibx-done">${done}</b> / <span id="ibx-total">${_total}</span> ${en ? 'done' : 'traités'}`
      + `<span class="track"><span class="fill" id="ibx-fill" style="width:${pct}%"></span></span></div>`
      + `<div id="ibx-chips-wrap">${chipsHtml()}</div>`;
  }
  function zeroHtml() {
    const en = LANG === 'en';
    const s = _session;
    const total = s.kept + s.trashed + s.snoozed;
    const dp = (d, n, l, col) => `<span class="ibx-dpill"><span style="color:${col}">${_isvg(d)}</span><b>${n}</b> ${l}</span>`;
    return `<div class="ibx-zero"><div class="ibx-mark">${_isvg(_ICHECK)}</div>`
      + `<h3>${en ? 'Inbox zero' : 'Inbox zéro'}</h3>`
      + `<p>${en ? 'Your agents do the research for you. You just kept what matters.'
                 : "Tes agents font les recherches à ta place. Tu viens de garder l'essentiel."}</p>`
      + (total ? `<div class="ibx-digest">`
        + dp(_ICHECK, s.kept, en ? 'kept → graph' : 'gardés → graphe', '#5fd0a6')
        + dp(_ITRASH, s.trashed, en ? 'trashed' : 'jetés', '#868a90')
        + dp(_ISNOOZE, s.snoozed, en ? 'snoozed' : 'snoozés', '#e8941c')
        + `</div>` : '')
      + `</div>`;
  }
  function skelHtml() {
    let s = '';
    for (let i = 0; i < 3; i++) {
      s += '<div class="ibx-skelrow"><div class="ibx-skel" style="width:30px;height:30px;border-radius:8px"></div>'
        + '<div style="flex:1"><div class="ibx-skel" style="width:42%;height:10px"></div>'
        + '<div class="ibx-skel" style="width:26%;height:8px;margin-top:6px"></div></div></div>';
    }
    return s;
  }

  // ---- DOM ops: the focus card and the list are separate, independently-updated nodes ----
  function renderShell() {
    if (!_box) return;
    if (!_inbox) { _box.innerHTML = skelHtml(); return; }
    const q = queue();
    if (!q.length) { _box.innerHTML = zeroHtml(); updateBadge(); return; }
    _box.innerHTML =
      `<div class="ibx-sub" id="ibx-sub">${subInner()}</div>`
      + focusHtml(q[0])
      + `<div id="ibx-next"><div class="ibx-next-h" id="ibx-next-h"></div><div id="ibx-next-rows"></div></div>`;
    renderList();
    updateBadge();
  }
  // Selection changed: rebuild the focus card + the list. Never called by the poll.
  function renderFocusAndList() {
    if (!_box) return;
    const q = queue();
    if (!q.length || !_box.querySelector('#ibx-sub')) { renderShell(); return; }  // -> zero, or was zero
    const fc = _box.querySelector('#ibx-focus');
    if (!fc) { renderShell(); return; }
    fc.outerHTML = focusHtml(q[0]);
    renderList();
    updateProgress();
    renderChips();
    updateBadge();
  }
  // The focus card alone (a dest/tag edit changes only it, not the list).
  function renderFocus() {
    if (!_box) return;
    const q = queue();
    if (!q.length || !_box.querySelector('#ibx-sub')) { renderShell(); return; }
    const fc = _box.querySelector('#ibx-focus');
    if (fc) fc.outerHTML = focusHtml(q[0]); else renderShell();
  }
  function renderList() {
    const rows = _box && _box.querySelector('#ibx-next-rows');
    if (!rows) return;
    const up = queue().slice(1);
    rows.innerHTML = up.map(qRowHtml).join('');
    setNextHeader(up.length);
  }
  function setNextHeader(n) {
    const h = _box && _box.querySelector('#ibx-next-h');
    if (!h) return;
    const en = LANG === 'en';
    h.textContent = n > 0 ? (en ? 'Up next · ' : 'À suivre · ') + n : '';
    h.style.display = n > 0 ? '' : 'none';
  }
  // The poll's ONLY structural change: append one new queue row. Surgical: leaves the focus card and
  // every existing row untouched.
  function addRow(it) {
    const rows = _box && _box.querySelector('#ibx-next-rows');
    if (!rows) return;
    if (_filter && !_filter.has(it.source)) return;  // filtered out: counted, not shown
    rows.insertAdjacentHTML('beforeend', qRowHtml(it));
    setNextHeader(rows.children.length);
  }
  function updateProgress() {
    if (!_box) return;
    const done = Math.max(0, _total - _inbox.length);
    const d = _box.querySelector('#ibx-done'); if (d) d.textContent = done;
    const tt = _box.querySelector('#ibx-total'); if (tt) tt.textContent = _total;
    const f = _box.querySelector('#ibx-fill'); if (f) f.style.width = (_total ? Math.round(done / _total * 100) : 0) + '%';
  }
  function renderChips() {
    const w = _box && _box.querySelector('#ibx-chips-wrap');
    if (w) w.innerHTML = chipsHtml();
  }
  function toast(n) {
    if (!_box) return;
    const en = LANG === 'en';
    let el = _box.querySelector('#ibx-toast');
    if (!el) { el = document.createElement('div'); el.id = 'ibx-toast'; el.className = 'ibx-toast'; _box.appendChild(el); }
    el.textContent = n === 1 ? (en ? '1 new item' : '1 nouveau') : `${n} ${en ? 'new items' : 'nouveaux'}`;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 3200);
  }

  // ---- data + live poll ----
  async function load(force) {
    // A re-mount (e.g. an SSE soft-reload after a Keep enters the corpus) must NOT re-fetch and
    // re-sort: that would yank the focus card away to the highest-confidence item. Reuse the loaded
    // state (order, focus, edits); the poll brings new items into the list.
    if (_inbox && !force) { renderShell(); return; }
    let inbox = [];
    try {
      const r = await fetch('/api/inbox?limit=200');
      if (r.ok) inbox = (await r.json()).inbox || [];
    } catch (_) {}
    inbox.forEach((it) => {
      const o = _overrides[it.path];
      if (o) { if (o.dest != null) it._dest = o.dest; if (o.tags != null) it._tags = o.tags; }
    });
    _inbox = inbox;
    _total = inbox.length;
    _session = { kept: 0, trashed: 0, snoozed: 0 };
    _filter = null;
    renderShell();
  }
  // Detect new items and grow ONLY the list; the focus card is never re-rendered here, so an open
  // editor or the scroll position is never disturbed.
  function poll() {
    if (!_box || _box.classList.contains('hidden') || !_inbox) return;
    fetch('/api/inbox?limit=200').then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (!d) return;
      const have = new Set(_inbox.map((i) => i.path));
      const fresh = (d.inbox || []).filter((i) => !have.has(i.path));
      if (!fresh.length) return;
      fresh.forEach((it) => {
        const o = _overrides[it.path];
        if (o) { if (o.dest != null) it._dest = o.dest; if (o.tags != null) it._tags = o.tags; }
      });
      _inbox = _inbox.concat(fresh);  // to the BACK: the focus item never moves
      _total += fresh.length;
      if (!_box.querySelector('#ibx-focus')) { renderShell(); return; }  // was empty/zero -> first card
      // UP NEXT is BELOW the focus card, so appending rows never shifts it. The progress bar + chips
      // are ABOVE it: refreshing them mid-edit would slide the input and detach the combobox popup, so
      // while an edit is open they are left alone and recomputed on commit (editEnd).
      fresh.forEach(addRow);
      updateBadge();  // in the card header, never shifts the inbox body
      if (!editing()) {
        updateProgress();
        renderChips();
        toast(fresh.length);
      }
    }).catch(() => {});
  }
  function startPoll() { stopPoll(); poll(); _poll = setInterval(poll, 5000); }
  function stopPoll() { if (_poll) { clearInterval(_poll); _poll = null; } }

  // ---- actions ----
  function act(kind) {
    const q = queue();
    if (!q.length || _leaving) return;
    const it = q[0];
    if (kind === 'next') {  // rotate the focus item to the back of the queue
      _inbox = _inbox.filter((x) => x.path !== it.path).concat([it]);
      renderFocusAndList();
      return;
    }
    if (kind === 'keep' && !suggestDest(it)) return;  // no destination -> Keep is inert
    const body = { action: kind, path: it.path };
    if (kind === 'keep') {
      body.dest = suggestDest(it);
      const fset = new Set(folderTags(it));  // folder auto-tags at build; don't write them twice
      body.tags = tags(it).filter((tg) => !fset.has(tg));
    }
    if (kind === 'snooze') body.until = snoozeDate();
    _leaving = true;
    const fc = _box.querySelector('#ibx-focus');
    if (fc) fc.classList.add('ibx-leaving');
    fetch('/api/inbox/action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => {
      // Hold _leaving up for the WHOLE swipe-out: the next item is already at queue()[0] but not yet
      // rendered, so releasing the guard now would let a second K/X/S act on it blind (Keep = file a
      // doc unseen). Release only after the card has actually rendered.
      if (r.ok) {
        _inbox = _inbox.filter((x) => x.path !== it.path);  // optimistic drop
        delete _overrides[it.path];
        if (_SKEY[kind]) _session[_SKEY[kind]]++;
        setTimeout(() => { renderFocusAndList(); _leaving = false; }, fc ? 180 : 0);
      } else { _leaving = false; if (fc) fc.classList.remove('ibx-leaving'); }
    }).catch(() => { _leaving = false; if (fc) fc.classList.remove('ibx-leaving'); });
  }
  function select(path) {
    const it = _inbox.find((x) => x.path === path);
    if (!it) return;
    _inbox = [it].concat(_inbox.filter((x) => x.path !== path));  // promote to the focus slot
    renderFocusAndList();
  }
  function toggleFilter(src) {
    if (!_filter) _filter = new Set(_inbox.map((i) => i.source));
    if (_filter.has(src) && _filter.size > 1) _filter.delete(src); else _filter.add(src);
    renderFocusAndList();
  }

  // After an inline edit ends (commit or cancel): re-render the focus card AND recompute progress +
  // chips, which the poll left stale while the editor was open (it can't touch the area above the
  // input without shifting it).
  function editEnd() { renderFocus(); updateProgress(); renderChips(); }

  // ---- inline editors (folder combobox, tag field) ----
  function openDestEditor() {
    const it = queue()[0];
    const wrap = _box.querySelector('#ibx-focus .ibx-dest');
    if (!it || !wrap) return;
    const en = LANG === 'en';
    wrap.innerHTML = `<span class="ibx-lbl">${en ? 'file under' : 'classer dans'}</span>`
      + `<input class="ibx-destedit" value="${esc(suggestDest(it))}" autocomplete="off" `
      + `placeholder="${en ? 'pick or type a folder' : 'choisis ou tape un dossier'}" />`;
    const inp = wrap.querySelector('input');
    let cb = null;  // the combobox appends a popup to <body> + exposes destroy(): tear it down, or it leaks
    const close = () => { if (cb) { cb.destroy(); cb = null; } editEnd(); };
    const commit = (v) => { it._dest = (v != null ? v : inp.value).trim(); storeOverride(it); close(); };
    if (window.AtlasCombobox && typeof getAllDirs === 'function') {
      cb = AtlasCombobox(inp, { source: getAllDirs, creatable: true, onSelect: (v) => commit(v) });
    }
    inp.focus(); inp.select();
    inp.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } });
    inp.addEventListener('blur', () => setTimeout(() => { if (_box.querySelector('.ibx-destedit')) commit(); }, 180));
  }
  function openTagAdd(addBtn) {
    const it = queue()[0];
    if (!it) return;
    const inp = document.createElement('input');
    inp.className = 'ibx-tagedit-input'; inp.autocomplete = 'off';
    inp.placeholder = LANG === 'en' ? 'new tag' : 'nouveau tag';
    addBtn.replaceWith(inp);
    inp.focus();
    const commit = () => {  // Enter OR clicking away both add the typed tag (like the folder field)
      const tg = inp.value.trim().replace(/^#/, '');
      const cur = tags(it);
      it._tags = tg && cur.indexOf(tg) < 0 ? cur.concat([tg]) : cur.slice();
      storeOverride(it);
      editEnd();
    };
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); editEnd(); }  // only Escape cancels
    });
    inp.addEventListener('blur', () => setTimeout(() => { if (_box.querySelector('.ibx-tagedit-input')) commit(); }, 150));
  }

  // ---- events (delegated, on the owned container + document for the shortcuts) ----
  function onClick(ev) {
    if (ev.target.closest('.ibx-destchip')) { openDestEditor(); return; }
    const rm = ev.target.closest('.ibx-rmtag');
    if (rm) { const it = queue()[0]; if (it) { it._tags = tags(it).filter((x) => x !== rm.dataset.tag); storeOverride(it); editEnd(); } return; }
    const add = ev.target.closest('.ibx-addtag');
    if (add) { openTagAdd(add); return; }
    const ibtn = ev.target.closest('.ibx-btn');
    if (ibtn) { act(ibtn.dataset.act); return; }
    const chip = ev.target.closest('.ibx-chip');
    if (chip) { toggleFilter(chip.dataset.src); return; }
    const qrow = ev.target.closest('.ibx-qrow');
    if (qrow && qrow.dataset.ipath) { select(qrow.dataset.ipath); }
  }
  function onKey(ev) {
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
    if (!_box || _box.classList.contains('hidden') || !queue().length) return;
    const k = ev.key.toLowerCase();
    const a = k === 'k' ? 'keep' : k === 'x' ? 'trash' : k === 's' ? 'snooze'
            : (k === 'j' || ev.key === 'ArrowDown') ? 'next' : null;
    if (!a) return;
    ev.preventDefault();
    act(a);
  }

  // ---- public API (called by the Activity card's setView) ----
  window.AtlasInbox = {
    // Mount into a freshly-rendered #activity-inbox slot. Re-called on every card re-mount with a NEW
    // container, so the click listener is attached fresh; the document keydown is swapped (no leak).
    mount(container) {
      _box = container;
      container.addEventListener('click', onClick);
      if (_keyHandler) document.removeEventListener('keydown', _keyHandler);
      _keyHandler = onKey;
      document.addEventListener('keydown', _keyHandler);
      load(false);
    },
    show() { startPoll(); },   // tab activated
    hide() { stopPoll(); },    // tab left
    // Keep the header count live without opening the tab (the point of the feature: signal staged
    // items). If the tab is on screen the poll owns the badge, so skip (don't refetch and clobber the
    // open queue). Seeds _inbox so a later open is instant. No-op offline (the fetch just fails).
    async refreshBadge() {
      const live = document.querySelector('#activity-inbox');
      if (live && !live.classList.contains('hidden')) return;
      try {
        const r = await fetch('/api/inbox?limit=200');
        if (!r.ok) return;
        const fresh = (await r.json()).inbox || [];
        fresh.forEach((it) => {
          const o = _overrides[it.path];
          if (o) { if (o.dest != null) it._dest = o.dest; if (o.tags != null) it._tags = o.tags; }
        });
        _inbox = fresh; _total = fresh.length;
        updateBadge();
      } catch (_) {}
    },
  };
})();
