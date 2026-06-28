// Quick capture — the inbox-capture modal (quick-capture-*). A tiny note grabber that PUTs a timestamped
// markdown file into inbox/; it is neither 2FA nor new-file, so it owns its own module. Shares the Modal
// lifecycle (01c-modal-base.ts). Concatenates after the 18-totp-* files (where these refs were stranded)
// and before 19-newfile.ts, whose Escape stack — and 99-bootstrap.ts — read qcBtn/qcBackdrop and the
// quickCaptureModal instance by name.

// ── Quick capture: element refs ────────────────────────────────────────────────────────────────
import { Modal } from '../ui/modal-base';
import { t } from '../core/i18n';
import { slugify } from '../core/utils';
import { setStatus } from '../core/net';

export const qcBtn = document.getElementById('quick-capture-btn');
export const qcBackdrop = document.getElementById('quick-capture-backdrop');
export const qcForm = document.getElementById('quick-capture-form');
export const qcTitle = document.getElementById('quick-capture-title');
export const qcBody = document.getElementById('quick-capture-body');
export const qcCancel = document.getElementById('quick-capture-cancel');
export const qcError = document.getElementById('quick-capture-error');

export class QuickCaptureModal extends Modal {
  // qc* are the nullable getElementById consts above; assert/cast to the precise type here.
  private readonly title = qcTitle as HTMLInputElement;
  private readonly body = qcBody as HTMLTextAreaElement;
  private readonly error = qcError!;

  constructor() {
    super(qcBackdrop!);
    qcBtn!.addEventListener('click', () => this.open());
    qcCancel!.addEventListener('click', () => this.close());
    document.getElementById('quick-capture-close')?.addEventListener('click', () => this.close());
    qcForm!.addEventListener('submit', (e) => this.submit(e));
  }

  open(): void {
    if (window.__viewerMode) return;
    this.error.classList.add('hidden');
    this.title.value = '';
    this.body.value = '';
    this.reveal();
    setTimeout(() => this.title.focus(), 50);
  }

  private async submit(e: Event): Promise<void> {
    e.preventDefault();
    this.error.classList.add('hidden');
    const title = this.title.value.trim();

    if (!title) {
      this.error.textContent = t('titleRequired');
      this.error.classList.remove('hidden');

      return;
    }

    const body = this.body.value.trim();
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const dateStr =
      now.getFullYear() +
      '-' +
      pad(now.getMonth() + 1) +
      '-' +
      pad(now.getDate()) +
      '-' +
      pad(now.getHours()) +
      pad(now.getMinutes());
    const slug = (slugify(title) || 'note').slice(0, 50);
    const path = 'inbox/' + dateStr + '-' + slug + '.md';
    const content =
      '# ' + title + '\n\n_Capture : ' + now.toLocaleString('fr-FR') + '_\n\n' + body + '\n';

    try {
      const res = await fetch('/api/file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content }),
      });

      if (!res.ok) throw new Error('HTTP ' + res.status);
      this.close();
      setStatus(t('noteSaved'), 'ok');
    } catch (e) {
      this.error.textContent = t('err', (e as Error).message);
      this.error.classList.remove('hidden');
    }
  }
}

export const quickCaptureModal = new QuickCaptureModal();
