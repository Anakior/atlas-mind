// QR codec (ISO/IEC 18004, error-correction level L, versions 1-10). The QrCode class is pure: it
// encodes a string to a module matrix, no DOM; its GF(256)/Reed-Solomon helpers are private statics
// (the exp/log tables + gfMul/rsEncode/genPoly), so nothing leaks beside the class. The DOM bridge
// renderQrCanvas (matrix → <canvas>) is exported below; the 2FA enrollment wiring that
// calls it lives in admin/totp/totp-enroll-modal.ts. Public surface: the QrCode class
// (`new QrCode(text).matrix`) + renderQrCanvas.
//
// A wrong >>/<</^/& here yields a structurally valid but UNREADABLE QR with no error
// thrown — tests/test_qr.py locks the matrix byte-for-byte.

type QrCell = 0 | 1 | null;
type QrBitMatrix = (0 | 1)[][];

export class QrCode {
  // ── GF(256) arithmetic over the QR primitive polynomial 0x11d (Reed-Solomon ECC) ──
  // exp = antilog (length 512, doubled so log[a]+log[b] never overflows); log (length 256). Both
  // tables are filled once by the static block below, then read by gfMul/genPoly.
  private static readonly exp: number[] = new Array(512);
  private static readonly log: number[] = new Array(256);

  static {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      QrCode.exp[i] = x;
      QrCode.log[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) QrCode.exp[i] = QrCode.exp[i - 255];
  }

  private static gfMul(a: number, b: number): number {
    return a === 0 || b === 0 ? 0 : QrCode.exp[QrCode.log[a] + QrCode.log[b]];
  }

  // EC codewords for `data`: the remainder of the GF polynomial division by the
  // degree-ecLen generator.
  private static rsEncode(data: number[], ecLen: number): number[] {
    const gen = QrCode.genPoly(ecLen); // length ecLen+1, gen[0] === 1
    const buf = data.concat(new Array(ecLen).fill(0));
    for (let i = 0; i < data.length; i++) {
      const coef = buf[i];
      if (coef === 0) continue;
      for (let j = 1; j < gen.length; j++) buf[i + j] ^= QrCode.gfMul(gen[j], coef);
    }
    return buf.slice(data.length);
  }

  private static genPoly(n: number): number[] {
    let poly = [1];
    for (let i = 0; i < n; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= QrCode.gfMul(poly[j], QrCode.exp[i]);
      }
      poly = next;
    }
    return poly;
  }

  // Exact ISO/IEC 18004 capacity rows (level L). From v6 on the data is split into
  // MULTIPLE RS blocks then interleaved — treating it as one block is unreadable.
  // maxPayloadBytes = dataCodewords − header overhead (mode + counter).
  private static readonly VERSIONS: QrVersionSpec[] = [
    { version: 1, totalCodewords: 26, ecPerBlock: 7, blocks: 1, maxPayloadBytes: 17 },
    { version: 2, totalCodewords: 44, ecPerBlock: 10, blocks: 1, maxPayloadBytes: 32 },
    { version: 3, totalCodewords: 70, ecPerBlock: 15, blocks: 1, maxPayloadBytes: 53 },
    { version: 4, totalCodewords: 100, ecPerBlock: 20, blocks: 1, maxPayloadBytes: 78 },
    { version: 5, totalCodewords: 134, ecPerBlock: 26, blocks: 1, maxPayloadBytes: 106 },
    { version: 6, totalCodewords: 172, ecPerBlock: 18, blocks: 2, maxPayloadBytes: 134 },
    { version: 7, totalCodewords: 196, ecPerBlock: 20, blocks: 2, maxPayloadBytes: 154 },
    { version: 8, totalCodewords: 242, ecPerBlock: 24, blocks: 2, maxPayloadBytes: 192 },
    { version: 9, totalCodewords: 292, ecPerBlock: 30, blocks: 2, maxPayloadBytes: 230 },
    { version: 10, totalCodewords: 346, ecPerBlock: 18, blocks: 4, maxPayloadBytes: 271 },
  ];

  // Alignment-pattern center coordinates per version.
  private static readonly ALIGN: Record<number, number[]> = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  };

  // The encoded module matrix (0/1), or null if the text exceeds v10 capacity.
  readonly matrix: QrBitMatrix | null;

  private size = 0;
  private m: QrCell[][] = [];
  private reserved: boolean[][] = [];

  constructor(text: string) {
    const bytes = QrCode.toBytes(text);
    const spec = QrCode.pickVersion(bytes.length);
    this.matrix = spec ? this.build(bytes, spec) : null;
  }

  // text -> UTF-8 bytes.
  private static toBytes(text: string): number[] {
    const bytes: number[] = [];
    for (let i = 0; i < text.length; i++) {
      const cp = text.charCodeAt(i);
      if (cp < 0x80) bytes.push(cp);
      else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
      else bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
    return bytes;
  }

  // Smallest version whose payload capacity fits `len` bytes.
  private static pickVersion(len: number): QrVersionSpec | null {
    for (const v of QrCode.VERSIONS) if (len <= v.maxPayloadBytes) return v;
    return null;
  }

  private build(bytes: number[], spec: QrVersionSpec): QrBitMatrix {
    const codewords = this.assembleCodewords(bytes, spec);
    this.buildMatrix(spec, codewords);
    return this.selectMask();
  }

  // Byte mode bitstream (mode + count + data + terminator + pad) split into RS blocks,
  // each EC-encoded, then data + EC interleaved into the final codeword sequence.
  private assembleCodewords(bytes: number[], spec: QrVersionSpec): number[] {
    const countBits = spec.version <= 9 ? 8 : 16;
    const bits: number[] = [];
    const push = (val: number, n: number) => {
      for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1);
    };

    push(0b0100, 4); // byte mode
    push(bytes.length, countBits);
    for (const b of bytes) push(b, 8);

    const dataCw = spec.totalCodewords - spec.ecPerBlock * spec.blocks;
    const maxBits = dataCw * 8;
    for (let i = 0; i < 4 && bits.length < maxBits; i++) bits.push(0); // terminator
    while (bits.length % 8 !== 0) bits.push(0);

    const dataBytes: number[] = [];
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      dataBytes.push(b);
    }
    const pads = [0xec, 0x11];
    let pi = 0;
    while (dataBytes.length < dataCw) dataBytes.push(pads[pi++ & 1]);

    const perBlock = Math.floor(dataCw / spec.blocks);
    const remainder = dataCw - perBlock * spec.blocks;
    const dataBlocks: number[][] = [];
    const ecBlocks: number[][] = [];
    let off = 0;
    for (let bI = 0; bI < spec.blocks; bI++) {
      const sz = perBlock + (bI >= spec.blocks - remainder ? 1 : 0);
      const chunk = dataBytes.slice(off, off + sz);
      off += sz;
      dataBlocks.push(chunk);
      ecBlocks.push(QrCode.rsEncode(chunk, spec.ecPerBlock));
    }

    const finalCw: number[] = [];
    const maxData = Math.max(...dataBlocks.map((b) => b.length));
    for (let i = 0; i < maxData; i++)
      for (const blk of dataBlocks) if (i < blk.length) finalCw.push(blk[i]);
    for (let i = 0; i < spec.ecPerBlock; i++) for (const blk of ecBlocks) finalCw.push(blk[i]);
    return finalCw;
  }

  // ── matrix construction (fills this.m / this.reserved / this.size) ──
  private buildMatrix(spec: QrVersionSpec, codewords: number[]): void {
    this.size = 17 + spec.version * 4;
    this.m = [];
    this.reserved = [];
    for (let r = 0; r < this.size; r++) {
      this.m.push(new Array(this.size).fill(null));
      this.reserved.push(new Array(this.size).fill(false));
    }
    this.finders();
    this.timing();
    this.setF(this.size - 8, 8, 1); // dark module
    this.alignment(spec);
    this.versionInfo(spec);
    this.reserveFormatArea();
    this.placeData(codewords);
  }

  private setF(r: number, c: number, v: number): void {
    this.m[r][c] = v ? 1 : 0;
    this.reserved[r][c] = true;
  }

  private finders(): void {
    const finder = (r: number, c: number) => {
      for (let i = -1; i <= 7; i++)
        for (let j = -1; j <= 7; j++) {
          const rr = r + i, cc = c + j;
          if (rr < 0 || cc < 0 || rr >= this.size || cc >= this.size) continue;
          const inRing =
            (i >= 0 && i <= 6 && (j === 0 || j === 6)) ||
            (j >= 0 && j <= 6 && (i === 0 || i === 6));
          const inCore = i >= 2 && i <= 4 && j >= 2 && j <= 4;
          this.setF(rr, cc, inRing || inCore ? 1 : 0);
        }
    };
    finder(0, 0);
    finder(0, this.size - 7);
    finder(this.size - 7, 0);
  }

  private timing(): void {
    for (let i = 8; i < this.size - 8; i++) {
      this.setF(6, i, i % 2 === 0 ? 1 : 0);
      this.setF(i, 6, i % 2 === 0 ? 1 : 0);
    }
  }

  private alignment(spec: QrVersionSpec): void {
    const ac = QrCode.ALIGN[spec.version];
    for (const r of ac)
      for (const c of ac) {
        if ((r <= 7 && c <= 7) || (r <= 7 && c >= this.size - 8) || (r >= this.size - 8 && c <= 7)) continue;
        for (let i = -2; i <= 2; i++)
          for (let j = -2; j <= 2; j++) {
            const ring = Math.max(Math.abs(i), Math.abs(j));
            this.setF(r + i, c + j, ring === 2 || ring === 0 ? 1 : 0);
          }
      }
  }

  // Version information (mandatory from v7): 6 version bits + 12 BCH(18,6) bits
  // (generator 0x1f25), placed in two 6x3 blocks.
  private versionInfo(spec: QrVersionSpec): void {
    if (spec.version < 7) return;
    let vbits = spec.version << 12;
    const vg = 0x1f25;
    for (let i = 5; i >= 0; i--) if ((vbits >> (i + 12)) & 1) vbits ^= vg << i;
    const vfull = (spec.version << 12) | vbits;
    for (let i = 0; i < 18; i++) {
      const bit = (vfull >> i) & 1;
      const r = Math.floor(i / 3);
      const c = i % 3;
      this.setF(this.size - 11 + c, r, bit); // bottom-left block
      this.setF(r, this.size - 11 + c, bit); // top-right block (transposed)
    }
  }

  // Reserve EXACTLY the format-info modules (same cells placeFormat writes).
  private reserveFormatArea(): void {
    for (let i = 0; i <= 8; i++) {
      this.reserved[8][i] = true;
      this.reserved[i][8] = true;
    }
    for (let i = 0; i < 7; i++) this.reserved[this.size - 1 - i][8] = true;
    for (let i = 0; i < 8; i++) this.reserved[8][this.size - 1 - i] = true;
  }

  // Place the data bits in the upward/downward zigzag over the free modules.
  private placeData(codewords: number[]): void {
    let bitIdx = 0;
    const totalBits = codewords.length * 8;
    const bitAt = (i: number): 0 | 1 => (i < totalBits ? (((codewords[i >> 3] >> (7 - (i & 7))) & 1) as 0 | 1) : 0);
    let dir = -1;
    for (let col = this.size - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (let n = 0; n < this.size; n++) {
        const row = dir < 0 ? this.size - 1 - n : n;
        for (let k = 0; k < 2; k++) {
          const cc = col - k;
          if (this.reserved[row][cc]) continue;
          this.m[row][cc] = bitAt(bitIdx++);
        }
      }
      dir = -dir;
    }
  }

  // ── mask selection ──
  private selectMask(): QrBitMatrix {
    let best: QrBitMatrix | null = null;
    let bestPen = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const masked = this.applyMask(mask);
      this.placeFormat(masked, mask);
      const pen = this.penalty(masked);
      if (pen < bestPen) {
        bestPen = pen;
        best = masked;
      }
    }
    return best!;
  }

  // Fresh copy of this.m with the mask pattern XORed over the non-reserved modules.
  private applyMask(mask: number): QrBitMatrix {
    const out: QrBitMatrix = [];
    for (let r = 0; r < this.size; r++) out.push(this.m[r].slice() as (0 | 1)[]);
    for (let r = 0; r < this.size; r++)
      for (let c = 0; c < this.size; c++) {
        if (this.reserved[r][c]) continue;
        let flip = false;
        switch (mask) {
          case 0: flip = (r + c) % 2 === 0; break;
          case 1: flip = r % 2 === 0; break;
          case 2: flip = c % 3 === 0; break;
          case 3: flip = (r + c) % 3 === 0; break;
          case 4: flip = (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; break;
          case 5: flip = ((r * c) % 2) + ((r * c) % 3) === 0; break;
          case 6: flip = (((r * c) % 2) + ((r * c) % 3)) % 2 === 0; break;
          case 7: flip = (((r + c) % 2) + ((r * c) % 3)) % 2 === 0; break;
        }
        if (flip) out[r][c] ^= 1;
      }
    return out;
  }

  // ECC level L = 01. Format bits = BCH(15,5) then XOR 0x5412, placed in the two
  // ISO/IEC 18004 copies around the finders. Mutates the given matrix.
  private placeFormat(m: QrBitMatrix, mask: number): void {
    const data = (1 << 3) | mask; // level L = 1
    let bits = data << 10;
    const g = 0x537;
    for (let i = 4; i >= 0; i--) if ((bits >> (i + 10)) & 1) bits ^= g << i;
    const fmt = ((data << 10) | bits) ^ 0x5412;
    for (let i = 0; i < 15; i++) {
      const bit = ((fmt >> i) & 1) as 0 | 1;
      let vr: number;
      if (i < 6) vr = i;
      else if (i < 8) vr = i + 1;
      else vr = this.size - 15 + i;
      m[vr][8] = bit;
      let hc: number;
      if (i < 8) hc = this.size - i - 1;
      else if (i < 9) hc = 15 - i;
      else hc = 15 - i - 1;
      m[8][hc] = bit;
    }
  }

  // Mask-penalty score (Rule 1: same-colour runs >= 5, rows + columns).
  private penalty(m: QrBitMatrix): number {
    let p = 0;
    for (let r = 0; r < this.size; r++)
      for (const horiz of [true, false]) {
        let run = 1;
        let prev = -1;
        for (let c = 0; c < this.size; c++) {
          const v = horiz ? m[r][c] : m[c][r];
          if (v === prev) {
            run++;
            if (run === 5) p += 3;
            else if (run > 5) p += 1;
          } else {
            run = 1;
            prev = v;
          }
        }
      }
    return p;
  }
}

// DOM bridge: paint an encoded QR matrix onto a crisp <canvas> (square pixels) inside `el`. Returns
// false when `text` exceeds the encoder's capacity (matrix === null), so the caller can fall back to the
// plaintext secret. Exported and consumed by admin/totp/totp-enroll-modal.ts's enrollment flow.
export function renderQrCanvas(el: HTMLElement, text: string, sizePx: number): boolean {
  const matrix = new QrCode(text).matrix;

  if (!matrix) return false;
  const n = matrix.length;
  const quiet = 4;
  const total = n + quiet * 2;
  const scale = Math.max(2, Math.floor(sizePx / total));
  const px = total * scale;
  const canvas = document.createElement('canvas');

  canvas.width = px;
  canvas.height = px;
  canvas.style.width = px + 'px';
  canvas.style.height = px + 'px';
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = '#000';

  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      if (matrix[r][c]) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
    }

  el.innerHTML = '';
  el.appendChild(canvas);

  return true;
}
