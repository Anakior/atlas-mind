// Connections-graph geometry + physics: builds the node/edge model from the live file map + the
// backlinks index, runs the force simulation (organic mode), the deterministic phyllotaxis pack
// (structured "map" mode), and fits the camera. DOM-free except fitCamera, which reads the canvas
// size to centre the view. Colors come from the injected GraphPalette (whose familyHue is re-seeded
// here on every buildGraphModel); the controller owns the state object that every method mutates.

import { fileMap } from '../core/tree';
import { EMBED_MIND } from '../core/state';
import { GraphPalette } from './graph-palette';
import type { BacklinkEntry } from '../content/backlinks';

export class GraphLayout {
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly palette: GraphPalette,
  ) {}

  // Build the whole graph model from the live file map + the backlinks index: folder families →
  // hierarchical color + layout anchors, doc/tag nodes, wikilink/tag edges, degree-scaled radii and
  // the "recent" halo flag. Pure (no DOM): returns the fresh state plus the counts for the stats line.
  buildGraphModel(idx: Record<string, BacklinkEntry>): {
    state: MindGraphState;
    docCount: number;
    linkCount: number;
    tagCount: number;
  } {
    const nodes: MindNode[] = [];
    const byPath: Record<string, MindNode> = {};
    const tagNodes: Record<string, MindNode> = {};
    // Every previewable doc is a node (not just Markdown), so media docs cluster by region too.
    const GRAPH_EXTS = new Set(['.md', '.html', '.pdf', '.docx']);

    // ── Folder families + subfolders → hierarchical color AND layout anchors ──
    // Built ONCE before the node loop so each node can be colored and SEEDED near its folder's zone.
    // Families sit on a ring (even spacing); each family's subfolders orbit its anchor by sorted index
    // (NOT a hash → no two subfolders re-collide at one spot).
    const famSet = new Set<string>();
    const subByFam: Record<string, Set<string>> = {};

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
    const regionAnchors: Record<string, { x: number; y: number }> = {};
    const subAnchors: Record<string, { x: number; y: number }> = {};
    const RING = Math.max(260, 78 * families.length); // ring radius grows with family count

    this.palette.familyHue = {};
    families.forEach((fam, i) => {
      this.palette.familyHue[fam] = (i * 137.5) % 360; // golden-angle hue: maximal family separation
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
      // Mirror doc (remotes/<source>/…) → own region per source, diamond-prefixed to avoid colliding
      // with a same-named directory and to signal non-personal content.
      const isRemote = f.path.startsWith('remotes/');
      const region = isRemote ? '⧫ ' + (parts[1] || 'node') : parts.length > 1 ? parts[0] : '';
      // Immediate subfolder (one level under the family) → color tint + a layout sub-anchor.
      const subRegion = !isRemote && parts.length > 2 ? parts[1] : '';
      const subKey = subRegion ? region + '/' + subRegion : '';
      const anchor = subAnchors[subKey] || regionAnchors[region] || null;
      const n: MindNode = {
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
        // Remote nodes get AI teal; otherwise color = family hue + subfolder tint.
        color: isRemote ? '#59d0cf' : this.palette.hierColor(region, subRegion),
        r: 0,
      };

      nodes.push(n);
      byPath[f.path] = n;
    }

    const edges: MindEdge[] = [];
    const docCount = nodes.length;
    let linkCount = 0;

    for (const dn of nodes.slice()) {
      for (const tg of dn.tags!) {
        let tn = tagNodes[tg];

        if (!tn) {
          tn = {
            kind: 'tag',
            tag: tg,
            name: '#' + tg,
            color: this.palette.tagColor(tg),
            docs: 0,
            x: (Math.random() - 0.5) * 520,
            y: (Math.random() - 0.5) * 520,
            vx: 0,
            vy: 0,
            deg: 0,
            r: 0,
          };
          tagNodes[tg] = tn;
          nodes.push(tn);
        }

        tn.docs = (tn.docs ?? 0) + 1;
        edges.push({ s: dn, t: tn, kind: 'tag' });
        dn.deg++;
        tn.deg++;
      }
    }

    const seen = new Set<string>();

    for (const [p, e] of Object.entries(idx)) {
      for (const q of e.out || []) {
        const key = p < q ? p + '\n' + q : q + '\n' + p;

        if (seen.has(key)) continue;
        seen.add(key);
        const src = byPath[p],
          dst = byPath[q];

        if (src && dst) {
          edges.push({ s: src, t: dst, kind: 'link' });
          src.deg++;
          dst.deg++;
          linkCount++;
        }
      }
    }

    // Node radius: docs larger than tags, scaled by degree (hubs grow).
    for (const n of nodes) n.r = (n.kind === 'tag' ? 3 : 5) + Math.sqrt(n.deg) * (n.kind === 'tag' ? 1.2 : 2.6);
    // Docs edited < 14 days ago → halo at render time ("active thoughts").
    const RECENT_CUTOFF = Date.now() / 1000 - 14 * 86400;

    for (const n of nodes) if (n.kind === 'doc') n.recent = n.mtime! > RECENT_CUTOFF;
    const tagCount = Object.keys(tagNodes).length;
    const state: MindGraphState = {
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

    return { state, docCount, linkCount, tagCount };
  }

  // ── Mind view modes: "organic" (force-directed brain) ⇄ "structured" (folder map) ──
  // Which nodes/edges are active for the current mode. Organic shows the folder-zoned force graph with
  // TAGS HIDDEN by default — tags carry ~3× the edges of real wikilinks and drown the structure. The
  // hero (EMBED_MIND) keeps its full tag web for the landing.
  applyView(st: MindGraphState): void {
    const tags = st.mode === 'organic' && (st.showTags || EMBED_MIND);

    st.nodes = tags ? st.allNodes : st.allNodes.filter((n) => n.kind !== 'tag');
    st.edges = st.allEdges.filter((e) => e.kind === 'link' || (tags && e.kind === 'tag'));
    st.hover = null;
  }

  // Re-seed organic positions near each node's folder anchor (used when switching back from the
  // structured map so the force layout relaxes from an already-zoned start).
  reseedOrganic(st: MindGraphState): void {
    for (const n of st.nodes) {
      const anc = (st.subAnchors && st.subAnchors[n.subKey ?? '']) || (st.regionAnchors && st.regionAnchors[n.region ?? '']);

      n.x = anc ? anc.x + (Math.random() - 0.5) * 70 : (Math.random() - 0.5) * 520;
      n.y = anc ? anc.y + (Math.random() - 0.5) * 70 : (Math.random() - 0.5) * 520;
      n.vx = 0;
      n.vy = 0;
    }
  }

  // Fit the camera to the whole layout. Organic fits the anchor ring; structured fits the fixed packed
  // bbox. The hero keeps its own framing.
  fitCamera(st: MindGraphState): void {
    st.cam.ox = this.canvas.clientWidth / 2;
    st.cam.oy = this.canvas.clientHeight / 2;

    if (EMBED_MIND) return;
    let half: number;

    if (st.mode === 'structured') {
      half = 60;
      for (const n of st.nodes) half = Math.max(half, Math.abs(n.x) + n.r, Math.abs(n.y) + n.r);
      half += 70;
    } else {
      half = (st.ring || 360) + 220;
    }

    st.cam.scale = Math.min(1, (Math.min(this.canvas.clientWidth, this.canvas.clientHeight) / (2 * half)) * 0.92);
  }

  // Deterministic "map" layout: docs pack in a phyllotaxis disc per subfolder; subfolder discs pack
  // into a family box; family boxes pack across the canvas. No physics → tidy and stable, the opposite
  // of the organic hairball. Fills st.clusters + st.families for the scaffold, sets each doc's fixed x/y.
  layoutStructured(st: MindGraphState): void {
    interface Cluster {
      sub: string;
      docs: MindNode[];
      r: number;
    }
    interface Item {
      c: Cluster;
      w: number;
      h: number;
      x: number;
      y: number;
      _dx: number;
      _dy: number;
    }
    interface Family {
      name: string;
      clusters: Record<string, Cluster>;
      _items: Item[];
      _r: number;
    }

    const docs = st.nodes.filter((n) => n.kind === 'doc');
    const fams: Record<string, Family> = {};

    for (const n of docs) {
      const fam = n.region || '·root';
      const ckey = n.subRegion || '';
      const f = (fams[fam] = fams[fam] || { name: fam, clusters: {}, _items: [], _r: 0 });

      (f.clusters[ckey] = f.clusters[ckey] || { sub: ckey, docs: [], r: 0 }).docs.push(n);
    }

    const DOC_SP = 15,
      CL_GAP = 22,
      FAM_GAP = 56,
      FAM_PAD = 28;

    // Phyllotaxis pack of a cluster's docs around a local (0,0); sets c.r.
    const packCluster = (c: Cluster) => {
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
    const rowPack = (items: Array<{ w: number; h: number; x: number; y: number }>, maxW: number, gap: number) => {
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

    // Each family becomes a "cell": its subfolder clusters are arranged, then wrapped in ONE enclosing
    // circle (radius = the clusters' extent from their centre + pad) rather than a box — so the map
    // reads as cells, not rectangles.
    for (const f of famList) {
      const cl = Object.values(f.clusters);

      cl.forEach(packCluster);
      cl.sort((a, b) => b.r - a.r);
      f._items = cl.map((c) => ({ c, w: c.r * 2, h: c.r * 2, x: 0, y: 0, _dx: 0, _dy: 0 }));
      const area = f._items.reduce((s, it) => s + it.w * it.h, 0);
      const box = rowPack(f._items, Math.max(f._items[0].w, Math.sqrt(area) * 1.25), CL_GAP);
      // Offsets are measured from the clusters' bounding-box centre; the cell radius is the farthest
      // cluster edge from it.
      const bcx = box.w / 2,
        bcy = box.h / 2;
      let rad = 0;

      for (const it of f._items) {
        it._dx = it.x + it.c.r - bcx;
        it._dy = it.y + it.c.r - bcy;
        rad = Math.max(rad, Math.hypot(it._dx, it._dy) + it.c.r);
      }
      f._r = rad + FAM_PAD;
    }

    // Pack the cells: a square of side 2r per family → the circles tile a grid and never overlap.
    // Largest first keeps it tidy.
    famList.sort((a, b) => b._r - a._r);
    const famItems = famList.map((f) => ({ f, w: f._r * 2, h: f._r * 2, x: 0, y: 0 }));
    const totalArea = famItems.reduce((s, it) => s + it.w * it.h, 0);
    const total = rowPack(famItems, Math.max(famItems[0].w, Math.sqrt(totalArea) * 1.3), FAM_GAP);

    const cx = total.w / 2,
      cy = total.h / 2;
    const clusters: MindGraphState['clusters'] = [];
    const families: MindGraphState['families'] = [];

    for (const fit of famItems) {
      const f = fit.f;
      const fx = fit.x + f._r - cx,
        fy = fit.y + f._r - cy;

      families.push({ x: fx, y: fy, r: f._r, name: f.name, color: this.palette.hierColor(f.name, '') });

      for (const it of f._items) {
        const ccx = fx + it._dx,
          ccy = fy + it._dy;

        it.c.docs.forEach((n) => {
          n.x = ccx + n._lx!;
          n.y = ccy + n._ly!;
          n.vx = 0;
          n.vy = 0;
        });
        clusters.push({ x: ccx, y: ccy, r: it.c.r, sub: it.c.sub, color: this.palette.hierColor(f.name, it.c.sub) });
      }
    }

    st.clusters = clusters;
    st.families = families;
  }

  simStep(st: MindGraphState): void {
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

      // Folder gravity: pull each node toward its subfolder (or folder) anchor so folders settle into
      // distinct spatial zones. GRAVITY < SPRING, so wikilinks still bend the clusters and the layout
      // stays organic. Tags + root docs (no anchor) keep the old weak center pull.
      const anc = (st.subAnchors && st.subAnchors[a.subKey ?? '']) || (st.regionAnchors && st.regionAnchors[a.region ?? '']);

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
}
