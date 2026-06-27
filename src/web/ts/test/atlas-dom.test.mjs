// Golden tests for the Atlas DOM runtime (CDC section 3.9). They are the behavioural oracle:
// the reconciler must preserve focus, selection, uncommitted values and scroll, reuse keyed
// nodes, and never reconcile a managed host. Run with: npm run test:runtime (in src/web/ts).
import assert from 'node:assert/strict';
import test from 'node:test';
import { freshRuntime } from './runtime-harness.mjs';

// 1. A re-render that changes a SIBLING leaves the focused input (same key) untouched:
//    same node, same value, same selection.
test('focus and selection survive a sibling re-render', () => {
  const { h, render, document } = freshRuntime();
  const view = (label) =>
    h('div', null, h('input', { key: 'a', value: '' }), h('span', null, label));

  render(view('one'), document.body);
  const input = document.querySelector('input');

  input.focus();
  input.value = 'hello';
  input.setSelectionRange(2, 4);

  render(view('two'), document.body);

  assert.equal(document.activeElement, input);
  assert.equal(input.value, 'hello');
  assert.equal(input.selectionStart, 2);
  assert.equal(input.selectionEnd, 4);
  assert.equal(document.querySelector('span').textContent, 'two');
});

// 2. While focused, a render with a different `value` must NOT clobber the user's edit.
test('uncommitted value is protected while focused', () => {
  const { h, render, document } = freshRuntime();
  const view = (v) => h('input', { key: 'a', value: v });

  render(view('A'), document.body);
  const input = document.querySelector('input');

  input.focus();
  input.value = 'typing';
  render(view('B'), document.body);

  assert.equal(input.value, 'typing');
});

// 3. Not focused: a render with a different `value` reflects the new prop.
test('value updates when the node is not focused', () => {
  const { h, render, document } = freshRuntime();
  const view = (v) => h('input', { key: 'a', value: v });

  render(view('A'), document.body);
  const input = document.querySelector('input');

  assert.equal(input.value, 'A');
  render(view('B'), document.body);
  assert.equal(input.value, 'B');
});

// 4. The hardened guard: skipped-for-focus must not freeze the DOM. After blur, the same
//    vnode value is finally applied (diff is against the value actually applied, not the vnode).
test('value guard applies the pending value after blur', () => {
  const { h, render, document } = freshRuntime();
  const view = (v) => h('input', { key: 'a', value: v });

  render(view('A'), document.body);
  const input = document.querySelector('input');

  input.focus();
  render(view('B'), document.body);
  assert.equal(input.value, 'A');

  input.blur();
  render(view('B'), document.body);
  assert.equal(input.value, 'B');
});

// 5 + 7. A keyed append inserts exactly one node; every prior node is the SAME instance and
//    the container's scrollTop is untouched.
test('keyed append is surgical and preserves scrollTop', () => {
  const { h, render, document } = freshRuntime();
  const view = (items) =>
    h('div', { key: 'list' }, items.map((i) => h('div', { key: i }, String(i))));

  render(view([1, 2, 3]), document.body);
  const list = document.querySelector('div');

  list.scrollTop = 40;
  const before = [...list.children];

  render(view([1, 2, 3, 4]), document.body);

  assert.equal(list.scrollTop, 40);
  assert.equal(list.children.length, 4);
  assert.equal(list.children[0], before[0]);
  assert.equal(list.children[1], before[1]);
  assert.equal(list.children[2], before[2]);
});

// 6. A keyed reorder moves the same instances, recreates nothing, ends in the right order.
test('keyed reorder moves nodes without recreating them', () => {
  const { h, render, document } = freshRuntime();
  const view = (keys) => h('ul', null, keys.map((k) => h('li', { key: k }, k)));

  render(view(['a', 'b', 'c']), document.body);
  const ul = document.querySelector('ul');
  const node = {};

  for (const li of ul.children) node[li.textContent] = li;

  render(view(['c', 'a', 'b']), document.body);

  assert.deepEqual([...ul.children].map((li) => li.textContent), ['c', 'a', 'b']);
  assert.equal(ul.children[0], node.c);
  assert.equal(ul.children[1], node.a);
  assert.equal(ul.children[2], node.b);
});

// 8. Removing a keyed item detaches it and fires its ref(null) (the teardown hook).
test('keyed removal detaches the node and fires ref(null)', () => {
  const { h, render, document } = freshRuntime();
  const log = [];
  const view = (keys) =>
    h('ul', null, keys.map((k) => h('li', { key: k, ref: (el) => log.push([k, !!el]) }, k)));

  render(view(['a', 'b']), document.body);
  const ul = document.querySelector('ul');

  assert.equal(ul.children.length, 2);

  render(view(['a']), document.body);

  assert.equal(ul.children.length, 1);
  assert.deepEqual(log.filter(([k]) => k === 'b'), [['b', true], ['b', false]]);
});

// 9. The dispatcher is stable: N re-renders with a fresh onClick closure add ONE listener;
//    the latest closure runs.
test('event dispatcher adds one listener, runs the latest closure', () => {
  const { h, render, window, document } = freshRuntime();
  let clickAdds = 0;
  const proto = window.HTMLButtonElement.prototype;
  const orig = proto.addEventListener;

  proto.addEventListener = function (type, ...rest) {
    if (type === 'click') clickAdds++;

    return orig.call(this, type, ...rest);
  };

  let fired = null;
  const view = (n) => h('button', { key: 'b', onClick: () => (fired = n) }, 'x');

  render(view(1), document.body);
  render(view(2), document.body);
  render(view(3), document.body);

  assert.equal(clickAdds, 1);
  document.querySelector('button').dispatchEvent(new window.Event('click'));
  assert.equal(fired, 3);

  proto.addEventListener = orig;
});

// 10. A ref that calls el.focus() on a freshly created subtree works, proving refs fire AFTER
//    the node is inserted (a detached focus() would be a silent no-op).
test('ref fires after insertion so focus() takes effect', () => {
  const { h, render, document } = freshRuntime();
  const view = () => h('input', { key: 'a', ref: (el) => el && el.focus() });

  render(view(), document.body);

  assert.equal(document.activeElement, document.querySelector('input'));
});

// 11. Widget lifecycle: ref(el) on mount, ref(null) on removal tears the widget down.
test('widget is mounted on ref(el) and destroyed on ref(null)', () => {
  const { h, render, document } = freshRuntime();
  const widget = { destroyed: false, destroy() { this.destroyed = true; } };
  let mounted = false;
  const view = (show) =>
    h('div', null, show ? h('input', { key: 'w', ref: (el) => (el ? (mounted = true) : widget.destroy()) }) : null);

  render(view(true), document.body);
  assert.equal(mounted, true);

  render(view(false), document.body);
  assert.equal(widget.destroyed, true);
});

// 12. A managed host: its DOM children (mounted by external/imperative code) survive every
//    re-render, with ZERO removeChild; the rest of the tree still reconciles.
test('managed host children are never reconciled or removed', () => {
  const { h, render, document } = freshRuntime();
  let removeChildCalls = 0;
  const view = (label) =>
    h(
      'div',
      null,
      h('p', null, label),
      h.host('section', {
        key: 'isle',
        id: 'isle',
        ref: (el) => {
          if (el && !el.dataset.mounted) {
            el.dataset.mounted = '1';
            el.appendChild(document.createTextNode('IMPERATIVE'));
          }
        },
      }),
    );

  render(view('one'), document.body);
  const isle = document.getElementById('isle');

  assert.equal(isle.textContent, 'IMPERATIVE');

  const origRemove = isle.removeChild.bind(isle);

  isle.removeChild = (...a) => {
    removeChildCalls++;

    return origRemove(...a);
  };

  render(view('two'), document.body);
  render(view('three'), document.body);

  assert.equal(isle.textContent, 'IMPERATIVE');
  assert.equal(removeChildCalls, 0);
  assert.equal(document.querySelector('p').textContent, 'three');
});

// 13. A popup mounted to <body> by an input's ref survives a surrounding re-render (the input
//    keeps its key -> same node -> ref not refired -> popup not rebuilt, not destroyed).
//    The POSITION assertion (popup aligned under the input after chips wrap) needs real layout
//    and lives in the Playwright suite; jsdom has no layout engine.
test('host popup survives a surrounding re-render', () => {
  const { h, render, document } = freshRuntime();
  let destroyed = false;
  let popup = null;
  const view = (chips) =>
    h(
      'div',
      null,
      ...chips.map((c) => h('span', { key: c }, c)),
      h('input', {
        key: 'in',
        ref: (el) => {
          if (el) {
            popup = document.createElement('div');
            popup.className = 'popup';
            document.body.appendChild(popup);
          } else {
            if (popup) popup.remove();
            destroyed = true;
          }
        },
      }),
    );

  render(view(['a']), document.body);
  const input = document.querySelector('input');

  assert.ok(document.querySelector('.popup'));

  render(view(['a', 'b', 'c']), document.body);

  assert.equal(document.querySelector('input'), input);
  assert.ok(document.querySelector('.popup'));
  assert.equal(destroyed, false);
});

// 14. Text children are posed as textContent (escaped natively); raw() is the only HTML path.
test('text children are escaped, raw() is the only HTML vector', () => {
  const { h, raw, render, document } = freshRuntime();

  render(h('div', { key: 'd' }, '<img onerror=alert(1)>'), document.body);
  const div = document.querySelector('div');

  assert.equal(div.querySelector('img'), null);
  assert.equal(div.textContent, '<img onerror=alert(1)>');

  render(h('div', { key: 'd2' }, raw('<b>bold</b>')), document.body);
  assert.ok(document.querySelector('b'));
});

// 15. Children of an <svg> are created in the SVG namespace.
test('svg subtree gets the SVG namespace', () => {
  const { h, render, document } = freshRuntime();

  render(h('svg', { key: 's' }, h('path', { d: 'M0 0' })), document.body);
  const svg = document.querySelector('svg');

  assert.equal(svg.namespaceURI, 'http://www.w3.org/2000/svg');
  assert.equal(svg.querySelector('path').namespaceURI, 'http://www.w3.org/2000/svg');
});

// 16. The tree rendered from a Set of open dirs: collapsing one dir leaves the other open
//    dir's subtree as the SAME node (no recreation).
test('collapsing one dir keeps the other open subtree identical', () => {
  const { h, render, document } = freshRuntime();
  const dir = (k, label, open) =>
    h('li', { key: k }, label, open ? h('ul', { key: k + ':ul' }, h('li', { key: k + '/1' }, label.toLowerCase() + '1')) : null);
  const tree = (open) =>
    h('ul', { key: 'root' }, dir('a', 'A', open.has('a')), dir('b', 'B', open.has('b')));
  const labelOf = (li) => li.firstChild.textContent;
  const find = (label) => [...document.querySelectorAll('li')].find((li) => labelOf(li) === label);

  const open = new Set(['a', 'b']);

  render(tree(open), document.body);
  const bUl = find('B').querySelector('ul');

  assert.ok(bUl);

  open.delete('a');
  render(tree(open), document.body);

  assert.equal(find('A').querySelector('ul'), null);
  assert.equal(find('B').querySelector('ul'), bUl);
});
