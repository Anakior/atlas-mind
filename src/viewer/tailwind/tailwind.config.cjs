/* Config Tailwind v3 pour la précompilation de viewer/vendor/tailwind.css.
 *
 * Miroir EXACT de l'ancien `tailwind.config` inline du viewer (couleurs
 * navy/ink/accent, familles sans/serif/mono) + plugin typography — ce que
 * chargeait le CDN cdn.tailwindcss.com?plugins=typography.
 *
 * `content` couvre viewer.html en entier (le scanner texte attrape aussi les
 * classes écrites en clair dans le <script>) ; `safelist` ajoute les tokens
 * extraits des chaînes JS par extract-safelist.py (classes construites
 * dynamiquement). Régénération : voir l'en-tête de viewer/vendor/tailwind.css.
 */
const fs = require('fs');
const path = require('path');

// Le plugin est résolu depuis le node_modules du DOSSIER COURANT (là où la
// commande de régénération a fait `npm install`), pas depuis viewer/tailwind/
// (le repo Atlas n'a pas de node_modules : stdlib only côté moteur).
const typography = require(require.resolve('@tailwindcss/typography', {
  paths: [process.cwd(), __dirname],
}));

const safelist = fs
  .readFileSync(path.join(__dirname, 'safelist.txt'), 'utf-8')
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

// The palette reads the tokens of styles/00-tokens.css, so a skin or an extension restyles every
// class at once; <alpha-value> keeps the opacity variants (bg-navy-800/90, ring-accent/40).
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

module.exports = {
  content: [
    path.join(__dirname, '..', 'viewer.html'),
    // Demonolithified viewer: the markup + classes now live in partials/, pages/
    // and the JS modules (not viewer.html anymore). Scan them ALL, otherwise any
    // newly-used utility (e.g. rounded-2xl) never lands in the precompiled CSS.
    path.join(__dirname, '..', 'partials', '**', '*.html'),
    path.join(__dirname, '..', 'pages', '**', '*.html'),
    path.join(__dirname, '..', 'lib', '**', '*.{js,ts}'),
    path.join(__dirname, '..', '..', 'examples', 'extensions', '**', '*.{js,css,py}'),
  ],
  safelist,
  theme: {
    extend: {
      colors: {
        navy: {
          900: token('navy-900'),
          800: token('navy-800'),
          700: token('navy-700'),
          600: token('navy-600'),
          500: token('navy-500'),
        },
        ink: {
          100: token('ink-100'),
          200: token('ink-200'),
          300: token('ink-300'),
          400: token('ink-400'),
          500: token('ink-500'),
        },
        accent: token('accent'),
        page: token('page'),
        brand: token('brand'),
      },
      fontFamily: {
        sans: ['Manrope', 'system-ui', 'sans-serif'],
        serif: ['Lora', 'Georgia', 'serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [typography],
};
