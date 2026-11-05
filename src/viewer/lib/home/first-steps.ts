// Home card "First steps": what makes an Atlas yours, all in view, each checked once done — connect
// an AI (done once one has read the mind), recovery codes for the password, a copy on GitHub (an
// admin's). Online instances only: claude.ai can't reach a local one. Closing it is remembered on
// this device; it goes away once every step is done.

import { t } from '../core/i18n';
import { docLabelAt } from '../core/tree';
import { api } from '../core/net';
import { escapeHtml, relativeDate } from '../core/utils';
import { SITE_NAME, url } from '../core/data-csrf';
import { copyToClipboard } from '../admin/settings/settings-shared';
import { settingsPage } from '../admin/settings/settings-page';

interface Access {
  label?: string;
  last_used_at?: number | null;
  last_read?: { at: number; path: string } | null;
  revoked?: boolean;
}

interface Accesses {
  connected: Access | null; // the last one an assistant used
  read: Access | null; // the last one whose assistant read a doc
}

interface State extends Accesses {
  codes: boolean;
  github: boolean | null; // null: not the admin's to do
}

const DISMISS_KEY = 'atlas-firststeps-dismissed';
const WAIT_POLL_MS = 5000;
const WAIT_MAX_MS = 15 * 60_000;
const TRIES = ['connectTry1', 'connectTry2', 'connectTry3'];

export function mcpUrl(): string {
  return location.origin + url('/mcp');
}

export function claudeInstallUrl(): string {
  return (
    'https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=' +
    encodeURIComponent(SITE_NAME) +
    '&connectorUrl=' +
    encodeURIComponent(mcpUrl())
  );
}

class FirstSteps {
  private waiting: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    window.addEventListener('atlas:home', () => void this.mount());
  }

  // Called again by the boot once the session is known (the home may render before it).
  async mount(): Promise<void> {
    const slot = document.getElementById('home-connect');

    if (!slot || !document.body.classList.contains('cloud-authed') || this.dismissed()) return;
    let state: State;

    try {
      state = await this.state();
    } catch (e) {
      return;
    }
    if (!slot.isConnected) return; // the home was left meanwhile
    if (state.read && state.codes && state.github !== false) {
      slot.classList.add('hidden');
      return;
    }
    this.render(slot, state);
    if (!state.read) this.waitForFirstRead(slot, Date.now(), !!state.connected);
  }

  private async state(): Promise<State> {
    const admin = document.body.classList.contains('admin-cloud');
    const [accesses, codes, github] = await Promise.all([
      this.accesses(),
      api<{ recovery_codes: number }>('GET', '/api/account/profile').then((p) => p.recovery_codes > 0),
      admin ? api<{ remote: string | null }>('GET', '/api/admin/github').then((g) => !!g.remote) : Promise.resolve(null),
    ]);

    return { ...accesses, codes, github };
  }

  private dismissed(): boolean {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch (e) {
      return false;
    }
  }

  // Among the accesses (OAuth grants or tokens): the one an assistant used last, and the one whose
  // assistant last read a doc. A connection alone is not a read.
  private async accesses(): Promise<Accesses> {
    const live = (await api<Access[]>('GET', '/api/tokens')).filter((a) => !a.revoked);
    const latest = (when: (a: Access) => number | null | undefined) =>
      live.filter((a) => when(a)).sort((a, b) => when(b)! - when(a)!)[0] ?? null;

    return { connected: latest((a) => a.last_used_at), read: latest((a) => a.last_read?.at) };
  }

  private waitForFirstRead(slot: HTMLElement, since: number, connected: boolean): void {
    if (this.waiting) clearTimeout(this.waiting);
    this.waiting = setTimeout(async () => {
      if (!slot.isConnected || Date.now() - since > WAIT_MAX_MS) return;
      const now = await this.accesses().catch(() => null);

      if (now && (now.read || (now.connected && !connected))) void this.mount();
      else this.waitForFirstRead(slot, since, connected);
    }, WAIT_POLL_MS);
  }

  private step(n: number, done: boolean, title: string, body: string): string {
    return `<li class="home-step${done ? ' is-done' : ''}">
        <span class="home-step-mark" aria-hidden="true">${done ? '&#10003;' : n}</span>
        <div class="home-step-body"><h3>${title}</h3>${body}</div>
      </li>`;
  }

  private render(slot: HTMLElement, state: State): void {
    const copy = (value: string) => `<button type="button" data-copy="${escapeHtml(value)}">${t('copy')}</button>`;
    const tries = (keys: string[]) =>
      `<ul class="home-connect-try">${keys.map((k) => `<li><span>${escapeHtml(t(k))}</span>${copy(t(k))}</li>`).join('')}</ul>`;
    const waiting = `<span class="home-connect-wait"><i aria-hidden="true"></i>${t('connectWaiting')}</span>`;
    const read = state.read?.last_read;
    const claude = read
      ? `<p>${escapeHtml(t('connectDone', state.read!.label || 'Claude', docLabelAt(read.path), relativeDate(read.at)))}. ${t('connectTryTitle')}</p>
         ${tries(TRIES)}`
      : state.connected
      ? `<p>${escapeHtml(t('connectConnected', state.connected.label || 'Claude'))}</p>
         ${tries(['connectTry3'])}
         <div class="home-connect-actions">${waiting}</div>`
      : `<p>${t('connectText')}</p>
         <div class="home-connect-actions">
           <a class="home-connect-cta" href="${escapeHtml(claudeInstallUrl())}" target="_blank" rel="noopener">${t('connectClaude')}</a>
           ${waiting}
         </div>
         <p class="home-connect-note">${t('connectFreeNote')}</p>
         <p class="home-connect-note">${t('connectOther')}</p>
         <div class="home-connect-url"><code>${escapeHtml(mcpUrl())}</code>${copy(mcpUrl())}</div>`;
    // One filled button, the next thing to do; the steps after it wait their turn.
    let next = !state.read;
    const open = (tab: string, label: string) => {
      const cls = next ? 'home-step-cta is-quiet' : 'home-connect-cta';

      next = true;

      return `<div class="home-connect-actions"><button type="button" class="${cls}" data-open="${tab}">${label}</button></div>`;
    };
    const steps = [
      this.step(1, !!state.read, t('connectTitle'), claude),
      this.step(2, state.codes, t('stepCodesTitle'),
        state.codes ? `<p>${t('stepCodesDone')}</p>` : `<p>${t('stepCodesText')}</p>${open('account', t('stepCodesCta'))}`),
    ];

    if (state.github !== null) {
      steps.push(this.step(3, state.github, t('stepGithubTitle'),
        state.github ? `<p>${t('stepGithubDone')}</p>` : `<p>${t('stepGithubText')}</p>${open('atlas', t('stepGithubCta'))}`));
    }
    const done = [!!state.read, state.codes, state.github].filter((d) => d === true).length;

    slot.innerHTML = `<section class="home-connect home-steps">
        <div class="home-steps-head"><h2>${t('stepsTitle')}</h2><span>${done}/${steps.length}</span></div>
        <ol class="home-steps-list">${steps.join('')}</ol>
        <button type="button" class="home-connect-close" data-dismiss title="${t('close')}" aria-label="${t('close')}">&times;</button>
      </section>`;
    slot.classList.remove('hidden');
    slot.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((b) =>
      b.addEventListener('click', async () => {
        await copyToClipboard(b.dataset.copy!);
        b.textContent = t('copied');
        setTimeout(() => (b.textContent = t('copy')), 1200);
      }),
    );
    slot.querySelectorAll<HTMLButtonElement>('[data-open]').forEach((b) =>
      b.addEventListener('click', () => settingsPage.open(b.dataset.open!)));
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

export const firstSteps = new FirstSteps();
