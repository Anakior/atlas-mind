// Loads the Atlas DOM runtime into a fresh jsdom for each test. The runtime IIFE attaches
// its public API to its `root` (here, jsdom's window) and reads `document` from scope, so we
// transpile it once (esbuild, types stripped) and run it per test with an isolated DOM.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

const SRC = fileURLToPath(new URL('../../js/00b-atlas-dom.ts', import.meta.url));
const RUNTIME_JS = esbuild.transformSync(readFileSync(SRC, 'utf8'), {
  loader: 'ts',
  target: 'es2020',
}).code;

export function freshRuntime() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  const { window } = dom;

  new Function('window', 'document', RUNTIME_JS)(window, window.document);

  const { h, raw, render, createApp, Show } = window;

  return { h, raw, render, createApp, Show, window, document: window.document };
}
