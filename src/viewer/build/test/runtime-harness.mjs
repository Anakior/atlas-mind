// Loads the Atlas DOM runtime into a fresh jsdom for each test. atlas-dom.ts is a real ES
// module now (exports h/raw/render/createApp/Show); we esbuild-BUNDLE it once as an iife that
// returns its public API on a global, then run that per test inside an isolated DOM (the runtime
// reads `window`/`document` from scope, supplied as the Function's parameters).
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

const SRC = fileURLToPath(new URL('../../lib/runtime/atlas-dom.ts', import.meta.url));
const RUNTIME_JS = esbuild.buildSync({
  entryPoints: [SRC],
  bundle: true,
  format: 'iife',
  globalName: 'AtlasRuntime',
  target: 'es2020',
  write: false,
}).outputFiles[0].text;

export function freshRuntime() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  const { window } = dom;

  const exports = new Function('window', 'document', RUNTIME_JS + '\nreturn AtlasRuntime;')(
    window, window.document);

  const { h, raw, render, createApp, Show } = exports;

  return { h, raw, render, createApp, Show, window, document: window.document };
}
