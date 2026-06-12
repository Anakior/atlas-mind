// Extension PoB — module Path of Exile pour Atlas (viewer).
//
// Installé via <mind>/.atlas/extensions/pob.js (avec pob.css et pob.py) :
// build.py inline ce fichier dans dist/index.html, et server.py l'injecte
// aussi dans les pages de partage publiques.
//
// Autonome : i18n, helpers et DOM embarqués. Deux contextes d'exécution :
//   - page de partage : seul le délégué de clics (.poe-var-tab / .poe-copy)
//     est actif — il n'y a ni modale ni API window.Atlas ;
//   - viewer : enregistre le template « Import Path of Building » via
//     window.Atlas.registerTemplate, injecte le bouton « Maj PoB » et sa
//     modale, et suit le doc courant via les évènements atlas:doc-rendered /
//     atlas:edit-enter.
(function () {
'use strict';

// ─── i18n embarquée (même mécanique que le viewer : fr par défaut) ───────────
const LANG = (document.documentElement.lang || 'fr').toLowerCase().startsWith('en') ? 'en' : 'fr';
const STRINGS = {
  fr: {
    tplPob: 'Import Path of Building (PoE1/PoE2)',
    updatePobTitle: 'Réimporter depuis un code Path of Building',
    updatePobBtn: 'Maj PoB',
    updatePobHeader: 'Mettre à jour depuis Path of Building',
    updatePobHint: 'Colle un nouveau code PoB — le contenu du document sera regeneré en gardant le même fichier.',
    pobCharLabel: 'Nom du personnage',
    pobCharHint: '(optionnel, conservé aux maj)',
    pobCharPlaceholder: 'ex: MonPerso_TheRanger',
    pobCodesLabel: 'Codes PoB',
    pobCodesHint: '(un par skill — PoB ne calcule le DPS que du skill sélectionné)',
    pobCodesHint2: '(un par skill / variante)',
    pobCodesHelp: "Plusieurs codes = plusieurs variantes de DPS (onglets dans la fiche). Laisse le nom de fichier vide pour qu'il soit généré depuis la classe.",
    autoFromClass: '(auto depuis la classe)',
    pobCodeRequired: 'Colle au moins un code PoB',
    pobCodeRequired2: 'Au moins un code PoB requis',
    pobPrefix: m => 'PoB : ' + m,
    pobImported: 'Build PoB importe',
    pobUpdated: 'Build PoB mis a jour',
    removeSkill: 'Retirer ce skill',
    addSkill: '+ Ajouter un skill',
    charKept: 'Personnage conservé :',
    regenerate: 'Régénérer',
    cancel: 'Annuler',
    copyBtn: 'Copier',
    copiedCheck: 'Copié ✓',
    cdnFailPako: 'Impossible de charger pako (decodeur zlib)',
    pobEmpty: 'Code PoB vide',
    pobBadBase64: 'Code PoB invalide (base64 corrompu)',
    pobBadZlib: 'Code PoB invalide (decompression zlib echouee)',
    pobNotPob: "Le code decode n'est pas un PoB valide",
    pobBadXml: m => 'XML PoB illisible : ' + m,
    pobNoBuild: 'Aucun bloc <Build> dans le XML',
    err: m => 'Erreur : ' + m,
  },
  en: {
    tplPob: 'Path of Building import (PoE1/PoE2)',
    updatePobTitle: 'Re-import from a Path of Building code',
    updatePobBtn: 'Update PoB',
    updatePobHeader: 'Update from Path of Building',
    updatePobHint: 'Paste a new PoB code — the document content will be regenerated, keeping the same file.',
    pobCharLabel: 'Character name',
    pobCharHint: '(optional, kept on updates)',
    pobCharPlaceholder: 'e.g. MyChar_TheRanger',
    pobCodesLabel: 'PoB codes',
    pobCodesHint: '(one per skill — PoB only computes DPS for the selected skill)',
    pobCodesHint2: '(one per skill / variant)',
    pobCodesHelp: 'Several codes = several DPS variants (tabs in the sheet). Leave the file name empty to generate it from the class.',
    autoFromClass: '(auto from the class)',
    pobCodeRequired: 'Paste at least one PoB code',
    pobCodeRequired2: 'At least one PoB code required',
    pobPrefix: m => 'PoB: ' + m,
    pobImported: 'PoB build imported',
    pobUpdated: 'PoB build updated',
    removeSkill: 'Remove this skill',
    addSkill: '+ Add a skill',
    charKept: 'Character kept:',
    regenerate: 'Regenerate',
    cancel: 'Cancel',
    copyBtn: 'Copy',
    copiedCheck: 'Copied ✓',
    cdnFailPako: 'Could not load pako (zlib decoder)',
    pobEmpty: 'Empty PoB code',
    pobBadBase64: 'Invalid PoB code (corrupted base64)',
    pobBadZlib: 'Invalid PoB code (zlib decompression failed)',
    pobNotPob: 'The decoded code is not a valid PoB',
    pobBadXml: m => 'Unreadable PoB XML: ' + m,
    pobNoBuild: 'No <Build> block in the XML',
    err: m => 'Error: ' + m,
  },
};

function t(key, ...args) {
  const dict = STRINGS[LANG] || STRINGS.fr;
  let entry = dict[key];
  if (entry === undefined) entry = STRINGS.fr[key];
  if (entry === undefined) return key;
  return typeof entry === 'function' ? entry(...args) : entry;
}

// ─── Helpers embarqués (copies locales : la page de partage n'a pas ceux du viewer) ──
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function slugify(s) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ─── Partie commune viewer + page de partage : interactions de la fiche ──────
// Délégation sur #content (présent dans les deux pages) : onglets de variante
// de skill et boutons « Copier » du code PoB (DOMPurify retire les onclick
// inline → délégation obligatoire).
const contentRoot = document.getElementById('content');
if (contentRoot) {
  contentRoot.addEventListener('click', (e) => {
    // Onglet de variante : montre le bandeau de stats correspondant.
    const vtab = e.target.closest('.poe-var-tab');
    if (vtab) {
      e.preventDefault();
      const card = vtab.closest('.poe-card'); const v = vtab.dataset.var;
      if (card) card.querySelectorAll('.poe-var-tab[data-var], .poe-strip[data-var], .poe-res[data-var]')
        .forEach(el => el.classList.toggle('is-active', el.dataset.var === v));
      return;
    }
    // Bouton « Copier » du code PoB. Scope sur la ligne de variante si présente
    // (sinon le 1er code du <details>).
    const copy = e.target.closest('.poe-copy');
    if (!copy) return;
    e.preventDefault(); e.stopPropagation();
    const scope = copy.closest('.poe-share-row') || copy.closest('details');
    const code = scope?.querySelector('.poe-pob-code, .poe-share-box code')?.textContent || '';
    navigator.clipboard.writeText(code).then(() => {
      copy.textContent = t('copiedCheck');
      setTimeout(() => { copy.textContent = t('copyBtn'); }, 1500);
    }).catch(() => {});
  });
}

// ─── Partie viewer uniquement ────────────────────────────────────────────────
// Page de partage (ou API absente) : rien d'autre à brancher.
const btnEdit = document.getElementById('btn-edit');
if (!window.Atlas || typeof window.Atlas.registerTemplate !== 'function' || !btnEdit) return;

// Doc markdown affiché en dernier (suivi via atlas:doc-rendered) ; les codes
// PoB qu'il contient pilotent la visibilité du bouton « Maj PoB ».
let currentDocPath = null;
let _pobCodes = [];
let _pobCode = null;
let _pobCharName = '';

// Bouton « Maj PoB » dans la barre d'actions, juste avant « Éditer ».
const btnUpdatePob = document.createElement('button');
btnUpdatePob.id = 'btn-update-pob';
btnUpdatePob.className = 'hidden px-2.5 py-1 text-xs bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30 rounded flex items-center gap-1';
btnUpdatePob.title = t('updatePobTitle');
btnUpdatePob.innerHTML = '<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg><span></span>';
btnUpdatePob.querySelector('span').textContent = t('updatePobBtn');
btnEdit.parentElement.insertBefore(btnUpdatePob, btnEdit);

// Modale « Maj PoB » (data-atlas-modal : bloque le soft-reload du viewer tant
// qu'elle est ouverte, comme les modales natives).
const updatePobBackdrop = document.createElement('div');
updatePobBackdrop.id = 'update-pob-backdrop';
updatePobBackdrop.className = 'hidden fixed inset-0 z-50 bg-black/50 backdrop-blur-sm';
updatePobBackdrop.setAttribute('data-atlas-modal', '');
updatePobBackdrop.innerHTML = `
  <div class="absolute left-1/2 top-[15%] -translate-x-1/2 w-[32rem] max-w-[94vw] bg-navy-800 border subtle-border rounded-xl shadow-2xl shadow-black/70 p-5">
    <h3 class="text-base font-semibold text-ink-100 mb-1">${escapeHtml(t('updatePobHeader'))}</h3>
    <p class="text-xs text-ink-400 mb-4">${escapeHtml(t('updatePobHint'))}</p>
    <form id="update-pob-form" class="flex flex-col gap-3">
      <div id="update-pob-charname-hint" class="hidden text-xs text-ink-300 bg-navy-900/50 border subtle-border rounded px-3 py-2">
        <span>${escapeHtml(t('charKept'))}</span> <span id="update-pob-charname-value" class="font-mono text-ink-100"></span>
      </div>
      <label class="text-[11px] uppercase tracking-wider text-ink-500 font-semibold block"><span>${escapeHtml(t('pobCodesLabel'))}</span> <span class="text-ink-500 font-normal normal-case tracking-normal">${escapeHtml(t('pobCodesHint2'))}</span></label>
      <div id="update-pob-codes"></div>
      <div id="update-pob-error" class="text-xs text-rose-400 hidden"></div>
      <div class="flex justify-end gap-2 mt-1">
        <button type="button" id="update-pob-cancel" class="px-3 py-1.5 text-sm bg-navy-700 hover:bg-navy-600 text-ink-200 rounded">${escapeHtml(t('cancel'))}</button>
        <button type="submit" class="px-3 py-1.5 text-sm bg-amber-500 hover:brightness-110 text-white rounded font-medium">${escapeHtml(t('regenerate'))}</button>
      </div>
    </form>
  </div>`;
document.body.appendChild(updatePobBackdrop);

// Bloc de formulaire du template « Import PoB » (affiché par le viewer quand
// l'option est sélectionnée dans la modale « Nouveau document »).
const pobBlock = document.createElement('div');
pobBlock.className = 'flex flex-col gap-3';
pobBlock.innerHTML = `
  <div>
    <label class="text-[11px] uppercase tracking-wider text-ink-500 font-semibold mb-1 block"><span>${escapeHtml(t('pobCharLabel'))}</span> <span class="text-ink-500 font-normal normal-case tracking-normal">${escapeHtml(t('pobCharHint'))}</span></label>
    <input id="new-file-pob-charname" placeholder="${escapeHtml(t('pobCharPlaceholder'))}" autocomplete="off"
      class="w-full px-3 py-2 bg-navy-900 border subtle-border rounded text-ink-100 placeholder-ink-500 focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent text-sm">
  </div>
  <div>
    <label class="text-[11px] uppercase tracking-wider text-ink-500 font-semibold mb-1 block"><span>${escapeHtml(t('pobCodesLabel'))}</span> <span class="text-ink-500 font-normal normal-case tracking-normal">${escapeHtml(t('pobCodesHint'))}</span></label>
    <div id="new-file-pob-codes"></div>
    <p class="text-[11px] text-ink-500 mt-1">${escapeHtml(t('pobCodesHelp'))}</p>
  </div>`;
const newFilePobCodes = pobBlock.querySelector('#new-file-pob-codes');
const newFilePobCharname = pobBlock.querySelector('#new-file-pob-charname');

// Nouveau format fiche : code dans <div class="poe-share-box"><code class="poe-pob-code">…</code>.
// Ancien format (rétro-compat) : <summary>Code PoB…</summary> + bloc ``` fence.
const POB_MARKER_RE = /poe-share-box"><code[^>]*>([A-Za-z0-9_\-=]+)<\/code>|<summary>Code PoB[^<]*<\/summary>\s*\n+```\s*\n([A-Za-z0-9_\-=\s]+?)\n```/;
function extractPobCodeFromMarkdown(md) {
  const m = md && md.match(POB_MARKER_RE);
  return m ? (m[1] || m[2] || '').trim().replace(/\s+/g, '') : null;
}

// TOUS les codes (1 par variante) — regex global ANCRÉ sur le markup Partager (ne
// ramasse pas des <code> ailleurs). Fallback : extractPobCodeFromMarkdown (ancien format).
function extractAllPobCodes(md) {
  if (!md) return [];
  const codes = [];
  for (const m of md.matchAll(/poe-share-box"><code[^>]*>([A-Za-z0-9_\-=]+)<\/code>/g)) codes.push(m[1]);
  if (codes.length) return codes;
  const one = extractPobCodeFromMarkdown(md);
  return one ? [one] : [];
}

// Sépare des codes PoB collés dans une SAISIE utilisateur (jamais sur le markdown
// stocké). Inclut + et / (base64 standard) pour ne pas tronquer un code ; la
// normalisation base64url est faite au stockage (clean() dans le générateur).
function pobCodesFromText(txt) {
  return (txt || '').match(/[A-Za-z0-9_+/\-=]{50,}/g) || [];
}

function detectPobImport(markdown) {
  const codes = extractAllPobCodes(markdown);
  _pobCodes = codes;
  _pobCode = codes[0] || null;
  _pobCharName = codes.length ? extractCharNameFromMarkdown(markdown) : '';
  btnUpdatePob.classList.toggle('hidden', !codes.length || window.__viewerMode);
}

// ── Liste de champs de code PoB (1 par variante de skill) avec bouton « + » ───
function pobMakeCodeRow(value) {
  const row = document.createElement('div');
  row.className = 'pob-code-row flex gap-2 items-start';
  row.innerHTML = '<textarea rows="2" placeholder="eN..." class="pob-code-input flex-1 min-w-0 px-3 py-2 bg-navy-900 border subtle-border rounded text-ink-100 placeholder-ink-500 focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent text-xs font-mono resize-y"></textarea>'
    + '<button type="button" class="pob-code-rm px-2 py-1.5 text-ink-500 hover:text-rose-400 text-lg leading-none" title="' + escapeHtml(t('removeSkill')) + '">&times;</button>';
  row.querySelector('textarea').value = value || '';
  row.querySelector('.pob-code-rm').addEventListener('click', () => {
    const rows = row.parentElement.querySelectorAll('.pob-code-row');
    if (rows.length > 1) row.remove();
    else row.querySelector('textarea').value = '';  // garde toujours >= 1 champ
  });
  return row;
}
function pobCodeList(container, initialCodes) {
  container.innerHTML = '';
  const list = document.createElement('div');
  list.className = 'pob-code-rows flex flex-col gap-2';
  (initialCodes && initialCodes.length ? initialCodes : ['']).forEach(c => list.appendChild(pobMakeCodeRow(c)));
  container.appendChild(list);
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'pob-code-add self-start mt-1 text-[11px] font-semibold text-accent hover:brightness-110';
  add.textContent = t('addSkill');
  add.addEventListener('click', () => { const r = pobMakeCodeRow(''); list.appendChild(r); r.querySelector('textarea').focus(); });
  container.appendChild(add);
}
function readPobCodes(container) {
  const txt = Array.from(container.querySelectorAll('.pob-code-input')).map(t => t.value).join(' ');
  return pobCodesFromText(txt);
}

// ── PoB import (Path of Building decoder, lazy pako) ─────────────────────────
async function loadPakoLib() {
  if (typeof pako !== 'undefined') return;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/pako.min.js';  // pako 2.1.0 vendoré (web/vendor/)
    s.onload = resolve;
    s.onerror = () => reject(new Error(t('cdnFailPako')));
    document.head.appendChild(s);
  });
}

function decodePobCode(code) {
  const sanitized = (code || '').trim().replace(/\s+/g, '');
  if (!sanitized) throw new Error(t('pobEmpty'));
  const standard = sanitized.replace(/-/g, '+').replace(/_/g, '/');
  const padded = standard + '='.repeat((4 - standard.length % 4) % 4);
  let binary;
  try { binary = atob(padded); }
  catch (e) { throw new Error(t('pobBadBase64')); }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  let xml;
  try { xml = pako.inflate(bytes, { to: 'string' }); }
  catch (e) { throw new Error(t('pobBadZlib')); }
  if (!xml.includes('<PathOfBuilding')) throw new Error(t('pobNotPob'));
  return xml;
}

function fmtNum(n) {
  const num = Number(n);
  if (!isFinite(num)) return n;
  if (Math.abs(num) >= 1000) return num.toLocaleString('fr-FR', { maximumFractionDigits: 0 });
  if (num % 1 === 0) return String(num);
  return num.toFixed(2);
}

function pobSlugifyTitle(s) { return (slugify(s) || 'build').slice(0, 60); }

// Notation compacte pour les cartes de stats : 1.24M, 25.2k, 980.
function pobCompact(n) {
  const num = Number(n);
  if (!isFinite(num)) return String(n);
  const abs = Math.abs(num);
  if (abs >= 1e9) return (num / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'G';
  if (abs >= 1e6) return (num / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (abs >= 1e4) return (num / 1e3).toFixed(1).replace(/\.?0+$/, '') + 'k';
  if (abs >= 1000) return num.toLocaleString('fr-FR', { maximumFractionDigits: 0 });
  return num % 1 === 0 ? String(num) : num.toFixed(1);
}

// Clés de config PoB → libellé lisible. PoB n'exporte que des clés internes
// (pas de label humain) : on prettifie (camelCase/snake → mots, Title Case).
// Les passifs de quête (questActN…) ont une valeur déjà parlante → label générique.
function prettyCfgKey(k) {
  const q = k.match(/^questAct\s*(\d+)/i);
  if (q) return 'Quête · Acte ' + q[1];
  return k.replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ').trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

// Libellé du skill principal (label du groupe, sinon 1re gemme).
function mainSocketGroupSkillLabel(skillGroups, mainSocketGroup) {
  const sg = mainSocketGroup && skillGroups[mainSocketGroup - 1];
  if (!sg) return '';
  const lbl = sg.getAttribute('label') || '';
  const g = sg.querySelector('Gem');
  return lbl || (g ? (g.getAttribute('nameSpec') || g.getAttribute('skillId') || '') : '');
}

// Groupes de skills d'un doc PoB (format SkillSet/activeSkillSet ou flat).
function pobSkillGroups(doc) {
  const sets = Array.from(doc.querySelectorAll('Skills > SkillSet'));
  if (sets.length) {
    const active = doc.querySelector('Skills')?.getAttribute('activeSkillSet') || '1';
    const set = sets.find(s => s.getAttribute('id') === active) || sets[0];
    return Array.from(set.querySelectorAll('Skill'));
  }
  return Array.from(doc.querySelectorAll('Skills > Skill'));
}

// Stats (<PlayerStat>) + libellé du skill principal d'un doc PoB décodé.
function pobStatsAndSkill(doc) {
  const build = doc.querySelector('Build');
  const stats = {};
  doc.querySelectorAll('Build > PlayerStat').forEach(s => { stats[s.getAttribute('stat')] = s.getAttribute('value'); });
  const msg = parseInt(build?.getAttribute('mainSocketGroup') || '0', 10);
  const label = mainSocketGroupSkillLabel(pobSkillGroups(doc), msg) || (build?.getAttribute('className') || 'Build');
  return { stats, label };
}

// Décode un code PoB (variante) → {ok, stats, label}. Variante invalide → {ok:false}.
function pobVariantData(code) {
  try {
    const doc = new DOMParser().parseFromString(decodePobCode(code), 'text/xml');
    if (doc.querySelector('parsererror') || !doc.querySelector('Build')) return { ok: false };
    return { ok: true, ...pobStatsAndSkill(doc) };
  } catch (e) { console.warn('Variante PoB ignorée :', e && e.message); return { ok: false }; }
}

// `codes` = tableau de codes PoB (1 par variante de skill) ; `xml` = décodage de codes[0] (primaire).
async function pobXmlToMarkdown(xml, codes, charName) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const parseErr = doc.querySelector('parsererror');
  if (parseErr) throw new Error(t('pobBadXml', parseErr.textContent.slice(0, 120)));

  const build = doc.querySelector('Build');
  if (!build) throw new Error(t('pobNoBuild'));

  const stats = {};
  doc.querySelectorAll('Build > PlayerStat').forEach(s => {
    stats[s.getAttribute('stat')] = s.getAttribute('value');
  });

  const className = build.getAttribute('className') || '?';
  const ascendClassName = build.getAttribute('ascendClassName') || '';
  const level = build.getAttribute('level') || '?';
  const mainSocketGroup = parseInt(build.getAttribute('mainSocketGroup') || '0', 10);
  const bandit = build.getAttribute('bandit') || '';
  const pantheonMajor = build.getAttribute('pantheonMajorGod') || '';
  const pantheonMinor = build.getAttribute('pantheonMinorGod') || '';
  const targetVersion = build.getAttribute('targetVersion') || '';
  const viewMode = build.getAttribute('viewMode') || '';

  // Tree spec (premier Spec du Tree actif)
  const treeActive = parseInt(doc.querySelector('Tree')?.getAttribute('activeSpec') || '1', 10);
  const specs = Array.from(doc.querySelectorAll('Tree > Spec'));
  const activeSpec = specs[treeActive - 1] || specs[0];
  const treeUrl = activeSpec?.querySelector('URL')?.textContent?.trim() || '';
  const treeVersion = activeSpec?.getAttribute('treeVersion') || '';
  const nodesStr = activeSpec?.getAttribute('nodes') || '';
  const nodesCount = nodesStr ? nodesStr.split(',').filter(Boolean).length : 0;
  const masteriesStr = activeSpec?.getAttribute('masteryEffects') || '';
  const masteriesCount = (masteriesStr.match(/\{[^}]+\}/g) || []).length;
  const treeClassId = activeSpec?.getAttribute('classId') || '';
  const treeAscendClassId = activeSpec?.getAttribute('ascendClassId') || '';

  // PoE2 detection : treeVersion 2_x (PoE1 = 3_x) ou classes connues PoE2
  const poe2Classes = new Set(['Sorceress', 'Warrior', 'Mercenary', 'Monk', 'Druid', 'Huntress']);
  const isPoe2 = treeVersion.startsWith('2_') || poe2Classes.has(className);
  const gameLabel = isPoe2 ? 'PoE2' : 'PoE1';

  // Skills (parcourt SkillSet > Skill > Gem)
  const skillSets = Array.from(doc.querySelectorAll('Skills > SkillSet'));
  const flatSkillsRoot = doc.querySelector('Skills');
  let skillGroups = [];
  if (skillSets.length) {
    // Format moderne : on prend l'activeSkillSet
    const activeSkillSet = flatSkillsRoot?.getAttribute('activeSkillSet') || '1';
    const set = skillSets.find(s => s.getAttribute('id') === activeSkillSet) || skillSets[0];
    skillGroups = Array.from(set.querySelectorAll('Skill'));
  } else {
    skillGroups = Array.from(doc.querySelectorAll('Skills > Skill'));
  }

  // Items et slots
  const items = {};
  doc.querySelectorAll('Items > Item').forEach(it => {
    items[it.getAttribute('id')] = it.textContent.trim();
  });
  const itemSets = Array.from(doc.querySelectorAll('Items > ItemSet'));
  const activeItemSet = doc.querySelector('Items')?.getAttribute('activeItemSet') || '1';
  const itemSet = itemSets.find(s => s.getAttribute('id') === activeItemSet) || itemSets[0];
  const slots = itemSet ? Array.from(itemSet.querySelectorAll('Slot')) : [];

  // Parsing + carte d'item (rareté, mods) — partagé par l'équipement ET les jewels
  // de l'arbre (qui sont des items référencés par les <Socket> du spec).
  const ITEM_RAR = { NORMAL: 'norm', MAGIC: 'mag', RARE: 'rare', UNIQUE: 'uniq', RELIC: 'uniq' };
  const ITEM_META = new Set(['Unique ID','LevelReq','Selected Variant','Has Variants','League','Source',
    'Requires','Crucible','Catalyst','Crafted','Prefix','Suffix','Implicit']);
  const itemHl = (text) => escapeHtml(text).replace(/([+\-]?\d+(?:\.\d+)?%?)/g, '<span class="poe-v">$1</span>');
  function parseItem(raw) {
    let ls = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean).filter(l => !l.startsWith('<'));
    if (!ls.length) return null;
    const rar = ls[0].replace(/^Rarity:\s*/i, '').trim().toUpperCase();
    const name = ls[1] || '';
    let body = ls.slice(2);
    let base = '';
    if (body.length && !body[0].includes(':') && !body[0].startsWith('{')) { base = body[0]; body = body.slice(1); }
    let ilvl = '', qual = '', corrupted = false, nImpl = 0;
    const mods = [];
    body.forEach(l => {
      const key = l.split(':', 1)[0].trim();
      if (key === 'Item Level') { ilvl = l.split(':')[1].trim(); return; }
      if (key === 'Quality') { qual = l.split(':')[1].trim(); return; }
      if (key === 'Implicits') { nImpl = parseInt((l.split(':')[1] || '').replace(/\D/g, ''), 10) || 0; return; }
      if (key === 'Sockets' || key === 'Rune') return;
      if (l === 'Corrupted') { corrupted = true; return; }
      if (ITEM_META.has(key)) return;
      if (l.startsWith('{') && l.endsWith('}')) return;
      const m = l.replace(/\{[^}]*\}/g, '').trim();
      if (m) mods.push(m);
    });
    return { cls: ITEM_RAR[rar] || 'rare', name, base, ilvl, qual, corrupted,
             impl: mods.slice(0, nImpl), expl: mods.slice(nImpl) };
  }
  function itemCard(slotLabel, it) {
    const eh = escapeHtml;
    let badges = '';
    if (it.ilvl) badges += `<span class="poe-tag">iLvl ${eh(it.ilvl)}</span>`;
    if (it.qual && it.qual !== '0') badges += `<span class="poe-tag">Q${eh(it.qual)}</span>`;
    if (it.corrupted) badges += '<span class="poe-tag poe-tag-corr">Corrompu</span>';
    let mods = '';
    if (it.impl.length) mods += '<ul class="poe-mods poe-impl">' + it.impl.map(m => `<li>${itemHl(m)}</li>`).join('') + '</ul>';
    if (it.expl.length) mods += '<ul class="poe-mods">' + it.expl.map(m => `<li>${itemHl(m)}</li>`).join('') + '</ul>';
    return `<div class="poe-item poe-${it.cls}">`
      + (slotLabel ? `<div class="poe-item-slot">${eh(slotLabel)}</div>` : '')
      + `<div class="poe-item-name">${eh(it.name)}</div>`
      + (it.base ? `<div class="poe-item-base">${eh(it.base)}</div>` : '')
      + (badges ? `<div class="poe-item-tags">${badges}</div>` : '')
      + mods + '</div>';
  }

  const notes = doc.querySelector('Notes')?.textContent?.trim() || '';

  // Variantes de skill : PoB ne calcule le DPS que d'UN skill → 1 code = 1 DPS.
  // Primaire = codes[0] (build/arbre/équipement partagés) ; les autres n'apportent
  // que leur bandeau de stats. Variante secondaire invalide → ignorée.
  const primaryLabel = mainSocketGroupSkillLabel(skillGroups, mainSocketGroup) || className;
  const variants = [{ code: codes[0], stats, label: primaryLabel }];
  for (let i = 1; i < codes.length; i++) {
    const vd = pobVariantData(codes[i]);
    if (vd.ok) variants.push({ code: codes[i], stats: vd.stats, label: vd.label });
  }
  // Pas de cap : le switch est en JS (data-var) → gère N variantes ; les onglets wrap.

  // Construction du markdown
  const title = `Build ${className}${ascendClassName ? ' / ' + ascendClassName : ''} (lvl ${level})`;
  const importDate = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  const lines = [];
  // Pas de H1 ni de blockquote d'import : redondant avec la carte du perso. La
  // date d'import est affichée discrètement dans le hero (voir plus bas).

  // ── Bandeau « fiche » (HTML stylé façon Atlas, voir CSS .poe-* dans viewer) ─
  // Hero (identité + bandeau de stats clés + chips résistances). HTML pur :
  // marked ne parse PAS le markdown dans un bloc HTML → on écrit <strong>/<span>.
  {
    const eh = escapeHtml;
    let hero = '<div class="poe-card"><div class="poe-hero">';
    // <h2> (et non <div>) pour que le nom du perso apparaisse dans le sommaire
    // (le TOC se construit depuis les h2/h3 du contenu).
    hero += `<h2 class="poe-hero-name">${eh(charName || className)}</h2>`;
    let meta = eh(className);
    if (ascendClassName) meta += ` <span class="poe-asc">${eh(ascendClassName)}</span>`;
    meta += ` &middot; niveau ${eh(level)}`;
    hero += `<div class="poe-hero-meta">${meta}</div>`;
    hero += `<div class="poe-hero-imported">${eh(gameLabel)} &middot; importé le ${eh(importDate)}</div>`;
    hero += `</div>`;

    // Onglets de variante (si plusieurs skills) — switch via handler délégué (.poe-var-tab).
    if (variants.length > 1) {
      hero += '<div class="poe-var-tabs">'
        + variants.map((vv, i) => `<button type="button" class="poe-var-tab${i === 0 ? ' is-active' : ''}" data-var="${i}">${eh(vv.label)}</button>`).join('')
        + '</div>';
    }
    // Bandeau de stats (DPS/EHP/res) PAR variante ; le 1er est is-active. Le CSS
    // masque [data-var] non actif. Les anciennes fiches (strip sans data-var) restent
    // visibles (la règle de masquage ne cible que [data-var]).
    const stripResFor = (vstats, idx, active) => {
      const numv = (k) => (vstats[k] !== undefined && vstats[k] !== '' ? Number(vstats[k]) : undefined);
      const cells = [];
      const stat = (k, label, val) => {
        const x = val !== undefined ? val : numv(k);
        if (!x) return;
        cells.push(`<div class="poe-stat"><div class="poe-stat-v">${eh(pobCompact(x))}</div><div class="poe-stat-k">${eh(label)}</div></div>`);
      };
      stat('CombinedDPS', 'DPS', numv('CombinedDPS') || numv('TotalDPS'));
      stat('TotalEHP', 'EHP'); stat('Life', 'Vie'); stat('EnergyShield', 'ES');
      stat('Armour', 'Armure'); stat('Evasion', 'Évasion'); stat('Mana', 'Mana');
      const resChip = (k, label, cls) => {
        const x = numv(k);
        if (x === undefined) return '';
        return `<span class="poe-r ${cls}${x < 75 ? ' poe-r-under' : ''}">${label}<b>${Math.round(x)}</b></span>`;
      };
      const chips = [resChip('FireResist', 'Feu ', 'poe-r-fire'), resChip('ColdResist', 'Froid ', 'poe-r-cold'),
        resChip('LightningResist', 'Foudre ', 'poe-r-light'), resChip('ChaosResist', 'Chaos ', 'poe-r-chaos')].filter(Boolean).join('');
      const a = active ? ' is-active' : '';
      let out = '';
      if (cells.length) out += `<div class="poe-strip${a}" data-var="${idx}">${cells.join('')}</div>`;
      if (chips) out += `<div class="poe-res${a}" data-var="${idx}">${chips}</div>`;
      return out;
    };
    variants.forEach((vv, i) => { hero += stripResFor(vv.stats, i, i === 0); });

    // Aperçu & stats détaillées : repliable, DANS la carte (séparateur en bas).
    // Caché par défaut ; gardé pour le theorycraft. Le pseudo n'est PAS répété ici
    // (déjà dans le hero) ; un marqueur commenté sert au ré-import (invisible).
    const v = (k, suffix) => (stats[k] !== undefined ? fmtNum(stats[k]) + (suffix || '') : null);
    const resV = (capKey, overKey) => {
      if (stats[capKey] === undefined) return null;
      const over = stats[overKey];
      return fmtNum(stats[capKey]) + '%' + (over && Number(over) > 0 ? ' (overcap +' + fmtNum(over) + ')' : '');
    };
    const chg = (curKey, maxKey) => (stats[curKey] === undefined && stats[maxKey] === undefined)
      ? null : fmtNum(stats[curKey] || 0) + ' / ' + fmtNum(stats[maxKey] || 0);
    const group = (title, pairs) => {
      const body = pairs.filter(pp => pp && pp[1] != null && pp[1] !== '')
        .map(pp => `<tr><td>${eh(pp[0])}</td><td>${eh(String(pp[1]))}</td></tr>`).join('');
      return body ? `<div class="poe-statgrp"><div class="poe-statgrp-h">${eh(title)}</div><table class="poe-tbl"><tbody>${body}</tbody></table></div>` : '';
    };
    // Config de calcul (hypothèses ennemi, buffs supposés…) : ce ne sont PAS des
    // stats du perso, mais c'est pris en compte dans les chiffres → on l'expose
    // via une roue crantée près du pseudo, contenu affiché au survol (popover CSS).
    const cfgPairs = [];
    doc.querySelectorAll('Config > ConfigSet > Placeholder, Config > Placeholder, Config > ConfigSet > Input, Config > Input').forEach(el => {
      const k = el.getAttribute('name');
      if (!k) return;
      const numAttr = el.getAttribute('number');
      const val = numAttr != null ? fmtNum(numAttr) : (el.getAttribute('string') ?? el.getAttribute('boolean'));
      if (val != null) cfgPairs.push([k, val]);
    });
    if (cfgPairs.length) {
      const cfgRows = cfgPairs.map(p => `<div class="poe-cfg-row"><span>${eh(prettyCfgKey(p[0]))}</span><b>${eh(String(p[1]))}</b></div>`).join('');
      // Pattern :focus-within (CSS pur) : clic = focus → ouvre ; clic dehors = blur
      // → ferme ; molette = reste ouvert. Pas de survol (capricieux), pas de JS.
      hero += `<div class="poe-cog" tabindex="0" role="button" aria-label="Config de calcul">⚙︎<div class="poe-cog-pop"><div class="poe-cog-h">Config de calcul</div><div class="poe-cfg">${cfgRows}</div></div></div>`;
    }

    // Pas de groupe « Aperçu » : jeu/classe/niveau sont déjà dans le hero,
    // le skill principal dans Compétences → redondant.
    const grps = [
      group('Offensif', [
        ['Total DPS', v('TotalDPS')], ['Combined DPS', v('CombinedDPS')], ['Full DPS', v('FullDPS')],
        ['Average Damage', v('AverageDamage')], ['Average Burst', v('AverageBurstDamage')],
        ['Speed', v('Speed', ' /s')], ['Crit Chance', v('CritChance', '%')], ['Crit Multi', v('CritMultiplier', '%')],
        ['Hit Chance', v('HitChance', '%')], ['Mana Cost', v('ManaCost')], ['Mana / sec', v('ManaPerSecondCost')],
        ['Ignite DPS', v('IgniteDPS')], ['Bleed DPS', v('BleedDPS')], ['Poison DPS', v('PoisonDPS')], ['Total Dot DPS', v('TotalDotDPS')],
      ]),
      group('Défensif', [
        ['Vie', v('Life')], ['Vie effective (EHP)', v('TotalEHP')], ['Mana', v('Mana')], ['Mana réservée (libre)', v('ManaUnreserved')],
        ['Energy Shield', v('EnergyShield')], ['Ward', v('Ward')], ['Armure', v('Armour')], ['Réduction Physique', v('PhysicalDamageReduction', '%')],
        ['Évasion', v('Evasion')], ['Esquive mêlée', v('MeleeEvadeChance', '%')], ['Esquive projectile', v('ProjectileEvadeChance', '%')],
        ['Block', v('EffectiveBlockChance', '%')], ['Spell Block', v('EffectiveSpellBlockChance', '%')], ['Spell Suppression', v('EffectiveSpellSuppressionChance', '%')],
      ]),
      group('Résistances', [
        ['Feu', resV('FireResist', 'FireResistOverCap')], ['Froid', resV('ColdResist', 'ColdResistOverCap')],
        ['Foudre', resV('LightningResist', 'LightningResistOverCap')], ['Chaos', resV('ChaosResist', 'ChaosResistOverCap')],
      ]),
      group('Hit max encaissé', [
        ['Physique', v('PhysicalMaximumHitTaken')], ['Feu', v('FireMaximumHitTaken')], ['Froid', v('ColdMaximumHitTaken')],
        ['Foudre', v('LightningMaximumHitTaken')], ['Chaos', v('ChaosMaximumHitTaken')],
      ]),
      group('Attributs', [
        ['Force', v('Str')], ['Dextérité', v('Dex')], ['Intelligence', v('Int')], ['Dévotion', v('Devotion')],
      ]),
      group('Charges', [
        ['Power', chg('PowerCharges', 'PowerChargesMax')], ['Frenzy', chg('FrenzyCharges', 'FrenzyChargesMax')], ['Endurance', chg('EnduranceCharges', 'EnduranceChargesMax')],
      ]),
    ].filter(Boolean).join('');
    if (grps) hero += `<details class="poe-details"><summary><span class="poe-details-label">Stats détaillées</span></summary><div class="poe-statgrid">${grps}</div></details>`;

    hero += '</div>';
    if (charName) lines.push(`<!-- charName: ${charName} -->`);
    lines.push(hero);
    lines.push('');
  }
  // ── Compétences (cartes par groupe de gemmes, HTML stylé) ─────────────────
  if (skillGroups.length) {
    const eh = escapeHtml;
    const gemName = (g) => g.getAttribute('nameSpec') || g.getAttribute('skillId') || g.getAttribute('gemId') || '?';
    const cards = [];
    skillGroups.forEach((sg, idx) => {
      const gems = Array.from(sg.querySelectorAll('Gem'))
        .filter(g => g.getAttribute('enabled') !== 'false' && (g.getAttribute('nameSpec') || g.getAttribute('skillId') || g.getAttribute('gemId')));
      if (!gems.length) return;
      // PoE2 : « Support » peut être au milieu du skillId (ex. ProlongedDurationSupportPlayerTwo)
      // → on teste la présence n'importe où, pas seulement startsWith.
      const isSupport = (g) => /support/i.test((g.getAttribute('skillId') || '') + ' ' + (g.getAttribute('gemId') || ''));
      let actives = gems.filter(g => !isSupport(g));
      let sups = gems.filter(g => isSupport(g));
      if (!actives.length) { actives = gems; sups = []; }
      const isMain = (idx + 1) === mainSocketGroup;
      const prim = actives[0];
      const lvl = prim.getAttribute('level') || '?';
      const q = prim.getAttribute('quality') || '0';
      const lvlLine = `<div class="poe-gem-lvl">Niv. ${eh(lvl)}${(q === '0' || q === '') ? '' : ' · Qual. ' + eh(q) + '%'}</div>`;
      const extra = actives.slice(1).map(a => `<div class="poe-gem-2nd">+ ${eh(gemName(a))}</div>`).join('');
      const chips = sups.map(s => `<span class="poe-chip">${eh(gemName(s))}</span>`).join('');
      cards.push(
        `<div class="poe-skill${isMain ? ' poe-skill-main' : ''}">`
        + (isMain ? '<div class="poe-skill-tag">principal</div>' : '')
        + `<div class="poe-gem-main">${eh(gemName(prim))}</div>`
        + lvlLine
        + extra
        + (chips ? `<div class="poe-chips">${chips}</div>` : '')
        + '</div>');
    });
    if (cards.length) {
      lines.push('## Compétences');
      lines.push('');
      lines.push(`<div class="poe-skills">${cards.join('')}</div>`);
      lines.push('');
    }
  }

  // ── Arbre passif ────────────────────────────────────────────────────────
  // Les nodes du PoB ne sont que des IDs : on demande au serveur de les résoudre
  // en noms (keystones/notables/masteries) via les données d'arbre de la version.
  // Si le serveur ne répond pas ou ne résout pas, on retombe sur le résumé minimal.
  let treeRes = null;
  if (nodesStr) {
    try {
      const r = await fetch('/api/pob-tree', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          game: gameLabel.toLowerCase(),
          version: treeVersion,
          nodes: nodesStr,
          classId: treeClassId,
          ascendClassId: treeAscendClassId,
          masteryEffects: masteriesStr,
        }),
      });
      if (r.ok) treeRes = await r.json();
    } catch (e) { /* hors-ligne / serveur indispo → fallback minimal */ }
  }

  if (treeUrl || nodesCount) {
    const eh = escapeHtml;
    lines.push('## Arbre des passifs');
    lines.push('');
    if (treeRes && treeRes.resolved) {
      const c = treeRes.counts;
      lines.push(`- **Nœuds alloués** : ${c.allocated} &middot; ${c.keystones} keystone${c.keystones > 1 ? 's' : ''} &middot; ${c.notables} notables &middot; ${c.ascNotables} ascendance${c.masteries ? ` &middot; ${c.masteries} masteries` : ''} &middot; ${c.jewels} jewels${c.unknown ? ` &middot; ${c.unknown} non résolus/cluster` : ''}`);
    } else {
      if (nodesCount) lines.push(`- **Nœuds alloués** : ${nodesCount}`);
      if (masteriesCount) lines.push(`- **Masteries** : ${masteriesCount}`);
    }
    if (treeVersion) lines.push(`- **Tree version** : ${treeVersion}`);
    lines.push('');

    if (treeRes && treeRes.resolved) {
      // Encadré nommé avec sa description. HTML pur (pas de markdown dans un bloc HTML).
      const callout = (cls, name, stat) =>
        `<div class="poe-node ${cls}"><span class="poe-node-n">${eh(name)}</span>`
        + (stat ? `<span class="poe-node-s">${eh(stat)}</span>` : '') + `</div>`;

      if (treeRes.keystones && treeRes.keystones.length) {
        lines.push('### Keystones');
        lines.push('');
        lines.push(treeRes.keystones.map(k => callout('poe-key', k.name, k.stats)).join('\n'));
        lines.push('');
      }
      if (treeRes.ascNotables && treeRes.ascNotables.length) {
        lines.push('### Notables d\'ascendance');
        lines.push('');
        lines.push(treeRes.ascNotables.map(n => callout('poe-ascn', n.name, n.stats)).join('\n'));
        lines.push('');
      }
      if (treeRes.masteries && treeRes.masteries.length) {
        lines.push('### Masteries');
        lines.push('');
        lines.push(treeRes.masteries.map(m => callout('', m.name, m.effect)).join('\n'));
        lines.push('');
      }
      if (treeRes.notables && treeRes.notables.length) {
        // Liste repliable (souvent 20-30 entrées) avec description, en 2 colonnes.
        // HTML pur : le markdown n'est pas parsé dans un <details>.
        const items = treeRes.notables.map(n =>
          `<li><strong>${eh(n.name)}</strong>${n.stats ? ` <span>${eh(n.stats)}</span>` : ''}</li>`).join('');
        lines.push(`<details class="poe-notables"><summary>Notables (${treeRes.notables.length})</summary>\n<ul>${items}</ul>\n</details>`);
        lines.push('');
      }
      if (treeRes.smallsBreakdown && treeRes.smallsBreakdown.length) {
        // Petits passifs agrégés par stat : « 12× +10 to Strength ». Repliable.
        const tot = treeRes.smallsBreakdown.reduce((a, s) => a + s.count, 0);
        const items = treeRes.smallsBreakdown.map(s =>
          `<li><strong>${s.count}×</strong> <span>${eh(s.stat)}</span></li>`).join('');
        lines.push(`<details class="poe-notables"><summary>Autres passifs (${tot})</summary>\n<ul>${items}</ul>\n</details>`);
        lines.push('');
      }
    }

    // Jewels sertis dans l'arbre : items référencés par les <Socket nodeId itemId>
    // du spec. Mêmes cartes que l'équipement (rareté + mods). Indépendant de la
    // résolution serveur (donnée présente dans le PoB).
    const jewelCards = (activeSpec ? Array.from(activeSpec.querySelectorAll('Socket')) : [])
      .map(s => s.getAttribute('itemId') || '0')
      .filter(iid => iid !== '0' && items[iid])
      .map(iid => parseItem(items[iid]))
      .filter(Boolean)
      .map(it => itemCard('Jewel', it));
    if (jewelCards.length) {
      lines.push('### Jewels');
      lines.push('');
      lines.push('<div class="poe-eq">' + jewelCards.join('') + '</div>');
      lines.push('');
    }

    // Lien vers l'arbre (pratique pour ouvrir dans le site / PoB).
    if (treeUrl) {
      lines.push(`<p class="poe-link"><a href="${eh(treeUrl)}" target="_blank" rel="noopener">↗ Ouvrir l'arbre sur pathofexile.com</a></p>`);
      lines.push('');
    }
  }

  // (La config de calcul est désormais intégrée dans le bloc « Stats détaillées ».)

  // ── Équipement / Flasks / Charms (cartes par rareté, HTML stylé) ──────────
  if (slots.length) {
    const SLOT_FR = { 'Weapon 1':'Arme','Weapon 2':'Arme 2','Helmet':'Casque','Body Armour':'Torse',
      'Gloves':'Gants','Boots':'Bottes','Belt':'Ceinture','Amulet':'Amulette','Ring 1':'Anneau 1',
      'Ring 2':'Anneau 2','Ring 3':'Anneau 3' };
    const ORDER = ['Weapon 1','Weapon 2','Helmet','Body Armour','Gloves','Boots','Belt','Amulet','Ring 1','Ring 2','Ring 3'];

    const gear = [], flasks = [], charms = [];
    slots.forEach(slot => {
      const sname = slot.getAttribute('name') || '';
      const iid = slot.getAttribute('itemId') || '0';
      if (iid === '0' || !items[iid]) return;
      const it = parseItem(items[iid]);
      if (!it) return;
      const entry = { sname, it };
      if (/Flask/i.test(sname)) flasks.push(entry);
      else if (/Charm/i.test(sname)) charms.push(entry);
      else gear.push(entry);
    });
    const ord = (s) => { const i = ORDER.indexOf(s); return i < 0 ? ORDER.length : i; };
    gear.sort((a, b) => ord(a.sname) - ord(b.sname) || a.sname.localeCompare(b.sname));
    flasks.sort((a, b) => a.sname.localeCompare(b.sname));
    charms.sort((a, b) => a.sname.localeCompare(b.sname));

    const section = (title, group) => {
      if (!group.length) return;
      lines.push('## ' + title);
      lines.push('');
      lines.push('<div class="poe-eq">' + group.map(e => itemCard(SLOT_FR[e.sname] || e.sname, e.it)).join('') + '</div>');
      lines.push('');
    };
    section('Équipement', gear);
    section('Flasks', flasks);
    section('Charms', charms);
  }

  // ── Notes ───────────────────────────────────────────────────────────────
  if (notes) {
    lines.push('## Notes du build');
    lines.push('');
    lines.push(notes);
    lines.push('');
  }

  // ── Partager (un code PoB par variante de skill) ──────────────────────────
  // Copie câblée par délégation (voir handler contentEl click + page de partage).
  {
    const eh = escapeHtml;
    // Normalise en base64url (- _) : decodePobCode accepte les deux, et le regex de
    // relecture (extractAllPobCodes) ne couvre que [A-Za-z0-9_-=] → évite la troncature
    // d'un code collé en base64 standard (avec + ou /).
    const clean = (c) => eh(c.trim().replace(/\s+/g, '').replace(/\+/g, '-').replace(/\//g, '_'));
    lines.push('## Partager');
    lines.push('');
    if (variants.length === 1) {
      // Layout simple : bouton Copier dans le summary (copie sans déplier).
      lines.push(
        '<details class="poe-share"><summary>'
        + '<span class="poe-share-label">Code PoB (pour ré-importer / partager)</span>'
        + '<button class="poe-copy" type="button">Copier</button></summary>'
        + `<div class="poe-share-box"><code class="poe-pob-code">${clean(variants[0].code)}</code></div></details>`);
    } else {
      // Une ligne par variante : libellé du skill + son propre bouton Copier
      // (1 <code> = 1 variante réimportable isolément).
      const rows = variants.map(vv =>
        '<div class="poe-share-row"><div class="poe-share-rh">'
        + `<span class="poe-share-rl">${eh(vv.label)}</span>`
        + '<button class="poe-copy" type="button">Copier</button></div>'
        + `<div class="poe-share-box"><code class="poe-pob-code">${clean(vv.code)}</code></div></div>`).join('');
      lines.push(`<details class="poe-share"><summary><span class="poe-share-label">Codes PoB · ${variants.length} variantes</span></summary>${rows}</details>`);
    }
    lines.push('');
  }

  const slugBase = charName
    ? `${charName}-${className}-${ascendClassName || 'base'}`
    : `${className}-${ascendClassName || 'base'}-lvl${level}`;
  return {
    markdown: lines.join('\n') + '\n',
    title,
    slug: pobSlugifyTitle(slugBase),
    game: gameLabel.toLowerCase(),
  };
}

// Nom du perso : marqueur commenté (nouveau format fiche) ou ancienne ligne de
// table « | **Personnage** | … | » (rétro-compat avec les fiches déjà générées).
const POB_CHARNAME_RE = /<!--\s*charName:\s*([^\n>]+?)\s*-->|^\|\s*\*\*Personnage\*\*\s*\|\s*([^|\n]+?)\s*\|/m;
function extractCharNameFromMarkdown(md) {
  const m = md && md.match(POB_CHARNAME_RE);
  return m ? (m[1] || m[2] || '').trim() : '';
}

// ── Modale « Maj PoB » (réimport d'un code dans le doc courant) ──────────────
const updatePobForm = updatePobBackdrop.querySelector('#update-pob-form');
const updatePobCodes = updatePobBackdrop.querySelector('#update-pob-codes');
const updatePobError = updatePobBackdrop.querySelector('#update-pob-error');
const updatePobCancel = updatePobBackdrop.querySelector('#update-pob-cancel');

function openUpdatePobModal() {
  if (window.__viewerMode || !currentDocPath) return;
  updatePobError.classList.add('hidden');
  // Pré-rempli avec TOUS les codes actuels (un champ par variante) ; la liste est
  // la source de vérité au submit (ajouter via «+», retirer via «×»).
  const cur = (_pobCodes && _pobCodes.length)
    ? _pobCodes
    : (_pobCode ? [_pobCode] : ['']);
  pobCodeList(updatePobCodes, cur);
  const charName = _pobCharName || '';
  const hint = document.getElementById('update-pob-charname-hint');
  document.getElementById('update-pob-charname-value').textContent = charName;
  hint.classList.toggle('hidden', !charName);
  updatePobBackdrop.classList.remove('hidden');
  setTimeout(() => { const t = updatePobCodes.querySelector('.pob-code-input'); if (t) t.focus(); }, 50);
}
function closeUpdatePobModal() { updatePobBackdrop.classList.add('hidden'); }

btnUpdatePob.addEventListener('click', openUpdatePobModal);
updatePobCancel.addEventListener('click', closeUpdatePobModal);
updatePobBackdrop.addEventListener('click', (e) => { if (e.target === updatePobBackdrop) closeUpdatePobModal(); });

updatePobForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  updatePobError.classList.add('hidden');
  if (!currentDocPath) return;
  const codes = readPobCodes(updatePobCodes);
  if (!codes.length) { updatePobError.textContent = t('pobCodeRequired2'); updatePobError.classList.remove('hidden'); return; }
  let content;
  try {
    await loadPakoLib();
    const xml = decodePobCode(codes[0]);
    content = (await pobXmlToMarkdown(xml, codes, _pobCharName || '')).markdown;
  } catch (err) {
    updatePobError.textContent = t('pobPrefix', err.message);
    updatePobError.classList.remove('hidden');
    return;
  }
  try {
    const res = await fetch('/api/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: currentDocPath, content }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    closeUpdatePobModal();
    // Force le re-fetch du contenu : le viewer invalide son cache et la mtime.
    window.Atlas.invalidateDoc(currentDocPath);
    window.Atlas.setStatus(t('pobUpdated'), 'ok');
    await window.Atlas.refresh();
  } catch (err) {
    updatePobError.textContent = t('err', err.message);
    updatePobError.classList.remove('hidden');
  }
});

// ─── Enregistrement du template « Import PoB » auprès du viewer ──────────────
window.Atlas.registerTemplate('pob', {
  label: t('tplPob'),
  block: pobBlock,
  namePlaceholder: t('autoFromClass'),
  defaultDir: 'jeux',
  successMessage: t('pobImported'),
  onOpen() {
    pobCodeList(newFilePobCodes, ['']);
    newFilePobCharname.value = '';
  },
  async generate() {
    const codes = readPobCodes(newFilePobCodes);
    if (!codes.length) throw new Error(t('pobCodeRequired'));
    try {
      await loadPakoLib();
      const built = await pobXmlToMarkdown(decodePobCode(codes[0]), codes, newFilePobCharname.value.trim());
      return { content: built.markdown, slug: built.slug };
    } catch (err) {
      throw new Error(t('pobPrefix', err.message));
    }
  },
});

// ─── Suivi du doc courant (évènements génériques du viewer) ──────────────────
document.addEventListener('atlas:doc-rendered', (e) => {
  currentDocPath = (e.detail && e.detail.path) || null;
  detectPobImport((e.detail && e.detail.markdown) || '');
});
document.addEventListener('atlas:edit-enter', () => btnUpdatePob.classList.add('hidden'));

// Échap ferme la modale « Maj PoB » (les modales natives ont leur propre handler).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!updatePobBackdrop.classList.contains('hidden')) closeUpdatePobModal();
});

})();
