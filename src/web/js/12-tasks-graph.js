const tasksOverlay = document.getElementById('tasks-overlay');
const tasksList = document.getElementById('tasks-list');
const tasksStats = document.getElementById('tasks-stats');
const tasksShowDone = document.getElementById('tasks-show-done');
let _tasksIndex = [];

async function loadTasksIndex() {
  if (IS_OFFLINE_BUILD) return EMBED_TASKS || [];

  // Let in-flight checkbox PUTs land first, then fetch fresh: the rollup is read
  // live from disk, so fetching mid-write would return the pre-toggle state.
  if (_taskWrites.size) await Promise.allSettled([..._taskWrites]);

  try {
    const res = await fetch('/_tasks-index.json', { cache: 'no-cache' });

    return res.ok ? await res.json() : [];
  } catch (e) {
    return [];
  }
}

async function openTasks() {
  tasksOverlay.classList.remove('hidden');
  showTasksLoading(); // skeleton first → never flash the stale previous list
  _tasksIndex = await loadTasksIndex(); // kept for the "show done" toggle re-render
  renderTasks(_tasksIndex);
}

function closeTasks() {
  tasksOverlay.classList.add('hidden');
}

// Skeleton mirrors renderTasks layout (no jump on swap). Seeded LCG → same skeleton each open.
function renderTasksSkeleton() {
  let state = 0x9e3779b9 >>> 0;
  const next = () => (state = (state * 1664525 + 1013904223) >>> 0);
  const range = (min, max) => min + (next() % (max - min + 1));
  const sections = [];

  for (let s = 0; s < 3; s++) {
    const rows = [];

    for (let r = 0, n = range(2, 4); r < n; r++) {
      rows.push(
        '<div style="display:flex;align-items:flex-start;gap:0.75rem;padding:0.5rem 0.75rem;">' +
          '<span class="skeleton" style="flex-shrink:0;width:19px;height:19px;border-radius:5px;margin-top:3px;"></span>' +
          '<span class="skeleton" style="height:0.95rem;width:' +
          range(45, 90) +
          '%;margin-top:5px;"></span>' +
          '</div>',
      );
    }

    sections.push(
      '<div style="margin-bottom:1.75rem;">' +
        '<div class="skeleton" style="height:0.7rem;width:' +
        range(22, 42) +
        '%;border-radius:4px;margin-bottom:0.6rem;"></div>' +
        rows.join('') +
        '</div>',
    );
  }

  return sections.join('');
}

function showTasksLoading() {
  tasksStats.innerHTML =
    '<span class="skeleton" style="display:inline-block;height:0.7rem;width:9rem;border-radius:4px;vertical-align:middle;"></span>';
  tasksList.innerHTML =
    '<div aria-busy="true" aria-label="' +
    t('tasksLoading') +
    '">' +
    renderTasksSkeleton() +
    '</div>';
}

// Normalize a task line for matching against rendered text: the index stores raw
// markdown, the rendered doc shows plain text. Drop wikilink/link syntax + inline
// marks, lowercase, collapse spaces.
function _normTask(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Scroll the open doc to the checkbox of `task` and flash it. Primary = the Nth
// rendered checkbox (task._docIndex); on rare index/render drift, fall back to
// matching by text, then to a loose text highlight.
function scrollToTaskCheckbox(task) {
  const want = _normTask(task.text);
  const boxes = [...contentEl.querySelectorAll('input[type=checkbox]')];
  const liOf = (b) => b && (b.closest('li') || b.parentElement);
  let li = liOf(boxes[task._docIndex]);

  if (!(li && want && _normTask(li.textContent).includes(want))) {
    li = null;

    if (want) {
      for (const b of boxes) {
        const candidate = liOf(b);

        if (candidate && _normTask(candidate.textContent).includes(want)) {
          li = candidate;
          break;
        }
      }
    }
  }

  if (!li) {
    highlightFirstMatch(contentEl, task.text);

    return;
  }

  li.scrollIntoView({ behavior: 'smooth', block: 'center' });
  li.style.transition = 'background-color 0.4s';
  li.style.backgroundColor = 'rgba(89,208,207,0.18)';
  li.style.borderRadius = '4px';
  setTimeout(() => {
    li.style.backgroundColor = '';
  }, 1600);
}

// Render a task's inline markdown like the rest of the app. Links/images stripped
// to text (the row is itself a button — no nested navigation).
function renderTaskText(s) {
  // On any unexpected error fall back to ESCAPED text (never raw, unsanitized HTML).
  try {
    return DOMPurify.sanitize(marked.parseInline(s), { FORBID_TAGS: ['a', 'img'] });
  } catch (e) {
    return escapeHtml(s);
  }
}

function renderTasks(tasks) {
  // _docIndex = position among its OWN doc's tasks → matches the Nth rendered
  // checkbox, so a click scrolls straight to it regardless of the "show done" filter.
  const perDoc = {};

  for (const tk of tasks) tk._docIndex = perDoc[tk.path] = (perDoc[tk.path] ?? -1) + 1;
  const open = tasks.filter((x) => !x.done).length;

  tasksStats.textContent = t('tasksStats', open, tasks.length);
  const visible = tasksShowDone.checked ? tasks : tasks.filter((x) => !x.done);

  tasksList.innerHTML = '';

  if (!visible.length) {
    const empty = document.createElement('div');

    empty.className = 'text-ink-500 text-sm font-sans';
    empty.textContent = t('tasksEmpty');
    tasksList.appendChild(empty);

    return;
  }

  const byDoc = {};

  for (const task of visible) (byDoc[task.path] = byDoc[task.path] || []).push(task);

  for (const p of Object.keys(byDoc).sort()) {
    const file = fileMap[p];
    const section = document.createElement('div');

    section.style.marginBottom = '1.75rem';
    const head = document.createElement('div');

    head.className = 'text-[11px] uppercase tracking-[0.12em] text-ink-500 font-bold font-mono';
    head.style.marginBottom = '0.6rem';
    head.textContent = p;
    section.appendChild(head);

    for (const task of byDoc[p]) {
      const row = document.createElement('button');

      row.type = 'button';
      row.className =
        'flex items-start gap-3 w-full text-left px-3 py-2 rounded-lg hover:bg-white/5 text-base font-sans';
      const box = document.createElement('span');

      box.className = 'flex-shrink-0';
      box.style.marginTop = '3px';
      box.innerHTML = task.done
        ? '<svg viewBox="0 0 24 24" fill="none" class="text-accent" style="width:19px;height:19px"><rect x="3" y="3" width="18" height="18" rx="5" fill="currentColor"/><path d="M7.4 12.4l3 3 6.2-6.7" fill="none" stroke="#0e0d12" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" class="text-ink-500" style="width:19px;height:19px"><rect x="3" y="3" width="18" height="18" rx="5" stroke="currentColor" stroke-width="2"/></svg>';
      const txt = document.createElement('span');

      txt.className = task.done ? 'text-ink-500' : 'text-ink-100';

      if (task.done) txt.style.textDecoration = 'line-through';
      txt.innerHTML = renderTaskText(task.text);
      row.appendChild(box);
      row.appendChild(txt);
      row.addEventListener('click', async () => {
        closeTasks();

        if (!file) return;
        await showMarkdown(file);
        history.replaceState(null, '', '#' + encodeURIComponent(file.path));
        scrollToTaskCheckbox(task);
      });
      section.appendChild(row);
    }

    tasksList.appendChild(section);
  }
}

document.getElementById('tasks-btn').addEventListener('click', openTasks);
document.getElementById('tasks-close').addEventListener('click', closeTasks);
tasksShowDone.addEventListener('change', () => renderTasks(_tasksIndex));

function resizeGraph() {
  const dpr = window.devicePixelRatio || 1;

  graphCanvas.width = graphCanvas.clientWidth * dpr;
  graphCanvas.height = graphCanvas.clientHeight * dpr;
  graphCanvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
}

function graphSimStep(st) {
  const { nodes, edges } = st;
  const REP = 13000,
    SPRING = 0.02,
    REST = 120,
    CENTER = 0.0034,
    GRAVITY = 0.009;

  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];

    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      let dx = a.x - b.x,
        dy = a.y - b.y,
        d2 = dx * dx + dy * dy || 0.01,
        d = Math.sqrt(d2);
      const f = REP / d2,
        fx = (f * dx) / d,
        fy = (f * dy) / d;

      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }

    // Folder gravity: pull each node toward its subfolder (or folder) anchor so folders
    // settle into distinct spatial zones. GRAVITY < SPRING, so wikilinks still bend the
    // clusters and the layout stays organic. Tags + root docs (no anchor) keep the old
    // weak center pull.
    const anc = (st.subAnchors && st.subAnchors[a.subKey]) || (st.regionAnchors && st.regionAnchors[a.region]);

    if (anc) {
      a.vx += (anc.x - a.x) * GRAVITY;
      a.vy += (anc.y - a.y) * GRAVITY;
    } else {
      a.vx -= a.x * CENTER;
      a.vy -= a.y * CENTER;
    }
  }

  for (const e of edges) {
    const a = e.s,
      b = e.t;
    let dx = b.x - a.x,
      dy = b.y - a.y,
      d = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const f = SPRING * (d - REST),
      fx = (f * dx) / d,
      fy = (f * dy) / d;

    a.vx += fx;
    a.vy += fy;
    b.vx -= fx;
    b.vy -= fy;
  }

  for (const n of nodes) {
    if (n === st.drag) continue;
    n.vx *= 0.86;
    n.vy *= 0.86;
    n.x += Math.max(-25, Math.min(25, n.vx));
    n.y += Math.max(-25, Math.min(25, n.vy));
  }
}

function roundRect(ctx, x, y, w, h, r) {
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    return;
  }

  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Organic mode: a translucent radial blob + label per top-level folder, drawn at the
// centroid/hull of wherever that family's nodes settled.
function drawOrganicZones(ctx, st) {
  const { cam, nodes } = st;
  const regions = {};

  for (const n of nodes) {
    if (n.kind !== 'doc' || !n.region) continue;
    (regions[n.region] = regions[n.region] || []).push(n);
  }

  for (const name in regions) {
    const rn = regions[name];
    let cx = 0,
      cy = 0;

    for (const n of rn) {
      cx += n.x;
      cy += n.y;
    }

    cx /= rn.length;
    cy /= rn.length;
    let rad = 70;

    for (const n of rn) rad = Math.max(rad, Math.hypot(n.x - cx, n.y - cy) + 46);
    const scx = cx * cam.scale + cam.ox,
      scy = cy * cam.scale + cam.oy,
      sr = rad * cam.scale;
    // Remote region (mental node from another atlas): teal + dashed ring, to
    // detach it from the personal regions.
    const isRemoteRegion = rn.some((n) => n.remote);
    const col = isRemoteRegion ? '#59d0cf' : hierColor(name, '');
    const grad = ctx.createRadialGradient(scx, scy, sr * 0.2, scx, scy, sr);

    grad.addColorStop(0, col + (isRemoteRegion ? '3d' : '2b'));
    grad.addColorStop(1, col + '00');
    ctx.beginPath();
    ctx.arc(scx, scy, sr, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    if (isRemoteRegion) {
      ctx.save();
      ctx.setLineDash([6, 5]);
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = col + '99';
      ctx.beginPath();
      ctx.arc(scx, scy, sr, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    ctx.font = '600 13px Manrope, system-ui, sans-serif';
    ctx.fillStyle = col + (isRemoteRegion ? 'ff' : 'dd');
    ctx.textAlign = 'center';
    ctx.fillText(name, scx, scy - sr + 16);
    ctx.textAlign = 'left';
  }
}

// Structured "map" mode: a soft labeled container per family, with a thin ring + label
// per subfolder cluster. Positions come from layoutStructured (fixed, no physics).
function drawStructuredScaffold(ctx, st) {
  const s = st.cam.scale;
  const SX = (x) => x * s + st.cam.ox;
  const SY = (y) => y * s + st.cam.oy;

  for (const f of st.families) {
    const x = SX(f.x),
      y = SY(f.y),
      w = f.w * s,
      h = f.h * s;

    roundRect(ctx, x, y, w, h, 14 * s);
    const grad = ctx.createLinearGradient(x, y, x, y + h);

    grad.addColorStop(0, f.color + '16');
    grad.addColorStop(1, f.color + '06');
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = f.color + '33';
    ctx.stroke();
    ctx.font = '600 ' + Math.max(11, 13 * s) + 'px Manrope, system-ui, sans-serif';
    ctx.fillStyle = f.color + 'ee';
    ctx.textBaseline = 'top';
    ctx.fillText(f.name, x + 12 * s, y + 8 * s);
  }

  ctx.textBaseline = 'middle';

  for (const c of st.clusters) {
    if (!c.sub) continue; // family-direct docs have no separate ring
    const x = SX(c.x),
      y = SY(c.y),
      r = c.r * s;

    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = c.color + '40';
    ctx.stroke();
    ctx.font = '500 ' + Math.max(9, 11 * s) + 'px Manrope, system-ui, sans-serif';
    ctx.fillStyle = c.color + 'cc';
    ctx.textAlign = 'center';
    ctx.fillText(c.sub, x, y - r - 9 * s);
    ctx.textAlign = 'left';
  }
}

function graphDraw(st) {
  const ctx = graphCanvas.getContext('2d');
  const w = graphCanvas.clientWidth,
    h = graphCanvas.clientHeight;

  ctx.clearRect(0, 0, w, h);
  const { cam, nodes, edges, hover } = st;
  const SX = (n) => n.x * cam.scale + cam.ox,
    SY = (n) => n.y * cam.scale + cam.oy;
  // Scaffold UNDER the nodes: structured "map" mode → tidy folder boxes + subfolder
  // rings; organic mode → translucent zone blobs per top-level folder.
  if (st.mode === 'structured') {
    drawStructuredScaffold(ctx, st);
  } else {
    drawOrganicZones(ctx, st);
  }

  // ── Render pass: link arcs + node glow ──
  const now = performance.now();

  // 1) Wikilinks bow into arcs (additive glow); tag links stay faint and straight.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  for (const e of edges) {
    const hot = hover && (e.s === hover || e.t === hover);
    const ax = SX(e.s),
      ay = SY(e.s),
      bx = SX(e.t),
      by = SY(e.t);

    if (e.kind === 'link') {
      const dx = bx - ax,
        dy = by - ay,
        len = Math.hypot(dx, dy) || 1;
      const bow = Math.min(26, len * 0.16);

      e._cx = (ax + bx) / 2 - (dy / len) * bow;
      e._cy = (ay + by) / 2 + (dx / len) * bow;
      ctx.strokeStyle = hot ? 'rgba(196,181,253,0.95)' : 'rgba(150,130,246,0.28)';
      ctx.lineWidth = hot ? 2 : 1.1;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.quadraticCurveTo(e._cx, e._cy, bx, by);
      ctx.stroke();
    } else {
      ctx.strokeStyle = hot ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.05)';
      ctx.lineWidth = hot ? 1.2 : 0.7;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }
  }

  // 2) Firing synapses: a pulse of light travels along each wikilink arc.
  let pi = 0;

  for (const e of edges) {
    if (e.kind !== 'link') continue;
    const ax = SX(e.s),
      ay = SY(e.s),
      bx = SX(e.t),
      by = SY(e.t);
    const tt = (now * 0.00016 + pi++ * 0.1379) % 1,
      u = 1 - tt;
    const px = u * u * ax + 2 * u * tt * e._cx + tt * tt * bx;
    const py = u * u * ay + 2 * u * tt * e._cy + tt * tt * by;
    const env = Math.sin(tt * Math.PI); // fade in/out along the arc
    const gr = 0.9 + env * 1.0;

    ctx.globalAlpha = 0.3 + env * 0.3;
    ctx.beginPath();
    ctx.arc(px, py, gr, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(200,188,250,0.9)';
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  ctx.restore();
  // 3) Radial glow under each doc node; recently-edited ones pulse.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  for (const n of nodes) {
    if (n.kind !== 'doc') continue;
    const dim = hover && n !== hover && !n._adj;

    if (dim) continue;
    const r = Math.max(2, n.r * cam.scale),
      x = SX(n),
      y = SY(n);
    const breath = n.recent
      ? 1 +
        0.12 * Math.sin(now * 0.004 + (n._ph || (n._ph = (Math.abs(n.x) + Math.abs(n.y)) % 6.28)))
      : 1;
    const gr = (r + (n.recent ? 7 : 4)) * 2.1 * breath;
    const g = ctx.createRadialGradient(x, y, 0, x, y, gr);

    g.addColorStop(0, n.color + (n.recent ? '3a' : '30'));
    g.addColorStop(1, n.color + '00');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, gr, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();

  // 4) Neuron cores: solid doc discs, hollow-tinted tags, a ring on media docs.
  for (const n of nodes) {
    const dim = hover && n !== hover && !n._adj;
    const orphan = n.kind === 'doc' && n.deg === 0;
    const r = Math.max(2, n.r * cam.scale),
      x = SX(n),
      y = SY(n);

    // Orphans (no link, no tag) muted when not hovered: disconnected thoughts.
    ctx.globalAlpha = !dim && !hover && orphan ? 0.45 : 1;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = dim ? 'rgba(110,110,130,0.3)' : n.kind === 'tag' ? n.color + '33' : n.color;
    ctx.fill();

    if (n.kind === 'tag') {
      ctx.lineWidth = dim ? 1 : 1.6;
      ctx.strokeStyle = dim ? 'rgba(150,150,160,0.3)' : n.color;
      ctx.stroke();
    } else if (n.doctype && n.doctype !== '.md' && !dim) {
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.72)';
      ctx.stroke();
    }

    if (n === hover) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
  }

  ctx.font = '12px Manrope, system-ui, sans-serif';
  ctx.textBaseline = 'middle';

  for (const n of nodes) {
    // Node labels only on hover / neighborhood / zoom: region names (above)
    // carry the orientation, so labels don't clutter the default view. EXCEPTION:
    // when the tag layer is explicitly toggled on, label every tag so turning it on
    // visibly shows the tags (otherwise they're faint rings lost in the dense zones).
    const tagAlways = n.kind === 'tag' && st.showTags && st.mode === 'organic';

    if (!(tagAlways || n === hover || n._adj || cam.scale > 1.35)) continue;
    ctx.font = (n.kind === 'tag' ? '600 12px' : '12px') + ' Manrope, system-ui, sans-serif';
    ctx.fillStyle =
      hover && n !== hover && !n._adj
        ? 'rgba(150,150,160,0.5)'
        : n.kind === 'tag'
          ? n.color
          : '#e5e6e8';
    ctx.fillText(n.name, SX(n) + Math.max(2, n.r * cam.scale) + 4, SY(n));
  }
}

function graphLoop() {
  const st = graphState;

  if (!st) return;

  // Structured "map" mode has fixed positions → no physics, just draw (hover/zoom/pan
  // and node breathing still animate).
  if (st.mode !== 'structured' && st.ticks < 480) {
    graphSimStep(st);
    st.ticks++;
  }

  graphDraw(st);
  graphRaf = requestAnimationFrame(graphLoop);
}

function graphNodeAt(st, sx, sy) {
  const { cam, nodes } = st;

  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    const dx = sx - (n.x * cam.scale + cam.ox),
      dy = sy - (n.y * cam.scale + cam.oy);
    const r = Math.max(6, n.r * cam.scale + 4);

    if (dx * dx + dy * dy <= r * r) return n;
  }

  return null;
}

graphCanvas.addEventListener('mousedown', (e) => {
  const st = graphState;

  if (!st) return;
  st.drag = graphNodeAt(st, e.offsetX, e.offsetY);
  st.panFrom = { x: e.offsetX, y: e.offsetY, ox: st.cam.ox, oy: st.cam.oy };
  st.moved = false;
});
graphCanvas.addEventListener('mousemove', (e) => {
  const st = graphState;

  if (!st) return;

  if (st.panFrom) {
    st.moved = true;

    if (st.drag) {
      st.drag.x = (e.offsetX - st.cam.ox) / st.cam.scale;
      st.drag.y = (e.offsetY - st.cam.oy) / st.cam.scale;
      st.drag.vx = st.drag.vy = 0;
    } else {
      st.cam.ox = st.panFrom.ox + (e.offsetX - st.panFrom.x);
      st.cam.oy = st.panFrom.oy + (e.offsetY - st.panFrom.y);
    }

    return;
  }

  const n = graphNodeAt(st, e.offsetX, e.offsetY);

  if (n !== st.hover) {
    st.nodes.forEach((x) => (x._adj = false));

    if (n)
      for (const e2 of st.edges) {
        if (e2.s === n) e2.t._adj = true;
        else if (e2.t === n) e2.s._adj = true;
      }

    st.hover = n;
  }

  graphCanvas.style.cursor = n ? 'pointer' : 'grab';

  if (n) {
    graphTooltip.textContent =
      n.kind === 'tag'
        ? n.name + '  ' + t('nDocs', n.docs)
        : n.name + (n.tags.length ? '  ' + n.tags.map((tag) => '#' + tag).join(' ') : '');
    graphTooltip.style.left = e.offsetX + 14 + 'px';
    graphTooltip.style.top = e.offsetY + 12 + 'px';
    graphTooltip.classList.remove('hidden');
  } else graphTooltip.classList.add('hidden');
});
window.addEventListener('mouseup', () => {
  const st = graphState;

  if (!st || !st.panFrom) return;
  const node = st.drag,
    moved = st.moved;

  st.panFrom = null;
  st.drag = null;

  if (node && !moved) {
    if (node.kind === 'tag') {
      closeGraph();
      showTag(node.tag);

      return;
    }

    const f = fileMap[node.path];

    closeGraph();

    if (f) {
      showMarkdown(f);
      history.replaceState(null, '', '#' + encodeURIComponent(f.path));
    }
  }
});
graphCanvas.addEventListener(
  'wheel',
  (e) => {
    const st = graphState;

    if (!st) return;
    e.preventDefault();
    const ns = Math.max(0.2, Math.min(4, st.cam.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));

    st.cam.ox = e.offsetX - (e.offsetX - st.cam.ox) * (ns / st.cam.scale);
    st.cam.oy = e.offsetY - (e.offsetY - st.cam.oy) * (ns / st.cam.scale);
    st.cam.scale = ns;
  },
  { passive: false },
);
document.getElementById('graph-close').addEventListener('click', closeGraph);
document.getElementById('graph-btn').addEventListener('click', openGraph);

// ── View-mode toggle: organic brain ⇄ structured folder map (+ tag-layer toggle) ──
function updateGraphModeUI() {
  const st = graphState;
  const orgBtn = document.getElementById('graph-mode-organic');

  if (!st || !orgBtn) return;
  const strBtn = document.getElementById('graph-mode-structured');
  const tagBtn = document.getElementById('graph-tags-toggle');
  const setActive = (btn, on) => {
    btn.classList.toggle('bg-white/15', on);
    btn.classList.toggle('text-white', on);
    btn.classList.toggle('text-ink-400', !on);
  };

  setActive(orgBtn, st.mode === 'organic');
  setActive(strBtn, st.mode === 'structured');

  if (tagBtn) {
    // Tags only matter in organic mode.
    tagBtn.style.opacity = st.mode === 'organic' ? '1' : '.4';
    tagBtn.style.pointerEvents = st.mode === 'organic' ? 'auto' : 'none';
    setActive(tagBtn, st.mode === 'organic' && st.showTags);
  }
}

function setGraphMode(mode) {
  const st = graphState;

  if (!st || st.mode === mode) return;
  st.mode = mode;
  applyGraphView(st);

  if (mode === 'structured') {
    layoutStructured(st);
  } else {
    reseedOrganic(st);
  }

  st.ticks = 0;
  st.hover = null;
  fitGraphCamera(st);
  updateGraphModeUI();
}

function toggleGraphTags() {
  const st = graphState;

  if (!st || st.mode !== 'organic') return;
  st.showTags = !st.showTags;
  applyGraphView(st);

  // Seed each freshly-shown tag at the centroid of the docs it links, so it appears in
  // place instead of flying in from a random corner. Docs keep their settled positions
  // (no full re-seed → the layout doesn't jump), then a short re-settle integrates the tags.
  if (st.showTags) {
    for (const n of st.nodes) {
      if (n.kind !== 'tag') continue;
      let cx = 0,
        cy = 0,
        k = 0;

      for (const e of st.edges) {
        if (e.kind === 'tag' && e.t === n) {
          cx += e.s.x;
          cy += e.s.y;
          k++;
        }
      }

      if (k) {
        n.x = cx / k + (Math.random() - 0.5) * 30;
        n.y = cy / k + (Math.random() - 0.5) * 30;
      }

      n.vx = 0;
      n.vy = 0;
    }
  }

  st.ticks = Math.min(st.ticks, 360); // a gentle re-settle, not a full upheaval
  updateGraphModeUI();
}

document.getElementById('graph-mode-organic')?.addEventListener('click', () => setGraphMode('organic'));
document.getElementById('graph-mode-structured')?.addEventListener('click', () => setGraphMode('structured'));
document.getElementById('graph-tags-toggle')?.addEventListener('click', toggleGraphTags);
window.addEventListener('resize', () => {
  if (graphState) resizeGraph();
});

// Embed hero: open the graph chrome-less. The host iframe is pointer-events:none,
// so there is nothing to interact with — it just lives.
if (EMBED_MIND) {
  const gc = document.getElementById('graph-controls');

  if (gc) gc.style.display = 'none';
  openGraph();
}

// To-do widget
const isServerMode = location.protocol === 'http:' || location.protocol === 'https:';
const todoWidget = document.getElementById('todo-widget');
const todoHeader = document.getElementById('todo-header');
const todoBody = document.getElementById('todo-body');
const todoChevron = document.getElementById('todo-chevron');
const todoList = document.getElementById('todo-list');
const todoForm = document.getElementById('todo-form');
const todoInput = document.getElementById('todo-input');
const todoCount = document.getElementById('todo-count');
const todoBubbleCount = document.getElementById('todo-bubble-count');
const todoStatus = document.getElementById('todo-status');

let collapsed;

{
  const stored = localStorage.getItem('todo-collapsed');

  collapsed = stored === null ? isMobile() : stored === '1';
}

applyCollapsed();

function applyCollapsed() {
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

todoHeader.addEventListener('click', () => {
  collapsed = !collapsed;
  localStorage.setItem('todo-collapsed', collapsed ? '1' : '0');
  applyCollapsed();
});

function updateHomeTodoStat() {
  const el = document.getElementById('home-todo-stat');

  if (!el) return;
  el.textContent = todos.length ? `${todos.filter((t) => t.done).length}/${todos.length}` : '–';
}

function buildFavicon(count) {
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

function updateTabBadge() {
  const pending = todos.filter((t) => !t.done).length;

  document.title = pending > 0 ? '(' + pending + ') ' + SITE_NAME : SITE_NAME;
  const link = document.querySelector("link[rel='icon']");

  if (link) link.href = buildFavicon(pending);
}

let showDoneTodos = localStorage.getItem('todo-show-done') === '1';
// Todo categories injected at build time from atlas.toml ([todo].categories);
// tabs, labels and filter all derive from them.
const TODO_CATEGORIES = __TODO_CATEGORIES_JSON__;
const TODO_CATS = TODO_CATEGORIES.map((c) => c.cat);
const TODO_FILTER_LABELS = Object.fromEntries(TODO_CATEGORIES.map((c) => [c.cat, c.label]));
// An unknown cat (todo from a category removed from the config) falls back to the
// first configured category (the default), instead of a hard-coded "work".
const tcat = (t) => (TODO_CATS.includes(t.cat) ? t.cat : TODO_CATS[0]);
let todoFilter = localStorage.getItem('todo-filter');

if (!TODO_CATS.includes(todoFilter)) todoFilter = TODO_CATS[0];
(function buildTodoFilterTabs() {
  const wrap = document.getElementById('todo-filter');

  if (!wrap) return;
  wrap.innerHTML = TODO_CATEGORIES.map(
    (c) =>
      `<button type="button" data-cat="${escapeHtml(c.cat)}" class="todo-filter-btn flex-1 px-3 py-2 transition hover:bg-white/5 text-ink-500">${escapeHtml(c.label)}</button>`,
  ).join('');
})();

function renderTodoFilterTabs() {
  document.querySelectorAll('.todo-filter-btn').forEach((btn) => {
    const cat = btn.dataset.cat;
    const active = cat === todoFilter;
    const pending = todos.filter((t) => tcat(t) === cat && !t.done).length;

    btn.classList.toggle('text-accent', active);
    btn.classList.toggle('bg-accent/10', active);
    btn.classList.toggle('text-ink-500', !active);
    btn.textContent =
      pending > 0 ? `${TODO_FILTER_LABELS[cat]} (${pending})` : TODO_FILTER_LABELS[cat];
  });
}

// ── Read-only demo banner ────────────────────────────────────────────────────
// Shown ONLY on the static/offline build (the demo) — the live server has working
// write features, so it never appears there. Dismissible per tab session: a new
// visitor still sees it, but it doesn't nag while browsing.
(function () {
  if (!IS_OFFLINE_BUILD || window.__viewerMode) return;
  // Don't nag inside an embed: the landing page iframes the demo (./demo/#mind) as
  // a live hero, where the banner would be noise. Any iframe → skip it.
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
