// Settings › Copies (admin): copies of the mind the person owns, outside this instance.
// On GitHub: the instance makes its own deploy key; the person creates an empty private repository,
// adds the key with write access and connects: no token, no app to install (routes/github.py).
// On the computer: `git clone <instance>/git` with an access token as the password (routes/git.py).
// Restore: from the zip "Export my notes" made (routes/restore.py), or by taking back the GitHub
// repo that already holds the mind. Computer and restore are for the owner of a mind theirs alone.

import { LANG, t } from '../../core/i18n';
import { escapeHtml, relativeDate, slugify } from '../../core/utils';
import { SITE_NAME, totpEnabled } from '../../core/data-csrf';
import { Dialogs } from '../../modals/dialogs';
import { SettingsContext, SettingsError, copyBox } from './settings-shared';

interface CopiesState {
  remote: string | null;
  key: string | null;
  owner: boolean;
  clone: string | null;
}

interface SyncState {
  status: string;
  unpushed: number;
  last_push_at: number | null;
}

const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const CARD = 'settings-card';
// What a copy is called, on GitHub and on the computer: the notes of this Atlas, never the
// product's own name (a developer already has an `atlas-mind` repository and folder).
const COPY_NAME = (slugify(SITE_NAME) || 'atlas') + '-notes';
const BTN = 'px-3 py-2 text-sm bg-accent hover:brightness-110 text-white rounded-lg font-medium';
const BTN_QUIET = 'px-3 py-1.5 text-xs bg-navy-700 hover:bg-navy-600 text-ink-200 rounded-lg font-medium';
const LINK = 'text-accent hover:underline';
const HEADING = 'text-xs uppercase tracking-wider text-ink-500 font-semibold mb-2';
const HINT = 'text-xs text-ink-500 mt-1 leading-snug';

// "git@github.com:owner/name.git" → "owner/name"; null for a remote elsewhere.
function githubRepo(remote: string): string | null {
  const m = remote.match(/github\.com[:/]+([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/);

  return m ? m[1] : null;
}

function syncLine(sync: SyncState | null): string {
  if (!sync) return '';
  if (sync.status === 'pending') return t('ghPending', sync.unpushed);
  if (sync.last_push_at) return t('ghLastPush', relativeDate(sync.last_push_at));

  return sync.status === 'ok' ? t('ghUpToDate') : '';
}

export class SettingsCopies {
  private readonly pane = document.getElementById('settings-pane-copies')!;
  private repo = '';
  private owner = false;

  constructor(private readonly ctx: SettingsContext) {}

  async load(): Promise<void> {
    try {
      const [state, sync] = await Promise.all([
        this.ctx.fetch<CopiesState>('/api/admin/github'),
        this.ctx.fetch<SyncState>('/api/sync').catch(() => null),
      ]);

      const block = (title: string, name: string) =>
        `<div class="settings-block s-6"><h3 class="${HEADING}">${title}</h3><div data-copies-${name}></div></div>`;

      this.pane.innerHTML =
        block(t('copiesOnGithub'), 'github') +
        block(t('copiesOnComputer'), 'computer') +
        block(t('bkTitle'), 'backup') +
        block(t('copiesRestore'), 'restore');
      this.owner = state.owner;
      if (state.remote) this.renderConnected(state.remote, sync);
      else this.renderSteps(state.key);
      this.renderComputer(state.clone);
      this.renderBackup();
      this.renderRestore();
    } catch (e) {
      this.ctx.showError((e as Error).message);
    }
  }

  private section(name: 'github' | 'computer' | 'backup' | 'restore'): HTMLElement {
    return this.pane.querySelector<HTMLElement>(`[data-copies-${name}]`)!;
  }

  // ── GitHub ──
  private renderConnected(remote: string, sync: SyncState | null): void {
    const box = this.section('github');
    const repo = githubRepo(remote);
    const where = repo
      ? `<a class="${LINK}" href="https://github.com/${escapeHtml(repo)}" target="_blank" rel="noopener">github.com/${escapeHtml(repo)}</a>`
      : `<code>${escapeHtml(remote)}</code>`;
    const line = syncLine(sync);

    box.innerHTML = `
      <div class="${CARD}">
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0">
            <h4 class="text-sm font-semibold text-ink-100">${t('ghConnected')}</h4>
            <p class="${HINT}">${where}${line ? ' · ' + escapeHtml(line) : ''}</p>
          </div>
          <button type="button" class="${BTN_QUIET} flex-shrink-0" data-gh-disconnect>${t('ghDisconnect')}</button>
        </div>
      </div>
      <p class="text-xs text-ink-500 mt-3 leading-snug">${t('ghConnectedHint')}</p>`;
    box.querySelector('[data-gh-disconnect]')!.addEventListener('click', () => this.disconnect());
  }

  private renderSteps(key: string | null): void {
    const box = this.section('github');
    const newRepo = `https://github.com/new?visibility=private&name=${encodeURIComponent(COPY_NAME)}`;

    box.innerHTML = `
      <p class="text-xs text-ink-500 mb-3 leading-snug">${t('ghIntro')}</p>
      <ol class="gh-steps ${CARD}">
        <li>
          <h4 class="text-sm font-semibold text-ink-100">${t('ghStep1')}</h4>
          <p class="${HINT}">${t('ghStep1Hint')}
            <a class="${LINK}" href="${escapeHtml(newRepo)}" target="_blank" rel="noopener">${t('ghOpenGithub')}</a></p>
        </li>
        <li>
          <h4 class="text-sm font-semibold text-ink-100">${t('ghStep2')}</h4>
          <input id="gh-repo" type="text" spellcheck="false" autocomplete="off" placeholder="${t('ghRepoPlaceholder')}"
            class="w-full mt-2 px-3 py-2 bg-navy-900 border subtle-border rounded-lg text-ink-100 placeholder-ink-500 focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent text-sm font-mono">
        </li>
        <li>
          <h4 class="text-sm font-semibold text-ink-100">${t('ghStep3')}</h4>
          <p class="${HINT}">${t('ghStep3Hint')}
            <a id="gh-keys-link" class="${LINK} hidden" target="_blank" rel="noopener">${t('ghOpenKeys')}</a></p>
          ${key ? copyBox(key, 'data-gh-copy') : `<button type="button" class="${BTN_QUIET} mt-2" data-gh-key>${t('ghMakeKey')}</button>`}
        </li>
        <li class="gh-go">
          <div class="flex items-center gap-3 flex-wrap">
            <button type="button" class="${BTN}" data-gh-connect>${t('ghConnect')}</button>
            <span id="gh-msg" class="text-xs text-ink-500" role="status"></span>
          </div>
          <div data-gh-adopt class="hidden mt-3">
            <p class="${HINT}">${t('ghAdoptHint')}</p>
            <button type="button" class="${BTN_QUIET} mt-2">${t('ghAdopt')}</button>
          </div>
        </li>
      </ol>`;
    const input = box.querySelector<HTMLInputElement>('#gh-repo')!;
    const keysLink = box.querySelector<HTMLAnchorElement>('#gh-keys-link')!;
    const follow = () => {
      this.repo = input.value;
      const repo = input.value.trim().replace(/\.git$/, '');

      keysLink.classList.toggle('hidden', !REPO.test(repo));
      keysLink.href = `https://github.com/${repo}/settings/keys/new`;
    };

    input.value = this.repo;
    follow();
    input.addEventListener('input', follow);
    box.querySelector('[data-gh-key]')?.addEventListener('click', () => this.makeKey());
    this.ctx.copyOn(box, '[data-gh-copy]', () => key!);
    box
      .querySelector('[data-gh-connect]')!
      .addEventListener('click', (e) => this.connect(e.currentTarget as HTMLButtonElement));
    box.querySelector('[data-gh-adopt] button')!.addEventListener('click', () => this.adopt());
  }

  private async makeKey(): Promise<void> {
    try {
      const state = await this.ctx.fetch<CopiesState>('/api/admin/github/key', { method: 'POST', body: '{}' });

      this.renderSteps(state.key);
    } catch (e) {
      this.ctx.showError((e as SettingsError).code === 'no_ssh' ? t('ghErr_no_ssh') : (e as Error).message);
    }
  }

  private async connect(btn: HTMLButtonElement): Promise<void> {
    const msg = this.pane.querySelector<HTMLElement>('#gh-msg')!;
    const adopt = this.pane.querySelector<HTMLElement>('[data-gh-adopt]')!;

    btn.disabled = true;
    adopt.classList.add('hidden');
    this.say(msg, t('ghConnecting'));

    try {
      await this.ctx.fetch('/api/admin/github', { method: 'POST', body: JSON.stringify({ repo: this.repo }) });
      this.repo = '';
      await this.load();
    } catch (e) {
      btn.disabled = false;
      this.sayError(msg, e as SettingsError, 'ghErr_');
      // A full repo may be this very mind's copy, from an instance that is gone.
      adopt.classList.toggle('hidden', (e as SettingsError).code !== 'repo_not_empty' || !this.owner);
    }
  }

  private async adopt(): Promise<void> {
    const ok = await Dialogs.confirm({
      title: t('ghAdopt'),
      message: t('ghAdoptConfirm'),
      confirmLabel: t('ghAdopt'),
      destructive: true,
    });

    if (!ok) return;
    const msg = this.pane.querySelector<HTMLElement>('#gh-msg')!;

    this.say(msg, t('ghAdopting'));

    try {
      await this.ctx.fetch('/api/admin/github/restore', { method: 'POST', body: JSON.stringify({ repo: this.repo }) });
      this.say(msg, t('rsDone'));
      setTimeout(() => location.reload(), 1200);
    } catch (e) {
      this.sayError(msg, e as SettingsError, 'ghErr_');
    }
  }

  private say(el: HTMLElement, text: string, error = false): void {
    el.className = error ? 'text-xs text-rose-300' : 'text-xs text-ink-500';
    el.textContent = text;
  }

  // The server's error code as a sentence; git's own words when it has no better one.
  private sayError(el: HTMLElement, e: SettingsError, prefix: string): void {
    const known = e.code && e.code !== 'other';

    this.say(el, known ? t(prefix + e.code) : t(prefix + 'other', e.detail || e.message), true);
  }

  private async disconnect(): Promise<void> {
    const ok = await Dialogs.confirm({
      title: t('ghDisconnectTitle'),
      message: t('ghDisconnectConfirm'),
      confirmLabel: t('ghDisconnect'),
      destructive: true,
    });

    if (!ok) return;

    try {
      await this.ctx.fetch('/api/admin/github', { method: 'DELETE' });
      await this.load();
    } catch (e) {
      this.ctx.showError((e as Error).message);
    }
  }

  // ── Computer ──
  // Three steps, in the order they happen: the password first, then the command that carries it
  // (git then asks nothing, now or at each pull and push), then the daily gestures.
  private renderComputer(clone: string | null): void {
    const box = this.section('computer');

    if (!clone) {
      box.innerHTML = `<p class="text-xs text-ink-500 leading-snug">${t('pcShared')}</p>`;

      return;
    }
    box.innerHTML = `
      <p class="text-xs text-ink-500 mb-3 leading-snug">${t('pcIntro')}</p>
      <ol class="gh-steps ${CARD}">
        <li>
          <h4 class="text-sm font-semibold text-ink-100">${t('pcStep1')}</h4>
          <p class="${HINT}">${t('pcStep1Hint')}</p>
          <button type="button" class="${BTN} mt-2" data-pc-make>${t('pcMakeToken')}</button>
        </li>
        <li>
          <h4 class="text-sm font-semibold text-ink-100">${t('pcStep2')}</h4>
          <div data-pc-clone><p class="${HINT}">${t('pcStep2Wait')}</p></div>
        </li>
        <li>
          <h4 class="text-sm font-semibold text-ink-100">${t('pcStep3', COPY_NAME)}</h4>
          <p class="${HINT}">${t('pcThen', COPY_NAME)}</p>
        </li>
      </ol>`;
    box.querySelector('[data-pc-make]')!.addEventListener('click', (e) =>
      this.makeToken(clone, e.currentTarget as HTMLButtonElement));
  }

  // A password of its own for each computer (dated, so a second one never replaces the first),
  // put straight into the command.
  private async makeToken(clone: string, button: HTMLButtonElement): Promise<void> {
    const slot = this.pane.querySelector<HTMLElement>('[data-pc-clone]')!;
    const when = new Date().toLocaleString(LANG, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

    try {
      const made = await this.ctx.fetch<{ token: string }>('/api/tokens', {
        method: 'POST',
        body: JSON.stringify({ label: t('pcTokenLabel') + ' · ' + when }),
      });
      const command = `git clone ${clone.replace('://', '://atlas:' + made.token + '@')} ${COPY_NAME}`;

      slot.innerHTML = copyBox(command, 'data-pc-copy') + `<p class="${HINT}">${t('pcCloneHint')}</p>`;
      this.ctx.copyOn(slot, '[data-pc-copy]', () => command);
      button.textContent = t('pcMakeAnother');
      button.className = `${BTN_QUIET} mt-2`;
    } catch (e) {
      this.ctx.showError((e as Error).message);
    }
  }

  // ── Full backup: the notes, their history and the registry; the password (and the 2FA
  // code) asked again, the registry holding secrets.
  private renderBackup(): void {
    const box = this.section('backup');

    if (!this.owner) {
      box.innerHTML = `<p class="text-xs text-ink-500 leading-snug">${t('rsShared')}</p>`;

      return;
    }
    const field = 'px-3 py-1.5 bg-navy-900 border subtle-border rounded-lg text-ink-100 text-sm focus:outline-none focus:ring-2 focus:ring-accent/40';

    box.innerHTML = `
      <p class="text-xs text-ink-500 mb-3 leading-snug">${t('bkIntro')}</p>
      <form class="flex items-center gap-2 flex-wrap" data-bk-form>
        <input type="password" required autocomplete="current-password" placeholder="${t('bkPassword')}" class="${field}" data-bk-password>
        ${totpEnabled ? `<input inputmode="numeric" autocomplete="one-time-code" placeholder="${t('bkCode')}" class="${field} w-28" data-bk-code>` : ''}
        <button type="submit" class="${BTN_QUIET}">${t('bkDownload')}</button>
        <span data-bk-msg class="text-xs text-ink-500" role="status"></span>
      </form>`;
    box.querySelector('[data-bk-form]')!.addEventListener('submit', (e) => {
      e.preventDefault();
      this.downloadBackup(box);
    });
  }

  private async downloadBackup(box: HTMLElement): Promise<void> {
    const msg = box.querySelector<HTMLElement>('[data-bk-msg]')!;
    const password = box.querySelector<HTMLInputElement>('[data-bk-password]')!;
    const code = box.querySelector<HTMLInputElement>('[data-bk-code]');

    this.say(msg, t('bkWorking'));
    const res = await fetch('/api/admin/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password.value, code: code ? code.value : '' }),
    });

    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: '' }));
      const known = ['bad_password', 'bad_code', 'code_required', 'locked', 'shared'].includes(error);

      this.say(msg, known ? t('bkErr_' + error) : t('bkErr_other', res.status), true);

      return;
    }
    const link = document.createElement('a');

    link.href = URL.createObjectURL(await res.blob());
    link.download = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'atlas-backup.zip';
    link.click();
    URL.revokeObjectURL(link.href);
    password.value = '';
    if (code) code.value = '';
    this.say(msg, t('bkDone'));
  }

  // ── Restore ──
  private renderRestore(): void {
    const box = this.section('restore');

    if (!this.owner) {
      box.innerHTML = `<p class="text-xs text-ink-500 leading-snug">${t('rsShared')}</p>`;

      return;
    }
    box.innerHTML = `
      <p class="text-xs text-ink-500 mb-3 leading-snug">${t('rsIntro')}</p>
      <div class="flex items-center gap-3 flex-wrap">
        <label class="${BTN_QUIET} cursor-pointer">${t('rsChoose')}<input type="file" accept=".zip,application/zip" class="hidden" data-rs-file></label>
        <span data-rs-msg class="text-xs text-ink-500" role="status"></span>
      </div>`;
    const input = box.querySelector<HTMLInputElement>('[data-rs-file]')!;

    input.addEventListener('change', () => {
      const file = input.files?.[0];

      input.value = '';
      if (file) this.restore(file);
    });
  }

  private async restore(file: File): Promise<void> {
    const ok = await Dialogs.confirm({
      title: t('rsConfirmTitle'),
      message: t('rsConfirm', file.name),
      confirmLabel: t('copiesRestore'),
      destructive: true,
    });

    if (!ok) return;
    const msg = this.pane.querySelector<HTMLElement>('[data-rs-msg]')!;

    this.say(msg, t('rsWorking'));

    try {
      const done = await this.ctx.fetch<{ mode: string; count: number | null; registry: boolean }>('/api/admin/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip' },
        body: file,
      });

      // A full backup brings the account back too: one signs in again with its password.
      if (done.registry) {
        this.say(msg, t('rsDoneRegistry'));
        setTimeout(() => location.reload(), 3500);

        return;
      }
      this.say(msg, done.mode === 'history' ? t('rsDone') : t('rsDoneFiles', done.count));
      setTimeout(() => location.reload(), 1200);
    } catch (e) {
      this.sayError(msg, e as SettingsError, 'rsErr_');
    }
  }
}
