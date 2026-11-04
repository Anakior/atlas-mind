// ── Settings page ───────────────────────────────────────────────────────────
// A page of the viewer at #settings/<section>, shown in place of the content: a hero with the sections
// as tabs, then the section's cards. Thin shell over the per-pane controllers (./*-tab.ts): it
// owns the gear, the route and the sections (SECTIONS), each stacking its panes; each pane's
// lists/forms/fetches live in its own controller. Any other view written into #content (a doc, the
// home, a tag) takes the page's place.

import { t } from '../../core/i18n';
import { contentEl, breadcrumbPath, breadcrumbDate, breadcrumbActions, tocPanel } from '../../core/dom-refs';
import { setCurrentFile } from '../../core/state';
import { tocShow } from '../../home/layout-chrome';
import { constellationSvg } from '../../ui/avatar';
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
import { SettingsAbout } from './about-tab';

// A section slower than this shows the loading placeholder; faster ones swap straight in. Once shown,
// the placeholder stays long enough to read as a state rather than a flicker.
const PLACEHOLDER_DELAY_MS = 300;
const PLACEHOLDER_MIN_MS = 300;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The sections and the panes whose cards each shows.
const SECTIONS: Record<string, string[]> = {
  account: ['profile', 'security'],
  atlas: ['phone', 'copies'],
  ai: ['tokens'],
  hive: ['nodes'],
  shares: ['shares'],
  team: ['users', 'groups'],
  appearance: ['appearance'],
  about: ['about'],
};
const ROUTE = /^#?settings(?:\/(\w+))?$/;

export class SettingsPage {
  private readonly settingsBtn = document.getElementById('settings-btn')!;
  private readonly page = document.getElementById('settings-page')!;
  private readonly tabs = Array.from(this.page.querySelectorAll<HTMLAnchorElement>('.settings-tab'));
  private activeTab = '';
  private updateLatest = ''; // a newer version on PyPI (checkUpdate), '' when none

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
  private readonly about = new SettingsAbout(this.ctx);

  constructor() {
    // The partials follow the shell: the page belongs in <main>, beside the content it stands in for.
    contentEl.after(this.page);
    this.settingsBtn.addEventListener('click', () => this.open());
    document.getElementById('settings-update-banner')!.addEventListener('click', () => this.open('about'));
    this.tabs.forEach((tab) =>
      tab.addEventListener('click', (e) => {
        e.preventDefault();
        this.open(tab.dataset.tab!);
      }));
    new MutationObserver(() => {
      if (this.isOpen() && contentEl.firstChild) this.leave();
    }).observe(contentEl, { childList: true });
    // Back and forward between sections, and from the page back to a doc.
    window.addEventListener('hashchange', () => {
      if (ROUTE.test(location.hash)) this.route(location.hash);
      else if (this.isOpen()) window.dispatchEvent(new Event('atlas:route'));
    });
  }

  isOpen(): boolean {
    return !this.page.classList.contains('hidden');
  }

  /** The page for a #settings[/section] hash; false when the hash is something else. */
  route(hash: string): boolean {
    const m = ROUTE.exec(hash);

    if (!m) return false;
    this.show(m[1] || '');

    return true;
  }

  open(section = ''): void {
    const target = this.visible(section) ? section : this.defaultSection();

    if (location.hash !== '#settings/' + target) history.pushState(null, '', '#settings/' + target);
    this.show(target);
  }

  // Opens Hive with the path pre-filled (the tree's "share as node" button).
  openPublish(path: string): void {
    this.open('hive');
    this.nodes.prefill(path);
  }

  showError(message: string): void {
    this.ctx.showError(message);
  }

  clearError(): void {
    this.ctx.clearError();
  }

  private defaultSection(): string {
    return document.body.classList.contains('local-mode') ? 'ai' : 'account';
  }

  // A section the nav hides from this account (a member's Team, Shares without links) is not one to land on.
  private visible(section: string): boolean {
    const tab = this.tabs.find((a) => a.dataset.tab === section);

    return !!tab && !tab.classList.contains('hidden') && getComputedStyle(tab).display !== 'none';
  }

  private show(section: string): void {
    if (!this.visible(section)) section = this.defaultSection();
    if (this.isOpen() && section === this.activeTab) return; // a reload while it is up keeps the forms as typed
    if (!this.isOpen()) this.enter();
    void this.selectTab(section);
  }

  private enter(): void {
    setCurrentFile(null);
    contentEl.replaceChildren();
    contentEl.classList.add('hidden');
    this.page.classList.remove('hidden');
    this.settingsBtn.classList.add('is-on');
    document.querySelector('main')!.scrollTop = 0;
    breadcrumbPath.textContent = '/';
    breadcrumbDate.textContent = '';
    breadcrumbActions.classList.add('hidden');
    breadcrumbActions.classList.remove('flex');
    tocPanel.classList.add('hidden');
    tocPanel.classList.remove('flex');
    tocShow.classList.add('hidden');
    this.tokens.hideResult();
    this.showWho();
    window.dispatchEvent(new Event('atlas:settings'));

    const local = document.body.classList.contains('local-mode');

    if (local || document.body.classList.contains('admin-cloud')) void this.checkUpdate();
    // Shares is a section only while share links exist (and a link from this computer opens nowhere).
    if (!local && document.body.classList.contains('admin-cloud')) {
      void this.shares.load().then((count) =>
        this.tabs.find((a) => a.dataset.tab === 'shares')!.classList.toggle('hidden', !count));
    }
  }

  // Whoever the menu's account card shows (side-nav.ts), at the hero's right.
  private showWho(): void {
    const face = document.createElement('div');
    const text = document.createElement('div');
    const line = (cls: string, from: string) => {
      const el = document.createElement('div');

      el.className = cls;
      el.textContent = document.getElementById(from)!.textContent;

      return el;
    };

    face.className = 'settings-who-av';
    face.innerHTML = constellationSvg(document.getElementById('user-avatar')!.dataset.seed || '', 42);
    text.className = 'min-w-0';
    text.append(line('settings-who-name', 'user-email'), line('settings-who-sub', 'user-sub'));
    document.getElementById('settings-who')!.replaceChildren(face, text);
  }

  private leave(): void {
    this.page.classList.add('hidden');
    contentEl.classList.remove('hidden');
    this.settingsBtn.classList.remove('is-on');
    this.activeTab = '';
  }

  // A section is revealed whole: every fetch it needs settles first (Hive waits for both of its
  // lists), so it never pieces itself together in several moves. Meanwhile the previous section
  // stays up; past PLACEHOLDER_DELAY_MS a placeholder takes its place.
  private async selectTab(name: string): Promise<void> {
    const tab = this.tabs.find((a) => a.dataset.tab === name)!;

    this.activeTab = name;
    this.tabs.forEach((a) => a.classList.toggle('is-on', a === tab));
    tab.scrollIntoView({ block: 'nearest', inline: 'nearest' }); // a narrow tab row scrolls sideways
    this.showUpdateBanner();
    this.ctx.clearError();
    let placeholderShownAt = 0;
    const placeholder = setTimeout(() => {
      if (this.activeTab !== name) return;
      this.showPane('loading');
      placeholderShownAt = performance.now();
    }, PLACEHOLDER_DELAY_MS);

    await this.loadTab(name);
    clearTimeout(placeholder);

    if (placeholderShownAt) await wait(PLACEHOLDER_MIN_MS - (performance.now() - placeholderShownAt));

    if (this.activeTab !== name) return; // moved to another section (or left) meanwhile
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
    if (name === 'about') return this.about.load();
    if (name === 'team') {
      // Groups are for sorting several people: alone on the Atlas, only the invitation shows.
      return Promise.all([this.users.load(), this.groups.load()]).then(([count]) =>
        document.getElementById('settings-pane-groups')!.toggleAttribute('data-solo', count < 2));
    }
    securityPane.refreshState();

    return this.profile.load();
  }

  /** Shows a section's panes (or the loading placeholder). */
  private showPane(name: string): void {
    this.page.querySelectorAll<HTMLElement>('.settings-pane').forEach((pane) => pane.classList.add('hidden'));
    for (const id of SECTIONS[name] || [name]) {
      const pane = document.getElementById('settings-pane-' + id)!;

      pane.classList.toggle('hidden', pane.hasAttribute('data-solo'));
    }
  }

  // Best-effort: never blocks Settings.
  async checkUpdate(): Promise<void> {
    let latest = '';

    try {
      const data = await this.ctx.fetch<any>('/api/admin/update-check');

      if (data?.update_available && data.latest) latest = data.latest;
    } catch (_) {
      /* best-effort */
    }
    this.updateLatest = latest;
    this.settingsBtn.classList.toggle('has-update', !!latest);
    this.showUpdateBanner();
  }

  private showUpdateBanner(): void {
    const banner = document.getElementById('settings-update-banner')!;

    banner.textContent = this.updateLatest ? t('settingsUpdateAvailable', this.updateLatest) : '';
    banner.classList.toggle('hidden', !this.updateLatest || this.activeTab === 'about');
  }
}

export const settingsPage = new SettingsPage();
