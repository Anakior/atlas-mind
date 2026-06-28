// Bundle the viewer sources into one IIFE, read by src/build/render.py.
//
// esbuild --bundle from the single ESM entry lib/main.ts, which side-effect-imports every module
// in load order (so esbuild includes + evaluates them in that sequence). format:iife keeps the one
// shared runtime scope the modules expect; treeShaking off keeps every module's side effects and
// the __DATA__/__EMBED_* barewords render.py substitutes later; minify off + charset utf8 keep
// those barewords and accents literal so the Python build can fill them in one regex pass.
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
  minify: false,
  charset: 'utf8',
  legalComments: 'none',
  outfile,
  logLevel: 'info',
});
console.log('[atlas-ts] bundled lib/main.ts -> viewer/vendor/app.bundle.js');
