// A short notice at the bottom of the page that goes away by itself: something happened that the
// person should know about but needn't act on (the doc changed under them and was reloaded). A live
// region in the page from the start, so a screen reader says it too.
const el = document.createElement('div');
let timer: ReturnType<typeof setTimeout> | null = null;

el.className = 'atlas-toast';
el.setAttribute('role', 'status');
document.body.appendChild(el);

export function toast(message: string): void {
  el.textContent = message;
  el.classList.add('show');
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => el.classList.remove('show'), 5000);
}
