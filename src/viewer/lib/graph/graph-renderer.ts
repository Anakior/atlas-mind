// Connections-graph render passes: the per-frame canvas draw (scaffold → link arcs → firing synapses
// → node glow → cores → labels) plus the two scaffold variants (organic zone blobs, structured map
// rings). Owns the 2D context off the injected canvas and reads family colors from the injected
// GraphPalette; it never mutates the state, only paints it — the rAF loop and all physics live
// elsewhere (controller + GraphLayout).

import { GraphPalette } from './graph-palette';

export class GraphRenderer {
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly palette: GraphPalette,
  ) {}

  // Organic mode: a translucent radial blob + label per top-level folder, drawn at the centroid/hull
  // of wherever that family's nodes settled.
  private drawOrganicZones(ctx: CanvasRenderingContext2D, st: MindGraphState): void {
    const { cam, nodes } = st;
    const regions: Record<string, MindNode[]> = {};

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
      // Remote region (mental node from another atlas): teal + dashed ring, to detach it from the
      // personal regions.
      const isRemoteRegion = rn.some((n) => n.remote);
      const col = isRemoteRegion ? '#59d0cf' : this.palette.hierColor(name, '');
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

  // Structured "map" mode: a soft labeled container per family, with a thin ring + label per subfolder
  // cluster. Positions come from layoutStructured (fixed, no physics).
  private drawStructuredScaffold(ctx: CanvasRenderingContext2D, st: MindGraphState): void {
    const s = st.cam.scale;
    const SX = (x: number) => x * s + st.cam.ox;
    const SY = (y: number) => y * s + st.cam.oy;

    for (const f of st.families) {
      const x = SX(f.x),
        y = SY(f.y),
        r = f.r * s;

      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      const grad = ctx.createRadialGradient(x, y, r * 0.25, x, y, r);

      grad.addColorStop(0, f.color + '18');
      grad.addColorStop(1, f.color + '05');
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = f.color + '33';
      ctx.stroke();
      ctx.font = '600 ' + Math.max(11, 13 * s) + 'px Manrope, system-ui, sans-serif';
      ctx.fillStyle = f.color + 'ee';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(f.name, x, y - r - 7 * s);
      ctx.textAlign = 'left';
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

  draw(st: MindGraphState): void {
    const ctx = this.canvas.getContext('2d')!;
    const w = this.canvas.clientWidth,
      h = this.canvas.clientHeight;

    ctx.clearRect(0, 0, w, h);
    const { cam, nodes, edges, hover } = st;
    const SX = (n: MindNode) => n.x * cam.scale + cam.ox,
      SY = (n: MindNode) => n.y * cam.scale + cam.oy;
    // Scaffold UNDER the nodes: structured "map" mode → tidy folder boxes + subfolder rings; organic
    // mode → translucent zone blobs per top-level folder.
    if (st.mode === 'structured') {
      this.drawStructuredScaffold(ctx, st);
    } else {
      this.drawOrganicZones(ctx, st);
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
      const px = u * u * ax + 2 * u * tt * e._cx! + tt * tt * bx;
      const py = u * u * ay + 2 * u * tt * e._cy! + tt * tt * by;
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
        ? 1 + 0.12 * Math.sin(now * 0.004 + (n._ph || (n._ph = (Math.abs(n.x) + Math.abs(n.y)) % 6.28)))
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
      // Node labels only on hover / neighborhood / zoom: region names (above) carry the orientation,
      // so labels don't clutter the default view. EXCEPTION: when the tag layer is explicitly toggled
      // on, label every tag so turning it on visibly shows the tags (otherwise they're faint rings).
      const tagAlways = n.kind === 'tag' && st.showTags && st.mode === 'organic';

      if (!(tagAlways || n === hover || n._adj || cam.scale > 1.35)) continue;
      ctx.font = (n.kind === 'tag' ? '600 12px' : '12px') + ' Manrope, system-ui, sans-serif';
      ctx.fillStyle =
        hover && n !== hover && !n._adj ? 'rgba(150,150,160,0.5)' : n.kind === 'tag' ? n.color : '#e5e6e8';
      ctx.fillText(n.name, SX(n) + Math.max(2, n.r * cam.scale) + 4, SY(n));
    }
  }
}
