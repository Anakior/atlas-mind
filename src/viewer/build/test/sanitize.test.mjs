// Tests for the document sanitizer (lib/content/sanitize.ts) over the vendored DOMPurify, in jsdom:
// a note can't draw a form, a global style or anything that leaves the page, and keeps its harmless
// formatting and its task checkboxes. Run with: npm run test:runtime (in src/viewer/build).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

const SRC = fileURLToPath(new URL('../../lib/content/sanitize.ts', import.meta.url));
const PURIFY = readFileSync(new URL('../../vendor/purify.min.js', import.meta.url), 'utf8');
const CODE = esbuild.buildSync({
  entryPoints: [SRC],
  bundle: true,
  format: 'iife',
  globalName: 'SanitizeModule',
  target: 'es2020',
  write: false,
}).outputFiles[0].text;

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'outside-only' });

dom.window.eval(PURIFY);
const { sanitizeHtml, DOC_ID_PREFIX } = new Function('window', 'document', 'DOMPurify', CODE + '\nreturn SanitizeModule;')(
  dom.window, dom.window.document, dom.window.DOMPurify);

// The sanitized HTML, parsed back, to query it.
function clean(html, forbid) {
  const box = dom.window.document.createElement('div');

  box.innerHTML = sanitizeHtml(html, forbid);

  return box;
}

test('a fake sign-in box is left with nothing to type into', () => {
  const box = clean('<form action="https://evil.example"><input type="password" name="pw"><textarea></textarea>'
    + '<select><option>a</option></select><button>Se reconnecter</button></form>');

  assert.equal(box.querySelector('form, textarea, select, button'), null);
  const input = box.querySelector('input');

  // The one input kept is turned into what a doc may hold: a disabled checkbox.
  assert.equal(input.getAttribute('type'), 'checkbox');
  assert.ok(input.hasAttribute('disabled'));
});

test('no style sheet: a doc cannot restyle the viewer', () => {
  assert.equal(clean('<style>body{display:none}</style><p>x</p>').querySelector('style'), null);
});

test('inline styles keep the colours, lose what moves the element', () => {
  const div = clean('<div style="position:fixed;inset:0;z-index:99;transform:translateY(-50px);margin-top:-900px;'
    + 'color:red;background-color:#123456;font-weight:bold;background-image:url(https://t.example/p.gif)">x</div>').querySelector('div');
  const style = div.getAttribute('style');

  assert.match(style, /color:\s*red/);
  assert.match(style, /background-color/);
  assert.match(style, /font-weight:\s*bold/);
  for (const banned of ['position', 'inset', 'z-index', 'transform', 'margin', 'url(']) assert.ok(!style.includes(banned), banned);
  assert.equal(clean('<span style="position:absolute;top:0">x</span>').querySelector('span').hasAttribute('style'), false);
});

test('only the classes the rendering gives survive', () => {
  const box = clean('<div class="fixed inset-0 z-50 overlay-backdrop">x</div>'
    + '<pre><code class="hljs language-js"><span class="hljs-keyword">const</span></code></pre>'
    + '<a class="wikilink broken">y</a>');

  assert.equal(box.querySelector('div').hasAttribute('class'), false);
  assert.equal(box.querySelector('code').className, 'hljs language-js');
  assert.equal(box.querySelector('span').className, 'hljs-keyword');
  assert.equal(box.querySelector('a').className, 'wikilink broken');
});

test('a task list keeps its checkboxes and their state', () => {
  const box = clean('<ul><li><input checked="" disabled="" type="checkbox"> done</li><li><input disabled="" type="checkbox"> todo</li></ul>');
  const boxes = box.querySelectorAll('input[type="checkbox"]');

  assert.equal(boxes.length, 2);
  assert.ok(boxes[0].hasAttribute('checked'));
  assert.ok(!boxes[1].hasAttribute('checked'));
});

test('ids get the doc prefix, so a doc cannot stand in for the app', () => {
  assert.equal(clean('<span id="confirm-ok">x</span>').querySelector('span').id, DOC_ID_PREFIX + 'confirm-ok');
});

test('scripts and handlers still go, and extra forbidden tags apply', () => {
  const box = clean('<img src="x" onerror="alert(1)"><script>alert(1)</script><a href="javascript:alert(1)">z</a>', ['img']);

  assert.equal(box.querySelector('script, img'), null);
  assert.equal(box.querySelector('a').hasAttribute('href'), false);
});
