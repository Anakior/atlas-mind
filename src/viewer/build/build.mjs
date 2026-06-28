// Bundle the viewer sources into one IIFE, read by src/build/render.py.
//
// esbuild --bundle from the single ESM entry lib/main.ts, which side-effect-imports every module
// in load order (so esbuild includes + evaluates them in that sequence). format:iife keeps the one
// shared runtime scope the modules expect; treeShaking off keeps every module's side effects and
// the __DATA__/__EMBED_* barewords render.py substitutes later. Whitespace + syntax are minified but
// IDENTIFIERS are kept (minifyIdentifiers off): the artifact shrinks ~30% yet every symbol name stays
// intact, so the barewords, the public window.* API extensions read, and the Python build's regex pass
// all keep working — and the bundle stays greppable/debuggable. charset utf8 keeps accents literal.
import esbuild from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const libDir = join(here, '..', 'lib');
const outfile = join(here, '..', 'vendor', 'app.bundle.js');

esbuild.buildSync({
  entryPoints: [join(libDir, 'main.ts')],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  treeShaking: false,
  minifyWhitespace: true,
  minifySyntax: true,
  minifyIdentifiers: false,
  charset: 'utf8',
  legalComments: 'none',
  outfile,
  logLevel: 'info',
});
console.log('[atlas-ts] bundled lib/main.ts -> viewer/vendor/app.bundle.js');
