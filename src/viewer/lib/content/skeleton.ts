// Loading skeletons for the document surface (shared by doc-renderer.ts and frames.ts). hashStr seeds
// a per-path LCG so the same doc always shimmers the same shape; renderSkeleton paints it. Both
// consumers import it.

import { t } from '../core/i18n';

export function hashStr(s: string): number {
  // djb2 — small stable fingerprint to seed the skeleton's LCG
  let h = 5381;

  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;

  return h;
}

// Deterministic per-path skeleton (same doc → same layout). LCG seeded by hashStr(path). Pure +
// cross-cutting: frames.ts also renders it before a .html/.pdf/.docx frame loads.
export function renderSkeleton(file: FileNode): string {
  let state = (file && file.path ? hashStr(file.path) : 1) || 1;
  const next = (): number => (state = (state * 1664525 + 1013904223) >>> 0);
  const range = (min: number, max: number): number => min + (next() % (max - min + 1));
  const coin = (p: number): boolean => next() % 100 < p * 100;

  const parts: string[] = [];
  const para = (lines: number): string => {
    const rows: string[] = [];

    for (let i = 0; i < lines; i++) {
      const isLast = i === lines - 1;
      const isPenult = i === lines - 2;
      let w: number;

      if (isLast) w = range(35, 70);
      else if (isPenult && coin(0.4)) w = range(78, 94);
      else w = range(95, 100);
      rows.push('<div class="skeleton" style="height:.95rem;width:' + w + '%;"></div>');
    }

    return (
      '<div style="display:flex;flex-direction:column;gap:.55rem;margin-bottom:1.75rem;">' +
      rows.join('') +
      '</div>'
    );
  };

  const h2 = (): string =>
    '<div class="skeleton-h2" style="height:1.6rem;width:' +
    range(28, 58) +
    '%;margin-bottom:1rem;margin-top:.5rem;"></div>';
  const code = (): string =>
    '<div class="skeleton-code" style="height:' +
    range(4, 9) +
    'rem;margin-bottom:1.75rem;"></div>';

  parts.push(
    '<div class="skeleton-title" style="height:2.4rem;width:' +
      range(48, 78) +
      '%;margin-bottom:1rem;"></div>',
  );
  parts.push(
    '<div style="display:flex;gap:.5rem;margin-bottom:2rem;">' +
      '<div class="skeleton" style="height:.7rem;width:' +
      range(5, 9) +
      'rem;"></div>' +
      '<div class="skeleton" style="height:.7rem;width:' +
      range(4, 7) +
      'rem;"></div>' +
      '</div>',
  );

  parts.push(para(range(3, 5)));

  const sections = range(1, 3);

  for (let s = 0; s < sections; s++) {
    parts.push(h2());
    parts.push(para(range(2, 5)));

    if (coin(0.4)) parts.push(code());
  }

  return (
    '<div class="not-prose" aria-busy="true" aria-label="' +
    t('loadingDoc') +
    '">' +
    parts.join('') +
    '</div>'
  );
}
