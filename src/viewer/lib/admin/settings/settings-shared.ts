// Admin/cloud Settings — foundation layer: the standalone share-link modal, the shared admin/share
// JSON fetch, a few pure helpers, and the SettingsContext handed to every tab controller. The seven
// per-tab controllers live in ./*-tab.ts and the orchestrating SettingsPanel shell in
// ./settings-panel.ts (which imports and constructs every controller class).
//
// settingsFetch / copyToClipboard / openShareModal / closeShareModal are exported and imported
// cross-module by modals/reset-password.ts, admin/totp/*, modals/new-file-modal.ts and
// content/notes/notes-store.ts. The SettingsPanel shell is reached through its imported instance
// (settingsPanel.showError / openPublish / close), replacing the old free-function wrappers.
//
// Behaviour-preserving pass: the lists still build their rows by innerHTML string-concat and mutate
// via delegated click listeners reading data-* — the keyed-runtime port is a later pass.

import { LANG, t } from '../../core/i18n';
import { currentFile } from '../../core/state';
import { escapeHtml } from '../../core/utils';
import { fileMap } from '../../core/tree';
import { Dialogs } from '../../modals/dialogs';

// ── Share modal (admin + server mode) ────────────────────────────────────────
// The share-link modal: element refs + the two list helpers, plus the open/close/post logic below. Kept
// imperative — a tiny static popup, not worth a component. The existing-links list builds its rows by
// innerHTML string-concat (keyed-runtime port is a later pass), with hand-escaped fields. shareFormatDate
// is exported and reused by the Settings tab controllers (./*-tab.ts) for their date columns.
export const btnShare = document.getElementById('btn-share')!;
export const shareBackdrop = document.getElementById('share-backdrop')!;
export const sharePath = document.getElementById('share-path')!;
export const shareStep1 = document.getElementById('share-step1')!;
export const shareStep2 = document.getElementById('share-step2')!;
export const shareUrl = document.getElementById('share-url')!;
export const shareCopy = document.getElementById('share-copy')!;
export const shareExpiry = document.getElementById('share-expiry')!;
export const shareError = document.getElementById('share-error')!;
export const shareCancel = document.getElementById('share-cancel')!;
export const shareClose = document.getElementById('share-close')!;
export const shareNew = document.getElementById('share-new')!;
export const shareExisting = document.getElementById('share-existing')!;
export const shareExistingList = document.getElementById('share-existing-list')!;
export const shareExistingCount = document.getElementById('share-existing-count')!;

export function shareFormatDate(ts: number): string {
  if (!ts) return '';

  return new Date(ts * 1000).toLocaleDateString(LANG, {
    day: 'numeric',
    month: 'short',
    year: '2-digit',
  });
}

export async function refreshShareList(): Promise<void> {
  const file = currentFile;

  if (!file) return;
  shareExisting.classList.add('hidden');
  shareExistingList.innerHTML = '';

  try {
    const res = await fetch('/api/share/list?path=' + encodeURIComponent(file.path));

    if (!res.ok) return;
    const items = await res.json();

    if (!Array.isArray(items) || items.length === 0) return;
    shareExisting.classList.remove('hidden');
    shareExistingCount.textContent = t('nLinks', items.length);
    shareExistingList.innerHTML = items
      .map((item) => {
        const url = location.origin + '/s/' + item.token;
        const exp = item.expires_at
          ? t('expiresShort', shareFormatDate(item.expires_at))
          : t('noExpiry');
        const created = item.created_at ? t('createdShort', shareFormatDate(item.created_at)) : '';

        return (
          '<li class="bg-navy-900 border subtle-border rounded p-2 flex items-center gap-2 text-xs">' +
          '<div class="flex-1 min-w-0">' +
          '<div class="text-ink-300 font-mono truncate" title="' +
          escapeHtml(url) +
          '">' +
          escapeHtml(url) +
          '</div>' +
          '<div class="text-ink-500 text-[10px] mt-0.5">' +
          created +
          ' &middot; ' +
          exp +
          '</div>' +
          '</div>' +
          '<button class="share-existing-copy px-2 py-1 text-[11px] bg-navy-700 hover:bg-navy-600 text-ink-200 rounded" data-url="' +
          escapeHtml(url) +
          '" title="' +
          escapeHtml(t('copy')) +
          '">' +
          t('copy') +
          '</button>' +
          '<button class="share-existing-del px-2 py-1 text-[11px] bg-navy-700 hover:bg-rose-500/30 hover:text-rose-300 text-ink-200 rounded" data-id="' +
          escapeHtml(item.id) +
          '" title="' +
          escapeHtml(t('revokeTitle')) +
          '">&times;</button>' +
          '</li>'
        );
      })
      .join('');
  } catch (e) {}
}

export function openShareModal(): void {
  const file = currentFile;

  if (!file || window.__viewerMode) return;
  sharePath!.textContent = file.path;
  shareStep1!.classList.remove('hidden');
  shareStep2!.classList.add('hidden');
  shareError!.classList.add('hidden');
  shareBackdrop!.classList.remove('hidden');
  refreshShareList();
}

export function closeShareModal(): void {
  shareBackdrop!.classList.add('hidden');
}

shareExistingList!.addEventListener('click', async (e) => {
  const copyBtn = (e.target as HTMLElement).closest<HTMLElement>('.share-existing-copy');

  if (copyBtn) {
    try {
      await navigator.clipboard.writeText(copyBtn.dataset.url || '');
      copyBtn.textContent = t('copied');
      setTimeout(() => (copyBtn.textContent = t('copy')), 1200);
    } catch (e) {}

    return;
  }

  const delBtn = (e.target as HTMLElement).closest<HTMLElement>('.share-existing-del');

  if (delBtn) {
    const ok = await Dialogs.confirm({
      title: t('revokeConfirmTitle'),
      message: t('revokeConfirmMsg'),
      confirmLabel: t('revoke'),
      destructive: true,
    });

    if (!ok) return;
    shareError!.classList.add('hidden');

    try {
      const res = await fetch('/api/share/' + delBtn.dataset.id, { method: 'DELETE' });

      if (!res.ok) throw new Error('HTTP ' + res.status);
      refreshShareList();
    } catch (e) {
      shareError!.textContent = t('err', (e as Error).message);
      shareError!.classList.remove('hidden');
    }
  }
});

btnShare!.addEventListener('click', openShareModal);
shareCancel!.addEventListener('click', closeShareModal);
shareClose!.addEventListener('click', closeShareModal);
document.getElementById('share-close-x')?.addEventListener('click', closeShareModal);
shareBackdrop!.addEventListener('click', (e) => {
  if (e.target === shareBackdrop) closeShareModal();
});
shareNew!.addEventListener('click', () => {
  shareStep2!.classList.add('hidden');
  shareStep1!.classList.remove('hidden');
});

document.querySelectorAll<HTMLButtonElement>('.share-dur').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const file = currentFile;

    if (!file) return;
    shareError!.classList.add('hidden');
    const days = parseInt(btn.dataset.days!, 10);

    btn.disabled = true;

    try {
      const res = await fetch('/api/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: file.path, expires_days: days }),
      });

      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const fullUrl = location.origin + '/s/' + data.token;

      (shareUrl as HTMLInputElement).value = fullUrl;
      shareExpiry!.textContent = data.expires_at
        ? t('expiresAt', new Date(data.expires_at * 1000).toLocaleString(LANG))
        : t('neverExpires');
      shareStep1!.classList.add('hidden');
      shareStep2!.classList.remove('hidden');
      setTimeout(() => {
        (shareUrl as HTMLInputElement).select();
      }, 50);
      refreshShareList();
    } catch (e) {
      shareError!.textContent = t('err', (e as Error).message);
      shareError!.classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  });
});

shareCopy!.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText((shareUrl as HTMLInputElement).value);
    shareCopy!.textContent = t('copiedBang');
    setTimeout(() => {
      shareCopy!.textContent = t('copy');
    }, 1500);
  } catch (e) {
    (shareUrl as HTMLInputElement).select();
    document.execCommand('copy');
  }
});

// ── HTTP + pure helpers ───────────────────────────────────────────────────────
// HTTP status → human message (never the raw technical detail).
export function settingsHttpMessage(status: number): string {
  if (status === 403 || status === 401) return t('settingsErrForbidden');

  if (status === 409) return t('settingsErrConflict');

  return t('settingsErrGeneric');
}

// Shared JSON fetch for admin mutations: adds Content-Type, parses the body and raises a readable
// message (not the server detail) on failure. Imported by modals/reset-password.ts and admin/totp/*.
export async function settingsFetch<T = any>(url: string, options?: RequestInit): Promise<T> {
  const opts: RequestInit = { ...options };
  const headers: Record<string, string> = { ...(opts.headers as Record<string, string> | undefined) };

  if (opts.body) opts.headers = { 'Content-Type': 'application/json', ...headers };
  else opts.headers = headers;
  const res = await fetch(url, opts);
  let payload: any = null;

  try {
    payload = await res.json();
  } catch (_) {}

  if (!res.ok) {
    const human =
      payload && payload.error === 'cannot delete the last admin'
        ? t('settingsLastAdmin')
        : settingsHttpMessage(res.status);
    const err = new Error(human) as Error & { status?: number };

    err.status = res.status;
    throw err;
  }

  return payload as T;
}

// Node name from a path: last segment, slugified.
export function suggestNodeName(path: string): string {
  const base = (String(path).split('/').pop() || path).replace(/\.(md|html)$/i, '');

  return (
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'noeud'
  );
}

// Info about the remote node a mirror doc belongs to (remotes/<name>/…).
export function remoteNodeInfo(path: string): { name: string; sourceRel: string; fileCount: number } | null {
  const parts = (path || '').split('/');

  if (parts[0] !== 'remotes' || parts.length < 3) return null;
  const name = parts[1];
  const prefix = 'remotes/' + name + '/';
  const fileCount = Object.keys(fileMap).filter((p) => p.startsWith(prefix)).length;

  return { name, sourceRel: parts.slice(2).join('/'), fileCount };
}

// Imported by content/notes/notes-store.ts (copies its own text).
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);

    return true;
  } catch (_) {
    return false;
  }
}

// ── Shared tab context ────────────────────────────────────────────────────────
// The services every tab controller needs: the admin JSON fetch, the panel's single error banner,
// and the copy-button helpers. The shell builds ONE and hands it to each of the seven controllers,
// so none of them re-implements the banner or the clipboard flash.
export class SettingsContext {
  private readonly errorEl = document.getElementById('settings-error')!;

  // The shared admin/share JSON fetch (settingsFetch, exported above).
  readonly fetch = settingsFetch;

  showError(message: string): void {
    this.errorEl.textContent = message;
    this.errorEl.classList.remove('hidden');
  }

  clearError(): void {
    this.errorEl.classList.add('hidden');
  }

  flashCopied(btn: HTMLElement): void {
    btn.textContent = t('copied');
    btn.classList.add('is-copied');
    setTimeout(() => {
      btn.textContent = t('copy');
      btn.classList.remove('is-copied');
    }, 1200);
  }

  // Copy an input's value to the clipboard (with execCommand fallback) and flash the button.
  async copyFromInput(btn: HTMLElement, inputId: string): Promise<void> {
    const input = document.getElementById(inputId) as HTMLInputElement;
    const ok = await copyToClipboard(input.value);

    if (!ok) {
      input.select();
      document.execCommand('copy');
    }

    this.flashCopied(btn);
  }

  // The clicked element matching a delegated selector (data-* row buttons).
  hit(e: Event, selector: string): HTMLElement | null {
    return (e.target as HTMLElement).closest<HTMLElement>(selector);
  }
}
