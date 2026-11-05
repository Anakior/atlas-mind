// The menu's navigation. Accueil opens the home, the gear the Settings page; Inbox, Journal and Récents open their panel over the
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
  const role = t(me.role === 'admin' ? 'settingsRoleAdmin' : 'settingsRoleViewer');

  document.getElementById('user-email')!.textContent = me.name || me.email;
  document.getElementById('user-sub')!.textContent = me.name ? role + ' · ' + me.email : role;
  showFaces(avatarSeed(me.first_name, me.last_name, me.email));
  document.getElementById('user-bar')!.classList.remove('hidden');
}

// One render per place: an avatar's gradients go by id, and a copy finds them in its twin, which
// draws nothing while the folded menu's button is hidden. The seed stays on the card for the
// other places that show this account (the Settings hero).
function showFaces(seed: string): void {
  const avatar = document.getElementById('user-avatar')!;

  avatar.dataset.seed = seed;
  avatar.innerHTML = constellationSvg(seed, 30);
  document.getElementById('side-me-btn')!.innerHTML = constellationSvg(seed, 30);
}

// On a mind on this computer there is no account: the card says where it runs and keeps the gear
// (Settings) and the export; no sign-out.
export function showLocal(): void {
  document.body.classList.add('local-mode');
  document.getElementById('user-email')!.textContent = t('localName');
  document.getElementById('user-sub')!.textContent = t('localSub');
  showFaces(avatarSeed('', '', location.host));
  document.getElementById('user-bar')!.classList.remove('hidden');
}

class SideNav {
  private readonly links = Array.from(document.querySelectorAll<HTMLElement>('.side-link[data-nav]'));

  constructor() {
    const foot = document.querySelector<HTMLElement>('.side-foot')!;

    if (IS_OFFLINE_BUILD) this.links.find((a) => a.dataset.nav === 'inbox')?.remove();
    this.links.forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      this.go(a.dataset.nav!);
    }));
    document.addEventListener('atlas:doc-rendered', () => this.light(false));
    window.addEventListener('atlas:home', () => this.light(true));
    window.addEventListener('atlas:settings', () => {
      this.light(false);
      foot.classList.remove('is-open');
      if (layoutChrome.isMobile()) document.body.classList.remove('sidebar-open');
    });
    document.getElementById('side-search-btn')!.addEventListener('click', () => commandPalette.open());

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
      homeView.goHome();
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
