// Filename tooltip: one body-level popup shown over any truncated [data-name] label or any explicit
// [data-tip] (the tree + breadcrumb use it). Document-delegated, so it stays imperative.
class Tooltip {
  private readonly el: HTMLElement;

  constructor() {
    this.el = document.createElement('div');
    this.el.className =
      'fixed pointer-events-none bg-navy-800/95 border subtle-border text-ink-100 text-xs px-3 py-1.5 rounded-md shadow-2xl shadow-black/70 z-50 opacity-0 max-w-md whitespace-nowrap font-medium';
    this.el.style.cssText +=
      ';backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);transition:opacity 0.12s ease, transform 0.12s ease;transform:translateY(-50%) translateX(-4px);';
    document.body.appendChild(this.el);
    document.addEventListener('mouseover', (e) => this.onMouseOver(e));
    document.addEventListener('mouseout', (e) => this.onMouseOut(e));
  }

  private isTruncated(el: Element): boolean {
    return el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight;
  }

  private position(target: Element): void {
    const rect = target.getBoundingClientRect();
    const GAP = 14;

    this.el.style.left = rect.right + GAP + 'px';
    this.el.style.top = rect.top + rect.height / 2 + 'px';
    requestAnimationFrame(() => {
      const tipRect = this.el.getBoundingClientRect();

      if (tipRect.right > window.innerWidth - 8) this.el.style.left = rect.left - tipRect.width - GAP + 'px';
    });
  }

  private hide(): void {
    this.el.style.opacity = '0';
    this.el.style.transform = 'translateY(-50%) translateX(-4px)';
  }

  private onMouseOver(e: MouseEvent): void {
    const target = (e.target as Element | null)?.closest<HTMLElement>('[data-name], [data-tip]') ?? null;

    if (!target) {
      this.hide();

      return;
    }
    // data-tip: an explicit tooltip string, shown as-is (and allowed to wrap). data-name: the full
    // filename, shown only when the on-screen label is actually truncated.
    const isTip = !!target.dataset.tip;
    const text = isTip ? target.dataset.tip : this.isTruncated(target) ? target.dataset.name : '';

    if (!text) {
      this.hide();

      return;
    }
    this.el.style.whiteSpace = isTip ? 'normal' : 'nowrap';
    this.el.textContent = text;
    this.position(target);
    this.el.style.opacity = '1';
    this.el.style.transform = 'translateY(-50%) translateX(0)';
  }

  private onMouseOut(e: MouseEvent): void {
    const related = e.relatedTarget as Element | null;

    if (!related || !related.closest('[data-name], [data-tip]')) this.hide();
  }
}

new Tooltip();
