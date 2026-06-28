// The two seeded hues (primary + accent) plus the accent's band index (used to derive
// the backdrop wisp hue).
interface Palette {
  prim: Hsl;
  acc: Hsl;
  accIdx: number;
}
