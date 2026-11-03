// ── Settings panel (admin + cloud mode) ──────────────────────────────────────
// Thin shell over the per-pane controllers (./*-tab.ts): owns the user-bar gear, open/close, and the
// sections (SECTIONS), each stacking its panes. Each pane's lists/forms/fetches live in its own
// controller; the shell builds the shared SettingsContext, constructs the controllers, and dispatches
// open() → selectTab() → the section's loads, revealed together.
//
// Every per-tab controller class is imported above, so all are in scope when `new SettingsPanel()`
// constructs them (the single instance is created at the bottom of this module).

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
import { SettingsAppearance } from './appearance-tab';
import { SettingsCopies } from './copies-tab';
import { SettingsPhone } from './phone-pane';

// A tab slower than this shows the loading placeholder; faster ones swap straight in. Once shown,
// the placeholder stays long enough to read as a state rather than a flicker.
const PLACEHOLDER_DELAY_MS = 300;
const PLACEHOLDER_MIN_MS = 300;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The sections and the panes each stacks, in order; a stacked pane without its own heading wears one.
const SECTIONS: Record<string, string[]> = {
  me: ['security'],
  atlas: ['phone', 'copies'],
  ai: ['tokens'],
  hive: ['nodes'],
  shares: ['shares'],
  team: ['users', 'groups'],
  appearance: ['appearance'],
};
const PANE_TITLES: Record<string, string> = { users: 'settingsTabUsers', groups: 'settingsTabGroups' };

export class SettingsPanel {
  private readonly settingsBtn = document.getElementById('settings-btn')!;
  private readonly settingsBackdrop = document.getElementById('settings-backdrop')!;
  private readonly settingsClose = document.getElementById('settings-close')!;
  private readonly panel = document.getElementById('settings-panel')!;
  private readonly body = document.getElementById('settings-body')!;
  private readonly content = document.getElementById('settings-content')!;
  // The height the panel is pinned at; 0 while closed, so opening snaps instead of gliding.
  private pinnedHeight = 0;
  private activeTab = '';
  private loading = false;

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
  private readonly appearance = new SettingsAppearance(this.ctx);
  private readonly copies = new SettingsCopies(this.ctx);
  private readonly phone = new SettingsPhone();

  constructor() {
    this.settingsBtn.addEventListener('click', () => this.open());
    this.settingsClose.addEventListener('click', () => this.close());
    this.settingsBackdrop.addEventListener('click', (e) => {
      if (e.target === this.settingsBackdrop) this.close();
    });
    document.querySelectorAll<HTMLElement>('.settings-tab').forEach((tab) => {
      tab.addEventListener('click', () => this.selectTab(tab.dataset.tab!));
    });
    for (const [pane, key] of Object.entries(PANE_TITLES)) {
      document.getElementById('settings-pane-' + pane)!.dataset.title = t(key);
    }
    new ResizeObserver(() => this.followContentHeight()).observe(this.content);
  }

  // ── height: sized to the content, gliding instead of jumping ──
  // A ResizeObserver runs after layout but before paint, and the panel keeps the px height it was
  // last pinned at: a tab switch or a list arriving never shows the jump, the CSS transition
  // (05-admin.css) carries the panel to its new height. Mobile is full screen (!important wins).
  private followContentHeight(): void {
    if (this.settingsBackdrop.classList.contains('hidden')) return;
    // While a tab loads, the dialog holds its height: it moves once, on the reveal.
    if (this.loading && this.pinnedHeight) return;
    const pad = getComputedStyle(this.body);
    const chrome = this.panel.offsetHeight - this.body.clientHeight;
    const target = Math.ceil(
      chrome + parseFloat(pad.paddingTop) + parseFloat(pad.paddingBottom) + this.content.offsetHeight,
    );

    if (target === this.pinnedHeight) return;

    if (!this.pinnedHeight) {
      this.panel.style.transition = 'none';
      this.panel.style.height = target + 'px';
      void this.panel.offsetHeight; // commit the snap before the transition comes back
      this.panel.style.transition = '';
    } else {
      this.panel.style.height = target + 'px';
    }

    this.pinnedHeight = target;
  }

  // ── error banner (reached cross-module via settingsPanel.showError / clearError) ──
  showError(message: string): void {
    this.ctx.showError(message);
  }

  clearError(): void {
    this.ctx.clearError();
  }

  // ── open / close / tabs ──
  // A tab is revealed whole: every fetch it needs settles first (Nodes waits for both of its
  // lists), so it never pieces itself together in several moves. Meanwhile the previous pane
  // stays up; past PLACEHOLDER_DELAY_MS a placeholder takes its place at the same height.
  open(): void {
    this.tokens.hideResult();
    // Nothing stale: the dialog appears with its first tab loaded, or with the placeholder.
    this.showPane(null);
    // Everyone lands on Me (the per-account section, first in the bar); admin-only sections are
    // one click away. The update check rides along with the first reveal when it answers quickly.
    const local = document.body.classList.contains('local-mode');
    const isAdmin = local || document.body.classList.contains('admin-cloud');
    const banner = isAdmin ? this.refreshUpdateBanner() : Promise.resolve();

    // Shares is a tab only while share links exist (and a link from this computer opens nowhere).
    if (isAdmin && !local) {
      void this.shares.load().then((count) =>
        document.querySelector('.settings-tab[data-tab="shares"]')!.classList.toggle('hidden', !count));
    }

    this.selectTab(local ? 'ai' : 'me', Promise.race([banner, wait(600)]));
  }

  close(): void {
    this.settingsBackdrop.classList.add('hidden');
    this.activeTab = '';
    this.pinnedHeight = 0;
    this.panel.style.height = '';
  }

  // Opens Settings → Hive with the path pre-filled (from the tree button). Called from the tree's
  // "share as node" button in content/content-tree.ts via settingsPanel.openPublish().
  openPublish(path: string): void {
    this.open();
    this.selectTab('hive');
    this.nodes.prefill(path);
  }

  private async selectTab(
    name: string,
    alongside: Promise<unknown> = Promise.resolve(),
  ): Promise<void> {
    this.activeTab = name;
    this.loading = true;
    document.querySelectorAll<HTMLElement>('.settings-tab').forEach((tab) => {
      tab.classList.toggle('is-active', tab.dataset.tab === name);
    });
    this.ctx.clearError();
    let placeholderShownAt = 0;
    const placeholder = setTimeout(() => {
      if (this.activeTab !== name) return;
      this.showPane('loading');
      placeholderShownAt = performance.now();
    }, PLACEHOLDER_DELAY_MS);

    await Promise.all([this.loadTab(name), alongside]);
    clearTimeout(placeholder);

    if (placeholderShownAt) await wait(PLACEHOLDER_MIN_MS - (performance.now() - placeholderShownAt));

    if (this.activeTab !== name) return; // moved to another tab (or closed) meanwhile
    this.loading = false;
    this.showPane(name);
  }

  private loadTab(name: string): Promise<unknown> {
    if (name === 'atlas') {
      this.phone.load();

      return this.copies.load();
    }
    if (name === 'ai') return this.tokens.load();
    if (name === 'hive') return Promise.all([this.nodes.load(), this.remotes.load()]);
    if (name === 'shares') return this.shares.load();
    if (name === 'appearance') return this.appearance.load();
    if (name === 'team') {
      // Groups are for sorting several people: alone on the Atlas, only the invitation shows.
      return Promise.all([this.users.load(), this.groups.load()]).then(([count]) =>
        document.getElementById('settings-pane-groups')!.toggleAttribute('data-solo', count < 2));
    }
    securityPane.refreshState();

    return this.profile.load();
  }

  /** Shows a section's panes (or the loading placeholder, or nothing), and the dialog with them. */
  private showPane(name: string | null): void {
    document.querySelectorAll<HTMLElement>('.settings-pane').forEach((pane) =>
      pane.classList.add('hidden'));

    if (!name) return;
    const panes = SECTIONS[name] || [name];

    panes.forEach((id, i) => {
      const pane = document.getElementById('settings-pane-' + id)!;

      pane.classList.toggle('hidden', pane.hasAttribute('data-solo'));
      pane.classList.toggle('stacked', panes.length > 1);
      pane.classList.toggle('stacked-next', i > 0);
      pane.style.order = String(i + 1);
    });
    this.settingsBackdrop.classList.remove('hidden');
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
