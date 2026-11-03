// Sync banner — warns when changes stop reaching git: a commit refused (not in the history)
// or pushes failing / stuck (not saved online). Polls GET /api/sync; Retry asks the server
// to pull/push again (POST /api/sync). Closing hides that warning until it changes.
import { api } from '../core/net';
import { t } from '../core/i18n';

interface SyncHealth {
  status: 'ok' | 'pending' | 'error' | 'local';
  unpushed: number;
  oldest_unpushed_at: number | null;
  error: { op: string; kind: string; message?: string } | null;
}

const POLL_MS = 60_000;
// A push runs right after each write: only a backlog older than this means it is stuck.
const STUCK_AFTER_S = 10 * 60;
const EXPLAINED = ['auth', 'network', 'conflict'];

let last: SyncHealth | null = null;
let dismissed = '';

function signature(h: SyncHealth): string {
  return h.error ? h.error.op + ':' + h.error.kind : h.status;
}

function render(h: SyncHealth): void {
  const banner = document.getElementById('sync-banner');

  if (!banner) return;
  const stuck =
    h.status === 'pending' && h.oldest_unpushed_at !== null && Date.now() / 1000 - h.oldest_unpushed_at > STUCK_AFTER_S;

  if ((h.status !== 'error' && !stuck) || signature(h) === dismissed) {
    banner.classList.add('hidden');
    return;
  }
  const history = h.error?.op === 'commit';
  const why = h.error && EXPLAINED.includes(h.error.kind) ? t('syncWhy_' + h.error.kind) : '';
  const text = document.getElementById('sync-banner-text')!;

  document.getElementById('sync-banner-title')!.textContent = t(history ? 'syncTitleHistory' : 'syncTitleOnline');
  text.textContent = history ? t('syncTextHistory') : t('syncTextOnline', h.unpushed, why);
  text.title = h.error?.message || ''; // git's own words: the server only sends them to admins
  banner.classList.remove('hidden');
}

async function check(): Promise<void> {
  try {
    last = await api<SyncHealth>('GET', '/api/sync');
    render(last);
  } catch (e) {
    /* a network blip or an expired session: keep showing the last known state */
  }
}

export function startSyncBanner(): void {
  document.getElementById('sync-banner-retry')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;

    btn.disabled = true;
    try {
      await api('POST', '/api/sync', {});
    } catch (err) {
      /* the next check reports whatever state the server is in */
    }
    setTimeout(() => {
      btn.disabled = false;
      void check();
    }, 3000);
  });
  document.getElementById('sync-banner-close')?.addEventListener('click', () => {
    if (last) dismissed = signature(last);
    document.getElementById('sync-banner')?.classList.add('hidden');
  });
  void check();
  setInterval(check, POLL_MS);
}
