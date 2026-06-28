// Constellation avatar: a deterministic mini star-graph from an identity. The
// identity is built by Avatar.seed() = the account name (when set) + its email, so
// the avatar reflects the person's name yet stays unique per account and falls back
// to a pure-email seed when no name is set (it does change on rename — intended).
// Pure (returns an SVG string), no DOM/network/storage, works in the offline build.
//
// Seeded-deterministic: the ORDER in which the constructor pulls from its Rng (core/rng.ts,
// loaded earlier in the shared scope) decides a person's avatar, so it is fixed. The render
// methods only turn that drawn state into SVG — no randomness, reorder-proof.

import { Rng } from '../core/rng';

export class Avatar {
  // Gold-forward brand band: the per-identity hue is picked from here, so it stays on-brand.
  private static readonly BAND: Hsl[] = [
    { h: 35, s: 82, l: 51 },   // deep-gold #e8941c (signature)
    { h: 38, s: 86, l: 65 },   // amber #f2b65a
    { h: 28, s: 80, l: 56 },   // warm orange
    { h: 205, s: 60, l: 56 },  // blue #4aa3d6
    { h: 188, s: 56, l: 60 },  // cyan #5ec8d8
    { h: 258, s: 58, l: 69 },  // nebula-violet #9b7fe0
  ];
  private static readonly GOLD = '#e8941c';
  // 100x100 viewBox; the hub sits at its center, satellites on a fixed ring.
  private static readonly VB = 100;
  private static readonly CX = 50;
  private static readonly CY = 50;
  private static readonly RING_R = 33;

  // Seed string for an account's avatar: "First Last" (each half trimmed, blanks dropped)
  // concatenated with the email. Empty name -> email only. Compute it the SAME way on every
  // surface (user bar, admin list, profile) or one account would render different avatars.
  static seed(firstName: string | null | undefined,
              lastName: string | null | undefined,
              email: string | null | undefined): string {
    const name = [firstName, lastName]
      .map((s) => (s == null ? '' : String(s)).trim())
      .filter(Boolean)
      .join(' ');
    return name + (email == null ? '' : String(email));
  }

  private readonly rng: Rng;
  private readonly size: number;
  private readonly small: boolean;
  private readonly uid: string;
  private readonly prim: Hsl;
  private readonly acc: Hsl;
  private readonly back: Backdrop;
  private readonly nodes: GraphNode[];
  private readonly edges: number[][];
  private readonly field: FieldStar[];

  constructor(identity: string, size = 96) {
    this.rng = new Rng(identity);
    this.size = size;
    // Small render: drop fine detail + cut blur so the graph stays a crisp silhouette at 24px.
    this.small = size <= 36;
    // Suffix every gradient/filter/clip id with the seed so avatars on one page don't collide.
    this.uid = 's' + this.rng.seed.toString(36);
    const palette = this.pickPalette();
    this.prim = palette.prim;
    this.acc = palette.acc;
    this.back = this.pickBackdrop(palette.accIdx);
    this.nodes = this.buildNodes();
    this.edges = this.buildEdges(this.nodes);
    this.field = this.buildField();
  }

  render(): string {
    return this.open()
      + this.defs()
      + '<g clip-path="url(#clip_' + this.uid + ')">'
      + this.backdrop()
      + this.stars()
      + this.orbitRing()
      + this.graph()
      + this.core()
      + '</g>'
      + this.rim()
      + '</svg>';
  }

  // ── seeded geometry (pulls this.rng in this exact order — see the file header) ──
  private pickPalette(): Palette {
    const r = this.rng;
    const pick = r.next();
    const primIdx = pick < 0.5 ? (r.next() * 3) | 0 : (r.next() * Avatar.BAND.length) | 0;
    const accIdx = (primIdx + 2 + ((r.next() * 3) | 0)) % Avatar.BAND.length;
    return { prim: Avatar.BAND[primIdx], acc: Avatar.BAND[accIdx], accIdx };
  }

  // Backdrop variety (seeded): the nebula glow drifts + spreads, and a second wisp in a
  // third hue is offset over it — so identities differ by their background as much as by
  // their graph, which lets the satellite count stay low without looking samey.
  private pickBackdrop(accIdx: number): Backdrop {
    const r = this.rng;
    const nebCx = Avatar.round(30 + r.next() * 34);
    const nebCy = Avatar.round(26 + r.next() * 30);
    const nebR = Avatar.round(66 + r.next() * 22);
    const wisp = Avatar.BAND[(accIdx + 1 + ((r.next() * 3) | 0)) % Avatar.BAND.length];
    const wCx = Avatar.round(18 + r.next() * 64);
    const wCy = Avatar.round(18 + r.next() * 64);
    const wR = Avatar.round(36 + r.next() * 26);
    return { nebCx, nebCy, nebR, wisp, wCx, wCy, wR };
  }

  // Hub at the center + orbiting satellites. Structure stays size-independent so the same
  // identity looks the same at any size.
  private buildNodes(): GraphNode[] {
    const r = this.rng;
    const satN = 3 + ((r.next() * 3) | 0);
    const baseAng = r.next() * Math.PI * 2;
    const even = r.next() < 0.55;
    const nodes: GraphNode[] = [{ x: Avatar.CX, y: Avatar.CY, r: 8.5, hub: true }];
    for (let i = 0; i < satN; i++) {
      const t = even ? (i / satN) : (i / satN + (r.next() - 0.5) * 0.16);
      const ang = baseAng + t * Math.PI * 2;
      const rr = Avatar.RING_R * (0.82 + r.next() * 0.36);
      const m = 12; // keep nodes off the rim
      const nx = Math.max(m, Math.min(Avatar.VB - m, Avatar.CX + Math.cos(ang) * rr));
      const ny = Math.max(m, Math.min(Avatar.VB - m, Avatar.CY + Math.sin(ang) * rr));
      nodes.push({ x: nx, y: ny, r: 3.0 + r.next() * 2.6, hub: false, tw: r.next() });
    }
    return nodes;
  }

  // Every satellite links to the hub (the spine); a couple of chords add network feel.
  private buildEdges(nodes: GraphNode[]): number[][] {
    const r = this.rng;
    const satN = nodes.length - 1;
    const edges: number[][] = [];
    for (let k = 1; k < nodes.length; k++) edges.push([0, k]);
    const chords = 1 + ((r.next() * 2) | 0);
    for (let c = 0; c < chords; c++) {
      const ea = 1 + ((r.next() * satN) | 0);
      const eb = 1 + ((r.next() * satN) | 0);
      if (ea !== eb && ea < nodes.length && eb < nodes.length) edges.push([ea, eb]);
    }
    return edges;
  }

  // Faint twinkling field-star dust (negligible at small size, kept for consistency).
  private buildField(): FieldStar[] {
    const r = this.rng;
    const field: FieldStar[] = [];
    const n = 9 + (r.seed % 7);
    for (let f = 0; f < n; f++) {
      field.push({ x: r.next() * Avatar.VB, y: r.next() * Avatar.VB, r: 0.3 + r.next() * 0.7, tw: r.next(), op: 0.16 + r.next() * 0.3 });
    }
    return field;
  }

  // ── pure formatting utilities (stateless, like Math.round) ──
  private static round(n: number): number { return Math.round(n * 100) / 100; }
  private static hsl(c: Hsl, dl?: number): string {
    const l = Math.max(0, Math.min(100, c.l + (dl || 0)));
    return 'hsl(' + c.h + ',' + c.s + '%,' + l + '%)';
  }
  private static hsla(c: Hsl, dl: number, a: number): string {
    const l = Math.max(0, Math.min(100, c.l + (dl || 0)));
    return 'hsla(' + c.h + ',' + c.s + '%,' + l + '%,' + a + ')';
  }

  // ── render layers (z-order) ──
  private open(): string {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + this.size + '" height="' + this.size +
      '" viewBox="0 0 ' + Avatar.VB + ' ' + Avatar.VB + '" role="img" aria-label="avatar">';
  }

  private defs(): string {
    const { prim, acc, uid, back } = this;
    const blur = this.small ? 1.0 : 1.9;
    let s = '<defs>';
    // Deep radial nebula backdrop tinted by the identity hue, plus a second offset wisp.
    s += '<radialGradient id="neb_' + uid + '" cx="' + back.nebCx + '%" cy="' + back.nebCy + '%" r="' + back.nebR + '%">';
    s += '<stop offset="0%" stop-color="' + Avatar.hsl(prim, -30) + '"/>';
    s += '<stop offset="40%" stop-color="' + Avatar.hsla(acc, -34, 0.55) + '"/>';
    s += '<stop offset="100%" stop-color="#0b1220"/>';
    s += '</radialGradient>';
    s += '<radialGradient id="wisp_' + uid + '" cx="' + back.wCx + '%" cy="' + back.wCy + '%" r="' + back.wR + '%">';
    s += '<stop offset="0%" stop-color="' + Avatar.hsla(back.wisp, -8, 0.5) + '"/>';
    s += '<stop offset="55%" stop-color="' + Avatar.hsla(back.wisp, -22, 0.16) + '"/>';
    s += '<stop offset="100%" stop-color="' + Avatar.hsla(back.wisp, -22, 0) + '"/>';
    s += '</radialGradient>';
    // Hub: white-hot gold-forward core.
    s += '<radialGradient id="hub_' + uid + '" cx="42%" cy="38%" r="68%">';
    s += '<stop offset="0%" stop-color="#fff7e8"/>';
    s += '<stop offset="32%" stop-color="' + Avatar.hsl(prim, 18) + '"/>';
    s += '<stop offset="72%" stop-color="' + Avatar.hsl(prim, -4) + '"/>';
    s += '<stop offset="100%" stop-color="' + Avatar.hsl(prim, -22) + '"/>';
    s += '</radialGradient>';
    // Hub halo (soft outer bloom).
    s += '<radialGradient id="halo_' + uid + '" cx="50%" cy="50%" r="50%">';
    s += '<stop offset="0%" stop-color="' + Avatar.hsla(prim, 6, 0.55) + '"/>';
    s += '<stop offset="55%" stop-color="' + Avatar.hsla(prim, 0, 0.18) + '"/>';
    s += '<stop offset="100%" stop-color="' + Avatar.hsla(prim, 0, 0) + '"/>';
    s += '</radialGradient>';
    // Edge gradient: gold -> accent luminous link.
    s += '<linearGradient id="edge_' + uid + '" x1="0%" y1="0%" x2="100%" y2="100%">';
    s += '<stop offset="0%" stop-color="' + Avatar.GOLD + '"/>';
    s += '<stop offset="100%" stop-color="' + Avatar.hsla(acc, 12, 0.85) + '"/>';
    s += '</linearGradient>';
    // Bloom/glow (reduced at small size).
    s += '<filter id="glow_' + uid + '" x="-60%" y="-60%" width="220%" height="220%">';
    s += '<feGaussianBlur stdDeviation="' + Avatar.round(blur) + '" result="b"/>';
    s += '<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>';
    s += '</filter>';
    // Rounded-square clip (the avatar frame).
    s += '<clipPath id="clip_' + uid + '"><rect x="0" y="0" width="' + Avatar.VB + '" height="' + Avatar.VB + '" rx="24" ry="24"/></clipPath>';
    s += '</defs>';
    return s;
  }

  private backdrop(): string {
    const { uid } = this;
    return '<rect x="0" y="0" width="' + Avatar.VB + '" height="' + Avatar.VB + '" fill="#0b1220"/>'
      + '<rect x="0" y="0" width="' + Avatar.VB + '" height="' + Avatar.VB + '" fill="url(#neb_' + uid + ')"/>'
      + '<rect x="0" y="0" width="' + Avatar.VB + '" height="' + Avatar.VB + '" fill="url(#wisp_' + uid + ')"/>';
  }

  private stars(): string {
    let s = '';
    for (let ff = 0; ff < this.field.length; ff++) {
      const p = this.field[ff];
      const cls = p.tw > 0.55 ? ' class="cst-star"' : '';
      const dly = cls ? ' style="animation-delay:' + Avatar.round(p.tw * 3) + 's"' : '';
      s += '<circle' + cls + dly + ' cx="' + Avatar.round(p.x) + '" cy="' + Avatar.round(p.y) +
        '" r="' + Avatar.round(p.r) + '" fill="#cfe6ff" opacity="' + Avatar.round(p.op) + '"/>';
    }
    return s;
  }

  // Faint orbit ring (structure cue, large render only).
  private orbitRing(): string {
    if (this.small) return '';
    return '<circle cx="' + Avatar.CX + '" cy="' + Avatar.CY + '" r="' + Avatar.round(Avatar.RING_R) +
      '" fill="none" stroke="' + Avatar.hsla(this.acc, 8, 0.16) +
      '" stroke-width="0.7" stroke-dasharray="1.6 3.2"/>';
  }

  // The graph (edges + satellites) slowly orbits the fixed hub.
  private graph(): string {
    const { nodes, edges, prim, acc, small, uid } = this;
    let s = '<g class="cst-orbit"><g filter="url(#glow_' + uid + ')">';
    for (let e = 0; e < edges.length; e++) {
      const n1 = nodes[edges[e][0]], n2 = nodes[edges[e][1]];
      s += '<line x1="' + Avatar.round(n1.x) + '" y1="' + Avatar.round(n1.y) +
        '" x2="' + Avatar.round(n2.x) + '" y2="' + Avatar.round(n2.y) +
        '" stroke="url(#edge_' + uid + ')" stroke-width="' + (small ? 0.9 : 1.05) +
        '" stroke-linecap="round" opacity="0.9"/>';
    }
    s += '</g>';
    // Satellite nodes (alternating primary/accent, white specular bead).
    s += '<g filter="url(#glow_' + uid + ')">';
    for (let n = 1; n < nodes.length; n++) {
      const nd = nodes[n];
      const col = (n % 2 === 0) ? Avatar.hsl(acc, 10) : Avatar.hsl(prim, 14);
      const twinkle = (!small && nd.tw! < 0.5) ? ' class="cst-star"' : '';
      const tdly = twinkle ? ' style="animation-delay:' + Avatar.round(nd.tw! * 2.5) + 's"' : '';
      s += '<circle' + twinkle + tdly + ' cx="' + Avatar.round(nd.x) + '" cy="' + Avatar.round(nd.y) +
        '" r="' + Avatar.round(nd.r) + '" fill="' + col + '"/>';
      if (!small) {
        s += '<circle cx="' + Avatar.round(nd.x - nd.r * 0.32) + '" cy="' + Avatar.round(nd.y - nd.r * 0.32) +
          '" r="' + Avatar.round(nd.r * 0.32) + '" fill="#ffffff" opacity="0.6"/>';
      }
    }
    s += '</g></g>';
    return s;
  }

  // Hub: halo + gold core + specular (the focal anchor, fixed at center).
  private core(): string {
    const { prim, small, uid } = this;
    const hub = this.nodes[0];
    const haloR = hub.r * (small ? 2.0 : 2.4);
    let s = '<circle class="cst-pulse" cx="' + Avatar.CX + '" cy="' + Avatar.CY + '" r="' + Avatar.round(haloR) +
      '" fill="url(#halo_' + uid + ')"/>';
    s += '<g filter="url(#glow_' + uid + ')">';
    s += '<circle cx="' + Avatar.CX + '" cy="' + Avatar.CY + '" r="' + Avatar.round(hub.r) +
      '" fill="url(#hub_' + uid + ')" stroke="' + Avatar.hsla(prim, 26, 0.7) + '" stroke-width="0.6"/>';
    s += '<circle cx="' + Avatar.round(Avatar.CX - hub.r * 0.3) + '" cy="' + Avatar.round(Avatar.CY - hub.r * 0.34) +
      '" r="' + Avatar.round(hub.r * 0.34) + '" fill="#ffffff" opacity="0.8"/>';
    s += '</g>';
    return s;
  }

  // Subtle gold rim (rounded square).
  private rim(): string {
    return '<rect x="0.6" y="0.6" width="' + (Avatar.VB - 1.2) + '" height="' + (Avatar.VB - 1.2) +
      '" rx="23.5" ry="23.5" fill="none" stroke="' + Avatar.hsl(this.prim, 9) + '" stroke-opacity="0.35" stroke-width="0.8"/>';
  }
}

// Public bundle API: top-level in the shared concat scope so the consumers (user bar, admin lists,
// profile, activity) read constellationSvg/avatarSeed as bare globals (loaded after this file).
export function constellationSvg(identity: string, size?: number): string {
  return new Avatar(identity, size).render();
}
export const avatarSeed = Avatar.seed;
