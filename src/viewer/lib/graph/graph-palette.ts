// Connections-graph color math: the categorical tag palette and the hierarchical folder coloring
// (a stable family hue + a per-subfolder tint). DOM-free and self-contained, so it is unit-testable
// in isolation. familyHue is (re)populated by GraphLayout.buildGraphModel on every open(); hierColor
// reads it. Shared by GraphLayout (model build + structured scaffold colors) and GraphRenderer (the
// organic zone blobs), injected into both rather than duplicated.
export class GraphPalette {
  private static readonly GRAPH_COLORS = [
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

  // Hierarchical folder color: a top-level folder maps to a stable family HUE (golden-angle spread,
  // populated once in buildGraphModel so families never collide); the immediate subfolder varies
  // LIGHTNESS/SATURATION within that hue. So a dominant family stays one recognizable hue while its
  // subfolders read as distinct tints.
  familyHue: Record<string, number> = {};

  tagColor(tag: string): string {
    if (!tag) return '#6b7280';
    let h = 0;

    for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;

    return GraphPalette.GRAPH_COLORS[h % GraphPalette.GRAPH_COLORS.length];
  }

  // HSL→#rrggbb. MUST return the 6-hex form: every consumer appends an alpha byte (n.color + '30',
  // col + '2b', …), so an hsl() string would corrupt every gradient stop.
  private hslToHex(h: number, s: number, l: number): string {
    s /= 100;
    l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = (k: number) => {
      const x = (k + h / 30) % 12;
      const c = l - a * Math.max(-1, Math.min(x - 3, 9 - x, 1));

      return Math.round(255 * c)
        .toString(16)
        .padStart(2, '0');
    };

    return '#' + f(0) + f(8) + f(4);
  }

  hierColor(family: string, sub: string): string {
    if (!family) return '#6b7280'; // root-level docs: neutral (matches the old tagColor(''))
    let fh = 0;

    for (let i = 0; i < family.length; i++) fh = (fh * 31 + family.charCodeAt(i)) >>> 0;
    const baseHue = family in this.familyHue ? this.familyHue[family] : fh % 360;

    if (!sub) return this.hslToHex(baseHue, 68, 55); // family anchor color (blobs + sub-less docs)
    // Spread subfolders on a 3D hue/sat/light grid — a single axis crowds for a family with ~8
    // subfolders. The hue jitter stays small (±16°, within the family band) so the family is still
    // recognizable. Mid-band lightness keeps cores legible and the additive bloom from washing to white.
    let h = 0;

    for (let i = 0; i < sub.length; i++) h = (h * 31 + sub.charCodeAt(i)) >>> 0;
    const hue = (baseHue + ((h % 5) - 2) * 8 + 360) % 360; // ±16° within the family band
    const light = 46 + (Math.floor(h / 5) % 5) * 5; // 46,51,56,61,66
    const sat = 60 + (Math.floor(h / 25) % 3) * 9; // 60,69,78

    return this.hslToHex(hue, sat, light);
  }
}
