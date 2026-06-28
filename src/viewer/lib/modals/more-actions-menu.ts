// Kebab "More actions" menu (btn-more) — the per-doc rename / move / delete dropdown. It owns only the
// menu chrome (toggle + outside-click dismiss) and the delete-doc fetch; rename and move are delegated to
// RenameModal via renameModal.open(...). The element handles (btnMore, btnMoreMenu) and the renameModal
// instance live in 14-dialogs.ts, concatenated first, so both exist when this wires up and dispatches.
class MoreActionsMenu {
  constructor() {
    btnMore!.addEventListener('click', (e) => {
      e.stopPropagation();
      btnMoreMenu!.classList.toggle('hidden');
    });
    document.addEventListener('click', () => btnMoreMenu!.classList.add('hidden'));
    btnMoreMenu!.addEventListener('click', (e) => this.onMenuClick(e));
  }

  private async onMenuClick(e: Event): Promise<void> {
    const btn = (e.target as HTMLElement).closest('button[data-action]') as HTMLElement | null;

    if (!btn) return;
    btnMoreMenu!.classList.add('hidden');
    const action = btn.dataset.action;

    if (action === 'rename') {
      renameModal.open('rename');

      return;
    }

    if (action === 'move') {
      renameModal.open('move');

      return;
    }

    if (action === 'delete') {
      const ok = await Dialogs.confirm({
        title: t('deleteDocTitle'),
        message: t('deleteDocMsg', currentFile!.path),
        confirmLabel: t('del'),
        destructive: true,
      });

      if (!ok) return;

      try {
        const res = await fetch('/api/file', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: currentFile!.path }),
        });

        if (!res.ok) throw new Error('HTTP ' + res.status);
        location.hash = '';
        setStatus(t('docDeleted'), 'ok');
        await refreshTreeOrReload();
      } catch (err) {
        Dialogs.notifyError('err', (err as Error).message);
      }
    }
  }
}

const moreActionsMenu = new MoreActionsMenu();
