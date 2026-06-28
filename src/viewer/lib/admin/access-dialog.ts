// ── Access & sharing (per-document ACL) ──────────────────────────────────────
// The "Accès" button on a doc opens a dialog to see/own/share it with users,
// groups, or everyone — backed by /api/acl. Read-only for a non-manager.

import { meState } from '../core/data-csrf';
import { t } from '../core/i18n';
import { setStatus } from '../core/net';
import { currentFile } from '../core/state';
import { escapeHtml } from '../core/utils';
import { Dialogs } from '../modals/dialogs';
import { AtlasCombobox } from '../ui/combobox';

export class AccessDialog {
  // ---- static partial DOM (the dialog markup ships as one unit; the backdrop guard above proved
  // it present, so the rest are asserted) ----
  private readonly backdrop = document.getElementById('acl-backdrop')!;
  private readonly pathEl = document.getElementById('acl-path')!;
  private readonly statusEl = document.getElementById('acl-status')!;
  private readonly grantsEl = document.getElementById('acl-grants')!;
  private readonly manageEl = document.getElementById('acl-manage')!;
  private readonly form = document.getElementById('acl-grant-form')!;
  private readonly kindSel = document.getElementById('acl-kind') as HTMLSelectElement;
  private readonly valueInp = document.getElementById('acl-value') as HTMLInputElement;
  private readonly levelSel = document.getElementById('acl-level') as HTMLSelectElement;
  private readonly errEl = document.getElementById('acl-error')!;

  // ---- state ----
  private cur: AclState | null = null;
  private dir: { users: string[]; groups: string[] } | null = null; // /api/directory, cached for autocompletion

  // The value field is a creatable combobox: pick a known user/group OR type a new one. Its source
  // flips with the kind select (users vs groups) → refresh() on change. Created once on the permanent
  // partial input and never torn down.
  private readonly aclCb = AtlasCombobox(this.valueInp, {
    source: () => (this.kindSel.value === 'group' ? (this.dir && this.dir.groups) || [] : (this.dir && this.dir.users) || []),
    creatable: true,
  });

  constructor() {
    this.wire();
  }

  private async loadDir(): Promise<{ users: string[]; groups: string[] }> {
    if (!this.dir) {
      try {
        const r = await fetch('/api/directory');

        if (r.ok) this.dir = await r.json();
      } catch (_) {
        /* best-effort */
      }
    }

    return this.dir || { users: [], groups: [] };
  }

  private myPrincipal(): string | null {
    return meState && meState.authenticated && meState.email ? 'user:' + meState.email : null;
  }

  private principalLabel(p: string): string {
    if (p === '*') return '🌐 ' + t('aclEveryone');
    if (p.startsWith('user:')) return '👤 ' + p.slice(5);
    if (p.startsWith('group:')) return '👥 ' + p.slice(6);
    if (p.startsWith('anon:')) return '🔗 ' + t('aclLinkPrincipal');

    return p;
  }

  private levelLabel(l: string): string {
    if (l === 'edit') return t('aclLevelEdit');
    if (l === 'comment') return t('aclLevelComment');

    return t('aclLevelView');
  }

  private render(): void {
    const cur = this.cur!;

    this.pathEl.textContent = cur.path;

    if (cur.owner) {
      const mine = this.myPrincipal();
      const who = mine && cur.owner === mine
        ? t('aclYou')
        : cur.owner.startsWith('user:') ? cur.owner.slice(5) : cur.owner;

      this.statusEl.innerHTML =
        '<span class="text-amber-300 font-medium">' + escapeHtml(t('aclPrivate')) + '</span> · ' +
        escapeHtml(t('aclOwner')) + ' ' + escapeHtml(who);
    } else {
      this.statusEl.innerHTML =
        '<span class="text-emerald-300 font-medium">' + escapeHtml(t('aclCommons')) + '</span>';
    }

    if (cur.creator) {
      const mine = this.myPrincipal();
      const who = mine && cur.creator === mine
        ? t('aclYou')
        : cur.creator.startsWith('user:') ? cur.creator.slice(5) : cur.creator;

      this.statusEl.innerHTML +=
        ' <span class="text-ink-500">· ' + escapeHtml(t('aclCreatedBy')) + ' ' + escapeHtml(who) + '</span>';
    }

    const grants = cur.grants || [];

    this.grantsEl.innerHTML = grants.length
      ? grants
          .map(
            (g) =>
              '<li class="flex items-center justify-between gap-2 bg-navy-900 border subtle-border rounded px-2.5 py-1.5 text-xs">' +
              '<span class="truncate text-ink-200">' +
              escapeHtml(this.principalLabel(g.principal)) +
              ' · <span class="text-ink-400">' +
              escapeHtml(this.levelLabel(g.level)) +
              '</span></span>' +
              (cur.can_manage
                ? '<button class="acl-revoke text-ink-500 hover:text-rose-300 px-1 flex-shrink-0" data-principal="' +
                  escapeHtml(g.principal) +
                  '" title="' +
                  escapeHtml(t('aclRemove')) +
                  '">✕</button>'
                : '') +
              '</li>',
          )
          .join('')
      : '<li class="text-[11px] text-ink-500">' + escapeHtml(t('aclNoGrants')) + '</li>';

    this.manageEl.classList.toggle('hidden', !cur.can_manage);
    this.errEl.classList.add('hidden');
  }

  private async refresh(): Promise<void> {
    const res = await fetch('/api/acl?path=' + encodeURIComponent(this.cur!.path));

    if (res.ok) {
      this.cur = await res.json();
      this.render();
    }
  }

  async openAccessFor(path: string): Promise<void> {
    if (!path) return;

    try {
      const res = await fetch('/api/acl?path=' + encodeURIComponent(path));

      if (!res.ok) return; // not readable → nothing to show
      this.cur = await res.json();
      this.kindSel.value = 'user';
      document.getElementById('acl-value-wrap')!.classList.remove('hidden');
      this.aclCb.clear();
      this.render();
      this.backdrop.classList.remove('hidden');
      this.loadDir().then(() => this.aclCb.refresh());
    } catch (_) {
      /* best-effort */
    }
  }

  private close(): void {
    this.backdrop.classList.add('hidden');
  }

  private async post(body: { path: string; action: 'grant' | 'revoke' | 'set_owner' | 'make_commons'; principal?: string; level?: string }): Promise<boolean> {
    this.errEl.classList.add('hidden');

    const res = await fetch('/api/acl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const p = await res.json().catch(() => null);

      this.errEl.textContent = (p && p.error) || 'HTTP ' + res.status;
      this.errEl.classList.remove('hidden');

      return false;
    }

    await this.refresh();

    return true;
  }

  private wire(): void {
    document.getElementById('btn-access')?.addEventListener('click', () => {
      if (currentFile) this.openAccessFor(currentFile.path);
    });
    document.getElementById('acl-close')!.addEventListener('click', () => this.close());
    document.getElementById('acl-close-x')?.addEventListener('click', () => this.close());
    this.backdrop.addEventListener('click', (e) => {
      if (e.target === this.backdrop) this.close();
    });

    this.kindSel.addEventListener('change', () => {
      document.getElementById('acl-value-wrap')!.classList.toggle('hidden', this.kindSel.value === '*');
      this.aclCb.refresh();
    });

    this.form.addEventListener('submit', async (e) => {
      e.preventDefault();
      let principal: string;

      if (this.kindSel.value === '*') {
        principal = '*';
      } else {
        const v = this.aclCb.getValue();

        if (!v) return;
        principal = this.kindSel.value + ':' + (this.kindSel.value === 'user' ? v.toLowerCase() : v);
      }

      if (await this.post({ path: this.cur!.path, action: 'grant', principal, level: this.levelSel.value })) {
        this.aclCb.clear();
        setStatus(t('aclSharedToast'), 'ok');
      }
    });

    this.grantsEl.addEventListener('click', async (e) => {
      const btn = (e.target as HTMLElement).closest('.acl-revoke') as HTMLElement | null;

      if (btn && (await this.post({ path: this.cur!.path, action: 'revoke', principal: btn.dataset.principal }))) {
        setStatus(t('aclRevokedToast'), 'ok');
      }
    });

    document.getElementById('acl-make-private')!.addEventListener('click', async () => {
      const mine = this.myPrincipal();

      if (mine && (await this.post({ path: this.cur!.path, action: 'set_owner', principal: mine }))) {
        setStatus(t('aclNowPrivateToast'), 'ok');
      }
    });

    document.getElementById('acl-make-commons')!.addEventListener('click', async () => {
      // Destructive: removes the owner AND every grant of this doc → confirm first.
      const ok = await Dialogs.confirm({
        title: t('aclMakeCommons'),
        message: t('aclMakeCommonsConfirm'),
        confirmLabel: t('aclMakeCommons'),
        destructive: true,
      });

      if (ok && (await this.post({ path: this.cur!.path, action: 'make_commons' }))) {
        setStatus(t('aclNowCommonsToast'), 'ok');
      }
    });
  }
}

// Offline builds ship without the dialog partial → no backdrop. Only wire up the dialog when the partial
// is present; otherwise it stays undefined (consumers guard on it).
if (document.getElementById('acl-backdrop')) {
  const dialog = new AccessDialog();
  // The tree (02-content-tree.ts) opens the dialog through this global; keep it exposed from the instance.
  window.openAccessFor = (path) => dialog.openAccessFor(path);
}
