// Tests for the Mind graph's Barnes-Hut repulsion (graph-layout.ts): the exact pairwise sum on a
// small graph, close to it on a big one, finite on coincident nodes. graph-layout.ts is bundled with
// its two core imports stubbed (they read the baked mind data at load). Run with: npm run
// test:runtime (in src/viewer/build).
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const SRC = fileURLToPath(new URL('../../lib/graph/graph-layout.ts', import.meta.url));
const STUBS = { tree: 'export const fileMap = {};', state: 'export const EMBED_MIND = false;' };
const bundle = await esbuild.build({
  entryPoints: [SRC],
  bundle: true,
  format: 'iife',
  globalName: 'GraphLayoutModule',
  target: 'es2020',
  write: false,
  plugins: [
    {
      name: 'stub-core',
      setup(b) {
        b.onResolve({ filter: /\/core\/(tree|state)$/ }, (a) => ({ path: a.path.split('/').pop(), namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: STUBS[a.path], loader: 'js' }));
      },
    },
  ],
});
const { Repulsion } = new Function(bundle.outputFiles[0].text + '\nreturn GraphLayoutModule;')();

const REP = 13000,
  SOFT = 400;

// mulberry32: seeded, so a failure reproduces.
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);

    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Nodes in a dozen discs, like folders settling into zones.
function nodes(n, seed) {
  const rnd = random(seed);
  const zones = Array.from({ length: 12 }, () => [(rnd() - 0.5) * 3000, (rnd() - 0.5) * 3000]);

  return Array.from({ length: n }, () => {
    const [zx, zy] = zones[Math.floor(rnd() * zones.length)];
    const r = 300 * Math.sqrt(rnd()),
      a = rnd() * 2 * Math.PI;

    return { x: zx + r * Math.cos(a), y: zy + r * Math.sin(a), vx: 0, vy: 0 };
  });
}

// The force every node got from the former all-pairs loop.
function exact(ns) {
  return ns.map((a) => {
    let fx = 0,
      fy = 0;

    for (const b of ns) {
      if (a === b) continue;
      const dx = a.x - b.x,
        dy = a.y - b.y,
        d2 = dx * dx + dy * dy || 0.01,
        f = REP / (d2 + SOFT) / Math.sqrt(d2);

      fx += f * dx;
      fy += f * dy;
    }

    return [fx, fy];
  });
}

test('a small graph gets the exact pairwise repulsion', () => {
  const ns = nodes(250, 1);
  const ref = exact(ns);

  new Repulsion().apply(ns, REP, SOFT);
  ns.forEach((n, i) => {
    assert.ok(Math.abs(n.vx - ref[i][0]) < 1e-9 && Math.abs(n.vy - ref[i][1]) < 1e-9, `node ${i}`);
  });
});

test('a big graph stays close to the exact repulsion', () => {
  const ns = nodes(3000, 2);
  const ref = exact(ns);
  let err = 0,
    mag = 0;

  new Repulsion().apply(ns, REP, SOFT);
  ns.forEach((n, i) => {
    err += (n.vx - ref[i][0]) ** 2 + (n.vy - ref[i][1]) ** 2;
    mag += ref[i][0] ** 2 + ref[i][1] ** 2;
  });

  assert.ok(Math.sqrt(err / mag) < 0.08, `relative RMS error ${Math.sqrt(err / mag)}`);
});

test('coincident nodes push each other nothing and never give NaN', () => {
  const pile = Array.from({ length: 500 }, () => ({ x: 10, y: 10, vx: 0, vy: 0 }));
  const mixed = [...nodes(400, 3), ...pile.slice(0, 400)];

  new Repulsion().apply(pile, REP, SOFT);
  assert.ok(pile.every((n) => n.vx === 0 && n.vy === 0));

  new Repulsion().apply(mixed, REP, SOFT);
  assert.ok(mixed.every((n) => Number.isFinite(n.vx) && Number.isFinite(n.vy)));
});
