// Constellation ("orrery") view of the home Activity card: the attributed history as a spinning solar
// system — each aggregated event is a node on one of three rings, hover/tap reveals a popover, the sun
// carries the easter egg, and a node opens its doc's history. A render-only view over the shared feed:
// it reads through the ActivityRenderCtx the shell hands it (helpers + openDocHistory) and keeps its own
// transient orreryItems (the list the nodes index into). Top-level (no IIFE) so it is a shared symbol in
// the concat scope.
class ActivityOrrery {
  private orreryItems: ActivityItem[] = []; // the list the constellation nodes index into (respects the filter)

  constructor(private readonly ctx: ActivityRenderCtx) {}

  private orreryNodes(): { ringSvg: string; nodes: string; cx: number; cy: number } {
    const cx = 360;
    const cy = 265;
    const radii = [104, 172, 236];
    // Cap + even split by recency RANK (not raw time): each ring gets a balanced share so a burst
    // of recent edits can't pile onto one ring. Inner = most recent.
    const items = (this.orreryItems = this.ctx.shownItems()).slice(0, ActivityIcons.ORRERY_CAP).map((e, i) => ({ e, i }));
    const perRing = Math.max(1, Math.ceil(items.length / 3));
    const rings: { e: ActivityItem; i: number }[][] = [[], [], []];

    items.forEach((it, idx) => rings[Math.min(2, Math.floor(idx / perRing))].push(it));

    let nodes = '';

    rings.forEach((arr, ri) => {
      const r = radii[ri];
      const off = ri * 0.7 + 0.15; // stagger rings so nodes don't align radially

      arr.forEach((it, k) => {
        const ang = (k + 0.5) / arr.length * Math.PI * 2 - Math.PI / 2 + off;
        const x = cx + r * Math.cos(ang);
        const y = cy + r * Math.sin(ang);
        const c = this.ctx.TY(it.e.type).color;

        nodes +=
          `<g class="act-node" data-i="${it.i}" tabindex="0" transform="translate(${x.toFixed(1)},${y.toFixed(1)})">
            <g class="act-node-inner">
              <circle r="19" fill="#14131a" stroke="${c}" stroke-opacity=".6"/>
              <svg x="-11" y="-11" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${this.ctx.TY(it.e.type).d}"/></svg>
              ${it.e.ai ? '<circle cx="13" cy="-13" r="5" fill="#14131a" stroke="#e8941c" stroke-opacity=".8"/><circle cx="13" cy="-13" r="1.8" fill="#e8941c"/>' : ''}
            </g>
          </g>`;
      });
    });

    const ringSvg = radii
      .map((r) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#6a7180" stroke-opacity=".4" stroke-width="1" stroke-dasharray="3 7"/>`)
      .join('');

    return { ringSvg, nodes, cx, cy };
  }

  html(): string {
    const { ringSvg, nodes, cx, cy } = this.orreryNodes();
    const legend = Object.keys(ActivityIcons.TYPES)
      .map((k) => `<span class="act-legend-chip">${this.ctx.iconSvg(k, 12)}<span>${this.ctx.verb(k)}</span></span>`)
      .join('');

    return (
      `<div class="act-orrery flex items-start gap-4">
        <div class="act-sky relative flex-1 min-w-0">
          <svg viewBox="0 0 720 540" style="width:100%;height:auto;overflow:visible">
            <defs>
              <radialGradient id="actcore" cx="42%" cy="38%"><stop offset="0" stop-color="#ffd9a0"/><stop offset="55%" stop-color="#e8941c"/><stop offset="100%" stop-color="#8a4f0e"/></radialGradient>
              <radialGradient id="actglow" cx="50%" cy="50%"><stop offset="0" stop-color="rgba(232,148,28,.15)"/><stop offset="70%" stop-color="rgba(232,148,28,0)"/></radialGradient>
              <radialGradient id="actsunlimb" cx="42%" cy="38%"><stop offset="58%" stop-color="rgba(0,0,0,0)"/><stop offset="100%" stop-color="rgba(70,35,5,.6)"/></radialGradient>
              <clipPath id="actsunclip"><circle cx="${cx}" cy="${cy}" r="27"/></clipPath>
              <filter id="actsunblur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2.3"/></filter>
            </defs>
            <circle class="act-glow" cx="${cx}" cy="${cy}" r="120" fill="url(#actglow)"/>
            <g class="act-spin">${ringSvg}${nodes}</g>
            <g class="act-sun"><g class="act-sun-pulse">
              <circle cx="${cx}" cy="${cy}" r="27" fill="url(#actcore)"/>
              <g clip-path="url(#actsunclip)" filter="url(#actsunblur)">
                <circle cx="${cx - 7}" cy="${cy - 8}" r="6" fill="#fff1d6" opacity=".5"/>
                <circle cx="${cx + 8}" cy="${cy - 3}" r="5.4" fill="#b86f12" opacity=".5"/>
                <circle cx="${cx - 3}" cy="${cy + 8}" r="6.7" fill="#a55f0f" opacity=".45"/>
                <circle cx="${cx - 11}" cy="${cy + 3}" r="4" fill="#ffe2b0" opacity=".4"/>
                <circle cx="${cx + 9}" cy="${cy + 9}" r="4.7" fill="#8a4f0e" opacity=".5"/>
                <circle cx="${cx + 2}" cy="${cy - 11}" r="3.4" fill="#ffe9c4" opacity=".4"/>
              </g>
              <circle cx="${cx}" cy="${cy}" r="27" fill="url(#actsunlimb)"/>
              <circle cx="${cx - 7}" cy="${cy - 9}" r="4" fill="#fff7e6" opacity=".55" filter="url(#actsunblur)"/>
            </g></g>
          </svg>
          <div class="act-pop dialog-card hidden"></div>
          <div class="act-egg"></div>
        </div>
        <div class="act-legend">${legend}</div>
      </div>`
    );
  }

  private popHtml(e: ActivityItem): string {
    const ty = this.ctx.TY(e.type);
    const via = e.ai ? `<span class="text-ink-500 text-xs">· via ${escapeHtml(e.ai)}</span>` : '';

    return (
      `<div class="flex items-center gap-2 mb-1.5"><span style="line-height:0">${this.ctx.avatar(e, 26)}</span><span class="text-sm font-semibold text-ink-100">${escapeHtml(e.who)}</span>${via}</div>
       <div class="flex items-baseline gap-1.5 text-sm"><span style="color:${ty.color};font-weight:600;white-space:nowrap">${this.ctx.verbPhrase(e.type)}</span><span class="text-ink-300" style="min-width:0;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${escapeHtml(e.title)}</span>${e.count && e.count > 1 ? `<span class="text-ink-500 text-xs" style="white-space:nowrap">×${e.count}</span>` : ''}</div>
       <div class="text-xs text-ink-500 font-mono mt-1.5">${this.ctx.rel(e.agoMin)} · ${escapeHtml(e.sha)}</div>`
    );
  }

  wireHover(container: HTMLElement): void {
    const wrap = container.querySelector<HTMLElement>('.act-sky');
    const pop = container.querySelector<HTMLElement>('.act-pop');

    if (!wrap || !pop) return;

    const show = (node: HTMLElement): void => {
      const e = this.orreryItems[Number(node.dataset.i)];

      if (!e) return;
      pop.innerHTML = this.popHtml(e);
      pop.classList.remove('hidden');
      if (window.matchMedia('(max-width:767px)').matches) {
        pop.style.left = pop.style.top = pop.style.transform = ''; // CSS bottom-sheet positions it

        return;
      }

      const nb = node.getBoundingClientRect();
      const wb = wrap.getBoundingClientRect();
      let left = nb.left - wb.left + nb.width / 2;
      const half = pop.offsetWidth / 2;

      left = Math.max(half + 4, Math.min(wb.width - half - 4, left));
      pop.style.left = left + 'px';
      // flip below the node when there isn't room above (keeps it off the toggle / top edge)
      if (nb.top - wb.top > pop.offsetHeight + 16) {
        pop.style.top = (nb.top - wb.top - 10) + 'px';
        pop.style.transform = 'translate(-50%, -100%)';
      } else {
        pop.style.top = (nb.bottom - wb.top + 10) + 'px';
        pop.style.transform = 'translate(-50%, 0)';
      }
    };
    const hide = (): void => pop.classList.add('hidden');
    const noHover = window.matchMedia('(hover: none)').matches; // touch: no hover → tap to reveal
    let activeNode: HTMLElement | null = null;

    wrap.querySelectorAll<HTMLElement>('.act-node').forEach((n) => {
      n.addEventListener('mouseenter', () => show(n));
      n.addEventListener('mouseleave', hide);
      n.addEventListener('focus', () => show(n));
      n.addEventListener('blur', hide);
      n.addEventListener('click', () => {
        const e = this.orreryItems[Number(n.dataset.i)];

        if (!noHover) { if (e) this.ctx.openDocHistory(e.path); return; }
        if (activeNode === n) { if (e) this.ctx.openDocHistory(e.path); } // 2nd tap on same node → open history
        else { activeNode = n; show(n); } // 1st tap → reveal the popover
      });
    });
    wrap.addEventListener('click', (ev) => {
      if (!(ev.target as HTMLElement).closest('.act-node')) { hide(); activeNode = null; } // tap the empty sky → dismiss
    });
  }

  wireSun(container: HTMLElement): void {
    const sun = container.querySelector<SVGGraphicsElement>('.act-sun');
    const spin = container.querySelector<SVGGraphicsElement>('.act-spin');
    const egg = container.querySelector<HTMLElement>('.act-egg');

    if (!sun) return;
    // Drop each one-shot class when its animation ends, so it doesn't persist and replay when the
    // hidden orrery is shown again (Journal ⇄ Constellation switch re-displays it).
    if (spin) spin.addEventListener('animationend', () => spin.classList.remove('spinning'));
    sun.addEventListener('animationend', () => sun.classList.remove('pop'));
    if (egg) egg.addEventListener('animationend', () => egg.classList.remove('show'));

    let n = 0;

    sun.addEventListener('click', () => {
      n += 1;
      if (spin) { spin.classList.remove('spinning'); void spin.getBBox(); spin.classList.add('spinning'); }
      sun.classList.remove('pop'); void sun.getBBox(); sun.classList.add('pop');
      if (n % 5 === 0 && egg) {
        egg.textContent = ActivityIcons.EGG_LINES[(n / 5 - 1) % ActivityIcons.EGG_LINES.length];
        egg.classList.remove('show'); void egg.offsetWidth; egg.classList.add('show');
      }
    });
  }
}
