// Constellation avatar: a deterministic mini star-graph from an identity. The
// identity is built by avatarSeed() = the account name (when set) + its email, so
// the avatar reflects the person's name yet stays unique per account and falls back
// to a pure-email seed when no name is set (it does change on rename — intended).
// Pure (returns an SVG string), no DOM/network/storage, works in the offline build.
(function (root) {
  'use strict';

  // Seed string for an account's avatar: "First Last" (each half trimmed, blanks
  // dropped) concatenated with the email. Empty name -> email only. Compute it the
  // SAME way on every surface (user bar, admin list, profile) or one account would
  // render different avatars.
  function avatarSeed(firstName, lastName, email) {
    var name = [firstName, lastName]
      .map(function (s) { return (s == null ? '' : String(s)).trim(); })
      .filter(Boolean)
      .join(' ');
    return name + (email == null ? '' : String(email));
  }

  // Seeded hash (FNV-1a, shift-mixed) -> the constellation seed.
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  // mulberry32 seeded PRNG -> [0, 1).
  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Gold-forward brand band: the per-identity hue is picked from here, so it stays on-brand.
  const BAND = [
    { h: 35, s: 82, l: 51 },   // deep-gold #e8941c (signature)
    { h: 38, s: 86, l: 65 },   // amber #f2b65a
    { h: 28, s: 80, l: 56 },   // warm orange
    { h: 205, s: 60, l: 56 },  // blue #4aa3d6
    { h: 188, s: 56, l: 60 },  // cyan #5ec8d8
    { h: 258, s: 58, l: 69 },  // nebula-violet #9b7fe0
  ];

  function hsl(c, dl) {
    const l = Math.max(0, Math.min(100, c.l + (dl || 0)));
    return 'hsl(' + c.h + ',' + c.s + '%,' + l + '%)';
  }
  function hsla(c, dl, a) {
    const l = Math.max(0, Math.min(100, c.l + (dl || 0)));
    return 'hsla(' + c.h + ',' + c.s + '%,' + l + '%,' + a + ')';
  }

  function round(n) { return Math.round(n * 100) / 100; }

  const GOLD = '#e8941c';

  function constellationSvg(identity, size) {
    identity = String(identity == null ? '' : identity);
    size = +size || 96;

    const seed = fnv1a(identity);
    const rnd = mulberry32(seed);
    // Suffix every gradient/filter/clip id with the seed so avatars on one page don't collide.
    const uid = 's' + seed.toString(36);

    const pick = rnd();
    const primIdx = pick < 0.5 ? (rnd() * 3) | 0 : (rnd() * BAND.length) | 0;
    const prim = BAND[primIdx];
    const accIdx = (primIdx + 2 + ((rnd() * 3) | 0)) % BAND.length;
    const acc = BAND[accIdx];

    // Backdrop variety (seeded): the nebula glow drifts + spreads, and a second wisp
    // in a third hue is offset over it — so identities differ by their background as
    // much as by their graph, which lets the satellite count stay low without looking
    // samey.
    const nebCx = round(30 + rnd() * 34);
    const nebCy = round(26 + rnd() * 30);
    const nebR = round(66 + rnd() * 22);
    const wispC = BAND[(accIdx + 1 + ((rnd() * 3) | 0)) % BAND.length];
    const wCx = round(18 + rnd() * 64);
    const wCy = round(18 + rnd() * 64);
    const wR = round(36 + rnd() * 26);

    const VB = 100;
    const cx = 50, cy = 50;
    // Small render: drop fine detail + cut blur so the graph stays a crisp silhouette at 24px.
    const small = size <= 36;

    // Hub + orbiting satellites.
    const satN = 3 + ((rnd() * 3) | 0);
    const baseAng = rnd() * Math.PI * 2;
    const ringR = 33;
    const even = rnd() < 0.55;

    const nodes = [];
    nodes.push({ x: cx, y: cy, r: 8.5, hub: true });

    for (let i = 0; i < satN; i++) {
      const t = even ? (i / satN) : (i / satN + (rnd() - 0.5) * 0.16);
      const ang = baseAng + t * Math.PI * 2;
      const rr = ringR * (0.82 + rnd() * 0.36);
      let nx = cx + Math.cos(ang) * rr;
      let ny = cy + Math.sin(ang) * rr;
      const m = 12; // keep nodes off the rim
      nx = Math.max(m, Math.min(VB - m, nx));
      ny = Math.max(m, Math.min(VB - m, ny));
      nodes.push({
        x: nx, y: ny,
        r: 3.0 + rnd() * 2.6,
        hub: false,
        tw: rnd(),
      });
    }

    // Every satellite links to the hub (the spine); a couple of chords add network feel.
    // Structure stays size-independent so the same identity looks the same at any size.
    const edges = [];
    for (let k = 1; k < nodes.length; k++) edges.push([0, k]);
    const chords = 1 + ((rnd() * 2) | 0);
    for (let c2 = 0; c2 < chords; c2++) {
      const ea = 1 + ((rnd() * satN) | 0);
      const eb = 1 + ((rnd() * satN) | 0);
      if (ea !== eb && ea < nodes.length && eb < nodes.length) edges.push([ea, eb]);
    }

    // Faint twinkling field-star dust (negligible at small size, kept for consistency).
    const field = [];
    const nField = 9 + (seed % 7);
    for (let f = 0; f < nField; f++) {
      field.push({
        x: rnd() * VB, y: rnd() * VB,
        r: 0.3 + rnd() * 0.7, tw: rnd(), op: 0.16 + rnd() * 0.3,
      });
    }

    const blur = small ? 1.0 : 1.9;
    let s = '';
    s += '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size +
      '" viewBox="0 0 ' + VB + ' ' + VB + '" role="img" aria-label="avatar">';

    s += '<defs>';
    // Deep radial nebula backdrop (glow drifts + spreads per identity), tinted by the
    // identity hue, plus a second offset wisp in a third hue for backdrop variety.
    s += '<radialGradient id="neb_' + uid + '" cx="' + nebCx + '%" cy="' + nebCy + '%" r="' + nebR + '%">';
    s += '<stop offset="0%" stop-color="' + hsl(prim, -30) + '"/>';
    s += '<stop offset="40%" stop-color="' + hsla(acc, -34, 0.55) + '"/>';
    s += '<stop offset="100%" stop-color="#0b1220"/>';
    s += '</radialGradient>';
    s += '<radialGradient id="wisp_' + uid + '" cx="' + wCx + '%" cy="' + wCy + '%" r="' + wR + '%">';
    s += '<stop offset="0%" stop-color="' + hsla(wispC, -8, 0.5) + '"/>';
    s += '<stop offset="55%" stop-color="' + hsla(wispC, -22, 0.16) + '"/>';
    s += '<stop offset="100%" stop-color="' + hsla(wispC, -22, 0) + '"/>';
    s += '</radialGradient>';

    // Hub: white-hot gold-forward core.
    s += '<radialGradient id="hub_' + uid + '" cx="42%" cy="38%" r="68%">';
    s += '<stop offset="0%" stop-color="#fff7e8"/>';
    s += '<stop offset="32%" stop-color="' + hsl(prim, 18) + '"/>';
    s += '<stop offset="72%" stop-color="' + hsl(prim, -4) + '"/>';
    s += '<stop offset="100%" stop-color="' + hsl(prim, -22) + '"/>';
    s += '</radialGradient>';

    // Hub halo (soft outer bloom).
    s += '<radialGradient id="halo_' + uid + '" cx="50%" cy="50%" r="50%">';
    s += '<stop offset="0%" stop-color="' + hsla(prim, 6, 0.55) + '"/>';
    s += '<stop offset="55%" stop-color="' + hsla(prim, 0, 0.18) + '"/>';
    s += '<stop offset="100%" stop-color="' + hsla(prim, 0, 0) + '"/>';
    s += '</radialGradient>';

    // Edge gradient: gold -> accent luminous link.
    s += '<linearGradient id="edge_' + uid + '" x1="0%" y1="0%" x2="100%" y2="100%">';
    s += '<stop offset="0%" stop-color="' + GOLD + '"/>';
    s += '<stop offset="100%" stop-color="' + hsla(acc, 12, 0.85) + '"/>';
    s += '</linearGradient>';

    // Bloom/glow (reduced at small size).
    s += '<filter id="glow_' + uid + '" x="-60%" y="-60%" width="220%" height="220%">';
    s += '<feGaussianBlur stdDeviation="' + round(blur) + '" result="b"/>';
    s += '<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>';
    s += '</filter>';

    // Rounded-square clip (the avatar frame).
    s += '<clipPath id="clip_' + uid + '"><rect x="0" y="0" width="' + VB + '" height="' + VB + '" rx="24" ry="24"/></clipPath>';
    s += '</defs>';

    s += '<g clip-path="url(#clip_' + uid + ')">';
    s += '<rect x="0" y="0" width="' + VB + '" height="' + VB + '" fill="#0b1220"/>';
    s += '<rect x="0" y="0" width="' + VB + '" height="' + VB + '" fill="url(#neb_' + uid + ')"/>';
    s += '<rect x="0" y="0" width="' + VB + '" height="' + VB + '" fill="url(#wisp_' + uid + ')"/>';

    for (let ff = 0; ff < field.length; ff++) {
      const p = field[ff];
      const cls = p.tw > 0.55 ? ' class="cst-star"' : '';
      const dly = cls ? ' style="animation-delay:' + round(p.tw * 3) + 's"' : '';
      s += '<circle' + cls + dly + ' cx="' + round(p.x) + '" cy="' + round(p.y) +
        '" r="' + round(p.r) + '" fill="#cfe6ff" opacity="' + round(p.op) + '"/>';
    }

    // Faint orbit ring (structure cue, large render only).
    if (!small) {
      s += '<circle cx="' + cx + '" cy="' + cy + '" r="' + round(ringR) +
        '" fill="none" stroke="' + hsla(acc, 8, 0.16) +
        '" stroke-width="0.7" stroke-dasharray="1.6 3.2"/>';
    }

    // The graph (edges + satellites) slowly orbits the fixed hub.
    s += '<g class="cst-orbit">';
    s += '<g filter="url(#glow_' + uid + ')">';
    for (let e = 0; e < edges.length; e++) {
      const n1 = nodes[edges[e][0]], n2 = nodes[edges[e][1]];
      s += '<line x1="' + round(n1.x) + '" y1="' + round(n1.y) +
        '" x2="' + round(n2.x) + '" y2="' + round(n2.y) +
        '" stroke="url(#edge_' + uid + ')" stroke-width="' + (small ? 0.9 : 1.05) +
        '" stroke-linecap="round" opacity="0.9"/>';
    }
    s += '</g>';

    // Satellite nodes (alternating primary/accent, white specular bead).
    s += '<g filter="url(#glow_' + uid + ')">';
    for (let n = 1; n < nodes.length; n++) {
      const nd = nodes[n];
      const col = (n % 2 === 0) ? hsl(acc, 10) : hsl(prim, 14);
      const twinkle = (!small && nd.tw < 0.5) ? ' class="cst-star"' : '';
      const tdly = twinkle ? ' style="animation-delay:' + round(nd.tw * 2.5) + 's"' : '';
      s += '<circle' + twinkle + tdly + ' cx="' + round(nd.x) + '" cy="' + round(nd.y) +
        '" r="' + round(nd.r) + '" fill="' + col + '"/>';
      if (!small) {
        s += '<circle cx="' + round(nd.x - nd.r * 0.32) + '" cy="' + round(nd.y - nd.r * 0.32) +
          '" r="' + round(nd.r * 0.32) + '" fill="#ffffff" opacity="0.6"/>';
      }
    }
    s += '</g>';
    s += '</g>';

    // Hub: halo + gold core + specular (the focal anchor, fixed at center).
    const hub = nodes[0];
    const haloR = hub.r * (small ? 2.0 : 2.4);
    s += '<circle class="cst-pulse" cx="' + cx + '" cy="' + cy + '" r="' + round(haloR) +
      '" fill="url(#halo_' + uid + ')"/>';
    s += '<g filter="url(#glow_' + uid + ')">';
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="' + round(hub.r) +
      '" fill="url(#hub_' + uid + ')" stroke="' + hsla(prim, 26, 0.7) + '" stroke-width="0.6"/>';
    s += '<circle cx="' + round(cx - hub.r * 0.3) + '" cy="' + round(cy - hub.r * 0.34) +
      '" r="' + round(hub.r * 0.34) + '" fill="#ffffff" opacity="0.8"/>';
    s += '</g>';

    s += '</g>'; // end clip

    // Subtle gold rim (rounded square).
    s += '<rect x="0.6" y="0.6" width="' + (VB - 1.2) + '" height="' + (VB - 1.2) +
      '" rx="23.5" ry="23.5" fill="none" stroke="' + hsl(prim, 9) + '" stroke-opacity="0.35" stroke-width="0.8"/>';

    s += '</svg>';
    return s;
  }

  root.constellationSvg = constellationSvg;
  root.avatarSeed = avatarSeed;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { constellationSvg, avatarSeed };
  }
})(typeof window !== 'undefined' ? window : globalThis);
