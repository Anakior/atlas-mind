// Settings › Nodes tab (hive): publish a doc as a node (one-time link), relink (regenerate the
// token) or revoke. prefill() is the entry the shell's openPublish() delegates to when the tree's
// "share as node" button pre-fills a path.
class SettingsNodes {
  private readonly list = document.getElementById('settings-nodes-list')!;
  private readonly form = document.getElementById('settings-node-form') as HTMLFormElement;
  private readonly result = document.getElementById('settings-node-result')!;

  constructor(private readonly ctx: SettingsContext) {
    this.form.addEventListener('submit', (e) => this.submit(e));
    document.getElementById('settings-node-copy')!.addEventListener('click', (e) =>
      this.ctx.copyFromInput(e.currentTarget as HTMLElement, 'settings-node-link'),
    );
    document.getElementById('settings-node-close')!.addEventListener('click', () => this.hideResult());
    this.list.addEventListener('click', (e) => this.onClick(e));
  }

  async load(): Promise<void> {
    this.list.innerHTML = '';

    try {
      const nodes = await this.ctx.fetch<any[]>('/api/admin/nodes');
      const active = Array.isArray(nodes) ? nodes.filter((n) => !n.revoked) : [];

      if (active.length === 0) {
        this.list.innerHTML =
          '<li class="text-sm text-ink-500">' + t('settingsNoNodes') + '</li>';

        return;
      }

      this.list.innerHTML = active
        .map((n) => {
          const created = n.created_at ? t('createdShort', shareFormatDate(n.created_at)) : '';
          const nameEsc = escapeHtml(n.name || '');
          const pathEsc = escapeHtml(n.path || '');

          return (
            '<li class="admin-row bg-navy-900 border subtle-border rounded p-3 text-sm">' +
            '<div class="flex-1 min-w-0">' +
            '<div class="text-ink-100 font-medium font-mono truncate" title="' +
            nameEsc +
            '">' +
            nameEsc +
            '</div>' +
            '<div class="text-ink-300 font-mono text-xs truncate mt-0.5" title="' +
            pathEsc +
            '">' +
            pathEsc +
            '</div>' +
            '<div class="text-ink-500 text-xs mt-0.5">' +
            escapeHtml(created) +
            '</div>' +
            '</div>' +
            '<div class="admin-row__actions">' +
            '<button class="settings-node-relink px-3 py-1.5 text-sm bg-navy-700 hover:bg-navy-600 text-ink-200 rounded" data-name="' +
            nameEsc +
            '" data-path="' +
            pathEsc +
            '" title="' +
            escapeHtml(t('settingsNodeRelinkTitle')) +
            '">' +
            t('settingsNodeRelink') +
            '</button>' +
            '<button class="settings-node-revoke px-3 py-1.5 text-sm bg-navy-700 hover:bg-rose-500/30 hover:text-rose-300 text-ink-200 rounded" data-name="' +
            nameEsc +
            '">' +
            t('revoke') +
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

  // Opens with the path pre-filled, suggesting a node name (from the tree's "share as node" button).
  prefill(path: string): void {
    this.hideResult();
    const pathEl = document.getElementById('settings-node-path') as HTMLInputElement | null;
    const nameEl = document.getElementById('settings-node-name') as HTMLInputElement | null;

    if (pathEl) pathEl.value = path;

    if (nameEl) {
      nameEl.value = suggestNodeName(path);
      nameEl.focus();
      nameEl.select();
    }
  }

  private async publishNode(name: string, path: string): Promise<void> {
    // One-time display: the link (which carries the token) NEVER comes back after.
    const data = await this.ctx.fetch<any>('/api/admin/nodes', {
      method: 'POST',
      body: JSON.stringify({ name, path }),
    });

    (document.getElementById('settings-node-link') as HTMLInputElement).value = data.link || '';
    this.result.classList.remove('hidden');
    this.load();
  }

  private async submit(e: Event): Promise<void> {
    e.preventDefault();
    this.ctx.clearError();
    const name = (document.getElementById('settings-node-name') as HTMLInputElement).value.trim();
    const path = (document.getElementById('settings-node-path') as HTMLInputElement).value.trim();

    if (!name || !path) return;

    try {
      await this.publishNode(name, path);
      this.form.reset();
    } catch (err) {
      this.ctx.showError((err as Error).message);
    }
  }

  private hideResult(): void {
    this.result.classList.add('hidden');
    (document.getElementById('settings-node-link') as HTMLInputElement).value = '';
  }

  private async onClick(e: Event): Promise<void> {
    const relinkBtn = this.ctx.hit(e, '.settings-node-relink');

    if (relinkBtn) {
      // Re-publishing regenerates the token (old link dies), but it's the only way to get a
      // copyable link back — hence the warning.
      const ok = await confirmDialog({
        title: t('settingsNodeRelinkTitle'),
        message: t('settingsNodeRelinkMsg', relinkBtn.dataset.name),
        confirmLabel: t('settingsNodeRelink'),
      });

      if (!ok) return;

      try {
        await this.publishNode(relinkBtn.dataset.name || '', relinkBtn.dataset.path || '');
      } catch (err) {
        this.ctx.showError((err as Error).message);
      }

      return;
    }

    const revokeBtn = this.ctx.hit(e, '.settings-node-revoke');

    if (!revokeBtn || !revokeBtn.dataset.name) return;
    const ok = await confirmDialog({
      title: t('settingsRevokeNodeTitle'),
      message: t('settingsRevokeNodeMsg', revokeBtn.dataset.name),
      confirmLabel: t('revoke'),
      destructive: true,
    });

    if (!ok) return;

    try {
      await this.ctx.fetch('/api/admin/nodes', {
        method: 'DELETE',
        body: JSON.stringify({ name: revokeBtn.dataset.name }),
      });
      this.load();
    } catch (err) {
      this.ctx.showError((err as Error).message);
    }
  }
}
