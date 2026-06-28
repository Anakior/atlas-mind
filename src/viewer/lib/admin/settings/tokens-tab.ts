// Settings › Tokens tab: list active API tokens, create one (plaintext shown once), revoke. The
// token result panel (plaintext + MCP URL) is the shell's only cross-tab dependency here — open()
// hides it via hideResult().
class SettingsTokens {
  private readonly list = document.getElementById('settings-tokens-list')!;
  private readonly form = document.getElementById('settings-token-form') as HTMLFormElement;
  private readonly result = document.getElementById('settings-token-result')!;

  constructor(private readonly ctx: SettingsContext) {
    this.form.addEventListener('submit', (e) => this.submit(e));
    document.getElementById('settings-token-copy')!.addEventListener('click', async (e) => {
      await this.ctx.copyFromInput(e.currentTarget as HTMLElement, 'settings-token-plain');
      // Hide the secret after the flash — it's in the clipboard and never reappears.
      setTimeout(() => this.hideResult(), 1400);
    });
    document.getElementById('settings-token-mcp-copy')!.addEventListener('click', (e) =>
      this.ctx.copyFromInput(e.currentTarget as HTMLElement, 'settings-token-mcp'),
    );
    document.getElementById('settings-token-close')!.addEventListener('click', () => this.hideResult());
    this.list.addEventListener('click', (e) => this.onClick(e));
  }

  async load(): Promise<void> {
    this.list.innerHTML = '';

    try {
      const tokens = await this.ctx.fetch<any[]>('/api/tokens');
      const active = Array.isArray(tokens) ? tokens.filter((tk) => !tk.revoked) : [];

      if (active.length === 0) {
        this.list.innerHTML =
          '<li class="text-sm text-ink-500">' + t('settingsNoTokens') + '</li>';

        return;
      }

      this.list.innerHTML = active
        .map((tk) => {
          const created = tk.created_at ? t('createdShort', shareFormatDate(tk.created_at)) : '';
          const labelText = tk.label || tk.email || '';
          const labelEsc = escapeHtml(labelText);

          return (
            '<li class="admin-row bg-navy-900 border subtle-border rounded p-2.5 text-sm">' +
            '<div class="flex-1 min-w-0">' +
            '<div class="text-ink-100 font-medium font-mono truncate" title="' +
            labelEsc +
            '">' +
            labelEsc +
            '</div>' +
            '<div class="text-ink-500 text-xs mt-0.5">' +
            escapeHtml(created) +
            '</div>' +
            '</div>' +
            '<div class="admin-row__actions">' +
            '<button class="settings-token-revoke px-3 py-1.5 text-sm bg-navy-700 hover:bg-rose-500/30 hover:text-rose-300 text-ink-200 rounded" data-id="' +
            escapeHtml(tk.id || '') +
            '" data-label="' +
            labelEsc +
            '">' +
            t('settingsRevokeToken') +
            '</button>' +
            '</div>' +
            '</li>'
          );
        })
        .join('');
    } catch (e) {
      this.ctx.showError((e as Error).message);
    }
  }

  private async submit(e: Event): Promise<void> {
    e.preventDefault();
    this.ctx.clearError();
    const labelInput = document.getElementById('settings-token-label') as HTMLInputElement;
    const label = labelInput.value.trim();

    if (!label) return;

    try {
      const data = await this.ctx.fetch<any>('/api/tokens', {
        method: 'POST',
        body: JSON.stringify({ label }),
      });

      // One-time display: the plaintext token NEVER comes back after this point.
      (document.getElementById('settings-token-plain') as HTMLInputElement).value = data.token || '';
      (document.getElementById('settings-token-mcp') as HTMLInputElement).value = data.mcp_url || '';
      this.result.classList.remove('hidden');
      labelInput.value = '';
      this.load();
    } catch (err) {
      this.ctx.showError((err as Error).message);
    }
  }

  hideResult(): void {
    this.result.classList.add('hidden');
    // Clear the secret from the DOM — no residue in the inspector.
    (document.getElementById('settings-token-plain') as HTMLInputElement).value = '';
    (document.getElementById('settings-token-mcp') as HTMLInputElement).value = '';
  }

  private async onClick(e: Event): Promise<void> {
    const revokeBtn = this.ctx.hit(e, '.settings-token-revoke');

    if (!revokeBtn) return;
    const ok = await confirmDialog({
      title: t('settingsRevokeTokenTitle'),
      message: t('settingsRevokeTokenMsg', revokeBtn.dataset.label),
      confirmLabel: t('settingsRevokeToken'),
      destructive: true,
    });

    if (!ok) return;

    try {
      // Prefer id over label: the label may be reused after revocation.
      const body = revokeBtn.dataset.id
        ? { id: revokeBtn.dataset.id }
        : { label: revokeBtn.dataset.label };

      await this.ctx.fetch('/api/tokens', {
        method: 'DELETE',
        body: JSON.stringify(body),
      });
      this.load();
    } catch (err) {
      this.ctx.showError((err as Error).message);
    }
  }
}
