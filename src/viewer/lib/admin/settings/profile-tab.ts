// Settings › Profile tab (self-service, "security" pane): your first/last name, your password and its
// recovery codes. The
// form markup is static in 05-settings.html; the submit handlers are wired lazily on first load (the
// dataset.wired guard) so they are attached exactly once.

import { t } from '../../core/i18n';
import { avatarSeed, constellationSvg } from '../../ui/avatar';
import { showAccount } from '../../home/side-nav';
import { setCsrfToken, totpEnabled } from '../../core/data-csrf';
import { SettingsContext, type SettingsError, copyToClipboard } from './settings-shared';

export class SettingsProfile {
  constructor(private readonly ctx: SettingsContext) {}

  async load(): Promise<void> {
    const form = document.getElementById('account-profile-form') as HTMLFormElement | null;
    const first = document.getElementById('account-profile-first') as HTMLInputElement | null;
    const last = document.getElementById('account-profile-last') as HTMLInputElement | null;

    if (!form || !first || !last) return;
    const pwForm = document.getElementById('account-password-form') as HTMLFormElement;

    if (!form.dataset.wired) {
      form.dataset.wired = '1';
      form.addEventListener('submit', (e) => this.save(e));
      pwForm.addEventListener('submit', (e) => this.changePassword(e, pwForm));
      const codesForm = document.getElementById('account-codes-form') as HTMLFormElement;

      codesForm.addEventListener('submit', (e) => this.makeCodes(e, codesForm));
    }
    for (const row of ['account-password-code-row', 'account-codes-code-row']) {
      document.getElementById(row)!.classList.toggle('hidden', !totpEnabled);
    }
    document.getElementById('account-codes-list')!.classList.add('hidden');
    try {
      const data = await this.ctx.fetch<any>('/api/account/profile');
      first.value = data.first_name || '';
      last.value = data.last_name || '';
      this.showCodesLeft(data.recovery_codes || 0);
      const avatar = document.getElementById('account-profile-avatar');
      if (avatar && data.email) avatar.innerHTML = constellationSvg(avatarSeed(data.first_name, data.last_name, data.email), 64);
    } catch (e) {
      this.ctx.showError((e as Error).message);
    }
  }

  private async save(e: Event): Promise<void> {
    e.preventDefault();
    this.ctx.clearError();
    const btn = (e.target as HTMLElement).querySelector('button[type="submit"]') as HTMLButtonElement;
    const first = (document.getElementById('account-profile-first') as HTMLInputElement).value.trim();
    const last = (document.getElementById('account-profile-last') as HTMLInputElement).value.trim();
    btn.disabled = true;
    try {
      await this.ctx.fetch('/api/account/profile', {
        method: 'POST',
        body: JSON.stringify({ first_name: first, last_name: last }),
      });
      // The new name shows at once: in the menu's account card, and on this tab's face.
      const me = await this.ctx.fetch<MeAuthenticated>('/api/me');

      showAccount(me);
      const avatar = document.getElementById('account-profile-avatar');

      if (avatar && me.email) avatar.innerHTML = constellationSvg(avatarSeed(me.first_name, me.last_name, me.email), 64);
      const status = document.getElementById('account-profile-status');
      if (status) {
        status.textContent = t('profileSaved');
        status.classList.remove('hidden');
        setTimeout(() => status.classList.add('hidden'), 2500);
      }
    } catch (err) {
      this.ctx.showError((err as Error).message);
    } finally {
      btn.disabled = false;
    }
  }

  private showCodesLeft(left: number): void {
    document.getElementById('account-codes-state')!.textContent = left ? t('codesLeft', left) : t('codesNone');
    document.getElementById('account-codes-submit')!.textContent = t(left ? 'codesRenew' : 'codesMake');
  }

  // New codes replace the old ones and are shown once: copy or save them now.
  private async makeCodes(e: Event, form: HTMLFormElement): Promise<void> {
    e.preventDefault();
    this.ctx.clearError();
    const value = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
    const btn = form.querySelector('button[type="submit"]') as HTMLButtonElement;

    btn.disabled = true;
    try {
      const { codes } = await this.ctx.fetch<{ codes: string[] }>('/api/account/recovery-codes', {
        method: 'POST',
        body: JSON.stringify({ password: value('account-codes-password'), code: value('account-codes-code') }),
      });

      form.reset();
      this.showCodesLeft(codes.length);
      this.showCodes(codes);
    } catch (err) {
      const code = (err as SettingsError).code;

      if (code === 'code_required') document.getElementById('account-codes-code-row')!.classList.remove('hidden');
      this.ctx.showError(code && t('passwordErr_' + code) !== 'passwordErr_' + code ? t('passwordErr_' + code) : (err as Error).message);
    } finally {
      btn.disabled = false;
    }
  }

  private showCodes(codes: string[]): void {
    const list = document.getElementById('account-codes-list')!;
    const text = codes.join('\n') + '\n';
    const file = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));

    list.innerHTML = `<p class="text-xs text-amber-300 mb-2">${t('codesOnce')}</p>
      <div class="grid grid-cols-2 gap-1.5 font-mono text-sm text-ink-100">${codes.map((c) => `<code class="px-2 py-1 rounded bg-black/30">${c}</code>`).join('')}</div>
      <div class="flex gap-2 mt-3">
        <button type="button" data-copy class="px-3 py-1.5 text-xs bg-navy-700 hover:bg-navy-600 text-ink-200 rounded-lg font-medium">${t('copy')}</button>
        <a href="${file}" download="atlas-codes-de-secours.txt" class="px-3 py-1.5 text-xs bg-navy-700 hover:bg-navy-600 text-ink-200 rounded-lg font-medium">${t('codesDownload')}</a>
      </div>`;
    list.classList.remove('hidden');
    list.querySelector('[data-copy]')!.addEventListener('click', async (e) => {
      if (await copyToClipboard(text)) this.ctx.flashCopied(e.currentTarget as HTMLElement);
    });
  }

  private async changePassword(e: Event, form: HTMLFormElement): Promise<void> {
    e.preventDefault();
    this.ctx.clearError();
    const value = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
    const password = value('account-password-new');

    if (password.length < 8) return this.ctx.showError(t('passwordTooShort'));
    if (password !== value('account-password-confirm')) return this.ctx.showError(t('passwordMismatch'));
    const btn = form.querySelector('button[type="submit"]') as HTMLButtonElement;

    btn.disabled = true;
    try {
      await this.ctx.fetch('/api/account/password', {
        method: 'POST',
        body: JSON.stringify({ current: value('account-password-current'), password, code: value('account-password-code') }),
      });
      // The session was renewed with the password: so was its CSRF token.
      setCsrfToken((await this.ctx.fetch<{ csrf_token: string }>('/api/me')).csrf_token);
      form.reset();
      const status = document.getElementById('account-password-status')!;

      status.textContent = t('passwordChanged');
      status.classList.remove('hidden');
      setTimeout(() => status.classList.add('hidden'), 3000);
    } catch (err) {
      const code = (err as SettingsError).code;

      if (code === 'code_required') document.getElementById('account-password-code-row')!.classList.remove('hidden');
      this.ctx.showError(code && t('passwordErr_' + code) !== 'passwordErr_' + code ? t('passwordErr_' + code) : (err as Error).message);
    } finally {
      btn.disabled = false;
    }
  }
}
