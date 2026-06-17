const QR = (function() {
  // GF(256) tables (primitive 0x11d).
  const EXP = new Array(512), LOG = new Array(256);
  (function() { let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; })();
  function gfMul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }
  function rsGenPoly(n) {
    let poly = [1];
    for (let i = 0; i < n; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }
  function rsEncode(data, ecLen) {
    // GF(256) polynomial division of (data + ecLen zeros) by the generator;
    // the remainder is the ecLen correction bytes.
    const gen = rsGenPoly(ecLen); // length ecLen+1, gen[0] === 1
    const buf = data.concat(new Array(ecLen).fill(0));
    for (let i = 0; i < data.length; i++) {
      const coef = buf[i];
      if (coef === 0) continue;
      for (let j = 1; j < gen.length; j++) buf[i + j] ^= gfMul(gen[j], coef);
    }
    return buf.slice(data.length);
  }
  // EC level L. [version, totalCodewords, ecPerBlock, blocks, maxPayloadBytes].
  // Exact ISO/IEC 18004 values. WARNING: from v6 on the data is split into
  // MULTIPLE RS blocks (ecPerBlock ≠ total ec) then interleaved — treating it as
  // a single block produces an unreadable QR.
  // maxPayloadBytes = dataCodewords − header overhead (mode + counter, ~2 bytes up to v9).
  const VERSIONS = [
    [1, 26, 7, 1, 17], [2, 44, 10, 1, 32], [3, 70, 15, 1, 53],
    [4, 100, 20, 1, 78], [5, 134, 26, 1, 106], [6, 172, 18, 2, 134],
    [7, 196, 20, 2, 154], [8, 242, 24, 2, 192], [9, 292, 30, 2, 230],
    [10, 346, 18, 4, 271],
  ];
  function pickVersion(len) {
    for (const v of VERSIONS) { if (len <= v[4]) return v; }
    return null;
  }
  // Alignment pattern centers per version.
  const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
  function buildMatrix(version, codewords) {
    const size = 17 + version * 4;
    const m = []; const reserved = [];
    for (let r = 0; r < size; r++) { m.push(new Array(size).fill(null)); reserved.push(new Array(size).fill(false)); }
    function setF(r, c, v) { m[r][c] = v ? 1 : 0; reserved[r][c] = true; }
    // Finder patterns + separators.
    function finder(r, c) {
      for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) {
        const rr = r + i, cc = c + j;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const inRing = (i >= 0 && i <= 6 && (j === 0 || j === 6)) || (j >= 0 && j <= 6 && (i === 0 || i === 6));
        const inCore = i >= 2 && i <= 4 && j >= 2 && j <= 4;
        setF(rr, cc, inRing || inCore ? 1 : 0);
      }
    }
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
    // Timing patterns.
    for (let i = 8; i < size - 8; i++) { setF(6, i, i % 2 === 0 ? 1 : 0); setF(i, 6, i % 2 === 0 ? 1 : 0); }
    // Dark module.
    setF(size - 8, 8, 1);
    // Alignment patterns.
    const ac = ALIGN[version];
    for (const r of ac) for (const c of ac) {
      if ((r <= 7 && c <= 7) || (r <= 7 && c >= size - 8) || (r >= size - 8 && c <= 7)) continue;
      for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
        const ring = Math.max(Math.abs(i), Math.abs(j));
        setF(r + i, c + j, (ring === 2 || ring === 0) ? 1 : 0);
      }
    }
    // Version information (mandatory from v7 on): 18 bits = 6 version bits +
    // 12 BCH(18,6) bits (generator 0x1f25), placed in two 6×3 blocks (left of
    // the top-right finder and above the bottom-left finder).
    if (version >= 7) {
      let vbits = version << 12;
      const vg = 0x1f25;
      for (let i = 5; i >= 0; i--) if ((vbits >> (i + 12)) & 1) vbits ^= vg << i;
      const vfull = (version << 12) | vbits;
      for (let i = 0; i < 18; i++) {
        const bit = (vfull >> i) & 1;
        const r = Math.floor(i / 3);
        const c = i % 3;
        // Bottom-left block: rows size-11..size-9, columns 0..5.
        setF(size - 11 + c, r, bit);
        // Top-right block: rows 0..5, columns size-11..size-9 (transposed).
        setF(r, size - 11 + c, bit);
      }
    }
    // Reserve EXACTLY the format-info modules (same cells as placeFormat).
    // Over-reserving (dark module, neighboring data cells) would shift data
    // placement → unreadable QR.
    for (let i = 0; i <= 8; i++) { reserved[8][i] = true; reserved[i][8] = true; }
    for (let i = 0; i < 7; i++) reserved[size - 1 - i][8] = true; // col 8, rows size-1..size-7
    for (let i = 0; i < 8; i++) reserved[8][size - 1 - i] = true; // row 8, cols size-1..size-8
    // Places the data bits in zigzag.
    let bitIdx = 0;
    const totalBits = codewords.length * 8;
    function bitAt(i) { return i < totalBits ? (codewords[i >> 3] >> (7 - (i & 7))) & 1 : 0; }
    let dir = -1;
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (let n = 0; n < size; n++) {
        const row = dir < 0 ? size - 1 - n : n;
        for (let k = 0; k < 2; k++) {
          const cc = col - k;
          if (reserved[row][cc]) continue;
          m[row][cc] = bitAt(bitIdx++);
        }
      }
      dir = -dir;
    }
    return { m, reserved, size };
  }
  function applyMask(m, reserved, size, mask) {
    const out = []; for (let r = 0; r < size; r++) out.push(m[r].slice());
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
      if (reserved[r][c]) continue;
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
  function placeFormat(m, size, mask) {
    // ECC level L = 01. Format bits = BCH(15,5) then XOR mask 0x5412.
    // Placement per ISO/IEC 18004: each bit i (LSB→MSB) appears in TWO copies
    // (around the top-left finder + spread over the top-right/bottom-left
    // finders), exactly like the reference implementation.
    const lvl = 1; // L
    const data = (lvl << 3) | mask;
    let bits = data << 10;
    const g = 0x537;
    for (let i = 4; i >= 0; i--) if ((bits >> (i + 10)) & 1) bits ^= g << i;
    const fmt = ((data << 10) | bits) ^ 0x5412;
    // For each bit i (LSB→MSB), two copies at the ISO/IEC 18004 positions.
    // Strip A: around the top-left finder, on row 8 (and its corner);
    // Strip B: on column 8 (top-left/bottom-left/top-right finders).
    for (let i = 0; i < 15; i++) {
      const bit = (fmt >> i) & 1;
      // Vertical strip (column 8): top-left finder (i<8) then bottom-left.
      let vr;
      if (i < 6) vr = i;
      else if (i < 8) vr = i + 1;
      else vr = size - 15 + i;
      m[vr][8] = bit;
      // Horizontal strip (row 8): copy spread over row 8 (top-right i<8) then
      // around the top-left finder.
      let hc;
      if (i < 8) hc = size - i - 1;
      else if (i < 9) hc = 15 - i;
      else hc = 15 - i - 1;
      m[8][hc] = bit;
    }
  }
  function penalty(m, size) {
    let p = 0;
    // Rule 1: runs >=5 of the same color (rows + columns).
    for (let r = 0; r < size; r++) for (const horiz of [true, false]) {
      let run = 1, prev = -1;
      for (let c = 0; c < size; c++) {
        const v = horiz ? m[r][c] : m[c][r];
        if (v === prev) { run++; if (run === 5) p += 3; else if (run > 5) p += 1; }
        else { run = 1; prev = v; }
      }
    }
    // Rule 3: finder-like pattern (approximation good enough to pick a mask).
    return p;
  }
  // Encodes an ASCII/UTF-8 string → boolean matrix.
  function encode(text) {
    const bytes = []; for (let i = 0; i < text.length; i++) {
      const cp = text.charCodeAt(i);
      if (cp < 0x80) bytes.push(cp);
      else if (cp < 0x800) { bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f)); }
      else { bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)); }
    }
    const ver = pickVersion(bytes.length);
    if (!ver) return null;
    const [version, total, ecLen, blocks, cap] = ver;
    const countBits = version <= 9 ? 8 : 16;
    // Bitstream: mode 0100, count, data, terminator, pad.
    let bits = [];
    function push(val, n) { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); }
    push(0b0100, 4); push(bytes.length, countBits);
    for (const b of bytes) push(b, 8);
    const dataCw = total - ecLen * blocks;
    const maxBits = dataCw * 8;
    for (let i = 0; i < 4 && bits.length < maxBits; i++) bits.push(0); // terminator
    while (bits.length % 8 !== 0) bits.push(0);
    const dataBytes = [];
    for (let i = 0; i < bits.length; i += 8) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]; dataBytes.push(b); }
    const pads = [0xec, 0x11]; let pi = 0;
    while (dataBytes.length < dataCw) { dataBytes.push(pads[pi & 1]); pi++; }
    // Splitting into blocks + EC, then interleaving.
    const perBlock = Math.floor(dataCw / blocks);
    const remainder = dataCw - perBlock * blocks;
    const dataBlocks = [], ecBlocks = [];
    let off = 0;
    for (let bI = 0; bI < blocks; bI++) {
      const sz = perBlock + (bI >= blocks - remainder ? 1 : 0);
      const chunk = dataBytes.slice(off, off + sz); off += sz;
      dataBlocks.push(chunk); ecBlocks.push(rsEncode(chunk, ecLen));
    }
    const finalCw = [];
    const maxData = Math.max(...dataBlocks.map(b => b.length));
    for (let i = 0; i < maxData; i++) for (const blk of dataBlocks) if (i < blk.length) finalCw.push(blk[i]);
    for (let i = 0; i < ecLen; i++) for (const blk of ecBlocks) finalCw.push(blk[i]);
    const { m, reserved, size } = buildMatrix(version, finalCw);
    // Pick the mask with the minimal penalty.
    let best = null, bestPen = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const masked = applyMask(m, reserved, size, mask);
      placeFormat(masked, size, mask);
      const pen = penalty(masked, size);
      if (pen < bestPen) { bestPen = pen; best = masked; }
    }
    return best;
  }
  // Renders the matrix into a container via a crisp <canvas> (square pixels).
  function render(container, text, sizePx) {
    const matrix = encode(text);
    if (!matrix) return false;
    const n = matrix.length, quiet = 4, total = n + quiet * 2;
    const scale = Math.max(2, Math.floor((sizePx || 180) / total));
    const px = total * scale;
    const canvas = document.createElement('canvas');
    canvas.width = px; canvas.height = px;
    canvas.style.width = px + 'px'; canvas.style.height = px + 'px';
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = '#000';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      if (matrix[r][c]) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
    }
    container.innerHTML = '';
    container.appendChild(canvas);
    return true;
  }
  return { render: render, encode: encode };
})();

// ── Security: 2FA (TOTP) + sessions ──────────────────────────────────────────
const securityTotpStatus = document.getElementById('security-totp-status');
const securityTotpEnableBtn = document.getElementById('security-totp-enable');
const securityTotpDisableBtn = document.getElementById('security-totp-disable');
const securityLogoutAllBtn = document.getElementById('security-logout-all');

const totpBackdrop = document.getElementById('totp-backdrop');
const totpTitle = document.getElementById('totp-title');
const totpError = document.getElementById('totp-error');
const totpClose = document.getElementById('totp-close');
const totpStepEnroll = document.getElementById('totp-step-enroll');
const totpStepRecovery = document.getElementById('totp-step-recovery');
const totpStepDisable = document.getElementById('totp-step-disable');
const totpQr = document.getElementById('totp-qr');
const totpSecretValue = document.getElementById('totp-secret-value');
const totpSecretCopy = document.getElementById('totp-secret-copy');
const totpVerifyForm = document.getElementById('totp-verify-form');
const totpVerifyCode = document.getElementById('totp-verify-code');
const totpVerifySubmit = document.getElementById('totp-verify-submit');
const totpEnrollCancel = document.getElementById('totp-enroll-cancel');
const totpRecoveryList = document.getElementById('totp-recovery-list');
const totpRecoveryCopy = document.getElementById('totp-recovery-copy');
const totpRecoveryDone = document.getElementById('totp-recovery-done');
const totpDisableForm = document.getElementById('totp-disable-form');
const totpDisableCode = document.getElementById('totp-disable-code');
const totpDisableSubmit = document.getElementById('totp-disable-submit');
const totpDisableCancel = document.getElementById('totp-disable-cancel');
let pendingRecoveryCodes = [];

function refreshSecurityState() {
  // totpEnabled is updated by /api/me and by the enable/disable actions.
  securityTotpStatus.textContent = totpEnabled ? t('securityTotpStatusOn') : t('securityTotpStatusOff');
  securityTotpStatus.classList.toggle('bg-emerald-500/20', totpEnabled);
  securityTotpStatus.classList.toggle('text-emerald-300', totpEnabled);
  securityTotpStatus.classList.toggle('bg-ink-500/15', !totpEnabled);
  securityTotpStatus.classList.toggle('text-ink-400', !totpEnabled);
  securityTotpEnableBtn.classList.toggle('hidden', totpEnabled);
  securityTotpDisableBtn.classList.toggle('hidden', !totpEnabled);
}

function showTotpError(msg) { totpError.textContent = msg; totpError.classList.remove('hidden'); }
function clearTotpError() { totpError.classList.add('hidden'); totpError.textContent = ''; }

function closeTotpModal() {
  totpBackdrop.classList.add('hidden');
  document.removeEventListener('keydown', onTotpKey, true);
  pendingRecoveryCodes = [];
}
function onTotpKey(e) {
  // Capture + stopPropagation so Escape closes only the 2FA modal, never the
  // Settings panel underneath. While recovery codes are shown, Escape is blocked
  // entirely (explicit "Done" required).
  if (e.key !== 'Escape') return;
  e.preventDefault(); e.stopPropagation();
  if (totpStepRecovery.classList.contains('hidden')) closeTotpModal();
}
