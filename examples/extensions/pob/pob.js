// PoB extension — Path of Exile module for Atlas (viewer).
//
// Installed via <mind>/.atlas/extensions/pob.js (alongside pob.css and pob.py):
// the build inlines this file into dist/index.html, and the server also injects
// it into the public share pages.
//
// Self-contained: i18n, helpers and DOM embedded. Two execution contexts:
//   - share page: only the click delegate (.poe-var-tab / .poe-copy) is
//     active — there is no modal and no window.Atlas API;
//   - viewer: registers the "Import Path of Building" template via
//     window.Atlas.registerTemplate, injects the "Update PoB" button and its
//     modal, and tracks the current doc via the atlas:doc-rendered /
//     atlas:edit-enter events.
(function () {
'use strict';

// ─── Embedded i18n (same mechanism as the viewer: fr by default) ─────────────
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

// ─── Embedded helpers (local copies: the share page doesn't have the viewer's) ──
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function slugify(s) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ─── Shared viewer + share page part: sheet interactions ─────────────────────
// Delegation on #content (present on both pages): skill-variant tabs and the
// "Copy" buttons for the PoB code (DOMPurify strips inline onclick → delegation
// is mandatory).
const contentRoot = document.getElementById('content');
if (contentRoot) {
  contentRoot.addEventListener('click', (e) => {
    // Variant tab: show the corresponding stats strip.
    const vtab = e.target.closest('.poe-var-tab');
    if (vtab) {
      e.preventDefault();
      const card = vtab.closest('.poe-card'); const v = vtab.dataset.var;
      if (card) card.querySelectorAll('.poe-var-tab[data-var], .poe-strip[data-var], .poe-res[data-var]')
        .forEach(el => el.classList.toggle('is-active', el.dataset.var === v));
      return;
    }
    // "Copy" button for the PoB code. Scoped to the variant row if present
    // (otherwise the first code in the <details>).
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

// ─── Viewer-only part ─────────────────────────────────────────────────────────
// Share page (or API absent): nothing else to wire up.
const btnEdit = document.getElementById('btn-edit');
if (!window.Atlas || typeof window.Atlas.registerTemplate !== 'function' || !btnEdit) return;

// Markdown doc displayed last (tracked via atlas:doc-rendered); the PoB codes
// it contains drive the visibility of the "Update PoB" button.
let currentDocPath = null;
let _pobCodes = [];
let _pobCode = null;
let _pobCharName = '';

// "Update PoB" button in the action bar, just before "Edit".
const btnUpdatePob = document.createElement('button');
btnUpdatePob.id = 'btn-update-pob';
btnUpdatePob.className = 'hidden px-2.5 py-1 text-xs bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30 rounded flex items-center gap-1';
btnUpdatePob.title = t('updatePobTitle');
btnUpdatePob.innerHTML = '<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg><span></span>';
btnUpdatePob.querySelector('span').textContent = t('updatePobBtn');
btnEdit.parentElement.insertBefore(btnUpdatePob, btnEdit);

// "Update PoB" modal (data-atlas-modal: blocks the viewer's soft-reload while
// it is open, like the native modals).
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

// Form block for the "Import PoB" template (shown by the viewer when the option
// is selected in the "New document" modal).
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

// New sheet format: code in <div class="poe-share-box"><code class="poe-pob-code">…</code>.
// Old format (backward compat): <summary>Code PoB…</summary> + a ``` fence block.
const POB_MARKER_RE = /poe-share-box"><code[^>]*>([A-Za-z0-9_\-=]+)<\/code>|<summary>Code PoB[^<]*<\/summary>\s*\n+```\s*\n([A-Za-z0-9_\-=\s]+?)\n```/;
function extractPobCodeFromMarkdown(md) {
  const m = md && md.match(POB_MARKER_RE);
  return m ? (m[1] || m[2] || '').trim().replace(/\s+/g, '') : null;
}

// ALL codes (1 per variant) — global regex ANCHORED on the Share markup (does
// not pick up <code> elsewhere). Fallback: extractPobCodeFromMarkdown (old format).
function extractAllPobCodes(md) {
  if (!md) return [];
  const codes = [];
  for (const m of md.matchAll(/poe-share-box"><code[^>]*>([A-Za-z0-9_\-=]+)<\/code>/g)) codes.push(m[1]);
  if (codes.length) return codes;
  const one = extractPobCodeFromMarkdown(md);
  return one ? [one] : [];
}

// Splits PoB codes pasted into a user INPUT (never on the stored markdown).
// Includes + and / (standard base64) so a code isn't truncated; the base64url
// normalization is done at storage time (clean() in the generator).
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

// ── List of PoB code fields (1 per skill variant) with a "+" button ──────────
function pobMakeCodeRow(value) {
  const row = document.createElement('div');
  row.className = 'pob-code-row flex gap-2 items-start';
  row.innerHTML = '<textarea rows="2" placeholder="eN..." class="pob-code-input flex-1 min-w-0 px-3 py-2 bg-navy-900 border subtle-border rounded text-ink-100 placeholder-ink-500 focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent text-xs font-mono resize-y"></textarea>'
    + '<button type="button" class="pob-code-rm px-2 py-1.5 text-ink-500 hover:text-rose-400 text-lg leading-none" title="' + escapeHtml(t('removeSkill')) + '">&times;</button>';
  row.querySelector('textarea').value = value || '';
  row.querySelector('.pob-code-rm').addEventListener('click', () => {
    const rows = row.parentElement.querySelectorAll('.pob-code-row');
    if (rows.length > 1) row.remove();
    else row.querySelector('textarea').value = '';  // always keep >= 1 field
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
    s.src = '/vendor/pako.min.js';  // pako 2.1.0 vendored (src/web/vendor/)
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

// Compact notation for the stat cards: 1.24M, 25.2k, 980.
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

// PoB config keys → readable label. PoB only exports internal keys (no
// human-readable label): we prettify (camelCase/snake → words, Title Case).
// Quest passives (questActN…) already have a meaningful value → generic label.
function prettyCfgKey(k) {
  const q = k.match(/^questAct\s*(\d+)/i);
  if (q) return 'Quête · Acte ' + q[1];
  return k.replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ').trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

// Label of the main skill (group label, otherwise first gem).
function mainSocketGroupSkillLabel(skillGroups, mainSocketGroup) {
  const sg = mainSocketGroup && skillGroups[mainSocketGroup - 1];
  if (!sg) return '';
  const lbl = sg.getAttribute('label') || '';
  const g = sg.querySelector('Gem');
  return lbl || (g ? (g.getAttribute('nameSpec') || g.getAttribute('skillId') || '') : '');
}

// Skill groups of a PoB doc (SkillSet/activeSkillSet format or flat).
function pobSkillGroups(doc) {
  const sets = Array.from(doc.querySelectorAll('Skills > SkillSet'));
  if (sets.length) {
    const active = doc.querySelector('Skills')?.getAttribute('activeSkillSet') || '1';
    const set = sets.find(s => s.getAttribute('id') === active) || sets[0];
    return Array.from(set.querySelectorAll('Skill'));
  }
  return Array.from(doc.querySelectorAll('Skills > Skill'));
}

// Stats (<PlayerStat>) + main-skill label of a decoded PoB doc.
function pobStatsAndSkill(doc) {
  const build = doc.querySelector('Build');
  const stats = {};
  doc.querySelectorAll('Build > PlayerStat').forEach(s => { stats[s.getAttribute('stat')] = s.getAttribute('value'); });
  const msg = parseInt(build?.getAttribute('mainSocketGroup') || '0', 10);
  const label = mainSocketGroupSkillLabel(pobSkillGroups(doc), msg) || (build?.getAttribute('className') || 'Build');
  return { stats, label };
}

// Decodes a PoB code (variant) → {ok, stats, label}. Invalid variant → {ok:false}.
function pobVariantData(code) {
  try {
    const doc = new DOMParser().parseFromString(decodePobCode(code), 'text/xml');
    if (doc.querySelector('parsererror') || !doc.querySelector('Build')) return { ok: false };
    return { ok: true, ...pobStatsAndSkill(doc) };
  } catch (e) { console.warn('PoB variant skipped:', e && e.message); return { ok: false }; }
}

// `codes` = array of PoB codes (1 per skill variant); `xml` = decoding of codes[0] (primary).
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

  // Tree spec (first Spec of the active Tree)
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

  // PoE2 detection: treeVersion 2_x (PoE1 = 3_x) or known PoE2 classes
  const poe2Classes = new Set(['Sorceress', 'Warrior', 'Mercenary', 'Monk', 'Druid', 'Huntress']);
  const isPoe2 = treeVersion.startsWith('2_') || poe2Classes.has(className);
  const gameLabel = isPoe2 ? 'PoE2' : 'PoE1';

  // Skills (walks SkillSet > Skill > Gem)
  const skillSets = Array.from(doc.querySelectorAll('Skills > SkillSet'));
  const flatSkillsRoot = doc.querySelector('Skills');
  let skillGroups = [];
  if (skillSets.length) {
    // Modern format: we take the activeSkillSet
    const activeSkillSet = flatSkillsRoot?.getAttribute('activeSkillSet') || '1';
    const set = skillSets.find(s => s.getAttribute('id') === activeSkillSet) || skillSets[0];
    skillGroups = Array.from(set.querySelectorAll('Skill'));
  } else {
    skillGroups = Array.from(doc.querySelectorAll('Skills > Skill'));
  }

  // Items and slots
  const items = {};
  doc.querySelectorAll('Items > Item').forEach(it => {
    items[it.getAttribute('id')] = it.textContent.trim();
  });
  const itemSets = Array.from(doc.querySelectorAll('Items > ItemSet'));
  const activeItemSet = doc.querySelector('Items')?.getAttribute('activeItemSet') || '1';
  const itemSet = itemSets.find(s => s.getAttribute('id') === activeItemSet) || itemSets[0];
  const slots = itemSet ? Array.from(itemSet.querySelectorAll('Slot')) : [];

  // Parsing + item card (rarity, mods) — shared by the equipment AND the tree
  // jewels (which are items referenced by the spec's <Socket> elements).
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

  // Skill variants: PoB only computes DPS for ONE skill → 1 code = 1 DPS.
  // Primary = codes[0] (shared build/tree/equipment); the others only contribute
  // their own stats strip. Invalid secondary variant → skipped.
  const primaryLabel = mainSocketGroupSkillLabel(skillGroups, mainSocketGroup) || className;
  const variants = [{ code: codes[0], stats, label: primaryLabel }];
  for (let i = 1; i < codes.length; i++) {
    const vd = pobVariantData(codes[i]);
    if (vd.ok) variants.push({ code: codes[i], stats: vd.stats, label: vd.label });
  }
  // No cap: the switch is in JS (data-var) → handles N variants; the tabs wrap.

  // Markdown construction
  const title = `Build ${className}${ascendClassName ? ' / ' + ascendClassName : ''} (lvl ${level})`;
  const importDate = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  const lines = [];
  // No H1 nor import blockquote: redundant with the character card. The import
  // date is shown discreetly in the hero (see below).

  // ── "Sheet" banner (Atlas-styled HTML, see .poe-* CSS in the viewer) ────────
  // Hero (identity + key-stats strip + resistance chips). Pure HTML: marked does
  // NOT parse markdown inside an HTML block → we write <strong>/<span>.
  {
    const eh = escapeHtml;
    let hero = '<div class="poe-card"><div class="poe-hero">';
    // <h2> (not <div>) so the character name appears in the table of contents
    // (the TOC is built from the content's h2/h3).
    hero += `<h2 class="poe-hero-name">${eh(charName || className)}</h2>`;
    let meta = eh(className);
    if (ascendClassName) meta += ` <span class="poe-asc">${eh(ascendClassName)}</span>`;
    meta += ` &middot; niveau ${eh(level)}`;
    hero += `<div class="poe-hero-meta">${meta}</div>`;
    hero += `<div class="poe-hero-imported">${eh(gameLabel)} &middot; importé le ${eh(importDate)}</div>`;
    hero += `</div>`;

    // Variant tabs (if several skills) — switched via the delegated handler (.poe-var-tab).
    if (variants.length > 1) {
      hero += '<div class="poe-var-tabs">'
        + variants.map((vv, i) => `<button type="button" class="poe-var-tab${i === 0 ? ' is-active' : ''}" data-var="${i}">${eh(vv.label)}</button>`).join('')
        + '</div>';
    }
    // Stats strip (DPS/EHP/res) PER variant; the first is is-active. The CSS
    // hides inactive [data-var]. Old sheets (strip without data-var) stay
    // visible (the hiding rule only targets [data-var]).
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

    // Overview & detailed stats: collapsible, INSIDE the card (separator at the
    // bottom). Hidden by default; kept for theorycrafting. The name is NOT
    // repeated here (already in the hero); a commented marker is used for re-import (invisible).
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
    // Calculation config (enemy assumptions, presumed buffs…): these are NOT
    // character stats, but they are factored into the numbers → we expose it
    // via a cog near the name, content shown on hover (CSS popover).
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
      // :focus-within pattern (pure CSS): click = focus → opens; click outside =
      // blur → closes; scroll wheel = stays open. No hover (finicky), no JS.
      hero += `<div class="poe-cog" tabindex="0" role="button" aria-label="Config de calcul">⚙︎<div class="poe-cog-pop"><div class="poe-cog-h">Config de calcul</div><div class="poe-cfg">${cfgRows}</div></div></div>`;
    }

    // No "Overview" group: game/class/level are already in the hero, the main
    // skill is in Skills → redundant.
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
  // ── Skills (cards per gem group, styled HTML) ─────────────────────────────
  if (skillGroups.length) {
    const eh = escapeHtml;
    const gemName = (g) => g.getAttribute('nameSpec') || g.getAttribute('skillId') || g.getAttribute('gemId') || '?';
    const cards = [];
    skillGroups.forEach((sg, idx) => {
      const gems = Array.from(sg.querySelectorAll('Gem'))
        .filter(g => g.getAttribute('enabled') !== 'false' && (g.getAttribute('nameSpec') || g.getAttribute('skillId') || g.getAttribute('gemId')));
      if (!gems.length) return;
      // PoE2: "Support" can be in the middle of the skillId (e.g. ProlongedDurationSupportPlayerTwo)
      // → we test for its presence anywhere, not just startsWith.
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

  // ── Passive tree ──────────────────────────────────────────────────────────
  // The PoB nodes are only IDs: we ask the server to resolve them into names
  // (keystones/notables/masteries) via the version's tree data. If the server
  // doesn't respond or can't resolve, we fall back to the minimal summary.
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
    } catch (e) { /* offline / server unavailable → minimal fallback */ }
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
      // Named callout with its description. Pure HTML (no markdown in an HTML block).
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
        // Collapsible list (often 20-30 entries) with description, in 2 columns.
        // Pure HTML: markdown is not parsed inside a <details>.
        const items = treeRes.notables.map(n =>
          `<li><strong>${eh(n.name)}</strong>${n.stats ? ` <span>${eh(n.stats)}</span>` : ''}</li>`).join('');
        lines.push(`<details class="poe-notables"><summary>Notables (${treeRes.notables.length})</summary>\n<ul>${items}</ul>\n</details>`);
        lines.push('');
      }
      if (treeRes.smallsBreakdown && treeRes.smallsBreakdown.length) {
        // Small passives aggregated by stat: "12× +10 to Strength". Collapsible.
        const tot = treeRes.smallsBreakdown.reduce((a, s) => a + s.count, 0);
        const items = treeRes.smallsBreakdown.map(s =>
          `<li><strong>${s.count}×</strong> <span>${eh(s.stat)}</span></li>`).join('');
        lines.push(`<details class="poe-notables"><summary>Autres passifs (${tot})</summary>\n<ul>${items}</ul>\n</details>`);
        lines.push('');
      }
    }

    // Jewels socketed in the tree: items referenced by the spec's
    // <Socket nodeId itemId>. Same cards as the equipment (rarity + mods).
    // Independent of the server resolution (data present in the PoB).
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

    // Link to the tree (handy to open on the site / in PoB).
    if (treeUrl) {
      lines.push(`<p class="poe-link"><a href="${eh(treeUrl)}" target="_blank" rel="noopener">↗ Ouvrir l'arbre sur pathofexile.com</a></p>`);
      lines.push('');
    }
  }

  // (The calculation config is now integrated into the "Detailed stats" block.)

  // ── Equipment / Flasks / Charms (cards per rarity, styled HTML) ───────────
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

  // ── Share (one PoB code per skill variant) ────────────────────────────────
  // Copy wired up by delegation (see the contentEl click handler + share page).
  {
    const eh = escapeHtml;
    // Normalize to base64url (- _): decodePobCode accepts both, and the re-read
    // regex (extractAllPobCodes) only covers [A-Za-z0-9_-=] → avoids truncating a
    // code pasted in standard base64 (with + or /).
    const clean = (c) => eh(c.trim().replace(/\s+/g, '').replace(/\+/g, '-').replace(/\//g, '_'));
    lines.push('## Partager');
    lines.push('');
    if (variants.length === 1) {
      // Simple layout: Copy button in the summary (copies without expanding).
      lines.push(
        '<details class="poe-share"><summary>'
        + '<span class="poe-share-label">Code PoB (pour ré-importer / partager)</span>'
        + '<button class="poe-copy" type="button">Copier</button></summary>'
        + `<div class="poe-share-box"><code class="poe-pob-code">${clean(variants[0].code)}</code></div></details>`);
    } else {
      // One row per variant: the skill label + its own Copy button
      // (1 <code> = 1 variant re-importable on its own).
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

// Character name: commented marker (new sheet format) or the old table row
// "| **Personnage** | … |" (backward compat with already-generated sheets).
const POB_CHARNAME_RE = /<!--\s*charName:\s*([^\n>]+?)\s*-->|^\|\s*\*\*Personnage\*\*\s*\|\s*([^|\n]+?)\s*\|/m;
function extractCharNameFromMarkdown(md) {
  const m = md && md.match(POB_CHARNAME_RE);
  return m ? (m[1] || m[2] || '').trim() : '';
}

// ── "Update PoB" modal (re-import a code into the current doc) ────────────────
const updatePobForm = updatePobBackdrop.querySelector('#update-pob-form');
const updatePobCodes = updatePobBackdrop.querySelector('#update-pob-codes');
const updatePobError = updatePobBackdrop.querySelector('#update-pob-error');
const updatePobCancel = updatePobBackdrop.querySelector('#update-pob-cancel');

function openUpdatePobModal() {
  if (window.__viewerMode || !currentDocPath) return;
  updatePobError.classList.add('hidden');
  // Pre-filled with ALL the current codes (one field per variant); the list is
  // the source of truth on submit (add via "+", remove via "×").
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
    // Force a content re-fetch: the viewer invalidates its cache and the mtime.
    window.Atlas.invalidateDoc(currentDocPath);
    window.Atlas.setStatus(t('pobUpdated'), 'ok');
    await window.Atlas.refresh();
  } catch (err) {
    updatePobError.textContent = t('err', err.message);
    updatePobError.classList.remove('hidden');
  }
});

// ─── Registration of the "Import PoB" template with the viewer ───────────────
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

// ─── Tracking the current doc (generic viewer events) ────────────────────────
document.addEventListener('atlas:doc-rendered', (e) => {
  currentDocPath = (e.detail && e.detail.path) || null;
  detectPobImport((e.detail && e.detail.markdown) || '');
});
document.addEventListener('atlas:edit-enter', () => btnUpdatePob.classList.add('hidden'));

// Escape closes the "Update PoB" modal (the native modals have their own handler).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!updatePobBackdrop.classList.contains('hidden')) closeUpdatePobModal();
});

})();
