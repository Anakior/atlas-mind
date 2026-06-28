// Pure helpers (no DOM, no network), exported and used across the viewer. relativeDate
// depends on i18n (t/LANG), imported below.
import { LANG, t } from './i18n';

export function relativeDate(epoch: number): string {
  if (!epoch) return '';
  const diff = Date.now() / 1000 - epoch;

  if (diff < 60) return t('justNow');

  if (diff < 3600) return t('minAgo', Math.floor(diff / 60));

  if (diff < 86400) return t('hoursAgo', Math.floor(diff / 3600));

  if (diff < 86400 * 7) return t('daysAgo', Math.floor(diff / 86400));

  return new Date(epoch * 1000).toLocaleDateString(LANG, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function escapeHtml(s: unknown): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };

  return String(s).replace(/[&<>"']/g, (c) => map[c]);
}
