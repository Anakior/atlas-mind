const PALETTE_ACTIONS = [
  {
    label: t('actHome'),
    hint: t('actHomeHint'),
    icon: 'home',
    action: () => {
      showWelcome();
      history.replaceState(null, '', location.pathname);
    },
  },
  { label: t('actSidebar'), hint: 'Ctrl+B', icon: 'sidebar', action: toggleSidebar },
  { label: t('actToc'), hint: 'Ctrl+J', icon: 'toc', action: toggleToc },
  {
    label: t('actEdit'),
    hint: 'E',
    icon: 'edit',
    action: () => currentFile && !editMode && enterEditMode(),
  },
  {
    label: t('actDownload'),
    hint: '',
    icon: 'download',
    action: () => currentFile && document.getElementById('btn-download').click(),
  },
  {
    label: t('actSearch'),
    hint: '/',
    icon: 'search',
    action: () => {
      closePalette();
      searchEl.focus();
    },
  },
  {
    label: t('actGraph'),
    hint: 'Ctrl+G',
    icon: 'graph',
    action: () => {
      closePalette();
      openGraph();
    },
  },
  { label: t('actReload'), hint: 'F5', icon: 'reload', action: () => location.reload() },
];

const ICON_PATHS = {
  home: 'M3 12l9-9 9 9M5 10v10a1 1 0 001 1h3v-7h6v7h3a1 1 0 001-1V10',
  sidebar: 'M4 6h16M4 12h7M4 18h16',
  toc: 'M4 6h16M4 12h16M4 18h7',
  edit: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
  download: 'M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4',
  search: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z',
  reload:
    'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15',
  file: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
  graph:
    'M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4',
};

function iconSvg(name) {
  const p = ICON_PATHS[name] || ICON_PATHS.file;

  return (
    '<svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="' +
    p +
    '"/></svg>'
  );
}

function openPalette() {
  paletteBackdrop.classList.remove('hidden');
  paletteInput.value = '';
  renderPaletteResults('');
  setTimeout(() => paletteInput.focus(), 0);
}

function closePalette() {
  paletteBackdrop.classList.add('hidden');
}

function renderPaletteResults(q) {
  const raw = q.trim();

  q = raw.toLowerCase();
  // Instant pass: actions + files matched by name/path.
  const nav = [];

  for (const a of PALETTE_ACTIONS) {
    if (!q || a.label.toLowerCase().includes(q)) nav.push({ kind: 'action', ...a });
  }

  const seen = new Set();

  for (const f of Object.values(fileMap)) {
    if (f.ext !== '.md') continue;

    if (!q || f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)) {
      nav.push({ kind: 'file', label: f.name, hint: f.path, file: f, query: raw });
      seen.add(f.path);
    }
  }

  paletteNav = nav;
  paletteContent = [];
  paintPalette();
  // Async pass: full-text content search via getSearchHits (same engine as the
  // search bar). Debounced; skips files already listed by name/path.
  const seq = ++paletteSearchSeq;

  clearTimeout(paletteSearchDebounce);

  if (q.length >= 2) {
    paletteSearchDebounce = setTimeout(async () => {
      let hits;

      try {
        hits = await getSearchHits(raw);
      } catch (e) {
        return;
      }

      if (seq !== paletteSearchSeq) return; // stale request, we bail out
      const extra = [];

      for (const h of hits) {
        if (seen.has(h.path)) continue;
        const f = fileMap[h.path];

        if (f)
          extra.push({
            kind: 'file',
            label: f.name,
            hint: f.path,
            file: f,
            snippet: h.snippet,
            query: raw,
          });
      }

      paletteContent = extra;
      paintPalette();
    }, 160);
  }
}

function paintPalette() {
  const items = paletteNav.concat(paletteContent);

  paletteItems = items.slice(0, 30);
  paletteIdx = 0;
  paletteCount.textContent =
    items.length > 30 ? t('paletteResultsCapped', items.length) : t('nResults', items.length);
  paletteList.innerHTML = paletteItems
    .map((item, i) => {
      const secondary = item.snippet
        ? '<div class="text-[10px] text-ink-400 truncate">' + escapeHtml(item.snippet) + '</div>'
        : item.hint
          ? '<div class="text-[10px] text-ink-500 truncate font-mono">' +
            escapeHtml(item.hint) +
            '</div>'
          : '';
      const kbd =
        item.kind === 'action' && item.hint
          ? '<kbd class="text-[10px] text-ink-500 bg-black/30 border subtle-border px-1.5 py-0.5 rounded font-mono">' +
            escapeHtml(item.hint) +
            '</kbd>'
          : '';

      return `
    <li data-idx="${i}" class="palette-item flex items-center gap-3 px-4 py-2.5 cursor-pointer ${i === 0 ? 'palette-active' : ''}">
      <span class="text-ink-400">${iconSvg(item.icon || (item.kind === 'file' ? 'file' : 'edit'))}</span>
      <div class="flex-1 min-w-0">
        <div class="text-sm text-ink-100 truncate">${escapeHtml(item.label)}</div>
        ${secondary}
      </div>
      ${kbd}
    </li>`;
    })
    .join('');
  paletteList.querySelectorAll('.palette-item').forEach((el, i) => {
    el.addEventListener('mouseenter', () => {
      paletteIdx = i;
      updatePaletteHighlight();
    });
    el.addEventListener('click', () => selectPaletteItem(i));
  });
}

function updatePaletteHighlight() {
  paletteList.querySelectorAll('.palette-item').forEach((li, i) => {
    li.classList.toggle('palette-active', i === paletteIdx);
  });
  const active = paletteList.querySelector('.palette-active');

  if (active) active.scrollIntoView({ block: 'nearest' });
}

function selectPaletteItem(i) {
  const item = paletteItems[i];

  if (!item) return;
  closePalette();

  if (item.kind === 'action') item.action();
  else if (item.kind === 'file') {
    showMarkdown(item.file, item.query);
    history.replaceState(null, '', '#' + encodeURIComponent(item.file.path));
  }
}

paletteInput.addEventListener('input', (e) => renderPaletteResults(e.target.value));
paletteInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    paletteIdx = Math.min(paletteItems.length - 1, paletteIdx + 1);
    updatePaletteHighlight();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    paletteIdx = Math.max(0, paletteIdx - 1);
    updatePaletteHighlight();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    selectPaletteItem(paletteIdx);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closePalette();
  }
});
paletteBackdrop.addEventListener('click', (e) => {
  if (e.target === paletteBackdrop) closePalette();
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openPalette();

    return;
  }

  if (e.key === 'Escape' && !historyOverlay.classList.contains('hidden')) {
    closeHistory();

    return;
  }

  if (e.key === 'Escape' && !tasksOverlay.classList.contains('hidden')) {
    closeTasks();

    return;
  }

  if (e.key === 'Escape' && !graphOverlay.classList.contains('hidden')) {
    closeGraph();

    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') {
    e.preventDefault();
    openGraph();

    return;
  }

  if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    if (e.key === 'Escape' && document.activeElement === searchEl) {
      searchEl.value = '';
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
});

// ─── Pinned favorites ────────────────────────────────────────────────────────────
const pinnedSection = document.getElementById('pinned-section');
const pinnedList = document.getElementById('pinned-list');
const btnPin = document.getElementById('btn-pin');
const btnPinIcon = document.getElementById('btn-pin-icon');
let pins = [];

try {
  pins = (JSON.parse(localStorage.getItem('kb-pins') || '[]') || []).filter((p) => fileMap[p]);
} catch (e) {
  pins = [];
}

function savePins() {
  try {
    localStorage.setItem('kb-pins', JSON.stringify(pins));
  } catch (e) {}
}

function isPinned(path) {
  return pins.includes(path);
}

function togglePin(path) {
  if (!path) return;
  const i = pins.indexOf(path);

  if (i >= 0) pins.splice(i, 1);
  else pins.unshift(path);
  savePins();
  renderPinned();

  if (currentFile) updatePinButton(currentFile);
}

function updatePinButton(file) {
  if (!file || file.ext !== '.md') {
    btnPin.classList.add('hidden');

    return;
  }

  btnPin.classList.remove('hidden');
  const on = isPinned(file.path);

  btnPinIcon.setAttribute('fill', on ? 'currentColor' : 'none');
  btnPin.classList.toggle('text-amber-300', on);
  btnPin.title = on ? t('unpin') : t('pin');
}

function renderPinned() {
  const items = pins.map((p) => fileMap[p]).filter(Boolean);

  if (!items.length) {
    pinnedSection.classList.add('hidden');
    pinnedList.innerHTML = '';

    return;
  }

  pinnedSection.classList.remove('hidden');
  pinnedList.innerHTML = items
    .map(
      (f) => `
    <li class="overflow-hidden group flex items-center">
      <a class="tree-item flex-1 min-w-0 flex items-center px-2 py-1 rounded cursor-pointer" data-pinpath="${escapeHtml(f.path)}">
        <span class="block text-xs text-ink-200 truncate w-full">${escapeHtml(f.name)}</span>
      </a>
      <button class="px-1.5 text-ink-600 hover:text-rose-300 opacity-0 group-hover:opacity-100 transition-opacity" data-unpin="${escapeHtml(f.path)}" title="${escapeHtml(t('unpin'))}">&times;</button>
    </li>`,
    )
    .join('');
  pinnedList.querySelectorAll('[data-pinpath]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const f = fileMap[a.dataset.pinpath];

      if (f) {
        showMarkdown(f);
        history.replaceState(null, '', '#' + encodeURIComponent(f.path));
      }
    }),
  );
  pinnedList.querySelectorAll('[data-unpin]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePin(b.dataset.unpin);
    }),
  );
}

btnPin.addEventListener('click', () => {
  if (currentFile) togglePin(currentFile.path);
});
renderPinned();

// Embed mode (#mind): the landing page iframes this viewer for a chrome-less
// live Mind hero. We only build the base view here; the graph is opened (controls
// hidden) once it is fully wired, below.
const EMBED_MIND = location.hash.replace(/^#/, '') === 'mind';

if (EMBED_MIND) {
  showWelcome();
} else {
  routeFromHash();
}

// ─── Connections graph view ────────────────────────────────────────────────────
const graphOverlay = document.getElementById('graph-overlay');
const graphCanvas = document.getElementById('graph-canvas');
const graphTooltip = document.getElementById('graph-tooltip');
const graphStats = document.getElementById('graph-stats');
const GRAPH_COLORS = [
  '#5db5e8',
  '#fbc678',
  '#a78bfa',
  '#34d399',
  '#f472b6',
  '#f87171',
  '#22d3ee',
  '#facc15',
  '#c084fc',
  '#4ade80',
];
let graphState = null,
  graphRaf = null;

function tagColor(tag) {
  if (!tag) return '#6b7280';
  let h = 0;

  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;

  return GRAPH_COLORS[h % GRAPH_COLORS.length];
}

// Hierarchical folder color: a top-level folder maps to a stable family HUE (golden-angle
// spread, populated once in openGraph so families never collide), and the immediate
// subfolder under it varies LIGHTNESS/SATURATION within that hue. So a dominant family
// (e.g. wizishop) stays one recognizable hue while its subfolders read as distinct tints.
let _familyHue = {};

// HSL→#rrggbb. MUST return the 6-hex form: every consumer appends an alpha byte
// (n.color + '30', col + '2b', …), so an hsl() string would corrupt every gradient stop.
function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (k) => {
    const x = (k + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(x - 3, 9 - x, 1));
    return Math.round(255 * c)
      .toString(16)
      .padStart(2, '0');
  };
  return '#' + f(0) + f(8) + f(4);
}

function hierColor(family, sub) {
  if (!family) return '#6b7280'; // root-level docs: neutral (matches the old tagColor(''))
  let fh = 0;
  for (let i = 0; i < family.length; i++) fh = (fh * 31 + family.charCodeAt(i)) >>> 0;
  const baseHue = family in _familyHue ? _familyHue[family] : fh % 360;
  if (!sub) return hslToHex(baseHue, 68, 55); // family anchor color (blobs + sub-less docs)
  // Spread subfolders on a 3D hue/sat/light grid — a single axis crowds for a family with
  // ~8 subfolders. The hue jitter stays small (±16°, well within the gap between family
  // hues) so the family is still recognizable. Mid-band lightness keeps cores legible and
  // the additive bloom from washing to white.
  let h = 0;
  for (let i = 0; i < sub.length; i++) h = (h * 31 + sub.charCodeAt(i)) >>> 0;
  const hue = (baseHue + ((h % 5) - 2) * 8 + 360) % 360; // ±16° within the family band
  const light = 46 + (Math.floor(h / 5) % 5) * 5; // 46,51,56,61,66
  const sat = 60 + (Math.floor(h / 25) % 3) * 9; // 60,69,78
  return hslToHex(hue, sat, light);
}

// ── Mind view modes: "organic" (force-directed brain) ⇄ "structured" (folder map) ──

// Which nodes/edges are active for the current mode. Organic shows the folder-zoned
// force graph with TAGS HIDDEN by default — tags carry ~3× the edges of real wikilinks
// and drown the structure. The hero (EMBED_MIND) keeps its full tag web for the landing.
function applyGraphView(st) {
  const tags = st.mode === 'organic' && (st.showTags || EMBED_MIND);

  st.nodes = tags ? st.allNodes : st.allNodes.filter((n) => n.kind !== 'tag');
  st.edges = st.allEdges.filter((e) => e.kind === 'link' || (tags && e.kind === 'tag'));
  st.hover = null;
}

// Re-seed organic positions near each node's folder anchor (used when switching back
// from the structured map so the force layout relaxes from an already-zoned start).
function reseedOrganic(st) {
  for (const n of st.nodes) {
    const anc = (st.subAnchors && st.subAnchors[n.subKey]) || (st.regionAnchors && st.regionAnchors[n.region]);

    n.x = anc ? anc.x + (Math.random() - 0.5) * 70 : (Math.random() - 0.5) * 520;
    n.y = anc ? anc.y + (Math.random() - 0.5) * 70 : (Math.random() - 0.5) * 520;
    n.vx = 0;
    n.vy = 0;
  }
}

// Fit the camera to the whole layout. Organic fits the anchor ring (nodes spread as the
// sim relaxes); structured fits the fixed packed bbox. The hero keeps its own framing.
function fitGraphCamera(st) {
  st.cam.ox = graphCanvas.clientWidth / 2;
  st.cam.oy = graphCanvas.clientHeight / 2;

  if (EMBED_MIND) return;
  let half;

  if (st.mode === 'structured') {
    half = 60;
    for (const n of st.nodes) half = Math.max(half, Math.abs(n.x) + n.r, Math.abs(n.y) + n.r);
    half += 70;
  } else {
    half = (st.ring || 360) + 220;
  }

  st.cam.scale = Math.min(
    1,
    (Math.min(graphCanvas.clientWidth, graphCanvas.clientHeight) / (2 * half)) * 0.92,
  );
}

// Deterministic "map" layout: docs pack in a phyllotaxis disc per subfolder; subfolder
// discs pack into a family box; family boxes pack across the canvas. No physics → tidy
// and stable, the opposite of the organic hairball. Fills st.clusters + st.families for
// the scaffold drawing, and sets each doc's fixed x/y.
function layoutStructured(st) {
  const docs = st.nodes.filter((n) => n.kind === 'doc');
  const fams = {};

  for (const n of docs) {
    const fam = n.region || '·root';
    const ckey = n.subRegion || '';
    const f = (fams[fam] = fams[fam] || { name: fam, clusters: {} });

    (f.clusters[ckey] = f.clusters[ckey] || { sub: ckey, docs: [] }).docs.push(n);
  }

  const DOC_SP = 15,
    CL_GAP = 22,
    FAM_GAP = 56,
    FAM_PAD = 28,
    LABEL_H = 26;

  // Phyllotaxis pack of a cluster's docs around a local (0,0); sets c.r.
  const packCluster = (c) => {
    let maxR = 0;

    c.docs.forEach((n, i) => {
      const a = i * 2.399963;
      const r = DOC_SP * Math.sqrt(i + 0.6);

      n._lx = Math.cos(a) * r;
      n._ly = Math.sin(a) * r;
      maxR = Math.max(maxR, r + (n.r || 6));
    });
    c.r = Math.max(18, maxR + 8);
  };

  // Row-pack square items {w,h} into maxW; sets it.x/it.y, returns the bounding {w,h}.
  const rowPack = (items, maxW, gap) => {
    let x = 0,
      y = 0,
      rowH = 0,
      totalW = 0;

    for (const it of items) {
      if (x > 0 && x + it.w > maxW) {
        x = 0;
        y += rowH + gap;
        rowH = 0;
      }

      it.x = x;
      it.y = y;
      x += it.w + gap;
      rowH = Math.max(rowH, it.h);
      totalW = Math.max(totalW, x - gap);
    }

    return { w: totalW, h: y + rowH };
  };

  const famList = Object.values(fams);

  for (const f of famList) {
    const cl = Object.values(f.clusters);

    cl.forEach(packCluster);
    cl.sort((a, b) => b.r - a.r);
    f._items = cl.map((c) => ({ c, w: c.r * 2, h: c.r * 2 }));
    const area = f._items.reduce((s, it) => s + it.w * it.h, 0);
    const box = rowPack(f._items, Math.max(f._items[0].w, Math.sqrt(area) * 1.25), CL_GAP);

    f._w = box.w;
    f._h = box.h;
  }

  famList.sort((a, b) => b._w * b._h - a._w * a._h);
  const famItems = famList.map((f) => ({ f, w: f._w + FAM_PAD * 2, h: f._h + FAM_PAD * 2 + LABEL_H }));
  const totalArea = famItems.reduce((s, it) => s + it.w * it.h, 0);
  const total = rowPack(famItems, Math.max(famItems[0].w, Math.sqrt(totalArea) * 1.3), FAM_GAP);

  const cx = total.w / 2,
    cy = total.h / 2;
  const clusters = [],
    families = [];

  for (const fit of famItems) {
    const f = fit.f;
    const fx = fit.x - cx,
      fy = fit.y - cy;

    families.push({ x: fx, y: fy, w: fit.w, h: fit.h, name: f.name, color: hierColor(f.name, '') });

    for (const it of f._items) {
      const ccx = fx + FAM_PAD + it.x + it.c.r;
      const ccy = fy + FAM_PAD + LABEL_H + it.y + it.c.r;

      it.c.docs.forEach((n) => {
        n.x = ccx + n._lx;
        n.y = ccy + n._ly;
        n.vx = 0;
        n.vy = 0;
      });
      clusters.push({ x: ccx, y: ccy, r: it.c.r, sub: it.c.sub, color: hierColor(f.name, it.c.sub) });
    }
  }

  st.clusters = clusters;
  st.families = families;
}

async function openGraph() {
  const idx = await loadBacklinksIndex();

  graphOverlay.classList.remove('hidden');
  const nodes = [],
    byPath = {},
    tagNodes = {};
  // Every previewable doc is a node (not just Markdown), so media docs cluster by region too.
  const GRAPH_EXTS = new Set(['.md', '.html', '.pdf', '.docx']);

  // ── Folder families + subfolders → hierarchical color AND layout anchors ──
  // Built ONCE before the node loop so each node can be colored and SEEDED near its
  // folder's zone. Families sit on a ring (even spacing); each family's subfolders orbit
  // its anchor by sorted index (NOT a hash → no two subfolders re-collide at one spot).
  const famSet = new Set();
  const subByFam = {};

  for (const f of Object.values(fileMap)) {
    if (!GRAPH_EXTS.has(f.ext)) continue;
    const fp = f.path.split('/');
    const isRemoteDoc = f.path.startsWith('remotes/');
    const fam = isRemoteDoc ? '⧫ ' + (fp[1] || 'node') : fp.length > 1 ? fp[0] : '';

    if (!fam) continue; // root-level docs have no family
    famSet.add(fam);

    if (!isRemoteDoc && fp.length > 2) {
      (subByFam[fam] = subByFam[fam] || new Set()).add(fp[1]);
    }
  }

  const families = [...famSet].sort();
  const regionAnchors = {};
  const subAnchors = {};
  const RING = Math.max(260, 78 * families.length); // ring radius grows with family count

  _familyHue = {};
  families.forEach((fam, i) => {
    _familyHue[fam] = (i * 137.5) % 360; // golden-angle hue: maximal family separation
    const a = (i / families.length) * Math.PI * 2; // even placement on the ring
    regionAnchors[fam] = { x: Math.cos(a) * RING, y: Math.sin(a) * RING };
    const subs = subByFam[fam] ? [...subByFam[fam]].sort() : [];
    subs.forEach((sub, k) => {
      const a2 = a + (k / subs.length) * Math.PI * 2; // distribute subs around the family
      subAnchors[fam + '/' + sub] = {
        x: regionAnchors[fam].x + Math.cos(a2) * 130,
        y: regionAnchors[fam].y + Math.sin(a2) * 130,
      };
    });
  });

  for (const f of Object.values(fileMap)) {
    if (!GRAPH_EXTS.has(f.ext)) continue;
    const parts = f.path.split('/');
    // Mirror doc (remotes/<source>/…) → own region per source, diamond-prefixed to
    // avoid colliding with a same-named directory and to signal non-personal content.
    const isRemote = f.path.startsWith('remotes/');
    const region = isRemote ? '⧫ ' + (parts[1] || 'node') : parts.length > 1 ? parts[0] : '';
    // Immediate subfolder (one level under the family) → color tint + a layout sub-anchor.
    const subRegion = !isRemote && parts.length > 2 ? parts[1] : '';
    const subKey = subRegion ? region + '/' + subRegion : '';
    const anchor = subAnchors[subKey] || regionAnchors[region] || null;
    const n = {
      kind: 'doc',
      path: f.path,
      name: f.name.replace(/\.(md|html|pdf|docx)$/i, ''),
      doctype: f.ext,
      tags: f.tags || [],
      region,
      subRegion,
      subKey,
      remote: isRemote,
      mtime: f.mtime || 0,
      recent: false,
      // Seed near the folder's zone so the layout settles already-organized.
      x: anchor ? anchor.x + (Math.random() - 0.5) * 70 : (Math.random() - 0.5) * 520,
      y: anchor ? anchor.y + (Math.random() - 0.5) * 70 : (Math.random() - 0.5) * 520,
      vx: 0,
      vy: 0,
      deg: 0,
    };

    // Remote nodes get AI teal; otherwise color = family hue + subfolder tint.
    n.color = isRemote ? '#59d0cf' : hierColor(region, subRegion);
    nodes.push(n);
    byPath[f.path] = n;
  }

  const edges = [];
  const docCount = nodes.length;
  let linkCount = 0;

  for (const dn of nodes.slice()) {
    for (const tg of dn.tags) {
      let tn = tagNodes[tg];

      if (!tn) {
        tn = {
          kind: 'tag',
          tag: tg,
          name: '#' + tg,
          color: tagColor(tg),
          docs: 0,
          x: (Math.random() - 0.5) * 520,
          y: (Math.random() - 0.5) * 520,
          vx: 0,
          vy: 0,
          deg: 0,
        };
        tagNodes[tg] = tn;
        nodes.push(tn);
      }

      tn.docs++;
      edges.push({ s: dn, t: tn, kind: 'tag' });
      dn.deg++;
      tn.deg++;
    }
  }

  const seen = new Set();

  for (const [p, e] of Object.entries(idx)) {
    for (const q of e.out || []) {
      const key = p < q ? p + '\n' + q : q + '\n' + p;

      if (seen.has(key)) continue;
      seen.add(key);
      const s = byPath[p],
        t = byPath[q];

      if (s && t) {
        edges.push({ s, t, kind: 'link' });
        s.deg++;
        t.deg++;
        linkCount++;
      }
    }
  }

  // Node radius: docs larger than tags, scaled by degree (hubs grow).
  for (const n of nodes)
    n.r = (n.kind === 'tag' ? 3 : 5) + Math.sqrt(n.deg) * (n.kind === 'tag' ? 1.2 : 2.6);
  // Docs edited < 14 days ago → halo at render time ("active thoughts").
  const RECENT_CUTOFF = Date.now() / 1000 - 14 * 86400;

  for (const n of nodes) if (n.kind === 'doc') n.recent = n.mtime > RECENT_CUTOFF;
  graphStats.textContent = t('graphStats', docCount, linkCount, Object.keys(tagNodes).length);
  graphState = {
    allNodes: nodes,
    allEdges: edges,
    nodes,
    edges,
    regionAnchors,
    subAnchors,
    ring: RING,
    mode: 'organic',
    showTags: false, // de-cluttered by default; toggle to bring the tag web back
    clusters: [],
    families: [],
    cam: { scale: 1, ox: 0, oy: 0 },
    ticks: 0,
    hover: null,
    drag: null,
    panFrom: null,
    moved: false,
  };
  applyGraphView(graphState);
  resizeGraph();
  fitGraphCamera(graphState);

  // Embed hero: pre-settle the layout off-screen so it appears already organized
  // (no nodes flying into place on the landing page).
  if (EMBED_MIND) {
    for (let i = 0; i < 480; i++) graphSimStep(graphState);
    graphState.ticks = 480;
  }

  cancelAnimationFrame(graphRaf);
  graphLoop();
  updateGraphModeUI();
}

function closeGraph() {
  graphOverlay.classList.add('hidden');
  cancelAnimationFrame(graphRaf);
  graphRaf = null;
  graphState = null;
  graphTooltip.classList.add('hidden');
}

// ─── Tasks rollup — every - [ ] / - [x] across the mind in one view ───────────
// Reads EMBED_TASKS (offline) or /_tasks-index.json (server). A row click opens
// its doc and scrolls to the task text (highlightFirstMatch), like a search result.
