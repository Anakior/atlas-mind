// Settings › My Atlas › On your phone: the address as a QR code, to open it there and add it to the
// home screen. A mind on this computer has none to give: the phone could not reach it.

import { t } from '../../core/i18n';
import { isLoopback } from '../../core/utils';
import { renderQrCanvas } from '../../ui/qr-code';

export class SettingsPhone {
  load(): void {
    const qr = document.getElementById('phone-qr')!;
    const local = isLoopback();

    document.getElementById('phone-hint')!.textContent = t(local ? 'phoneLocal' : 'phoneHint');
    document.getElementById('phone-url')!.textContent = local ? '' : location.origin;
    qr.classList.toggle('hidden', local);
    if (!local && !qr.firstChild) renderQrCanvas(qr, location.origin + '/', 112);
  }
}
