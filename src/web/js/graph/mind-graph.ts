// The connections graph view: a <canvas> island showing the force/structured graph of the mind. This
// is the controller — it owns the DOM refs, the live state, the drag/hover/pan + wheel-zoom input, the
// rAF loop and the mode/tag UI. The pure pieces are injected: GraphPalette (colors), GraphLayout (model
// build + physics + camera) and GraphRenderer (the per-frame paint). The loop stays imperative — no
// reconciliation, the 2D context is driven directly inside the canvas island, only typed.
//
// Instantiated once in 12z-graph-boot.ts (built last, after the three pieces are concatenated) so every
// class is in scope when `new MindGraph()` runs its field initializers — class declarations do not hoist.
class MindGraph {
  private overlay = document.getElementById('graph-overlay')!;
  private canvas = document.getElementById('graph-canvas') as HTMLCanvasElement;
  private tooltip = document.getElementById('graph-tooltip')!;
  private stats = document.getElementById('graph-stats')!;

  // The injected pieces. canvas is declared above so the layout/renderer initializers can read it.
  private palette = new GraphPalette();
  private layout = new GraphLayout(this.canvas, this.palette);
  private renderer = new GraphRenderer(this.canvas, this.palette);

  private state: MindGraphState | null = null;
  private raf: number | null = null;

  constructor() {
    this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    window.addEventListener('mouseup', () => this.onMouseUp());
    window.addEventListener('resize', () => {
      if (this.state) this.resize();
    });
    document.getElementById('graph-close')!.addEventListener('click', () => this.close());
    document.getElementById('graph-btn')!.addEventListener('click', () => this.open());
    document.getElementById('graph-mode-organic')?.addEventListener('click', () => this.setMode('organic'));
    document.getElementById('graph-mode-structured')?.addEventListener('click', () => this.setMode('structured'));
    document.getElementById('graph-tags-toggle')?.addEventListener('click', () => this.toggleTags());
  }

  isOpen(): boolean {
    return this.state !== null;
  }

  async open(): Promise<void> {
    const idx = await loadBacklinksIndex();

    this.overlay.classList.remove('hidden');
    const model = this.layout.buildGraphModel(idx);

    this.stats.textContent = t('graphStats', model.docCount, model.linkCount, model.tagCount);
    this.state = model.state;
    this.layout.applyView(this.state);
    this.resize();
    this.layout.fitCamera(this.state);

    // Embed hero: pre-settle the layout off-screen so it appears already organized (no nodes flying
    // into place on the landing page).
    if (EMBED_MIND) {
      for (let i = 0; i < 480; i++) this.layout.simStep(this.state);
      this.state.ticks = 480;
    }

    if (this.raf != null) cancelAnimationFrame(this.raf);
    this.loop();
    this.updateModeUI();
  }

  close(): void {
    this.overlay.classList.add('hidden');
    if (this.raf != null) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.state = null;
    this.tooltip.classList.add('hidden');
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;

    this.canvas.width = this.canvas.clientWidth * dpr;
    this.canvas.height = this.canvas.clientHeight * dpr;
    this.canvas.getContext('2d')!.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private loop(): void {
    const st = this.state;

    if (!st) return;

    // Structured "map" mode has fixed positions → no physics, just draw (hover/zoom/pan and node
    // breathing still animate).
    if (st.mode !== 'structured' && st.ticks < 480) {
      this.layout.simStep(st);
      st.ticks++;
    }

    this.renderer.draw(st);
    this.raf = requestAnimationFrame(() => this.loop());
  }

  private nodeAt(st: MindGraphState, sx: number, sy: number): MindNode | null {
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

  private onMouseDown(e: MouseEvent): void {
    const st = this.state;

    if (!st) return;
    st.drag = this.nodeAt(st, e.offsetX, e.offsetY);
    st.panFrom = { x: e.offsetX, y: e.offsetY, ox: st.cam.ox, oy: st.cam.oy };
    st.moved = false;
  }

  private onMouseMove(e: MouseEvent): void {
    const st = this.state;

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

    const n = this.nodeAt(st, e.offsetX, e.offsetY);

    if (n !== st.hover) {
      st.nodes.forEach((x) => (x._adj = false));

      if (n)
        for (const e2 of st.edges) {
          if (e2.s === n) e2.t._adj = true;
          else if (e2.t === n) e2.s._adj = true;
        }

      st.hover = n;
    }

    this.canvas.style.cursor = n ? 'pointer' : 'grab';

    if (n) {
      this.tooltip.textContent =
        n.kind === 'tag'
          ? n.name + '  ' + t('nDocs', n.docs!)
          : n.name + (n.tags!.length ? '  ' + n.tags!.map((tag) => '#' + tag).join(' ') : '');
      this.tooltip.style.left = e.offsetX + 14 + 'px';
      this.tooltip.style.top = e.offsetY + 12 + 'px';
      this.tooltip.classList.remove('hidden');
    } else this.tooltip.classList.add('hidden');
  }

  private onMouseUp(): void {
    const st = this.state;

    if (!st || !st.panFrom) return;
    const node = st.drag,
      moved = st.moved;

    st.panFrom = null;
    st.drag = null;

    if (node && !moved) {
      if (node.kind === 'tag') {
        this.close();
        showTag(node.tag!);

        return;
      }

      const f = fileMap[node.path!];

      this.close();

      if (f) {
        showMarkdown(f);
        history.replaceState(null, '', '#' + encodeURIComponent(f.path));
      }
    }
  }

  private onWheel(e: WheelEvent): void {
    const st = this.state;

    if (!st) return;
    e.preventDefault();
    const ns = Math.max(0.2, Math.min(4, st.cam.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));

    st.cam.ox = e.offsetX - (e.offsetX - st.cam.ox) * (ns / st.cam.scale);
    st.cam.oy = e.offsetY - (e.offsetY - st.cam.oy) * (ns / st.cam.scale);
    st.cam.scale = ns;
  }

  // ── View-mode toggle: organic brain ⇄ structured folder map (+ tag-layer toggle) ──
  private updateModeUI(): void {
    const st = this.state;
    const orgBtn = document.getElementById('graph-mode-organic');

    if (!st || !orgBtn) return;
    const strBtn = document.getElementById('graph-mode-structured')!;
    const tagBtn = document.getElementById('graph-tags-toggle');
    const setActive = (btn: HTMLElement, on: boolean) => {
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

  private setMode(mode: 'organic' | 'structured'): void {
    const st = this.state;

    if (!st || st.mode === mode) return;
    st.mode = mode;
    this.layout.applyView(st);

    if (mode === 'structured') {
      this.layout.layoutStructured(st);
    } else {
      this.layout.reseedOrganic(st);
    }

    st.ticks = 0;
    st.hover = null;
    this.layout.fitCamera(st);
    this.updateModeUI();
  }

  private toggleTags(): void {
    const st = this.state;

    if (!st || st.mode !== 'organic') return;
    st.showTags = !st.showTags;
    this.layout.applyView(st);

    // Seed each freshly-shown tag at the centroid of the docs it links, so it appears in place instead
    // of flying in from a random corner. Docs keep their settled positions (no full re-seed → the
    // layout doesn't jump), then a short re-settle integrates the tags.
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
    this.updateModeUI();
  }
}
