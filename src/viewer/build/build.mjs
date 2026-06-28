// Compile the viewer sources into one bundle, read by src/build/render.py.
//
// Transform-concat (NOT esbuild --bundle): each file is emitted then concatenated in the
// explicit load order from build-order.mjs (sources live in clean-named folders), preserving
// the shared global scope the modules use (no import/export). Each .ts is transpiled by
// esbuild (types stripped). charset utf8 keeps accents literal; the
// __DATA__/__EMBED_* barewords are substituted later by render.py, so nothing here may
// rename or drop them (hence minify/treeShaking off on the .ts path).
import { transformSync } from 'esbuild';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORDER } from './build-order.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const jsDir = join(here, '..', 'lib');
const out = join(here, '..', 'vendor', 'app.bundle.js');

const bundle = ORDER
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

// Atomic write: render.py reads this file, so it must never see a half-written bundle.
// Write a pid-unique temp then rename (atomic on the same volume, replaces on Windows too).
const tmp = `${out}.${process.pid}.tmp`;
writeFileSync(tmp, bundle, 'utf8');
renameSync(tmp, out);
console.log(`[atlas-ts] ${ORDER.length} sources -> viewer/vendor/app.bundle.js`);
