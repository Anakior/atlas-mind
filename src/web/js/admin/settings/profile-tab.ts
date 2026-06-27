// Settings › Profile tab (self-service, "security" pane): prefill + save your first/last name. The
// form markup is static in 05-settings.html; the submit handler is wired lazily on first load (the
// dataset.wired guard) so it is attached exactly once.
class SettingsProfile {
  constructor(private readonly ctx: SettingsContext) {}

  async load(): Promise<void> {
    const form = document.getElementById('account-profile-form') as HTMLFormElement | null;
    const first = document.getElementById('account-profile-first') as HTMLInputElement | null;
    const last = document.getElementById('account-profile-last') as HTMLInputElement | null;

    if (!form || !first || !last) return;
    if (!form.dataset.wired) {
      form.dataset.wired = '1';
      form.addEventListener('submit', (e) => this.save(e));
    }
    try {
      const data = await this.ctx.fetch<any>('/api/account/profile');
      first.value = data.first_name || '';
      last.value = data.last_name || '';
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
}
