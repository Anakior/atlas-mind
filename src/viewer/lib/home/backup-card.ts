// Home card for an admin with no GitHub copy yet; its steps are in Settings › Mon Atlas. Closing it is
// remembered on this device.

import { t } from '../core/i18n';
import { api } from '../core/net';
import { settingsPanel } from '../admin/settings/settings-panel';

const DISMISS_KEY = 'atlas-backup-dismissed';

class BackupCard {
  constructor() {
    window.addEventListener('atlas:home', () => void this.mount());
  }

  // Called again by the boot once the session is known (the home may render before it).
  async mount(): Promise<void> {
    const slot = document.getElementById('home-backup');

    if (!slot || !document.body.classList.contains('admin-cloud') || this.dismissed()) return;
    let remote: string | null;

    try {
      remote = (await api<{ remote: string | null }>('GET', '/api/admin/github')).remote;
    } catch (e) {
      return;
    }
    if (remote || !slot.isConnected) return;
    slot.innerHTML = `<section class="home-connect is-backup">
        <div class="home-connect-main">
          <h2>${t('backupTitle')}</h2>
          <p>${t('backupText')}</p>
          <div class="home-connect-actions"><button type="button" class="home-connect-cta" data-open>${t('backupCta')}</button></div>
        </div>
        <button type="button" class="home-connect-close" data-dismiss title="${t('close')}" aria-label="${t('close')}">&times;</button>
      </section>`;
    slot.classList.remove('hidden');
    slot.querySelector('[data-open]')!.addEventListener('click', () => settingsPanel.openTab('atlas'));
    slot.querySelector('[data-dismiss]')!.addEventListener('click', () => {
      try {
        localStorage.setItem(DISMISS_KEY, '1');
      } catch (e) {
        /* storage blocked: it just comes back next time */
      }
      slot.classList.add('hidden');
    });
  }

  private dismissed(): boolean {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch (e) {
      return false;
    }
  }
}

export const backupCard = new BackupCard();
