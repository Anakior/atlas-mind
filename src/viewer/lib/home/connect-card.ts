// Home card that gets the person's AI onto their Atlas: "Add to Claude" (claude.ai's prefilled install
// link) and the address for any other assistant; then, once an assistant has actually read the mind,
// the proof of it and a few first requests to try. Online instances only: claude.ai can't reach a local
// one. Closing it is remembered on this device; Settings › Tokens keeps the same button.

import { t } from '../core/i18n';
import { api } from '../core/net';
import { escapeHtml, relativeDate } from '../core/utils';
import { SITE_NAME } from '../core/data-csrf';
import { copyToClipboard } from '../admin/settings/settings-shared';

interface Access {
  label?: string;
  last_used_at?: number | null;
  revoked?: boolean;
}

const DISMISS_KEY = 'atlas-connect-dismissed';
const WAIT_POLL_MS = 5000;
const WAIT_MAX_MS = 15 * 60_000;
const TRIES = ['connectTry1', 'connectTry2', 'connectTry3'];

export function mcpUrl(): string {
  return location.origin + '/mcp';
}

export function claudeInstallUrl(): string {
  return (
    'https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=' +
    encodeURIComponent(SITE_NAME) +
    '&connectorUrl=' +
    encodeURIComponent(mcpUrl())
  );
}

class ConnectCard {
  private waiting: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    window.addEventListener('atlas:home', () => void this.mount());
  }

  // Called again by the boot once the session is known (the home may render before it).
  async mount(): Promise<void> {
    const slot = document.getElementById('home-connect');

    if (!slot || !document.body.classList.contains('cloud-authed') || this.dismissed()) return;
    let read: Access | null;

    try {
      read = await this.lastRead();
    } catch (e) {
      return;
    }
    if (!slot.isConnected) return; // the home was left meanwhile
    this.render(slot, read);
    if (!read) this.waitForFirstRead(slot, Date.now());
  }

  private dismissed(): boolean {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch (e) {
      return false;
    }
  }

  // The access (OAuth grant or token) an assistant used last, if any ever was.
  private async lastRead(): Promise<Access | null> {
    const used = (await api<Access[]>('GET', '/api/tokens')).filter((a) => !a.revoked && a.last_used_at);

    used.sort((a, b) => b.last_used_at! - a.last_used_at!);

    return used[0] ?? null;
  }

  private waitForFirstRead(slot: HTMLElement, since: number): void {
    if (this.waiting) clearTimeout(this.waiting);
    this.waiting = setTimeout(async () => {
      if (!slot.isConnected || Date.now() - since > WAIT_MAX_MS) return;
      const read = await this.lastRead().catch(() => null);

      if (read) this.render(slot, read);
      else this.waitForFirstRead(slot, since);
    }, WAIT_POLL_MS);
  }

  private render(slot: HTMLElement, read: Access | null): void {
    const close = `<button type="button" class="home-connect-close" data-dismiss title="${t('close')}" aria-label="${t('close')}">&times;</button>`;

    slot.innerHTML = read
      ? `<section class="home-connect is-on">
          <div class="home-connect-main">
            <h2><span class="home-connect-ok" aria-hidden="true">&#10003;</span>${escapeHtml(t('connectDone', read.label || 'Claude', relativeDate(read.last_used_at!)))}</h2>
            <p>${t('connectTryTitle')}</p>
            <ul class="home-connect-try">${TRIES.map((k) => `<li><span>${escapeHtml(t(k))}</span><button type="button" data-copy="${escapeHtml(t(k))}">${t('copy')}</button></li>`).join('')}</ul>
          </div>${close}
        </section>`
      : `<section class="home-connect">
          <div class="home-connect-main">
            <h2>${t('connectTitle')}</h2>
            <p>${t('connectText')}</p>
            <div class="home-connect-actions">
              <a class="home-connect-cta" href="${escapeHtml(claudeInstallUrl())}" target="_blank" rel="noopener">${t('connectClaude')}</a>
              <span class="home-connect-wait"><i aria-hidden="true"></i>${t('connectWaiting')}</span>
            </div>
            <p class="home-connect-note">${t('connectFreeNote')}</p>
          </div>
          <div class="home-connect-side">
            <p>${t('connectOther')}</p>
            <div class="home-connect-url"><code>${escapeHtml(mcpUrl())}</code><button type="button" data-copy="${escapeHtml(mcpUrl())}">${t('copy')}</button></div>
          </div>${close}
        </section>`;
    slot.classList.remove('hidden');
    slot.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((b) =>
      b.addEventListener('click', async () => {
        await copyToClipboard(b.dataset.copy!);
        b.textContent = t('copied');
        setTimeout(() => (b.textContent = t('copy')), 1200);
      }),
    );
    slot.querySelector('[data-dismiss]')!.addEventListener('click', () => {
      try {
        localStorage.setItem(DISMISS_KEY, '1');
      } catch (e) {
        /* storage blocked: it just comes back next time */
      }
      if (this.waiting) clearTimeout(this.waiting);
      slot.classList.add('hidden');
    });
  }
}

export const connectCard = new ConnectCard();
