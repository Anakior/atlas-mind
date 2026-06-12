/* Config Tailwind v3 pour la précompilation de web/vendor/tailwind.css.
 *
 * Miroir EXACT de l'ancien `tailwind.config` inline du viewer (couleurs
 * navy/ink/accent, familles sans/serif/mono) + plugin typography — ce que
 * chargeait le CDN cdn.tailwindcss.com?plugins=typography.
 *
 * `content` couvre viewer.html en entier (le scanner texte attrape aussi les
 * classes écrites en clair dans le <script>) ; `safelist` ajoute les tokens
 * extraits des chaînes JS par extract-safelist.py (classes construites
 * dynamiquement). Régénération : voir l'en-tête de web/vendor/tailwind.css.
 */
const fs = require('fs');
const path = require('path');

// Le plugin est résolu depuis le node_modules du DOSSIER COURANT (là où la
// commande de régénération a fait `npm install`), pas depuis web/tailwind/
// (le repo Atlas n'a pas de node_modules : stdlib only côté moteur).
const typography = require(require.resolve('@tailwindcss/typography', {
  paths: [process.cwd(), __dirname],
}));

const safelist = fs
  .readFileSync(path.join(__dirname, 'safelist.txt'), 'utf-8')
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

module.exports = {
  content: [
    path.join(__dirname, '..', 'viewer.html'),
    path.join(__dirname, '..', '..', 'examples', 'extensions', '**', '*.{js,css,py}'),
  ],
  safelist,
  theme: {
    extend: {
      colors: {
        navy: {
          900: '#0e0d12',
          800: '#1a181e',
          700: '#23222a',
          600: '#2f2d36',
          500: '#3e3c47',
        },
        ink: {
          100: '#ffffff',
          200: '#d1d2d3',
          300: '#b0b1b5',
          400: '#868a90',
          500: '#5e6066',
        },
        accent: '#1d9bd1',
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
