// Compile the viewer sources into one bundle, read by src/build/render.py.
//
// Transform-concat (NOT esbuild --bundle): each file is emitted then concatenated in
// NN- prefix order, preserving the shared global scope the modules use (no import/
// export). A .js is passed through UNCHANGED (it is already the runtime target, so the
// bundle stays byte-identical to the old Python concat and existing tests hold); only a
// .ts is transpiled by esbuild (types stripped). charset utf8 keeps accents literal; the
// __DATA__/__EMBED_* barewords are substituted later by render.py, so nothing here may
// rename or drop them (hence minify/treeShaking off on the .ts path).
import { transformSync } from 'esbuild';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const jsDir = join(here, '..', 'js');
const out = join(here, '..', 'vendor', 'app.bundle.js');

const files = readdirSync(jsDir)
  .filter((f) => f.endsWith('.js') || f.endsWith('.ts'))
  .sort();

const bundle = files
  .map((f) => {
    const src = readFileSync(join(jsDir, f), 'utf8');
    if (extname(f) !== '.ts') return src;
    return transformSync(src, {
      loader: 'ts',
      target: 'es2020',
      charset: 'utf8',
      minify: false,
      treeShaking: false,
    }).code;
  })
  .join('\n');

writeFileSync(out, bundle, 'utf8');
console.log(`[atlas-ts] ${files.length} sources -> web/vendor/app.bundle.js`);
