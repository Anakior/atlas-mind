// Atlas DOM — a tiny keyed virtual-DOM with state-preserving reconciliation. The pattern
// is "mutate state, then render(view(state), container)": the diff reuses the live DOM node
// whose (tag, key) is stable, so focus, text selection, an uncommitted input value and the
// container's scroll position all survive a re-render. That is what kills the SSE live-reload
// bug class by construction — no ad-hoc guards needed.
//
// No reactivity and no hidden state: h() builds a plain object and render() diffs two arrays
// of them, so the whole model can be read top to bottom and audited. The module exports its
// public API (h, raw, render, createApp, Show); the ~15 internal reconciler helpers stay
// module-private.

const SVG_NS = 'http://www.w3.org/2000/svg';

// Last rendered child list per container: the "old" side of the next diff.
const ROOTS = new WeakMap<Element, VNode[]>();

// ref callbacks fire AFTER the patched tree is in the document, so el.focus() and
// getBoundingClientRect() (popups) operate on an attached, laid-out node, not a detached one.
let mountQueue: Array<() => void> = [];

export function h(tag: string, props?: Record<string, any> | null, ...children: Child[]): VNode {
  const p = props || {};

  return { tag, key: p.key, props: p, children: normalize(children) };
}

// Opaque node for an imperative island (inbox app, editor textarea, graph canvas, popup
// host): its props are applied, but its DOM children are never reconciled or removed. The
// island owns its content and tears it down via its ref.
(h as any).host = function host(tag: string, props?: Record<string, any> | null): VNode {
  const p = props || {};

  return { tag, key: p.key, props: p, children: [], managed: true };
};

// The single innerHTML path: one trusted, single-root HTML string (a static SVG icon, or
// markdown already sanitised upstream by DOMPurify).
export function raw(html: string): VNode {
  return { tag: '#raw', props: {}, children: [], text: html };
}

export function Show(cond: any, view: () => Child): Child {
  return cond ? view() : null;
}

// Flatten nested arrays, drop null/boolean/undefined, wrap primitives in #text nodes.
function normalize(children: Child[]): VNode[] {
  const out: VNode[] = [];
  const walk = (c: Child): void => {
    if (c === null || c === undefined || typeof c === 'boolean') return;
    if (Array.isArray(c)) {
      c.forEach(walk);

      return;
    }
    if (typeof c === 'string' || typeof c === 'number') {
      out.push({ tag: '#text', props: {}, children: [], text: String(c) });

      return;
    }
    out.push(c);
  };

  children.forEach(walk);

  return out;
}

export function render(next: Child, container: Element): void {
  const arr = normalize([next]);

  patchChildren(container, ROOTS.get(container) || [], arr, container.namespaceURI === SVG_NS);
  ROOTS.set(container, arr);

  const mounts = mountQueue;

  mountQueue = [];
  mounts.forEach((fn) => fn());
}

export function createApp(container: Element, view: (state?: any) => Child) {
  return {
    render(state?: any): void {
      render(view(state), container);
    },
    unmount(): void {
      patchChildren(container, ROOTS.get(container) || [], [], container.namespaceURI === SVG_NS);
      ROOTS.delete(container);
    },
  };
}

// Three O(n) passes: pair, remove, order.
function patchChildren(parent: Node, old: VNode[], next: VNode[], svg: boolean): void {
  const keyed = new Map<string | number, VNode>();
  const fifo = new Map<string, VNode[]>();

  for (const o of old) {
    if (o.key !== undefined) keyed.set(o.key, o);
    else {
      const q = fifo.get(o.tag);

      if (q) q.push(o);
      else fifo.set(o.tag, [o]);
    }
  }

  // Pass 1: match each new vnode to an old one (key+tag, else FIFO-by-tag), patch or create.
  const reused = new Set<VNode>();

  for (const n of next) {
    let match: VNode | undefined;

    if (n.key !== undefined) {
      const o = keyed.get(n.key);

      if (o && o.tag === n.tag) match = o;
    } else {
      const q = fifo.get(n.tag);

      if (q && q.length) match = q.shift();
    }

    if (match) {
      reused.add(match);
      patchNode(match, n, svg);
    } else createNode(n, svg);
  }

  // Pass 2: remove the old nodes not reused, with bottom-up cleanup (refs fire null).
  for (const o of old) if (!reused.has(o)) removeNode(o);

  // Pass 3: order the DOM to match next. insertBefore MOVES an existing node, so a reorder
  // never recreates; an already-in-place node just advances the cursor.
  let cursor = parent.firstChild;

  for (const n of next) {
    const el = n.el!;

    if (el === cursor) cursor = cursor.nextSibling;
    else parent.insertBefore(el, cursor);
  }
}

function patchNode(old: VNode, next: VNode, svg: boolean): void {
  next.el = old.el;

  if (next.tag === '#text') {
    if (next.text !== old.text) (next.el as Text).data = next.text!;

    return;
  }
  if (next.tag === '#raw') {
    if (next.text !== old.text) {
      const fresh = rawToNode(next.text!, svg);

      (old.el as ChildNode).replaceWith(fresh);
      next.el = fresh;
    }

    return;
  }

  const el = next.el as Element;

  applyProps(el, old.props, next.props);
  if (next.managed) return; // island owns its children
  patchChildren(el, old.children, next.children, svg || next.tag === 'svg');
}

function createNode(vnode: VNode, svg: boolean): Node {
  if (vnode.tag === '#text') {
    vnode.el = document.createTextNode(vnode.text!);

    return vnode.el;
  }
  if (vnode.tag === '#raw') {
    vnode.el = rawToNode(vnode.text!, svg);

    return vnode.el;
  }

  const isSvg = svg || vnode.tag === 'svg';
  const el = isSvg
    ? document.createElementNS(SVG_NS, vnode.tag)
    : document.createElement(vnode.tag);

  vnode.el = el;
  applyProps(el, {}, vnode.props);
  if (!vnode.managed) for (const child of vnode.children) el.appendChild(createNode(child, isSvg));

  const ref = vnode.props.ref;

  if (ref) mountQueue.push(() => ref(el));

  return el;
}

function rawToNode(html: string, svg: boolean): Node {
  const holder = svg ? document.createElementNS(SVG_NS, 'g') : document.createElement('div');

  holder.innerHTML = html;

  return holder.firstChild || document.createTextNode('');
}

function applyProps(el: Element, oldProps: Record<string, any>, newProps: Record<string, any>): void {
  for (const k in oldProps) {
    if (k === 'key' || k === 'ref' || k in newProps) continue;
    removeProp(el, k);
  }
  for (const k in newProps) {
    if (k === 'key' || k === 'ref') continue;

    const v = newProps[k];

    // value/checked carry the focus guard, evaluated every render (not gated on the old vnode).
    if (k === 'value' || k === 'checked') applyValue(el, k, v);
    else if (v !== oldProps[k]) setProp(el, k, v);
  }
}

// Write value/checked only if it actually changed AND the node is not focused, so a user's
// uncommitted edit is never clobbered. Diff against the value we LAST APPLIED, not the old
// vnode: when we skip for focus we leave it stale, so the first render after blur still
// detects the delta and writes it (no "DOM frozen for life" bug).
function applyValue(el: any, k: string, v: any): void {
  const applied = el.__applied || (el.__applied = {});

  if (applied[k] === v) return;
  if (document.activeElement === el) return;
  el[k] = v;
  applied[k] = v;
}

function setProp(el: any, k: string, v: any): void {
  if (k.length > 2 && k[0] === 'o' && k[1] === 'n') {
    setEvent(el, k.slice(2).toLowerCase(), v);

    return;
  }
  if (k === 'disabled' || k === 'selected') {
    el[k] = !!v;

    return;
  }
  if (k === 'style') {
    setStyle(el, v);

    return;
  }
  if (v == null || v === false) el.removeAttribute(k);
  else el.setAttribute(k, v === true ? '' : String(v));
}

function removeProp(el: any, k: string): void {
  if (k.length > 2 && k[0] === 'o' && k[1] === 'n') {
    setEvent(el, k.slice(2).toLowerCase(), null);

    return;
  }
  if (k === 'value' || k === 'checked') return; // leave the live DOM value untouched
  if (k === 'disabled' || k === 'selected') {
    el[k] = false;

    return;
  }
  el.removeAttribute(k);
}

// One real listener per event type per node; re-renders swap the stored closure with zero
// addEventListener churn. A null handler turns the dispatcher into a no-op.
function setEvent(el: any, type: string, handler: any): void {
  const ev = el.__ev || (el.__ev = {});

  if (!(type in ev)) {
    el.addEventListener(type, (e: Event) => {
      const fn = el.__ev[type];

      if (fn) fn(e);
    });
  }
  if (handler) ev[type] = handler;
  else delete ev[type];
}

function setStyle(el: any, v: any): void {
  if (v == null || v === false) {
    el.removeAttribute('style');

    return;
  }
  if (typeof v === 'string') {
    el.setAttribute('style', v);

    return;
  }
  el.removeAttribute('style');
  for (const k in v) el.style[k] = v[k];
}

function removeNode(vnode: VNode): void {
  cleanup(vnode);

  const el = vnode.el as ChildNode;

  if (el && el.parentNode) el.parentNode.removeChild(el);
}

// Bottom-up: a child's ref(null) fires before its parent's. A managed host stops the
// recursion — its island tears itself down from its own ref(null).
function cleanup(vnode: VNode): void {
  if (!vnode.managed) for (const c of vnode.children) cleanup(c);

  const ref = vnode.props.ref;

  if (ref) ref(null);
}
