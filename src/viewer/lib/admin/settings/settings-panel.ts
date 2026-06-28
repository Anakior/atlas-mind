// ── Settings panel (admin + cloud mode) ──────────────────────────────────────
// Thin shell over the seven per-tab controllers (16b…16h): owns the user-bar gear, open/close, and
// the tab switch. Each tab's lists/forms/fetches live in its own controller; the shell just builds
// the shared SettingsContext, constructs the controllers, and dispatches open() → selectTab() →
// the active tab's load().
//
// Concatenated LAST in the 16x family (16z sorts after 16b…16h) so every controller class is already
// in scope when `new SettingsPanel()` constructs them — class declarations do not hoist.

import { t } from '../../core/i18n';
import { securityPane } from '../totp/security-pane';
import { SettingsContext } from './settings-shared';
import { SettingsUsers } from './users-tab';
import { SettingsTokens } from './tokens-tab';
import { SettingsShares } from './shares-tab';
import { SettingsNodes } from './nodes-tab';
import { SettingsRemotes } from './remotes-tab';
import { SettingsGroups } from './groups-tab';
import { SettingsProfile } from './profile-tab';

export class SettingsPanel {
  private readonly settingsBtn = document.getElementById('settings-btn')!;
  private readonly settingsBackdrop = document.getElementById('settings-backdrop')!;
  private readonly settingsClose = document.getElementById('settings-close')!;

  // Shared services + the seven tab controllers. ctx is declared first so the controller field
  // initializers below can read it.
  private readonly ctx = new SettingsContext();
  private readonly users = new SettingsUsers(this.ctx);
  private readonly tokens = new SettingsTokens(this.ctx);
  private readonly shares = new SettingsShares(this.ctx);
  private readonly nodes = new SettingsNodes(this.ctx);
  private readonly remotes = new SettingsRemotes(this.ctx);
  private readonly groups = new SettingsGroups(this.ctx);
  private readonly profile = new SettingsProfile(this.ctx);

  constructor() {
    this.settingsBtn.addEventListener('click', () => this.open());
    this.settingsClose.addEventListener('click', () => this.close());
    this.settingsBackdrop.addEventListener('click', (e) => {
      if (e.target === this.settingsBackdrop) this.close();
    });
    document.querySelectorAll<HTMLElement>('.settings-tab').forEach((tab) => {
      tab.addEventListener('click', () => this.selectTab(tab.dataset.tab!));
    });
  }

  // ── error banner (called cross-file via the showSettingsError/clearSettingsError wrappers) ──
  showError(message: string): void {
    this.ctx.showError(message);
  }

  clearError(): void {
    this.ctx.clearError();
  }

  // ── open / close / tabs ──
  open(): void {
    this.tokens.hideResult();
    this.settingsBackdrop.classList.remove('hidden');
    // Everyone lands on Profile (the per-account tab, first in the bar); admin-only tabs are one
    // click away.
    const isAdmin = document.body.classList.contains('admin-cloud');

    this.selectTab('security');

    if (isAdmin) this.refreshUpdateBanner();
  }

  close(): void {
    this.settingsBackdrop.classList.add('hidden');
  }

  // Opens Settings → Nodes with the path pre-filled (from the tree button). Called cross-file via
  // the openPublishNode wrapper (02-content-tree.ts).
  openPublish(path: string): void {
    this.open();
    this.selectTab('nodes');
    this.nodes.prefill(path);
  }

  private selectTab(name: string): void {
    document.querySelectorAll<HTMLElement>('.settings-tab').forEach((tab) => {
      tab.classList.toggle('is-active', tab.dataset.tab === name);
    });
    document.querySelectorAll('.settings-pane').forEach((pane) => {
      pane.classList.add('hidden');
    });
    document.getElementById('settings-pane-' + name)!.classList.remove('hidden');
    this.ctx.clearError();

    if (name === 'users') this.users.load();
    else if (name === 'tokens') this.tokens.load();
    else if (name === 'shares') this.shares.load();
    else if (name === 'nodes') {
      this.nodes.load();
      this.remotes.load();
    } else if (name === 'groups') this.groups.load();
    else if (name === 'security') {
      securityPane.refreshState();
      this.profile.load();
    }
  }

  // Admin-only, best-effort: never block Settings if the check fails/offline.
  private async refreshUpdateBanner(): Promise<void> {
    const banner = document.getElementById('settings-update-banner') as HTMLAnchorElement | null;

    if (!banner) return;
    banner.classList.add('hidden');

    try {
      const data = await this.ctx.fetch<any>('/api/admin/update-check');

      if (data && data.update_available && data.latest) {
        banner.textContent = t('settingsUpdateAvailable')
          .replace('{latest}', data.latest)
          .replace('{current}', data.current || '?');
        banner.href = data.url || 'https://pypi.org/project/atlas-mind/';
        banner.classList.remove('hidden');
      }
    } catch (_) {
      /* best-effort */
    }
  }
}

export const settingsPanel = new SettingsPanel();
