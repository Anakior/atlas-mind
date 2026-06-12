/* Service worker — Atlas (viewer PWA)
 *
 * Objectif : chargement instantané + consultation hors-ligne de la PWA, sans
 * casser l'auth (cookie de session same-origin, relayé automatiquement par fetch).
 *
 * Stratégies :
 *   - navigations (shell HTML)       → network-first  (frais en ligne, cache hors-ligne)
 *   - assets /vendor/ / .md / JSON   → stale-while-revalidate
 *   - /api/*, login, share, SSE      → bypass total (jamais caché : dynamique / auth)
 *
 * CACHE_VERSION embarque la version du moteur (__ENGINE_VERSION__ est remplacé
 * à la volée quand le serveur sert ce fichier). À chaque release le nom de cache
 * change donc, `activate` purge l'ancien cache et `install` reprécache des assets
 * frais — sinon les fichiers vendored non versionnés (tailwind.css, fonts…)
 * restaient bloqués sur leur ancienne copie après un déploiement. Le shell HTML
 * est en network-first et les .md sont versionnés par ?v=<mtime> (URL = cache-buster).
 */
const CACHE_VERSION = 'atlas-cache-__ENGINE_VERSION__';
const PRECACHE = [
  '/', '/manifest.json', '/icon.svg',
  // Libs vendorées (chargées par le shell — voir web/viewer.html).
  '/vendor/tailwind.css',
  '/vendor/fonts.css',
  '/vendor/marked.min.js',
  '/vendor/purify.min.js',
  '/vendor/highlight.min.js',
  '/vendor/highlight-github-dark.min.css',
  '/vendor/minisearch.min.js',
  // Fontes locales référencées par fonts.css (subsets latin + latin-ext).
  '/vendor/fonts/corinthia-latin.woff2',
  '/vendor/fonts/corinthia-latin-ext.woff2',
  '/vendor/fonts/corinthia-latin-700.woff2',
  '/vendor/fonts/corinthia-latin-ext-700.woff2',
  '/vendor/fonts/jetbrains-mono-latin.woff2',
  '/vendor/fonts/jetbrains-mono-latin-ext.woff2',
  '/vendor/fonts/lora-latin.woff2',
  '/vendor/fonts/lora-latin-ext.woff2',
  '/vendor/fonts/lora-italic-latin.woff2',
  '/vendor/fonts/lora-italic-latin-ext.woff2',
  '/vendor/fonts/manrope-latin.woff2',
  '/vendor/fonts/manrope-latin-ext.woff2',
  '/vendor/fonts/rubik-80s-fade-latin.woff2',
  '/vendor/fonts/rubik-80s-fade-latin-ext.woff2',
];

// Préfixes same-origin jamais cachés (dynamique, auth-sensible, ou streaming SSE).
const BYPASS = ['/api/', '/login', '/logout', '/share/', '/mcp/', '/webhook/', '/.well-known/'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())  // un asset de precache absent ne doit pas bloquer l'install
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Ne stocke que les réponses exploitables : 200 same-origin/cors, ou opaques (CDN no-cors).
function putInCache(request, response) {
  if (!response || (response.status !== 200 && response.type !== 'opaque')) return;
  const copy = response.clone();
  caches.open(CACHE_VERSION).then((c) => c.put(request, copy));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;  // on ne touche qu'aux GET
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // 1. Routes dynamiques / auth / streaming : laisser passer au réseau, sans cache.
  if (sameOrigin && BYPASS.some((p) => url.pathname.startsWith(p))) return;

  // 2. Navigations (chargement du shell) : network-first.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Ne pas cacher une redirection vers /login comme si c'était le shell.
          if (res.ok && !res.redirected) putInCache('/', res);
          return res;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  // 3. Reste (/vendor/, .md, _search-data.json, icônes…) : stale-while-revalidate.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => { putInCache(req, res); return res; })
        .catch(() => cached);
      return cached || network;
    })
  );
});
