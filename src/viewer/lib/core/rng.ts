// Seeded pseudo-random generator (generic, pure, no DOM): a mulberry32 stream whose next() yields a
// value in [0, 1), seeded by an FNV-1a (shift-mixed) hash of an identity string. Holds its own
// evolving state, so a consumer draws a whole deterministic sequence from one instance by pulling
// next() in a fixed order. Lives in core/ and loads before its users in the shared concat scope.

export class Rng {
  readonly seed: number;
  private a: number;

  constructor(identity: string) {
    this.seed = Rng.hash(identity);
    this.a = this.seed;
  }

  // Next value in [0, 1).
  next(): number {
    this.a |= 0;
    this.a = (this.a + 0x6d2b79f5) | 0;
    let t = Math.imul(this.a ^ (this.a >>> 15), 1 | this.a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // FNV-1a (shift-mixed) hash of the identity -> the seed.
  private static hash(str: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }
}
