// Settings › About (everyone): the version, how to report a problem and support Atlas (static, in
// 05-settings.html). For an admin, whether a newer version is out and, where a click can install it,
// the Update button (routes/admin.py update_run: pip in place, then the server restarts itself on
// it); the page reloads once the new version answers.

import { t } from '../../core/i18n';
import { escapeHtml } from '../../core/utils';
import { SettingsContext } from './settings-shared';

interface UpdateState {
  current: string | null;
  latest: string | null;
  install: 'button' | 'container' | 'source' | 'manual';
  update_available: boolean;
}

const REPO = 'https://github.com/Anakior/atlas-mind';
// For whoever has no GitHub account.
const SUPPORT_EMAIL = 'anakior@gmail.com';
const BTN = 'px-3 py-2 text-sm bg-accent hover:brightness-110 text-white rounded-lg font-medium disabled:opacity-60';
const LINK = 'text-accent hover:underline';
const HINT = 'text-xs text-ink-500 mt-1 leading-snug';
// pip, the import check and the restart take about a minute on a small host.
const RESTART_TIMEOUT_MS = 180_000;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class SettingsAbout {
  private readonly box = document.getElementById('about-update')!;

  constructor(private readonly ctx: SettingsContext) {}

  async load(): Promise<void> {
    this.fillReport();
    const admin = document.body.classList.contains('admin-cloud') || document.body.classList.contains('local-mode');

    this.box.classList.toggle('hidden', !admin);
    if (!admin) return;
    const state = await this.ctx.fetch<UpdateState>('/api/admin/update-check?now=1').catch(() => null);

    this.render(state);
  }

  // The issue (or the mail) opens with the version, the mode and the browser already written down.
  private fillReport(): void {
    const version = document.getElementById('about-version')!.textContent!.replace(/^v/, '');
    const mode = document.body.classList.contains('local-mode') ? 'local' : 'cloud';
    const body = t('aboutReportBody', `Atlas ${version} · ${mode} · ${navigator.userAgent}`);

    (document.getElementById('about-report') as HTMLAnchorElement).href =
      `${REPO}/issues/new?body=${encodeURIComponent(body)}`;
    (document.getElementById('about-mail') as HTMLAnchorElement).href =
      `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Atlas ' + version)}&body=${encodeURIComponent(body)}`;
  }

  private render(state: UpdateState | null): void {
    if (!state?.latest) {
      this.box.innerHTML = `<p class="${HINT}">${t('aboutCheckFailed')}</p>`;
      return;
    }
    if (!state.update_available) {
      this.box.innerHTML = `<p class="${HINT}">${t('aboutUpToDate')}</p>`;
      return;
    }
    const latest = escapeHtml(state.latest);
    const news = `<a class="${LINK}" href="${REPO}/releases/tag/v${latest}" target="_blank" rel="noopener">${t('aboutWhatsNew')}</a>`;
    const how = state.install === 'button'
      ? `<div class="flex flex-wrap items-center gap-3 mt-3">
           <button type="button" class="${BTN}" data-about-update>${t('aboutUpdate')}</button>
           <span class="text-xs text-ink-400" data-about-status></span>
         </div>
         <p class="${HINT} mt-2">${t('aboutUpdateHint')}</p>`
      : `<p class="${HINT} mt-2">${t('aboutHow_' + state.install)}</p>`;

    this.box.innerHTML = `<p class="text-sm text-ink-200">${t('aboutAvailable', latest)} ${news}</p>${how}`;
    this.box.querySelector<HTMLButtonElement>('[data-about-update]')
      ?.addEventListener('click', (e) => this.update(e.currentTarget as HTMLButtonElement, state.latest!));
  }

  private async update(btn: HTMLButtonElement, latest: string): Promise<void> {
    const status = this.box.querySelector<HTMLElement>('[data-about-status]')!;

    btn.disabled = true;
    this.ctx.clearError();
    status.textContent = t('aboutUpdating');
    try {
      await this.ctx.fetch('/api/admin/update', { method: 'POST', body: '{}' });
    } catch (e) {
      btn.disabled = false;
      status.textContent = '';
      this.ctx.showError(t('aboutUpdateFailed'));
      status.title = (e as { code?: string }).code || '';
      return;
    }
    status.textContent = t('aboutRestarting');
    const deadline = Date.now() + RESTART_TIMEOUT_MS;

    while (Date.now() < deadline) {
      await wait(2500);
      try {
        const state = await this.ctx.fetch<UpdateState>('/api/admin/update-check');

        if (state.current === latest) {
          await this.reloadOnNewVersion();
          return;
        }
      } catch (_) {
        /* restarting: not answering yet */
      }
    }
    status.textContent = t('aboutRestartSlow');
  }

  // The new version comes with a new service worker, whose takeover reloads the page once (boot's
  // controllerchange): asking for it rather than reloading first spares a second reload.
  private async reloadOnNewVersion(): Promise<void> {
    const reg = await navigator.serviceWorker?.getRegistration().catch(() => undefined);

    setTimeout(() => location.reload(), 10_000); // no worker took over: reload all the same
    if (reg) await reg.update().catch(() => location.reload());
    else location.reload();
  }
}
