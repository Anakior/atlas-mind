// The menu's navigation. Accueil opens the home; Inbox, Journal and Récents open their panel over the
// page (home/side-panels.ts), the way Tâches opens its own; The Mind and Tâches are the #graph-btn and
// #tasks-btn buttons, wired by their own modules. Accueil is lit while the home is on screen. Folded to
// its column, the menu adds what its labels and lists gave: search opens the palette, Dossiers the
// folder panel, the avatar the account card (the glass foot, shown as a popover).

import { IS_OFFLINE_BUILD } from '../core/data-csrf';
import { t } from '../core/i18n';
import { avatarSeed, constellationSvg } from '../ui/avatar';
import { homeView } from './home-view';
import { layoutChrome } from './layout-chrome';
import { sidePanels, type SidePanel } from './side-panels';
import { commandPalette } from '../graph/command-palette';

// The account card at the menu's foot, and the folded menu's avatar: who is signed in. Shown at
// boot, and again when the person changes their name.
export function showAccount(me: MeAuthenticated): void {
  const face = constellationSvg(avatarSeed(me.first_name, me.last_name, me.email), 30);
  const role = t(me.role === 'admin' ? 'settingsRoleAdmin' : 'settingsRoleViewer');

  document.getElementById('user-email')!.textContent = me.name || me.email;
  document.getElementById('user-sub')!.textContent = me.name ? role + ' · ' + me.email : role;
  const avatar = document.getElementById('user-avatar');

  if (avatar) avatar.innerHTML = face;
  document.getElementById('side-me-btn')!.innerHTML = face;
  document.getElementById('user-bar')!.classList.remove('hidden');
}

// On a mind on this computer there is no account: the card says where it runs and keeps the gear
// (Settings) and the export; no sign-out.
export function showLocal(): void {
  const face = constellationSvg(avatarSeed('', '', location.host), 30);

  document.body.classList.add('local-mode');
  document.getElementById('user-email')!.textContent = t('localName');
  document.getElementById('user-sub')!.textContent = t('localSub');
  document.getElementById('user-avatar')!.innerHTML = face;
  document.getElementById('side-me-btn')!.innerHTML = face;
  document.getElementById('user-bar')!.classList.remove('hidden');
}

class SideNav {
  private readonly links = Array.from(document.querySelectorAll<HTMLElement>('.side-link[data-nav]'));

  constructor() {
    if (IS_OFFLINE_BUILD) this.links.find((a) => a.dataset.nav === 'inbox')?.remove();
    this.links.forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      this.go(a.dataset.nav!);
    }));
    document.addEventListener('atlas:doc-rendered', () => this.light(false));
    window.addEventListener('atlas:home', () => this.light(true));
    document.getElementById('side-search-btn')!.addEventListener('click', () => commandPalette.open());

    const foot = document.querySelector<HTMLElement>('.side-foot')!;

    document.getElementById('side-me-btn')!.addEventListener('click', (e) => {
      e.stopPropagation();
      foot.classList.toggle('is-open');
    });
    document.addEventListener('click', (e) => {
      if (!foot.contains(e.target as Node)) foot.classList.remove('is-open');
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') foot.classList.remove('is-open');
    });
  }

  private go(where: string): void {
    if (where === 'home') {
      sidePanels.close();
      homeView.showWelcome();
      history.replaceState(null, '', location.pathname);
    } else {
      sidePanels.open(where as SidePanel);
    }
    if (layoutChrome.isMobile()) document.body.classList.remove('sidebar-open');
  }

  private light(home: boolean): void {
    this.links.forEach((a) => a.classList.toggle('is-on', home && a.dataset.nav === 'home'));
  }
}

export const sideNav = new SideNav();
