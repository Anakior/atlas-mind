const TREE = __DATA__;
const EMBED_CONTENT = __EMBED_CONTENT__;
const EMBED_BACKLINKS = __EMBED_BACKLINKS__;
const EMBED_NOTES = __EMBED_NOTES__;
const EMBED_TASKS = __EMBED_TASKS__;
const EMBED_ACTIVITY = __EMBED_ACTIVITY__;
const DOC_TEMPLATES = __TEMPLATES__;
const IS_OFFLINE_BUILD = EMBED_CONTENT !== null;
const SITE_NAME = document.title;
const TAGLINE = __TAGLINE_JSON__;
const SITE_PREFIX = __SITE_PREFIX_JSON__;
let csrfToken = null;
let meState = null;
let totpEnabled = false;
function readCsrfCookie() {
  const m = document.cookie.match(/(?:^|;\s*)kb_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
function setCsrfToken(token) {
  if (token) csrfToken = token;
}
function currentCsrfToken() {
  return csrfToken || readCsrfCookie();
}
(function installCsrfFetch() {
  const nativeFetch = window.fetch.bind(window);
  const MUTATING = { POST: 1, PUT: 1, PATCH: 1, DELETE: 1 };
  window.fetch = function(input, init) {
    init = init || {};
    const req = typeof input === "string" ? null : input;
    const method = (init.method || req && req.method || "GET").toUpperCase();
    const url = typeof input === "string" ? input : req && req.url || "";
    const sameOrigin = url && !/^https?:\/\//i.test(url);
    if (MUTATING[method] && sameOrigin) {
      const token = currentCsrfToken();
      if (token) {
        const headers = new Headers(init.headers || (req ? req.headers : void 0) || {});
        if (!headers.has("X-CSRF-Token")) headers.set("X-CSRF-Token", token);
        init = Object.assign({}, init, { headers });
      }
    }
    return nativeFetch(input, init);
  };
})();

(function(root) {
  "use strict";
  const SVG_NS = "http://www.w3.org/2000/svg";
  const ROOTS = /* @__PURE__ */ new WeakMap();
  let mountQueue = [];
  function h(tag, props, ...children) {
    const p = props || {};
    return { tag, key: p.key, props: p, children: normalize(children) };
  }
  h.host = function host(tag, props) {
    const p = props || {};
    return { tag, key: p.key, props: p, children: [], managed: true };
  };
  function raw(html) {
    return { tag: "#raw", props: {}, children: [], text: html };
  }
  function Show(cond, view) {
    return cond ? view() : null;
  }
  function normalize(children) {
    const out = [];
    const walk = (c) => {
      if (c === null || c === void 0 || typeof c === "boolean") return;
      if (Array.isArray(c)) {
        c.forEach(walk);
        return;
      }
      if (typeof c === "string" || typeof c === "number") {
        out.push({ tag: "#text", props: {}, children: [], text: String(c) });
        return;
      }
      out.push(c);
    };
    children.forEach(walk);
    return out;
  }
  function render(next, container) {
    const arr = normalize([next]);
    patchChildren(container, ROOTS.get(container) || [], arr, container.namespaceURI === SVG_NS);
    ROOTS.set(container, arr);
    const mounts = mountQueue;
    mountQueue = [];
    mounts.forEach((fn) => fn());
  }
  function createApp(container, view) {
    return {
      render(state) {
        render(view(state), container);
      },
      unmount() {
        patchChildren(container, ROOTS.get(container) || [], [], container.namespaceURI === SVG_NS);
        ROOTS.delete(container);
      }
    };
  }
  function patchChildren(parent, old, next, svg) {
    const keyed = /* @__PURE__ */ new Map();
    const fifo = /* @__PURE__ */ new Map();
    for (const o of old) {
      if (o.key !== void 0) keyed.set(o.key, o);
      else {
        const q = fifo.get(o.tag);
        if (q) q.push(o);
        else fifo.set(o.tag, [o]);
      }
    }
    const reused = /* @__PURE__ */ new Set();
    for (const n of next) {
      let match;
      if (n.key !== void 0) {
        const o = keyed.get(n.key);
        if (o && o.tag === n.tag) match = o;
      } else {
        const q = fifo.get(n.tag);
        if (q && q.length) match = q.shift();
      }
      if (match) {
        reused.add(match);
        patchNode(match, n, svg);
      } else createNode(n, svg);
    }
    for (const o of old) if (!reused.has(o)) removeNode(o);
    let cursor = parent.firstChild;
    for (const n of next) {
      const el = n.el;
      if (el === cursor) cursor = cursor.nextSibling;
      else parent.insertBefore(el, cursor);
    }
  }
  function patchNode(old, next, svg) {
    next.el = old.el;
    if (next.tag === "#text") {
      if (next.text !== old.text) next.el.data = next.text;
      return;
    }
    if (next.tag === "#raw") {
      if (next.text !== old.text) {
        const fresh = rawToNode(next.text, svg);
        old.el.replaceWith(fresh);
        next.el = fresh;
      }
      return;
    }
    const el = next.el;
    applyProps(el, old.props, next.props);
    if (next.managed) return;
    patchChildren(el, old.children, next.children, svg || next.tag === "svg");
  }
  function createNode(vnode, svg) {
    if (vnode.tag === "#text") {
      vnode.el = document.createTextNode(vnode.text);
      return vnode.el;
    }
    if (vnode.tag === "#raw") {
      vnode.el = rawToNode(vnode.text, svg);
      return vnode.el;
    }
    const isSvg = svg || vnode.tag === "svg";
    const el = isSvg ? document.createElementNS(SVG_NS, vnode.tag) : document.createElement(vnode.tag);
    vnode.el = el;
    applyProps(el, {}, vnode.props);
    if (!vnode.managed) for (const child of vnode.children) el.appendChild(createNode(child, isSvg));
    const ref = vnode.props.ref;
    if (ref) mountQueue.push(() => ref(el));
    return el;
  }
  function rawToNode(html, svg) {
    const holder = svg ? document.createElementNS(SVG_NS, "g") : document.createElement("div");
    holder.innerHTML = html;
    return holder.firstChild || document.createTextNode("");
  }
  function applyProps(el, oldProps, newProps) {
    for (const k in oldProps) {
      if (k === "key" || k === "ref" || k in newProps) continue;
      removeProp(el, k);
    }
    for (const k in newProps) {
      if (k === "key" || k === "ref") continue;
      const v = newProps[k];
      if (k === "value" || k === "checked") applyValue(el, k, v);
      else if (v !== oldProps[k]) setProp(el, k, v);
    }
  }
  function applyValue(el, k, v) {
    const applied = el.__applied || (el.__applied = {});
    if (applied[k] === v) return;
    if (document.activeElement === el) return;
    el[k] = v;
    applied[k] = v;
  }
  function setProp(el, k, v) {
    if (k.length > 2 && k[0] === "o" && k[1] === "n") {
      setEvent(el, k.slice(2).toLowerCase(), v);
      return;
    }
    if (k === "disabled" || k === "selected") {
      el[k] = !!v;
      return;
    }
    if (k === "style") {
      setStyle(el, v);
      return;
    }
    if (v == null || v === false) el.removeAttribute(k);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  function removeProp(el, k) {
    if (k.length > 2 && k[0] === "o" && k[1] === "n") {
      setEvent(el, k.slice(2).toLowerCase(), null);
      return;
    }
    if (k === "value" || k === "checked") return;
    if (k === "disabled" || k === "selected") {
      el[k] = false;
      return;
    }
    el.removeAttribute(k);
  }
  function setEvent(el, type, handler) {
    const ev = el.__ev || (el.__ev = {});
    if (!(type in ev)) {
      el.addEventListener(type, (e) => {
        const fn = el.__ev[type];
        if (fn) fn(e);
      });
    }
    if (handler) ev[type] = handler;
    else delete ev[type];
  }
  function setStyle(el, v) {
    if (v == null || v === false) {
      el.removeAttribute("style");
      return;
    }
    if (typeof v === "string") {
      el.setAttribute("style", v);
      return;
    }
    el.removeAttribute("style");
    for (const k in v) el.style[k] = v[k];
  }
  function removeNode(vnode) {
    cleanup(vnode);
    const el = vnode.el;
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }
  function cleanup(vnode) {
    if (!vnode.managed) for (const c of vnode.children) cleanup(c);
    const ref = vnode.props.ref;
    if (ref) ref(null);
  }
  root.h = h;
  root.raw = raw;
  root.render = render;
  root.createApp = createApp;
  root.Show = Show;
})(typeof window !== "undefined" ? window : globalThis);

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
class SseCoord {
  constructor() {
    __publicField(this, "selfSaveUntil", {});
    __publicField(this, "taskWrites", /* @__PURE__ */ new Set());
  }
  // Mute the self-triggered SSE reload for `path` over the next `ms` (the commit echo would re-render it).
  muteSelfSave(path, ms = 6e3) {
    this.selfSaveUntil[path] = Date.now() + ms;
  }
  isSelfSaveMuted(path) {
    return !!(this.selfSaveUntil[path] && Date.now() < this.selfSaveUntil[path]);
  }
  // Track an in-flight checkbox PUT so drainTaskWrites() can await it; it drops out once settled.
  trackTaskWrite(p) {
    this.taskWrites.add(p);
    p.finally(() => this.taskWrites.delete(p));
  }
  async drainTaskWrites() {
    await Promise.allSettled([...this.taskWrites]);
  }
}
const sse = new SseCoord();

window.AtlasUI = {
  btnPrimary: "px-3 py-1.5 text-sm bg-accent hover:brightness-110 text-white rounded font-medium",
  btnDanger: "px-3 py-1.5 text-sm bg-rose-500/80 hover:bg-rose-500 text-white rounded font-medium",
  btnSecondary: "px-3 py-1.5 text-sm bg-navy-700 hover:bg-navy-600 text-ink-200 rounded",
  input: "w-full px-3 py-2 text-sm bg-navy-900 border subtle-border rounded text-ink-100 placeholder-ink-500 focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent",
  label: "text-[11px] uppercase tracking-wider text-ink-500 font-semibold mb-1 block"
};

const treeEl = document.getElementById("tree");
const contentEl = document.getElementById("content");
const breadcrumbPath = document.getElementById("breadcrumb-path");
const breadcrumbDate = document.getElementById("breadcrumb-date");
const breadcrumbActions = document.getElementById("breadcrumb-actions");
const btnEdit = document.getElementById("btn-edit");
const btnSave = document.getElementById("btn-save");
const btnCancel = document.getElementById("btn-cancel");
const searchEl = document.getElementById("search");
const searchResultsEl = document.getElementById("search-results");
const recentSection = document.getElementById("recent-section");
const recentList = document.getElementById("recent-list");
const sharedSection = document.getElementById("shared-section");
const sharedList = document.getElementById("shared-list");
const statsEl = document.getElementById("stats");
const tocPanel = document.getElementById("toc-panel");
const tocList = document.getElementById("toc-list");
const tocLinks = document.getElementById("toc-links");
const tocNotes = document.getElementById("toc-notes");

const LANG = (document.documentElement.lang || "fr").toLowerCase().startsWith("en") ? "en" : "fr";
const STRINGS = {
  fr: {
    // Génériques
    cancel: "Annuler",
    confirm: "Confirmer",
    ok: "OK",
    errorTitle: "Erreur",
    offlineTitle: "Mode hors-ligne",
    offlineDisabled: "Cette fonctionnalité est désactivée.",
    save: "Enregistrer",
    close: "Fermer",
    del: "Supprimer",
    copy: "Copier",
    copied: "Copié",
    copiedBang: "Copié !",
    validate: "Valider",
    create: "Créer",
    err: (m) => "Erreur: " + m,
    errSp: (m) => "Erreur : " + m,
    nameRequired: "Nom requis",
    titleRequired: "Titre requis",
    noSlashes: "Pas de / ni \\ dans le nom",
    // Dates relatives
    justNow: "à l'instant",
    minAgo: (n) => `il y a ${n} min`,
    hoursAgo: (n) => `il y a ${n} h`,
    daysAgo: (n) => `il y a ${n} j`,
    // Sidebar / arbre
    homeTitle: "Accueil",
    collapseSidebar: "Replier (Ctrl+B)",
    showSidebar: "Afficher la sidebar (Ctrl+B)",
    searchPlaceholder: "Rechercher…",
    graphBtnTitle: "The Mind (Ctrl+G)",
    expandAllFolders: "Tout déplier / replier",
    newDocTitle: "Nouveau document (N)",
    pinnedHeader: "Épinglés",
    recentHeader: "Récents",
    sharedHeader: "Partagés avec vous",
    treeContentHeader: "Contenu",
    signedInAs: "Connecté en tant que",
    logoutTitle: "Se déconnecter",
    logoutLabel: "Déco",
    statsLine: (md, other) => `${md} markdown / ${other} autres`,
    renameFolder: "Renommer le dossier",
    renameFile: "Renommer le fichier",
    treeRemoteBadge: "lié",
    remotesLabel: "Nœuds mentaux",
    shareAsNode: "Partager en nœud",
    notesBadge: (n) => n + " note(s)",
    // Barre d'actions du document
    pin: "Épingler",
    unpin: "Désépingler",
    downloadTitle: "Télécharger le fichier",
    downloadBtn: "Télécharger",
    moreActions: "Plus d'actions",
    menuRename: "Renommer",
    menuMove: "Déplacer…",
    shareTitle: "Générer un lien public partagé",
    shareBtn: "Partager",
    editBtn: "Éditer",
    saveBtn: "Sauvegarder",
    saving: "Sauvegarde…",
    modifiedAgo: (d) => "modifié " + d,
    sharedByLabel: (n) => "· partagé par " + n,
    readingTime: (min, words) => `${min} min · ${words} mots`,
    // Contenu / rendu
    loadingDoc: "Chargement du document",
    loadError: (m) => "Erreur de chargement : " + m,
    offlineMissing: "contenu manquant dans le build offline",
    brokenLink: (tgt) => "Doc introuvable : " + tgt,
    htmlDocBanner: "Document HTML · rendu isolé (clique dans le cadre pour naviguer au clavier)",
    demoBannerTitle: "Démo en lecture seule",
    demoBannerText: "L’édition, les comptes, le partage & la collaboration, l’historique des versions, ton IA (MCP/API) et la synchro Hive nécessitent ta propre instance.",
    demoBannerCta: "Installer la tienne ↗",
    pdfDocBanner: "Document PDF · aperçu",
    pdfOfflineHint: "Aperçu PDF indisponible en mode hors-ligne :",
    docxError: (e) => `Impossible d'afficher ce document Word (${e}). Télécharger :`,
    openFullscreen: "Ouvrir en plein écran ↗",
    cantLoadDoc: (m) => "Impossible de charger le document: " + m,
    fileModeNoEdit: "Édition indisponible en mode hors-ligne",
    // Tags
    folderTagTitle: "Tag de dossier (toujours présent)",
    removeTag: "Retirer",
    addTag: "Ajouter un tag",
    tagSaveFailed: (m) => "Échec de la sauvegarde du tag : " + m,
    tagEditorTitle: "Tags custom",
    tagPlaceholder: "nouveau tag…",
    tagEditorHint: "Entrée pour ajouter · les tags de dossier restent toujours",
    noCustomTags: "Aucun tag custom.",
    docsWithTag: (n) => n + " document" + (n > 1 ? "s" : "") + " avec ce tag.",
    // Panneau latéral (sommaire / liens / notes)
    tocHeader: "Sur ce doc",
    hideToc: "Masquer (Ctrl+J)",
    showToc: "Afficher le sommaire (Ctrl+J)",
    linksTitle: "Liens",
    historyTitle: "Historique du document",
    historyLabel: "Historique",
    historyHeader: "Historique",
    historyClose: "Fermer (Esc)",
    historyPick: "Sélectionne une révision à gauche.",
    historyEmpty: "Aucun historique pour ce document.",
    historyAiOnly: "Écritures IA",
    historyNoAi: "Aucune écriture IA sur ce document.",
    digestWeek: "Cette semaine",
    digestDocs: (n) => "doc" + (n > 1 ? "s" : ""),
    digestCreated: (n) => "créé" + (n > 1 ? "s" : ""),
    digestChecked: (n) => "tâche" + (n > 1 ? "s" : ""),
    digestContributors: () => "pers.",
    digestViaAi: () => "IA",
    actTitle: "Activité",
    actJournal: "Journal",
    actConstellation: "Constellation",
    actHealth: "Santé",
    actAiOnly: "IA seulement",
    actSeeAll: "Voir tout →",
    actCollapse: "Réduire ↑",
    actSeeAllN: (n) => `Voir tout (${n}) →`,
    actSeeChanges: "Voir les modifications",
    actEmptyAi: "Aucune écriture IA récente.",
    actEmpty: "Aucune activité récente.",
    actInbox: "Inbox",
    inboxKeep: "Garder",
    inboxTrash: "Jeter",
    inboxSnooze: "Snooze",
    inboxZero: "Inbox vide, rien à trier 👌",
    inboxConfHigh: "confiance haute",
    inboxConfMed: "confiance moyenne",
    inboxConfLow: "confiance basse",
    inboxNext: "Suivant",
    inboxFileUnder: "classer dans",
    inboxChooseFolder: "choisir un dossier",
    inboxPickFolderFirst: "choisis d'abord un dossier",
    inboxPickOrType: "choisis ou tape un dossier",
    inboxNewTag: "nouveau tag",
    inboxSameSubject: "Même sujet qu'un doc déjà classé :",
    inboxDone: "traités",
    inboxUpNext: "À suivre",
    inboxNew: (n) => n === 1 ? "1 nouveau" : n + " nouveaux",
    inboxZeroTitle: "Inbox",
    inboxZeroSub: "Tes agents font les recherches à ta place. Tu viens de garder l'essentiel.",
    inboxKept: "gardés → graphe",
    inboxTrashed: "jetés",
    inboxSnoozed: "snoozés",
    relJustNow: "à l'instant",
    relYesterday: "hier",
    relDaysAgo: (d) => "il y a " + d + " j",
    healthTabStale: "Obsolescence",
    healthTabCont: "Contradictions",
    healthNoStale: "Rien de périmé 👌",
    healthMonthsAgo: (n) => `il y a ${n} mois`,
    healthOpenHist: "Ouvrir l'historique",
    healthValueConflict: (s, a, b) => (s ? s + " : " : "") + a + " vs " + b,
    healthConfHigh: "valeur ≠",
    healthConfHighHint: "Deux docs donnent une valeur différente pour la même ligne de tableau. Signal fort.",
    healthReview: "à vérifier",
    healthReviewHint: "Même sujet. Piste à lire et juger, rien n’est affirmé.",
    healthNoCand: "Aucune contradiction détectée 👌. Demande à l'IA d'analyser les docs proches.",
    healthAskAi: "Valeurs divergentes et contradictions confirmées. Demande à l'IA d'en chercher d'autres dans les docs proches.",
    healthReal: "contradiction",
    healthDismiss: "pas une contradiction",
    healthDismissHint: "Marquer cette paire comme non contradictoire (réapparaît si un des deux docs est modifié).",
    historyError: "Impossible de charger l’historique.",
    historyNoChange: "Aucun changement dans cette révision.",
    historyViewVersion: "Voir cette version",
    historyViewChanges: "Voir les changements",
    historyRestore: "Restaurer cette version",
    historyRestoreBtn: "Restaurer",
    historyRestoreConfirm: "Elle remplacera le contenu actuel du document. Rien n’est perdu : la version actuelle restera dans l’historique, tu pourras y revenir.",
    historyRestored: "Version restaurée.",
    historyRestoreError: "Échec de la restauration.",
    referencedBy: (n) => `← Référencé par (${n})`,
    outgoingLinks: (n) => `→ Sortantes (${n})`,
    sameTopic: (n) => `~ Même sujet (${n})`,
    // Annotations
    noteBtn: "Noter",
    sanitizerMissing: "Sanitizer introuvable : rendu bloqué (aucun HTML non assaini). Vérifie /vendor/purify.min.js et le build.",
    appropriateDestPlaceholder: "dossier/copie",
    notesTitle: (n) => `Notes (${n})`,
    copyAllNotes: "Copier toutes les notes",
    notesCopied: (n) => `${n} note${n > 1 ? "s" : ""} copiée${n > 1 ? "s" : ""} dans le presse-papier`,
    orphanShort: "⚠ passage introuvable",
    orphanLong: (q) => "⚠ Passage introuvable (texte modifié) : “" + q + "”",
    notePlaceholder: "Ta note sur ce passage…",
    noteSaveFailed: (m) => "Échec de l’enregistrement de la note : " + m,
    actionFailed: (m) => "Échec : " + m,
    deleteNoteTitle: "Supprimer cette note ?",
    deleteNoteMsg: (txt) => "L’annotation « " + txt + " » sera définitivement supprimée.",
    // Recherche
    searching: "Recherche…",
    noResults: (q) => `Aucun résultat pour "${q}"`,
    nResults: (n) => n + " résultat" + (n > 1 ? "s" : ""),
    cappedSuffix: " (50 affichés)",
    paletteResultsCapped: (n) => n + " résultats (30 affichés)",
    cdnFailMiniSearch: "Impossible de charger MiniSearch",
    // Accueil
    heatNone: "Aucune modif",
    heatCount: (n) => n + " modif" + (n > 1 ? "s" : ""),
    statDocs: "Documents",
    statDocsSub: "markdown",
    statWords: "Mots totaux",
    statWordsSub: (n) => `~${n} min lecture`,
    statWeek: "Cette semaine",
    statWeekSub: "docs modifiés (vs précédente)",
    statTodoSub: "fait / total",
    activityTitle: "Activité (année glissante)",
    lessLabel: "moins",
    moreLabel: "plus",
    favorites: "Favoris",
    noFavorites: "Aucun favori. Épingle un doc avec le bouton favori de sa barre.",
    graphLabel: "The Mind",
    noTags: "Aucun tag.",
    recentlyModified: "Récemment modifiés",
    noRecentDocs: "Aucun document récent.",
    categories: "Catégories",
    longestDocs: "Plus longs documents",
    hintPalette: "palette",
    hintSearch: "recherche",
    hintSidebar: "sidebar",
    hintToc: "sommaire",
    hintEdit: "éditer",
    hintNewTodo: "nouvelle todo",
    rootLabel: "racine",
    // Palette de commandes
    actHome: "Accueil",
    actHomeHint: "Vue d'ensemble",
    actSidebar: "Replier / déplier la sidebar",
    actToc: "Masquer / afficher le sommaire",
    actEdit: "Éditer le document courant",
    actDownload: "Télécharger le document courant",
    actSearch: "Focus recherche",
    actGraph: "The Mind (vue d'ensemble)",
    actReload: "Recharger la page",
    palettePlaceholder: "Rechercher un fichier ou une action…",
    paletteNavigate: "naviguer",
    paletteOpen: "ouvrir",
    // Graphe
    graphTitle: "The Mind",
    mindSubtitle: "ton palais mental, celui que ton IA arpente avec toi",
    graphHint: "molette : zoom · glisser : déplacer · clic : ouvrir",
    graphModeOrganic: "Cerveau",
    graphModeStructured: "Cellules",
    graphTagsToggle: "Afficher / masquer les tags",
    closeEsc: "Fermer (Esc)",
    graphStats: (docs, links, tags) => docs + " docs · " + links + " liens, " + tags + " tags",
    tasksBtnTitle: "Tâches",
    tasksTitle: "Tâches",
    tasksShowDone: "Afficher les faites",
    tasksEmpty: "Aucune tâche à faire 🎉",
    tasksLoading: "Chargement des tâches",
    tasksStats: (open, total) => open + " à faire · " + total + " au total",
    nDocs: (n) => n + " doc" + (n > 1 ? "s" : ""),
    // Widget to-do
    nPending: (n) => `${n} à faire`,
    addTodoIn: (label) => "Ajouter dans " + label + "…",
    todoAddPlaceholder: "Ajouter une tâche…",
    enterKey: "Entrée",
    showDone: (n) => `Afficher faits (${n})`,
    hideDone: (n) => `Masquer faits (${n})`,
    clearDoneTitle: "Supprimer toutes les tâches faites",
    clearDoneBtn: "Vider faits",
    noTasksIn: (label) => `Aucune tâche dans ${label}. Ajoute-en une.`,
    allDone: (done) => `Tout est fait ${done > 0 ? `(${done} masqu${done > 1 ? "ées" : "ée"})` : ""}`,
    updated: "Modifié",
    synced: "Synchronisé",
    offlinePrefix: (m) => "Hors-ligne: " + m,
    fileModeTodoStatus: "Indisponible en mode hors-ligne",
    adding: "Ajout…",
    added: "Ajouté",
    doneStatus: "Terminé",
    reopened: "Réouvert",
    deletedStatus: "Supprimé",
    clearDoneConfirmTitle: (n) => `Vider ${n} tâche${n > 1 ? "s" : ""} faite${n > 1 ? "s" : ""} ?`,
    clearDoneConfirmMsg: "Les tâches cochées seront définitivement supprimées.",
    clearBtn: "Vider",
    clearing: "Vidage…",
    nCleared: (n) => `${n} supprimé${n > 1 ? "es" : "e"}`,
    serverRequired: "Serveur requis",
    fileModeTodosHtml: "Les tâches sont indisponibles en mode hors-ligne",
    // Modales document (renommer / déplacer / supprimer / nouveau)
    renameDocTitle: "Renommer le document",
    moveDocTitle: "Déplacer le document",
    folderLabel: "Dossier",
    dirPlaceholder: "ex: notes/projets",
    filenameLabel: "Nom du fichier",
    filenamePlaceholder: "nom-du-fichier",
    fileExistsAt: "Un fichier existe deja a cet emplacement",
    docMoved: "Document deplace",
    docRenamed: "Document renomme",
    deleteDocTitle: "Supprimer ce document ?",
    deleteDocMsg: (path) => 'Le fichier "' + path + `" sera definitivement supprime (un commit Git garde l'historique).`,
    docDeleted: "Document supprime",
    newDocHeader: "Nouveau document",
    templateLabel: "Template",
    visibilityLabel: "Visibilité",
    visibilityPrivate: "Privé, moi seul",
    visibilityCommons: "Commun, toute l'équipe",
    tplBlank: "Vide",
    docNamePlaceholder: "mon-document",
    fileExists: "Fichier deja existant",
    docCreated: "Document cree",
    // Partage
    shareModalTitle: "Partager ce document",
    shareDuration: "Durée de validité",
    hours24: "24h",
    days7: "7 jours",
    days30: "30 jours",
    never: "Jamais",
    shareGenerated: "Lien généré",
    shareOther: "Autre durée",
    done: "Terminé",
    shareExistingHeader: "Liens existants pour ce document",
    nLinks: (n) => n + (n > 1 ? " liens" : " lien"),
    expiresShort: (d) => "expire " + d,
    noExpiry: "sans expiration",
    createdShort: (d) => "créé " + d,
    revokeTitle: "Revoquer",
    revoke: "Révoquer",
    revokeConfirmTitle: "Révoquer ce lien ?",
    revokeConfirmMsg: "Le lien arrêtera de fonctionner immédiatement. Cette action est irréversible.",
    expiresAt: (d) => "Expire le " + d,
    neverExpires: "N'expire jamais",
    shareBroken: "(lien cassé)",
    shareReactivate: "Réactiver",
    shareReactivateTitle: "Réactiver ce lien",
    shareReactivateMsg: (p) => `Le document « ${p} » est introuvable (déplacé ou supprimé hors de l'app). Indique son nouveau chemin : le lien repartira sur la même URL.`,
    shareReactivatePlaceholder: "dossier/document.md",
    // Paramètres (admin)
    settingsTitle: "Paramètres",
    settingsTabUsers: "Utilisateurs",
    settingsTabTokens: "Tokens",
    settingsTabShares: "Partages",
    settingsEmailLabel: "Email",
    settingsRoleLabel: "Rôle",
    settingsRoleViewer: "Membre",
    settingsRoleAdmin: "Admin",
    settingsPasswordLabel: "Mot de passe",
    settingsPasswordPlaceholder: "8 car. min.",
    settingsEmailPlaceholder: "utilisateur@exemple.com",
    settingsAddUser: "Inviter",
    settingsInviteHint: "L'invité reçoit un lien et choisit lui-même son mot de passe.",
    settingsInviteOnce: "Copiez le lien maintenant : il ne sera plus jamais affiché",
    settingsInviteLink: "Lien d'invitation",
    settingsInvitePending: "En attente",
    settingsResendInvite: "Renvoyer le lien",
    settingsResetPassword: "Réinitialiser le mot de passe",
    settingsResetPasswordShort: "Réinitialiser",
    settingsResetPasswordTitle: "Réinitialiser le mot de passe",
    settingsResetPasswordFor: "Nouveau mot de passe pour",
    settingsNewPasswordLabel: "Nouveau mot de passe",
    settingsConfirmPasswordLabel: "Confirmer le mot de passe",
    settingsConfirmPasswordPlaceholder: "Saisir à nouveau",
    settingsPasswordRule: "8 caractères minimum.",
    settingsPasswordTooShort: "Le mot de passe doit faire au moins 8 caractères.",
    settingsPasswordMismatch: "Les deux mots de passe ne sont pas identiques.",
    settingsPasswordUpdated: "Mot de passe mis à jour.",
    settingsUpdatePassword: "Mettre à jour",
    settingsTogglePassword: "Afficher / masquer le mot de passe",
    settingsDeleteUser: "Supprimer",
    settingsDeleteUserTitle: "Supprimer cet utilisateur ?",
    settingsDeleteUserMsg: (e) => `Le compte ${e} sera supprimé définitivement.`,
    settingsLastAdmin: "Impossible de supprimer le dernier admin.",
    settingsUpdateAvailable: "Mise à jour disponible : version {latest} (vous avez {current}). Voir sur PyPI →",
    settingsNoUsers: "Aucun utilisateur.",
    settingsTokenLabel: "Libellé",
    settingsTokenLabelPlaceholder: "claude, mcp-perso...",
    settingsCreateToken: "Créer un token",
    settingsTokenOnce: "Copiez-le maintenant : il ne sera plus jamais affiché",
    settingsTokenPlain: "Token",
    settingsMcpUrl: "URL connecteur MCP",
    settingsRevokeToken: "Révoquer",
    settingsRevokeTokenTitle: "Révoquer ce token ?",
    settingsRevokeTokenMsg: (l) => `Le token « ${l} » cessera de fonctionner immédiatement.`,
    settingsNoTokens: "Aucun token API.",
    settingsTokenRevoked: "révoqué",
    settingsSharesHint: "Liens publics actifs vers des documents.",
    settingsNoShares: "Aucun lien de partage actif.",
    settingsTabNodes: "Nœuds",
    settingsNodesHint: "Publie un dossier ou un document en nœud : un autre atlas pourra s’y abonner en lecture seule via le lien.",
    settingsNodeName: "Nom du nœud",
    settingsNodeNamePlaceholder: "guide-equipe",
    settingsNodePath: "Chemin (dossier ou .md/.html)",
    settingsNodePathPlaceholder: "equipe/onboarding",
    settingsNodePublish: "Publier",
    settingsNodeOnce: "Copiez ce lien maintenant : il ne sera plus jamais affiché",
    settingsNodeLink: "Lien du nœud",
    settingsNoNodes: "Aucun nœud publié.",
    settingsNodeRelink: "Nouveau lien",
    settingsNodeRelinkTitle: "Régénérer le lien ?",
    settingsNodeRelinkMsg: (n) => `Republier « ${n} » génère un nouveau lien ; l’ancien cessera de fonctionner.`,
    settingsRevokeNodeTitle: "Révoquer ce nœud ?",
    settingsRevokeNodeMsg: (n) => `Le nœud « ${n} » et son lien cesseront de fonctionner immédiatement. Les abonnés perdront l’accès.`,
    settingsNodesPublished: "Mes nœuds publiés",
    settingsRemotesHeader: "Abonnements",
    settingsRemotesHint: "Colle le lien d’un nœud partagé pour le suivre en lecture seule.",
    settingsRemoteLink: "Lien du nœud",
    settingsRemoteLinkPlaceholder: "atlas-node:…",
    settingsRemoteAdd: "S’abonner",
    settingsNoRemotes: "Aucun abonnement.",
    settingsRemoteSynced: (d) => "synchronisé " + d,
    settingsRemoteNeverSynced: "jamais synchronisé",
    settingsRemoteFrom: (h) => "depuis " + h,
    settingsRemoteError: (msg) => "erreur : " + msg,
    settingsRemoteSync: "Synchroniser",
    settingsRemoteSyncFailed: (msg) => `Synchronisation impossible (émetteur injoignable ?) : ${msg}`,
    settingsRemoteAppropriate: "S’approprier",
    settingsRemoteAppropriateTitle: "Copier ce nœud dans tes documents (copie éditable, détachée)",
    settingsRemoteAppropriatePrompt: (n) => `S’approprier « ${n} » : destination dans tes documents ?`,
    settingsRemoteAppropriated: (c) => `Copié (${c} fichier(s)). La copie est éditable dans tes documents.`,
    settingsRemoteRemove: "Se désabonner",
    settingsRemoteRemoveTitle: "Se désabonner ?",
    settingsRemoteRemoveMsg: (n) => `Le miroir local de « ${n} » sera supprimé. Tu pourras te réabonner avec le lien.`,
    nodeAppropriateBtn: "S’approprier",
    nodeAppropriateTitle: "Copier ce nœud dans tes documents (copie éditable, détachée)",
    nodeAppropriateWholePrompt: (n) => `S’approprier le nœud « ${n} » entier : destination dans tes documents ?`,
    nodeAppropriateFilePrompt: (f) => `S’approprier « ${f} » : destination dans tes documents ?`,
    nodeRemoveBtn: "Retirer",
    nodeRemoveTitle: "Se désabonner de ce nœud",
    settingsErrForbidden: "Accès refusé : droits administrateur requis.",
    settingsErrConflict: "Conflit : cette opération a été refusée.",
    settingsErrGeneric: "Une erreur est survenue. Réessaie.",
    // Groupes (modèle B, principals group:<nom>)
    settingsTabGroups: "Groupes",
    settingsGroupsHint: "Crée des groupes pour partager des documents avec plusieurs personnes d’un coup.",
    settingsGroupNameLabel: "Nom du groupe",
    settingsGroupMembersLabel: "Membres (emails séparés par des virgules)",
    settingsGroupSave: "Enregistrer le groupe",
    settingsNoGroups: "Aucun groupe.",
    settingsGroupEmpty: "aucun membre",
    settingsGroupEdit: "Éditer",
    settingsGroupDelete: "Supprimer",
    settingsGroupDeleteTitle: "Supprimer le groupe ?",
    settingsGroupDeleteMsg: (name) => `Le groupe « ${name} » sera supprimé. Les partages qui le visent ne donneront plus accès.`,
    // Accès & partage par document (modèle B)
    aclBtn: "Accès",
    aclBtnTitle: "Gérer l’accès (privé / partagé)",
    aclModalTitle: "Accès & partage",
    aclPrivate: "Privé",
    aclCommons: "Commun, visible par tous les comptes",
    aclOwner: "propriétaire :",
    aclCreatedBy: "créé par",
    comboCreate: (q) => "Créer « " + q + " »",
    comboNoResults: "Aucun résultat",
    aclKindLabel: "Type",
    aclLevelLabel: "Niveau",
    aclValueLabel: "Email ou groupe",
    aclYou: "vous",
    aclNoGrants: "Partagé avec personne.",
    aclEveryone: "Tous les comptes",
    aclKindUser: "Personne",
    aclKindGroup: "Groupe",
    aclKindAll: "Tout le monde",
    aclValuePlaceholder: "email ou nom de groupe",
    aclLevelView: "Lecture",
    aclLevelComment: "Commentaire",
    aclLevelEdit: "Édition",
    aclLinkPrincipal: "Lien public",
    aclAdd: "Ajouter",
    aclRemove: "Retirer",
    aclMakePrivate: "Rendre privé",
    aclMakeCommons: "Mettre en commun",
    aclMakeCommonsConfirm: "Remettre en commun supprime le propriétaire ET tous les partages de ce document. Continuer ?",
    aclSharedToast: "Partage mis à jour",
    aclRevokedToast: "Accès retiré",
    aclNowPrivateToast: "Document rendu privé",
    aclNowCommonsToast: "Document remis en commun",
    aclVisibilityHelp: "Privé = vous seul (+ les accès ci-dessus). Commun = visible par toute l'équipe.",
    visPrivate: "Privé",
    visShared: "Partagé",
    visGranted: "Partagé avec vous",
    notFoundTitle: "Document introuvable ou accès non autorisé",
    notFoundBody: "Ce document n'existe pas, ou vous n'y avez pas accès.",
    notFoundHome: "Retour à l'accueil",
    titleLabel: "Titre",
    bodyLabel: "Corps",
    // Profil + Sécurité (nom, 2FA, sessions)
    settingsTabProfile: "Profil",
    profileNameTitle: "Votre nom",
    profileNameHint: "Affiché dans l'application.",
    profileFirstName: "Prénom",
    profileLastName: "Nom",
    profileSave: "Enregistrer",
    profileSaved: "Enregistré",
    securityTotpTitle: "Authentification à deux facteurs",
    securityTotpHint: "Ajoute un code à usage unique depuis ton application d’authentification.",
    securityTotpStatusOn: "Actif",
    securityTotpStatusOff: "Inactif",
    securityTotpEnable: "Activer le 2FA",
    securityTotpDisable: "Désactiver le 2FA",
    securitySessionsTitle: "Sessions",
    securitySessionsHint: "Déconnecte tous les appareils où ce compte est connecté, y compris celui-ci.",
    securityLogoutAll: "Déconnecter toutes mes sessions",
    securityLogoutAllConfirmTitle: "Déconnecter toutes les sessions ?",
    securityLogoutAllConfirmMsg: "Tu seras déconnecté ici et sur tous tes autres appareils. Tu devras te reconnecter.",
    securityLogoutAllConfirm: "Tout déconnecter",
    // Modale 2FA
    totpModalTitle: "Activer le 2FA",
    totpModalDisableTitle: "Désactiver le 2FA",
    totpScanHint: "Scanne ce QR code avec ton application d’authentification, ou ajoute la clé manuellement.",
    totpSecretLabel: "Clé secrète",
    totpVerifyLabel: "Code de vérification",
    totpConfirmEnable: "Confirmer et activer",
    totpInvalidCode: "Code invalide. Vérifie l’heure de ton téléphone et réessaie.",
    totpRecoveryWarn: "Conserve ces codes de secours en lieu sûr. Ils ne seront plus jamais affichés et chacun ne fonctionne qu’une fois.",
    totpRecoveryCopy: "Copier les codes",
    totpEnabledToast: "2FA activé.",
    totpDisabledToast: "2FA désactivé.",
    totpDisableHint: "Saisis un code de ton application (ou un code de secours) pour désactiver le 2FA.",
    totpConfirmDisable: "Désactiver",
    totpCodeRequired: "Saisis un code.",
    securityLoggedOutAll: "Toutes les sessions ont été déconnectées.",
    // Capture rapide
    quickCaptureTitle: "Capture rapide",
    quickCaptureHint: "Crée une note dans",
    titlePlaceholder: "Titre",
    qcBodyPlaceholder: "(optionnel) corps de la note",
    noteSaved: "Note enregistree dans inbox/",
    // Renommage de dossier
    currentFolder: "Dossier actuel :",
    newNameLabel: "Nouveau nom",
    dirRenameNote: "Tous les fichiers du dossier seront déplacés automatiquement.",
    folderRenamed: "Dossier renomme",
    // Barre d'outils markdown
    tbBold: "Gras (Ctrl+B)",
    tbItalic: "Italique (Ctrl+I)",
    tbStrike: "Barré",
    tbUl: "Liste à puces",
    tbUlLabel: "• Liste",
    tbOl: "Liste numérotée",
    tbOlLabel: "1. Liste",
    tbTodo: "Case à cocher",
    tbQuote: "Citation",
    tbQuoteLabel: "&ldquo; Citation",
    tbLink: "Lien (Ctrl+L)",
    tbLinkLabel: "🔗 Lien",
    tbCode: "Code inline",
    tbCodeblock: "Bloc de code",
    tbCodeblockLabel: "{ } Bloc",
    tbTable: "Tableau",
    tbHr: "Séparateur",
    phText: "texte",
    phLabel: "libellé"
  },
  en: {
    // Generic
    cancel: "Cancel",
    confirm: "Confirm",
    ok: "OK",
    errorTitle: "Error",
    offlineTitle: "Offline mode",
    offlineDisabled: "This feature is disabled.",
    save: "Save",
    close: "Close",
    del: "Delete",
    copy: "Copy",
    copied: "Copied",
    copiedBang: "Copied!",
    validate: "Confirm",
    create: "Create",
    err: (m) => "Error: " + m,
    errSp: (m) => "Error: " + m,
    nameRequired: "Name required",
    titleRequired: "Title required",
    noSlashes: "No / or \\ in the name",
    // Relative dates
    justNow: "just now",
    minAgo: (n) => `${n} min ago`,
    hoursAgo: (n) => `${n} h ago`,
    daysAgo: (n) => `${n} d ago`,
    // Sidebar / tree
    homeTitle: "Home",
    collapseSidebar: "Collapse (Ctrl+B)",
    showSidebar: "Show sidebar (Ctrl+B)",
    searchPlaceholder: "Search…",
    graphBtnTitle: "The Mind (Ctrl+G)",
    expandAllFolders: "Expand / collapse all",
    newDocTitle: "New document (N)",
    pinnedHeader: "Pinned",
    recentHeader: "Recent",
    sharedHeader: "Shared with you",
    treeContentHeader: "Content",
    signedInAs: "Signed in as",
    logoutTitle: "Log out",
    logoutLabel: "Logout",
    statsLine: (md, other) => `${md} markdown / ${other} other`,
    renameFolder: "Rename folder",
    renameFile: "Rename file",
    treeRemoteBadge: "linked",
    remotesLabel: "Mental nodes",
    shareAsNode: "Share as node",
    notesBadge: (n) => n + " note(s)",
    // Document action bar
    pin: "Pin",
    unpin: "Unpin",
    downloadTitle: "Download the file",
    downloadBtn: "Download",
    moreActions: "More actions",
    menuRename: "Rename",
    menuMove: "Move…",
    shareTitle: "Generate a public share link",
    shareBtn: "Share",
    editBtn: "Edit",
    saveBtn: "Save",
    saving: "Saving…",
    modifiedAgo: (d) => "modified " + d,
    sharedByLabel: (n) => "· shared by " + n,
    readingTime: (min, words) => `${min} min · ${words} words`,
    // Content / rendering
    loadingDoc: "Loading document",
    loadError: (m) => "Load error: " + m,
    offlineMissing: "content missing from the offline build",
    brokenLink: (tgt) => "Document not found: " + tgt,
    htmlDocBanner: "HTML document · isolated rendering (click inside the frame for keyboard navigation)",
    demoBannerTitle: "Read-only demo",
    demoBannerText: "Editing, accounts, sharing & collaboration, version history, your AI (MCP/API) and Hive sync all need your own instance.",
    demoBannerCta: "Get your own ↗",
    pdfDocBanner: "PDF document · preview",
    pdfOfflineHint: "PDF preview unavailable offline:",
    docxError: (e) => `Can't display this Word document (${e}). Download:`,
    openFullscreen: "Open full screen ↗",
    cantLoadDoc: (m) => "Could not load the document: " + m,
    fileModeNoEdit: "Editing unavailable in offline mode",
    // Tags
    folderTagTitle: "Folder tag (always present)",
    removeTag: "Remove",
    addTag: "Add a tag",
    tagSaveFailed: (m) => "Failed to save the tag: " + m,
    tagEditorTitle: "Custom tags",
    tagPlaceholder: "new tag…",
    tagEditorHint: "Enter to add · folder tags always remain",
    noCustomTags: "No custom tags.",
    docsWithTag: (n) => n + " document" + (n > 1 ? "s" : "") + " with this tag.",
    // Side panel (outline / links / notes)
    tocHeader: "On this doc",
    hideToc: "Hide (Ctrl+J)",
    showToc: "Show the outline (Ctrl+J)",
    linksTitle: "Links",
    historyTitle: "Document history",
    historyLabel: "History",
    historyHeader: "History",
    historyClose: "Close (Esc)",
    historyPick: "Pick a revision on the left.",
    historyEmpty: "No history for this document.",
    historyAiOnly: "AI writes",
    historyNoAi: "No AI writes on this document.",
    digestWeek: "This week",
    digestDocs: (n) => "doc" + (n > 1 ? "s" : ""),
    digestCreated: () => "new",
    digestChecked: (n) => "task" + (n > 1 ? "s" : ""),
    digestContributors: () => "people",
    digestViaAi: () => "AI",
    actTitle: "Activity",
    actJournal: "Journal",
    actConstellation: "Constellation",
    actHealth: "Health",
    actAiOnly: "AI only",
    actSeeAll: "See all →",
    actCollapse: "Collapse ↑",
    actSeeAllN: (n) => `See all (${n}) →`,
    actSeeChanges: "View changes",
    actEmptyAi: "No recent AI writes.",
    actEmpty: "No recent activity.",
    actInbox: "Inbox",
    inboxKeep: "Keep",
    inboxTrash: "Trash",
    inboxSnooze: "Snooze",
    inboxZero: "Inbox empty, nothing to triage 👌",
    inboxConfHigh: "high confidence",
    inboxConfMed: "medium confidence",
    inboxConfLow: "low confidence",
    inboxNext: "Next",
    inboxFileUnder: "file under",
    inboxChooseFolder: "choose a folder",
    inboxPickFolderFirst: "pick a folder first",
    inboxPickOrType: "pick or type a folder",
    inboxNewTag: "new tag",
    inboxSameSubject: "Same subject as a filed doc:",
    inboxDone: "done",
    inboxUpNext: "Up next",
    inboxNew: (n) => n === 1 ? "1 new item" : n + " new items",
    inboxZeroTitle: "Inbox",
    inboxZeroSub: "Your agents do the research for you. You just kept what matters.",
    inboxKept: "kept → graph",
    inboxTrashed: "trashed",
    inboxSnoozed: "snoozed",
    relJustNow: "just now",
    relYesterday: "yesterday",
    relDaysAgo: (d) => d + "d ago",
    healthTabStale: "Obsolescence",
    healthTabCont: "Contradictions",
    healthNoStale: "Nothing stale 👌",
    healthMonthsAgo: (n) => `${n} month${n > 1 ? "s" : ""} ago`,
    healthOpenHist: "Open history",
    healthValueConflict: (s, a, b) => (s ? s + ": " : "") + a + " vs " + b,
    healthConfHigh: "value ≠",
    healthConfHighHint: "Two docs give a different value for the same table row. Strong signal.",
    healthReview: "to check",
    healthReviewHint: "Same subject. A lead to read and judge, nothing is asserted.",
    healthNoCand: "No contradiction detected 👌. Ask the AI to scan related docs.",
    healthAskAi: "Diverging values and confirmed contradictions. Ask the AI to find more in related docs.",
    healthReal: "contradiction",
    healthDismiss: "not a contradiction",
    healthDismissHint: "Mark this pair as non-contradictory (it resurfaces if either doc is edited).",
    historyError: "Couldn’t load the history.",
    historyNoChange: "No change in this revision.",
    historyViewVersion: "View this version",
    historyViewChanges: "View changes",
    historyRestore: "Restore this version",
    historyRestoreBtn: "Restore",
    historyRestoreConfirm: "It will replace the document’s current content. Nothing is lost: the current version stays in the history, you can come back to it.",
    historyRestored: "Version restored.",
    historyRestoreError: "Restore failed.",
    referencedBy: (n) => `← Referenced by (${n})`,
    outgoingLinks: (n) => `→ Outgoing (${n})`,
    sameTopic: (n) => `~ Same topic (${n})`,
    // Annotations
    noteBtn: "Note",
    sanitizerMissing: "Sanitizer not found: rendering blocked (never unsanitized HTML). Check /vendor/purify.min.js and the build.",
    appropriateDestPlaceholder: "folder/copy",
    notesTitle: (n) => `Notes (${n})`,
    copyAllNotes: "Copy all notes",
    notesCopied: (n) => `${n} note${n > 1 ? "s" : ""} copied to clipboard`,
    orphanShort: "⚠ passage not found",
    orphanLong: (q) => "⚠ Passage not found (text changed): “" + q + "”",
    notePlaceholder: "Your note on this passage…",
    noteSaveFailed: (m) => "Failed to save the note: " + m,
    actionFailed: (m) => "Failed: " + m,
    deleteNoteTitle: "Delete this note?",
    deleteNoteMsg: (txt) => "The annotation “" + txt + "” will be permanently deleted.",
    // Search
    searching: "Searching…",
    noResults: (q) => `No results for "${q}"`,
    nResults: (n) => n + " result" + (n === 1 ? "" : "s"),
    cappedSuffix: " (50 shown)",
    paletteResultsCapped: (n) => n + " results (30 shown)",
    cdnFailMiniSearch: "Could not load MiniSearch",
    // Home
    heatNone: "No changes",
    heatCount: (n) => n + " change" + (n > 1 ? "s" : ""),
    statDocs: "Documents",
    statDocsSub: "markdown",
    statWords: "Total words",
    statWordsSub: (n) => `~${n} min read`,
    statWeek: "This week",
    statWeekSub: "docs modified (vs previous)",
    statTodoSub: "done / total",
    activityTitle: "Activity (rolling year)",
    lessLabel: "less",
    moreLabel: "more",
    favorites: "Favorites",
    noFavorites: "No favorites. Pin a doc with the favorite button in its bar.",
    graphLabel: "The Mind",
    noTags: "No tags.",
    recentlyModified: "Recently modified",
    noRecentDocs: "No recent documents.",
    categories: "Categories",
    longestDocs: "Longest documents",
    hintPalette: "palette",
    hintSearch: "search",
    hintSidebar: "sidebar",
    hintToc: "outline",
    hintEdit: "edit",
    hintNewTodo: "new todo",
    rootLabel: "root",
    // Command palette
    actHome: "Home",
    actHomeHint: "Overview",
    actSidebar: "Collapse / expand the sidebar",
    actToc: "Hide / show the outline",
    actEdit: "Edit the current document",
    actDownload: "Download the current document",
    actSearch: "Focus search",
    actGraph: "The Mind (overview)",
    actReload: "Reload the page",
    palettePlaceholder: "Search a file or an action…",
    paletteNavigate: "navigate",
    paletteOpen: "open",
    // Graph
    graphTitle: "The Mind",
    mindSubtitle: "your mind palace, the one your AI walks with you",
    graphHint: "wheel: zoom · drag: pan · click: open",
    graphModeOrganic: "Brain",
    graphModeStructured: "Cells",
    graphTagsToggle: "Show / hide tags",
    closeEsc: "Close (Esc)",
    graphStats: (docs, links, tags) => docs + " docs · " + links + " links, " + tags + " tags",
    tasksBtnTitle: "Tasks",
    tasksTitle: "Tasks",
    tasksShowDone: "Show completed",
    tasksEmpty: "Nothing to do 🎉",
    tasksLoading: "Loading tasks",
    tasksStats: (open, total) => open + " to do · " + total + " total",
    nDocs: (n) => n + " doc" + (n > 1 ? "s" : ""),
    // To-do widget
    nPending: (n) => `${n} to do`,
    addTodoIn: (label) => "Add to " + label + "…",
    todoAddPlaceholder: "Add a task…",
    enterKey: "Enter",
    showDone: (n) => `Show done (${n})`,
    hideDone: (n) => `Hide done (${n})`,
    clearDoneTitle: "Delete all completed tasks",
    clearDoneBtn: "Clear done",
    noTasksIn: (label) => `No tasks in ${label}. Add one.`,
    allDone: (done) => `All done ${done > 0 ? `(${done} hidden)` : ""}`,
    updated: "Updated",
    synced: "Synced",
    offlinePrefix: (m) => "Offline: " + m,
    fileModeTodoStatus: "Unavailable in offline mode",
    adding: "Adding…",
    added: "Added",
    doneStatus: "Done",
    reopened: "Reopened",
    deletedStatus: "Deleted",
    clearDoneConfirmTitle: (n) => `Clear ${n} completed task${n > 1 ? "s" : ""}?`,
    clearDoneConfirmMsg: "Checked tasks will be permanently deleted.",
    clearBtn: "Clear",
    clearing: "Clearing…",
    nCleared: (n) => `${n} deleted`,
    serverRequired: "Server required",
    fileModeTodosHtml: "To-dos are unavailable in offline mode",
    // Document modals (rename / move / delete / new)
    renameDocTitle: "Rename the document",
    moveDocTitle: "Move the document",
    folderLabel: "Folder",
    dirPlaceholder: "e.g. notes/projects",
    filenameLabel: "File name",
    filenamePlaceholder: "file-name",
    fileExistsAt: "A file already exists at this location",
    docMoved: "Document moved",
    docRenamed: "Document renamed",
    deleteDocTitle: "Delete this document?",
    deleteDocMsg: (path) => 'The file "' + path + '" will be permanently deleted (a Git commit keeps the history).',
    docDeleted: "Document deleted",
    newDocHeader: "New document",
    templateLabel: "Template",
    visibilityLabel: "Visibility",
    visibilityPrivate: "Private, only me",
    visibilityCommons: "Common, whole team",
    tplBlank: "Blank",
    docNamePlaceholder: "my-document",
    fileExists: "File already exists",
    docCreated: "Document created",
    // Sharing
    shareModalTitle: "Share this document",
    shareDuration: "Validity period",
    hours24: "24h",
    days7: "7 days",
    days30: "30 days",
    never: "Never",
    shareGenerated: "Generated link",
    shareOther: "Another duration",
    done: "Done",
    shareExistingHeader: "Existing links for this document",
    nLinks: (n) => n + (n > 1 ? " links" : " link"),
    expiresShort: (d) => "expires " + d,
    noExpiry: "no expiry",
    createdShort: (d) => "created " + d,
    revokeTitle: "Revoke",
    revoke: "Revoke",
    revokeConfirmTitle: "Revoke this link?",
    revokeConfirmMsg: "The link will stop working immediately. This action is irreversible.",
    expiresAt: (d) => "Expires on " + d,
    neverExpires: "Never expires",
    shareBroken: "(broken link)",
    shareReactivate: "Reactivate",
    shareReactivateTitle: "Reactivate this link",
    shareReactivateMsg: (p) => `The document "${p}" is missing (moved or deleted outside the app). Enter its new path: the link will resume on the same URL.`,
    shareReactivatePlaceholder: "folder/document.md",
    // Settings (admin)
    settingsTitle: "Settings",
    settingsTabUsers: "Users",
    settingsTabTokens: "Tokens",
    settingsTabShares: "Shares",
    settingsEmailLabel: "Email",
    settingsRoleLabel: "Role",
    settingsRoleViewer: "Member",
    settingsRoleAdmin: "Admin",
    settingsPasswordLabel: "Password",
    settingsPasswordPlaceholder: "8 chars min.",
    settingsEmailPlaceholder: "user@example.com",
    settingsAddUser: "Invite",
    settingsInviteHint: "The invitee gets a link and sets their own password.",
    settingsInviteOnce: "Copy the link now, it will never be shown again",
    settingsInviteLink: "Invitation link",
    settingsInvitePending: "Pending",
    settingsResendInvite: "Resend link",
    settingsResetPassword: "Reset password",
    settingsResetPasswordShort: "Reset",
    settingsResetPasswordTitle: "Reset password",
    settingsResetPasswordFor: "New password for",
    settingsNewPasswordLabel: "New password",
    settingsConfirmPasswordLabel: "Confirm password",
    settingsConfirmPasswordPlaceholder: "Type it again",
    settingsPasswordRule: "8 characters minimum.",
    settingsPasswordTooShort: "Password must be at least 8 characters.",
    settingsPasswordMismatch: "The two passwords do not match.",
    settingsPasswordUpdated: "Password updated.",
    settingsUpdatePassword: "Update",
    settingsTogglePassword: "Show / hide password",
    settingsDeleteUser: "Delete",
    settingsDeleteUserTitle: "Delete this user?",
    settingsDeleteUserMsg: (e) => `The account ${e} will be permanently deleted.`,
    settingsLastAdmin: "Cannot delete the last admin.",
    settingsUpdateAvailable: "Update available: version {latest} (you have {current}). View on PyPI →",
    settingsNoUsers: "No users.",
    settingsTokenLabel: "Label",
    settingsTokenLabelPlaceholder: "claude, my-mcp...",
    settingsCreateToken: "Create token",
    settingsTokenOnce: "Copy it now: it will never be shown again",
    settingsTokenPlain: "Token",
    settingsMcpUrl: "MCP connector URL",
    settingsRevokeToken: "Revoke",
    settingsRevokeTokenTitle: "Revoke this token?",
    settingsRevokeTokenMsg: (l) => `The token "${l}" will stop working immediately.`,
    settingsNoTokens: "No API tokens.",
    settingsTokenRevoked: "revoked",
    settingsSharesHint: "Active public links to documents.",
    settingsNoShares: "No active share links.",
    settingsTabNodes: "Nodes",
    settingsNodesHint: "Publish a folder or a document as a node: another atlas can subscribe to it read-only via the link.",
    settingsNodeName: "Node name",
    settingsNodeNamePlaceholder: "team-guide",
    settingsNodePath: "Path (folder or .md/.html)",
    settingsNodePathPlaceholder: "team/onboarding",
    settingsNodePublish: "Publish",
    settingsNodeOnce: "Copy this link now: it will never be shown again",
    settingsNodeLink: "Node link",
    settingsNoNodes: "No published nodes.",
    settingsNodeRelink: "New link",
    settingsNodeRelinkTitle: "Regenerate link?",
    settingsNodeRelinkMsg: (n) => `Re-publishing "${n}" generates a new link; the old one will stop working.`,
    settingsRevokeNodeTitle: "Revoke this node?",
    settingsRevokeNodeMsg: (n) => `Node "${n}" and its link will stop working immediately. Subscribers will lose access.`,
    settingsNodesPublished: "My published nodes",
    settingsRemotesHeader: "Subscriptions",
    settingsRemotesHint: "Paste a shared node link to follow it read-only.",
    settingsRemoteLink: "Node link",
    settingsRemoteLinkPlaceholder: "atlas-node:…",
    settingsRemoteAdd: "Subscribe",
    settingsNoRemotes: "No subscriptions.",
    settingsRemoteSynced: (d) => "synced " + d,
    settingsRemoteNeverSynced: "never synced",
    settingsRemoteFrom: (h) => "from " + h,
    settingsRemoteError: (msg) => "error: " + msg,
    settingsRemoteSync: "Sync",
    settingsRemoteSyncFailed: (msg) => `Sync failed (publisher unreachable?): ${msg}`,
    settingsRemoteAppropriate: "Make mine",
    settingsRemoteAppropriateTitle: "Copy this node into your documents (editable, detached copy)",
    settingsRemoteAppropriatePrompt: (n) => `Make "${n}" yours: destination in your documents?`,
    settingsRemoteAppropriated: (c) => `Copied (${c} file(s)). The copy is editable in your documents.`,
    settingsRemoteRemove: "Unsubscribe",
    settingsRemoteRemoveTitle: "Unsubscribe?",
    settingsRemoteRemoveMsg: (n) => `The local mirror of "${n}" will be deleted. You can re-subscribe with the link.`,
    nodeAppropriateBtn: "Make mine",
    nodeAppropriateTitle: "Copy this node into your documents (editable, detached copy)",
    nodeAppropriateWholePrompt: (n) => `Make the whole node "${n}" yours: destination in your documents?`,
    nodeAppropriateFilePrompt: (f) => `Make "${f}" yours: destination in your documents?`,
    nodeRemoveBtn: "Remove",
    nodeRemoveTitle: "Unsubscribe from this node",
    settingsErrForbidden: "Access denied: administrator rights required.",
    settingsErrConflict: "Conflict: this operation was refused.",
    settingsErrGeneric: "Something went wrong. Try again.",
    // Groups (model B, principals group:<name>)
    settingsTabGroups: "Groups",
    settingsGroupsHint: "Create groups to share documents with several people at once.",
    settingsGroupNameLabel: "Group name",
    settingsGroupMembersLabel: "Members (comma-separated emails)",
    settingsGroupSave: "Save group",
    settingsNoGroups: "No groups yet.",
    settingsGroupEmpty: "no members",
    settingsGroupEdit: "Edit",
    settingsGroupDelete: "Delete",
    settingsGroupDeleteTitle: "Delete group?",
    settingsGroupDeleteMsg: (name) => `Group "${name}" will be deleted. Shares targeting it will no longer grant access.`,
    // Per-document access & sharing (model B)
    aclBtn: "Access",
    aclBtnTitle: "Manage access (private / shared)",
    aclModalTitle: "Access & sharing",
    aclPrivate: "Private",
    aclCommons: "Common, visible to all accounts",
    aclOwner: "owner:",
    aclCreatedBy: "created by",
    comboCreate: (q) => 'Create "' + q + '"',
    comboNoResults: "No results",
    aclKindLabel: "Type",
    aclLevelLabel: "Level",
    aclValueLabel: "Email or group",
    aclYou: "you",
    aclNoGrants: "Not shared with anyone.",
    aclEveryone: "Everyone (authenticated)",
    aclKindUser: "Person",
    aclKindGroup: "Group",
    aclKindAll: "Everyone",
    aclValuePlaceholder: "email or group name",
    aclLevelView: "View",
    aclLevelComment: "Comment",
    aclLevelEdit: "Edit",
    aclLinkPrincipal: "Public link",
    aclAdd: "Add",
    aclRemove: "Remove",
    aclMakePrivate: "Make private",
    aclMakeCommons: "Make common",
    aclMakeCommonsConfirm: "Moving to the commons removes the owner AND every share of this document. Continue?",
    aclSharedToast: "Sharing updated",
    aclRevokedToast: "Access removed",
    aclNowPrivateToast: "Document made private",
    aclNowCommonsToast: "Document moved to the commons",
    aclVisibilityHelp: "Private = only you (+ the access above). Common = visible to the whole team.",
    visPrivate: "Private",
    visShared: "Shared",
    visGranted: "Shared with you",
    notFoundTitle: "Document not found or access denied",
    notFoundBody: "This document doesn't exist, or you don't have access to it.",
    notFoundHome: "Back home",
    titleLabel: "Title",
    bodyLabel: "Body",
    // Profile + Security (name, 2FA, sessions)
    settingsTabProfile: "Profile",
    profileNameTitle: "Your name",
    profileNameHint: "Shown across the app.",
    profileFirstName: "First name",
    profileLastName: "Last name",
    profileSave: "Save",
    profileSaved: "Saved",
    securityTotpTitle: "Two-factor authentication",
    securityTotpHint: "Add a one-time code from your authenticator app.",
    securityTotpStatusOn: "On",
    securityTotpStatusOff: "Off",
    securityTotpEnable: "Enable 2FA",
    securityTotpDisable: "Disable 2FA",
    securitySessionsTitle: "Sessions",
    securitySessionsHint: "Sign out every device where this account is signed in, including this one.",
    securityLogoutAll: "Sign out all my sessions",
    securityLogoutAllConfirmTitle: "Sign out all sessions?",
    securityLogoutAllConfirmMsg: "You will be signed out here and on all your other devices. You will need to sign in again.",
    securityLogoutAllConfirm: "Sign out everywhere",
    // 2FA modal
    totpModalTitle: "Enable 2FA",
    totpModalDisableTitle: "Disable 2FA",
    totpScanHint: "Scan this QR code with your authenticator app, or add the key manually.",
    totpSecretLabel: "Secret key",
    totpVerifyLabel: "Verification code",
    totpConfirmEnable: "Confirm and enable",
    totpInvalidCode: "Invalid code. Check your phone’s clock and try again.",
    totpRecoveryWarn: "Keep these recovery codes somewhere safe. They will never be shown again and each one works only once.",
    totpRecoveryCopy: "Copy codes",
    totpEnabledToast: "2FA enabled.",
    totpDisabledToast: "2FA disabled.",
    totpDisableHint: "Enter a code from your app (or a recovery code) to disable 2FA.",
    totpConfirmDisable: "Disable",
    totpCodeRequired: "Enter a code.",
    securityLoggedOutAll: "All sessions have been signed out.",
    // Quick capture
    quickCaptureTitle: "Quick capture",
    quickCaptureHint: "Creates a note in",
    titlePlaceholder: "Title",
    qcBodyPlaceholder: "(optional) note body",
    noteSaved: "Note saved to inbox/",
    // Folder rename
    currentFolder: "Current folder:",
    newNameLabel: "New name",
    dirRenameNote: "All files in the folder will be moved automatically.",
    folderRenamed: "Folder renamed",
    // Markdown toolbar
    tbBold: "Bold (Ctrl+B)",
    tbItalic: "Italic (Ctrl+I)",
    tbStrike: "Strikethrough",
    tbUl: "Bullet list",
    tbUlLabel: "• List",
    tbOl: "Numbered list",
    tbOlLabel: "1. List",
    tbTodo: "Checkbox",
    tbQuote: "Quote",
    tbQuoteLabel: "&ldquo; Quote",
    tbLink: "Link (Ctrl+L)",
    tbLinkLabel: "🔗 Link",
    tbCode: "Inline code",
    tbCodeblock: "Code block",
    tbCodeblockLabel: "{ } Block",
    tbTable: "Table",
    tbHr: "Divider",
    phText: "text",
    phLabel: "label"
  }
};
function t(key, ...args) {
  const dict = STRINGS[LANG] || STRINGS.fr;
  let entry = dict[key];
  if (entry === void 0) entry = STRINGS.fr[key];
  if (entry === void 0) return key;
  return typeof entry === "function" ? entry(...args) : entry;
}
function applyStaticI18n() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
}
applyStaticI18n();

function setStatus(msg, kind) {
  const colors = { ok: "text-emerald-400", err: "text-rose-400", info: "text-ink-500" };
  todoStatus.innerHTML = `<span class="${colors[kind] || colors.info}">${msg}</span><span class="text-ink-600">${location.host}</span>`;
}
async function api(method, path, body) {
  const headers = {};
  const opts = { method, headers };
  if (body) {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

let tocHasLinks = false;
let tocHasNotes = false;
let currentFile = null;
let editMode = false;
let editTextarea = null;
let mdCount = 0, otherCount = 0;
const EMBED_MIND = location.hash.replace(/^#/, "") === "mind";
const isServerMode = (location.protocol === "http:" || location.protocol === "https:") && !IS_OFFLINE_BUILD;

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
class Tooltip {
  constructor() {
    __publicField(this, "el");
    this.el = document.createElement("div");
    this.el.className = "fixed pointer-events-none bg-navy-800/95 border subtle-border text-ink-100 text-xs px-3 py-1.5 rounded-md shadow-2xl shadow-black/70 z-50 opacity-0 max-w-md whitespace-nowrap font-medium";
    this.el.style.cssText += ";backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);transition:opacity 0.12s ease, transform 0.12s ease;transform:translateY(-50%) translateX(-4px);";
    document.body.appendChild(this.el);
    document.addEventListener("mouseover", (e) => this.onMouseOver(e));
    document.addEventListener("mouseout", (e) => this.onMouseOut(e));
  }
  isTruncated(el) {
    return el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight;
  }
  position(target) {
    const rect = target.getBoundingClientRect();
    const GAP = 14;
    this.el.style.left = rect.right + GAP + "px";
    this.el.style.top = rect.top + rect.height / 2 + "px";
    requestAnimationFrame(() => {
      const tipRect = this.el.getBoundingClientRect();
      if (tipRect.right > window.innerWidth - 8) this.el.style.left = rect.left - tipRect.width - GAP + "px";
    });
  }
  hide() {
    this.el.style.opacity = "0";
    this.el.style.transform = "translateY(-50%) translateX(-4px)";
  }
  onMouseOver(e) {
    const target = e.target?.closest("[data-name], [data-tip]") ?? null;
    if (!target) {
      this.hide();
      return;
    }
    const isTip = !!target.dataset.tip;
    const text = isTip ? target.dataset.tip : this.isTruncated(target) ? target.dataset.name : "";
    if (!text) {
      this.hide();
      return;
    }
    this.el.style.whiteSpace = isTip ? "normal" : "nowrap";
    this.el.textContent = text;
    this.position(target);
    this.el.style.opacity = "1";
    this.el.style.transform = "translateY(-50%) translateX(0)";
  }
  onMouseOut(e) {
    const related = e.relatedTarget;
    if (!related || !related.closest("[data-name], [data-tip]")) this.hide();
  }
}
new Tooltip();

const fileMap = {};
function index(node) {
  const children = node.type === "dir" ? node.children : [];
  for (const c of children) {
    if (c.type === "file") {
      fileMap[c.path] = c;
      if (c.ext === ".md") mdCount++;
      else otherCount++;
    } else index(c);
  }
}
if (IS_OFFLINE_BUILD) {
  index(TREE);
}
statsEl.textContent = t("statsLine", mdCount, otherCount);

function relativeDate(epoch) {
  if (!epoch) return "";
  const diff = Date.now() / 1e3 - epoch;
  if (diff < 60) return t("justNow");
  if (diff < 3600) return t("minAgo", Math.floor(diff / 60));
  if (diff < 86400) return t("hoursAgo", Math.floor(diff / 3600));
  if (diff < 86400 * 7) return t("daysAgo", Math.floor(diff / 86400));
  return new Date(epoch * 1e3).toLocaleDateString(LANG, {
    day: "numeric",
    month: "short",
    year: "numeric"
  });
}
function slugify(s) {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function escapeHtml(s) {
  const map = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  };
  return String(s).replace(/[&<>"']/g, (c) => map[c]);
}

class Modal {
  constructor(backdrop) {
    this.backdrop = backdrop;
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) this.close();
    });
  }
  isOpen() {
    return !this.backdrop.classList.contains("hidden");
  }
  close() {
    this.backdrop.classList.add("hidden");
  }
  reveal() {
    this.backdrop.classList.remove("hidden");
  }
}

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
(function(root) {
  "use strict";
  class Rng {
    constructor(identity) {
      __publicField(this, "seed");
      __publicField(this, "a");
      this.seed = Rng.hash(identity);
      this.a = this.seed;
    }
    // Next value in [0, 1).
    next() {
      this.a |= 0;
      this.a = this.a + 1831565813 | 0;
      let t = Math.imul(this.a ^ this.a >>> 15, 1 | this.a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }
    // FNV-1a (shift-mixed) hash of the identity -> the seed.
    static hash(str) {
      let h = 2166136261;
      for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
      }
      return h >>> 0;
    }
  }
  const _Avatar = class _Avatar {
    constructor(identity, size = 96) {
      __publicField(this, "rng");
      __publicField(this, "size");
      __publicField(this, "small");
      __publicField(this, "uid");
      __publicField(this, "prim");
      __publicField(this, "acc");
      __publicField(this, "back");
      __publicField(this, "nodes");
      __publicField(this, "edges");
      __publicField(this, "field");
      this.rng = new Rng(identity);
      this.size = size;
      this.small = size <= 36;
      this.uid = "s" + this.rng.seed.toString(36);
      const palette = this.pickPalette();
      this.prim = palette.prim;
      this.acc = palette.acc;
      this.back = this.pickBackdrop(palette.accIdx);
      this.nodes = this.buildNodes();
      this.edges = this.buildEdges(this.nodes);
      this.field = this.buildField();
    }
    // Seed string for an account's avatar: "First Last" (each half trimmed, blanks dropped)
    // concatenated with the email. Empty name -> email only. Compute it the SAME way on every
    // surface (user bar, admin list, profile) or one account would render different avatars.
    static seed(firstName, lastName, email) {
      const name = [firstName, lastName].map((s) => (s == null ? "" : String(s)).trim()).filter(Boolean).join(" ");
      return name + (email == null ? "" : String(email));
    }
    render() {
      return this.open() + this.defs() + '<g clip-path="url(#clip_' + this.uid + ')">' + this.backdrop() + this.stars() + this.orbitRing() + this.graph() + this.core() + "</g>" + this.rim() + "</svg>";
    }
    // ── seeded geometry (pulls this.rng in this exact order — see the file header) ──
    pickPalette() {
      const r = this.rng;
      const pick = r.next();
      const primIdx = pick < 0.5 ? r.next() * 3 | 0 : r.next() * _Avatar.BAND.length | 0;
      const accIdx = (primIdx + 2 + (r.next() * 3 | 0)) % _Avatar.BAND.length;
      return { prim: _Avatar.BAND[primIdx], acc: _Avatar.BAND[accIdx], accIdx };
    }
    // Backdrop variety (seeded): the nebula glow drifts + spreads, and a second wisp in a
    // third hue is offset over it — so identities differ by their background as much as by
    // their graph, which lets the satellite count stay low without looking samey.
    pickBackdrop(accIdx) {
      const r = this.rng;
      const nebCx = _Avatar.round(30 + r.next() * 34);
      const nebCy = _Avatar.round(26 + r.next() * 30);
      const nebR = _Avatar.round(66 + r.next() * 22);
      const wisp = _Avatar.BAND[(accIdx + 1 + (r.next() * 3 | 0)) % _Avatar.BAND.length];
      const wCx = _Avatar.round(18 + r.next() * 64);
      const wCy = _Avatar.round(18 + r.next() * 64);
      const wR = _Avatar.round(36 + r.next() * 26);
      return { nebCx, nebCy, nebR, wisp, wCx, wCy, wR };
    }
    // Hub at the center + orbiting satellites. Structure stays size-independent so the same
    // identity looks the same at any size.
    buildNodes() {
      const r = this.rng;
      const satN = 3 + (r.next() * 3 | 0);
      const baseAng = r.next() * Math.PI * 2;
      const even = r.next() < 0.55;
      const nodes = [{ x: _Avatar.CX, y: _Avatar.CY, r: 8.5, hub: true }];
      for (let i = 0; i < satN; i++) {
        const t = even ? i / satN : i / satN + (r.next() - 0.5) * 0.16;
        const ang = baseAng + t * Math.PI * 2;
        const rr = _Avatar.RING_R * (0.82 + r.next() * 0.36);
        const m = 12;
        const nx = Math.max(m, Math.min(_Avatar.VB - m, _Avatar.CX + Math.cos(ang) * rr));
        const ny = Math.max(m, Math.min(_Avatar.VB - m, _Avatar.CY + Math.sin(ang) * rr));
        nodes.push({ x: nx, y: ny, r: 3 + r.next() * 2.6, hub: false, tw: r.next() });
      }
      return nodes;
    }
    // Every satellite links to the hub (the spine); a couple of chords add network feel.
    buildEdges(nodes) {
      const r = this.rng;
      const satN = nodes.length - 1;
      const edges = [];
      for (let k = 1; k < nodes.length; k++) edges.push([0, k]);
      const chords = 1 + (r.next() * 2 | 0);
      for (let c = 0; c < chords; c++) {
        const ea = 1 + (r.next() * satN | 0);
        const eb = 1 + (r.next() * satN | 0);
        if (ea !== eb && ea < nodes.length && eb < nodes.length) edges.push([ea, eb]);
      }
      return edges;
    }
    // Faint twinkling field-star dust (negligible at small size, kept for consistency).
    buildField() {
      const r = this.rng;
      const field = [];
      const n = 9 + r.seed % 7;
      for (let f = 0; f < n; f++) {
        field.push({ x: r.next() * _Avatar.VB, y: r.next() * _Avatar.VB, r: 0.3 + r.next() * 0.7, tw: r.next(), op: 0.16 + r.next() * 0.3 });
      }
      return field;
    }
    // ── pure formatting utilities (stateless, like Math.round) ──
    static round(n) {
      return Math.round(n * 100) / 100;
    }
    static hsl(c, dl) {
      const l = Math.max(0, Math.min(100, c.l + (dl || 0)));
      return "hsl(" + c.h + "," + c.s + "%," + l + "%)";
    }
    static hsla(c, dl, a) {
      const l = Math.max(0, Math.min(100, c.l + (dl || 0)));
      return "hsla(" + c.h + "," + c.s + "%," + l + "%," + a + ")";
    }
    // ── render layers (z-order) ──
    open() {
      return '<svg xmlns="http://www.w3.org/2000/svg" width="' + this.size + '" height="' + this.size + '" viewBox="0 0 ' + _Avatar.VB + " " + _Avatar.VB + '" role="img" aria-label="avatar">';
    }
    defs() {
      const { prim, acc, uid, back } = this;
      const blur = this.small ? 1 : 1.9;
      let s = "<defs>";
      s += '<radialGradient id="neb_' + uid + '" cx="' + back.nebCx + '%" cy="' + back.nebCy + '%" r="' + back.nebR + '%">';
      s += '<stop offset="0%" stop-color="' + _Avatar.hsl(prim, -30) + '"/>';
      s += '<stop offset="40%" stop-color="' + _Avatar.hsla(acc, -34, 0.55) + '"/>';
      s += '<stop offset="100%" stop-color="#0b1220"/>';
      s += "</radialGradient>";
      s += '<radialGradient id="wisp_' + uid + '" cx="' + back.wCx + '%" cy="' + back.wCy + '%" r="' + back.wR + '%">';
      s += '<stop offset="0%" stop-color="' + _Avatar.hsla(back.wisp, -8, 0.5) + '"/>';
      s += '<stop offset="55%" stop-color="' + _Avatar.hsla(back.wisp, -22, 0.16) + '"/>';
      s += '<stop offset="100%" stop-color="' + _Avatar.hsla(back.wisp, -22, 0) + '"/>';
      s += "</radialGradient>";
      s += '<radialGradient id="hub_' + uid + '" cx="42%" cy="38%" r="68%">';
      s += '<stop offset="0%" stop-color="#fff7e8"/>';
      s += '<stop offset="32%" stop-color="' + _Avatar.hsl(prim, 18) + '"/>';
      s += '<stop offset="72%" stop-color="' + _Avatar.hsl(prim, -4) + '"/>';
      s += '<stop offset="100%" stop-color="' + _Avatar.hsl(prim, -22) + '"/>';
      s += "</radialGradient>";
      s += '<radialGradient id="halo_' + uid + '" cx="50%" cy="50%" r="50%">';
      s += '<stop offset="0%" stop-color="' + _Avatar.hsla(prim, 6, 0.55) + '"/>';
      s += '<stop offset="55%" stop-color="' + _Avatar.hsla(prim, 0, 0.18) + '"/>';
      s += '<stop offset="100%" stop-color="' + _Avatar.hsla(prim, 0, 0) + '"/>';
      s += "</radialGradient>";
      s += '<linearGradient id="edge_' + uid + '" x1="0%" y1="0%" x2="100%" y2="100%">';
      s += '<stop offset="0%" stop-color="' + _Avatar.GOLD + '"/>';
      s += '<stop offset="100%" stop-color="' + _Avatar.hsla(acc, 12, 0.85) + '"/>';
      s += "</linearGradient>";
      s += '<filter id="glow_' + uid + '" x="-60%" y="-60%" width="220%" height="220%">';
      s += '<feGaussianBlur stdDeviation="' + _Avatar.round(blur) + '" result="b"/>';
      s += '<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>';
      s += "</filter>";
      s += '<clipPath id="clip_' + uid + '"><rect x="0" y="0" width="' + _Avatar.VB + '" height="' + _Avatar.VB + '" rx="24" ry="24"/></clipPath>';
      s += "</defs>";
      return s;
    }
    backdrop() {
      const { uid } = this;
      return '<rect x="0" y="0" width="' + _Avatar.VB + '" height="' + _Avatar.VB + '" fill="#0b1220"/><rect x="0" y="0" width="' + _Avatar.VB + '" height="' + _Avatar.VB + '" fill="url(#neb_' + uid + ')"/><rect x="0" y="0" width="' + _Avatar.VB + '" height="' + _Avatar.VB + '" fill="url(#wisp_' + uid + ')"/>';
    }
    stars() {
      let s = "";
      for (let ff = 0; ff < this.field.length; ff++) {
        const p = this.field[ff];
        const cls = p.tw > 0.55 ? ' class="cst-star"' : "";
        const dly = cls ? ' style="animation-delay:' + _Avatar.round(p.tw * 3) + 's"' : "";
        s += "<circle" + cls + dly + ' cx="' + _Avatar.round(p.x) + '" cy="' + _Avatar.round(p.y) + '" r="' + _Avatar.round(p.r) + '" fill="#cfe6ff" opacity="' + _Avatar.round(p.op) + '"/>';
      }
      return s;
    }
    // Faint orbit ring (structure cue, large render only).
    orbitRing() {
      if (this.small) return "";
      return '<circle cx="' + _Avatar.CX + '" cy="' + _Avatar.CY + '" r="' + _Avatar.round(_Avatar.RING_R) + '" fill="none" stroke="' + _Avatar.hsla(this.acc, 8, 0.16) + '" stroke-width="0.7" stroke-dasharray="1.6 3.2"/>';
    }
    // The graph (edges + satellites) slowly orbits the fixed hub.
    graph() {
      const { nodes, edges, prim, acc, small, uid } = this;
      let s = '<g class="cst-orbit"><g filter="url(#glow_' + uid + ')">';
      for (let e = 0; e < edges.length; e++) {
        const n1 = nodes[edges[e][0]], n2 = nodes[edges[e][1]];
        s += '<line x1="' + _Avatar.round(n1.x) + '" y1="' + _Avatar.round(n1.y) + '" x2="' + _Avatar.round(n2.x) + '" y2="' + _Avatar.round(n2.y) + '" stroke="url(#edge_' + uid + ')" stroke-width="' + (small ? 0.9 : 1.05) + '" stroke-linecap="round" opacity="0.9"/>';
      }
      s += "</g>";
      s += '<g filter="url(#glow_' + uid + ')">';
      for (let n = 1; n < nodes.length; n++) {
        const nd = nodes[n];
        const col = n % 2 === 0 ? _Avatar.hsl(acc, 10) : _Avatar.hsl(prim, 14);
        const twinkle = !small && nd.tw < 0.5 ? ' class="cst-star"' : "";
        const tdly = twinkle ? ' style="animation-delay:' + _Avatar.round(nd.tw * 2.5) + 's"' : "";
        s += "<circle" + twinkle + tdly + ' cx="' + _Avatar.round(nd.x) + '" cy="' + _Avatar.round(nd.y) + '" r="' + _Avatar.round(nd.r) + '" fill="' + col + '"/>';
        if (!small) {
          s += '<circle cx="' + _Avatar.round(nd.x - nd.r * 0.32) + '" cy="' + _Avatar.round(nd.y - nd.r * 0.32) + '" r="' + _Avatar.round(nd.r * 0.32) + '" fill="#ffffff" opacity="0.6"/>';
        }
      }
      s += "</g></g>";
      return s;
    }
    // Hub: halo + gold core + specular (the focal anchor, fixed at center).
    core() {
      const { prim, small, uid } = this;
      const hub = this.nodes[0];
      const haloR = hub.r * (small ? 2 : 2.4);
      let s = '<circle class="cst-pulse" cx="' + _Avatar.CX + '" cy="' + _Avatar.CY + '" r="' + _Avatar.round(haloR) + '" fill="url(#halo_' + uid + ')"/>';
      s += '<g filter="url(#glow_' + uid + ')">';
      s += '<circle cx="' + _Avatar.CX + '" cy="' + _Avatar.CY + '" r="' + _Avatar.round(hub.r) + '" fill="url(#hub_' + uid + ')" stroke="' + _Avatar.hsla(prim, 26, 0.7) + '" stroke-width="0.6"/>';
      s += '<circle cx="' + _Avatar.round(_Avatar.CX - hub.r * 0.3) + '" cy="' + _Avatar.round(_Avatar.CY - hub.r * 0.34) + '" r="' + _Avatar.round(hub.r * 0.34) + '" fill="#ffffff" opacity="0.8"/>';
      s += "</g>";
      return s;
    }
    // Subtle gold rim (rounded square).
    rim() {
      return '<rect x="0.6" y="0.6" width="' + (_Avatar.VB - 1.2) + '" height="' + (_Avatar.VB - 1.2) + '" rx="23.5" ry="23.5" fill="none" stroke="' + _Avatar.hsl(this.prim, 9) + '" stroke-opacity="0.35" stroke-width="0.8"/>';
    }
  };
  // Gold-forward brand band: the per-identity hue is picked from here, so it stays on-brand.
  __publicField(_Avatar, "BAND", [
    { h: 35, s: 82, l: 51 },
    // deep-gold #e8941c (signature)
    { h: 38, s: 86, l: 65 },
    // amber #f2b65a
    { h: 28, s: 80, l: 56 },
    // warm orange
    { h: 205, s: 60, l: 56 },
    // blue #4aa3d6
    { h: 188, s: 56, l: 60 },
    // cyan #5ec8d8
    { h: 258, s: 58, l: 69 }
    // nebula-violet #9b7fe0
  ]);
  __publicField(_Avatar, "GOLD", "#e8941c");
  // 100x100 viewBox; the hub sits at its center, satellites on a fixed ring.
  __publicField(_Avatar, "VB", 100);
  __publicField(_Avatar, "CX", 50);
  __publicField(_Avatar, "CY", 50);
  __publicField(_Avatar, "RING_R", 33);
  let Avatar = _Avatar;
  root.constellationSvg = (identity, size) => new Avatar(identity, size).render();
  root.avatarSeed = Avatar.seed;
})(typeof window !== "undefined" ? window : globalThis);

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
const contentCache = /* @__PURE__ */ new Map();
async function loadContent(file) {
  if (file.content != null) return file.content;
  const cached = contentCache.get(file.path);
  if (cached != null) {
    file.content = cached;
    return cached;
  }
  if (IS_OFFLINE_BUILD) {
    const c = EMBED_CONTENT[file.path];
    if (c == null) throw new Error(t("offlineMissing"));
    contentCache.set(file.path, c);
    file.content = c;
    return c;
  }
  const url = "/" + file.path.split("/").map(encodeURIComponent).join("/") + (file.mtime ? "?v=" + file.mtime : "");
  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const text = await res.text();
  contentCache.set(file.path, text);
  file.content = text;
  return text;
}
let todos = [];
let notesIndex = null;
marked.setOptions({ gfm: true, breaks: false });
marked.use({
  renderer: {
    code({ text, lang }) {
      const language = (lang || "").trim().split(/\s+/)[0];
      let html;
      try {
        html = language && hljs.getLanguage(language) ? hljs.highlight(text, { language }).value : hljs.highlightAuto(text).value;
      } catch (e) {
        html = escapeHtml(text);
      }
      const cls = language ? " language-" + escapeHtml(language) : "";
      return '<pre><code class="hljs' + cls + '">' + html + "</code></pre>\n";
    }
  }
});
const WL_TARGET_EXTS = [".md", ".html", ".pdf", ".docx"];
let _wlMaps = null;
function wlMaps() {
  if (_wlMaps) return _wlMaps;
  const byPath = {};
  const byStem = {};
  for (const f of Object.values(fileMap)) {
    if (!WL_TARGET_EXTS.includes(f.ext)) continue;
    byPath[f.path.toLowerCase()] = f.path;
    const stem = f.name.replace(/\.[^.]+$/, "").toLowerCase();
    if (!(stem in byStem)) byStem[stem] = f.path;
  }
  _wlMaps = { byPath, byStem };
  return _wlMaps;
}
const _ContentTree = class _ContentTree {
  constructor() {
    // Open folders, keyed on the FULL dir path (homonym independence). Top-level dirs are seeded
    // open on every reload (force-open after an SSE rebuild); a plain rerender keeps a user's closes.
    __publicField(this, "openDirs", /* @__PURE__ */ new Set());
  }
  iconFor(ext) {
    return _ContentTree.ICONS[ext] || _ContentTree.FILE_ICON;
  }
  // Reload (boot / SSE rebuild): force the top-level dirs open, then render — a user's nested
  // toggles in openDirs are preserved.
  reload() {
    const children = TREE.type === "dir" ? TREE.children : [];
    for (const c of children) if (c.type === "dir") this.openDirs.add(c.name);
    this.rerender();
  }
  rerender() {
    render(this.treeView(TREE, 0, ""), treeEl);
  }
  treeView(node, depth, prefix) {
    const cls = depth === 0 ? "space-y-0.5" : "ml-3 border-l border-navy-600 pl-2 space-y-0.5 mt-0.5";
    let children = node.type === "dir" ? node.children : [];
    if (depth === 0) {
      const own = [];
      const remotes = [];
      for (const c of children) (c.type === "dir" && c.name === "remotes" ? remotes : own).push(c);
      children = own.concat(remotes);
    }
    return h("ul", { class: cls }, children.map((c) => c.type === "dir" ? this.dirView(c, depth, prefix) : this.fileView(c)));
  }
  dirView(child, depth, prefix) {
    const childPath = prefix ? prefix + "/" + child.name : child.name;
    const isRemoteRoot = childPath === "remotes";
    const isRemote = isRemoteRoot || childPath.startsWith("remotes/");
    const open = this.openDirs.has(childPath) || !!(currentFile && currentFile.path.startsWith(childPath + "/"));
    const dirLabel = isRemoteRoot ? t("remotesLabel") : child.name;
    const btnChildren = [
      h("span", { class: "caret text-xs text-ink-400" + (open ? " open" : "") }, raw("&#9656;")),
      raw(isRemoteRoot ? _ContentTree.REMOTE_FOLDER_ICON : _ContentTree.FOLDER_ICON),
      h("span", { class: "truncate min-w-0 flex-1", "data-name": child.name }, dirLabel)
    ];
    if (!isRemote) {
      btnChildren.push(
        h("span", { class: "dir-access-btn tree-action-btn", title: t("aclBtnTitle"), onClick: (e) => {
          e.stopPropagation();
          if (window.openAccessFor) window.openAccessFor(childPath);
        } }, raw(_ContentTree.ACL_ICON))
      );
    }
    btnChildren.push(
      h("span", { class: "dir-rename-btn tree-action-btn", title: t("renameFolder"), onClick: (e) => {
        e.stopPropagation();
        openDirRenameModal(childPath);
      } }, raw(_ContentTree.PENCIL_ICON))
    );
    if (!isRemote) {
      btnChildren.push(
        h("span", { class: "dir-share-btn tree-action-btn tree-action-btn--share", title: t("shareAsNode"), onClick: (e) => {
          e.stopPropagation();
          openPublishNode(childPath);
        } }, raw(_ContentTree.LINK_ICON))
      );
    }
    const btn = h("button", {
      class: "tree-item group w-full text-left px-2 py-1.5 rounded flex items-center gap-2 font-semibold text-ink-100" + (isRemote ? " tree-remote" : ""),
      "data-dir-path": childPath,
      onClick: () => this.toggleDir(childPath)
    }, btnChildren);
    const sub = this.treeView(child, depth + 1, childPath);
    if (!open) sub.props.class += " hidden";
    return h("li", { key: "d:" + childPath, class: isRemoteRoot ? "tree-section--remotes" : null }, btn, sub);
  }
  fileView(child) {
    const isRemoteFile = child.path.startsWith("remotes/");
    const openable = child.ext === ".md" || child.ext === ".html" || child.ext === ".pdf" || child.ext === ".docx";
    const fileActionable = !isRemoteFile && (child.ext === ".md" || child.ext === ".html");
    const aChildren = [
      raw(this.iconFor(child.ext)),
      h("span", { class: "truncate min-w-0 flex-1 leading-snug", "data-name": child.name }, child.name),
      this.visBadge(child)
    ];
    if (fileActionable) {
      aChildren.push(
        h("span", { class: "file-access-btn tree-action-btn", title: t("aclBtnTitle"), onClick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (window.openAccessFor) window.openAccessFor(child.path);
        } }, raw(_ContentTree.ACL_ICON)),
        h("span", { class: "file-rename-btn tree-action-btn", title: t("renameFile"), onClick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          showMarkdown(child);
          openRenameModal("rename");
        } }, raw(_ContentTree.PENCIL_ICON)),
        h("span", { class: "file-share-btn tree-action-btn tree-action-btn--share", title: t("shareAsNode"), onClick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          openPublishNode(child.path);
        } }, raw(_ContentTree.LINK_ICON))
      );
    }
    const props = {
      key: "f:" + child.path,
      class: "tree-item group w-full px-2 py-1.5 rounded flex items-start gap-2 cursor-pointer text-ink-200" + (isRemoteFile ? " tree-remote" : ""),
      "data-path": child.path
    };
    if (currentFile && child.path === currentFile.path) props.class += " active";
    if (openable) {
      props.onClick = (e) => {
        e.preventDefault();
        showMarkdown(child);
        history.replaceState(null, "", "#" + encodeURIComponent(child.path));
      };
    } else {
      props.href = encodeURI(child.path);
    }
    return h("li", { key: "l:" + child.path }, h("a", props, aChildren));
  }
  visBadge(child) {
    const color = child.vis === "private" ? "rgba(251,191,36,.85)" : child.vis === "shared" ? "rgba(56,189,248,.85)" : child.vis === "granted" ? "rgba(52,211,153,.9)" : null;
    if (!color) return null;
    const titleKey = child.vis === "private" ? "visPrivate" : child.vis === "shared" ? "visShared" : "visGranted";
    return h("span", { class: "flex-shrink-0 mt-1.5 w-1.5 h-1.5 rounded-full", style: "background-color:" + color, title: t(titleKey) });
  }
  toggleDir(path) {
    if (this.openDirs.has(path)) this.openDirs.delete(path);
    else this.openDirs.add(path);
    this.rerender();
  }
  // Toolbar #tree-toggle-all: collapse everything if anything is open, else expand all.
  toggleAll() {
    if (this.openDirs.size === 0) {
      const all = [];
      const walk = (node, prefix) => {
        const children = node.type === "dir" ? node.children : [];
        for (const c of children) {
          if (c.type !== "dir") continue;
          const p = prefix ? prefix + "/" + c.name : c.name;
          all.push(p);
          walk(c, p);
        }
      };
      walk(TREE, "");
      this.openDirs = new Set(all);
    } else {
      this.openDirs.clear();
    }
    this.rerender();
  }
  // Under each mirror (remotes/<name>), show which atlas it comes from. Admin-only → silent.
  async decorateRemoteOrigins() {
    let remotes;
    try {
      const resp = await fetch("/api/admin/remotes", { headers: { Accept: "application/json" } });
      if (!resp.ok) return;
      remotes = await resp.json();
    } catch (_) {
      return;
    }
    if (!Array.isArray(remotes)) return;
    for (const r of remotes) {
      const host = (r.url || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      if (!host) continue;
      const sel = 'button[data-dir-path="remotes/' + (window.CSS && CSS.escape ? CSS.escape(r.name) : r.name) + '"]';
      const btn = treeEl.querySelector(sel);
      if (!btn || btn.querySelector(".tree-remote-origin")) continue;
      const span = document.createElement("span");
      span.className = "tree-remote-origin";
      span.textContent = host;
      span.title = r.url || "";
      btn.insertBefore(span, btn.querySelector(".dir-rename-btn"));
    }
  }
};
__publicField(_ContentTree, "ICONS", {
  ".md": '<svg class="w-4 h-4 text-sky-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>',
  ".pdf": '<svg class="w-4 h-4 text-rose-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>',
  ".pptx": '<svg class="w-4 h-4 text-orange-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"/></svg>',
  ".html": '<svg class="w-4 h-4 text-purple-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/></svg>',
  ".docx": '<svg class="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>'
});
__publicField(_ContentTree, "FOLDER_ICON", '<svg class="w-4 h-4 text-[#fbc678] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/></svg>');
__publicField(_ContentTree, "REMOTE_FOLDER_ICON", '<svg class="w-4 h-4 text-[#59d0cf] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.933-2.185 2.25 2.25 0 0 0-3.933 2.185Z"/></svg>');
__publicField(_ContentTree, "LINK_ICON", '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="w-3.5 h-3.5"><path stroke-linecap="round" stroke-linejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244"/></svg>');
__publicField(_ContentTree, "PENCIL_ICON", '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="w-3.5 h-3.5"><path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.862 4.487Z"/></svg>');
__publicField(_ContentTree, "FILE_ICON", '<svg class="w-4 h-4 text-ink-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>');
__publicField(_ContentTree, "ACL_ICON", '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"/></svg>');
let ContentTree = _ContentTree;
const contentTree = new ContentTree();
(function() {
  const btn = document.getElementById("tree-toggle-all");
  if (!btn) return;
  btn.dataset.tip = t("expandAllFolders");
  btn.setAttribute("aria-label", t("expandAllFolders"));
  btn.addEventListener("click", () => contentTree.toggleAll());
})();
if (IS_OFFLINE_BUILD) {
  contentTree.reload();
  decorateTreeBadges();
  contentTree.decorateRemoteOrigins();
}

class Markdown {
  constructor() {
    marked.use({ extensions: [this.wikilinkExtension()] });
  }
  // marked leaves raw HTML intact — a doc with <script>/<img onerror> would run in the innerHTML.
  // The output goes through DOMPurify (vendored, inlined in the offline build); if it is missing
  // that is a build bug, so show an error and NEVER render unsanitised HTML.
  render(md) {
    if (typeof DOMPurify === "undefined") {
      console.error("DOMPurify absent : asset /vendor/purify.min.js manquant (bug de build).");
      return '<p class="text-red-400 font-sans">' + escapeHtml(t("sanitizerMissing")) + "</p>";
    }
    return DOMPurify.sanitize(marked.parse(md || ""));
  }
  // [[target]] / [[target|text]] → a navigable link (.broken when unresolved). Inline token, so it
  // is ignored inside code blocks.
  wikilinkExtension() {
    return {
      name: "wikilink",
      level: "inline",
      start: (src) => src.indexOf("[["),
      tokenizer: (src) => {
        const m = /^\[\[([^\[\]\n]+?)\]\]/.exec(src);
        return m ? { type: "wikilink", raw: m[0], target: m[1].trim() } : void 0;
      },
      renderer: (token) => {
        const parts = token.target.split("|");
        const label = (parts[1] || parts[0]).trim();
        const path = this.resolveWikilink(parts[0].trim());
        if (path) return '<a class="wikilink" data-path="' + escapeHtml(path) + '">' + escapeHtml(label) + "</a>";
        return '<a class="wikilink broken" title="' + escapeHtml(t("brokenLink", parts[0].trim())) + '">' + escapeHtml(label) + "</a>";
      }
    };
  }
  resolveWikilink(target) {
    const { byPath, byStem } = wlMaps();
    const norm = target.split("|")[0].trim().toLowerCase();
    if (!norm) return null;
    for (const ext of ["", ...WL_TARGET_EXTS]) {
      if (byPath[norm + ext]) return byPath[norm + ext];
    }
    const stem = norm.split("/").pop().replace(/\.[^.]+$/, "");
    return byStem[stem] || null;
  }
}
const markdown = new Markdown();
function renderMd(md) {
  return markdown.render(md);
}

function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h << 5) + h + s.charCodeAt(i) >>> 0;
  return h;
}
function renderSkeleton(file) {
  let state = (file && file.path ? hashStr(file.path) : 1) || 1;
  const next = () => state = state * 1664525 + 1013904223 >>> 0;
  const range = (min, max) => min + next() % (max - min + 1);
  const coin = (p) => next() % 100 < p * 100;
  const parts = [];
  const para = (lines) => {
    const rows = [];
    for (let i = 0; i < lines; i++) {
      const isLast = i === lines - 1;
      const isPenult = i === lines - 2;
      let w;
      if (isLast) w = range(35, 70);
      else if (isPenult && coin(0.4)) w = range(78, 94);
      else w = range(95, 100);
      rows.push('<div class="skeleton" style="height:.95rem;width:' + w + '%;"></div>');
    }
    return '<div style="display:flex;flex-direction:column;gap:.55rem;margin-bottom:1.75rem;">' + rows.join("") + "</div>";
  };
  const h2 = () => '<div class="skeleton-h2" style="height:1.6rem;width:' + range(28, 58) + '%;margin-bottom:1rem;margin-top:.5rem;"></div>';
  const code = () => '<div class="skeleton-code" style="height:' + range(4, 9) + 'rem;margin-bottom:1.75rem;"></div>';
  parts.push(
    '<div class="skeleton-title" style="height:2.4rem;width:' + range(48, 78) + '%;margin-bottom:1rem;"></div>'
  );
  parts.push(
    '<div style="display:flex;gap:.5rem;margin-bottom:2rem;"><div class="skeleton" style="height:.7rem;width:' + range(5, 9) + 'rem;"></div><div class="skeleton" style="height:.7rem;width:' + range(4, 7) + 'rem;"></div></div>'
  );
  parts.push(para(range(3, 5)));
  const sections = range(1, 3);
  for (let s = 0; s < sections; s++) {
    parts.push(h2());
    parts.push(para(range(2, 5)));
    if (coin(0.4)) parts.push(code());
  }
  return '<div class="not-prose" aria-busy="true" aria-label="' + t("loadingDoc") + '">' + parts.join("") + "</div>";
}

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
const _TaskMarkers = class _TaskMarkers {
  // Flipping the Nth rendered checkbox flips the Nth source marker, so the count must mirror marked
  // exactly: skip fenced-code tasks (no checkbox), count blockquoted ones, detect fences only
  // outside blockquotes (a fence nested in a blockquote is not honoured here).
  static toggleNthTaskMarker(content, index, checked) {
    const lines = content.split("\n");
    let n = -1;
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
      const [unquoted, quoted] = _TaskMarkers.stripBlockquote(lines[i]);
      if (!quoted && _TaskMarkers.FENCE_RE.test(lines[i].trimStart())) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      if (!_TaskMarkers.TASK_MARK_RE.test(unquoted)) continue;
      n++;
      if (n === index) {
        const prefix = lines[i].slice(0, lines[i].length - unquoted.length);
        lines[i] = prefix + unquoted.replace(_TaskMarkers.TASK_MARK_RE, "$1" + (checked ? "x" : " ") + "$3");
        return lines.join("\n");
      }
    }
    return null;
  }
  static stripBlockquote(line) {
    let s = line;
    let quoted = false;
    while (_TaskMarkers.BQ_RE.test(s)) {
      s = s.replace(_TaskMarkers.BQ_RE, "");
      quoted = true;
    }
    return [s, quoted];
  }
};
__publicField(_TaskMarkers, "TASK_MARK_RE", /^(\s*(?:[-*+]|\d+\.)\s+\[)([ xX])(\])/);
__publicField(_TaskMarkers, "FENCE_RE", /^(?:`{3,}|~{3,})/);
__publicField(_TaskMarkers, "BQ_RE", /^\s*>[ \t]?/);
let TaskMarkers = _TaskMarkers;
function toggleNthTaskMarker(content, index, checked) {
  return TaskMarkers.toggleNthTaskMarker(content, index, checked);
}

class Toc {
  // Build the right-panel TOC from the rendered h2/h3 (<2 headings → hide it); anchors smooth-scroll.
  buildToc() {
    tocList.innerHTML = "";
    const headings = contentEl.querySelectorAll("h2, h3");
    if (headings.length < 2) {
      tocList.classList.add("hidden");
      if (typeof applyToc === "function") applyToc();
      else {
        tocPanel.classList.add("hidden");
        tocPanel.classList.remove("flex");
      }
      return;
    }
    tocList.classList.remove("hidden");
    const used = /* @__PURE__ */ new Set();
    headings.forEach((heading) => {
      let id = slugify(heading.textContent || "");
      let base = id, n = 2;
      while (used.has(id)) {
        id = base + "-" + n;
        n++;
      }
      used.add(id);
      heading.id = id;
      const a = document.createElement("a");
      a.href = "#" + id;
      a.textContent = heading.textContent;
      a.className = "block px-2 py-1 rounded hover:bg-white/5 text-ink-300 hover:text-accent truncate " + (heading.tagName === "H3" ? "pl-5 text-[11px] text-ink-400" : "font-medium");
      a.addEventListener("click", (e) => {
        e.preventDefault();
        document.getElementById(id).scrollIntoView({ behavior: "smooth", block: "start" });
      });
      tocList.appendChild(a);
    });
    if (typeof applyToc === "function") applyToc();
    else {
      tocPanel.classList.remove("hidden");
      tocPanel.classList.add("flex");
    }
  }
}
const toc = new Toc();
function buildToc() {
  toc.buildToc();
}
function readingTimeFromWords(words) {
  if (!words) return null;
  const minutes = Math.max(1, Math.round(words / 220));
  return { words, minutes };
}

class TaskCheckboxes {
  // Make the rendered task checkboxes writable; each toggle flips its source marker and commits.
  wireTaskCheckboxes(file, fullContent) {
    if (!isServerMode || window.__viewerMode) return;
    const boxes = contentEl.querySelectorAll('input[type="checkbox"]');
    if (!boxes.length) return;
    let docContent = fullContent;
    boxes.forEach((box, index) => {
      box.disabled = false;
      box.style.cursor = "pointer";
      box.addEventListener("change", () => {
        const desired = box.checked;
        const newContent = toggleNthTaskMarker(docContent, index, desired);
        if (newContent == null) {
          box.checked = !desired;
          return;
        }
        const prev = docContent;
        docContent = newContent;
        contentCache.set(file.path, newContent);
        if (currentFile && currentFile.path === file.path) currentFile.content = newContent;
        sse.muteSelfSave(file.path);
        const li = box.closest("li");
        let taskText = "";
        if (li) {
          const clone = li.cloneNode(true);
          clone.querySelectorAll("ul, ol").forEach((n) => n.remove());
          taskText = (clone.textContent || "").replace(/\s+/g, " ").trim();
        }
        const body = {
          path: file.path,
          content: newContent,
          task: { text: taskText, checked: desired }
        };
        const write = fetch("/api/file", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        }).then((res) => {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.json();
        }).then((data) => {
          if (currentFile && currentFile.path === file.path && data.mtime)
            currentFile.mtime = data.mtime;
        }).catch((e) => {
          docContent = prev;
          contentCache.set(file.path, prev);
          if (currentFile && currentFile.path === file.path) currentFile.content = prev;
          box.checked = !desired;
          notifyError("err", e.message);
        });
        sse.trackTaskWrite(write);
      });
    });
  }
}
const taskCheckboxes = new TaskCheckboxes();
function wireTaskCheckboxes(file, fullContent) {
  taskCheckboxes.wireTaskCheckboxes(file, fullContent);
}

function attachCopyButtons() {
  contentEl.querySelectorAll("pre").forEach((pre) => {
    if (pre.querySelector(".copy-btn")) return;
    pre.style.position = "relative";
    const btn = document.createElement("button");
    btn.className = "copy-btn absolute top-2 right-2 opacity-0 transition-opacity px-2 py-1 text-[11px] bg-white/8 hover:bg-white/15 text-ink-300 hover:text-white rounded font-mono";
    btn.innerHTML = '<svg class="w-3 h-3 inline mr-1 -mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>' + t("copy");
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      const codeEl = pre.querySelector("code");
      const code = (codeEl ? codeEl.textContent : pre.textContent) ?? "";
      try {
        await navigator.clipboard.writeText(code);
        btn.innerHTML = '<svg class="w-3 h-3 inline mr-1 -mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>' + t("copied");
        btn.classList.add("text-emerald-400");
        setTimeout(() => {
          btn.innerHTML = '<svg class="w-3 h-3 inline mr-1 -mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>' + t("copy");
          btn.classList.remove("text-emerald-400");
        }, 1500);
      } catch (e2) {
      }
    });
    pre.appendChild(btn);
    pre.addEventListener("mouseenter", () => btn.style.opacity = "1");
    pre.addEventListener("mouseleave", () => btn.style.opacity = "0");
  });
}
function highlightFirstMatch(container, query) {
  const tokens = query.trim().split(/\s+/).filter((tok) => tok.length >= 2).map((tok) => tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!tokens.length) return;
  const re = new RegExp("(" + tokens.join("|") + ")", "i");
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => n.nodeValue && re.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
  });
  const node = walker.nextNode();
  if (!node) return;
  const value = node.nodeValue;
  if (value == null) return;
  const m = value.match(re);
  if (!m) return;
  const after = node.splitText(m.index);
  after.nodeValue = after.nodeValue.slice(m[0].length);
  const mark = document.createElement("mark");
  mark.className = "search-hit";
  mark.textContent = m[0];
  after.parentNode.insertBefore(mark, after);
  mark.scrollIntoView({ behavior: "smooth", block: "center" });
}

let backlinksIndex = null;
let backlinksLoading = null;
async function loadBacklinksIndex() {
  if (backlinksIndex) return backlinksIndex;
  if (backlinksLoading) return backlinksLoading;
  backlinksLoading = (async () => {
    if (IS_OFFLINE_BUILD) {
      backlinksIndex = EMBED_BACKLINKS || {};
    } else {
      try {
        const res = await fetch("/_backlinks.json", { cache: "no-cache" });
        backlinksIndex = res.ok ? await res.json() : {};
      } catch (e) {
        backlinksIndex = {};
      }
    }
    return backlinksIndex;
  })();
  return backlinksLoading;
}
async function renderBacklinksFor(file) {
  tocHasLinks = false;
  if (tocLinks) {
    tocLinks.innerHTML = "";
    tocLinks.classList.remove("border-t", "panel-divider");
  }
  const idx = await loadBacklinksIndex();
  if (currentFile !== file) return;
  const entry = idx[file.path] || { out: [], in: [] };
  const resolve = (paths) => (paths || []).map((p) => fileMap[p]).filter((f) => !!f);
  const incoming = resolve(entry.in);
  const outgoing = resolve(entry.out);
  const tagSet = new Set(file.tags || []);
  const shared = (f) => (f.tags || []).filter((tg) => tagSet.has(tg)).length;
  const related = tagSet.size ? Object.values(fileMap).filter((f) => f.ext === ".md" && f.path !== file.path && shared(f) > 0).sort((a, b) => shared(b) - shared(a) || (b.mtime || 0) - (a.mtime || 0)).slice(0, 8) : [];
  tocHasLinks = !!(incoming.length || outgoing.length || related.length);
  tocLinks.classList.toggle("hidden", !tocHasLinks);
  if (!tocHasLinks) {
    applyToc();
    return;
  }
  const card = (f) => '<a class="block px-2 py-1 rounded hover:bg-white/5 text-ink-300 hover:text-accent cursor-pointer truncate" data-conn="' + escapeHtml(f.path) + '" title="' + escapeHtml(f.path) + '">' + escapeHtml(f.name) + "</a>";
  const group = (title, items) => items.length ? '<div class="mt-2"><div class="px-2 pb-0.5 text-[10px] uppercase tracking-[0.1em] text-ink-500 font-bold">' + title + "</div>" + items.map(card).join("") + "</div>" : "";
  tocLinks.classList.add("border-t", "panel-divider");
  tocLinks.innerHTML = '<div class="px-2 pb-1 text-[10px] uppercase tracking-[0.12em] text-accent font-bold">' + t("linksTitle") + "</div>" + group(t("referencedBy", incoming.length), incoming) + group(t("outgoingLinks", outgoing.length), outgoing) + group(t("sameTopic", related.length), related);
  tocLinks.querySelectorAll("[data-conn]").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const f = fileMap[a.dataset.conn];
      if (f) {
        showMarkdown(f);
        history.replaceState(null, "", "#" + encodeURIComponent(f.path));
      }
    });
  });
  applyToc();
}

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
const _NoteAnchor = class _NoteAnchor {
  // captured prefix/suffix context length
  // Global text offset of a (node, offset) within contentEl, by walking the text nodes. -1 if the
  // node isn't under contentEl.
  textOffsetOf(node, offset) {
    if (!contentEl.contains(node)) return -1;
    const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT);
    let acc = 0;
    let n;
    while (n = walker.nextNode()) {
      if (n === node) return acc + offset;
      acc += n.nodeValue.length;
    }
    return -1;
  }
  // Builds a text-quote anchor from the current selection.
  selectionToAnchor() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const r = sel.getRangeAt(0);
    if (!contentEl.contains(r.commonAncestorContainer)) return null;
    const start = this.textOffsetOf(r.startContainer, r.startOffset);
    const end = this.textOffsetOf(r.endContainer, r.endOffset);
    if (start < 0 || end < 0 || end <= start) return null;
    const full = contentEl.textContent || "";
    const exact = full.slice(start, end);
    if (!exact.trim()) return null;
    return {
      exact,
      prefix: full.slice(Math.max(0, start - _NoteAnchor.CTX_LEN), start),
      suffix: full.slice(end, end + _NoteAnchor.CTX_LEN),
      pos: start
    };
  }
  // Re-locates an anchor in the current text → {start, end} or null (orphan). Searches all
  // occurrences of `exact`, scores by prefix/suffix context and proximity to `pos`, keeps the best.
  locateAnchor(a) {
    const full = contentEl.textContent || "";
    if (!a.exact) return null;
    const idxs = [];
    let i = full.indexOf(a.exact);
    while (i !== -1) {
      idxs.push(i);
      i = full.indexOf(a.exact, i + 1);
    }
    if (!idxs.length) return null;
    let best = idxs[0];
    let bestScore = -Infinity;
    for (const s of idxs) {
      let score = 0;
      const before = full.slice(Math.max(0, s - _NoteAnchor.CTX_LEN), s);
      const after = full.slice(s + a.exact.length, s + a.exact.length + _NoteAnchor.CTX_LEN);
      if (a.prefix && before.endsWith(a.prefix)) score += 100;
      else if (a.prefix) {
        let k = 0;
        while (k < a.prefix.length && before[before.length - 1 - k] === a.prefix[a.prefix.length - 1 - k])
          k++;
        score += k;
      }
      if (a.suffix && after.startsWith(a.suffix)) score += 100;
      else if (a.suffix) {
        let k = 0;
        while (k < a.suffix.length && after[k] === a.suffix[k]) k++;
        score += k;
      }
      score -= Math.abs(s - (a.pos || 0)) / 1e3;
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    return { start: best, end: best + a.exact.length };
  }
  // Wraps the global text range [start,end) in <mark> (one per traversed text node), with data-* +
  // click handler. Injected AFTER DOMPurify, so the note text never goes through markdown rendering.
  // onMarkClick fires when a painted <mark> is clicked; the panel routes it to the popover.
  highlightRange(start, end, note, onMarkClick) {
    const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT);
    let acc = 0;
    let n;
    const todo = [];
    while (n = walker.nextNode()) {
      const len = n.nodeValue.length;
      const ns = acc;
      const ne = acc + len;
      if (ne > start && ns < end) {
        todo.push({ node: n, from: Math.max(0, start - ns), to: Math.min(len, end - ns) });
      }
      acc = ne;
      if (ns >= end) break;
    }
    for (const seg of todo) {
      let node = seg.node;
      if (seg.to < node.nodeValue.length) node.splitText(seg.to);
      if (seg.from > 0) node = node.splitText(seg.from);
      const mark = document.createElement("mark");
      mark.className = "kb-annot";
      mark.dataset.noteId = note.id;
      node.parentNode.insertBefore(mark, node);
      mark.appendChild(node);
      mark.addEventListener("click", (e) => {
        e.stopPropagation();
        onMarkClick(note, mark);
      });
    }
    return todo.length > 0;
  }
};
__publicField(_NoteAnchor, "CTX_LEN", 60);
let NoteAnchor = _NoteAnchor;
const noteAnchor = new NoteAnchor();

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
const noteContext = { notesForDoc: [] };
const _NotesPanel = class _NotesPanel {
  async renderNotesFor(file) {
    tocHasNotes = false;
    if (tocNotes) {
      tocNotes.innerHTML = "";
      tocNotes.classList.remove("border-t", "panel-divider");
    }
    noteContext.notesForDoc = [];
    const notes = await notesStore.fetchNotes(file);
    if (currentFile !== file) return;
    noteContext.notesForDoc = notes;
    if (!notes.length) {
      applyToc();
      return;
    }
    notes.forEach((note) => {
      const loc = noteAnchor.locateAnchor(note);
      note._orphan = !(loc && noteAnchor.highlightRange(
        loc.start,
        loc.end,
        note,
        (n, mark) => notePopover.openNotePopForExisting(n, mark)
      ));
    });
    this.renderNotesPanel();
  }
  renderNotesPanel() {
    tocHasNotes = noteContext.notesForDoc.length > 0;
    tocNotes.classList.toggle("hidden", !tocHasNotes);
    if (!tocHasNotes) {
      applyToc();
      return;
    }
    const row = (note) => {
      const by = note.author ? "✍ " + escapeHtml(String(note.author).split("@")[0]) : "";
      const when = note.created ? relativeDate(note.created) : "";
      const byline = [by, when].filter(Boolean).join(" · ");
      return '<button class="kb-note-row' + (note._orphan ? " kb-orphan" : "") + '" data-note-id="' + escapeHtml(note.id) + '"><span class="kb-note-snip">' + escapeHtml(note.note.length > 90 ? note.note.slice(0, 90) + "…" : note.note) + '</span><span class="kb-note-meta">' + (note._orphan ? t("orphanShort") : "“" + escapeHtml(note.exact.length > 40 ? note.exact.slice(0, 40) + "…" : note.exact) + "”") + "</span>" + (byline ? '<span class="kb-note-meta" style="opacity:.65">' + byline + "</span>" : "") + "</button>";
    };
    tocNotes.classList.add("border-t", "panel-divider");
    tocNotes.innerHTML = '<div class="px-2 pb-1 flex items-center justify-between gap-2"><span class="text-[10px] uppercase tracking-[0.12em] text-amber-300 font-bold">' + t("notesTitle", noteContext.notesForDoc.length) + '</span><button id="toc-notes-copy" class="p-0.5 -mr-0.5 text-ink-500 hover:text-amber-300 rounded hover:bg-white/5 flex-shrink-0" title="' + escapeHtml(t("copyAllNotes")) + '">' + _NotesPanel.NOTES_COPY_ICON + "</button></div>" + noteContext.notesForDoc.map(row).join("");
    const copyBtn = tocNotes.querySelector("#toc-notes-copy");
    if (copyBtn)
      copyBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        notesStore.copyAllNotes(copyBtn);
      });
    tocNotes.querySelectorAll("[data-note-id]").forEach((el) => {
      el.addEventListener("click", () => {
        const note = noteContext.notesForDoc.find((n) => n.id === el.dataset.noteId);
        if (!note) return;
        const mark = contentEl.querySelector(
          'mark.kb-annot[data-note-id="' + CSS.escape(note.id) + '"]'
        );
        if (mark) {
          mark.scrollIntoView({ behavior: "smooth", block: "center" });
          notePopover.openNotePopForExisting(note, mark);
        } else notePopover.openNotePopForExisting(note, el);
      });
    });
    applyToc();
  }
};
__publicField(_NotesPanel, "NOTES_COPY_ICON", '<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184"/></svg>');
let NotesPanel = _NotesPanel;
const notesPanel = new NotesPanel();
function renderNotesFor(file) {
  return notesPanel.renderNotesFor(file);
}

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
class NotePopover {
  constructor() {
    // Anchor being created (selection -> popover), null when the create popover is closed.
    __publicField(this, "pendingAnchor", null);
    // selectionchange debounce handle.
    __publicField(this, "selTimer", null);
    // Anchor + rect captured at selection time, so the "Note" button tap works after the selection
    // collapses (mobile) — was stashed on the DOM node (noteAddBtn._anchor/_rect) before.
    __publicField(this, "pendingButtonAnchor", null);
    __publicField(this, "pendingButtonRect", null);
    // Stateful islands: the floating "Note" button + the popover. Guaranteed by the viewer markup.
    __publicField(this, "noteAddBtn", document.getElementById("kb-note-add"));
    __publicField(this, "notePop", document.getElementById("kb-note-pop"));
    contentEl.addEventListener("mouseup", () => setTimeout(() => this.updateNoteButton(), 10));
    document.addEventListener("selectionchange", () => {
      if (this.selTimer) clearTimeout(this.selTimer);
      this.selTimer = setTimeout(() => this.updateNoteButton(), 350);
    });
    this.noteAddBtn.addEventListener("click", () => this.triggerNoteCreate());
    this.noteAddBtn.addEventListener("touchend", (e) => {
      e.preventDefault();
      this.triggerNoteCreate();
    });
    document.addEventListener("mousedown", (e) => this.maybeCloseOutside(e));
    document.addEventListener("touchstart", (e) => this.maybeCloseOutside(e), { passive: true });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        this.closeNotePop();
        this.noteAddBtn.style.display = "none";
      }
    });
  }
  // Notes are the (deferred) comment level — admin-only for now. A member has the `viewer-mode`
  // body class (but writes its own docs), so gate notes on the class.
  notesCanEdit() {
    return !IS_OFFLINE_BUILD && !document.body.classList.contains("viewer-mode");
  }
  // ─── Popover create / read-edit ──────────────────────────────────────────
  positionPop(el, anchorRect) {
    const margin = 8;
    let top = window.scrollY + anchorRect.bottom + margin;
    let left = window.scrollX + anchorRect.left;
    el.style.display = "block";
    const w = el.offsetWidth;
    const ph = el.offsetHeight;
    if (left + w > window.scrollX + document.documentElement.clientWidth - margin)
      left = window.scrollX + document.documentElement.clientWidth - w - margin;
    if (anchorRect.bottom + margin + ph > document.documentElement.clientHeight)
      top = window.scrollY + anchorRect.top - ph - margin;
    el.style.top = Math.max(window.scrollY + margin, top) + "px";
    el.style.left = Math.max(margin, left) + "px";
  }
  closeNotePop() {
    this.notePop.style.display = "none";
    this.notePop.innerHTML = "";
    this.pendingAnchor = null;
    contentEl.querySelectorAll("mark.kb-annot.kb-annot-active").forEach((m) => m.classList.remove("kb-annot-active"));
  }
  openNotePopForNew(anchor, rect) {
    this.pendingAnchor = anchor;
    this.notePop.innerHTML = '<div class="kb-quote">“' + escapeHtml(anchor.exact.length > 160 ? anchor.exact.slice(0, 160) + "…" : anchor.exact) + '”</div><textarea placeholder="' + escapeHtml(t("notePlaceholder")) + '"></textarea><div class="kb-pop-actions"><button class="kb-btn-ghost" data-act="cancel">' + t("cancel") + '</button><button class="kb-btn-save" data-act="save">' + t("save") + "</button></div>";
    this.positionPop(this.notePop, rect);
    const ta = this.notePop.querySelector("textarea");
    ta.focus();
    this.notePop.querySelector('[data-act="cancel"]').onclick = () => this.closeNotePop();
    this.notePop.querySelector('[data-act="save"]').onclick = () => notesStore.saveNewNote(this.pendingAnchor, ta.value);
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) notesStore.saveNewNote(this.pendingAnchor, ta.value);
    });
  }
  openNotePopForExisting(note, anchorEl) {
    this.closeNotePop();
    contentEl.querySelectorAll('mark.kb-annot[data-note-id="' + CSS.escape(note.id) + '"]').forEach((m) => m.classList.add("kb-annot-active"));
    const canEdit = this.notesCanEdit();
    const created = note.created ? relativeDate(note.created) : "";
    const by = note.author ? "✍ " + escapeHtml(String(note.author).split("@")[0]) : "";
    const meta = [by, created].filter(Boolean).join(" · ");
    this.notePop.innerHTML = (note._orphan ? '<div class="kb-quote">' + t("orphanLong", escapeHtml(note.exact.slice(0, 120))) + "</div>" : "") + (canEdit ? "<textarea>" + escapeHtml(note.note) + "</textarea>" : '<div style="font-size:0.82rem;color:#e7e7ec;white-space:pre-wrap">' + escapeHtml(note.note) + "</div>") + (meta ? '<div class="kb-note-meta" style="font-size:0.66rem;color:#6b7280;margin-top:0.5rem">' + meta + "</div>" : "") + '<div class="kb-pop-actions">' + (canEdit ? '<button class="kb-btn-del" data-act="del">' + t("del") + "</button>" : "") + '<button class="kb-btn-ghost" data-act="cancel">' + t("close") + "</button>" + (canEdit ? '<button class="kb-btn-save" data-act="save">' + t("save") + "</button>" : "") + "</div>";
    this.positionPop(this.notePop, anchorEl.getBoundingClientRect());
    this.notePop.querySelector('[data-act="cancel"]').onclick = () => this.closeNotePop();
    if (canEdit) {
      const ta = this.notePop.querySelector("textarea");
      ta.focus();
      this.notePop.querySelector('[data-act="save"]').onclick = () => notesStore.saveEditNote(note, ta.value);
      this.notePop.querySelector('[data-act="del"]').onclick = () => notesStore.deleteNote(note);
    }
  }
  // Text selection → floating "Note" button (edit mode only). We store the anchor + rect at
  // selection time, so the button tap doesn't need the selection to survive (on mobile the tap
  // collapses it).
  updateNoteButton() {
    if (!this.notesCanEdit() || editMode || this.notePop.style.display === "block" || !currentFile || currentFile.ext !== ".md") {
      this.noteAddBtn.style.display = "none";
      return;
    }
    const a = noteAnchor.selectionToAnchor();
    if (!a) {
      this.noteAddBtn.style.display = "none";
      return;
    }
    const rect = window.getSelection().getRangeAt(0).getBoundingClientRect();
    this.pendingButtonAnchor = a;
    this.pendingButtonRect = rect;
    this.noteAddBtn.style.display = "inline-flex";
    const bw = this.noteAddBtn.offsetWidth || 96;
    let left = window.scrollX + rect.left;
    const maxLeft = window.scrollX + document.documentElement.clientWidth - bw - 8;
    if (left > maxLeft) left = maxLeft;
    this.noteAddBtn.style.top = window.scrollY + rect.bottom + 8 + "px";
    this.noteAddBtn.style.left = Math.max(8, left) + "px";
  }
  triggerNoteCreate() {
    if (!this.pendingButtonAnchor) return;
    this.noteAddBtn.style.display = "none";
    this.openNotePopForNew(this.pendingButtonAnchor, this.pendingButtonRect);
  }
  maybeCloseOutside(e) {
    const target = e.target;
    if (!this.notePop.contains(target) && target !== this.noteAddBtn && !this.noteAddBtn.contains(target) && !target.closest("mark.kb-annot") && !target.closest(".kb-note-row")) {
      if (this.notePop.style.display === "block") this.closeNotePop();
      if (!target.closest("#content")) this.noteAddBtn.style.display = "none";
    }
  }
}
const notePopover = new NotePopover();

class NotesStore {
  async fetchNotes(file) {
    if (IS_OFFLINE_BUILD) return EMBED_NOTES && EMBED_NOTES[file.path] || [];
    try {
      const res = await fetch("/api/notes?path=" + encodeURIComponent(file.path), {
        cache: "no-cache"
      });
      return res.ok ? await res.json() : [];
    } catch (e) {
      return [];
    }
  }
  // Copies all notes of the current doc as markdown (quote + note) for sharing.
  async copyAllNotes(btn) {
    if (!noteContext.notesForDoc.length) return;
    const lines = [];
    const title = currentFile ? currentFile.name || currentFile.path : "";
    if (title) lines.push("# Notes — " + title, "");
    noteContext.notesForDoc.forEach((n) => {
      if (n.exact && !n._orphan) lines.push("> " + n.exact);
      lines.push(n.note);
      const meta = [];
      if (n.author) meta.push(String(n.author));
      if (n.created) meta.push(new Date(n.created * 1e3).toLocaleString(LANG));
      if (meta.length) lines.push("— " + meta.join(" · "));
      lines.push("");
    });
    await copyToClipboard(lines.join("\n").trim() + "\n");
    if (btn) {
      btn.classList.add("text-emerald-400");
      setTimeout(() => btn.classList.remove("text-emerald-400"), 1200);
    }
    setStatus(t("notesCopied", noteContext.notesForDoc.length), "ok");
  }
  async saveNewNote(anchor, text) {
    text = (text || "").trim();
    if (!text || !anchor || !currentFile) return;
    const body = Object.assign({ path: currentFile.path, note: text }, anchor);
    try {
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
    } catch (e) {
      notifyError("noteSaveFailed", e.message);
      return;
    }
    notePopover.closeNotePop();
    window.getSelection().removeAllRanges();
    this.refreshNotes();
  }
  async saveEditNote(note, text) {
    text = (text || "").trim();
    if (!text || !currentFile) return;
    try {
      const res = await fetch(
        "/api/notes?path=" + encodeURIComponent(currentFile.path) + "&id=" + encodeURIComponent(note.id),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ note: text })
        }
      );
      if (!res.ok) throw new Error("HTTP " + res.status);
    } catch (e) {
      notifyError("actionFailed", e.message);
      return;
    }
    notePopover.closeNotePop();
    this.refreshNotes();
  }
  async deleteNote(note) {
    if (!currentFile) return;
    const ok = await confirmDialog({
      title: t("deleteNoteTitle"),
      message: t("deleteNoteMsg", note.note.length > 80 ? note.note.slice(0, 80) + "…" : note.note),
      confirmLabel: t("del"),
      destructive: true
    });
    if (!ok) return;
    try {
      const res = await fetch(
        "/api/notes?path=" + encodeURIComponent(currentFile.path) + "&id=" + encodeURIComponent(note.id),
        { method: "DELETE" }
      );
      if (!res.ok) throw new Error("HTTP " + res.status);
    } catch (e) {
      notifyError("actionFailed", e.message);
      return;
    }
    notePopover.closeNotePop();
    this.refreshNotes();
  }
  // Full re-render of the current doc + live tree-badge update. We recount notes from the SOURCE
  // (/api/notes) because _notes-index.json is only regenerated at the next build — without this the
  // badge only appeared after a reload.
  async refreshNotes() {
    if (!currentFile) return;
    const path = currentFile.path;
    try {
      const res = await fetch("/api/notes?path=" + encodeURIComponent(path), { cache: "no-cache" });
      const list = res.ok ? await res.json() : null;
      if (Array.isArray(list)) {
        const idx = await loadNotesIndex();
        if (list.length) idx[path] = list.length;
        else delete idx[path];
        decorateTreeBadges();
      }
    } catch (_) {
    }
    showMarkdown(currentFile);
  }
}
const notesStore = new NotesStore();

async function loadNotesIndex() {
  if (notesIndex) return notesIndex;
  if (IS_OFFLINE_BUILD) {
    notesIndex = {};
    for (const p in EMBED_NOTES || {}) notesIndex[p] = EMBED_NOTES[p].length;
    return notesIndex;
  }
  try {
    const res = await fetch("/_notes-index.json", { cache: "no-cache" });
    notesIndex = res.ok ? await res.json() : {};
  } catch (e) {
    notesIndex = {};
  }
  return notesIndex;
}
async function decorateTreeBadges() {
  const idx = await loadNotesIndex();
  document.querySelectorAll(".kb-tree-badge").forEach((b) => b.remove());
  for (const path in idx) {
    const link = treeEl.querySelector('a[data-path="' + CSS.escape(path) + '"]');
    if (!link) continue;
    const badge = document.createElement("span");
    badge.className = "kb-tree-badge";
    badge.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="w-3 h-3"><path stroke-linecap="round" stroke-linejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 0 1 .865-.501 48.172 48.172 0 0 0 3.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z"/></svg><span>' + idx[path] + "</span>";
    badge.title = t("notesBadge", idx[path]);
    link.appendChild(badge);
  }
}

class DocRenderer {
  // THE document renderer that owns #content. Writes the skeleton, gates the breadcrumb chrome,
  // dispatches by extension (.html/.pdf/.docx → an isolated frame, else the markdown pipeline) and
  // fires the post-render hooks. async: a slow load is raced out by the currentFile !== file guards.
  async show(file, highlightQuery) {
    if (editMode) exitEditMode(false);
    currentFile = file;
    contentEl.style.maxWidth = "";
    contentEl.style.padding = "";
    document.getElementById("todo-widget")?.classList.remove("hidden");
    contentEl.innerHTML = renderSkeleton(file);
    breadcrumbPath.textContent = file.path.startsWith("remotes/") ? t("remotesLabel") + " / " + file.path.slice("remotes/".length) : file.path;
    const parts = [];
    if (file.mtime) parts.push(t("modifiedAgo", relativeDate(file.mtime)));
    const rt = readingTimeFromWords(file.words);
    if (rt) parts.push(t("readingTime", rt.minutes, rt.words.toLocaleString(LANG)));
    breadcrumbDate.textContent = parts.length ? "· " + parts.join(" · ") : "";
    breadcrumbActions.classList.remove("hidden");
    breadcrumbActions.classList.add("flex");
    const isRemoteDoc = (file.path || "").startsWith("remotes/");
    btnEdit.classList.toggle("hidden", isRemoteDoc);
    btnSave.classList.add("hidden");
    btnCancel.classList.add("hidden");
    document.getElementById("btn-share")?.classList.toggle("hidden", isRemoteDoc);
    document.getElementById("btn-access")?.classList.toggle("hidden", isRemoteDoc || IS_OFFLINE_BUILD);
    document.getElementById("btn-more-wrap")?.classList.toggle("hidden", isRemoteDoc);
    const sharedByEl = document.getElementById("breadcrumb-sharedby");
    if (sharedByEl) {
      sharedByEl.textContent = "";
      sharedByEl.title = "";
      if (location.protocol.startsWith("http") && !isRemoteDoc && !IS_OFFLINE_BUILD) {
        fetch("/api/acl?path=" + encodeURIComponent(file.path)).then((r) => r.ok ? r.json() : null).then((a) => {
          if (a && a.owner && !a.can_manage && currentFile && currentFile.path === file.path) {
            const who = String(a.owner).replace(/^user:/, "");
            sharedByEl.textContent = " " + t("sharedByLabel", who.split("@")[0]);
            sharedByEl.title = t("sharedByLabel", who);
          }
        }).catch(() => {
        });
      }
    }
    const showNodeActions = isRemoteDoc && !IS_OFFLINE_BUILD;
    document.getElementById("btn-node-appropriate")?.classList.toggle("hidden", !showNodeActions);
    document.getElementById("btn-node-remove")?.classList.toggle("hidden", !showNodeActions);
    const dlExt = document.getElementById("btn-download-ext");
    if (dlExt) dlExt.textContent = file.ext || "";
    closeHistory();
    document.getElementById("btn-history")?.classList.toggle("hidden", !historyAvailable(file));
    updatePinButton(file);
    contentTree.rerender();
    document.querySelector("main").scrollTop = 0;
    if (file.ext === ".html") {
      renderHtmlFrame(file);
      return;
    }
    if (file.ext === ".pdf") {
      renderPdfFrame(file);
      return;
    }
    if (file.ext === ".docx") {
      renderDocxFrame(file);
      return;
    }
    let content;
    try {
      content = await loadContent(file);
    } catch (e) {
      if (currentFile !== file) return;
      contentEl.innerHTML = '<div class="text-rose-400 text-sm">' + escapeHtml(t("loadError", e.message)) + "</div>";
      return;
    }
    if (currentFile !== file) return;
    const body = stripFrontmatter(content);
    contentEl.innerHTML = renderDocTags(file) + renderMd(body);
    attachCopyButtons();
    wireTaskCheckboxes(file, content);
    renderBacklinksFor(file);
    buildToc();
    renderNotesFor(file);
    document.dispatchEvent(
      new CustomEvent("atlas:doc-rendered", { detail: { path: file.path, markdown: body } })
    );
    if (highlightQuery) highlightFirstMatch(contentEl, highlightQuery);
  }
}
const docRenderer = new DocRenderer();
function showMarkdown(file, highlightQuery) {
  return docRenderer.show(file, highlightQuery);
}

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
const historyOverlay = document.getElementById("history-overlay");
const historyList = document.getElementById("history-list");
const historyDetail = document.getElementById("history-detail");
const historyPathEl = document.getElementById("history-path");
class HistoryPanel {
  constructor() {
    __publicField(this, "file", null);
    // AI-only filter state: showVersion always receives the FULL revisions array + the absolute index,
    // so the diff (parent = revisions[i+1]) stays correct when the list is filtered.
    __publicField(this, "allRevisions", []);
    __publicField(this, "aiOnly", false);
    __publicField(this, "currentSha", null);
  }
  // the revision shown in the detail pane (kept across a filter toggle)
  available(file) {
    const serverMode = location.protocol === "http:" || location.protocol === "https:";
    return !!file && (file.ext === ".md" || file.ext === ".html") && serverMode && !IS_OFFLINE_BUILD && !window.__viewerMode && !(file.path || "").startsWith("remotes/");
  }
  close() {
    this.file = null;
    historyOverlay.classList.add("hidden");
  }
  async open(file) {
    const target = file && typeof file.path === "string" ? file : currentFile;
    if (!this.available(target)) return;
    this.file = target;
    historyPathEl.textContent = target.path;
    historyList.innerHTML = '<div class="text-ink-500 px-2 py-1">…</div>';
    historyDetail.innerHTML = '<div class="text-ink-500">' + escapeHtml(t("historyPick")) + "</div>";
    historyOverlay.classList.remove("hidden");
    let data;
    try {
      data = await api("GET", "/api/history?path=" + encodeURIComponent(target.path));
    } catch (_) {
      if (this.file !== target) return;
      historyList.innerHTML = '<div class="text-rose-400 px-2 py-1">' + escapeHtml(t("historyError")) + "</div>";
      return;
    }
    if (this.file !== target) return;
    const revisions = data.revisions || [];
    if (!revisions.length) {
      historyList.innerHTML = '<div class="text-ink-500 px-2 py-1">' + escapeHtml(t("historyEmpty")) + "</div>";
      return;
    }
    this.allRevisions = revisions;
    this.aiOnly = false;
    this.currentSha = null;
    this.renderHistoryList(target);
  }
  formatRevDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return isNaN(d.getTime()) ? "" : d.toLocaleDateString(LANG, { day: "numeric", month: "short", year: "numeric" });
  }
  renderHistoryList(file) {
    const revisions = this.allRevisions;
    const hasAi = revisions.some((r) => r.ai);
    const shown = this.aiOnly ? revisions.filter((r) => r.ai) : revisions;
    historyList.innerHTML = "";
    if (hasAi) {
      const tg = document.createElement("button");
      tg.type = "button";
      tg.className = "flex items-center gap-1.5 w-full text-left px-2 py-1.5 mb-1.5 text-xs transition " + (this.aiOnly ? "text-accent" : "text-ink-400 hover:text-ink-200");
      tg.innerHTML = '<span style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:4px;font-size:10px;color:#fff;border:1.5px solid ' + (this.aiOnly ? "#1d9bd1" : "#5e6066") + ";background:" + (this.aiOnly ? "#1d9bd1" : "transparent") + '">' + (this.aiOnly ? "✓" : "") + "</span>" + escapeHtml(t("historyAiOnly")) + " seulement";
      tg.addEventListener("click", () => {
        this.aiOnly = !this.aiOnly;
        this.renderHistoryList(file);
      });
      historyList.appendChild(tg);
    }
    if (!shown.length) {
      const empty = document.createElement("div");
      empty.className = "text-ink-500 px-2 py-2 text-xs";
      empty.textContent = t("historyNoAi");
      historyList.appendChild(empty);
      return;
    }
    shown.forEach((rev) => {
      const i = revisions.indexOf(rev);
      const when = this.formatRevDate(rev.date);
      const row = document.createElement("button");
      row.type = "button";
      row.className = "history-rev block w-full text-left px-3 py-2 rounded-lg hover:bg-white/5 mb-0.5 transition";
      row.innerHTML = '<div class="text-ink-200 truncate">' + escapeHtml(rev.subject || "(" + rev.sha.slice(0, 7) + ")") + (rev.ai ? ' <span class="text-accent text-xs font-medium">· ' + escapeHtml(rev.ai) + "</span>" : "") + '</div><div class="text-xs text-ink-500 font-mono mt-0.5">' + escapeHtml(rev.sha.slice(0, 7)) + (when ? " · " + escapeHtml(when) : "") + (rev.author ? " · " + escapeHtml(rev.author) : "") + "</div>";
      row.addEventListener("click", () => {
        historyList.querySelectorAll(".history-rev").forEach((b) => b.classList.remove("bg-accent/15"));
        row.classList.add("bg-accent/15");
        this.currentSha = rev.sha;
        this.showVersion(file, revisions, i);
      });
      historyList.appendChild(row);
    });
    const rows = historyList.querySelectorAll(".history-rev");
    const keepIdx = shown.findIndex((r) => r.sha === this.currentSha);
    if (keepIdx >= 0) rows[keepIdx].classList.add("bg-accent/15");
    else rows[0]?.click();
  }
  // `toggle` = { label, handler } for the secondary button: document view ↔ diff view. The document
  // is the default (cf. row click).
  revisionHeader(file, revisions, i, toggle) {
    const rev = revisions[i];
    const wrap = document.createElement("div");
    wrap.className = "mb-3 pb-2 border-b subtle-border";
    const when = rev.date ? new Date(rev.date).toLocaleString(LANG) : "";
    wrap.innerHTML = '<div class="text-ink-100 font-medium">' + escapeHtml(rev.subject || "") + '</div><div class="text-xs text-ink-500 font-mono mt-0.5">' + escapeHtml(rev.sha.slice(0, 7)) + (when ? " · " + escapeHtml(when) : "") + (rev.author ? " · " + escapeHtml(rev.author) : "") + "</div>";
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;margin-top:8px";
    const view = document.createElement("button");
    view.type = "button";
    view.className = "px-3 py-1.5 text-sm font-medium bg-white/5 hover:bg-white/10 text-ink-200 rounded-lg transition";
    view.textContent = t(toggle.label);
    view.addEventListener("click", toggle.handler);
    actions.appendChild(view);
    const restore = document.createElement("button");
    restore.type = "button";
    restore.className = "px-3 py-1.5 text-sm font-medium bg-accent/15 hover:bg-accent/25 text-accent rounded-lg transition";
    restore.textContent = t("historyRestore");
    restore.addEventListener("click", () => this.revertToRevision(file, rev));
    actions.appendChild(restore);
    wrap.appendChild(actions);
    return wrap;
  }
  async showRevision(file, revisions, i) {
    const rev = revisions[i];
    const parent = revisions[i + 1];
    historyDetail.innerHTML = "";
    historyDetail.appendChild(
      this.revisionHeader(file, revisions, i, {
        label: "historyViewVersion",
        handler: () => this.showVersion(file, revisions, i)
      })
    );
    const body = document.createElement("div");
    body.className = "text-ink-500";
    body.textContent = "…";
    historyDetail.appendChild(body);
    try {
      if (parent) {
        const data = await api(
          "GET",
          "/api/diff?path=" + encodeURIComponent(file.path) + "&from=" + parent.sha + "&to=" + rev.sha
        );
        if (this.file !== file) return;
        body.replaceWith(
          data.diff && data.diff.trim() ? this.diffToDom(data.diff) : this.simpleNode(t("historyNoChange"))
        );
      } else {
        const data = await api(
          "GET",
          "/api/revision?path=" + encodeURIComponent(file.path) + "&rev=" + rev.sha
        );
        if (this.file !== file) return;
        body.replaceWith(this.plainTextNode(data.content));
      }
    } catch (_) {
      if (this.file !== file) return;
      body.textContent = t("historyError");
      body.className = "text-rose-400";
    }
  }
  // Default view when a revision is picked: the DOCUMENT at that revision (what the reader cares
  // about first), with a button to switch to the git diff.
  async showVersion(file, revisions, i) {
    const rev = revisions[i];
    historyDetail.innerHTML = "";
    historyDetail.appendChild(
      this.revisionHeader(file, revisions, i, {
        label: "historyViewChanges",
        handler: () => this.showRevision(file, revisions, i)
      })
    );
    const wrap = document.createElement("div");
    wrap.className = "prose prose-invert max-w-none text-base mt-1";
    wrap.innerHTML = '<p class="text-ink-500">…</p>';
    historyDetail.appendChild(wrap);
    let data;
    try {
      data = await api(
        "GET",
        "/api/revision?path=" + encodeURIComponent(file.path) + "&rev=" + rev.sha
      );
    } catch (_) {
      if (this.file !== file) return;
      wrap.innerHTML = '<p class="text-rose-400">' + escapeHtml(t("historyError")) + "</p>";
      return;
    }
    if (this.file !== file) return;
    if (file.ext === ".html") {
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts");
      frame.title = file.name;
      frame.srcdoc = data.content || "";
      frame.style.cssText = "width:100%;height:60vh;border:0;display:block;background:#0b0d13;border-radius:.5rem";
      wrap.replaceWith(frame);
      return;
    }
    wrap.innerHTML = renderMd(stripFrontmatter(data.content || ""));
  }
  // Restore a doc to a past revision by writing that content back as a new, forward-moving change
  // (kept in git history). Admin-only server-side; CSRF is auto-injected by the global fetch wrapper.
  async revertToRevision(file, rev) {
    const ok = await confirmDialog({
      title: t("historyRestore"),
      message: t("historyRestoreConfirm"),
      confirmLabel: t("historyRestoreBtn")
    });
    if (!ok) return;
    try {
      await api("POST", "/api/revert", { path: file.path, rev: rev.sha });
    } catch (_) {
      setStatus(t("historyRestoreError"), "err");
      return;
    }
    contentCache.delete(file.path);
    closeHistory();
    setStatus(t("historyRestored"), "info");
    showMarkdown(file);
  }
  simpleNode(text) {
    const d = document.createElement("div");
    d.className = "text-ink-500";
    d.textContent = text;
    return d;
  }
  plainTextNode(text) {
    const pre = document.createElement("pre");
    pre.className = "font-mono text-[15px] leading-relaxed text-ink-300";
    pre.style.whiteSpace = "pre-wrap";
    pre.style.wordBreak = "break-word";
    pre.textContent = text || "";
    return pre;
  }
  // Unified diff → escaped, color-coded DOM. Diff colors use inline styles because the green/emerald
  // utilities aren't in the precompiled tailwind.css.
  diffToDom(diffText) {
    const wrap = document.createElement("div");
    wrap.className = "font-mono text-[15px] leading-relaxed";
    wrap.style.whiteSpace = "pre-wrap";
    wrap.style.wordBreak = "break-word";
    let hunks = 0;
    for (const line of (diffText || "").split("\n")) {
      if (line.startsWith("@@")) {
        if (hunks > 0) {
          const sep = document.createElement("div");
          sep.className = "border-t subtle-border";
          sep.style.margin = "8px 0";
          wrap.appendChild(sep);
        }
        hunks++;
        continue;
      }
      if (hunks === 0) continue;
      const row = document.createElement("div");
      row.className = "px-2";
      if (line[0] === "+") {
        row.style.color = "#86efac";
        row.style.background = "rgba(16,185,129,0.10)";
      } else if (line[0] === "-") {
        row.style.color = "#fca5a5";
        row.style.background = "rgba(244,63,94,0.10)";
      } else {
        row.className += " text-ink-400";
      }
      row.textContent = line === "" ? " " : line;
      wrap.appendChild(row);
    }
    return wrap;
  }
}
const historyPanel = new HistoryPanel();
function historyAvailable(file) {
  return historyPanel.available(file);
}
function openHistory(file) {
  return historyPanel.open(file);
}
function closeHistory() {
  historyPanel.close();
}
document.getElementById("btn-history").addEventListener("click", () => openHistory());
document.getElementById("history-close").addEventListener("click", closeHistory);
historyOverlay.addEventListener("click", (e) => {
  if (e.target === historyOverlay) closeHistory();
});

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
const _Frames = class _Frames {
  constructor() {
    // In-flight loads of lazy vendor scripts, cached by URL so a second .docx reuses the first load.
    __publicField(this, "scriptCache", /* @__PURE__ */ new Map());
  }
  // .html doc (slide deck, dashboard…) rendered as-is in a sandboxed iframe: allow-scripts runs its
  // JS in an opaque origin (no access to the viewer's DOM/cookies), allow=fullscreen enables
  // fullscreen. Offline (file://) the absolute URL won't resolve → inject the embedded content via
  // srcdoc instead.
  renderHtml(file) {
    this.enterFrameMode(true);
    const u = escapeHtml(this.frameUrl(file));
    const offlineSrc = IS_OFFLINE_BUILD ? file.content ?? EMBED_CONTENT?.[file.path] ?? null : null;
    const frameAttr = offlineSrc != null ? 'srcdoc="' + escapeHtml(offlineSrc) + '"' : 'src="' + u + '"';
    contentEl.innerHTML = this.banner("htmlDocBanner", u) + "<iframe " + frameAttr + ' sandbox="allow-scripts" allow="fullscreen" title="' + escapeHtml(file.name) + '" style="' + _Frames.FRAME_STYLE + '"></iframe>';
  }
  // .pdf in the browser's native viewer via a same-origin iframe (X-Frame-Options SAMEORIGIN allows
  // our own framing). Offline a binary can't be inlined → offer a direct-open link instead.
  renderPdf(file) {
    this.enterFrameMode(true);
    const u = escapeHtml(this.frameUrl(file));
    const body = IS_OFFLINE_BUILD ? '<div class="p-6 text-sm text-ink-400">' + t("pdfOfflineHint") + ' <a href="' + u + '" class="text-sky-400 hover:underline">' + escapeHtml(file.name) + "</a></div>" : '<iframe src="' + u + '" title="' + escapeHtml(file.name) + '" style="' + _Frames.FRAME_STYLE + '"></iframe>';
    contentEl.innerHTML = this.banner("pdfDocBanner", u) + body;
  }
  // .docx → HTML via mammoth, sanitized and injected into .prose. Read-only, client-side. Each
  // currentFile guard drops a result whose page changed during the fetch/parse.
  async renderDocx(file) {
    this.enterFrameMode(false);
    contentEl.innerHTML = renderSkeleton(file);
    try {
      await this.loadScript(_Frames.MAMMOTH_URL, () => !!window.mammoth);
      const buf = await (await fetch(this.frameUrl(file), { cache: "no-cache" })).arrayBuffer();
      if (currentFile !== file) return;
      const result = await window.mammoth.convertToHtml({ arrayBuffer: buf });
      if (currentFile !== file) return;
      contentEl.innerHTML = '<div class="docx-doc">' + DOMPurify.sanitize(result.value) + "</div>";
    } catch (e) {
      if (currentFile !== file) return;
      contentEl.innerHTML = '<div class="text-rose-400 text-sm">' + escapeHtml(t("docxError", e.message)) + ' <a href="' + escapeHtml(this.encodePath(file)) + '" class="text-sky-400 hover:underline">' + escapeHtml(file.name) + "</a></div>";
    }
  }
  // Banner above a framed doc: a label + an "open fullscreen" link to the raw URL.
  banner(bannerKey, u) {
    return '<div class="flex items-center justify-between px-4 py-2 border-b border-navy-500 bg-navy-800 text-xs"><span class="text-ink-400 font-mono">' + t(bannerKey) + '</span><a href="' + u + '" target="_blank" rel="noopener" class="text-sky-400 hover:underline whitespace-nowrap ml-3">' + t("openFullscreen") + "</a></div>";
  }
  // A framed doc takes over the content pane: no editing (none of these is editable via the viewer),
  // no TOC/backlinks/notes/todos (meaningless over a standalone doc). fullWidth drops the prose width
  // cap + padding for the HTML/PDF decks; DOCX keeps prose width (restores it). All restored by the
  // next .md doc via showMarkdown.
  enterFrameMode(fullWidth) {
    btnEdit.classList.add("hidden");
    btnSave.classList.add("hidden");
    btnCancel.classList.add("hidden");
    contentEl.style.maxWidth = fullWidth ? "none" : "";
    contentEl.style.padding = fullWidth ? "0" : "";
    tocList.innerHTML = "";
    tocLinks.innerHTML = "";
    tocNotes.innerHTML = "";
    tocPanel.classList.add("hidden");
    tocPanel.classList.remove("flex");
    if (tocShow) tocShow.classList.add("hidden");
    document.getElementById("todo-widget")?.classList.add("hidden");
  }
  // Content-relative path → an absolute, percent-encoded URL (no cache-buster).
  encodePath(file) {
    return "/" + file.path.split("/").map(encodeURIComponent).join("/");
  }
  // Same, plus the mtime cache-buster used for the live fetch / iframe src.
  frameUrl(file) {
    return this.encodePath(file) + (file.mtime ? "?v=" + file.mtime : "");
  }
  // Load a vendor <script> once, cached by URL; resolve when onload fires AND ready() confirms the
  // global it defines is present (a 200 that isn't the expected script still rejects). A failed load
  // is evicted so a later open can retry.
  loadScript(url, ready) {
    if (ready()) return Promise.resolve();
    const cached = this.scriptCache.get(url);
    if (cached) return cached;
    const p = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = url;
      s.onload = () => ready() ? resolve() : reject(new Error(url));
      s.onerror = () => {
        this.scriptCache.delete(url);
        reject(new Error(url + " load failed"));
      };
      document.head.appendChild(s);
    });
    this.scriptCache.set(url, p);
    return p;
  }
};
// Shared iframe geometry: full-bleed minus the breadcrumb, dark backdrop.
__publicField(_Frames, "FRAME_STYLE", "width:100%;height:calc(100vh - 150px);border:0;display:block;background:#0b0d13");
// mammoth.js (DOCX → HTML) is ~640 KB: loaded on demand, never in the <head>, since most sessions
// never open a .docx.
__publicField(_Frames, "MAMMOTH_URL", "/vendor/mammoth.min.js");
let Frames = _Frames;
const frameRenderer = new Frames();
function renderHtmlFrame(file) {
  frameRenderer.renderHtml(file);
}
function renderPdfFrame(file) {
  frameRenderer.renderPdf(file);
}
function renderDocxFrame(file) {
  return frameRenderer.renderDocx(file);
}

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
function stripFrontmatter(text) {
  return text.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, "");
}
function folderTagsOf(path) {
  return path.split("/").slice(0, -1).map((s) => s.toLowerCase());
}
class DocTags {
  renderDocTags(file) {
    if (!file || file.ext !== ".md") return "";
    const canEdit = !IS_OFFLINE_BUILD && !window.__viewerMode && !(file.path || "").startsWith("remotes/");
    const folderSet = new Set(folderTagsOf(file.path));
    const chips = (file.tags || []).map(
      (tg) => folderSet.has(tg) ? '<span class="doc-tag doc-tag-folder" data-tag="' + escapeHtml(tg) + '" title="' + escapeHtml(t("folderTagTitle")) + '">#' + escapeHtml(tg) + "</span>" : '<span class="doc-tag" data-tag="' + escapeHtml(tg) + '">#' + escapeHtml(tg) + (canEdit ? '<button class="doc-tag-x" data-removetag="' + escapeHtml(tg) + '" title="' + escapeHtml(t("removeTag")) + '">×</button>' : "") + "</span>"
    ).join("");
    if (!chips && !canEdit) return "";
    return '<div class="doc-tags not-prose">' + chips + (canEdit ? '<button class="doc-tag-add" title="' + escapeHtml(t("addTag")) + '">+</button>' : "") + "</div>";
  }
}
class TagStore {
  constructor(docTags2) {
    this.docTags = docTags2;
  }
  allTagsList() {
    const s = /* @__PURE__ */ new Set();
    for (const f of Object.values(fileMap)) {
      if (f.ext === ".md") for (const tg of f.tags || []) s.add(tg);
    }
    return [...s].sort();
  }
  // Rewrites the `tags:` frontmatter key (custom tags only — folder tags are derived at build).
  // Empty list → removes the key (and the frontmatter block if it empties).
  static setFrontmatterTags(content, customTags) {
    const tagsLine = customTags.length ? "tags: [" + customTags.join(", ") + "]" : null;
    const m = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);
    if (m) {
      const lines = m[1].split(/\r?\n/);
      const out = [];
      for (let i = 0; i < lines.length; i++) {
        if (/^tags[ \t]*:/i.test(lines[i])) {
          let j = i + 1;
          while (j < lines.length && /^[ \t]*-[ \t]+/.test(lines[j])) j++;
          i = j - 1;
          continue;
        }
        out.push(lines[i]);
      }
      if (tagsLine) out.push(tagsLine);
      const cleaned = out.filter((l) => l.trim().length).join("\n");
      const body = content.slice(m[0].length).replace(/^\n+/, "");
      return cleaned ? "---\n" + cleaned + "\n---\n\n" + body : body;
    }
    return tagsLine ? "---\n" + tagsLine + "\n---\n\n" + content : content;
  }
  // Persists custom tags: rewrite frontmatter, PUT /api/file (server rebuilds + commits), then update
  // fileMap and re-render the chips in place.
  async persistTags(file, customTags) {
    let loaded;
    try {
      loaded = await loadContent(file);
    } catch {
      return false;
    }
    const newContent = TagStore.setFrontmatterTags(loaded, customTags);
    try {
      const res = await fetch("/api/file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: file.path, content: newContent })
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
    } catch (err) {
      notifyError("tagSaveFailed", err.message);
      return false;
    }
    contentCache.set(file.path, newContent);
    file.content = newContent;
    const merged = folderTagsOf(file.path);
    for (const tg of customTags) if (!merged.includes(tg)) merged.push(tg);
    file.tags = merged;
    if (currentFile === file) {
      const wrap = contentEl.querySelector(".doc-tags");
      if (wrap) wrap.outerHTML = this.docTags.renderDocTags(file);
    }
    return true;
  }
  async addCustomTag(file, tag) {
    tag = (tag || "").trim().toLowerCase().replace(/^#/, "").replace(/\s+/g, "-");
    if (!file || !tag) return;
    const folderSet = new Set(folderTagsOf(file.path));
    if (folderSet.has(tag)) return;
    const custom = (file.tags || []).filter((tg) => !folderSet.has(tg));
    if (custom.includes(tag)) return;
    custom.push(tag);
    await this.persistTags(file, custom);
  }
  async removeCustomTag(file, tag) {
    if (!file) return;
    const folderSet = new Set(folderTagsOf(file.path));
    const custom = (file.tags || []).filter((tg) => !folderSet.has(tg) && tg !== tag);
    await this.persistTags(file, custom);
  }
}
const _TagEditor = class _TagEditor {
  constructor(store) {
    this.store = store;
    // The popup island: created on open, torn down on close. The combobox is mounted on its input and
    // owns its own body-level dropdown (refresh re-pulls the tag list after a new tag is committed).
    __publicField(this, "editorEl", null);
    __publicField(this, "editorCb", null);
  }
  closeEditor() {
    if (this.editorCb) {
      this.editorCb.destroy();
      this.editorCb = null;
    }
    if (this.editorEl) {
      this.editorEl.remove();
      this.editorEl = null;
    }
  }
  openEditor(file, anchorEl) {
    if (!file) return;
    this.closeEditor();
    const folderSet = new Set(folderTagsOf(file.path));
    const el = document.createElement("div");
    el.id = "tag-editor";
    el.className = _TagEditor.EDITOR_CLASS;
    el.innerHTML = '<div class="text-[11px] uppercase tracking-wider text-ink-500 font-semibold mb-2 font-sans">' + t("tagEditorTitle") + '</div><div id="tag-ed-list" class="flex flex-wrap gap-1.5 mb-2"></div><input id="tag-ed-input" placeholder="' + escapeHtml(t("tagPlaceholder")) + '" autocomplete="off" class="w-full px-3 py-2 text-sm bg-black/30 border subtle-border rounded text-ink-100 placeholder-ink-500 focus:outline-none focus:ring-2 focus:ring-accent/40"><div class="text-[10px] text-ink-500 mt-1.5 font-sans">' + t("tagEditorHint") + "</div>";
    document.body.appendChild(el);
    this.editorEl = el;
    const r = anchorEl.getBoundingClientRect();
    el.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 272)) + "px";
    el.style.top = r.bottom + 6 + "px";
    const input = el.querySelector("#tag-ed-input");
    const renderList = () => {
      const cur = (file.tags || []).filter((tg) => !folderSet.has(tg));
      const box = el.querySelector("#tag-ed-list");
      box.innerHTML = cur.length ? cur.map(
        (tg) => '<span class="doc-tag" style="cursor:default">#' + escapeHtml(tg) + '<button class="doc-tag-x" data-ed-rm="' + escapeHtml(tg) + '">×</button></span>'
      ).join("") : '<span class="text-[11px] text-ink-500">' + t("noCustomTags") + "</span>";
      box.querySelectorAll("[data-ed-rm]").forEach(
        (b) => b.addEventListener("click", async () => {
          await this.store.removeCustomTag(file, b.dataset.edRm);
          renderList();
        })
      );
    };
    renderList();
    this.editorCb = AtlasCombobox(input, {
      source: () => this.store.allTagsList(),
      creatable: true,
      onSelect: async (v) => {
        input.value = "";
        if (v && v.trim()) {
          await this.store.addCustomTag(file, v);
          renderList();
          this.editorCb.refresh();
        }
      }
    });
    input.focus();
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.closeEditor();
      }
    });
  }
  // ---- delegation + outside-click wiring (top-level side effects in the old .js) ----
  init() {
    document.addEventListener("click", (e) => {
      const target = e.target;
      if (this.editorEl && !this.editorEl.contains(target) && !target.closest(".doc-tag-add")) {
        this.closeEditor();
      }
    });
    contentEl.addEventListener("click", (e) => {
      const target = e.target;
      const rm = target.closest("[data-removetag]");
      if (rm) {
        e.preventDefault();
        e.stopPropagation();
        this.store.removeCustomTag(currentFile, rm.dataset.removetag);
        return;
      }
      const add = target.closest(".doc-tag-add");
      if (add) {
        e.preventDefault();
        this.openEditor(currentFile, add);
        return;
      }
      const tagBtn = target.closest(".doc-tag");
      if (tagBtn && tagBtn.dataset.tag) {
        e.preventDefault();
        showTag(tagBtn.dataset.tag);
        return;
      }
      const wl = target.closest("a.wikilink");
      if (wl) {
        e.preventDefault();
        const f = wl.dataset.path ? fileMap[wl.dataset.path] : void 0;
        if (f) {
          showMarkdown(f);
          history.replaceState(null, "", "#" + encodeURIComponent(f.path));
        }
      }
    });
  }
};
// The tag-editor popup wrapper (z-50, body-anchored). Only static class string worth hoisting.
__publicField(_TagEditor, "EDITOR_CLASS", "fixed z-50 w-64 bg-navy-800 border subtle-border rounded-lg shadow-2xl shadow-black/70 p-3");
let TagEditor = _TagEditor;
const docTags = new DocTags();
const tagStore = new TagStore(docTags);
const tagEditor = new TagEditor(tagStore);
tagEditor.init();
function renderDocTags(file) {
  return docTags.renderDocTags(file);
}
function mdInsertWrap(before, after, placeholderIfEmpty) {
  const ta = editTextarea;
  if (!ta) return;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const sel = ta.value.substring(start, end) || placeholderIfEmpty || "";
  const replacement = before + sel + after;
  ta.setRangeText(replacement, start, end, "end");
  if (!ta.value.substring(start, end + replacement.length - (before.length + after.length))) {
    ta.selectionStart = ta.selectionEnd = start + before.length + sel.length;
  } else {
    ta.selectionStart = start + before.length;
    ta.selectionEnd = start + before.length + sel.length;
  }
  ta.dispatchEvent(new Event("input"));
}
function mdInsertLineStart(prefix) {
  const ta = editTextarea;
  if (!ta) return;
  const v = ta.value;
  const start = ta.selectionStart;
  let lineStart = start;
  while (lineStart > 0 && v[lineStart - 1] !== "\n") lineStart--;
  ta.setRangeText(prefix, lineStart, lineStart, "end");
  ta.selectionStart = ta.selectionEnd = start + prefix.length;
  ta.dispatchEvent(new Event("input"));
}
function mdInsertAtCursor(text) {
  const ta = editTextarea;
  if (!ta) return;
  const start = ta.selectionStart;
  ta.setRangeText(text, start, ta.selectionEnd, "end");
  ta.dispatchEvent(new Event("input"));
}

class TagBrowsePage {
  showTag(tag) {
    if (editMode) exitEditMode(false);
    currentFile = null;
    document.querySelector("main").scrollTop = 0;
    const docs = Object.values(fileMap).filter((f) => f.ext === ".md" && (f.tags || []).includes(tag)).sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
    let html = '<h1 class="!mb-1">#' + escapeHtml(tag) + '</h1><p class="lead text-ink-400 !mt-0">' + t("docsWithTag", docs.length) + '</p><ul class="not-prose mt-6 space-y-2">';
    for (const f of docs) {
      html += '<li><a class="block p-3 bg-black/20 hover:bg-black/30 border subtle-border rounded-lg cursor-pointer transition" data-tagdoc="' + escapeHtml(f.path) + '"><div class="text-sm text-ink-100 font-medium font-sans truncate">' + escapeHtml(f.name) + '</div><div class="text-[10px] text-ink-500 mt-0.5 font-mono truncate">' + escapeHtml(f.path) + "</div></a></li>";
    }
    contentEl.innerHTML = html + "</ul>";
    contentEl.querySelectorAll("[data-tagdoc]").forEach(
      (a) => a.addEventListener("click", (e) => {
        e.preventDefault();
        const f = fileMap[a.dataset.tagdoc];
        if (f) {
          showMarkdown(f);
          history.replaceState(null, "", "#" + encodeURIComponent(f.path));
        }
      })
    );
    breadcrumbPath.textContent = "#" + tag;
    breadcrumbDate.textContent = "";
    breadcrumbActions.classList.add("hidden");
    breadcrumbActions.classList.remove("flex");
    tocPanel.classList.add("hidden");
    tocPanel.classList.remove("flex");
    document.querySelectorAll(".tree-item").forEach((el) => el.classList.remove("active"));
  }
}
const tagBrowsePage = new TagBrowsePage();
function showTag(tag) {
  tagBrowsePage.showTag(tag);
}

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
const _WikilinkAutocomplete = class _WikilinkAutocomplete {
  constructor() {
    __publicField(this, "isOpen", false);
    __publicField(this, "items", []);
    __publicField(this, "active", 0);
    __publicField(this, "start", -1);
    __publicField(this, "cands", null);
    __publicField(this, "menuEl", null);
    // Held so the body popup, its document-level outside-click, and the pending blur timer are torn
    // down on exit (no leak across edit sessions).
    __publicField(this, "docMousedown", null);
    __publicField(this, "blurTimer", null);
  }
  // Drop the cached candidates so they recompute on the next keystroke (catches any new docs).
  resetCandidates() {
    this.cands = null;
  }
  // Deferred close on textarea blur, so a mousedown on a popup option is handled first.
  scheduleClose() {
    this.blurTimer = setTimeout(() => this.close(), 150);
  }
  // ---- popup ----
  menu() {
    if (this.menuEl) return this.menuEl;
    const el = document.createElement("div");
    el.id = "wl-autocomplete";
    el.className = "fixed z-50 hidden w-80 max-h-64 overflow-y-auto rounded-md border subtle-border bg-navy-800 shadow-xl scrollbar-thin text-sm";
    document.body.appendChild(el);
    el.addEventListener("mousedown", (e) => {
      const opt = e.target.closest(".wl-opt");
      if (!opt) return;
      e.preventDefault();
      this.insert(+opt.dataset.i);
    });
    this.docMousedown = (e) => {
      if (this.isOpen && this.menuEl && !this.menuEl.contains(e.target) && e.target !== editTextarea)
        this.close();
    };
    document.addEventListener("mousedown", this.docMousedown);
    this.menuEl = el;
    return el;
  }
  close() {
    this.isOpen = false;
    this.start = -1;
    this.items = [];
    if (this.menuEl) {
      this.menuEl.classList.add("hidden");
      this.menuEl.innerHTML = "";
    }
  }
  // Remove the body popup + its document-level mousedown and clear the blur timer, so nothing
  // survives into the next edit session.
  teardown() {
    this.close();
    if (this.blurTimer) {
      clearTimeout(this.blurTimer);
      this.blurTimer = null;
    }
    if (this.docMousedown) {
      document.removeEventListener("mousedown", this.docMousedown);
      this.docMousedown = null;
    }
    if (this.menuEl) {
      this.menuEl.remove();
      this.menuEl = null;
    }
  }
  buildCands() {
    const out = [];
    for (const f of Object.values(fileMap)) {
      if (!WL_TARGET_EXTS.includes(f.ext)) continue;
      const stem = f.name.replace(/\.[^.]+$/, "");
      out.push({
        path: f.path,
        label: stem,
        sub: f.path,
        mtime: f.mtime || 0,
        _name: stem.toLowerCase(),
        _hay: (stem + " " + f.path).toLowerCase()
      });
    }
    return out;
  }
  queryAtCursor(ta) {
    const v = ta.value, cur = ta.selectionStart;
    const open = v.lastIndexOf("[[", cur - 2);
    if (open === -1 || open + 2 > cur) return null;
    const between = v.slice(open + 2, cur);
    if (/[\]\n]/.test(between)) return null;
    return { start: open, query: between };
  }
  filter(query) {
    if (!this.cands) this.cands = this.buildCands();
    const q = query.trim().toLowerCase();
    let res;
    if (q) {
      res = this.cands.filter((c) => c._hay.includes(q));
      const rank = (c) => c._name.startsWith(q) ? 0 : c._name.includes(q) ? 1 : 2;
      res.sort((a, b) => rank(a) - rank(b) || b.mtime - a.mtime);
    } else {
      res = this.cands.slice().sort((a, b) => b.mtime - a.mtime);
    }
    return res.slice(0, 8);
  }
  render() {
    const m = this.menu();
    m.innerHTML = this.items.map(
      (c, i) => '<div class="wl-opt px-3 py-1.5 cursor-pointer ' + (i === this.active ? "bg-white/10" : "") + '" data-i="' + i + '"><div class="text-ink-100 truncate">' + escapeHtml(c.label) + '</div><div class="text-[11px] text-ink-400 truncate">' + escapeHtml(c.sub) + "</div></div>"
    ).join("");
    m.classList.remove("hidden");
    const active = m.children[this.active];
    if (active) active.scrollIntoView({ block: "nearest" });
  }
  caretCoords(ta) {
    const pos = ta.selectionStart, s = getComputedStyle(ta);
    const div = document.createElement("div");
    for (const p of _WikilinkAutocomplete.STYLE_KEYS) div.style[p] = s[p];
    div.style.position = "absolute";
    div.style.visibility = "hidden";
    div.style.whiteSpace = "pre-wrap";
    div.style.wordWrap = "break-word";
    div.style.overflow = "hidden";
    div.textContent = ta.value.slice(0, pos);
    const span = document.createElement("span");
    span.textContent = ta.value.slice(pos) || ".";
    div.appendChild(span);
    document.body.appendChild(div);
    const lh = parseInt(s.lineHeight, 10) || parseInt(s.fontSize, 10) || 16;
    const rect = ta.getBoundingClientRect();
    const top = rect.top + span.offsetTop - ta.scrollTop + lh;
    const left = rect.left + span.offsetLeft - ta.scrollLeft;
    document.body.removeChild(div);
    return { top, left, lineHeight: lh };
  }
  position(ta) {
    const m = this.menu();
    const c = this.caretCoords(ta);
    let top = c.top + 4, left = c.left;
    const mh = m.offsetHeight || 200, mw = m.offsetWidth || 320;
    if (top + mh > window.innerHeight - 8) top = c.top - c.lineHeight - mh - 4;
    if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
    m.style.top = Math.max(8, top) + "px";
    m.style.left = Math.max(8, left) + "px";
  }
  targetFor(path) {
    const stem = fileMap[path].name.replace(/\.[^.]+$/, "");
    const stemLc = stem.toLowerCase();
    let count = 0;
    for (const f of Object.values(fileMap)) {
      if (WL_TARGET_EXTS.includes(f.ext) && f.name.replace(/\.[^.]+$/, "").toLowerCase() === stemLc)
        count++;
    }
    return count <= 1 ? stem : path.replace(/\.[^.]+$/, "");
  }
  update() {
    const ta = editTextarea;
    if (!ta) return;
    const q = this.queryAtCursor(ta);
    if (!q) {
      this.close();
      return;
    }
    this.start = q.start;
    this.items = this.filter(q.query);
    if (!this.items.length) {
      this.close();
      return;
    }
    this.active = 0;
    this.isOpen = true;
    this.render();
    this.position(ta);
  }
  insert(i) {
    const ta = editTextarea;
    const c = this.items[i];
    if (!ta || !c || this.start < 0) {
      this.close();
      return;
    }
    const cur = ta.selectionStart;
    ta.setRangeText("[[" + this.targetFor(c.path) + "]]", this.start, cur, "end");
    this.close();
    ta.focus();
    ta.dispatchEvent(new Event("input"));
  }
  handleKeydown(e) {
    if (!this.isOpen) return false;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.active = (this.active + 1) % this.items.length;
      this.render();
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      this.active = (this.active - 1 + this.items.length) % this.items.length;
      this.render();
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      this.insert(this.active);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
      return true;
    }
    return false;
  }
};
// The textarea computed-style props mirrored onto the caret-measuring div.
__publicField(_WikilinkAutocomplete, "STYLE_KEYS", [
  "boxSizing",
  "width",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "letterSpacing",
  "lineHeight",
  "textTransform",
  "wordSpacing",
  "textIndent",
  "tabSize"
]);
let WikilinkAutocomplete = _WikilinkAutocomplete;

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
const _Editor = class _Editor {
  constructor() {
    // The split-view live-preview debounce timer, cleared on exit. The [[wikilink]] popup, its caret
    // measurement, and its own timers/listeners live in the composed WikilinkAutocomplete.
    __publicField(this, "previewTimer", null);
    __publicField(this, "wikilink", new WikilinkAutocomplete());
    btnEdit.addEventListener("click", () => this.enterEditMode());
    btnSave.addEventListener("click", () => this.saveEdit());
    btnCancel.addEventListener("click", () => this.exitEditMode(false));
  }
  mdHandleAction(action) {
    const ta = editTextarea;
    if (!ta) return;
    ta.focus();
    switch (action) {
      case "bold":
        mdInsertWrap("**", "**", t("phText"));
        break;
      case "italic":
        mdInsertWrap("*", "*", t("phText"));
        break;
      case "strike":
        mdInsertWrap("~~", "~~", t("phText"));
        break;
      case "h1":
        mdInsertLineStart("# ");
        break;
      case "h2":
        mdInsertLineStart("## ");
        break;
      case "h3":
        mdInsertLineStart("### ");
        break;
      case "ul":
        mdInsertLineStart("- ");
        break;
      case "ol":
        mdInsertLineStart("1. ");
        break;
      case "todo":
        mdInsertLineStart("- [ ] ");
        break;
      case "quote":
        mdInsertLineStart("> ");
        break;
      case "link":
        mdInsertWrap("[", "](url)", t("phLabel"));
        break;
      case "code":
        mdInsertWrap("`", "`", "code");
        break;
      case "codeblock":
        mdInsertWrap("\n```\n", "\n```\n", "code");
        break;
      case "hr":
        mdInsertAtCursor("\n\n---\n\n");
        break;
      case "table":
        mdInsertAtCursor("\n| Col 1 | Col 2 |\n| --- | --- |\n| A | B |\n");
        break;
    }
  }
  // ---- edit-mode lifecycle ----
  async enterEditMode() {
    if (!currentFile) return;
    let content;
    try {
      content = await loadContent(currentFile);
    } catch (e) {
      notifyError("cantLoadDoc", e.message);
      return;
    }
    editMode = true;
    contentEl.classList.remove("max-w-4xl", "px-10", "py-10", "prose", "prose-invert");
    contentEl.classList.add("max-w-none", "px-4", "py-4");
    const wrap = document.createElement("div");
    wrap.className = "flex flex-col";
    wrap.style.height = "calc(100vh - 11rem)";
    const toolbar = document.createElement("div");
    toolbar.className = "flex flex-wrap items-center gap-1 px-3 py-2 border subtle-border rounded-t-md bg-navy-800";
    toolbar.innerHTML = _Editor.MD_TOOLBAR_HTML;
    const splitWrap = document.createElement("div");
    splitWrap.className = "flex flex-1 min-h-0 border-l border-r border-b subtle-border rounded-b-md overflow-hidden bg-navy-900";
    const ta = document.createElement("textarea");
    ta.id = "md-editor";
    ta.value = content;
    ta.spellcheck = false;
    ta.className = "min-w-0 p-5 bg-transparent text-ink-100 resize-none focus:outline-none scrollbar-thin";
    ta.style.flex = "1 1 0";
    editTextarea = ta;
    const divider = document.createElement("div");
    divider.className = "w-px bg-[#2a2a32] flex-shrink-0";
    const preview = document.createElement("article");
    preview.id = "md-preview";
    preview.className = "min-w-0 px-8 py-6 overflow-y-auto scrollbar-thin prose prose-sm prose-invert max-w-none";
    preview.style.flex = "1 1 0";
    preview.innerHTML = renderMd(content);
    splitWrap.appendChild(ta);
    splitWrap.appendChild(divider);
    splitWrap.appendChild(preview);
    wrap.appendChild(toolbar);
    wrap.appendChild(splitWrap);
    contentEl.innerHTML = "";
    contentEl.appendChild(wrap);
    toolbar.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-md]");
      if (btn) this.mdHandleAction(btn.dataset.md);
    });
    this.wikilink.resetCandidates();
    ta.addEventListener("input", () => {
      this.wikilink.update();
      if (this.previewTimer) clearTimeout(this.previewTimer);
      this.previewTimer = setTimeout(() => {
        preview.innerHTML = renderMd(ta.value);
      }, 150);
    });
    ta.addEventListener("blur", () => {
      this.wikilink.scheduleClose();
    });
    ta.addEventListener("keydown", (e) => {
      if (this.wikilink.handleKeydown(e)) return;
      if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase();
        if (k === "b") {
          e.preventDefault();
          this.mdHandleAction("bold");
          return;
        }
        if (k === "i") {
          e.preventDefault();
          this.mdHandleAction("italic");
          return;
        }
        if (k === "l") {
          e.preventDefault();
          this.mdHandleAction("link");
          return;
        }
      }
      if (e.key === "Tab") {
        e.preventDefault();
        mdInsertAtCursor("  ");
      }
    });
    ta.focus();
    ta.setSelectionRange(0, 0);
    ta.scrollTop = 0;
    btnEdit.classList.add("hidden");
    btnSave.classList.remove("hidden");
    btnCancel.classList.remove("hidden");
    document.dispatchEvent(new CustomEvent("atlas:edit-enter"));
    tocPanel.classList.add("hidden");
    tocPanel.classList.remove("flex");
    if (typeof tocShow !== "undefined" && tocShow) tocShow.classList.add("hidden");
  }
  async saveEdit() {
    if (!editMode || !currentFile) return;
    if (!isServerMode) {
      notifyError("fileModeNoEdit");
      return;
    }
    const file = currentFile;
    const newContent = editTextarea.value;
    btnSave.disabled = true;
    btnSave.textContent = t("saving");
    try {
      const body = { path: file.path, content: newContent };
      const res = await fetch("/api/file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      file.content = newContent;
      contentCache.set(file.path, newContent);
      file.mtime = data.mtime || Math.floor(Date.now() / 1e3);
      sse.muteSelfSave(file.path);
      this.exitEditMode(true);
    } catch (e) {
      notifyError("err", e.message);
    } finally {
      btnSave.disabled = false;
      btnSave.textContent = t("saveBtn");
    }
  }
  exitEditMode(reload) {
    this.teardownEditSession();
    editMode = false;
    editTextarea = null;
    contentEl.classList.add("max-w-4xl", "px-10", "py-10", "prose", "prose-invert");
    contentEl.classList.remove("max-w-none", "px-4", "py-4");
    if (reload && currentFile) showMarkdown(currentFile);
    else if (currentFile) {
      btnEdit.classList.remove("hidden");
      btnSave.classList.add("hidden");
      btnCancel.classList.add("hidden");
      const cached = currentFile.content != null ? currentFile.content : contentCache.get(currentFile.path);
      contentEl.innerHTML = renderMd(cached || "");
      attachCopyButtons();
      wireTaskCheckboxes(currentFile, cached || "");
      renderBacklinksFor(currentFile);
      buildToc();
      document.dispatchEvent(
        new CustomEvent("atlas:doc-rendered", {
          detail: { path: currentFile.path, markdown: cached || "" }
        })
      );
    }
  }
  // Clear the live-preview timer and tear down the wikilink popup so nothing survives the session.
  teardownEditSession() {
    this.wikilink.teardown();
    if (this.previewTimer) {
      clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
  }
};
// ---- markdown toolbar ----
// Built once at class-definition time (same timing as the old module-level const); the strings
// are localized via t(), so it must evaluate after 01-i18n.
__publicField(_Editor, "MD_TOOLBAR_HTML", '<button data-md="bold" class="md-tb-btn" title="' + t("tbBold") + '"><b>B</b></button><button data-md="italic" class="md-tb-btn" title="' + t("tbItalic") + '"><i>I</i></button><button data-md="strike" class="md-tb-btn" title="' + t("tbStrike") + '"><s>S</s></button><span class="md-tb-sep"></span><button data-md="h1" class="md-tb-btn">H1</button><button data-md="h2" class="md-tb-btn">H2</button><button data-md="h3" class="md-tb-btn">H3</button><span class="md-tb-sep"></span><button data-md="ul" class="md-tb-btn" title="' + t("tbUl") + '">' + t("tbUlLabel") + '</button><button data-md="ol" class="md-tb-btn" title="' + t("tbOl") + '">' + t("tbOlLabel") + '</button><button data-md="todo" class="md-tb-btn" title="' + t("tbTodo") + '">☐ Todo</button><button data-md="quote" class="md-tb-btn" title="' + t("tbQuote") + '">' + t("tbQuoteLabel") + '</button><span class="md-tb-sep"></span><button data-md="link" class="md-tb-btn" title="' + t("tbLink") + '">' + t("tbLinkLabel") + '</button><button data-md="code" class="md-tb-btn" title="' + t("tbCode") + '">&lt;/&gt;</button><button data-md="codeblock" class="md-tb-btn" title="' + t("tbCodeblock") + '">' + t("tbCodeblockLabel") + '</button><button data-md="table" class="md-tb-btn" title="' + t("tbTable") + '">⊞ Table</button><button data-md="hr" class="md-tb-btn" title="' + t("tbHr") + '">— HR</button>');
let Editor = _Editor;
const editor = new Editor();
function enterEditMode() {
  return editor.enterEditMode();
}
function exitEditMode(reload) {
  editor.exitEditMode(reload);
}

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
let miniSearch = null;
let searchInitPromise = null;
const _Search = class _Search {
  constructor() {
    __publicField(this, "searchDebounce", null);
    // The "FILES" header above the tree, hidden alongside the tree while a query is active.
    __publicField(this, "treeHeaderEl", document.getElementById("tree-header"));
    searchEl.addEventListener("input", () => this.onSearchInput());
  }
  // Local lib (/vendor/); in an offline build (file://) it's inlined into the
  // monolith by build.py, so the typeof short-circuits — no fetch.
  async loadMiniSearchLib() {
    if (typeof MiniSearch !== "undefined") return;
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "/vendor/minisearch.min.js";
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(t("cdnFailMiniSearch")));
      document.head.appendChild(s);
    });
  }
  // MiniSearch is only used in offline builds (file://, no server). Online,
  // search goes through /api/search. We index the already-embedded content.
  async getSearchData() {
    const docs = [];
    for (const f of Object.values(fileMap)) {
      if (f.ext !== ".md") continue;
      const c = EMBED_CONTENT[f.path] || "";
      docs.push({ id: f.path, name: f.name, path: f.path, content: c, preview: c.slice(0, 240) });
    }
    return docs;
  }
  async initMiniSearch() {
    if (miniSearch) return miniSearch;
    if (searchInitPromise) return searchInitPromise;
    searchInitPromise = (async () => {
      await this.loadMiniSearchLib();
      const docs = await this.getSearchData();
      const ms = new MiniSearch({
        idField: "id",
        fields: _Search.SEARCH_FIELDS,
        storeFields: _Search.SEARCH_STORE,
        searchOptions: {
          boost: { name: 3, path: 2 },
          fuzzy: 0.2,
          prefix: true,
          combineWith: "AND"
        },
        tokenize: (text) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean),
        processTerm: (term) => term.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
      });
      ms.addAll(docs);
      miniSearch = ms;
      return ms;
    })();
    return searchInitPromise;
  }
  // Online: server-side search (/api/search) → transfer O(results), nothing to
  // download. Offline (file:// monolith): MiniSearch over the embedded content.
  // Each branch returns a normalized array [{path, snippet}].
  async getSearchHits(q) {
    if (IS_OFFLINE_BUILD) {
      const ms = await this.initMiniSearch();
      const matches = ms.search(q, { boost: { name: 3, path: 2 }, fuzzy: 0.2, prefix: true });
      return matches.map((m) => ({
        path: m.path,
        snippet: makeSnippet(m.preview || "", q)
      }));
    }
    const res = await fetch("/api/search?q=" + encodeURIComponent(q) + "&limit=50", {
      cache: "no-store"
    });
    if (!res.ok) throw new Error("search HTTP " + res.status);
    const hits = await res.json();
    return hits.map((h) => ({ path: h.path, snippet: h.snippet || "" }));
  }
  async renderSearchResults(q) {
    searchResultsEl.innerHTML = '<div class="px-3 py-4 text-xs text-ink-500">' + t("searching") + "</div>";
    let hits;
    try {
      hits = await this.getSearchHits(q);
    } catch (e) {
      searchResultsEl.innerHTML = '<div class="px-3 py-4 text-xs text-rose-400">' + escapeHtml(t("err", e.message)) + "</div>";
      return;
    }
    if (searchEl.value.trim() !== q) return;
    if (hits.length === 0) {
      searchResultsEl.innerHTML = '<div class="px-3 py-4 text-xs text-ink-500">' + escapeHtml(t("noResults", q)) + "</div>";
      return;
    }
    const top = hits.slice(0, 50);
    searchResultsEl.innerHTML = '<div class="px-2 pb-2 text-[10px] uppercase tracking-wider text-ink-500 font-semibold">' + t("nResults", hits.length) + (hits.length > 50 ? t("cappedSuffix") : "") + "</div>";
    const tokens = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").split(/\s+/).filter(Boolean);
    const highlightRe = tokens.length ? new RegExp("(" + tokens.join("|") + ")", "gi") : null;
    for (const m of top) {
      const file = fileMap[m.path];
      if (!file) continue;
      const a = document.createElement("a");
      a.className = "tree-item block px-2 py-1.5 rounded cursor-pointer text-ink-200 mb-0.5";
      a.dataset.path = file.path;
      const snippet = m.snippet;
      const snippetHtml = snippet && highlightRe ? '<div class="text-[11px] text-ink-400 mt-0.5 leading-snug">' + escapeHtml(snippet).replace(
        highlightRe,
        '<mark class="bg-blue-500/30 text-blue-200 rounded px-0.5">$1</mark>'
      ) + "</div>" : "";
      a.innerHTML = '<div class="text-sm font-medium text-ink-100 truncate">' + escapeHtml(file.name) + '</div><div class="text-[10px] text-ink-500">' + file.path + "</div>" + snippetHtml;
      if (file.ext === ".md" || file.ext === ".html") {
        a.addEventListener("click", (e) => {
          e.preventDefault();
          showMarkdown(file, q);
        });
      } else {
        a.href = encodeURI(file.path);
      }
      searchResultsEl.appendChild(a);
    }
  }
  onSearchInput() {
    const q = searchEl.value.trim();
    if (this.searchDebounce) clearTimeout(this.searchDebounce);
    if (!q) {
      searchResultsEl.classList.add("hidden");
      treeEl.classList.remove("hidden");
      if (this.treeHeaderEl) this.treeHeaderEl.classList.remove("hidden");
      if (recentList.children.length > 0) recentSection.classList.remove("hidden");
      return;
    }
    treeEl.classList.add("hidden");
    if (this.treeHeaderEl) this.treeHeaderEl.classList.add("hidden");
    recentSection.classList.add("hidden");
    searchResultsEl.classList.remove("hidden");
    this.searchDebounce = setTimeout(() => this.renderSearchResults(q), 140);
  }
};
__publicField(_Search, "SEARCH_FIELDS", ["name", "path", "content"]);
__publicField(_Search, "SEARCH_STORE", ["name", "path", "preview"]);
let Search = _Search;
function makeSnippet(preview, query) {
  if (!preview) return "";
  const words = query.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/\s+/).filter(Boolean);
  const lower = preview.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  let idx = -1, term = null;
  for (const w of words) {
    const i = lower.indexOf(w);
    if (i >= 0 && (idx < 0 || i < idx)) {
      idx = i;
      term = w;
    }
  }
  if (idx < 0) return preview.slice(0, 160) + (preview.length > 160 ? "…" : "");
  const start = Math.max(0, idx - 40);
  const end = Math.min(preview.length, idx + term.length + 80);
  return (start > 0 ? "…" : "") + preview.slice(start, end) + (end < preview.length ? "…" : "");
}
const search = new Search();
function getSearchHits(q) {
  return search.getSearchHits(q);
}

class HomeView {
  // ---- home renderers (imperative innerHTML; see file header) ----
  renderRecent() {
    const files = Object.values(fileMap).filter((f) => f.ext === ".md" && f.mtime).sort((a, b) => b.mtime - a.mtime).slice(0, 3);
    if (files.length === 0) return;
    recentSection.classList.remove("hidden");
    recentList.innerHTML = files.map(
      (f) => `
    <li class="overflow-hidden"><a class="tree-item w-full flex flex-col px-2 py-1 rounded cursor-pointer" data-path="${f.path}">
      <span class="block text-xs text-ink-200 truncate w-full" data-name="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
      <span class="text-[10px] text-ink-500">${relativeDate(f.mtime)}</span>
    </a></li>
  `
    ).join("");
    recentList.querySelectorAll("a").forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const path = a.dataset.path;
        const f = path ? fileMap[path] : void 0;
        if (f) {
          showMarkdown(f);
          history.replaceState(null, "", "#" + encodeURIComponent(f.path));
        }
      });
    });
  }
  // "Shared with me": docs another member shared WITH the viewer, discovered via
  // /api/shared-with-me. Cloud-only and fully defensive — any failure (offline build, local mode,
  // empty list, network error) just leaves the section hidden, so it can never break the home view.
  async renderSharedWithMe() {
    if (IS_OFFLINE_BUILD || !location.protocol.startsWith("http")) return;
    let docs;
    try {
      const r = await fetch("/api/shared-with-me");
      if (!r.ok) return;
      docs = await r.json();
    } catch {
      return;
    }
    if (!Array.isArray(docs) || docs.length === 0) return;
    sharedSection.classList.remove("hidden");
    sharedList.innerHTML = docs.slice(0, 8).map((d) => {
      const name = String(d.path).split("/").pop();
      const by = d.granted_by ? String(d.granted_by).replace(/^user:/, "") : "";
      return `
    <li class="overflow-hidden"><a class="tree-item w-full flex flex-col px-2 py-1 rounded cursor-pointer" data-path="${escapeHtml(d.path)}">
      <span class="block text-xs text-ink-200 truncate w-full" data-name="${escapeHtml(name)}">${escapeHtml(name)}</span>
      ${by ? `<span class="text-[10px] text-ink-500">${escapeHtml(by)}</span>` : ""}
    </a></li>`;
    }).join("");
    sharedList.querySelectorAll("a").forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const path = a.dataset.path;
        const f = path ? fileMap[path] : void 0;
        if (f) {
          showMarkdown(f);
          history.replaceState(null, "", "#" + encodeURIComponent(f.path));
        }
      });
    });
  }
  showNotFound(path) {
    currentFile = null;
    contentEl.style.maxWidth = "";
    contentEl.style.padding = "";
    document.getElementById("todo-widget")?.classList.remove("hidden");
    breadcrumbPath.textContent = "/";
    breadcrumbDate.textContent = "";
    breadcrumbActions.classList.add("hidden");
    breadcrumbActions.classList.remove("flex");
    tocPanel.classList.add("hidden");
    contentEl.innerHTML = '<div class="max-w-md mx-auto mt-24 text-center"><div class="text-5xl mb-4 opacity-60">🔒</div><h1 class="text-xl font-semibold text-ink-100 mb-2 !border-0 !p-0">' + escapeHtml(t("notFoundTitle")) + '</h1><p class="text-sm text-ink-400 mb-1">' + escapeHtml(t("notFoundBody")) + '</p><p class="text-[11px] text-ink-500 font-mono mb-6 break-all">' + escapeHtml(path) + '</p><button id="nf-home" class="px-3 py-1.5 text-sm bg-accent hover:brightness-110 text-white rounded font-medium">' + escapeHtml(t("notFoundHome")) + "</button></div>";
    document.getElementById("nf-home")?.addEventListener("click", () => {
      history.replaceState(null, "", location.pathname);
      this.showWelcome();
    });
  }
  routeFromHash() {
    const hash = location.hash ? decodeURIComponent(location.hash.slice(1)) : "";
    if (!hash || hash === "mind") {
      this.showWelcome();
      return;
    }
    const f = fileMap[hash];
    if (f && f.ext === ".md") {
      showMarkdown(f);
      return;
    }
    if (f) {
      this.showWelcome();
      return;
    }
    if (Object.keys(fileMap).length) this.showNotFound(hash);
    else this.showWelcome();
  }
  showWelcome() {
    currentFile = null;
    document.querySelector("main").scrollTop = 0;
    contentEl.style.maxWidth = "";
    contentEl.style.padding = "";
    document.getElementById("todo-widget")?.classList.remove("hidden");
    const byCategory = {};
    let totalWords = 0;
    for (const f of Object.values(fileMap)) {
      if (f.ext !== ".md") continue;
      const parts = f.path.split("/");
      const cat = parts.length >= 2 ? parts[0] + (parts.length >= 3 ? "/" + parts[1] : "") : "root";
      byCategory[cat] = (byCategory[cat] || 0) + 1;
      if (f.words) totalWords += f.words;
    }
    const catEntries = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
    const recent = Object.values(fileMap).filter((f) => f.ext === ".md" && f.mtime).sort((a, b) => b.mtime - a.mtime).slice(0, 4);
    const todoSummary = todos.length ? `${todos.filter((td) => td.done).length}/${todos.length}` : "–";
    const dayMs = 86400 * 1e3;
    const now = /* @__PURE__ */ new Date();
    now.setHours(0, 0, 0, 0);
    const todayDow = (now.getDay() + 6) % 7;
    const monday = new Date(now.getTime() - todayDow * dayMs);
    const startOfThisWeek = monday.getTime() / 1e3;
    const startOfPrevWeek = (monday.getTime() - 7 * dayMs) / 1e3;
    let weekModif = 0;
    let prevWeekModif = 0;
    for (const f of Object.values(fileMap)) {
      if (f.ext !== ".md" || !f.mtime) continue;
      if (f.mtime >= startOfThisWeek) weekModif += 1;
      else if (f.mtime >= startOfPrevWeek) prevWeekModif += 1;
    }
    const weekDelta = weekModif - prevWeekModif;
    const weekDeltaTxt = weekDelta === 0 ? "=" : (weekDelta > 0 ? "+" : "") + weekDelta;
    const weekDeltaColor = weekDelta > 0 ? "#4ade80" : weekDelta < 0 ? "#f87171" : "#868a90";
    const categoryItems = catEntries.map(([cat, n]) => {
      return '<div class="flex items-center justify-between px-3 py-2 rounded border subtle-border bg-black/15 hover:bg-black/25 transition"><span class="text-sm text-ink-200 font-mono truncate">' + escapeHtml(cat) + '</span><span class="text-xs text-ink-400 font-semibold ml-2">' + n + "</span></div>";
    }).join("");
    const recentItems = recent.map((f) => {
      return '<a data-recent-path="' + f.path + '" class="block p-3 rounded-lg border subtle-border bg-black/15 hover:bg-black/30 hover:border-accent/30 transition cursor-pointer"><div class="text-sm text-ink-100 font-medium font-sans truncate">' + escapeHtml(f.name) + '</div><div class="text-[11px] text-ink-500 mt-0.5 font-sans">' + relativeDate(f.mtime) + " · " + escapeHtml(f.path.split("/").slice(0, -1).join("/") || t("rootLabel")) + "</div></a>";
    }).join("");
    const longest = Object.values(fileMap).filter((f) => f.ext === ".md" && f.words).sort((a, b) => (b.words ?? 0) - (a.words ?? 0)).slice(0, 6);
    const maxWords = longest.length ? longest[0].words ?? 1 : 1;
    const rankingHtml = longest.length ? longest.map((f, i) => {
      const words = f.words ?? 0;
      const pct = Math.max(4, Math.round(100 * words / maxWords));
      return '<a data-recent-path="' + f.path + '" class="block cursor-pointer group"><div class="flex items-center gap-2"><span class="text-ink-500 font-mono text-xs w-4 text-right">' + (i + 1) + '</span><span class="text-sm text-ink-200 group-hover:text-accent truncate flex-1">' + escapeHtml(f.name) + '</span><span class="text-[11px] text-ink-500 font-mono whitespace-nowrap">' + words.toLocaleString(LANG) + '</span></div><div class="h-1 mt-1 ml-6 rounded bg-black/30 overflow-hidden"><div class="h-full rounded" style="width:' + pct + '%;background:rgba(29,155,209,0.55)"></div></div></a>';
    }).join("") : '<span class="text-sm text-ink-500">—</span>';
    const tagCounts = {};
    for (const f of Object.values(fileMap)) {
      if (f.ext !== ".md") continue;
      for (const tag of f.tags || []) tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
    const tagEntries = Object.entries(tagCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const maxTagCount = tagEntries.length ? tagEntries[0][1] : 1;
    const tagCloud = tagEntries.map(([tag, n]) => {
      const scale = (0.78 + 0.5 * (n / maxTagCount)).toFixed(2);
      return '<button class="doc-tag" data-hometag="' + escapeHtml(tag) + '" style="font-size:' + scale + 'rem">#' + escapeHtml(tag) + '<span class="doc-tag-count">' + n + "</span></button>";
    }).join("");
    contentEl.innerHTML = `
    <h1 class="!mb-2"><span style="font-family:'Corinthia',cursive;font-weight:700;font-size:1.7em;line-height:.9;color:#eef0f2">${escapeHtml(SITE_PREFIX)}</span> <span style="display:inline-flex;align-items:center;gap:.4em;line-height:1;margin-left:.22em"><span style="font-family:'Lora',Georgia,serif;font-style:italic;font-weight:600;font-size:1.3em;color:#e8941c;text-shadow:0 1px 2px rgba(0,0,0,0.6),0 0 1px rgba(0,0,0,0.85)">Atlas</span><span class="nebula-pill">Mind</span></span></h1>
    <p class="lead text-ink-400 !mt-0">${escapeHtml(TAGLINE)}</p>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 not-prose mt-6 mb-8">
      <div class="border subtle-border rounded-lg p-4 bg-black/15">
        <div class="text-[10px] uppercase tracking-wider text-ink-500 font-semibold">${t("statDocs")}</div>
        <div class="text-3xl font-extrabold text-accent mt-1 font-sans">${mdCount}</div>
        <div class="text-[11px] text-ink-400 mt-0.5">${t("statDocsSub")}</div>
      </div>
      <div class="border subtle-border rounded-lg p-4 bg-black/15">
        <div class="text-[10px] uppercase tracking-wider text-ink-500 font-semibold">${t("statWords")}</div>
        <div class="text-3xl font-extrabold text-accent mt-1 font-sans">${(totalWords / 1e3).toFixed(1)}k</div>
        <div class="text-[11px] text-ink-400 mt-0.5">${t("statWordsSub", Math.round(totalWords / 220))}</div>
      </div>
      <div class="border subtle-border rounded-lg p-4 bg-black/15">
        <div class="text-[10px] uppercase tracking-wider text-ink-500 font-semibold">${t("statWeek")}</div>
        <div class="text-3xl font-extrabold text-accent mt-1 font-sans">${weekModif} <span class="text-sm font-bold ml-1" style="color:${weekDeltaColor}">${weekDeltaTxt}</span></div>
        <div class="text-[11px] text-ink-400 mt-0.5">${t("statWeekSub")}</div>
      </div>
      <div class="border subtle-border rounded-lg p-4 bg-black/15">
        <div class="text-[10px] uppercase tracking-wider text-ink-500 font-semibold">To-do</div>
        <div id="home-todo-stat" class="text-3xl font-extrabold text-accent mt-1 font-sans">${escapeHtml(todoSummary)}</div>
        <div class="text-[11px] text-ink-400 mt-0.5">${t("statTodoSub")}</div>
      </div>
    </div>

    <div class="not-prose mb-10" id="home-activity-mount"></div>

    <div class="not-prose mb-10">
      <div class="flex items-center justify-between mb-4">
        <h2 class="!mb-0 !mt-0">Tags</h2>
        <button id="home-graph-btn" class="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs bg-navy-600 hover:bg-navy-500 text-ink-100 rounded-lg border subtle-border transition" title="${t("graphBtnTitle")}"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/></svg>${t("graphLabel")}</button>
      </div>
      <div class="doc-tags">${tagCloud || '<span class="text-sm text-ink-500">' + t("noTags") + "</span>"}</div>
    </div>

    <h2 class="!mt-0 !mb-4">${t("recentlyModified")}</h2>
    <div class="not-prose grid grid-cols-1 md:grid-cols-2 gap-3 mb-10">${recentItems || '<div class="text-sm text-ink-500">' + t("noRecentDocs") + "</div>"}</div>

    <div class="not-prose grid grid-cols-1 md:grid-cols-2 gap-6 mb-10">
      <div>
        <h2 class="!mb-4 !mt-0">${t("categories")}</h2>
        <div class="grid grid-cols-1 gap-2">${categoryItems}</div>
      </div>
      <div>
        <h2 class="!mb-4 !mt-0">${t("longestDocs")}</h2>
        <div class="space-y-2.5">${rankingHtml}</div>
      </div>
    </div>

    <div class="not-prose mt-8 text-xs text-ink-500 flex flex-wrap gap-x-4 gap-y-2 items-center">
      <span><kbd class="bg-black/30 border subtle-border px-1.5 py-0.5 rounded font-mono">Ctrl+K</kbd> ${t("hintPalette")}</span>
      <span><kbd class="bg-black/30 border subtle-border px-1.5 py-0.5 rounded font-mono">/</kbd> ${t("hintSearch")}</span>
      <span><kbd class="bg-black/30 border subtle-border px-1.5 py-0.5 rounded font-mono">Ctrl+B</kbd> ${t("hintSidebar")}</span>
      <span><kbd class="bg-black/30 border subtle-border px-1.5 py-0.5 rounded font-mono">Ctrl+J</kbd> ${t("hintToc")}</span>
      <span><kbd class="bg-black/30 border subtle-border px-1.5 py-0.5 rounded font-mono">E</kbd> ${t("hintEdit")}</span>
      <span><kbd class="bg-black/30 border subtle-border px-1.5 py-0.5 rounded font-mono">N</kbd> ${t("hintNewTodo")}</span>
    </div>
  `;
    contentEl.querySelectorAll("[data-recent-path]").forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const path = a.dataset.recentPath;
        const f = path ? fileMap[path] : void 0;
        if (f) {
          showMarkdown(f);
          history.replaceState(null, "", "#" + encodeURIComponent(f.path));
        }
      });
    });
    contentEl.querySelectorAll("[data-hometag]").forEach(
      (b) => b.addEventListener("click", (e) => {
        e.preventDefault();
        if (b.dataset.hometag) showTag(b.dataset.hometag);
      })
    );
    const homeGraphBtn = contentEl.querySelector("#home-graph-btn");
    if (homeGraphBtn) homeGraphBtn.addEventListener("click", openGraph);
    if (window.mountActivity) window.mountActivity();
    breadcrumbPath.textContent = "/";
    breadcrumbDate.textContent = "";
    breadcrumbActions.classList.add("hidden");
    breadcrumbActions.classList.remove("flex");
    tocPanel.classList.add("hidden");
    tocPanel.classList.remove("flex");
    tocShow.classList.add("hidden");
  }
}
const homeView = new HomeView();
function renderRecent() {
  homeView.renderRecent();
}
function showNotFound(path) {
  homeView.showNotFound(path);
}
function routeFromHash() {
  homeView.routeFromHash();
}
function showWelcome() {
  homeView.showWelcome();
}
renderRecent();
homeView.renderSharedWithMe();
document.getElementById("home-link").addEventListener("click", () => {
  homeView.showWelcome();
  history.replaceState(null, "", location.pathname);
});
document.getElementById("btn-download").addEventListener("click", async () => {
  const file = currentFile;
  if (!file) return;
  if (file.ext !== ".md") {
    const fileUrl = "/" + file.path.split("/").map(encodeURIComponent).join("/");
    const a2 = document.createElement("a");
    a2.href = fileUrl;
    a2.download = file.name;
    document.body.appendChild(a2);
    a2.click();
    document.body.removeChild(a2);
    return;
  }
  let content;
  try {
    content = await loadContent(file);
  } catch (e) {
    notifyError("cantLoadDoc", e.message);
    return;
  }
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
});

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
class LayoutChrome {
  constructor() {
    __publicField(this, "sidebarCollapsed", localStorage.getItem("sidebar-collapsed") === "1");
    __publicField(this, "tocHiddenMap", {});
    try {
      this.tocHiddenMap = JSON.parse(localStorage.getItem("toc-hidden-per-doc") || "{}");
    } catch {
    }
  }
  isMobile() {
    return window.matchMedia("(max-width: 767px)").matches;
  }
  applySidebar() {
    if (this.isMobile()) {
      sidebarEl.style.marginLeft = "";
      sidebarShowInline.classList.remove("hidden");
      return;
    }
    if (this.sidebarCollapsed) {
      sidebarEl.style.marginLeft = "-20rem";
      sidebarShowInline.classList.remove("hidden");
    } else {
      sidebarEl.style.marginLeft = "";
      sidebarShowInline.classList.add("hidden");
    }
  }
  toggleSidebar() {
    if (this.isMobile()) {
      document.body.classList.toggle("sidebar-open");
      return;
    }
    this.sidebarCollapsed = !this.sidebarCollapsed;
    localStorage.setItem("sidebar-collapsed", this.sidebarCollapsed ? "1" : "0");
    this.applySidebar();
  }
  isTocHiddenForCurrent() {
    if (!currentFile) return false;
    return this.tocHiddenMap[currentFile.path] === true;
  }
  applyToc() {
    if (!currentFile) {
      tocPanel.classList.add("hidden");
      tocPanel.classList.remove("flex");
      tocShow.classList.add("hidden");
      return;
    }
    const hasContent = tocList.children.length >= 2 || tocHasLinks || tocHasNotes;
    if (this.isMobile()) {
      tocPanel.classList.add("hidden");
      tocPanel.classList.remove("flex");
      tocShow.classList.toggle("hidden", !hasContent);
      return;
    }
    const hidden = this.isTocHiddenForCurrent();
    if (hidden || !hasContent) {
      tocPanel.classList.add("hidden");
      tocPanel.classList.remove("flex");
      tocShow.classList.toggle("hidden", !hasContent || !hidden);
    } else {
      tocPanel.classList.remove("hidden");
      tocPanel.classList.add("flex");
      tocShow.classList.add("hidden");
    }
  }
  toggleToc() {
    if (!currentFile) return;
    if (this.isMobile()) {
      const wasHidden = tocPanel.classList.contains("hidden");
      tocPanel.classList.toggle("hidden", !wasHidden);
      tocPanel.classList.toggle("flex", wasHidden);
      tocShow.classList.toggle("hidden", wasHidden);
      return;
    }
    const path = currentFile.path;
    this.tocHiddenMap[path] = !this.isTocHiddenForCurrent();
    if (!this.tocHiddenMap[path]) delete this.tocHiddenMap[path];
    localStorage.setItem("toc-hidden-per-doc", JSON.stringify(this.tocHiddenMap));
    this.applyToc();
  }
}
const sidebarEl = document.getElementById("sidebar");
const sidebarToggle = document.getElementById("sidebar-toggle");
const sidebarShowInline = document.getElementById("sidebar-show-inline");
const tocClose = document.getElementById("toc-close");
const tocShow = document.getElementById("toc-show");
const sidebarBackdrop = document.getElementById("sidebar-backdrop");
const layoutChrome = new LayoutChrome();
function toggleSidebar() {
  layoutChrome.toggleSidebar();
}
function toggleToc() {
  layoutChrome.toggleToc();
}
function applyToc() {
  layoutChrome.applyToc();
}
function isMobile() {
  return layoutChrome.isMobile();
}
sidebarBackdrop.addEventListener("click", () => document.body.classList.remove("sidebar-open"));
treeEl.addEventListener("click", (e) => {
  if (layoutChrome.isMobile() && e.target.closest("a[data-path]")) document.body.classList.remove("sidebar-open");
});
window.addEventListener("resize", () => {
  if (!layoutChrome.isMobile()) document.body.classList.remove("sidebar-open");
  layoutChrome.applySidebar();
  layoutChrome.applyToc();
});
sidebarToggle.addEventListener("click", toggleSidebar);
sidebarShowInline.addEventListener("click", toggleSidebar);
tocClose.addEventListener("click", toggleToc);
tocShow.addEventListener("click", toggleToc);
layoutChrome.applySidebar();

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
const _CommandPalette = class _CommandPalette {
  constructor() {
    __publicField(this, "backdrop", document.getElementById("palette-backdrop"));
    __publicField(this, "input", document.getElementById("palette-input"));
    __publicField(this, "list", document.getElementById("palette-list"));
    __publicField(this, "count", document.getElementById("palette-count"));
    __publicField(this, "items", []);
    __publicField(this, "idx", 0);
    __publicField(this, "nav", []);
    // actions + files matched by name/path (instant)
    __publicField(this, "content", []);
    // files matched by content (async, via getSearchHits)
    __publicField(this, "searchDebounce", null);
    __publicField(this, "searchSeq", 0);
    // Static command rows. Built once at load (i18n labels are fixed for the session, as before); the
    // closures capture `this` for the palette-close actions, so this is an instance field, not static.
    __publicField(this, "actions");
    this.actions = [
      {
        kind: "action",
        label: t("actHome"),
        hint: t("actHomeHint"),
        icon: "home",
        action: () => {
          showWelcome();
          history.replaceState(null, "", location.pathname);
        }
      },
      { kind: "action", label: t("actSidebar"), hint: "Ctrl+B", icon: "sidebar", action: toggleSidebar },
      { kind: "action", label: t("actToc"), hint: "Ctrl+J", icon: "toc", action: toggleToc },
      {
        kind: "action",
        label: t("actEdit"),
        hint: "E",
        icon: "edit",
        action: () => {
          if (currentFile && !editMode) enterEditMode();
        }
      },
      {
        kind: "action",
        label: t("actDownload"),
        hint: "",
        icon: "download",
        action: () => {
          if (currentFile) document.getElementById("btn-download").click();
        }
      },
      {
        kind: "action",
        label: t("actSearch"),
        hint: "/",
        icon: "search",
        action: () => {
          this.close();
          searchEl.focus();
        }
      },
      {
        kind: "action",
        label: t("actGraph"),
        hint: "Ctrl+G",
        icon: "graph",
        action: () => {
          this.close();
          mindGraph.open();
        }
      },
      { kind: "action", label: t("actReload"), hint: "F5", icon: "reload", action: () => location.reload() }
    ];
    this.input.addEventListener("input", (e) => this.renderResults(e.target.value));
    this.input.addEventListener("keydown", (e) => this.onInputKey(e));
    this.backdrop.addEventListener("click", (e) => {
      if (e.target === this.backdrop) this.close();
    });
  }
  open() {
    this.backdrop.classList.remove("hidden");
    this.input.value = "";
    this.renderResults("");
    setTimeout(() => this.input.focus(), 0);
  }
  close() {
    this.backdrop.classList.add("hidden");
  }
  iconSvg(name) {
    const p = _CommandPalette.ICON_PATHS[name] || _CommandPalette.ICON_PATHS.file;
    return '<svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="' + p + '"/></svg>';
  }
  renderResults(q) {
    const rawQuery = q.trim();
    q = rawQuery.toLowerCase();
    const nav = [];
    for (const a of this.actions) {
      if (!q || a.label.toLowerCase().includes(q)) nav.push(a);
    }
    const seen = /* @__PURE__ */ new Set();
    for (const f of Object.values(fileMap)) {
      if (f.ext !== ".md") continue;
      if (!q || f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)) {
        nav.push({ kind: "file", label: f.name, hint: f.path, file: f, query: rawQuery });
        seen.add(f.path);
      }
    }
    this.nav = nav;
    this.content = [];
    this.paint();
    const seq = ++this.searchSeq;
    if (this.searchDebounce) clearTimeout(this.searchDebounce);
    if (q.length >= 2) {
      this.searchDebounce = setTimeout(async () => {
        let hits;
        try {
          hits = await getSearchHits(rawQuery);
        } catch (e) {
          return;
        }
        if (seq !== this.searchSeq) return;
        const extra = [];
        for (const hit of hits) {
          if (seen.has(hit.path)) continue;
          const f = fileMap[hit.path];
          if (f) extra.push({ kind: "file", label: f.name, hint: f.path, file: f, snippet: hit.snippet, query: rawQuery });
        }
        this.content = extra;
        this.paint();
      }, 160);
    }
  }
  paint() {
    const items = this.nav.concat(this.content);
    this.items = items.slice(0, 30);
    this.idx = 0;
    this.count.textContent = items.length > 30 ? t("paletteResultsCapped", items.length) : t("nResults", items.length);
    this.list.innerHTML = this.items.map((item, i) => {
      const secondary = item.snippet ? '<div class="text-[10px] text-ink-400 truncate">' + escapeHtml(item.snippet) + "</div>" : item.hint ? '<div class="text-[10px] text-ink-500 truncate font-mono">' + escapeHtml(item.hint) + "</div>" : "";
      const kbd = item.kind === "action" && item.hint ? '<kbd class="text-[10px] text-ink-500 bg-black/30 border subtle-border px-1.5 py-0.5 rounded font-mono">' + escapeHtml(item.hint) + "</kbd>" : "";
      return `
    <li data-idx="${i}" class="palette-item flex items-center gap-3 px-4 py-2.5 cursor-pointer ${i === 0 ? "palette-active" : ""}">
      <span class="text-ink-400">${this.iconSvg(item.icon || (item.kind === "file" ? "file" : "edit"))}</span>
      <div class="flex-1 min-w-0">
        <div class="text-sm text-ink-100 truncate">${escapeHtml(item.label)}</div>
        ${secondary}
      </div>
      ${kbd}
    </li>`;
    }).join("");
    this.list.querySelectorAll(".palette-item").forEach((el, i) => {
      el.addEventListener("mouseenter", () => {
        this.idx = i;
        this.updateHighlight();
      });
      el.addEventListener("click", () => this.select(i));
    });
  }
  updateHighlight() {
    this.list.querySelectorAll(".palette-item").forEach((li, i) => {
      li.classList.toggle("palette-active", i === this.idx);
    });
    const active = this.list.querySelector(".palette-active");
    if (active) active.scrollIntoView({ block: "nearest" });
  }
  select(i) {
    const item = this.items[i];
    if (!item) return;
    this.close();
    if (item.kind === "action") item.action();
    else if (item.kind === "file") {
      showMarkdown(item.file, item.query);
      history.replaceState(null, "", "#" + encodeURIComponent(item.file.path));
    }
  }
  onInputKey(e) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.idx = Math.min(this.items.length - 1, this.idx + 1);
      this.updateHighlight();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.idx = Math.max(0, this.idx - 1);
      this.updateHighlight();
    } else if (e.key === "Enter") {
      e.preventDefault();
      this.select(this.idx);
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.close();
    }
  }
};
__publicField(_CommandPalette, "ICON_PATHS", {
  home: "M3 12l9-9 9 9M5 10v10a1 1 0 001 1h3v-7h6v7h3a1 1 0 001-1V10",
  sidebar: "M4 6h16M4 12h7M4 18h16",
  toc: "M4 6h16M4 12h16M4 18h7",
  edit: "M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z",
  download: "M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4",
  search: "M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z",
  reload: "M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15",
  file: "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z",
  graph: "M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"
});
let CommandPalette = _CommandPalette;
const commandPalette = new CommandPalette();

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
class Pins {
  constructor() {
    __publicField(this, "section", document.getElementById("pinned-section"));
    __publicField(this, "list", document.getElementById("pinned-list"));
    __publicField(this, "btn", document.getElementById("btn-pin"));
    __publicField(this, "btnIcon", document.getElementById("btn-pin-icon"));
    __publicField(this, "pins", []);
    try {
      this.pins = (JSON.parse(localStorage.getItem("kb-pins") || "[]") || []).filter((p) => fileMap[p]);
    } catch (e) {
      this.pins = [];
    }
    this.btn.addEventListener("click", () => {
      if (currentFile) this.toggle(currentFile.path);
    });
    this.render();
  }
  save() {
    try {
      localStorage.setItem("kb-pins", JSON.stringify(this.pins));
    } catch (e) {
    }
  }
  isPinned(path) {
    return this.pins.includes(path);
  }
  toggle(path) {
    if (!path) return;
    const i = this.pins.indexOf(path);
    if (i >= 0) this.pins.splice(i, 1);
    else this.pins.unshift(path);
    this.save();
    this.render();
    if (currentFile) this.updateButton(currentFile);
  }
  updateButton(file) {
    if (!file || file.ext !== ".md") {
      this.btn.classList.add("hidden");
      return;
    }
    this.btn.classList.remove("hidden");
    const on = this.isPinned(file.path);
    this.btnIcon.setAttribute("fill", on ? "currentColor" : "none");
    this.btn.classList.toggle("text-amber-300", on);
    this.btn.title = on ? t("unpin") : t("pin");
  }
  render() {
    const items = this.pins.map((p) => fileMap[p]).filter((f) => !!f);
    if (!items.length) {
      this.section.classList.add("hidden");
      this.list.innerHTML = "";
      return;
    }
    this.section.classList.remove("hidden");
    this.list.innerHTML = items.map(
      (f) => `
    <li class="overflow-hidden group flex items-center">
      <a class="tree-item flex-1 min-w-0 flex items-center px-2 py-1 rounded cursor-pointer" data-pinpath="${escapeHtml(f.path)}">
        <span class="block text-xs text-ink-200 truncate w-full">${escapeHtml(f.name)}</span>
      </a>
      <button class="px-1.5 text-ink-600 hover:text-rose-300 opacity-0 group-hover:opacity-100 transition-opacity" data-unpin="${escapeHtml(f.path)}" title="${escapeHtml(t("unpin"))}">&times;</button>
    </li>`
    ).join("");
    this.list.querySelectorAll("[data-pinpath]").forEach(
      (a) => a.addEventListener("click", (e) => {
        e.preventDefault();
        const f = fileMap[a.dataset.pinpath];
        if (f) {
          showMarkdown(f);
          history.replaceState(null, "", "#" + encodeURIComponent(f.path));
        }
      })
    );
    this.list.querySelectorAll("[data-unpin]").forEach(
      (b) => b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.toggle(b.dataset.unpin);
      })
    );
  }
}
const pins = new Pins();
function updatePinButton(file) {
  pins.updateButton(file);
}
if (EMBED_MIND) {
  showWelcome();
} else {
  routeFromHash();
}

class GraphLayout {
  constructor(canvas, palette) {
    this.canvas = canvas;
    this.palette = palette;
  }
  // Build the whole graph model from the live file map + the backlinks index: folder families →
  // hierarchical color + layout anchors, doc/tag nodes, wikilink/tag edges, degree-scaled radii and
  // the "recent" halo flag. Pure (no DOM): returns the fresh state plus the counts for the stats line.
  buildGraphModel(idx) {
    const nodes = [];
    const byPath = {};
    const tagNodes = {};
    const GRAPH_EXTS = /* @__PURE__ */ new Set([".md", ".html", ".pdf", ".docx"]);
    const famSet = /* @__PURE__ */ new Set();
    const subByFam = {};
    for (const f of Object.values(fileMap)) {
      if (!GRAPH_EXTS.has(f.ext)) continue;
      const fp = f.path.split("/");
      const isRemoteDoc = f.path.startsWith("remotes/");
      const fam = isRemoteDoc ? "⧫ " + (fp[1] || "node") : fp.length > 1 ? fp[0] : "";
      if (!fam) continue;
      famSet.add(fam);
      if (!isRemoteDoc && fp.length > 2) {
        (subByFam[fam] = subByFam[fam] || /* @__PURE__ */ new Set()).add(fp[1]);
      }
    }
    const families = [...famSet].sort();
    const regionAnchors = {};
    const subAnchors = {};
    const RING = Math.max(260, 78 * families.length);
    this.palette.familyHue = {};
    families.forEach((fam, i) => {
      this.palette.familyHue[fam] = i * 137.5 % 360;
      const a = i / families.length * Math.PI * 2;
      regionAnchors[fam] = { x: Math.cos(a) * RING, y: Math.sin(a) * RING };
      const subs = subByFam[fam] ? [...subByFam[fam]].sort() : [];
      subs.forEach((sub, k) => {
        const a2 = a + k / subs.length * Math.PI * 2;
        subAnchors[fam + "/" + sub] = {
          x: regionAnchors[fam].x + Math.cos(a2) * 130,
          y: regionAnchors[fam].y + Math.sin(a2) * 130
        };
      });
    });
    for (const f of Object.values(fileMap)) {
      if (!GRAPH_EXTS.has(f.ext)) continue;
      const parts = f.path.split("/");
      const isRemote = f.path.startsWith("remotes/");
      const region = isRemote ? "⧫ " + (parts[1] || "node") : parts.length > 1 ? parts[0] : "";
      const subRegion = !isRemote && parts.length > 2 ? parts[1] : "";
      const subKey = subRegion ? region + "/" + subRegion : "";
      const anchor = subAnchors[subKey] || regionAnchors[region] || null;
      const n = {
        kind: "doc",
        path: f.path,
        name: f.name.replace(/\.(md|html|pdf|docx)$/i, ""),
        doctype: f.ext,
        tags: f.tags || [],
        region,
        subRegion,
        subKey,
        remote: isRemote,
        mtime: f.mtime || 0,
        recent: false,
        // Seed near the folder's zone so the layout settles already-organized.
        x: anchor ? anchor.x + (Math.random() - 0.5) * 70 : (Math.random() - 0.5) * 520,
        y: anchor ? anchor.y + (Math.random() - 0.5) * 70 : (Math.random() - 0.5) * 520,
        vx: 0,
        vy: 0,
        deg: 0,
        // Remote nodes get AI teal; otherwise color = family hue + subfolder tint.
        color: isRemote ? "#59d0cf" : this.palette.hierColor(region, subRegion),
        r: 0
      };
      nodes.push(n);
      byPath[f.path] = n;
    }
    const edges = [];
    const docCount = nodes.length;
    let linkCount = 0;
    for (const dn of nodes.slice()) {
      for (const tg of dn.tags) {
        let tn = tagNodes[tg];
        if (!tn) {
          tn = {
            kind: "tag",
            tag: tg,
            name: "#" + tg,
            color: this.palette.tagColor(tg),
            docs: 0,
            x: (Math.random() - 0.5) * 520,
            y: (Math.random() - 0.5) * 520,
            vx: 0,
            vy: 0,
            deg: 0,
            r: 0
          };
          tagNodes[tg] = tn;
          nodes.push(tn);
        }
        tn.docs = (tn.docs ?? 0) + 1;
        edges.push({ s: dn, t: tn, kind: "tag" });
        dn.deg++;
        tn.deg++;
      }
    }
    const seen = /* @__PURE__ */ new Set();
    for (const [p, e] of Object.entries(idx)) {
      for (const q of e.out || []) {
        const key = p < q ? p + "\n" + q : q + "\n" + p;
        if (seen.has(key)) continue;
        seen.add(key);
        const src = byPath[p], dst = byPath[q];
        if (src && dst) {
          edges.push({ s: src, t: dst, kind: "link" });
          src.deg++;
          dst.deg++;
          linkCount++;
        }
      }
    }
    for (const n of nodes) n.r = (n.kind === "tag" ? 3 : 5) + Math.sqrt(n.deg) * (n.kind === "tag" ? 1.2 : 2.6);
    const RECENT_CUTOFF = Date.now() / 1e3 - 14 * 86400;
    for (const n of nodes) if (n.kind === "doc") n.recent = n.mtime > RECENT_CUTOFF;
    const tagCount = Object.keys(tagNodes).length;
    const state = {
      allNodes: nodes,
      allEdges: edges,
      nodes,
      edges,
      regionAnchors,
      subAnchors,
      ring: RING,
      mode: "organic",
      showTags: false,
      // de-cluttered by default; toggle to bring the tag web back
      clusters: [],
      families: [],
      cam: { scale: 1, ox: 0, oy: 0 },
      ticks: 0,
      hover: null,
      drag: null,
      panFrom: null,
      moved: false
    };
    return { state, docCount, linkCount, tagCount };
  }
  // ── Mind view modes: "organic" (force-directed brain) ⇄ "structured" (folder map) ──
  // Which nodes/edges are active for the current mode. Organic shows the folder-zoned force graph with
  // TAGS HIDDEN by default — tags carry ~3× the edges of real wikilinks and drown the structure. The
  // hero (EMBED_MIND) keeps its full tag web for the landing.
  applyView(st) {
    const tags = st.mode === "organic" && (st.showTags || EMBED_MIND);
    st.nodes = tags ? st.allNodes : st.allNodes.filter((n) => n.kind !== "tag");
    st.edges = st.allEdges.filter((e) => e.kind === "link" || tags && e.kind === "tag");
    st.hover = null;
  }
  // Re-seed organic positions near each node's folder anchor (used when switching back from the
  // structured map so the force layout relaxes from an already-zoned start).
  reseedOrganic(st) {
    for (const n of st.nodes) {
      const anc = st.subAnchors && st.subAnchors[n.subKey ?? ""] || st.regionAnchors && st.regionAnchors[n.region ?? ""];
      n.x = anc ? anc.x + (Math.random() - 0.5) * 70 : (Math.random() - 0.5) * 520;
      n.y = anc ? anc.y + (Math.random() - 0.5) * 70 : (Math.random() - 0.5) * 520;
      n.vx = 0;
      n.vy = 0;
    }
  }
  // Fit the camera to the whole layout. Organic fits the anchor ring; structured fits the fixed packed
  // bbox. The hero keeps its own framing.
  fitCamera(st) {
    st.cam.ox = this.canvas.clientWidth / 2;
    st.cam.oy = this.canvas.clientHeight / 2;
    if (EMBED_MIND) return;
    let half;
    if (st.mode === "structured") {
      half = 60;
      for (const n of st.nodes) half = Math.max(half, Math.abs(n.x) + n.r, Math.abs(n.y) + n.r);
      half += 70;
    } else {
      half = (st.ring || 360) + 220;
    }
    st.cam.scale = Math.min(1, Math.min(this.canvas.clientWidth, this.canvas.clientHeight) / (2 * half) * 0.92);
  }
  // Deterministic "map" layout: docs pack in a phyllotaxis disc per subfolder; subfolder discs pack
  // into a family box; family boxes pack across the canvas. No physics → tidy and stable, the opposite
  // of the organic hairball. Fills st.clusters + st.families for the scaffold, sets each doc's fixed x/y.
  layoutStructured(st) {
    const docs = st.nodes.filter((n) => n.kind === "doc");
    const fams = {};
    for (const n of docs) {
      const fam = n.region || "·root";
      const ckey = n.subRegion || "";
      const f = fams[fam] = fams[fam] || { name: fam, clusters: {}, _items: [], _r: 0 };
      (f.clusters[ckey] = f.clusters[ckey] || { sub: ckey, docs: [], r: 0 }).docs.push(n);
    }
    const DOC_SP = 15, CL_GAP = 22, FAM_GAP = 56, FAM_PAD = 28;
    const packCluster = (c) => {
      let maxR = 0;
      c.docs.forEach((n, i) => {
        const a = i * 2.399963;
        const r = DOC_SP * Math.sqrt(i + 0.6);
        n._lx = Math.cos(a) * r;
        n._ly = Math.sin(a) * r;
        maxR = Math.max(maxR, r + (n.r || 6));
      });
      c.r = Math.max(18, maxR + 8);
    };
    const rowPack = (items, maxW, gap) => {
      let x = 0, y = 0, rowH = 0, totalW = 0;
      for (const it of items) {
        if (x > 0 && x + it.w > maxW) {
          x = 0;
          y += rowH + gap;
          rowH = 0;
        }
        it.x = x;
        it.y = y;
        x += it.w + gap;
        rowH = Math.max(rowH, it.h);
        totalW = Math.max(totalW, x - gap);
      }
      return { w: totalW, h: y + rowH };
    };
    const famList = Object.values(fams);
    for (const f of famList) {
      const cl = Object.values(f.clusters);
      cl.forEach(packCluster);
      cl.sort((a, b) => b.r - a.r);
      f._items = cl.map((c) => ({ c, w: c.r * 2, h: c.r * 2, x: 0, y: 0, _dx: 0, _dy: 0 }));
      const area = f._items.reduce((s, it) => s + it.w * it.h, 0);
      const box = rowPack(f._items, Math.max(f._items[0].w, Math.sqrt(area) * 1.25), CL_GAP);
      const bcx = box.w / 2, bcy = box.h / 2;
      let rad = 0;
      for (const it of f._items) {
        it._dx = it.x + it.c.r - bcx;
        it._dy = it.y + it.c.r - bcy;
        rad = Math.max(rad, Math.hypot(it._dx, it._dy) + it.c.r);
      }
      f._r = rad + FAM_PAD;
    }
    famList.sort((a, b) => b._r - a._r);
    const famItems = famList.map((f) => ({ f, w: f._r * 2, h: f._r * 2, x: 0, y: 0 }));
    const totalArea = famItems.reduce((s, it) => s + it.w * it.h, 0);
    const total = rowPack(famItems, Math.max(famItems[0].w, Math.sqrt(totalArea) * 1.3), FAM_GAP);
    const cx = total.w / 2, cy = total.h / 2;
    const clusters = [];
    const families = [];
    for (const fit of famItems) {
      const f = fit.f;
      const fx = fit.x + f._r - cx, fy = fit.y + f._r - cy;
      families.push({ x: fx, y: fy, r: f._r, name: f.name, color: this.palette.hierColor(f.name, "") });
      for (const it of f._items) {
        const ccx = fx + it._dx, ccy = fy + it._dy;
        it.c.docs.forEach((n) => {
          n.x = ccx + n._lx;
          n.y = ccy + n._ly;
          n.vx = 0;
          n.vy = 0;
        });
        clusters.push({ x: ccx, y: ccy, r: it.c.r, sub: it.c.sub, color: this.palette.hierColor(f.name, it.c.sub) });
      }
    }
    st.clusters = clusters;
    st.families = families;
  }
  simStep(st) {
    const { nodes, edges } = st;
    const REP = 13e3, SPRING = 0.02, REST = 120, CENTER = 34e-4, GRAVITY = 9e-3;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy || 0.01, d = Math.sqrt(d2);
        const f = REP / d2, fx = f * dx / d, fy = f * dy / d;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
      const anc = st.subAnchors && st.subAnchors[a.subKey ?? ""] || st.regionAnchors && st.regionAnchors[a.region ?? ""];
      if (anc) {
        a.vx += (anc.x - a.x) * GRAVITY;
        a.vy += (anc.y - a.y) * GRAVITY;
      } else {
        a.vx -= a.x * CENTER;
        a.vy -= a.y * CENTER;
      }
    }
    for (const e of edges) {
      const a = e.s, b = e.t;
      let dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = SPRING * (d - REST), fx = f * dx / d, fy = f * dy / d;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }
    for (const n of nodes) {
      if (n === st.drag) continue;
      n.vx *= 0.86;
      n.vy *= 0.86;
      n.x += Math.max(-25, Math.min(25, n.vx));
      n.y += Math.max(-25, Math.min(25, n.vy));
    }
  }
}

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
const _GraphPalette = class _GraphPalette {
  constructor() {
    // Hierarchical folder color: a top-level folder maps to a stable family HUE (golden-angle spread,
    // populated once in buildGraphModel so families never collide); the immediate subfolder varies
    // LIGHTNESS/SATURATION within that hue. So a dominant family stays one recognizable hue while its
    // subfolders read as distinct tints.
    __publicField(this, "familyHue", {});
  }
  tagColor(tag) {
    if (!tag) return "#6b7280";
    let h = 0;
    for (let i = 0; i < tag.length; i++) h = h * 31 + tag.charCodeAt(i) >>> 0;
    return _GraphPalette.GRAPH_COLORS[h % _GraphPalette.GRAPH_COLORS.length];
  }
  // HSL→#rrggbb. MUST return the 6-hex form: every consumer appends an alpha byte (n.color + '30',
  // col + '2b', …), so an hsl() string would corrupt every gradient stop.
  hslToHex(h, s, l) {
    s /= 100;
    l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = (k) => {
      const x = (k + h / 30) % 12;
      const c = l - a * Math.max(-1, Math.min(x - 3, 9 - x, 1));
      return Math.round(255 * c).toString(16).padStart(2, "0");
    };
    return "#" + f(0) + f(8) + f(4);
  }
  hierColor(family, sub) {
    if (!family) return "#6b7280";
    let fh = 0;
    for (let i = 0; i < family.length; i++) fh = fh * 31 + family.charCodeAt(i) >>> 0;
    const baseHue = family in this.familyHue ? this.familyHue[family] : fh % 360;
    if (!sub) return this.hslToHex(baseHue, 68, 55);
    let h = 0;
    for (let i = 0; i < sub.length; i++) h = h * 31 + sub.charCodeAt(i) >>> 0;
    const hue = (baseHue + (h % 5 - 2) * 8 + 360) % 360;
    const light = 46 + Math.floor(h / 5) % 5 * 5;
    const sat = 60 + Math.floor(h / 25) % 3 * 9;
    return this.hslToHex(hue, sat, light);
  }
};
__publicField(_GraphPalette, "GRAPH_COLORS", [
  "#5db5e8",
  "#fbc678",
  "#a78bfa",
  "#34d399",
  "#f472b6",
  "#f87171",
  "#22d3ee",
  "#facc15",
  "#c084fc",
  "#4ade80"
]);
let GraphPalette = _GraphPalette;

class GraphRenderer {
  constructor(canvas, palette) {
    this.canvas = canvas;
    this.palette = palette;
  }
  // Organic mode: a translucent radial blob + label per top-level folder, drawn at the centroid/hull
  // of wherever that family's nodes settled.
  drawOrganicZones(ctx, st) {
    const { cam, nodes } = st;
    const regions = {};
    for (const n of nodes) {
      if (n.kind !== "doc" || !n.region) continue;
      (regions[n.region] = regions[n.region] || []).push(n);
    }
    for (const name in regions) {
      const rn = regions[name];
      let cx = 0, cy = 0;
      for (const n of rn) {
        cx += n.x;
        cy += n.y;
      }
      cx /= rn.length;
      cy /= rn.length;
      let rad = 70;
      for (const n of rn) rad = Math.max(rad, Math.hypot(n.x - cx, n.y - cy) + 46);
      const scx = cx * cam.scale + cam.ox, scy = cy * cam.scale + cam.oy, sr = rad * cam.scale;
      const isRemoteRegion = rn.some((n) => n.remote);
      const col = isRemoteRegion ? "#59d0cf" : this.palette.hierColor(name, "");
      const grad = ctx.createRadialGradient(scx, scy, sr * 0.2, scx, scy, sr);
      grad.addColorStop(0, col + (isRemoteRegion ? "3d" : "2b"));
      grad.addColorStop(1, col + "00");
      ctx.beginPath();
      ctx.arc(scx, scy, sr, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
      if (isRemoteRegion) {
        ctx.save();
        ctx.setLineDash([6, 5]);
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = col + "99";
        ctx.beginPath();
        ctx.arc(scx, scy, sr, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      ctx.font = "600 13px Manrope, system-ui, sans-serif";
      ctx.fillStyle = col + (isRemoteRegion ? "ff" : "dd");
      ctx.textAlign = "center";
      ctx.fillText(name, scx, scy - sr + 16);
      ctx.textAlign = "left";
    }
  }
  // Structured "map" mode: a soft labeled container per family, with a thin ring + label per subfolder
  // cluster. Positions come from layoutStructured (fixed, no physics).
  drawStructuredScaffold(ctx, st) {
    const s = st.cam.scale;
    const SX = (x) => x * s + st.cam.ox;
    const SY = (y) => y * s + st.cam.oy;
    for (const f of st.families) {
      const x = SX(f.x), y = SY(f.y), r = f.r * s;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      const grad = ctx.createRadialGradient(x, y, r * 0.25, x, y, r);
      grad.addColorStop(0, f.color + "18");
      grad.addColorStop(1, f.color + "05");
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = f.color + "33";
      ctx.stroke();
      ctx.font = "600 " + Math.max(11, 13 * s) + "px Manrope, system-ui, sans-serif";
      ctx.fillStyle = f.color + "ee";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText(f.name, x, y - r - 7 * s);
      ctx.textAlign = "left";
    }
    ctx.textBaseline = "middle";
    for (const c of st.clusters) {
      if (!c.sub) continue;
      const x = SX(c.x), y = SY(c.y), r = c.r * s;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.lineWidth = 1;
      ctx.strokeStyle = c.color + "40";
      ctx.stroke();
      ctx.font = "500 " + Math.max(9, 11 * s) + "px Manrope, system-ui, sans-serif";
      ctx.fillStyle = c.color + "cc";
      ctx.textAlign = "center";
      ctx.fillText(c.sub, x, y - r - 9 * s);
      ctx.textAlign = "left";
    }
  }
  draw(st) {
    const ctx = this.canvas.getContext("2d");
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    const { cam, nodes, edges, hover } = st;
    const SX = (n) => n.x * cam.scale + cam.ox, SY = (n) => n.y * cam.scale + cam.oy;
    if (st.mode === "structured") {
      this.drawStructuredScaffold(ctx, st);
    } else {
      this.drawOrganicZones(ctx, st);
    }
    const now = performance.now();
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const e of edges) {
      const hot = hover && (e.s === hover || e.t === hover);
      const ax = SX(e.s), ay = SY(e.s), bx = SX(e.t), by = SY(e.t);
      if (e.kind === "link") {
        const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
        const bow = Math.min(26, len * 0.16);
        e._cx = (ax + bx) / 2 - dy / len * bow;
        e._cy = (ay + by) / 2 + dx / len * bow;
        ctx.strokeStyle = hot ? "rgba(196,181,253,0.95)" : "rgba(150,130,246,0.28)";
        ctx.lineWidth = hot ? 2 : 1.1;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.quadraticCurveTo(e._cx, e._cy, bx, by);
        ctx.stroke();
      } else {
        ctx.strokeStyle = hot ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.05)";
        ctx.lineWidth = hot ? 1.2 : 0.7;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
      }
    }
    let pi = 0;
    for (const e of edges) {
      if (e.kind !== "link") continue;
      const ax = SX(e.s), ay = SY(e.s), bx = SX(e.t), by = SY(e.t);
      const tt = (now * 16e-5 + pi++ * 0.1379) % 1, u = 1 - tt;
      const px = u * u * ax + 2 * u * tt * e._cx + tt * tt * bx;
      const py = u * u * ay + 2 * u * tt * e._cy + tt * tt * by;
      const env = Math.sin(tt * Math.PI);
      const gr = 0.9 + env * 1;
      ctx.globalAlpha = 0.3 + env * 0.3;
      ctx.beginPath();
      ctx.arc(px, py, gr, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(200,188,250,0.9)";
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const n of nodes) {
      if (n.kind !== "doc") continue;
      const dim = hover && n !== hover && !n._adj;
      if (dim) continue;
      const r = Math.max(2, n.r * cam.scale), x = SX(n), y = SY(n);
      const breath = n.recent ? 1 + 0.12 * Math.sin(now * 4e-3 + (n._ph || (n._ph = (Math.abs(n.x) + Math.abs(n.y)) % 6.28))) : 1;
      const gr = (r + (n.recent ? 7 : 4)) * 2.1 * breath;
      const g = ctx.createRadialGradient(x, y, 0, x, y, gr);
      g.addColorStop(0, n.color + (n.recent ? "3a" : "30"));
      g.addColorStop(1, n.color + "00");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, gr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    for (const n of nodes) {
      const dim = hover && n !== hover && !n._adj;
      const orphan = n.kind === "doc" && n.deg === 0;
      const r = Math.max(2, n.r * cam.scale), x = SX(n), y = SY(n);
      ctx.globalAlpha = !dim && !hover && orphan ? 0.45 : 1;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = dim ? "rgba(110,110,130,0.3)" : n.kind === "tag" ? n.color + "33" : n.color;
      ctx.fill();
      if (n.kind === "tag") {
        ctx.lineWidth = dim ? 1 : 1.6;
        ctx.strokeStyle = dim ? "rgba(150,150,160,0.3)" : n.color;
        ctx.stroke();
      } else if (n.doctype && n.doctype !== ".md" && !dim) {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "rgba(255,255,255,0.72)";
        ctx.stroke();
      }
      if (n === hover) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#fff";
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    ctx.font = "12px Manrope, system-ui, sans-serif";
    ctx.textBaseline = "middle";
    for (const n of nodes) {
      const tagAlways = n.kind === "tag" && st.showTags && st.mode === "organic";
      if (!(tagAlways || n === hover || n._adj || cam.scale > 1.35)) continue;
      ctx.font = (n.kind === "tag" ? "600 12px" : "12px") + " Manrope, system-ui, sans-serif";
      ctx.fillStyle = hover && n !== hover && !n._adj ? "rgba(150,150,160,0.5)" : n.kind === "tag" ? n.color : "#e5e6e8";
      ctx.fillText(n.name, SX(n) + Math.max(2, n.r * cam.scale) + 4, SY(n));
    }
  }
}

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
class MindGraph {
  constructor() {
    __publicField(this, "overlay", document.getElementById("graph-overlay"));
    __publicField(this, "canvas", document.getElementById("graph-canvas"));
    __publicField(this, "tooltip", document.getElementById("graph-tooltip"));
    __publicField(this, "stats", document.getElementById("graph-stats"));
    // The injected pieces. canvas is declared above so the layout/renderer initializers can read it.
    __publicField(this, "palette", new GraphPalette());
    __publicField(this, "layout", new GraphLayout(this.canvas, this.palette));
    __publicField(this, "renderer", new GraphRenderer(this.canvas, this.palette));
    __publicField(this, "state", null);
    __publicField(this, "raf", null);
    this.canvas.addEventListener("mousedown", (e) => this.onMouseDown(e));
    this.canvas.addEventListener("mousemove", (e) => this.onMouseMove(e));
    this.canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    window.addEventListener("mouseup", () => this.onMouseUp());
    window.addEventListener("resize", () => {
      if (this.state) this.resize();
    });
    document.getElementById("graph-close").addEventListener("click", () => this.close());
    document.getElementById("graph-btn").addEventListener("click", () => this.open());
    document.getElementById("graph-mode-organic")?.addEventListener("click", () => this.setMode("organic"));
    document.getElementById("graph-mode-structured")?.addEventListener("click", () => this.setMode("structured"));
    document.getElementById("graph-tags-toggle")?.addEventListener("click", () => this.toggleTags());
  }
  isOpen() {
    return this.state !== null;
  }
  async open() {
    const idx = await loadBacklinksIndex();
    this.overlay.classList.remove("hidden");
    const model = this.layout.buildGraphModel(idx);
    this.stats.textContent = t("graphStats", model.docCount, model.linkCount, model.tagCount);
    this.state = model.state;
    this.layout.applyView(this.state);
    this.resize();
    this.layout.fitCamera(this.state);
    if (EMBED_MIND) {
      for (let i = 0; i < 480; i++) this.layout.simStep(this.state);
      this.state.ticks = 480;
    }
    if (this.raf != null) cancelAnimationFrame(this.raf);
    this.loop();
    this.updateModeUI();
  }
  close() {
    this.overlay.classList.add("hidden");
    if (this.raf != null) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.state = null;
    this.tooltip.classList.add("hidden");
  }
  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = this.canvas.clientWidth * dpr;
    this.canvas.height = this.canvas.clientHeight * dpr;
    this.canvas.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  loop() {
    const st = this.state;
    if (!st) return;
    if (st.mode !== "structured" && st.ticks < 480) {
      this.layout.simStep(st);
      st.ticks++;
    }
    this.renderer.draw(st);
    this.raf = requestAnimationFrame(() => this.loop());
  }
  nodeAt(st, sx, sy) {
    const { cam, nodes } = st;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const dx = sx - (n.x * cam.scale + cam.ox), dy = sy - (n.y * cam.scale + cam.oy);
      const r = Math.max(6, n.r * cam.scale + 4);
      if (dx * dx + dy * dy <= r * r) return n;
    }
    return null;
  }
  onMouseDown(e) {
    const st = this.state;
    if (!st) return;
    st.drag = this.nodeAt(st, e.offsetX, e.offsetY);
    st.panFrom = { x: e.offsetX, y: e.offsetY, ox: st.cam.ox, oy: st.cam.oy };
    st.moved = false;
  }
  onMouseMove(e) {
    const st = this.state;
    if (!st) return;
    if (st.panFrom) {
      st.moved = true;
      if (st.drag) {
        st.drag.x = (e.offsetX - st.cam.ox) / st.cam.scale;
        st.drag.y = (e.offsetY - st.cam.oy) / st.cam.scale;
        st.drag.vx = st.drag.vy = 0;
      } else {
        st.cam.ox = st.panFrom.ox + (e.offsetX - st.panFrom.x);
        st.cam.oy = st.panFrom.oy + (e.offsetY - st.panFrom.y);
      }
      return;
    }
    const n = this.nodeAt(st, e.offsetX, e.offsetY);
    if (n !== st.hover) {
      st.nodes.forEach((x) => x._adj = false);
      if (n)
        for (const e2 of st.edges) {
          if (e2.s === n) e2.t._adj = true;
          else if (e2.t === n) e2.s._adj = true;
        }
      st.hover = n;
    }
    this.canvas.style.cursor = n ? "pointer" : "grab";
    if (n) {
      this.tooltip.textContent = n.kind === "tag" ? n.name + "  " + t("nDocs", n.docs) : n.name + (n.tags.length ? "  " + n.tags.map((tag) => "#" + tag).join(" ") : "");
      this.tooltip.style.left = e.offsetX + 14 + "px";
      this.tooltip.style.top = e.offsetY + 12 + "px";
      this.tooltip.classList.remove("hidden");
    } else this.tooltip.classList.add("hidden");
  }
  onMouseUp() {
    const st = this.state;
    if (!st || !st.panFrom) return;
    const node = st.drag, moved = st.moved;
    st.panFrom = null;
    st.drag = null;
    if (node && !moved) {
      if (node.kind === "tag") {
        this.close();
        showTag(node.tag);
        return;
      }
      const f = fileMap[node.path];
      this.close();
      if (f) {
        showMarkdown(f);
        history.replaceState(null, "", "#" + encodeURIComponent(f.path));
      }
    }
  }
  onWheel(e) {
    const st = this.state;
    if (!st) return;
    e.preventDefault();
    const ns = Math.max(0.2, Math.min(4, st.cam.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    st.cam.ox = e.offsetX - (e.offsetX - st.cam.ox) * (ns / st.cam.scale);
    st.cam.oy = e.offsetY - (e.offsetY - st.cam.oy) * (ns / st.cam.scale);
    st.cam.scale = ns;
  }
  // ── View-mode toggle: organic brain ⇄ structured folder map (+ tag-layer toggle) ──
  updateModeUI() {
    const st = this.state;
    const orgBtn = document.getElementById("graph-mode-organic");
    if (!st || !orgBtn) return;
    const strBtn = document.getElementById("graph-mode-structured");
    const tagBtn = document.getElementById("graph-tags-toggle");
    const setActive = (btn, on) => {
      btn.classList.toggle("bg-white/15", on);
      btn.classList.toggle("text-white", on);
      btn.classList.toggle("text-ink-400", !on);
    };
    setActive(orgBtn, st.mode === "organic");
    setActive(strBtn, st.mode === "structured");
    if (tagBtn) {
      tagBtn.style.opacity = st.mode === "organic" ? "1" : ".4";
      tagBtn.style.pointerEvents = st.mode === "organic" ? "auto" : "none";
      setActive(tagBtn, st.mode === "organic" && st.showTags);
    }
  }
  setMode(mode) {
    const st = this.state;
    if (!st || st.mode === mode) return;
    st.mode = mode;
    this.layout.applyView(st);
    if (mode === "structured") {
      this.layout.layoutStructured(st);
    } else {
      this.layout.reseedOrganic(st);
    }
    st.ticks = 0;
    st.hover = null;
    this.layout.fitCamera(st);
    this.updateModeUI();
  }
  toggleTags() {
    const st = this.state;
    if (!st || st.mode !== "organic") return;
    st.showTags = !st.showTags;
    this.layout.applyView(st);
    if (st.showTags) {
      for (const n of st.nodes) {
        if (n.kind !== "tag") continue;
        let cx = 0, cy = 0, k = 0;
        for (const e of st.edges) {
          if (e.kind === "tag" && e.t === n) {
            cx += e.s.x;
            cy += e.s.y;
            k++;
          }
        }
        if (k) {
          n.x = cx / k + (Math.random() - 0.5) * 30;
          n.y = cy / k + (Math.random() - 0.5) * 30;
        }
        n.vx = 0;
        n.vy = 0;
      }
    }
    st.ticks = Math.min(st.ticks, 360);
    this.updateModeUI();
  }
}

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
class TasksOverlay {
  // kept for the "show done" toggle re-render
  constructor() {
    __publicField(this, "overlay", document.getElementById("tasks-overlay"));
    __publicField(this, "list", document.getElementById("tasks-list"));
    __publicField(this, "stats", document.getElementById("tasks-stats"));
    __publicField(this, "showDoneBox", document.getElementById("tasks-show-done"));
    __publicField(this, "index", []);
    document.getElementById("tasks-btn").addEventListener("click", () => this.open());
    document.getElementById("tasks-close").addEventListener("click", () => this.close());
    this.showDoneBox.addEventListener("change", () => this.render(this.index));
  }
  isOpen() {
    return !this.overlay.classList.contains("hidden");
  }
  async open() {
    this.overlay.classList.remove("hidden");
    this.showLoading();
    this.index = await this.loadIndex();
    this.render(this.index);
  }
  close() {
    this.overlay.classList.add("hidden");
  }
  async loadIndex() {
    if (IS_OFFLINE_BUILD) return EMBED_TASKS || [];
    await sse.drainTaskWrites();
    try {
      const res = await fetch("/_tasks-index.json", { cache: "no-cache" });
      return res.ok ? await res.json() : [];
    } catch (e) {
      return [];
    }
  }
  // Skeleton mirrors render() layout (no jump on swap). Seeded LCG → same skeleton each open.
  renderSkeleton() {
    let state = 2654435769 >>> 0;
    const next = () => state = state * 1664525 + 1013904223 >>> 0;
    const range = (min, max) => min + next() % (max - min + 1);
    const sections = [];
    for (let s = 0; s < 3; s++) {
      const rows = [];
      for (let r = 0, n = range(2, 4); r < n; r++) {
        rows.push(
          '<div style="display:flex;align-items:flex-start;gap:0.75rem;padding:0.5rem 0.75rem;"><span class="skeleton" style="flex-shrink:0;width:19px;height:19px;border-radius:5px;margin-top:3px;"></span><span class="skeleton" style="height:0.95rem;width:' + range(45, 90) + '%;margin-top:5px;"></span></div>'
        );
      }
      sections.push(
        '<div style="margin-bottom:1.75rem;"><div class="skeleton" style="height:0.7rem;width:' + range(22, 42) + '%;border-radius:4px;margin-bottom:0.6rem;"></div>' + rows.join("") + "</div>"
      );
    }
    return sections.join("");
  }
  showLoading() {
    this.stats.innerHTML = '<span class="skeleton" style="display:inline-block;height:0.7rem;width:9rem;border-radius:4px;vertical-align:middle;"></span>';
    this.list.innerHTML = '<div aria-busy="true" aria-label="' + t("tasksLoading") + '">' + this.renderSkeleton() + "</div>";
  }
  // Normalize a task line for matching against rendered text: the index stores raw markdown, the
  // rendered doc shows plain text. Drop wikilink/link syntax + inline marks, lowercase, collapse spaces.
  normTask(s) {
    return (s || "").toLowerCase().replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "$1").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_`~]/g, "").replace(/\s+/g, " ").trim();
  }
  // Scroll the open doc to the checkbox of `task` and flash it. Primary = the Nth rendered checkbox
  // (task._docIndex); on rare index/render drift, fall back to matching by text, then a loose highlight.
  scrollToCheckbox(task) {
    const want = this.normTask(task.text);
    const boxes = [...contentEl.querySelectorAll("input[type=checkbox]")];
    const liOf = (b) => b ? b.closest("li") || b.parentElement : null;
    let li = liOf(boxes[task._docIndex ?? -1]);
    if (!(li && want && this.normTask(li.textContent || "").includes(want))) {
      li = null;
      if (want) {
        for (const b of boxes) {
          const candidate = liOf(b);
          if (candidate && this.normTask(candidate.textContent || "").includes(want)) {
            li = candidate;
            break;
          }
        }
      }
    }
    if (!li) {
      highlightFirstMatch(contentEl, task.text);
      return;
    }
    const el = li;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.style.transition = "background-color 0.4s";
    el.style.backgroundColor = "rgba(89,208,207,0.18)";
    el.style.borderRadius = "4px";
    setTimeout(() => {
      el.style.backgroundColor = "";
    }, 1600);
  }
  // Render a task's inline markdown like the rest of the app. Links/images stripped to text (the row
  // is itself a button — no nested navigation). Any error falls back to ESCAPED text, never raw HTML.
  renderTaskText(s) {
    try {
      return DOMPurify.sanitize(marked.parseInline(s), { FORBID_TAGS: ["a", "img"] });
    } catch (e) {
      return escapeHtml(s);
    }
  }
  render(tasks) {
    const perDoc = {};
    for (const tk of tasks) tk._docIndex = perDoc[tk.path] = (perDoc[tk.path] ?? -1) + 1;
    const open = tasks.filter((x) => !x.done).length;
    this.stats.textContent = t("tasksStats", open, tasks.length);
    const visible = this.showDoneBox.checked ? tasks : tasks.filter((x) => !x.done);
    this.list.innerHTML = "";
    if (!visible.length) {
      const empty = document.createElement("div");
      empty.className = "text-ink-500 text-sm font-sans";
      empty.textContent = t("tasksEmpty");
      this.list.appendChild(empty);
      return;
    }
    const byDoc = {};
    for (const task of visible) (byDoc[task.path] = byDoc[task.path] || []).push(task);
    for (const p of Object.keys(byDoc).sort()) {
      const file = fileMap[p];
      const section = document.createElement("div");
      section.style.marginBottom = "1.75rem";
      const head = document.createElement("div");
      head.className = "text-[11px] uppercase tracking-[0.12em] text-ink-500 font-bold font-mono";
      head.style.marginBottom = "0.6rem";
      head.textContent = p;
      section.appendChild(head);
      for (const task of byDoc[p]) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "flex items-start gap-3 w-full text-left px-3 py-2 rounded-lg hover:bg-white/5 text-base font-sans";
        const box = document.createElement("span");
        box.className = "flex-shrink-0";
        box.style.marginTop = "3px";
        box.innerHTML = task.done ? '<svg viewBox="0 0 24 24" fill="none" class="text-accent" style="width:19px;height:19px"><rect x="3" y="3" width="18" height="18" rx="5" fill="currentColor"/><path d="M7.4 12.4l3 3 6.2-6.7" fill="none" stroke="#0e0d12" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>' : '<svg viewBox="0 0 24 24" fill="none" class="text-ink-500" style="width:19px;height:19px"><rect x="3" y="3" width="18" height="18" rx="5" stroke="currentColor" stroke-width="2"/></svg>';
        const txt = document.createElement("span");
        txt.className = task.done ? "text-ink-500" : "text-ink-100";
        if (task.done) txt.style.textDecoration = "line-through";
        txt.innerHTML = this.renderTaskText(task.text);
        row.appendChild(box);
        row.appendChild(txt);
        row.addEventListener("click", async () => {
          this.close();
          if (!file) return;
          await showMarkdown(file);
          history.replaceState(null, "", "#" + encodeURIComponent(file.path));
          this.scrollToCheckbox(task);
        });
        section.appendChild(row);
      }
      this.list.appendChild(section);
    }
  }
}
const tasksOverlay = new TasksOverlay();

const todoWidget = document.getElementById("todo-widget");
const todoHeader = document.getElementById("todo-header");
const todoBody = document.getElementById("todo-body");
const todoChevron = document.getElementById("todo-chevron");
const todoList = document.getElementById("todo-list");
const todoForm = document.getElementById("todo-form");
const todoInput = document.getElementById("todo-input");
const todoCount = document.getElementById("todo-count");
const todoBubbleCount = document.getElementById("todo-bubble-count");
const todoStatus = document.getElementById("todo-status");
let collapsed;
{
  const stored = localStorage.getItem("todo-collapsed");
  collapsed = stored === null ? isMobile() : stored === "1";
}
function applyCollapsed() {
  if (collapsed) {
    todoBody.classList.add("hidden");
    todoChevron.style.transform = "rotate(-90deg)";
    todoWidget.classList.add("is-collapsed");
  } else {
    todoBody.classList.remove("hidden");
    todoChevron.style.transform = "";
    todoWidget.classList.remove("is-collapsed");
  }
}
applyCollapsed();
todoHeader.addEventListener("click", () => {
  collapsed = !collapsed;
  localStorage.setItem("todo-collapsed", collapsed ? "1" : "0");
  applyCollapsed();
});
function updateHomeTodoStat() {
  const el = document.getElementById("home-todo-stat");
  if (!el) return;
  el.textContent = todos.length ? `${todos.filter((td) => td.done).length}/${todos.length}` : "–";
}
function buildFavicon(count) {
  const badge = count > 0 ? "<circle cx='23' cy='9' r='8' fill='#ef4444' stroke='#0e0d12' stroke-width='1.5'/><text x='23' y='12.5' font-family='system-ui,Arial,sans-serif' font-size='" + (count > 9 ? "8.5" : "10") + "' font-weight='800' fill='white' text-anchor='middle'>" + (count > 9 ? "9+" : count) + "</text>" : "";
  const svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><defs><radialGradient id='sky' cx='50%' cy='40%' r='65%'><stop offset='0%' stop-color='#1f1d2a'/><stop offset='100%' stop-color='#0a0a12'/></radialGradient><radialGradient id='glow' cx='50%' cy='50%' r='50%'><stop offset='0%' stop-color='#fbc678' stop-opacity='0.75'/><stop offset='100%' stop-color='#fbc678' stop-opacity='0'/></radialGradient></defs><rect width='32' height='32' rx='7' fill='url(#sky)'/><circle cx='16' cy='16' r='9' fill='none' stroke='#fff' stroke-width='0.7' opacity='0.4'/><circle cx='16' cy='16' r='1.2' fill='#fff' opacity='0.85'/><circle cx='22.36' cy='9.64' r='4' fill='url(#glow)'/><circle cx='22.36' cy='9.64' r='1.9' fill='#fbc678'/>" + badge + "</svg>";
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}
function updateTabBadge() {
  const pending = todos.filter((td) => !td.done).length;
  document.title = pending > 0 ? "(" + pending + ") " + SITE_NAME : SITE_NAME;
  const link = document.querySelector("link[rel='icon']");
  if (link) link.href = buildFavicon(pending);
}
let showDoneTodos = localStorage.getItem("todo-show-done") === "1";
const TODO_CATEGORIES = __TODO_CATEGORIES_JSON__;
const TODO_CATS = TODO_CATEGORIES.map((c) => c.cat);
const TODO_FILTER_LABELS = Object.fromEntries(
  TODO_CATEGORIES.map((c) => [c.cat, c.label])
);
function tcat(td) {
  return TODO_CATS.includes(td.cat) ? td.cat : TODO_CATS[0];
}
let todoFilter = localStorage.getItem("todo-filter");
if (!todoFilter || !TODO_CATS.includes(todoFilter)) todoFilter = TODO_CATS[0];
(function buildTodoFilterTabs() {
  const wrap = document.getElementById("todo-filter");
  if (!wrap) return;
  wrap.innerHTML = TODO_CATEGORIES.map(
    (c) => `<button type="button" data-cat="${escapeHtml(c.cat)}" class="todo-filter-btn flex-1 px-3 py-2 transition hover:bg-white/5 text-ink-500">${escapeHtml(c.label)}</button>`
  ).join("");
})();
function renderTodoFilterTabs() {
  document.querySelectorAll(".todo-filter-btn").forEach((btn) => {
    const cat = btn.dataset.cat;
    const active = cat === todoFilter;
    const pending = todos.filter((td) => tcat(td) === cat && !td.done).length;
    btn.classList.toggle("text-accent", active);
    btn.classList.toggle("bg-accent/10", active);
    btn.classList.toggle("text-ink-500", !active);
    btn.textContent = pending > 0 ? `${TODO_FILTER_LABELS[cat]} (${pending})` : TODO_FILTER_LABELS[cat];
  });
}
(function() {
  if (!IS_OFFLINE_BUILD || window.__viewerMode) return;
  try {
    if (window.self !== window.top) return;
  } catch (e) {
    return;
  }
  const banner = document.getElementById("demo-banner");
  if (!banner) return;
  try {
    if (sessionStorage.getItem("demoBannerDismissed") === "1") return;
  } catch (e) {
  }
  banner.classList.remove("hidden");
  document.getElementById("demo-banner-close")?.addEventListener("click", () => {
    banner.classList.add("hidden");
    try {
      sessionStorage.setItem("demoBannerDismissed", "1");
    } catch (e) {
    }
  });
})();

class KeyboardRouter {
  constructor() {
    document.addEventListener("keydown", (e) => this.onKey(e));
  }
  // App-wide keyboard router. Ctrl/Cmd+K opens the palette; Escape closes the topmost open overlay
  // (history → tasks → graph, the owners' priority); the rest are global shortcuts, suppressed while
  // an input/textarea is focused.
  onKey(e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      commandPalette.open();
      return;
    }
    if (e.key === "Escape" && !historyOverlay.classList.contains("hidden")) {
      closeHistory();
      return;
    }
    if (e.key === "Escape" && tasksOverlay.isOpen()) {
      tasksOverlay.close();
      return;
    }
    if (e.key === "Escape" && mindGraph.isOpen()) {
      mindGraph.close();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "g") {
      e.preventDefault();
      mindGraph.open();
      return;
    }
    const active = document.activeElement;
    if (active && ["INPUT", "TEXTAREA"].includes(active.tagName)) {
      if (e.key === "Escape" && active === searchEl) {
        searchEl.value = "";
        searchEl.dispatchEvent(new Event("input"));
        searchEl.blur();
      }
      return;
    }
    if (e.key === "/") {
      e.preventDefault();
      searchEl.focus();
    }
    if (e.key === "e" && currentFile && !editMode && !window.__viewerMode) {
      e.preventDefault();
      enterEditMode();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "b") {
      e.preventDefault();
      toggleSidebar();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "j") {
      e.preventDefault();
      toggleToc();
    }
  }
}
const keyboardRouter = new KeyboardRouter();

const mindGraph = new MindGraph();
function openGraph() {
  mindGraph.open();
}
if (EMBED_MIND) {
  const gc = document.getElementById("graph-controls");
  if (gc) gc.style.display = "none";
  mindGraph.open();
}

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
class Combobox {
  // multi mode
  constructor(input, opts) {
    __publicField(this, "input");
    __publicField(this, "opts");
    __publicField(this, "pop");
    __publicField(this, "norm");
    __publicField(this, "fmt");
    __publicField(this, "all", []);
    __publicField(this, "items", []);
    // strings, plus an optional create sentinel at the end
    __publicField(this, "active", 0);
    __publicField(this, "isOpen", false);
    __publicField(this, "chipBox", null);
    __publicField(this, "values", []);
    this.input = input;
    this.opts = opts;
    this.norm = opts.normalize || ((v) => v);
    this.fmt = opts.format || ((v) => escapeHtml(v));
    this.input.removeAttribute("list");
    this.input.setAttribute("autocomplete", "off");
    this.input.setAttribute("role", "combobox");
    this.input.setAttribute("aria-expanded", "false");
    this.pop = document.createElement("div");
    this.pop.className = "atlas-cb-pop fixed hidden max-h-64 overflow-y-auto scrollbar-thin rounded-md border subtle-border shadow-2xl shadow-black/70 text-sm";
    this.pop.style.zIndex = "80";
    document.body.appendChild(this.pop);
    this.wire();
  }
  wire() {
    this.input.addEventListener("focus", async () => {
      await this.load();
      this.active = 0;
      this.render();
    });
    this.input.addEventListener("input", () => {
      this.active = 0;
      this.render();
    });
    this.input.addEventListener("keydown", (e) => this.onKeydown(e));
    this.pop.addEventListener("mousedown", (e) => this.onPopMousedown(e));
    this.input.addEventListener("blur", () => setTimeout(() => this.close(), 120));
  }
  async load() {
    try {
      this.all = await this.opts.source() || [];
    } catch (_) {
      this.all = [];
    }
  }
  compute() {
    const raw = this.input.value.trim();
    const q = raw.toLowerCase();
    let res = q ? this.all.filter((v) => String(v).toLowerCase().includes(q)) : this.all.slice();
    if (q) {
      const rk = (v) => String(v).toLowerCase().startsWith(q) ? 0 : 1;
      res.sort((a, b) => rk(a) - rk(b));
    }
    res = res.slice(0, this.opts.maxItems || 50).filter((v) => !(this.opts.multi && this.values.includes(v)));
    const exact = this.all.some((v) => String(v).toLowerCase() === q);
    return { res, create: this.opts.creatable && raw && !exact ? raw : null };
  }
  render() {
    const { res, create } = this.compute();
    this.items = res.slice();
    let html = res.map(
      (v, i) => '<div class="atlas-cb-opt px-3 py-1.5 cursor-pointer hover:bg-white/5 ' + (i === this.active ? "bg-white/10" : "") + '" data-i="' + i + '">' + this.fmt(v) + "</div>"
    ).join("");
    if (create) {
      const ci = res.length;
      html += '<div class="atlas-cb-create px-3 py-1.5 cursor-pointer hover:bg-white/5 text-accent flex items-center gap-2 ' + (this.active === ci ? "bg-white/10" : "") + '" data-create="1"><span class="text-base leading-none">+</span>' + escapeHtml(t("comboCreate", create)) + "</div>";
      this.items.push({ __create: create });
    }
    if (!this.items.length) {
      this.pop.innerHTML = '<div class="px-3 py-1.5 text-ink-500">' + escapeHtml(t("comboNoResults")) + "</div>";
    } else {
      this.pop.innerHTML = html;
    }
    const r = this.input.getBoundingClientRect();
    this.pop.style.left = r.left + "px";
    this.pop.style.top = r.bottom + 4 + "px";
    this.pop.style.width = r.width + "px";
    this.pop.classList.remove("hidden");
    this.isOpen = true;
    this.input.setAttribute("aria-expanded", "true");
    const a = this.pop.children[this.active];
    if (a) a.scrollIntoView({ block: "nearest" });
  }
  choose(it) {
    if (it == null) return;
    const val = this.norm(typeof it === "string" ? it : it.__create);
    if (this.opts.multi) {
      this.addChip(val);
      this.input.value = "";
    } else {
      this.input.value = val;
    }
    this.close();
    if (this.opts.onSelect) this.opts.onSelect(val);
  }
  // chips (multi) — reuse the existing .doc-tag / .doc-tag-x styling.
  ensureChipBox() {
    if (this.opts.multi && !this.chipBox) {
      this.chipBox = document.createElement("div");
      this.chipBox.className = "flex flex-wrap gap-1.5 mb-1.5 empty:hidden";
      this.input.parentNode.insertBefore(this.chipBox, this.input);
      this.chipBox.addEventListener("click", (e) => {
        const b = e.target.closest("[data-rm]");
        if (b) {
          this.values = this.values.filter((x) => x !== b.dataset.rm);
          this.renderChips();
        }
      });
    }
  }
  renderChips() {
    if (!this.chipBox) return;
    this.chipBox.innerHTML = this.values.map(
      (v) => '<span class="doc-tag">' + escapeHtml(v) + '<button type="button" class="doc-tag-x ml-1" data-rm="' + escapeHtml(v) + '">×</button></span>'
    ).join("");
  }
  addChip(v) {
    this.ensureChipBox();
    if (!v || this.values.includes(v)) return;
    this.values.push(v);
    this.renderChips();
  }
  onKeydown(e) {
    if (e.key === "Backspace" && this.opts.multi && !this.input.value && this.values.length) {
      this.values.pop();
      this.renderChips();
      return;
    }
    if (!this.isOpen) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.active = Math.min(this.active + 1, this.items.length - 1);
      this.render();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.active = Math.max(this.active - 1, 0);
      this.render();
    } else if (e.key === "Enter") {
      if (this.items[this.active] != null) {
        e.preventDefault();
        this.choose(this.items[this.active]);
      }
    } else if (e.key === "Escape") {
      e.stopPropagation();
      this.close();
    }
  }
  onPopMousedown(e) {
    const el = e.target.closest("[data-i],[data-create]");
    if (!el) return;
    e.preventDefault();
    this.choose(el.dataset.create ? this.items[this.items.length - 1] : this.items[+el.dataset.i]);
  }
  getValue() {
    return this.opts.multi ? this.values.slice() : this.input.value.trim();
  }
  setValue(value) {
    if (this.opts.multi) {
      this.values = String(value || "").split(this.opts.separator || ",").map((s) => s.trim()).filter(Boolean);
      this.ensureChipBox();
      this.renderChips();
    } else {
      this.input.value = value || "";
    }
  }
  async refresh() {
    await this.load();
    if (this.isOpen) this.render();
  }
  clear() {
    if (this.opts.multi) {
      this.values = [];
      this.renderChips();
    } else {
      this.input.value = "";
    }
  }
  focus() {
    this.input.focus();
  }
  open() {
    this.render();
  }
  close() {
    this.pop.classList.add("hidden");
    this.isOpen = false;
    this.input.setAttribute("aria-expanded", "false");
  }
  destroy() {
    this.pop.remove();
    if (this.chipBox) this.chipBox.remove();
  }
}
function AtlasCombobox(input, opts) {
  return new Combobox(input, opts);
}

class Todos {
  constructor() {
    todoForm.addEventListener("submit", (e) => this.onSubmit(e));
    todoList.addEventListener("click", (e) => this.onListClick(e));
    document.getElementById("todo-filter").addEventListener("click", (e) => this.onFilterClick(e));
    document.getElementById("todo-toggle-done").addEventListener("click", () => this.onToggleDone());
    document.getElementById("todo-clear-done").addEventListener("click", () => this.onClearDone());
  }
  render() {
    const inCat = todos.filter((it) => tcat(it) === todoFilter);
    const done = inCat.filter((it) => it.done).length;
    const pendingAll = todos.filter((it) => !it.done).length;
    todoCount.textContent = pendingAll ? t("nPending", pendingAll) : "";
    todoBubbleCount.textContent = pendingAll > 9 ? "9+" : String(pendingAll);
    todoBubbleCount.classList.toggle("empty", pendingAll === 0);
    renderTodoFilterTabs();
    if (todoInput) todoInput.placeholder = t("addTodoIn", TODO_FILTER_LABELS[todoFilter]);
    updateHomeTodoStat();
    updateTabBadge();
    const controls = document.getElementById("todo-controls");
    const toggleLabel = document.getElementById("todo-toggle-label");
    const toggleIcon = document.getElementById("todo-toggle-icon");
    if (done > 0) {
      controls.classList.remove("hidden");
      controls.classList.add("flex");
      toggleLabel.textContent = showDoneTodos ? t("hideDone", done) : t("showDone", done);
      toggleIcon.style.transform = showDoneTodos ? "rotate(180deg)" : "";
    } else {
      controls.classList.add("hidden");
      controls.classList.remove("flex");
    }
    if (inCat.length === 0) {
      todoList.innerHTML = `<li class="px-3 py-4 text-center text-xs text-ink-500">${t("noTasksIn", TODO_FILTER_LABELS[todoFilter])}</li>`;
      return;
    }
    const visible = showDoneTodos ? inCat : inCat.filter((it) => !it.done);
    if (visible.length === 0) {
      todoList.innerHTML = `<li class="px-3 py-4 text-center text-xs text-ink-500">${t("allDone", done)}</li>`;
      return;
    }
    todoList.innerHTML = visible.map(
      (item) => `
    <li class="todo-row group flex items-start gap-2 px-3 py-2 hover:bg-navy-800/40" data-id="${item.id}">
      <input type="checkbox" ${item.done ? "checked" : ""}
        class="todo-check mt-0.5 w-4 h-4 rounded border-navy-600 bg-navy-900 text-blue-500 focus:ring-blue-400/40 cursor-pointer accent-blue-500">
      <span class="todo-text flex-1 text-sm leading-snug ${item.done ? "line-through text-ink-500" : "text-ink-100"} cursor-pointer">${escapeHtml(item.text)}</span>
      <button class="todo-del opacity-0 group-hover:opacity-100 text-ink-500 hover:text-rose-400 text-base leading-none transition-opacity" title="${escapeHtml(t("del"))}">&times;</button>
    </li>
  `
    ).join("");
  }
  async onSubmit(e) {
    e.preventDefault();
    const input = todoInput;
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    if (!isServerMode) {
      setStatus(t("fileModeTodoStatus"), "err");
      return;
    }
    try {
      setStatus(t("adding"), "info");
      todos = await api("POST", "/api/todos", { text, cat: todoFilter });
      this.render();
      setStatus(t("added"), "ok");
    } catch (err) {
      setStatus(t("err", err.message), "err");
    }
  }
  async onListClick(e) {
    const target = e.target;
    const row = target.closest(".todo-row");
    if (!row) return;
    const id = parseInt(row.dataset.id);
    const check = target.closest(".todo-check");
    if (check) {
      try {
        todos = await api("PATCH", "/api/todos/" + id, { done: check.checked });
        this.render();
        setStatus(check.checked ? t("doneStatus") : t("reopened"), "ok");
      } catch (err) {
        setStatus(t("err", err.message), "err");
        check.checked = !check.checked;
      }
      return;
    }
    if (target.closest(".todo-del")) {
      try {
        todos = await api("DELETE", "/api/todos/" + id);
        this.render();
        setStatus(t("deletedStatus"), "ok");
      } catch (err) {
        setStatus(t("err", err.message), "err");
      }
      return;
    }
    if (target.closest(".todo-text")) {
      this.startInlineEdit(row);
    }
  }
  onFilterClick(e) {
    const btn = e.target.closest(".todo-filter-btn");
    if (!btn || btn.dataset.cat === todoFilter) return;
    todoFilter = btn.dataset.cat;
    localStorage.setItem("todo-filter", todoFilter);
    this.render();
  }
  onToggleDone() {
    showDoneTodos = !showDoneTodos;
    localStorage.setItem("todo-show-done", showDoneTodos ? "1" : "0");
    this.render();
  }
  async onClearDone() {
    const doneTodos = todos.filter((it) => it.done && tcat(it) === todoFilter);
    if (doneTodos.length === 0) return;
    const ok = await confirmDialog({
      title: t("clearDoneConfirmTitle", doneTodos.length),
      message: t("clearDoneConfirmMsg"),
      confirmLabel: t("clearBtn"),
      destructive: true
    });
    if (!ok) return;
    const idsDesc = doneTodos.map((it) => it.id).sort((a, b) => b - a);
    try {
      setStatus(t("clearing"), "info");
      for (const id of idsDesc) {
        todos = await api("DELETE", "/api/todos/" + id);
      }
      this.render();
      setStatus(t("nCleared", idsDesc.length), "ok");
    } catch (err) {
      setStatus(t("err", err.message), "err");
    }
  }
  // Swap the row's text span for a live <input>, commit on Enter/blur, revert on Escape. A 99-bootstrap
  // poll that re-renders mid-edit destroys this input — the keyed runtime port fixes that later.
  startInlineEdit(row) {
    const id = parseInt(row.dataset.id);
    const item = todos.find((it) => it.id === id);
    if (!item) return;
    const textSpan = row.querySelector(".todo-text");
    if (!textSpan) return;
    const input = document.createElement("input");
    input.type = "text";
    input.value = item.text;
    input.className = "todo-edit flex-1 px-2 py-0.5 text-sm bg-navy-900 border border-blue-400 rounded text-ink-100 focus:outline-none focus:ring-1 focus:ring-blue-400/40";
    textSpan.replaceWith(input);
    input.focus();
    input.select();
    let committed = false;
    const commit = async (save) => {
      if (committed) return;
      committed = true;
      const newText = input.value.trim();
      if (save && newText && newText !== item.text) {
        try {
          todos = await api("PATCH", "/api/todos/" + id, { text: newText });
          this.render();
          setStatus(t("updated"), "ok");
          return;
        } catch (err) {
          setStatus(t("err", err.message), "err");
        }
      }
      this.render();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        commit(false);
      }
    });
    input.addEventListener("blur", () => commit(true));
  }
}
const todosWidget = new Todos();
async function refresh() {
  if (!isServerMode) return;
  try {
    todos = await api("GET", "/api/todos");
    todosWidget.render();
    setStatus(t("synced"), "info");
  } catch (err) {
    setStatus(t("offlinePrefix", err.message), "err");
  }
}

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
const _Dialogs = class _Dialogs {
  static confirm(opts) {
    return new Promise((resolve) => {
      const o = typeof opts === "string" ? { message: opts } : opts || {};
      _Dialogs.titleEl.textContent = o.title || t("confirm");
      _Dialogs.messageEl.textContent = o.message || "";
      _Dialogs.okBtn.textContent = o.confirmLabel || t("confirm");
      _Dialogs.cancelBtn.textContent = o.cancelLabel || t("cancel");
      _Dialogs.okBtn.className = o.destructive ? "px-3 py-1.5 text-sm bg-rose-500/80 hover:bg-rose-500 text-white rounded font-medium" : "px-3 py-1.5 text-sm bg-accent hover:brightness-110 text-white rounded font-medium";
      _Dialogs.backdrop.classList.remove("hidden");
      setTimeout(() => _Dialogs.okBtn.focus(), 50);
      const cleanup = () => {
        _Dialogs.backdrop.classList.add("hidden");
        _Dialogs.okBtn.removeEventListener("click", onOk);
        _Dialogs.cancelBtn.removeEventListener("click", onCancel);
        _Dialogs.backdrop.removeEventListener("click", onBackdrop);
        document.removeEventListener("keydown", onKey);
      };
      const onOk = () => {
        cleanup();
        resolve(true);
      };
      const onCancel = () => {
        cleanup();
        resolve(false);
      };
      const onBackdrop = (e) => {
        if (e.target === _Dialogs.backdrop) onCancel();
      };
      const onKey = (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        } else if (e.key === "Enter") {
          e.preventDefault();
          onOk();
        }
      };
      _Dialogs.okBtn.addEventListener("click", onOk);
      _Dialogs.cancelBtn.addEventListener("click", onCancel);
      _Dialogs.backdrop.addEventListener("click", onBackdrop);
      document.addEventListener("keydown", onKey);
    });
  }
  // A single-OK notice reusing the confirm chrome (so it matches every other modal). Fire-and-forget:
  // callers don't await it.
  static alert(opts) {
    const o = typeof opts === "string" ? { message: opts } : opts || {};
    return new Promise((resolve) => {
      _Dialogs.titleEl.textContent = o.title || t("errorTitle");
      _Dialogs.messageEl.textContent = o.message || "";
      _Dialogs.okBtn.textContent = o.okLabel || t("ok");
      _Dialogs.okBtn.className = "px-3 py-1.5 text-sm bg-accent hover:brightness-110 text-white rounded font-medium";
      _Dialogs.cancelBtn.classList.add("hidden");
      _Dialogs.backdrop.classList.remove("hidden");
      setTimeout(() => _Dialogs.okBtn.focus(), 50);
      const cleanup = () => {
        _Dialogs.backdrop.classList.add("hidden");
        _Dialogs.cancelBtn.classList.remove("hidden");
        _Dialogs.okBtn.removeEventListener("click", done);
        _Dialogs.backdrop.removeEventListener("click", onBackdrop);
        document.removeEventListener("keydown", onKey);
      };
      const done = () => {
        cleanup();
        resolve();
      };
      const onBackdrop = (e) => {
        if (e.target === _Dialogs.backdrop) done();
      };
      const onKey = (e) => {
        if (e.key === "Escape" || e.key === "Enter") {
          e.preventDefault();
          done();
        }
      };
      _Dialogs.okBtn.addEventListener("click", done);
      _Dialogs.backdrop.addEventListener("click", onBackdrop);
      document.addEventListener("keydown", onKey);
    });
  }
  // In an OFFLINE build every server-backed action is disabled, so show one clear "disabled offline"
  // notice (in the UI language) rather than leaking a raw network error; online, show `key`'s message.
  static notifyError(key, ...args) {
    if (IS_OFFLINE_BUILD) {
      return _Dialogs.alert({ title: t("offlineTitle"), message: t("offlineDisabled") });
    }
    return _Dialogs.alert({ title: t("errorTitle"), message: t(key, ...args) });
  }
  // Input modal. Resolves the entered value (trimmed) or null if cancelled/empty.
  static prompt(opts) {
    const o = opts || {};
    const backdrop = document.getElementById("prompt-backdrop");
    const input = document.getElementById("prompt-input");
    document.getElementById("prompt-title").textContent = o.title || "";
    document.getElementById("prompt-message").textContent = o.message || "";
    input.placeholder = o.placeholder || "";
    input.value = o.value || "";
    const okBtn = document.getElementById("prompt-ok");
    const cancelBtn = document.getElementById("prompt-cancel");
    okBtn.textContent = o.confirmLabel || t("confirm");
    return new Promise((resolve) => {
      backdrop.classList.remove("hidden");
      setTimeout(() => {
        input.focus();
        input.select();
      }, 50);
      const cleanup = () => {
        backdrop.classList.add("hidden");
        okBtn.removeEventListener("click", onOk);
        cancelBtn.removeEventListener("click", onCancel);
        backdrop.removeEventListener("click", onBackdrop);
        document.removeEventListener("keydown", onKey);
      };
      const onOk = () => {
        const v = input.value.trim();
        cleanup();
        resolve(v || null);
      };
      const onCancel = () => {
        cleanup();
        resolve(null);
      };
      const onBackdrop = (e) => {
        if (e.target === backdrop) onCancel();
      };
      const onKey = (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        } else if (e.key === "Enter") {
          e.preventDefault();
          onOk();
        }
      };
      okBtn.addEventListener("click", onOk);
      cancelBtn.addEventListener("click", onCancel);
      backdrop.addEventListener("click", onBackdrop);
      document.addEventListener("keydown", onKey);
    });
  }
};
// Confirm + alert share this one chrome (alert reuses it as a single-OK notice).
__publicField(_Dialogs, "backdrop", document.getElementById("confirm-backdrop"));
__publicField(_Dialogs, "titleEl", document.getElementById("confirm-title"));
__publicField(_Dialogs, "messageEl", document.getElementById("confirm-message"));
__publicField(_Dialogs, "okBtn", document.getElementById("confirm-ok"));
__publicField(_Dialogs, "cancelBtn", document.getElementById("confirm-cancel"));
let Dialogs = _Dialogs;
function confirmDialog(opts) {
  return Dialogs.confirm(opts);
}
function alertDialog(opts) {
  return Dialogs.alert(opts);
}
function promptDialog(opts) {
  return Dialogs.prompt(opts);
}
function notifyError(key, ...args) {
  return Dialogs.notifyError(key, ...args);
}
const btnMore = document.getElementById("btn-more");
const btnMoreMenu = document.getElementById("btn-more-menu");
const renameBackdrop = document.getElementById("rename-backdrop");
const renameForm = document.getElementById("rename-form");
const renameTitle = document.getElementById("rename-title");
const renameDir = document.getElementById("rename-dir");
const renameDirWrap = document.getElementById("rename-dir-wrap");
const renameName = document.getElementById("rename-name");
const renameError = document.getElementById("rename-error");
const renameCancel = document.getElementById("rename-cancel");
let renameMode = null;
AtlasCombobox(renameDir, { source: getAllDirs, creatable: true });
class RenameModal {
  constructor() {
    renameCancel.addEventListener("click", () => this.close());
    document.getElementById("rename-close")?.addEventListener("click", () => this.close());
    renameBackdrop.addEventListener("click", (e) => {
      if (e.target === renameBackdrop) this.close();
    });
    renameForm.addEventListener("submit", (e) => this.onSubmit(e));
  }
  open(mode) {
    if (!currentFile || window.__viewerMode) return;
    renameMode = mode;
    renameError.classList.add("hidden");
    const parts = currentFile.path.split("/");
    const currentName = parts.pop().replace(/\.(md|html)$/i, "");
    const currentDir = parts.join("/");
    renameName.value = currentName;
    renameDir.value = currentDir;
    if (mode === "rename") {
      renameTitle.textContent = t("renameDocTitle");
      renameDirWrap.classList.add("hidden");
    } else {
      renameTitle.textContent = t("moveDocTitle");
      renameDirWrap.classList.remove("hidden");
    }
    renameBackdrop.classList.remove("hidden");
    setTimeout(() => (mode === "rename" ? renameName : renameDir).focus(), 50);
  }
  close() {
    renameBackdrop.classList.add("hidden");
  }
  async onSubmit(e) {
    e.preventDefault();
    renameError.classList.add("hidden");
    let name = renameName.value.trim();
    if (!name) {
      renameError.textContent = t("nameRequired");
      renameError.classList.remove("hidden");
      return;
    }
    if (/[\\\/]/.test(name)) {
      renameError.textContent = t("noSlashes");
      renameError.classList.remove("hidden");
      return;
    }
    if (!/\.(md|html)$/i.test(name)) {
      const ext = (/\.(md|html)$/i.exec(currentFile.path)?.[1] || "md").toLowerCase();
      name += "." + ext;
    }
    const dir = (renameMode === "move" ? renameDir.value.trim() : currentFile.path.split("/").slice(0, -1).join("/")).replace(/^\/+|\/+$/g, "");
    const newPath = dir ? dir + "/" + name : name;
    if (newPath === currentFile.path) {
      this.close();
      return;
    }
    if (fileMap[newPath]) {
      renameError.textContent = t("fileExistsAt");
      renameError.classList.remove("hidden");
      return;
    }
    try {
      const res = await fetch("/api/file/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: currentFile.path, to: newPath })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "HTTP " + res.status);
      }
      this.close();
      const cached = contentCache.get(currentFile.path);
      if (cached !== void 0) {
        contentCache.delete(currentFile.path);
        contentCache.set(newPath, cached);
      }
      currentFile.path = newPath;
      location.hash = "#" + encodeURIComponent(newPath);
      setStatus(renameMode === "move" ? t("docMoved") : t("docRenamed"), "ok");
      await refreshTreeOrReload();
    } catch (err) {
      renameError.textContent = t("err", err.message);
      renameError.classList.remove("hidden");
    }
  }
}
const renameModal = new RenameModal();
function openRenameModal(mode) {
  renameModal.open(mode);
}
function closeRenameModal() {
  renameModal.close();
}

class MoreActionsMenu {
  constructor() {
    btnMore.addEventListener("click", (e) => {
      e.stopPropagation();
      btnMoreMenu.classList.toggle("hidden");
    });
    document.addEventListener("click", () => btnMoreMenu.classList.add("hidden"));
    btnMoreMenu.addEventListener("click", (e) => this.onMenuClick(e));
  }
  async onMenuClick(e) {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    btnMoreMenu.classList.add("hidden");
    const action = btn.dataset.action;
    if (action === "rename") {
      renameModal.open("rename");
      return;
    }
    if (action === "move") {
      renameModal.open("move");
      return;
    }
    if (action === "delete") {
      const ok = await Dialogs.confirm({
        title: t("deleteDocTitle"),
        message: t("deleteDocMsg", currentFile.path),
        confirmLabel: t("del"),
        destructive: true
      });
      if (!ok) return;
      try {
        const res = await fetch("/api/file", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: currentFile.path })
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        location.hash = "";
        setStatus(t("docDeleted"), "ok");
        await refreshTreeOrReload();
      } catch (err) {
        Dialogs.notifyError("err", err.message);
      }
    }
  }
}
const moreActionsMenu = new MoreActionsMenu();

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
const RESET_PW_MIN = 8;
const resetPwBackdrop = document.getElementById("reset-pw-backdrop");
const resetPwForm = document.getElementById("reset-pw-form");
const resetPwEmail = document.getElementById("reset-pw-email");
const resetPwInput = document.getElementById("reset-pw-input");
const resetPwConfirm = document.getElementById("reset-pw-confirm");
const resetPwToggle = document.getElementById("reset-pw-toggle");
const resetPwEye = document.getElementById("reset-pw-eye");
const resetPwEyeOff = document.getElementById("reset-pw-eye-off");
const resetPwError = document.getElementById("reset-pw-error");
const resetPwSuccess = document.getElementById("reset-pw-success");
const resetPwSubmit = document.getElementById("reset-pw-submit");
const resetPwCancel = document.getElementById("reset-pw-cancel");
const resetPwClose = document.getElementById("reset-pw-close");
function resetPwValidationError() {
  const pw = resetPwInput.value;
  const confirm = resetPwConfirm.value;
  if (pw.length < RESET_PW_MIN) return t("settingsPasswordTooShort");
  if (pw !== confirm) return t("settingsPasswordMismatch");
  return null;
}
function refreshResetPwState() {
  resetPwError.classList.add("hidden");
  const tooShort = resetPwInput.value.length < RESET_PW_MIN;
  resetPwSubmit.disabled = tooShort || resetPwConfirm.value.length === 0;
}
function setResetPwVisibility(show) {
  resetPwInput.type = show ? "text" : "password";
  resetPwConfirm.type = show ? "text" : "password";
  resetPwEye.classList.toggle("hidden", show);
  resetPwEyeOff.classList.toggle("hidden", !show);
  resetPwToggle.setAttribute("aria-pressed", show ? "true" : "false");
}
class ResetPwModal {
  constructor() {
    __publicField(this, "targetEmail", null);
    __publicField(this, "closeTimer", null);
    // Capture-phase + stopPropagation so Esc closes ONLY this modal (stacked over Settings), not the
    // panel beneath, and runs before the global handler. Arrow field: a stable ref for add/remove.
    __publicField(this, "onKey", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    });
    resetPwInput.addEventListener("input", refreshResetPwState);
    resetPwConfirm.addEventListener("input", refreshResetPwState);
    resetPwToggle.addEventListener(
      "click",
      () => setResetPwVisibility(resetPwInput.type === "password")
    );
    resetPwCancel.addEventListener("click", () => this.close());
    resetPwClose.addEventListener("click", () => this.close());
    resetPwBackdrop.addEventListener("click", (e) => {
      if (e.target === resetPwBackdrop) this.close();
    });
    resetPwForm.addEventListener("submit", (e) => this.submit(e));
  }
  open(email) {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    this.targetEmail = email || "";
    resetPwEmail.textContent = this.targetEmail;
    resetPwInput.value = "";
    resetPwConfirm.value = "";
    resetPwError.classList.add("hidden");
    resetPwSuccess.classList.add("hidden");
    setResetPwVisibility(false);
    refreshResetPwState();
    resetPwBackdrop.classList.remove("hidden");
    document.addEventListener("keydown", this.onKey, true);
    setTimeout(() => resetPwInput.focus(), 50);
  }
  close() {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    resetPwBackdrop.classList.add("hidden");
    document.removeEventListener("keydown", this.onKey, true);
    this.targetEmail = null;
  }
  async submit(e) {
    e.preventDefault();
    resetPwError.classList.add("hidden");
    resetPwSuccess.classList.add("hidden");
    const validationError = resetPwValidationError();
    if (validationError) {
      resetPwError.textContent = validationError;
      resetPwError.classList.remove("hidden");
      return;
    }
    const email = this.targetEmail;
    resetPwSubmit.disabled = true;
    try {
      await settingsFetch("/api/admin/users/password", {
        method: "POST",
        body: JSON.stringify({ email, password: resetPwInput.value })
      });
      clearSettingsError();
      resetPwSuccess.classList.remove("hidden");
      this.closeTimer = setTimeout(() => this.close(), 1200);
    } catch (err) {
      resetPwError.textContent = err.message;
      resetPwError.classList.remove("hidden");
      resetPwSubmit.disabled = false;
    }
  }
}
const resetPwModal = new ResetPwModal();
function openResetPassword(email) {
  resetPwModal.open(email);
}

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
const btnShare = document.getElementById("btn-share");
const shareBackdrop = document.getElementById("share-backdrop");
const sharePath = document.getElementById("share-path");
const shareStep1 = document.getElementById("share-step1");
const shareStep2 = document.getElementById("share-step2");
const shareUrl = document.getElementById("share-url");
const shareCopy = document.getElementById("share-copy");
const shareExpiry = document.getElementById("share-expiry");
const shareError = document.getElementById("share-error");
const shareCancel = document.getElementById("share-cancel");
const shareClose = document.getElementById("share-close");
const shareNew = document.getElementById("share-new");
const shareExisting = document.getElementById("share-existing");
const shareExistingList = document.getElementById("share-existing-list");
const shareExistingCount = document.getElementById("share-existing-count");
function shareFormatDate(ts) {
  if (!ts) return "";
  return new Date(ts * 1e3).toLocaleDateString(LANG, {
    day: "numeric",
    month: "short",
    year: "2-digit"
  });
}
async function refreshShareList() {
  const file = currentFile;
  if (!file) return;
  shareExisting.classList.add("hidden");
  shareExistingList.innerHTML = "";
  try {
    const res = await fetch("/api/share/list?path=" + encodeURIComponent(file.path));
    if (!res.ok) return;
    const items = await res.json();
    if (!Array.isArray(items) || items.length === 0) return;
    shareExisting.classList.remove("hidden");
    shareExistingCount.textContent = t("nLinks", items.length);
    shareExistingList.innerHTML = items.map((item) => {
      const url = location.origin + "/s/" + item.token;
      const exp = item.expires_at ? t("expiresShort", shareFormatDate(item.expires_at)) : t("noExpiry");
      const created = item.created_at ? t("createdShort", shareFormatDate(item.created_at)) : "";
      return '<li class="bg-navy-900 border subtle-border rounded p-2 flex items-center gap-2 text-xs"><div class="flex-1 min-w-0"><div class="text-ink-300 font-mono truncate" title="' + escapeHtml(url) + '">' + escapeHtml(url) + '</div><div class="text-ink-500 text-[10px] mt-0.5">' + created + " &middot; " + exp + '</div></div><button class="share-existing-copy px-2 py-1 text-[11px] bg-navy-700 hover:bg-navy-600 text-ink-200 rounded" data-url="' + escapeHtml(url) + '" title="' + escapeHtml(t("copy")) + '">' + t("copy") + '</button><button class="share-existing-del px-2 py-1 text-[11px] bg-navy-700 hover:bg-rose-500/30 hover:text-rose-300 text-ink-200 rounded" data-id="' + escapeHtml(item.id) + '" title="' + escapeHtml(t("revokeTitle")) + '">&times;</button></li>';
    }).join("");
  } catch (e) {
  }
}
function openShareModal() {
  const file = currentFile;
  if (!file || window.__viewerMode) return;
  sharePath.textContent = file.path;
  shareStep1.classList.remove("hidden");
  shareStep2.classList.add("hidden");
  shareError.classList.add("hidden");
  shareBackdrop.classList.remove("hidden");
  refreshShareList();
}
function closeShareModal() {
  shareBackdrop.classList.add("hidden");
}
shareExistingList.addEventListener("click", async (e) => {
  const copyBtn = e.target.closest(".share-existing-copy");
  if (copyBtn) {
    try {
      await navigator.clipboard.writeText(copyBtn.dataset.url || "");
      copyBtn.textContent = t("copied");
      setTimeout(() => copyBtn.textContent = t("copy"), 1200);
    } catch (e2) {
    }
    return;
  }
  const delBtn = e.target.closest(".share-existing-del");
  if (delBtn) {
    const ok = await confirmDialog({
      title: t("revokeConfirmTitle"),
      message: t("revokeConfirmMsg"),
      confirmLabel: t("revoke"),
      destructive: true
    });
    if (!ok) return;
    shareError.classList.add("hidden");
    try {
      const res = await fetch("/api/share/" + delBtn.dataset.id, { method: "DELETE" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      refreshShareList();
    } catch (e2) {
      shareError.textContent = t("err", e2.message);
      shareError.classList.remove("hidden");
    }
  }
});
btnShare.addEventListener("click", openShareModal);
shareCancel.addEventListener("click", closeShareModal);
shareClose.addEventListener("click", closeShareModal);
document.getElementById("share-close-x")?.addEventListener("click", closeShareModal);
shareBackdrop.addEventListener("click", (e) => {
  if (e.target === shareBackdrop) closeShareModal();
});
shareNew.addEventListener("click", () => {
  shareStep2.classList.add("hidden");
  shareStep1.classList.remove("hidden");
});
document.querySelectorAll(".share-dur").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const file = currentFile;
    if (!file) return;
    shareError.classList.add("hidden");
    const days = parseInt(btn.dataset.days, 10);
    btn.disabled = true;
    try {
      const res = await fetch("/api/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: file.path, expires_days: days })
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const fullUrl = location.origin + "/s/" + data.token;
      shareUrl.value = fullUrl;
      shareExpiry.textContent = data.expires_at ? t("expiresAt", new Date(data.expires_at * 1e3).toLocaleString(LANG)) : t("neverExpires");
      shareStep1.classList.add("hidden");
      shareStep2.classList.remove("hidden");
      setTimeout(() => {
        shareUrl.select();
      }, 50);
      refreshShareList();
    } catch (e) {
      shareError.textContent = t("err", e.message);
      shareError.classList.remove("hidden");
    } finally {
      btn.disabled = false;
    }
  });
});
shareCopy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(shareUrl.value);
    shareCopy.textContent = t("copiedBang");
    setTimeout(() => {
      shareCopy.textContent = t("copy");
    }, 1500);
  } catch (e) {
    shareUrl.select();
    document.execCommand("copy");
  }
});
function settingsHttpMessage(status) {
  if (status === 403 || status === 401) return t("settingsErrForbidden");
  if (status === 409) return t("settingsErrConflict");
  return t("settingsErrGeneric");
}
async function settingsFetch(url, options) {
  const opts = { ...options };
  const headers = { ...opts.headers };
  if (opts.body) opts.headers = { "Content-Type": "application/json", ...headers };
  else opts.headers = headers;
  const res = await fetch(url, opts);
  let payload = null;
  try {
    payload = await res.json();
  } catch (_) {
  }
  if (!res.ok) {
    const human = payload && payload.error === "cannot delete the last admin" ? t("settingsLastAdmin") : settingsHttpMessage(res.status);
    const err = new Error(human);
    err.status = res.status;
    throw err;
  }
  return payload;
}
function suggestNodeName(path) {
  const base = (String(path).split("/").pop() || path).replace(/\.(md|html)$/i, "");
  return base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "noeud";
}
function remoteNodeInfo(path) {
  const parts = (path || "").split("/");
  if (parts[0] !== "remotes" || parts.length < 3) return null;
  const name = parts[1];
  const prefix = "remotes/" + name + "/";
  const fileCount = Object.keys(fileMap).filter((p) => p.startsWith(prefix)).length;
  return { name, sourceRel: parts.slice(2).join("/"), fileCount };
}
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    return false;
  }
}
class SettingsContext {
  constructor() {
    __publicField(this, "errorEl", document.getElementById("settings-error"));
    // The shared admin/share JSON fetch (declared above as a cross-file global).
    __publicField(this, "fetch", settingsFetch);
  }
  showError(message) {
    this.errorEl.textContent = message;
    this.errorEl.classList.remove("hidden");
  }
  clearError() {
    this.errorEl.classList.add("hidden");
  }
  flashCopied(btn) {
    btn.textContent = t("copied");
    btn.classList.add("is-copied");
    setTimeout(() => {
      btn.textContent = t("copy");
      btn.classList.remove("is-copied");
    }, 1200);
  }
  // Copy an input's value to the clipboard (with execCommand fallback) and flash the button.
  async copyFromInput(btn, inputId) {
    const input = document.getElementById(inputId);
    const ok = await copyToClipboard(input.value);
    if (!ok) {
      input.select();
      document.execCommand("copy");
    }
    this.flashCopied(btn);
  }
  // The clicked element matching a delegated selector (data-* row buttons).
  hit(e, selector) {
    return e.target.closest(selector);
  }
}

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
class SettingsUsers {
  constructor(ctx) {
    this.ctx = ctx;
    __publicField(this, "list", document.getElementById("settings-users-list"));
    __publicField(this, "form", document.getElementById("settings-user-form"));
    __publicField(this, "inviteResult", document.getElementById("settings-invite-result"));
    this.form.addEventListener("submit", (e) => this.submit(e));
    this.list.addEventListener("click", (e) => this.onClick(e));
    document.getElementById("settings-invite-copy").addEventListener(
      "click",
      (e) => this.ctx.copyFromInput(e.currentTarget, "settings-invite-link")
    );
    document.getElementById("settings-invite-close").addEventListener("click", () => this.hideInviteResult());
  }
  async load() {
    this.list.innerHTML = "";
    try {
      const users = await this.ctx.fetch("/api/admin/users");
      if (!Array.isArray(users) || users.length === 0) {
        this.list.innerHTML = '<li class="text-sm text-ink-500">' + t("settingsNoUsers") + "</li>";
        return;
      }
      this.list.innerHTML = users.map((u) => {
        const roleLabel = u.role === "admin" ? t("settingsRoleAdmin") : t("settingsRoleViewer");
        const roleCls = u.role === "admin" ? "text-accent" : "text-ink-400";
        const emailEsc = escapeHtml(u.email);
        const fullName = [u.first_name, u.last_name].map((p) => (p || "").trim()).filter(Boolean).join(" ");
        const nameLine = fullName ? '<div class="text-ink-100 font-medium truncate" title="' + escapeHtml(fullName) + '">' + escapeHtml(fullName) + "</div>" : "";
        const pendingBadge = u.pending ? ' <span class="settings-pending-badge">' + escapeHtml(t("settingsInvitePending")) + "</span>" : "";
        const actionBtn = u.pending ? '<button class="settings-user-resend px-3 py-1.5 text-sm bg-navy-700 hover:bg-navy-600 text-ink-200 rounded" data-email="' + emailEsc + '" data-role="' + escapeHtml(u.role || "") + '">' + escapeHtml(t("settingsResendInvite")) + "</button>" : '<button class="settings-user-reset px-3 py-1.5 text-sm bg-navy-700 hover:bg-navy-600 text-ink-200 rounded" data-email="' + emailEsc + '" title="' + escapeHtml(t("settingsResetPassword")) + '">' + escapeHtml(t("settingsResetPasswordShort")) + "</button>";
        return '<li class="bg-navy-900 border subtle-border rounded p-2.5 text-sm"><div class="admin-row"><div class="flex-shrink-0 mr-2.5">' + constellationSvg(avatarSeed(u.first_name, u.last_name, u.email), 28) + '</div><div class="flex-1 min-w-0">' + nameLine + '<div class="' + (fullName ? "text-ink-400 text-xs" : "text-ink-100 font-medium") + ' truncate" title="' + emailEsc + '">' + emailEsc + '</div><div class="' + roleCls + ' text-xs uppercase tracking-wider font-semibold mt-0.5">' + escapeHtml(roleLabel) + pendingBadge + '</div></div><div class="admin-row__actions">' + actionBtn + '<button class="settings-user-del px-3 py-1.5 text-sm bg-navy-700 hover:bg-rose-500/30 hover:text-rose-300 text-ink-200 rounded" data-email="' + emailEsc + '" data-role="' + escapeHtml(u.role || "") + '">' + t("settingsDeleteUser") + "</button></div></div></li>";
      }).join("");
    } catch (e) {
      this.ctx.showError(e.message);
    }
  }
  async submit(e) {
    e.preventDefault();
    this.ctx.clearError();
    const email = document.getElementById("settings-user-email").value.trim();
    const role = document.getElementById("settings-user-role").value;
    try {
      const data = await this.ctx.fetch("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({ email, role })
      });
      this.showInviteResult(data.invite_url);
      this.form.reset();
      this.load();
    } catch (err) {
      this.ctx.showError(err.message);
    }
  }
  async onClick(e) {
    const resendBtn = this.ctx.hit(e, ".settings-user-resend");
    if (resendBtn) {
      try {
        const data = await this.ctx.fetch("/api/admin/users", {
          method: "POST",
          body: JSON.stringify({ email: resendBtn.dataset.email, role: resendBtn.dataset.role })
        });
        this.showInviteResult(data.invite_url);
        this.load();
      } catch (err) {
        this.ctx.showError(err.message);
      }
      return;
    }
    const resetBtn = this.ctx.hit(e, ".settings-user-reset");
    if (resetBtn) {
      openResetPassword(resetBtn.dataset.email);
      return;
    }
    const delBtn = this.ctx.hit(e, ".settings-user-del");
    if (delBtn) {
      const ok = await confirmDialog({
        title: t("settingsDeleteUserTitle"),
        message: t("settingsDeleteUserMsg", delBtn.dataset.email),
        confirmLabel: t("settingsDeleteUser"),
        destructive: true
      });
      if (!ok) return;
      try {
        await this.ctx.fetch("/api/admin/users", {
          method: "DELETE",
          body: JSON.stringify({ email: delBtn.dataset.email })
        });
        this.load();
      } catch (err) {
        this.ctx.showError(err.message);
      }
    }
  }
  // ── Invite link one-time display (mirror of the token result) ──
  showInviteResult(url) {
    if (!url) return;
    document.getElementById("settings-invite-link").value = url;
    this.inviteResult.classList.remove("hidden");
  }
  hideInviteResult() {
    this.inviteResult.classList.add("hidden");
    document.getElementById("settings-invite-link").value = "";
  }
}

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
class SettingsTokens {
  constructor(ctx) {
    this.ctx = ctx;
    __publicField(this, "list", document.getElementById("settings-tokens-list"));
    __publicField(this, "form", document.getElementById("settings-token-form"));
    __publicField(this, "result", document.getElementById("settings-token-result"));
    this.form.addEventListener("submit", (e) => this.submit(e));
    document.getElementById("settings-token-copy").addEventListener("click", async (e) => {
      await this.ctx.copyFromInput(e.currentTarget, "settings-token-plain");
      setTimeout(() => this.hideResult(), 1400);
    });
    document.getElementById("settings-token-mcp-copy").addEventListener(
      "click",
      (e) => this.ctx.copyFromInput(e.currentTarget, "settings-token-mcp")
    );
    document.getElementById("settings-token-close").addEventListener("click", () => this.hideResult());
    this.list.addEventListener("click", (e) => this.onClick(e));
  }
  async load() {
    this.list.innerHTML = "";
    try {
      const tokens = await this.ctx.fetch("/api/tokens");
      const active = Array.isArray(tokens) ? tokens.filter((tk) => !tk.revoked) : [];
      if (active.length === 0) {
        this.list.innerHTML = '<li class="text-sm text-ink-500">' + t("settingsNoTokens") + "</li>";
        return;
      }
      this.list.innerHTML = active.map((tk) => {
        const created = tk.created_at ? t("createdShort", shareFormatDate(tk.created_at)) : "";
        const labelText = tk.label || tk.email || "";
        const labelEsc = escapeHtml(labelText);
        return '<li class="admin-row bg-navy-900 border subtle-border rounded p-2.5 text-sm"><div class="flex-1 min-w-0"><div class="text-ink-100 font-medium font-mono truncate" title="' + labelEsc + '">' + labelEsc + '</div><div class="text-ink-500 text-xs mt-0.5">' + escapeHtml(created) + '</div></div><div class="admin-row__actions"><button class="settings-token-revoke px-3 py-1.5 text-sm bg-navy-700 hover:bg-rose-500/30 hover:text-rose-300 text-ink-200 rounded" data-id="' + escapeHtml(tk.id || "") + '" data-label="' + labelEsc + '">' + t("settingsRevokeToken") + "</button></div></li>";
      }).join("");
    } catch (e) {
      this.ctx.showError(e.message);
    }
  }
  async submit(e) {
    e.preventDefault();
    this.ctx.clearError();
    const labelInput = document.getElementById("settings-token-label");
    const label = labelInput.value.trim();
    if (!label) return;
    try {
      const data = await this.ctx.fetch("/api/tokens", {
        method: "POST",
        body: JSON.stringify({ label })
      });
      document.getElementById("settings-token-plain").value = data.token || "";
      document.getElementById("settings-token-mcp").value = data.mcp_url || "";
      this.result.classList.remove("hidden");
      labelInput.value = "";
      this.load();
    } catch (err) {
      this.ctx.showError(err.message);
    }
  }
  hideResult() {
    this.result.classList.add("hidden");
    document.getElementById("settings-token-plain").value = "";
    document.getElementById("settings-token-mcp").value = "";
  }
  async onClick(e) {
    const revokeBtn = this.ctx.hit(e, ".settings-token-revoke");
    if (!revokeBtn) return;
    const ok = await confirmDialog({
      title: t("settingsRevokeTokenTitle"),
      message: t("settingsRevokeTokenMsg", revokeBtn.dataset.label),
      confirmLabel: t("settingsRevokeToken"),
      destructive: true
    });
    if (!ok) return;
    try {
      const body = revokeBtn.dataset.id ? { id: revokeBtn.dataset.id } : { label: revokeBtn.dataset.label };
      await this.ctx.fetch("/api/tokens", {
        method: "DELETE",
        body: JSON.stringify(body)
      });
      this.load();
    } catch (err) {
      this.ctx.showError(err.message);
    }
  }
}

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
class SettingsShares {
  constructor(ctx) {
    this.ctx = ctx;
    __publicField(this, "list", document.getElementById("settings-shares-list"));
    this.list.addEventListener("click", (e) => this.onClick(e));
  }
  async load() {
    this.list.innerHTML = "";
    try {
      const shares = await this.ctx.fetch("/api/share/list");
      if (!Array.isArray(shares) || shares.length === 0) {
        this.list.innerHTML = '<li class="text-sm text-ink-500">' + t("settingsNoShares") + "</li>";
        return;
      }
      this.list.innerHTML = shares.map((item) => {
        const exp = item.expires_at ? t("expiresShort", shareFormatDate(item.expires_at)) : t("noExpiry");
        const created = item.created_at ? t("createdShort", shareFormatDate(item.created_at)) : "";
        const pathEsc = escapeHtml(item.path || "");
        const broken = item.file_exists === false;
        const url = item.token ? location.origin + "/s/" + item.token : "";
        const urlEsc = escapeHtml(url);
        const urlLine = url ? '<div class="text-ink-300 font-mono text-xs truncate mt-0.5" title="' + urlEsc + '">' + urlEsc + "</div>" : "";
        const copyBtn = url ? '<button class="settings-share-copy px-3 py-1.5 text-sm bg-navy-700 hover:bg-navy-600 text-ink-200 rounded" data-url="' + urlEsc + '" title="' + escapeHtml(t("copy")) + '">' + t("copy") + "</button>" : "";
        return '<li class="admin-row bg-navy-900 border subtle-border rounded p-2.5 text-sm"><div class="flex-1 min-w-0"><div class="text-ink-100 font-medium truncate" title="' + pathEsc + '">' + pathEsc + (broken ? ' <span class="text-rose-300 text-xs font-normal">' + t("shareBroken") + "</span>" : "") + "</div>" + urlLine + '<div class="text-ink-500 text-xs mt-0.5">' + escapeHtml(created) + " &middot; " + escapeHtml(exp) + '</div></div><div class="admin-row__actions">' + copyBtn + (broken ? '<button class="settings-share-reactivate px-3 py-1.5 text-sm bg-navy-700 hover:bg-emerald-500/30 hover:text-emerald-300 text-ink-200 rounded" data-id="' + escapeHtml(item.id || "") + '" data-path="' + pathEsc + '" data-suggested="' + escapeHtml(item.suggested_path || "") + '">' + t("shareReactivate") + "</button>" : "") + '<button class="settings-share-revoke px-3 py-1.5 text-sm bg-navy-700 hover:bg-rose-500/30 hover:text-rose-300 text-ink-200 rounded" data-id="' + escapeHtml(item.id || "") + '">' + t("revoke") + "</button></div></li>";
      }).join("");
    } catch (e) {
      this.ctx.showError(e.message);
    }
  }
  async onClick(e) {
    const copyBtn = this.ctx.hit(e, ".settings-share-copy");
    if (copyBtn) {
      try {
        await navigator.clipboard.writeText(copyBtn.dataset.url || "");
        copyBtn.textContent = t("copied");
        setTimeout(() => copyBtn.textContent = t("copy"), 1200);
      } catch (_) {
      }
      return;
    }
    const reactivateBtn = this.ctx.hit(e, ".settings-share-reactivate");
    if (reactivateBtn) {
      const newPath = await promptDialog({
        title: t("shareReactivateTitle"),
        message: t("shareReactivateMsg", reactivateBtn.dataset.path || ""),
        value: reactivateBtn.dataset.suggested || "",
        placeholder: t("shareReactivatePlaceholder"),
        confirmLabel: t("shareReactivate")
      });
      if (!newPath) return;
      try {
        await this.ctx.fetch("/api/share/" + reactivateBtn.dataset.id, {
          method: "PATCH",
          body: JSON.stringify({ path: newPath.trim() })
        });
        this.load();
      } catch (err) {
        this.ctx.showError(err.message);
      }
      return;
    }
    const revokeBtn = this.ctx.hit(e, ".settings-share-revoke");
    if (!revokeBtn || !revokeBtn.dataset.id) return;
    const ok = await confirmDialog({
      title: t("revokeConfirmTitle"),
      message: t("revokeConfirmMsg"),
      confirmLabel: t("revoke"),
      destructive: true
    });
    if (!ok) return;
    try {
      await this.ctx.fetch("/api/share/" + revokeBtn.dataset.id, { method: "DELETE" });
      this.load();
    } catch (err) {
      this.ctx.showError(err.message);
    }
  }
}

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
class SettingsNodes {
  constructor(ctx) {
    this.ctx = ctx;
    __publicField(this, "list", document.getElementById("settings-nodes-list"));
    __publicField(this, "form", document.getElementById("settings-node-form"));
    __publicField(this, "result", document.getElementById("settings-node-result"));
    this.form.addEventListener("submit", (e) => this.submit(e));
    document.getElementById("settings-node-copy").addEventListener(
      "click",
      (e) => this.ctx.copyFromInput(e.currentTarget, "settings-node-link")
    );
    document.getElementById("settings-node-close").addEventListener("click", () => this.hideResult());
    this.list.addEventListener("click", (e) => this.onClick(e));
  }
  async load() {
    this.list.innerHTML = "";
    try {
      const nodes = await this.ctx.fetch("/api/admin/nodes");
      const active = Array.isArray(nodes) ? nodes.filter((n) => !n.revoked) : [];
      if (active.length === 0) {
        this.list.innerHTML = '<li class="text-sm text-ink-500">' + t("settingsNoNodes") + "</li>";
        return;
      }
      this.list.innerHTML = active.map((n) => {
        const created = n.created_at ? t("createdShort", shareFormatDate(n.created_at)) : "";
        const nameEsc = escapeHtml(n.name || "");
        const pathEsc = escapeHtml(n.path || "");
        return '<li class="admin-row bg-navy-900 border subtle-border rounded p-3 text-sm"><div class="flex-1 min-w-0"><div class="text-ink-100 font-medium font-mono truncate" title="' + nameEsc + '">' + nameEsc + '</div><div class="text-ink-300 font-mono text-xs truncate mt-0.5" title="' + pathEsc + '">' + pathEsc + '</div><div class="text-ink-500 text-xs mt-0.5">' + escapeHtml(created) + '</div></div><div class="admin-row__actions"><button class="settings-node-relink px-3 py-1.5 text-sm bg-navy-700 hover:bg-navy-600 text-ink-200 rounded" data-name="' + nameEsc + '" data-path="' + pathEsc + '" title="' + escapeHtml(t("settingsNodeRelinkTitle")) + '">' + t("settingsNodeRelink") + '</button><button class="settings-node-revoke px-3 py-1.5 text-sm bg-navy-700 hover:bg-rose-500/30 hover:text-rose-300 text-ink-200 rounded" data-name="' + nameEsc + '">' + t("revoke") + "</button></div></li>";
      }).join("");
    } catch (e) {
      this.ctx.showError(e.message);
    }
  }
  // Opens with the path pre-filled, suggesting a node name (from the tree's "share as node" button).
  prefill(path) {
    this.hideResult();
    const pathEl = document.getElementById("settings-node-path");
    const nameEl = document.getElementById("settings-node-name");
    if (pathEl) pathEl.value = path;
    if (nameEl) {
      nameEl.value = suggestNodeName(path);
      nameEl.focus();
      nameEl.select();
    }
  }
  async publishNode(name, path) {
    const data = await this.ctx.fetch("/api/admin/nodes", {
      method: "POST",
      body: JSON.stringify({ name, path })
    });
    document.getElementById("settings-node-link").value = data.link || "";
    this.result.classList.remove("hidden");
    this.load();
  }
  async submit(e) {
    e.preventDefault();
    this.ctx.clearError();
    const name = document.getElementById("settings-node-name").value.trim();
    const path = document.getElementById("settings-node-path").value.trim();
    if (!name || !path) return;
    try {
      await this.publishNode(name, path);
      this.form.reset();
    } catch (err) {
      this.ctx.showError(err.message);
    }
  }
  hideResult() {
    this.result.classList.add("hidden");
    document.getElementById("settings-node-link").value = "";
  }
  async onClick(e) {
    const relinkBtn = this.ctx.hit(e, ".settings-node-relink");
    if (relinkBtn) {
      const ok2 = await confirmDialog({
        title: t("settingsNodeRelinkTitle"),
        message: t("settingsNodeRelinkMsg", relinkBtn.dataset.name),
        confirmLabel: t("settingsNodeRelink")
      });
      if (!ok2) return;
      try {
        await this.publishNode(relinkBtn.dataset.name || "", relinkBtn.dataset.path || "");
      } catch (err) {
        this.ctx.showError(err.message);
      }
      return;
    }
    const revokeBtn = this.ctx.hit(e, ".settings-node-revoke");
    if (!revokeBtn || !revokeBtn.dataset.name) return;
    const ok = await confirmDialog({
      title: t("settingsRevokeNodeTitle"),
      message: t("settingsRevokeNodeMsg", revokeBtn.dataset.name),
      confirmLabel: t("revoke"),
      destructive: true
    });
    if (!ok) return;
    try {
      await this.ctx.fetch("/api/admin/nodes", {
        method: "DELETE",
        body: JSON.stringify({ name: revokeBtn.dataset.name })
      });
      this.load();
    } catch (err) {
      this.ctx.showError(err.message);
    }
  }
}

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
class SettingsRemotes {
  constructor(ctx) {
    this.ctx = ctx;
    __publicField(this, "list", document.getElementById("settings-remotes-list"));
    __publicField(this, "form", document.getElementById("settings-remote-form"));
    document.getElementById("btn-node-appropriate").addEventListener("click", () => this.appropriateFromDoc());
    document.getElementById("btn-node-remove").addEventListener("click", () => this.removeFromDoc());
    this.form.addEventListener("submit", (e) => this.submit(e));
    this.list.addEventListener("click", (e) => this.onClick(e));
  }
  async load() {
    this.list.innerHTML = "";
    try {
      const remotes = await this.ctx.fetch("/api/admin/remotes");
      if (!Array.isArray(remotes) || remotes.length === 0) {
        this.list.innerHTML = '<li class="text-sm text-ink-500">' + t("settingsNoRemotes") + "</li>";
        return;
      }
      this.list.innerHTML = remotes.map((r) => {
        const nameEsc = escapeHtml(r.name || "");
        const pathEsc = escapeHtml(r.path || "");
        const synced = r.last_sync_at ? t("settingsRemoteSynced", shareFormatDate(r.last_sync_at)) : t("settingsRemoteNeverSynced");
        const originHost = (r.url || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
        const originLine = originHost ? '<div class="text-xs text-sky-300/70 mt-0.5 truncate" title="' + escapeHtml(r.url || "") + '">' + escapeHtml(t("settingsRemoteFrom", originHost)) + "</div>" : "";
        const errLine = r.last_error ? '<div class="text-rose-400 text-xs mt-0.5 truncate" title="' + escapeHtml(r.last_error) + '">' + escapeHtml(t("settingsRemoteError", r.last_error)) + "</div>" : "";
        return '<li class="admin-row bg-navy-900 border subtle-border rounded p-3 text-sm"><div class="flex-1 min-w-0"><div class="text-ink-100 font-medium font-mono truncate" title="' + nameEsc + '">' + nameEsc + '</div><div class="text-ink-300 font-mono text-xs truncate mt-0.5" title="' + pathEsc + '">' + pathEsc + "</div>" + originLine + '<div class="text-ink-500 text-xs mt-0.5">' + escapeHtml(synced) + "</div>" + errLine + '</div><div class="admin-row__actions"><button class="settings-remote-sync px-3 py-1.5 text-sm bg-navy-700 hover:bg-navy-600 text-ink-200 rounded" data-name="' + nameEsc + '">' + t("settingsRemoteSync") + '</button><button class="settings-remote-appropriate px-3 py-1.5 text-sm bg-navy-700 hover:bg-navy-600 text-ink-200 rounded" data-name="' + nameEsc + '" title="' + escapeHtml(t("settingsRemoteAppropriateTitle")) + '">' + t("settingsRemoteAppropriate") + '</button><button class="settings-remote-del px-3 py-1.5 text-sm bg-navy-700 hover:bg-rose-500/30 hover:text-rose-300 text-ink-200 rounded" data-name="' + nameEsc + '">' + t("settingsRemoteRemove") + "</button></div></li>";
      }).join("");
    } catch (e) {
      this.ctx.showError(e.message);
    }
  }
  async submit(e) {
    e.preventDefault();
    this.ctx.clearError();
    const input = document.getElementById("settings-remote-link");
    const link = input.value.trim();
    if (!link) return;
    try {
      const res = await this.ctx.fetch("/api/admin/remotes", {
        method: "POST",
        body: JSON.stringify({ link })
      });
      input.value = "";
      if (res && res.sync && res.sync.ok === false) {
        this.ctx.showError(t("settingsRemoteSyncFailed", res.sync.error || ""));
      }
      this.load();
    } catch (err) {
      this.ctx.showError(err.message);
    }
  }
  async onClick(e) {
    const syncBtn = this.ctx.hit(e, ".settings-remote-sync");
    if (syncBtn) {
      syncBtn.disabled = true;
      try {
        const res = await this.ctx.fetch("/api/admin/remotes/sync", {
          method: "POST",
          body: JSON.stringify({ name: syncBtn.dataset.name })
        });
        const r = res && res.results ? res.results[syncBtn.dataset.name] : null;
        if (r && r.ok === false) this.ctx.showError(t("settingsRemoteSyncFailed", r.error || ""));
      } catch (err) {
        this.ctx.showError(err.message);
      }
      this.load();
      return;
    }
    const apprBtn = this.ctx.hit(e, ".settings-remote-appropriate");
    if (apprBtn) {
      const name = apprBtn.dataset.name;
      const dest = await promptDialog({
        title: t("settingsRemoteAppropriate"),
        message: t("settingsRemoteAppropriatePrompt", name),
        value: name,
        placeholder: t("appropriateDestPlaceholder"),
        confirmLabel: t("settingsRemoteAppropriate")
      });
      if (!dest) return;
      try {
        const res = await this.ctx.fetch("/api/admin/remotes/appropriate", {
          method: "POST",
          body: JSON.stringify({ name, source: "", dest })
        });
        this.ctx.showError(t("settingsRemoteAppropriated", String(res.copied || 0)));
      } catch (err) {
        this.ctx.showError(err.message);
      }
      return;
    }
    const delBtn = this.ctx.hit(e, ".settings-remote-del");
    if (!delBtn || !delBtn.dataset.name) return;
    const ok = await confirmDialog({
      title: t("settingsRemoteRemoveTitle"),
      message: t("settingsRemoteRemoveMsg", delBtn.dataset.name),
      confirmLabel: t("settingsRemoteRemove"),
      destructive: true
    });
    if (!ok) return;
    try {
      await this.ctx.fetch("/api/admin/remotes", {
        method: "DELETE",
        body: JSON.stringify({ name: delBtn.dataset.name })
      });
      this.load();
    } catch (err) {
      this.ctx.showError(err.message);
    }
  }
  // Appropriate from a mirror doc: node's only file → whole node, otherwise just that file.
  // Produces a detached, editable copy in your documents.
  async appropriateFromDoc() {
    const file = currentFile;
    if (!file) return;
    const info = remoteNodeInfo(file.path);
    if (!info) return;
    const whole = info.fileCount <= 1;
    const dest = await promptDialog({
      title: t("nodeAppropriateBtn"),
      message: whole ? t("nodeAppropriateWholePrompt", info.name) : t("nodeAppropriateFilePrompt", file.name),
      value: whole ? info.name : file.name || "",
      confirmLabel: t("nodeAppropriateBtn")
    });
    if (!dest) return;
    try {
      const res = await this.ctx.fetch("/api/admin/remotes/appropriate", {
        method: "POST",
        body: JSON.stringify({ name: info.name, source: whole ? "" : info.sourceRel, dest })
      });
      setStatus(t("settingsRemoteAppropriated", String(res.copied || 0)), "ok");
      await refreshTreeOrReload();
    } catch (e) {
      setStatus(t("err", e.message), "err");
    }
  }
  // Remove from a mirror doc = unsubscribe entirely: a single removed file would just come back on
  // the next sync, so we drop the whole subscription.
  async removeFromDoc() {
    const file = currentFile;
    if (!file) return;
    const info = remoteNodeInfo(file.path);
    if (!info) return;
    const ok = await confirmDialog({
      title: t("nodeRemoveTitle"),
      message: t("settingsRemoteRemoveMsg", info.name),
      confirmLabel: t("settingsRemoteRemove"),
      destructive: true
    });
    if (!ok) return;
    try {
      await this.ctx.fetch("/api/admin/remotes", {
        method: "DELETE",
        body: JSON.stringify({ name: info.name })
      });
      showWelcome();
      await refreshTreeOrReload();
    } catch (e) {
      setStatus(t("err", e.message), "err");
    }
  }
}

class SettingsGroups {
  constructor(ctx) {
    this.ctx = ctx;
    this.wire();
  }
  async load() {
    const list = document.getElementById("settings-groups-list");
    if (!list) return;
    list.innerHTML = "";
    try {
      const groups = await this.ctx.fetch("/api/admin/groups");
      const names = Object.keys(groups || {}).sort();
      if (!names.length) {
        list.innerHTML = '<li class="text-sm text-ink-500">' + t("settingsNoGroups") + "</li>";
        return;
      }
      list.innerHTML = names.map((name) => {
        const members = groups[name] || [];
        const nameEsc = escapeHtml(name);
        const membersEsc = escapeHtml(members.join(", "));
        return '<li class="bg-navy-900 border subtle-border rounded p-2.5 text-sm"><div class="admin-row"><div class="flex-1 min-w-0"><div class="text-ink-100 font-medium font-mono truncate">' + nameEsc + '</div><div class="text-ink-400 text-xs mt-0.5 truncate" title="' + membersEsc + '">' + (members.length ? membersEsc : '<span class="text-ink-500">' + t("settingsGroupEmpty") + "</span>") + '</div></div><div class="admin-row__actions"><button class="settings-group-edit px-3 py-1.5 text-sm bg-navy-700 hover:bg-navy-600 text-ink-200 rounded" data-name="' + nameEsc + '" data-members="' + membersEsc + '">' + t("settingsGroupEdit") + '</button><button class="settings-group-del px-3 py-1.5 text-sm bg-navy-700 hover:bg-rose-500/30 hover:text-rose-300 text-ink-200 rounded" data-name="' + nameEsc + '">' + t("settingsGroupDelete") + "</button></div></div></li>";
      }).join("");
    } catch (e) {
      this.ctx.showError(e.message);
    }
  }
  // Node path = a creatable combobox over the mind's existing folders; members = a creatable
  // multi/chips combobox (pick known accounts via /api/directory or type a new email). Both mount
  // once on static inputs that never leave the DOM, so no per-render teardown is needed.
  wire() {
    const nodePathEl = document.getElementById("settings-node-path");
    if (nodePathEl) AtlasCombobox(nodePathEl, { source: getAllDirs, creatable: true });
    const groupForm = document.getElementById("settings-group-form");
    if (!groupForm) return;
    const membersCb = AtlasCombobox(document.getElementById("settings-group-members"), {
      source: async () => {
        try {
          const r = await fetch("/api/directory");
          return r.ok ? (await r.json()).users || [] : [];
        } catch (_) {
          return [];
        }
      },
      creatable: true,
      multi: true,
      separator: ","
    });
    groupForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      this.ctx.clearError();
      const name = document.getElementById("settings-group-name").value.trim();
      const members = membersCb.getValue();
      try {
        await this.ctx.fetch("/api/admin/groups", {
          method: "POST",
          body: JSON.stringify({ name, members })
        });
        groupForm.reset();
        membersCb.clear();
        this.load();
      } catch (err) {
        this.ctx.showError(err.message);
      }
    });
    document.getElementById("settings-groups-list").addEventListener("click", async (e) => {
      const editBtn = this.ctx.hit(e, ".settings-group-edit");
      if (editBtn) {
        document.getElementById("settings-group-name").value = editBtn.dataset.name || "";
        membersCb.setValue(editBtn.dataset.members || "");
        document.getElementById("settings-group-name").focus();
        return;
      }
      const delBtn = this.ctx.hit(e, ".settings-group-del");
      if (delBtn) {
        const ok = await confirmDialog({
          title: t("settingsGroupDeleteTitle"),
          message: t("settingsGroupDeleteMsg", delBtn.dataset.name),
          confirmLabel: t("settingsGroupDelete"),
          destructive: true
        });
        if (!ok) return;
        try {
          await this.ctx.fetch("/api/admin/groups", {
            method: "DELETE",
            body: JSON.stringify({ name: delBtn.dataset.name })
          });
          this.load();
        } catch (err) {
          this.ctx.showError(err.message);
        }
      }
    });
  }
}

class SettingsProfile {
  constructor(ctx) {
    this.ctx = ctx;
  }
  async load() {
    const form = document.getElementById("account-profile-form");
    const first = document.getElementById("account-profile-first");
    const last = document.getElementById("account-profile-last");
    if (!form || !first || !last) return;
    if (!form.dataset.wired) {
      form.dataset.wired = "1";
      form.addEventListener("submit", (e) => this.save(e));
    }
    try {
      const data = await this.ctx.fetch("/api/account/profile");
      first.value = data.first_name || "";
      last.value = data.last_name || "";
      const avatar = document.getElementById("account-profile-avatar");
      if (avatar && data.email) avatar.innerHTML = constellationSvg(avatarSeed(data.first_name, data.last_name, data.email), 64);
    } catch (e) {
      this.ctx.showError(e.message);
    }
  }
  async save(e) {
    e.preventDefault();
    this.ctx.clearError();
    const btn = e.target.querySelector('button[type="submit"]');
    const first = document.getElementById("account-profile-first").value.trim();
    const last = document.getElementById("account-profile-last").value.trim();
    btn.disabled = true;
    try {
      await this.ctx.fetch("/api/account/profile", {
        method: "POST",
        body: JSON.stringify({ first_name: first, last_name: last })
      });
      const status = document.getElementById("account-profile-status");
      if (status) {
        status.textContent = t("profileSaved");
        status.classList.remove("hidden");
        setTimeout(() => status.classList.add("hidden"), 2500);
      }
    } catch (err) {
      this.ctx.showError(err.message);
    } finally {
      btn.disabled = false;
    }
  }
}

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
class SettingsPanel {
  constructor() {
    __publicField(this, "settingsBtn", document.getElementById("settings-btn"));
    __publicField(this, "settingsBackdrop", document.getElementById("settings-backdrop"));
    __publicField(this, "settingsClose", document.getElementById("settings-close"));
    // Shared services + the seven tab controllers. ctx is declared first so the controller field
    // initializers below can read it.
    __publicField(this, "ctx", new SettingsContext());
    __publicField(this, "users", new SettingsUsers(this.ctx));
    __publicField(this, "tokens", new SettingsTokens(this.ctx));
    __publicField(this, "shares", new SettingsShares(this.ctx));
    __publicField(this, "nodes", new SettingsNodes(this.ctx));
    __publicField(this, "remotes", new SettingsRemotes(this.ctx));
    __publicField(this, "groups", new SettingsGroups(this.ctx));
    __publicField(this, "profile", new SettingsProfile(this.ctx));
    this.settingsBtn.addEventListener("click", () => this.open());
    this.settingsClose.addEventListener("click", () => this.close());
    this.settingsBackdrop.addEventListener("click", (e) => {
      if (e.target === this.settingsBackdrop) this.close();
    });
    document.querySelectorAll(".settings-tab").forEach((tab) => {
      tab.addEventListener("click", () => this.selectTab(tab.dataset.tab));
    });
  }
  // ── error banner (called cross-file via the showSettingsError/clearSettingsError wrappers) ──
  showError(message) {
    this.ctx.showError(message);
  }
  clearError() {
    this.ctx.clearError();
  }
  // ── open / close / tabs ──
  open() {
    this.tokens.hideResult();
    this.settingsBackdrop.classList.remove("hidden");
    const isAdmin = document.body.classList.contains("admin-cloud");
    this.selectTab("security");
    if (isAdmin) this.refreshUpdateBanner();
  }
  close() {
    this.settingsBackdrop.classList.add("hidden");
  }
  // Opens Settings → Nodes with the path pre-filled (from the tree button). Called cross-file via
  // the openPublishNode wrapper (02-content-tree.ts).
  openPublish(path) {
    this.open();
    this.selectTab("nodes");
    this.nodes.prefill(path);
  }
  selectTab(name) {
    document.querySelectorAll(".settings-tab").forEach((tab) => {
      tab.classList.toggle("is-active", tab.dataset.tab === name);
    });
    document.querySelectorAll(".settings-pane").forEach((pane) => {
      pane.classList.add("hidden");
    });
    document.getElementById("settings-pane-" + name).classList.remove("hidden");
    this.ctx.clearError();
    if (name === "users") this.users.load();
    else if (name === "tokens") this.tokens.load();
    else if (name === "shares") this.shares.load();
    else if (name === "nodes") {
      this.nodes.load();
      this.remotes.load();
    } else if (name === "groups") this.groups.load();
    else if (name === "security") {
      refreshSecurityState();
      this.profile.load();
    }
  }
  // Admin-only, best-effort: never block Settings if the check fails/offline.
  async refreshUpdateBanner() {
    const banner = document.getElementById("settings-update-banner");
    if (!banner) return;
    banner.classList.add("hidden");
    try {
      const data = await this.ctx.fetch("/api/admin/update-check");
      if (data && data.update_available && data.latest) {
        banner.textContent = t("settingsUpdateAvailable").replace("{latest}", data.latest).replace("{current}", data.current || "?");
        banner.href = data.url || "https://pypi.org/project/atlas-mind/";
        banner.classList.remove("hidden");
      }
    } catch (_) {
    }
  }
}
const settingsPanel = new SettingsPanel();
function showSettingsError(message) {
  settingsPanel.showError(message);
}
function clearSettingsError() {
  settingsPanel.clearError();
}
function closeSettings() {
  settingsPanel.close();
}
function openPublishNode(path) {
  settingsPanel.openPublish(path);
}

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
(function(root) {
  "use strict";
  class Gf256 {
    // length 256
    constructor() {
      __publicField(this, "exp");
      // antilog, length 512 (doubled so log[a]+log[b] never overflows)
      __publicField(this, "log");
      this.exp = new Array(512);
      this.log = new Array(256);
      let x = 1;
      for (let i = 0; i < 255; i++) {
        this.exp[i] = x;
        this.log[x] = i;
        x <<= 1;
        if (x & 256) x ^= 285;
      }
      for (let i = 255; i < 512; i++) this.exp[i] = this.exp[i - 255];
    }
    mul(a, b) {
      return a === 0 || b === 0 ? 0 : this.exp[this.log[a] + this.log[b]];
    }
    // EC codewords for `data`: the remainder of the GF polynomial division by the
    // degree-ecLen generator.
    rsEncode(data, ecLen) {
      const gen = this.genPoly(ecLen);
      const buf = data.concat(new Array(ecLen).fill(0));
      for (let i = 0; i < data.length; i++) {
        const coef = buf[i];
        if (coef === 0) continue;
        for (let j = 1; j < gen.length; j++) buf[i + j] ^= this.mul(gen[j], coef);
      }
      return buf.slice(data.length);
    }
    genPoly(n) {
      let poly = [1];
      for (let i = 0; i < n; i++) {
        const next = new Array(poly.length + 1).fill(0);
        for (let j = 0; j < poly.length; j++) {
          next[j] ^= poly[j];
          next[j + 1] ^= this.mul(poly[j], this.exp[i]);
        }
        poly = next;
      }
      return poly;
    }
  }
  const _QrCode = class _QrCode {
    constructor(text) {
      // The encoded module matrix (0/1), or null if the text exceeds v10 capacity.
      __publicField(this, "matrix");
      __publicField(this, "size", 0);
      __publicField(this, "m", []);
      __publicField(this, "reserved", []);
      const bytes = _QrCode.toBytes(text);
      const spec = _QrCode.pickVersion(bytes.length);
      this.matrix = spec ? this.build(bytes, spec) : null;
    }
    // text -> UTF-8 bytes.
    static toBytes(text) {
      const bytes = [];
      for (let i = 0; i < text.length; i++) {
        const cp = text.charCodeAt(i);
        if (cp < 128) bytes.push(cp);
        else if (cp < 2048) bytes.push(192 | cp >> 6, 128 | cp & 63);
        else bytes.push(224 | cp >> 12, 128 | cp >> 6 & 63, 128 | cp & 63);
      }
      return bytes;
    }
    // Smallest version whose payload capacity fits `len` bytes.
    static pickVersion(len) {
      for (const v of _QrCode.VERSIONS) if (len <= v.maxPayloadBytes) return v;
      return null;
    }
    build(bytes, spec) {
      const codewords = this.assembleCodewords(bytes, spec);
      this.buildMatrix(spec, codewords);
      return this.selectMask();
    }
    // Byte mode bitstream (mode + count + data + terminator + pad) split into RS blocks,
    // each EC-encoded, then data + EC interleaved into the final codeword sequence.
    assembleCodewords(bytes, spec) {
      const countBits = spec.version <= 9 ? 8 : 16;
      const bits = [];
      const push = (val, n) => {
        for (let i = n - 1; i >= 0; i--) bits.push(val >> i & 1);
      };
      push(4, 4);
      push(bytes.length, countBits);
      for (const b of bytes) push(b, 8);
      const dataCw = spec.totalCodewords - spec.ecPerBlock * spec.blocks;
      const maxBits = dataCw * 8;
      for (let i = 0; i < 4 && bits.length < maxBits; i++) bits.push(0);
      while (bits.length % 8 !== 0) bits.push(0);
      const dataBytes = [];
      for (let i = 0; i < bits.length; i += 8) {
        let b = 0;
        for (let j = 0; j < 8; j++) b = b << 1 | bits[i + j];
        dataBytes.push(b);
      }
      const pads = [236, 17];
      let pi = 0;
      while (dataBytes.length < dataCw) dataBytes.push(pads[pi++ & 1]);
      const perBlock = Math.floor(dataCw / spec.blocks);
      const remainder = dataCw - perBlock * spec.blocks;
      const dataBlocks = [];
      const ecBlocks = [];
      let off = 0;
      for (let bI = 0; bI < spec.blocks; bI++) {
        const sz = perBlock + (bI >= spec.blocks - remainder ? 1 : 0);
        const chunk = dataBytes.slice(off, off + sz);
        off += sz;
        dataBlocks.push(chunk);
        ecBlocks.push(_QrCode.gf.rsEncode(chunk, spec.ecPerBlock));
      }
      const finalCw = [];
      const maxData = Math.max(...dataBlocks.map((b) => b.length));
      for (let i = 0; i < maxData; i++)
        for (const blk of dataBlocks) if (i < blk.length) finalCw.push(blk[i]);
      for (let i = 0; i < spec.ecPerBlock; i++) for (const blk of ecBlocks) finalCw.push(blk[i]);
      return finalCw;
    }
    // ── matrix construction (fills this.m / this.reserved / this.size) ──
    buildMatrix(spec, codewords) {
      this.size = 17 + spec.version * 4;
      this.m = [];
      this.reserved = [];
      for (let r = 0; r < this.size; r++) {
        this.m.push(new Array(this.size).fill(null));
        this.reserved.push(new Array(this.size).fill(false));
      }
      this.finders();
      this.timing();
      this.setF(this.size - 8, 8, 1);
      this.alignment(spec);
      this.versionInfo(spec);
      this.reserveFormatArea();
      this.placeData(codewords);
    }
    setF(r, c, v) {
      this.m[r][c] = v ? 1 : 0;
      this.reserved[r][c] = true;
    }
    finders() {
      const finder = (r, c) => {
        for (let i = -1; i <= 7; i++)
          for (let j = -1; j <= 7; j++) {
            const rr = r + i, cc = c + j;
            if (rr < 0 || cc < 0 || rr >= this.size || cc >= this.size) continue;
            const inRing = i >= 0 && i <= 6 && (j === 0 || j === 6) || j >= 0 && j <= 6 && (i === 0 || i === 6);
            const inCore = i >= 2 && i <= 4 && j >= 2 && j <= 4;
            this.setF(rr, cc, inRing || inCore ? 1 : 0);
          }
      };
      finder(0, 0);
      finder(0, this.size - 7);
      finder(this.size - 7, 0);
    }
    timing() {
      for (let i = 8; i < this.size - 8; i++) {
        this.setF(6, i, i % 2 === 0 ? 1 : 0);
        this.setF(i, 6, i % 2 === 0 ? 1 : 0);
      }
    }
    alignment(spec) {
      const ac = _QrCode.ALIGN[spec.version];
      for (const r of ac)
        for (const c of ac) {
          if (r <= 7 && c <= 7 || r <= 7 && c >= this.size - 8 || r >= this.size - 8 && c <= 7) continue;
          for (let i = -2; i <= 2; i++)
            for (let j = -2; j <= 2; j++) {
              const ring = Math.max(Math.abs(i), Math.abs(j));
              this.setF(r + i, c + j, ring === 2 || ring === 0 ? 1 : 0);
            }
        }
    }
    // Version information (mandatory from v7): 6 version bits + 12 BCH(18,6) bits
    // (generator 0x1f25), placed in two 6x3 blocks.
    versionInfo(spec) {
      if (spec.version < 7) return;
      let vbits = spec.version << 12;
      const vg = 7973;
      for (let i = 5; i >= 0; i--) if (vbits >> i + 12 & 1) vbits ^= vg << i;
      const vfull = spec.version << 12 | vbits;
      for (let i = 0; i < 18; i++) {
        const bit = vfull >> i & 1;
        const r = Math.floor(i / 3);
        const c = i % 3;
        this.setF(this.size - 11 + c, r, bit);
        this.setF(r, this.size - 11 + c, bit);
      }
    }
    // Reserve EXACTLY the format-info modules (same cells placeFormat writes).
    reserveFormatArea() {
      for (let i = 0; i <= 8; i++) {
        this.reserved[8][i] = true;
        this.reserved[i][8] = true;
      }
      for (let i = 0; i < 7; i++) this.reserved[this.size - 1 - i][8] = true;
      for (let i = 0; i < 8; i++) this.reserved[8][this.size - 1 - i] = true;
    }
    // Place the data bits in the upward/downward zigzag over the free modules.
    placeData(codewords) {
      let bitIdx = 0;
      const totalBits = codewords.length * 8;
      const bitAt = (i) => i < totalBits ? codewords[i >> 3] >> 7 - (i & 7) & 1 : 0;
      let dir = -1;
      for (let col = this.size - 1; col > 0; col -= 2) {
        if (col === 6) col--;
        for (let n = 0; n < this.size; n++) {
          const row = dir < 0 ? this.size - 1 - n : n;
          for (let k = 0; k < 2; k++) {
            const cc = col - k;
            if (this.reserved[row][cc]) continue;
            this.m[row][cc] = bitAt(bitIdx++);
          }
        }
        dir = -dir;
      }
    }
    // ── mask selection ──
    selectMask() {
      let best = null;
      let bestPen = Infinity;
      for (let mask = 0; mask < 8; mask++) {
        const masked = this.applyMask(mask);
        this.placeFormat(masked, mask);
        const pen = this.penalty(masked);
        if (pen < bestPen) {
          bestPen = pen;
          best = masked;
        }
      }
      return best;
    }
    // Fresh copy of this.m with the mask pattern XORed over the non-reserved modules.
    applyMask(mask) {
      const out = [];
      for (let r = 0; r < this.size; r++) out.push(this.m[r].slice());
      for (let r = 0; r < this.size; r++)
        for (let c = 0; c < this.size; c++) {
          if (this.reserved[r][c]) continue;
          let flip = false;
          switch (mask) {
            case 0:
              flip = (r + c) % 2 === 0;
              break;
            case 1:
              flip = r % 2 === 0;
              break;
            case 2:
              flip = c % 3 === 0;
              break;
            case 3:
              flip = (r + c) % 3 === 0;
              break;
            case 4:
              flip = (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
              break;
            case 5:
              flip = r * c % 2 + r * c % 3 === 0;
              break;
            case 6:
              flip = (r * c % 2 + r * c % 3) % 2 === 0;
              break;
            case 7:
              flip = ((r + c) % 2 + r * c % 3) % 2 === 0;
              break;
          }
          if (flip) out[r][c] ^= 1;
        }
      return out;
    }
    // ECC level L = 01. Format bits = BCH(15,5) then XOR 0x5412, placed in the two
    // ISO/IEC 18004 copies around the finders. Mutates the given matrix.
    placeFormat(m, mask) {
      const data = 1 << 3 | mask;
      let bits = data << 10;
      const g = 1335;
      for (let i = 4; i >= 0; i--) if (bits >> i + 10 & 1) bits ^= g << i;
      const fmt = (data << 10 | bits) ^ 21522;
      for (let i = 0; i < 15; i++) {
        const bit = fmt >> i & 1;
        let vr;
        if (i < 6) vr = i;
        else if (i < 8) vr = i + 1;
        else vr = this.size - 15 + i;
        m[vr][8] = bit;
        let hc;
        if (i < 8) hc = this.size - i - 1;
        else if (i < 9) hc = 15 - i;
        else hc = 15 - i - 1;
        m[8][hc] = bit;
      }
    }
    // Mask-penalty score (Rule 1: same-colour runs >= 5, rows + columns).
    penalty(m) {
      let p = 0;
      for (let r = 0; r < this.size; r++)
        for (const horiz of [true, false]) {
          let run = 1;
          let prev = -1;
          for (let c = 0; c < this.size; c++) {
            const v = horiz ? m[r][c] : m[c][r];
            if (v === prev) {
              run++;
              if (run === 5) p += 3;
              else if (run > 5) p += 1;
            } else {
              run = 1;
              prev = v;
            }
          }
        }
      return p;
    }
  };
  __publicField(_QrCode, "gf", new Gf256());
  // Exact ISO/IEC 18004 capacity rows (level L). From v6 on the data is split into
  // MULTIPLE RS blocks then interleaved — treating it as one block is unreadable.
  // maxPayloadBytes = dataCodewords − header overhead (mode + counter).
  __publicField(_QrCode, "VERSIONS", [
    { version: 1, totalCodewords: 26, ecPerBlock: 7, blocks: 1, maxPayloadBytes: 17 },
    { version: 2, totalCodewords: 44, ecPerBlock: 10, blocks: 1, maxPayloadBytes: 32 },
    { version: 3, totalCodewords: 70, ecPerBlock: 15, blocks: 1, maxPayloadBytes: 53 },
    { version: 4, totalCodewords: 100, ecPerBlock: 20, blocks: 1, maxPayloadBytes: 78 },
    { version: 5, totalCodewords: 134, ecPerBlock: 26, blocks: 1, maxPayloadBytes: 106 },
    { version: 6, totalCodewords: 172, ecPerBlock: 18, blocks: 2, maxPayloadBytes: 134 },
    { version: 7, totalCodewords: 196, ecPerBlock: 20, blocks: 2, maxPayloadBytes: 154 },
    { version: 8, totalCodewords: 242, ecPerBlock: 24, blocks: 2, maxPayloadBytes: 192 },
    { version: 9, totalCodewords: 292, ecPerBlock: 30, blocks: 2, maxPayloadBytes: 230 },
    { version: 10, totalCodewords: 346, ecPerBlock: 18, blocks: 4, maxPayloadBytes: 271 }
  ]);
  // Alignment-pattern center coordinates per version.
  __publicField(_QrCode, "ALIGN", {
    1: [],
    2: [6, 18],
    3: [6, 22],
    4: [6, 26],
    5: [6, 30],
    6: [6, 34],
    7: [6, 22, 38],
    8: [6, 24, 42],
    9: [6, 26, 46],
    10: [6, 28, 50]
  });
  let QrCode2 = _QrCode;
  root.QrCode = QrCode2;
})(typeof window !== "undefined" ? window : globalThis);
function renderQrCanvas(el, text, sizePx) {
  const matrix = new QrCode(text).matrix;
  if (!matrix) return false;
  const n = matrix.length;
  const quiet = 4;
  const total = n + quiet * 2;
  const scale = Math.max(2, Math.floor(sizePx / total));
  const px = total * scale;
  const canvas = document.createElement("canvas");
  canvas.width = px;
  canvas.height = px;
  canvas.style.width = px + "px";
  canvas.style.height = px + "px";
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = "#000";
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      if (matrix[r][c]) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
    }
  el.innerHTML = "";
  el.appendChild(canvas);
  return true;
}

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
const _TotpEnrollModal = class _TotpEnrollModal {
  constructor() {
    // a 6-digit code is a TOTP, anything else a recovery code
    __publicField(this, "backdrop", document.getElementById("totp-backdrop"));
    __publicField(this, "modalTitle", document.getElementById("totp-title"));
    __publicField(this, "errorBox", document.getElementById("totp-error"));
    __publicField(this, "closeBtn", document.getElementById("totp-close"));
    __publicField(this, "stepEnroll", document.getElementById("totp-step-enroll"));
    __publicField(this, "stepRecovery", document.getElementById("totp-step-recovery"));
    __publicField(this, "stepDisable", document.getElementById("totp-step-disable"));
    __publicField(this, "qr", document.getElementById("totp-qr"));
    __publicField(this, "secretValue", document.getElementById("totp-secret-value"));
    __publicField(this, "secretCopy", document.getElementById("totp-secret-copy"));
    __publicField(this, "verifyForm", document.getElementById("totp-verify-form"));
    __publicField(this, "verifyCode", document.getElementById("totp-verify-code"));
    __publicField(this, "verifySubmit", document.getElementById("totp-verify-submit"));
    __publicField(this, "enrollCancel", document.getElementById("totp-enroll-cancel"));
    __publicField(this, "recoveryList", document.getElementById("totp-recovery-list"));
    __publicField(this, "recoveryCopy", document.getElementById("totp-recovery-copy"));
    __publicField(this, "recoveryDone", document.getElementById("totp-recovery-done"));
    __publicField(this, "disableForm", document.getElementById("totp-disable-form"));
    __publicField(this, "disableCode", document.getElementById("totp-disable-code"));
    __publicField(this, "disableSubmit", document.getElementById("totp-disable-submit"));
    // ---- state ----
    __publicField(this, "recoveryCodes", []);
    // shown ONCE after enable, held only until the modal closes
    // Escape handler bound once: added in the CAPTURE phase so it closes only this modal, and removed
    // by the same reference on close.
    __publicField(this, "keyHandler", (e) => this.onKey(e));
    this.wire();
  }
  // ---- modal open / close ----
  openModal(mode) {
    this.clearError();
    this.stepEnroll.classList.toggle("hidden", mode !== "enroll");
    this.stepRecovery.classList.add("hidden");
    this.stepDisable.classList.toggle("hidden", mode !== "disable");
    this.modalTitle.textContent = mode === "disable" ? t("totpModalDisableTitle") : t("totpModalTitle");
    this.backdrop.classList.remove("hidden");
    document.addEventListener("keydown", this.keyHandler, true);
  }
  closeModal() {
    this.backdrop.classList.add("hidden");
    document.removeEventListener("keydown", this.keyHandler, true);
    this.recoveryCodes = [];
  }
  // Capture + stopPropagation so Escape closes only the 2FA modal, never the Settings panel
  // underneath. While the recovery codes are shown, Escape is blocked (explicit "Done" required).
  onKey(e) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    if (this.stepRecovery.classList.contains("hidden")) this.closeModal();
  }
  showError(msg) {
    this.errorBox.textContent = msg;
    this.errorBox.classList.remove("hidden");
  }
  clearError() {
    this.errorBox.classList.add("hidden");
    this.errorBox.textContent = "";
  }
  // ---- enable: init (secret + URI) → show QR + secret → verification ----
  // The Security pane keeps its enable button disabled for the round-trip; this owns only the flow.
  async enroll() {
    try {
      const data = await settingsFetch("/api/account/totp/init", {
        method: "POST",
        body: JSON.stringify({})
      });
      this.secretValue.value = data.secret || "";
      this.verifyCode.value = "";
      this.qr.innerHTML = "";
      const ok = !!data.otpauth_uri && renderQrCanvas(this.qr, data.otpauth_uri, 184);
      this.qr.classList.toggle("hidden", !ok);
      this.openModal("enroll");
      setTimeout(() => this.verifyCode.focus(), 60);
    } catch (err) {
      showSettingsError(err.message || t("settingsErrGeneric"));
    }
  }
  async verifyEnable(e) {
    e.preventDefault();
    this.clearError();
    const code = this.verifyCode.value.trim();
    if (!code) {
      this.showError(t("totpCodeRequired"));
      return;
    }
    this.verifySubmit.disabled = true;
    try {
      const data = await settingsFetch("/api/account/totp/enable", {
        method: "POST",
        body: JSON.stringify({ code })
      });
      setCsrfToken(readCsrfCookie());
      totpEnabled = true;
      refreshSecurityState();
      this.recoveryCodes = Array.isArray(data.recovery_codes) ? data.recovery_codes : [];
      this.recoveryList.innerHTML = this.recoveryCodes.map(
        (c) => '<li class="bg-black/40 border subtle-border rounded px-2 py-1.5 text-center select-all">' + escapeHtml(c) + "</li>"
      ).join("");
      this.stepEnroll.classList.add("hidden");
      this.stepRecovery.classList.remove("hidden");
      setStatus(t("totpEnabledToast"), "ok");
    } catch (err) {
      const fail = err;
      this.showError(fail.status === 400 ? t("totpInvalidCode") : fail.message || t("settingsErrGeneric"));
    } finally {
      this.verifySubmit.disabled = false;
    }
  }
  async copySecret() {
    try {
      await navigator.clipboard.writeText(this.secretValue.value);
      this.secretCopy.textContent = t("copied");
      setTimeout(() => this.secretCopy.textContent = t("copy"), 1200);
    } catch (e) {
      this.secretValue.select();
    }
  }
  async copyRecovery() {
    try {
      await navigator.clipboard.writeText(this.recoveryCodes.join("\n"));
      this.recoveryCopy.textContent = t("copied");
      setTimeout(() => this.recoveryCopy.textContent = t("totpRecoveryCopy"), 1200);
    } catch (e) {
    }
  }
  // ---- disable: asks for a code (TOTP or recovery) ----
  openDisable() {
    this.disableCode.value = "";
    this.openModal("disable");
    setTimeout(() => this.disableCode.focus(), 60);
  }
  async disable(e) {
    e.preventDefault();
    this.clearError();
    const code = this.disableCode.value.trim();
    if (!code) {
      this.showError(t("totpCodeRequired"));
      return;
    }
    this.disableSubmit.disabled = true;
    try {
      const body = _TotpEnrollModal.SIX_DIGITS.test(code) ? { code } : { recovery: code };
      await settingsFetch("/api/account/totp/disable", {
        method: "POST",
        body: JSON.stringify(body)
      });
      setCsrfToken(readCsrfCookie());
      totpEnabled = false;
      refreshSecurityState();
      this.closeModal();
      setStatus(t("totpDisabledToast"), "ok");
    } catch (err) {
      const fail = err;
      this.showError(fail.status === 400 ? t("totpInvalidCode") : fail.message || t("settingsErrGeneric"));
    } finally {
      this.disableSubmit.disabled = false;
    }
  }
  wire() {
    this.verifyForm.addEventListener("submit", (e) => this.verifyEnable(e));
    this.secretCopy.addEventListener("click", () => this.copySecret());
    this.recoveryCopy.addEventListener("click", () => this.copyRecovery());
    this.enrollCancel.addEventListener("click", () => this.closeModal());
    this.recoveryDone.addEventListener("click", () => this.closeModal());
    this.closeBtn.addEventListener("click", () => {
      if (this.stepRecovery.classList.contains("hidden")) this.closeModal();
    });
    this.backdrop.addEventListener("click", (e) => {
      if (e.target === this.backdrop && this.stepRecovery.classList.contains("hidden")) this.closeModal();
    });
    this.disableForm.addEventListener("submit", (e) => this.disable(e));
  }
};
__publicField(_TotpEnrollModal, "SIX_DIGITS", /^[0-9]{6}$/);
let TotpEnrollModal = _TotpEnrollModal;
const totpModal = new TotpEnrollModal();

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
class SecurityPane {
  constructor() {
    __publicField(this, "statusBadge", document.getElementById("security-totp-status"));
    __publicField(this, "enableBtn", document.getElementById("security-totp-enable"));
    __publicField(this, "disableBtn", document.getElementById("security-totp-disable"));
    __publicField(this, "logoutAllBtn", document.getElementById("security-logout-all"));
    this.wire();
  }
  // totpEnabled is updated by /api/me and by the enable/disable actions.
  refreshState() {
    this.statusBadge.textContent = totpEnabled ? t("securityTotpStatusOn") : t("securityTotpStatusOff");
    this.statusBadge.classList.toggle("bg-emerald-500/20", totpEnabled);
    this.statusBadge.classList.toggle("text-emerald-300", totpEnabled);
    this.statusBadge.classList.toggle("bg-ink-500/15", !totpEnabled);
    this.statusBadge.classList.toggle("text-ink-400", !totpEnabled);
    this.enableBtn.classList.toggle("hidden", totpEnabled);
    this.disableBtn.classList.toggle("hidden", !totpEnabled);
  }
  // The enable button stays disabled for the whole init round-trip (no double-submit); the modal owns
  // the enrollment flow itself.
  async enable() {
    this.enableBtn.disabled = true;
    try {
      await totpModal.enroll();
    } finally {
      this.enableBtn.disabled = false;
    }
  }
  // ---- log out all my sessions: in-app confirmation then redirect to /login ----
  async logoutAll() {
    const ok = await confirmDialog({
      title: t("securityLogoutAllConfirmTitle"),
      message: t("securityLogoutAllConfirmMsg"),
      confirmLabel: t("securityLogoutAllConfirm"),
      destructive: true
    });
    if (!ok) return;
    this.logoutAllBtn.disabled = true;
    try {
      await settingsFetch("/api/account/logout-all", { method: "POST", body: JSON.stringify({}) });
      window.location.href = "/login";
    } catch (err) {
      showSettingsError(err.message || t("settingsErrGeneric"));
      this.logoutAllBtn.disabled = false;
    }
  }
  wire() {
    this.enableBtn.addEventListener("click", () => this.enable());
    this.disableBtn.addEventListener("click", () => totpModal.openDisable());
    this.logoutAllBtn.addEventListener("click", () => this.logoutAll());
  }
}
const securityPane = new SecurityPane();

function refreshSecurityState() {
  securityPane.refreshState();
}

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
const qcBtn = document.getElementById("quick-capture-btn");
const qcBackdrop = document.getElementById("quick-capture-backdrop");
const qcForm = document.getElementById("quick-capture-form");
const qcTitle = document.getElementById("quick-capture-title");
const qcBody = document.getElementById("quick-capture-body");
const qcCancel = document.getElementById("quick-capture-cancel");
const qcError = document.getElementById("quick-capture-error");
class QuickCaptureModal extends Modal {
  constructor() {
    super(qcBackdrop);
    // qc* are the nullable getElementById consts above; assert/cast to the precise type here.
    __publicField(this, "title", qcTitle);
    __publicField(this, "body", qcBody);
    __publicField(this, "error", qcError);
    qcBtn.addEventListener("click", () => this.open());
    qcCancel.addEventListener("click", () => this.close());
    document.getElementById("quick-capture-close")?.addEventListener("click", () => this.close());
    qcForm.addEventListener("submit", (e) => this.submit(e));
  }
  open() {
    if (window.__viewerMode) return;
    this.error.classList.add("hidden");
    this.title.value = "";
    this.body.value = "";
    this.reveal();
    setTimeout(() => this.title.focus(), 50);
  }
  async submit(e) {
    e.preventDefault();
    this.error.classList.add("hidden");
    const title = this.title.value.trim();
    if (!title) {
      this.error.textContent = t("titleRequired");
      this.error.classList.remove("hidden");
      return;
    }
    const body = this.body.value.trim();
    const now = /* @__PURE__ */ new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const dateStr = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate()) + "-" + pad(now.getHours()) + pad(now.getMinutes());
    const slug = (slugify(title) || "note").slice(0, 50);
    const path = "inbox/" + dateStr + "-" + slug + ".md";
    const content = "# " + title + "\n\n_Capture : " + now.toLocaleString("fr-FR") + "_\n\n" + body + "\n";
    try {
      const res = await fetch("/api/file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, content })
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      this.close();
      setStatus(t("noteSaved"), "ok");
    } catch (e2) {
      this.error.textContent = t("err", e2.message);
      this.error.classList.remove("hidden");
    }
  }
}
const quickCaptureModal = new QuickCaptureModal();

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
class TemplateRegistry {
  constructor(template, name, dir) {
    this.template = template;
    this.name = name;
    this.dir = dir;
    __publicField(this, "extArea", document.getElementById("new-file-ext-area"));
    // Extension templates, keyed by select value. Null prototype: `for..in` yields only real entries.
    __publicField(this, "providers", /* @__PURE__ */ Object.create(null));
    this.populateOptions();
  }
  // Fills a DOC_TEMPLATES skeleton: tokens {{title}}, {{date}} (UI-locale long form), {{isoDate}}
  // (YYYY-MM-DD). Unknown kind (incl. 'blank') → title only.
  static buildContent(kind, title) {
    const template = DOC_TEMPLATES[kind];
    if (!template) return "# " + title + "\n\n";
    const locale = LANG === "en" ? "en-GB" : "fr-FR";
    const today = (/* @__PURE__ */ new Date()).toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric" });
    const isoDate = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    return template.replaceAll("{{title}}", title).replaceAll("{{date}}", today).replaceAll("{{isoDate}}", isoDate);
  }
  // The provider bound to the current select value, or null for a built-in skeleton / 'blank'.
  activeProvider() {
    return this.providers[this.template.value] || null;
  }
  // Run every registered provider's onOpen() hook (NewFileModal.open). A thrown hook is logged, never fatal.
  runOpenHooks() {
    for (const value in this.providers) {
      const provider = this.providers[value];
      if (provider.onOpen) {
        try {
          provider.onOpen();
        } catch (err) {
          console.warn("[extension] onOpen", value, err);
        }
      }
    }
  }
  updateExtras() {
    const active = this.activeProvider();
    for (const value in this.providers) {
      const provider = this.providers[value];
      if (provider.block) provider.block.classList.toggle("hidden", provider !== active);
    }
    this.name.placeholder = active && active.namePlaceholder || t("docNamePlaceholder");
    if (active && active.defaultDir && !this.dir.value.trim()) {
      this.dir.value = active.defaultDir;
    }
  }
  // "Blank" stays the reserved first option; skeleton names cannot override it.
  populateOptions() {
    for (const skelName of Object.keys(DOC_TEMPLATES).sort()) {
      if (skelName === "blank") continue;
      const option = document.createElement("option");
      option.value = skelName;
      option.textContent = skelName;
      this.template.appendChild(option);
    }
  }
  // window.Atlas.registerTemplate. Rejected: a falsy value/provider or one without generate(),
  // 'blank', a DOC_TEMPLATES skeleton of the same name, or an already-registered value.
  registerTemplate(value, provider) {
    if (!value || !provider || typeof provider.generate !== "function") return false;
    if (value === "blank" || this.providers[value] || DOC_TEMPLATES[value]) return false;
    this.providers[value] = provider;
    const option = document.createElement("option");
    option.value = value;
    option.textContent = provider.label || value;
    this.template.appendChild(option);
    if (provider.block) {
      provider.block.classList.add("hidden");
      this.extArea.appendChild(provider.block);
    }
    return true;
  }
}

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
class DirRenameModal extends Modal {
  constructor() {
    super(dirRenameBackdrop);
    __publicField(this, "form", document.getElementById("dir-rename-form"));
    __publicField(this, "input", document.getElementById("dir-rename-input"));
    __publicField(this, "current", document.getElementById("dir-rename-current"));
    __publicField(this, "error", document.getElementById("dir-rename-error"));
    __publicField(this, "cancel", document.getElementById("dir-rename-cancel"));
    __publicField(this, "sourcePath", null);
    this.cancel.addEventListener("click", () => this.close());
    document.getElementById("dir-rename-close")?.addEventListener("click", () => this.close());
    this.form.addEventListener("submit", (e) => this.submit(e));
  }
  open(path) {
    if (window.__viewerMode || !path) return;
    this.sourcePath = path;
    const parts = path.split("/");
    this.current.textContent = path;
    this.input.value = parts[parts.length - 1];
    this.error.classList.add("hidden");
    this.reveal();
    setTimeout(() => {
      this.input.focus();
      this.input.select();
    }, 50);
  }
  close() {
    super.close();
    this.sourcePath = null;
  }
  async submit(e) {
    e.preventDefault();
    this.error.classList.add("hidden");
    if (!this.sourcePath) return;
    const newName = this.input.value.trim().replace(/^\/+|\/+$/g, "");
    if (!newName) {
      this.error.textContent = t("nameRequired");
      this.error.classList.remove("hidden");
      return;
    }
    if (/[\\\/]/.test(newName)) {
      this.error.textContent = t("noSlashes");
      this.error.classList.remove("hidden");
      return;
    }
    const parts = this.sourcePath.split("/");
    parts[parts.length - 1] = newName;
    const newPath = parts.join("/");
    if (newPath === this.sourcePath) {
      this.close();
      return;
    }
    try {
      const res = await fetch("/api/dir/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: this.sourcePath, to: newPath })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "HTTP " + res.status);
      }
      this.close();
      setStatus(t("folderRenamed"), "ok");
      await refreshTreeOrReload();
    } catch (err) {
      this.error.textContent = t("errSp", err.message);
      this.error.classList.remove("hidden");
    }
  }
}

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
const newFileBtn = document.getElementById("new-file-btn");
const newFileBackdrop = document.getElementById("new-file-backdrop");
const dirRenameBackdrop = document.getElementById("dir-rename-backdrop");
function getAllDirs() {
  const dirs = /* @__PURE__ */ new Set();
  (function walk(node, prefix) {
    const children = node.type === "dir" ? node.children : [];
    for (const c of children) {
      if (c.type === "dir") {
        const path = prefix ? prefix + "/" + c.name : c.name;
        dirs.add(path);
        walk(c, path);
      }
    }
  })(TREE, "");
  return Array.from(dirs).sort();
}
async function refreshTreeOrReload() {
  if (window.softReload) await window.softReload();
  else location.reload();
}
class NewFileModal extends Modal {
  constructor() {
    super(newFileBackdrop);
    __publicField(this, "form", document.getElementById("new-file-form"));
    __publicField(this, "dir", document.getElementById("new-file-dir"));
    __publicField(this, "name", document.getElementById("new-file-name"));
    __publicField(this, "template", document.getElementById("new-file-template"));
    __publicField(this, "visibility", document.getElementById("new-file-visibility"));
    __publicField(this, "error", document.getElementById("new-file-error"));
    __publicField(this, "cancel", document.getElementById("new-file-cancel"));
    // The template <select> — its options, extension providers and content fill — is delegated here.
    __publicField(this, "registry");
    AtlasCombobox(this.dir, { source: getAllDirs, creatable: true });
    this.registry = new TemplateRegistry(this.template, this.name, this.dir);
    newFileBtn.addEventListener("click", () => this.open());
    this.cancel.addEventListener("click", () => this.close());
    document.getElementById("new-file-close")?.addEventListener("click", () => this.close());
    this.template.addEventListener("change", () => this.registry.updateExtras());
    this.form.addEventListener("submit", (e) => this.submit(e));
  }
  // window.Atlas.registerTemplate — delegated to the template registry.
  registerTemplate(value, provider) {
    return this.registry.registerTemplate(value, provider);
  }
  open(presetDir) {
    if (window.__viewerMode) return;
    this.error.classList.add("hidden");
    this.dir.value = presetDir || "";
    this.name.value = "";
    this.template.value = "blank";
    if (this.visibility) {
      this.visibility.value = localStorage.getItem("atlas:newdoc-visibility") === "commons" ? "commons" : "private";
    }
    this.registry.runOpenHooks();
    this.registry.updateExtras();
    this.reveal();
    setTimeout(() => (presetDir ? this.name : this.dir).focus(), 50);
  }
  showError(msg) {
    this.error.textContent = msg;
    this.error.classList.remove("hidden");
  }
  async submit(e) {
    e.preventDefault();
    this.error.classList.add("hidden");
    const dir = this.dir.value.trim().replace(/^\/+|\/+$/g, "");
    let name = this.name.value.trim();
    const provider = this.registry.activeProvider();
    let content;
    if (provider) {
      try {
        const built = await provider.generate();
        content = built.content;
        if (!name) name = (built.slug || "").trim();
      } catch (err) {
        return this.showError(err.message);
      }
    }
    if (!name) return this.showError(t("nameRequired"));
    if (/[\\\/]/.test(name)) return this.showError(t("noSlashes"));
    if (!name.endsWith(".md")) name += ".md";
    const path = dir ? dir + "/" + name : name;
    if (fileMap[path]) return this.showError(t("fileExists"));
    if (!provider) {
      const title = name.replace(/\.md$/, "").replace(/[-_]/g, " ").replace(/(?:^|\s)\S/g, (c) => c.toUpperCase());
      content = TemplateRegistry.buildContent(this.template.value, title);
    }
    const visibility = this.visibility ? this.visibility.value : "private";
    try {
      localStorage.setItem("atlas:newdoc-visibility", visibility);
    } catch (_) {
    }
    try {
      const res = await fetch("/api/file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, content, private: visibility === "private" })
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      this.close();
      location.hash = "#" + encodeURIComponent(path);
      setStatus(provider && provider.successMessage || t("docCreated"), "ok");
      await refreshTreeOrReload();
    } catch (err) {
      this.showError(t("errSp", err.message));
    }
  }
}
const newFileModal = new NewFileModal();
const dirRenameModal = new DirRenameModal();
window.Atlas = {
  version: 1,
  t,
  escapeHtml,
  setStatus,
  refresh: refreshTreeOrReload,
  currentDoc() {
    return currentFile ? { path: currentFile.path } : null;
  },
  invalidateDoc(path) {
    contentCache.delete(path);
    if (currentFile && currentFile.path === path) {
      currentFile.content = void 0;
      currentFile.mtime = 0;
    }
  },
  registerTemplate(value, provider) {
    return newFileModal.registerTemplate(value, provider);
  }
};
function openNewFileModal(presetDir) {
  newFileModal.open(presetDir);
}
function closeNewFileModal() {
  newFileModal.close();
}
function openDirRenameModal(path) {
  dirRenameModal.open(path);
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const settingsBackdrop = document.getElementById("settings-backdrop");
    if (settingsBackdrop && !settingsBackdrop.classList.contains("hidden")) {
      closeSettings();
      return;
    }
    if (newFileModal.isOpen()) {
      closeNewFileModal();
      return;
    }
    if (dirRenameModal.isOpen()) {
      dirRenameModal.close();
      return;
    }
    if (quickCaptureModal.isOpen()) {
      quickCaptureModal.close();
      return;
    }
    if (!shareBackdrop.classList.contains("hidden")) {
      closeShareModal();
      return;
    }
    if (!renameBackdrop.classList.contains("hidden")) {
      closeRenameModal();
      return;
    }
  }
  if (e.key === "n" && !window.__viewerMode && !editMode && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName ?? "")) {
    e.preventDefault();
    newFileModal.open();
  }
});

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
class AccessDialog {
  constructor() {
    // ---- static partial DOM (the dialog markup ships as one unit; the backdrop guard above proved
    // it present, so the rest are asserted) ----
    __publicField(this, "backdrop", document.getElementById("acl-backdrop"));
    __publicField(this, "pathEl", document.getElementById("acl-path"));
    __publicField(this, "statusEl", document.getElementById("acl-status"));
    __publicField(this, "grantsEl", document.getElementById("acl-grants"));
    __publicField(this, "manageEl", document.getElementById("acl-manage"));
    __publicField(this, "form", document.getElementById("acl-grant-form"));
    __publicField(this, "kindSel", document.getElementById("acl-kind"));
    __publicField(this, "valueInp", document.getElementById("acl-value"));
    __publicField(this, "levelSel", document.getElementById("acl-level"));
    __publicField(this, "errEl", document.getElementById("acl-error"));
    // ---- state ----
    __publicField(this, "cur", null);
    __publicField(this, "dir", null);
    // /api/directory, cached for autocompletion
    // The value field is a creatable combobox: pick a known user/group OR type a new one. Its source
    // flips with the kind select (users vs groups) → refresh() on change. Created once on the permanent
    // partial input and never torn down.
    __publicField(this, "aclCb", AtlasCombobox(this.valueInp, {
      source: () => this.kindSel.value === "group" ? this.dir && this.dir.groups || [] : this.dir && this.dir.users || [],
      creatable: true
    }));
    this.wire();
  }
  async loadDir() {
    if (!this.dir) {
      try {
        const r = await fetch("/api/directory");
        if (r.ok) this.dir = await r.json();
      } catch (_) {
      }
    }
    return this.dir || { users: [], groups: [] };
  }
  myPrincipal() {
    return meState && meState.authenticated && meState.email ? "user:" + meState.email : null;
  }
  principalLabel(p) {
    if (p === "*") return "🌐 " + t("aclEveryone");
    if (p.startsWith("user:")) return "👤 " + p.slice(5);
    if (p.startsWith("group:")) return "👥 " + p.slice(6);
    if (p.startsWith("anon:")) return "🔗 " + t("aclLinkPrincipal");
    return p;
  }
  levelLabel(l) {
    if (l === "edit") return t("aclLevelEdit");
    if (l === "comment") return t("aclLevelComment");
    return t("aclLevelView");
  }
  render() {
    const cur = this.cur;
    this.pathEl.textContent = cur.path;
    if (cur.owner) {
      const mine = this.myPrincipal();
      const who = mine && cur.owner === mine ? t("aclYou") : cur.owner.startsWith("user:") ? cur.owner.slice(5) : cur.owner;
      this.statusEl.innerHTML = '<span class="text-amber-300 font-medium">' + escapeHtml(t("aclPrivate")) + "</span> · " + escapeHtml(t("aclOwner")) + " " + escapeHtml(who);
    } else {
      this.statusEl.innerHTML = '<span class="text-emerald-300 font-medium">' + escapeHtml(t("aclCommons")) + "</span>";
    }
    if (cur.creator) {
      const mine = this.myPrincipal();
      const who = mine && cur.creator === mine ? t("aclYou") : cur.creator.startsWith("user:") ? cur.creator.slice(5) : cur.creator;
      this.statusEl.innerHTML += ' <span class="text-ink-500">· ' + escapeHtml(t("aclCreatedBy")) + " " + escapeHtml(who) + "</span>";
    }
    const grants = cur.grants || [];
    this.grantsEl.innerHTML = grants.length ? grants.map(
      (g) => '<li class="flex items-center justify-between gap-2 bg-navy-900 border subtle-border rounded px-2.5 py-1.5 text-xs"><span class="truncate text-ink-200">' + escapeHtml(this.principalLabel(g.principal)) + ' · <span class="text-ink-400">' + escapeHtml(this.levelLabel(g.level)) + "</span></span>" + (cur.can_manage ? '<button class="acl-revoke text-ink-500 hover:text-rose-300 px-1 flex-shrink-0" data-principal="' + escapeHtml(g.principal) + '" title="' + escapeHtml(t("aclRemove")) + '">✕</button>' : "") + "</li>"
    ).join("") : '<li class="text-[11px] text-ink-500">' + escapeHtml(t("aclNoGrants")) + "</li>";
    this.manageEl.classList.toggle("hidden", !cur.can_manage);
    this.errEl.classList.add("hidden");
  }
  async refresh() {
    const res = await fetch("/api/acl?path=" + encodeURIComponent(this.cur.path));
    if (res.ok) {
      this.cur = await res.json();
      this.render();
    }
  }
  async openAccessFor(path) {
    if (!path) return;
    try {
      const res = await fetch("/api/acl?path=" + encodeURIComponent(path));
      if (!res.ok) return;
      this.cur = await res.json();
      this.kindSel.value = "user";
      document.getElementById("acl-value-wrap").classList.remove("hidden");
      this.aclCb.clear();
      this.render();
      this.backdrop.classList.remove("hidden");
      this.loadDir().then(() => this.aclCb.refresh());
    } catch (_) {
    }
  }
  close() {
    this.backdrop.classList.add("hidden");
  }
  async post(body) {
    this.errEl.classList.add("hidden");
    const res = await fetch("/api/acl", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const p = await res.json().catch(() => null);
      this.errEl.textContent = p && p.error || "HTTP " + res.status;
      this.errEl.classList.remove("hidden");
      return false;
    }
    await this.refresh();
    return true;
  }
  wire() {
    document.getElementById("btn-access")?.addEventListener("click", () => {
      if (currentFile) this.openAccessFor(currentFile.path);
    });
    document.getElementById("acl-close").addEventListener("click", () => this.close());
    document.getElementById("acl-close-x")?.addEventListener("click", () => this.close());
    this.backdrop.addEventListener("click", (e) => {
      if (e.target === this.backdrop) this.close();
    });
    this.kindSel.addEventListener("change", () => {
      document.getElementById("acl-value-wrap").classList.toggle("hidden", this.kindSel.value === "*");
      this.aclCb.refresh();
    });
    this.form.addEventListener("submit", async (e) => {
      e.preventDefault();
      let principal;
      if (this.kindSel.value === "*") {
        principal = "*";
      } else {
        const v = this.aclCb.getValue();
        if (!v) return;
        principal = this.kindSel.value + ":" + (this.kindSel.value === "user" ? v.toLowerCase() : v);
      }
      if (await this.post({ path: this.cur.path, action: "grant", principal, level: this.levelSel.value })) {
        this.aclCb.clear();
        setStatus(t("aclSharedToast"), "ok");
      }
    });
    this.grantsEl.addEventListener("click", async (e) => {
      const btn = e.target.closest(".acl-revoke");
      if (btn && await this.post({ path: this.cur.path, action: "revoke", principal: btn.dataset.principal })) {
        setStatus(t("aclRevokedToast"), "ok");
      }
    });
    document.getElementById("acl-make-private").addEventListener("click", async () => {
      const mine = this.myPrincipal();
      if (mine && await this.post({ path: this.cur.path, action: "set_owner", principal: mine })) {
        setStatus(t("aclNowPrivateToast"), "ok");
      }
    });
    document.getElementById("acl-make-commons").addEventListener("click", async () => {
      const ok = await confirmDialog({
        title: t("aclMakeCommons"),
        message: t("aclMakeCommonsConfirm"),
        confirmLabel: t("aclMakeCommons"),
        destructive: true
      });
      if (ok && await this.post({ path: this.cur.path, action: "make_commons" })) {
        setStatus(t("aclNowCommonsToast"), "ok");
      }
    });
  }
}
if (document.getElementById("acl-backdrop")) {
  const dialog = new AccessDialog();
  window.openAccessFor = (path) => dialog.openAccessFor(path);
}

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
class ActivityCard {
  constructor() {
    // ---- state ----
    __publicField(this, "items", null);
    __publicField(this, "aiOnly", false);
    // 13d: filter the feed to AI-authored events only
    __publicField(this, "digest", null);
    // 13b: factual digest of the last 7 days
    __publicField(this, "expanded", false);
    // ---- views (each renders from the shared helper cluster + live state via the render context) ----
    __publicField(this, "journalView");
    __publicField(this, "orreryView");
    __publicField(this, "healthView");
    const self = this;
    const ctx = {
      shownItems: () => self.shownItems(),
      get expanded() {
        return self.expanded;
      },
      get aiOnly() {
        return self.aiOnly;
      },
      TY: (type) => self.TY(type),
      iconSvg: (type, size) => self.iconSvg(type, size),
      verb: (type) => self.verb(type),
      verbPhrase: (type) => self.verbPhrase(type),
      avatar: (e, size) => self.avatar(e, size),
      aiBadge: (family) => self.aiBadge(family),
      rel: (min) => self.rel(min),
      dayKey: (min) => self.dayKey(min),
      docTitle: (p) => self.docTitle(p),
      skelRows: (n) => self.skelRows(n),
      openDocHistory: (path) => self.openDocHistory(path)
    };
    this.journalView = new ActivityJournal(ctx);
    this.orreryView = new ActivityOrrery(ctx);
    this.healthView = new ActivityHealth(ctx);
  }
  // ---- small render helpers (the shared cluster; the views reach these through the render context) ----
  TY(type) {
    return ActivityIcons.TYPES[type] || ActivityIcons.TYPES.edit;
  }
  verb(type) {
    return (ActivityIcons.VERB[LANG] || ActivityIcons.VERB.fr)[type] || type;
  }
  // In a sentence ("Ludovic a créé X"), French wants the auxiliary; English doesn't. The bare
  // verb() stays for the orrery legend, where chips read as labels, not sentences.
  verbPhrase(type) {
    return (LANG === "en" ? "" : "a ") + this.verb(type);
  }
  docTitle(p) {
    return ((p || "").split("/").pop() || p).replace(/\.(md|html)$/i, "");
  }
  iconSvg(type, size) {
    const ty = this.TY(type);
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${ty.color}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="${ty.d}"/></svg>`;
  }
  aiBadge(family) {
    return `<span class="activity-badge"><svg width="9" height="9" viewBox="0 0 24 24" fill="#e8941c"><path d="${ActivityIcons.AI[family] || ActivityIcons.AI.generic}"/></svg></span>`;
  }
  // Atlas Bot (the app's own automated writes) shows the application logo itself.
  botAvatar(size) {
    return `<img src="/icon.svg" width="${size}" height="${size}" alt="Atlas" style="display:block">`;
  }
  avatar(e, size) {
    if (e.bot && !IS_OFFLINE_BUILD) return this.botAvatar(size);
    try {
      return constellationSvg(avatarSeed(e.first, e.last, e.email), size);
    } catch (_) {
      return `<span class="inline-block rounded-lg" style="width:${size}px;height:${size}px;background:#23222a"></span>`;
    }
  }
  rel(min) {
    const en = LANG === "en";
    if (min < 1) return en ? "just now" : "à l'instant";
    if (min < 60) return Math.round(min) + " min";
    const hrs = Math.round(min / 60);
    if (hrs < 24) return hrs + " h";
    const d = Math.round(min / 1440);
    if (d === 1) return en ? "yesterday" : "hier";
    return en ? d + "d ago" : "il y a " + d + " j";
  }
  dayKey(min) {
    const d = new Date(Date.now() - min * 6e4);
    const now = /* @__PURE__ */ new Date();
    const a = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const b = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diff = Math.round((a.getTime() - b.getTime()) / 864e5);
    if (diff <= 0) return LANG === "en" ? "Today" : "Aujourd'hui";
    if (diff === 1) return LANG === "en" ? "Yesterday" : "Hier";
    return d.toLocaleDateString(LANG === "en" ? "en-US" : "fr-FR", { weekday: "long", day: "numeric", month: "long" });
  }
  // The feed honoring the AI-only filter — the source both the Journal and the Orrery index into.
  shownItems() {
    return this.aiOnly ? this.items.filter((i) => i.ai) : this.items;
  }
  // Show the doc's history overlay in place ("voir les modifications"), no navigation, the activity
  // feed stays put. No-ops if the doc no longer exists (deleted/moved).
  openDocHistory(path) {
    if (!path || typeof fileMap === "undefined" || typeof openHistory !== "function") return;
    const f = fileMap[path];
    if (f) openHistory(f);
  }
  // ── Digest (the weekly summary above the Journal) ─────────────────────────
  digestHtml() {
    const d = this.digest;
    if (!d) return "";
    const ic = (path, color) => `<svg width="13" height="13" fill="none" stroke="${color}" stroke-width="1.9" viewBox="0 0 24 24" style="flex-shrink:0"><path stroke-linecap="round" stroke-linejoin="round" d="${path}"/></svg>`;
    const pill = (icon, n, label) => `<span class="act-legend-chip">${icon}<span class="text-ink-100 font-semibold">${n}</span> ${label}</span>`;
    const parts = [];
    if (d.docs) parts.push(pill(ic("M9 12h6m-6 4h6m2 4H7a2 2 0 01-2-2V5a2 2 0 012-2h7l5 5v11a2 2 0 01-2 2z", "#5e6066"), d.docs, t("digestDocs", d.docs)));
    if (d.created) parts.push(pill(ic("M12 4v16m8-8H4", this.TY("create").color), d.created, t("digestCreated", d.created)));
    if (d.checked) parts.push(pill(ic("M5 13l4 4L19 7", this.TY("check").color), d.checked, t("digestChecked", d.checked)));
    if (d.contributors) parts.push(pill(ic("M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-1.13a4 4 0 10-4-4 4 4 0 004 4z", "#5e6066"), d.contributors, t("digestContributors", d.contributors)));
    if (d.ai) parts.push(pill(ic("M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9l4.2-1.4z", "#e8941c"), d.ai, t("digestViaAi", d.ai)));
    if (!parts.length) return "";
    const hr = '<hr style="border:none;border-top:1px solid #2a2a32;margin:0">';
    return `<div style="position:relative;margin-bottom:12px">
        ${hr}
        <div style="display:flex;flex-wrap:wrap;justify-content:center;gap:6px;margin:10px 0 9px">${parts.join("")}</div>
        ${hr}
        <span class="act-digest-when text-ink-500" style="position:absolute;right:0;bottom:5px;font-size:10px;text-transform:uppercase;letter-spacing:.06em;pointer-events:none">${t("digestWeek")}</span>
      </div>`;
  }
  // ── Skeletons (first-load placeholder; also lent to the Health view via the context) ──────────────
  skelRow() {
    return '<div class="flex items-center gap-3 py-2"><div class="act-skel" style="width:30px;height:30px;border-radius:8px"></div><div class="flex-1"><div class="act-skel" style="width:42%;height:10px"></div><div class="act-skel" style="width:26%;height:8px;margin-top:6px"></div></div><div class="act-skel" style="width:38px;height:8px"></div></div>';
  }
  skelRows(n) {
    let s = "";
    for (let i = 0; i < n; i++) s += this.skelRow();
    return s;
  }
  skeletonHtml() {
    return '<div class="border subtle-border rounded-lg p-4 bg-black/15"><div class="flex items-center justify-between mb-4"><div class="act-skel" style="width:90px;height:18px"></div><div class="act-skel" style="width:150px;height:26px;border-radius:8px"></div></div>' + this.skelRows(4) + "</div>";
  }
  // ── Card shell + view switch ──────────────────────────────────────────
  segClass(active) {
    return "activity-seg px-3 py-1 text-xs font-medium " + (active ? "is-active bg-accent text-white" : "text-ink-300");
  }
  // A checkbox-style filter (small box + label), not a button, reads as "filter the feed".
  aiFilterHtml() {
    return `<button type="button" data-ai-filter class="flex items-center gap-1.5 text-xs transition ${this.aiOnly ? "text-accent" : "text-ink-400 hover:text-ink-200"}" title="${t("actAiOnly")}"><span style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:4px;font-size:10px;color:#fff;border:1.5px solid ${this.aiOnly ? "#1d9bd1" : "#5e6066"};background:${this.aiOnly ? "#1d9bd1" : "transparent"}">${this.aiOnly ? "✓" : ""}</span>${t("actAiOnly")}</button>`;
  }
  cardHtml() {
    return `<div id="home-activity-card" class="border subtle-border rounded-lg p-4 bg-black/15">
        <div class="act-card-head flex items-center justify-between gap-3 mb-3">
          <h2 class="!mb-0 !mt-0">${t("actTitle")}</h2>
          <div class="act-card-controls flex items-center gap-2 shrink-0">
            ${this.aiFilterHtml()}
            <div class="act-seg-group inline-flex rounded-lg border subtle-border overflow-hidden">
              <button type="button" data-view="journal" class="${this.segClass(true)}">${t("actJournal")}</button>
              <button type="button" data-view="orrery" class="${this.segClass(false)}">${t("actConstellation")}</button>
              <button type="button" data-view="health" class="${this.segClass(false)}">${t("actHealth")}</button>
              ${IS_OFFLINE_BUILD ? "" : `<button type="button" data-view="inbox" class="${this.segClass(false)}">${t("actInbox")} <span id="inbox-badge" class="act-ibadge hidden"></span></button>`}
            </div>
          </div>
        </div>
        <div id="activity-digest">${this.digestHtml()}</div>
        <div id="activity-journal">${this.journalView.html()}</div>
        <div id="activity-orrery" class="hidden"></div>
        <div id="activity-health" class="hidden"></div>
        <div id="activity-inbox" class="hidden"></div>
      </div>`;
  }
  setView(card, v, persist) {
    const journalEl = card.querySelector("#activity-journal");
    const orreryEl = card.querySelector("#activity-orrery");
    const healthEl = card.querySelector("#activity-health");
    const inboxEl = card.querySelector("#activity-inbox");
    const digestEl = card.querySelector("#activity-digest");
    if (digestEl) digestEl.classList.toggle("hidden", v !== "journal");
    if (v === "orrery") {
      if (!orreryEl.dataset.rendered) {
        orreryEl.innerHTML = this.orreryView.html();
        orreryEl.dataset.rendered = "1";
        this.orreryView.wireHover(orreryEl);
        this.orreryView.wireSun(orreryEl);
      }
      orreryEl.querySelectorAll(".act-spin,.act-sun,.act-egg").forEach((el) => el.classList.remove("spinning", "pop", "show"));
    } else if (v === "health" && !healthEl.dataset.rendered) {
      healthEl.dataset.rendered = "1";
      healthEl.innerHTML = this.healthView.html();
      this.healthView.load(healthEl);
    } else if (v === "inbox" && inboxEl && !inboxEl.dataset.rendered && window.AtlasInbox) {
      inboxEl.dataset.rendered = "1";
      window.AtlasInbox.mount(inboxEl);
    }
    journalEl.classList.toggle("hidden", v !== "journal");
    orreryEl.classList.toggle("hidden", v !== "orrery");
    healthEl.classList.toggle("hidden", v !== "health");
    if (inboxEl) inboxEl.classList.toggle("hidden", v !== "inbox");
    if (window.AtlasInbox) {
      if (v === "inbox") window.AtlasInbox.show();
      else window.AtlasInbox.hide();
    }
    card.querySelectorAll("[data-view]").forEach((b) => {
      b.className = this.segClass(b.dataset.view === v);
    });
    if (persist) {
      try {
        localStorage.setItem("atlas:activityView", v);
      } catch (_) {
      }
    }
  }
  wire(card) {
    let saved = "journal";
    try {
      saved = localStorage.getItem("atlas:activityView") || "journal";
    } catch (_) {
    }
    const q = new URLSearchParams(location.search).get("view");
    if (q === "journal" || q === "orrery" || q === "health" || q === "inbox") saved = q;
    if (saved === "inbox" && IS_OFFLINE_BUILD) saved = "journal";
    this.setView(card, saved, false);
    card.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => this.setView(card, b.dataset.view, true)));
    card.addEventListener("click", (ev) => {
      const fbtn = ev.target.closest("[data-ai-filter]");
      if (fbtn) {
        this.aiOnly = !this.aiOnly;
        this.expanded = false;
        fbtn.outerHTML = this.aiFilterHtml();
        card.querySelector("#activity-journal").innerHTML = this.journalView.html();
        const orreryEl = card.querySelector("#activity-orrery");
        if (orreryEl.dataset.rendered) {
          orreryEl.innerHTML = this.orreryView.html();
          this.orreryView.wireHover(orreryEl);
          this.orreryView.wireSun(orreryEl);
        }
        return;
      }
      if (ev.target.closest("[data-view]")) return;
      if (ev.target.closest(".act-seeall")) {
        this.expanded = !this.expanded;
        card.querySelector("#activity-journal").innerHTML = this.journalView.html();
        return;
      }
      if (ev.target.closest(".act-hsee")) {
        this.healthView.toggleStale(card.querySelector("#activity-health"));
        return;
      }
      if (ev.target.closest(".act-csee")) {
        this.healthView.toggleCand(card.querySelector("#activity-health"));
        return;
      }
      const ht = ev.target.closest("[data-htab]");
      if (ht) {
        this.healthView.setTab(ht.dataset.htab, card.querySelector("#activity-health"));
        return;
      }
      const cd = ev.target.closest(".act-cdismiss");
      if (cd) {
        this.healthView.dismiss(cd, card.querySelector("#activity-health"));
        return;
      }
      const rowEl = ev.target.closest("[data-path]");
      if (rowEl && rowEl.dataset.path) this.openDocHistory(rowEl.dataset.path);
    });
  }
  // ── Data ──────────────────────────────────────────────────────────────
  async load() {
    if (IS_OFFLINE_BUILD) {
      return EMBED_ACTIVITY ? EMBED_ACTIVITY.events.map(ActivityModel.toItem) : null;
    }
    if (!location.protocol.startsWith("http")) return null;
    try {
      const r = await fetch("/api/activity?since=60&limit=200");
      if (!r.ok) return null;
      const data = await r.json();
      return Array.isArray(data.events) ? data.events.map(ActivityModel.toItem) : null;
    } catch (_) {
      return null;
    }
  }
  // ── Public API (mountActivity / refreshActivityData) ──────────────────
  // Fill the mount left by showWelcome(). Robust to load order (showWelcome may run at boot before
  // this file defines the renderer, so we also mount on our own load).
  async mount() {
    const m = document.getElementById("home-activity-mount");
    if (!m) return;
    this.expanded = false;
    if (this.items && this.items.length) {
      m.innerHTML = this.cardHtml();
      this.wire(m.querySelector("#home-activity-card"));
    } else if (this.items === null) m.innerHTML = this.skeletonHtml();
    const loaded = await this.load();
    this.items = loaded ? ActivityModel.aggregate(loaded) : loaded;
    this.digest = loaded ? ActivityModel.computeDigest(loaded) : null;
    if (!this.items || !this.items.length) {
      m.innerHTML = "";
      return;
    }
    m.innerHTML = this.cardHtml();
    this.wire(m.querySelector("#home-activity-card"));
    if (!IS_OFFLINE_BUILD && window.AtlasInbox) window.AtlasInbox.refreshBadge();
  }
  // Live-reload refresh that does NOT re-mount the card: softReload() calls this so only the active
  // tab updates in place. Dormant tabs and the self-managing Inbox are left untouched.
  async refreshData() {
    const card = document.getElementById("home-activity-card");
    if (!card) return;
    const inbox = card.querySelector("#activity-inbox");
    if (inbox && !inbox.classList.contains("hidden")) return;
    if (!IS_OFFLINE_BUILD && window.AtlasInbox) window.AtlasInbox.refreshBadge();
    const loaded = await this.load();
    if (!loaded) return;
    this.items = ActivityModel.aggregate(loaded);
    this.digest = ActivityModel.computeDigest(loaded);
    const journal = card.querySelector("#activity-journal");
    if (journal && !journal.classList.contains("hidden")) {
      journal.innerHTML = this.journalView.html();
      const dg = card.querySelector("#activity-digest");
      if (dg && !dg.classList.contains("hidden")) dg.innerHTML = this.digestHtml();
      return;
    }
    const orrery = card.querySelector("#activity-orrery");
    if (orrery && !orrery.classList.contains("hidden") && orrery.dataset.rendered) {
      orrery.innerHTML = this.orreryView.html();
      this.orreryView.wireHover(orrery);
      this.orreryView.wireSun(orrery);
    }
  }
}

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
class ActivityIcons {
}
// CDC event types -> display label + tint + Heroicons-v2 outline path (clean line
// icons, matching the rest of the app). Keyed by the type /api/activity returns.
__publicField(ActivityIcons, "TYPES", {
  create: { label: "created", color: "#e8941c", d: "M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z" },
  edit: { label: "edited", color: "#1d9bd1", d: "m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.931-8.931Zm0 0L19.5 7.125" },
  move: { label: "moved", color: "#1d9bd1", d: "M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" },
  delete: { label: "deleted", color: "#868a90", d: "m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" },
  check: { label: "checked", color: "#5fd0a6", d: "M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" },
  revert: { label: "reverted", color: "#e8941c", d: "M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3" },
  // Mental-node subscriptions: the share/nodes glyph, tinted green (added) / grey (removed).
  node_add: { label: "added node", color: "#5fd0a6", d: "M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.933-2.185 2.25 2.25 0 0 0-3.933 2.185Z" },
  node_remove: { label: "removed node", color: "#868a90", d: "M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.933-2.185 2.25 2.25 0 0 0-3.933 2.185Z" }
});
// Verb labels by UI language (LANG from 01-i18n.ts). A local map (vs t()) keeps them next to
// TYPES and avoids colliding with existing STRINGS keys (create/edit…).
__publicField(ActivityIcons, "VERB", {
  fr: { create: "créé", edit: "édité", move: "déplacé", delete: "supprimé", check: "coché", revert: "restauré", node_add: "ajouté le nœud", node_remove: "retiré le nœud" },
  en: { create: "created", edit: "edited", move: "moved", delete: "deleted", check: "checked", revert: "reverted", node_add: "added the node", node_remove: "removed the node" }
});
__publicField(ActivityIcons, "AI", {
  claude: "M12 2.6l1.6 5.9 5.9 1.6-5.9 1.6L12 21.4l-1.6-7.7L4.5 12l5.9-1.6L12 2.6Z",
  chatgpt: "M12 3.2 18.5 7v8L12 18.8 5.5 15V7L12 3.2Z",
  gemini: "M12 3c.6 4.5 2.4 6.3 6.9 6.9-4.5.6-6.3 2.4-6.9 6.9-.6-4.5-2.4-6.3-6.9-6.9C9.6 9.3 11.4 7.5 12 3Z",
  generic: "M12 4l2 6 6 2-6 2-2 6-2-6-6-2 6-2 2-6Z"
});
__publicField(ActivityIcons, "ORRERY_CAP", 18);
// aggregated entries (distinct doc-activities), not raw commits
__publicField(ActivityIcons, "JOURNAL_PREVIEW", 8);
// Easter egg: flick the orrery (one full orbit) + bounce the sun on click; every 5th click, a
// little supernova line floats up. Pure fun; reduced-motion gets just the line.
__publicField(ActivityIcons, "EGG_LINES", [
  "✨ tu as trouvé le cœur du mind",
  "🪐 Atlas porte le ciel… et ton bordel",
  "☄️ supernova !",
  "🌟 fais un vœu",
  "🔭 continue d’explorer"
]);

class ActivityModel {
  // ---- pure projections over the wire events ----
  static toItem(e) {
    const author = (e.author || e.email || "").trim();
    const parts = author.split(/\s+/);
    const ts = Date.parse(e.date);
    return {
      who: author,
      first: parts[0] || e.email || "",
      last: parts.slice(1).join(" "),
      email: e.email || "",
      ai: e.ai || null,
      bot: /atlas bot/i.test(author),
      type: e.type,
      title: e.title || e.paths && e.paths[0] || "",
      agoMin: isNaN(ts) ? 0 : Math.max(0, Math.round((Date.now() - ts) / 6e4)),
      sha: e.short_sha || (e.sha || "").slice(0, 7),
      path: e.paths && e.paths[0] || "",
      subject: e.subject || ""
    };
  }
  // Collapse a run of consecutive events on the SAME doc by the same actor + type into one entry
  // with a count: a burst of edits to one doc shouldn't read as N identical lines (CDC §9). Events
  // arrive newest-first, so the kept time is the most recent.
  static aggregate(items) {
    const out = [];
    for (const e of items) {
      const last = out[out.length - 1];
      if (last && last.path === e.path && last.who === e.who && last.type === e.type && last.ai === e.ai) {
        last.count = (last.count || 0) + 1;
      } else {
        out.push(Object.assign({ count: 1 }, e));
      }
    }
    return out;
  }
  // 13b: factual digest over the last 7 days (deterministic, derived from the events; the narrative
  // side is the AI via the existing `activity` MCP tool, on demand).
  static computeDigest(items) {
    const WIN = 7 * 24 * 60;
    const docs = /* @__PURE__ */ new Set();
    const authors = /* @__PURE__ */ new Set();
    let created = 0;
    let checked = 0;
    let ai = 0;
    for (const i of items) {
      if (i.agoMin > WIN) continue;
      if (i.path) docs.add(i.path);
      if (i.who) authors.add(i.who);
      if (i.type === "create") created += 1;
      if (i.type === "check" && /^checked/i.test(i.subject || "")) checked += 1;
      if (i.ai) ai += 1;
    }
    return { docs: docs.size, created, checked, contributors: authors.size, ai };
  }
}

class ActivityJournal {
  constructor(ctx) {
    this.ctx = ctx;
  }
  row(e) {
    const ty = this.ctx.TY(e.type);
    const via = e.ai ? `<span class="text-ink-500 text-xs">· via ${escapeHtml(e.ai)}</span>` : "";
    return `<div class="act-row flex items-center gap-3" data-path="${escapeHtml(e.path)}" data-tip="${escapeHtml(t("actSeeChanges"))}">
        <div class="relative shrink-0" style="line-height:0">${this.ctx.avatar(e, 30)}${e.ai ? this.ctx.aiBadge(e.ai) : ""}</div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5"><span class="text-sm font-semibold text-ink-100">${escapeHtml(e.who)}</span>${via}</div>
          <div class="flex items-center gap-1.5 text-sm mt-0.5">
            <span class="shrink-0" style="line-height:0">${this.ctx.iconSvg(e.type, 14)}</span>
            <span class="shrink-0" style="color:${ty.color};font-weight:600;white-space:nowrap">${this.ctx.verbPhrase(e.type)}</span>
            <span class="text-ink-300 truncate min-w-0">${escapeHtml(e.title)}</span>
            ${e.count && e.count > 1 ? `<span class="text-ink-500 text-xs shrink-0">×${e.count}</span>` : ""}
          </div>
        </div>
        <div class="shrink-0 text-xs text-ink-500 font-mono" title="${escapeHtml(e.sha)}">${this.ctx.rel(e.agoMin)}</div>
      </div>`;
  }
  html() {
    const all = this.ctx.shownItems();
    if (!all.length) return `<div class="text-ink-500 text-sm py-4 text-center">${this.ctx.aiOnly ? t("actEmptyAi") : t("actEmpty")}</div>`;
    let out = "";
    let day = "";
    const shown = this.ctx.expanded ? all : all.slice(0, ActivityIcons.JOURNAL_PREVIEW);
    shown.forEach((e) => {
      const k = this.ctx.dayKey(e.agoMin);
      if (k !== day) {
        day = k;
        out += `<div class="text-[11px] uppercase tracking-wider text-ink-500 font-semibold mt-3 mb-1 first:mt-0">${escapeHtml(day)}</div>`;
      }
      out += this.row(e);
    });
    if (all.length > ActivityIcons.JOURNAL_PREVIEW) {
      out += `<div class="text-right mt-3"><a class="act-seeall text-sm text-accent hover:underline cursor-pointer">${this.ctx.expanded ? t("actCollapse") : t("actSeeAll")}</a></div>`;
    }
    return out;
  }
}

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
class ActivityOrrery {
  // the list the constellation nodes index into (respects the filter)
  constructor(ctx) {
    this.ctx = ctx;
    __publicField(this, "orreryItems", []);
  }
  orreryNodes() {
    const cx = 360;
    const cy = 265;
    const radii = [104, 172, 236];
    const items = (this.orreryItems = this.ctx.shownItems()).slice(0, ActivityIcons.ORRERY_CAP).map((e, i) => ({ e, i }));
    const perRing = Math.max(1, Math.ceil(items.length / 3));
    const rings = [[], [], []];
    items.forEach((it, idx) => rings[Math.min(2, Math.floor(idx / perRing))].push(it));
    let nodes = "";
    rings.forEach((arr, ri) => {
      const r = radii[ri];
      const off = ri * 0.7 + 0.15;
      arr.forEach((it, k) => {
        const ang = (k + 0.5) / arr.length * Math.PI * 2 - Math.PI / 2 + off;
        const x = cx + r * Math.cos(ang);
        const y = cy + r * Math.sin(ang);
        const c = this.ctx.TY(it.e.type).color;
        nodes += `<g class="act-node" data-i="${it.i}" tabindex="0" transform="translate(${x.toFixed(1)},${y.toFixed(1)})">
            <g class="act-node-inner">
              <circle r="19" fill="#14131a" stroke="${c}" stroke-opacity=".6"/>
              <svg x="-11" y="-11" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${this.ctx.TY(it.e.type).d}"/></svg>
              ${it.e.ai ? '<circle cx="13" cy="-13" r="5" fill="#14131a" stroke="#e8941c" stroke-opacity=".8"/><circle cx="13" cy="-13" r="1.8" fill="#e8941c"/>' : ""}
            </g>
          </g>`;
      });
    });
    const ringSvg = radii.map((r) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#6a7180" stroke-opacity=".4" stroke-width="1" stroke-dasharray="3 7"/>`).join("");
    return { ringSvg, nodes, cx, cy };
  }
  html() {
    const { ringSvg, nodes, cx, cy } = this.orreryNodes();
    const legend = Object.keys(ActivityIcons.TYPES).map((k) => `<span class="act-legend-chip">${this.ctx.iconSvg(k, 12)}<span>${this.ctx.verb(k)}</span></span>`).join("");
    return `<div class="act-orrery flex items-start gap-4">
        <div class="act-sky relative flex-1 min-w-0">
          <svg viewBox="0 0 720 540" style="width:100%;height:auto;overflow:visible">
            <defs>
              <radialGradient id="actcore" cx="42%" cy="38%"><stop offset="0" stop-color="#ffd9a0"/><stop offset="55%" stop-color="#e8941c"/><stop offset="100%" stop-color="#8a4f0e"/></radialGradient>
              <radialGradient id="actglow" cx="50%" cy="50%"><stop offset="0" stop-color="rgba(232,148,28,.15)"/><stop offset="70%" stop-color="rgba(232,148,28,0)"/></radialGradient>
              <radialGradient id="actsunlimb" cx="42%" cy="38%"><stop offset="58%" stop-color="rgba(0,0,0,0)"/><stop offset="100%" stop-color="rgba(70,35,5,.6)"/></radialGradient>
              <clipPath id="actsunclip"><circle cx="${cx}" cy="${cy}" r="27"/></clipPath>
              <filter id="actsunblur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2.3"/></filter>
            </defs>
            <circle class="act-glow" cx="${cx}" cy="${cy}" r="120" fill="url(#actglow)"/>
            <g class="act-spin">${ringSvg}${nodes}</g>
            <g class="act-sun"><g class="act-sun-pulse">
              <circle cx="${cx}" cy="${cy}" r="27" fill="url(#actcore)"/>
              <g clip-path="url(#actsunclip)" filter="url(#actsunblur)">
                <circle cx="${cx - 7}" cy="${cy - 8}" r="6" fill="#fff1d6" opacity=".5"/>
                <circle cx="${cx + 8}" cy="${cy - 3}" r="5.4" fill="#b86f12" opacity=".5"/>
                <circle cx="${cx - 3}" cy="${cy + 8}" r="6.7" fill="#a55f0f" opacity=".45"/>
                <circle cx="${cx - 11}" cy="${cy + 3}" r="4" fill="#ffe2b0" opacity=".4"/>
                <circle cx="${cx + 9}" cy="${cy + 9}" r="4.7" fill="#8a4f0e" opacity=".5"/>
                <circle cx="${cx + 2}" cy="${cy - 11}" r="3.4" fill="#ffe9c4" opacity=".4"/>
              </g>
              <circle cx="${cx}" cy="${cy}" r="27" fill="url(#actsunlimb)"/>
              <circle cx="${cx - 7}" cy="${cy - 9}" r="4" fill="#fff7e6" opacity=".55" filter="url(#actsunblur)"/>
            </g></g>
          </svg>
          <div class="act-pop dialog-card hidden"></div>
          <div class="act-egg"></div>
        </div>
        <div class="act-legend">${legend}</div>
      </div>`;
  }
  popHtml(e) {
    const ty = this.ctx.TY(e.type);
    const via = e.ai ? `<span class="text-ink-500 text-xs">· via ${escapeHtml(e.ai)}</span>` : "";
    return `<div class="flex items-center gap-2 mb-1.5"><span style="line-height:0">${this.ctx.avatar(e, 26)}</span><span class="text-sm font-semibold text-ink-100">${escapeHtml(e.who)}</span>${via}</div>
       <div class="flex items-baseline gap-1.5 text-sm"><span style="color:${ty.color};font-weight:600;white-space:nowrap">${this.ctx.verbPhrase(e.type)}</span><span class="text-ink-300" style="min-width:0;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${escapeHtml(e.title)}</span>${e.count && e.count > 1 ? `<span class="text-ink-500 text-xs" style="white-space:nowrap">×${e.count}</span>` : ""}</div>
       <div class="text-xs text-ink-500 font-mono mt-1.5">${this.ctx.rel(e.agoMin)} · ${escapeHtml(e.sha)}</div>`;
  }
  wireHover(container) {
    const wrap = container.querySelector(".act-sky");
    const pop = container.querySelector(".act-pop");
    if (!wrap || !pop) return;
    const show = (node) => {
      const e = this.orreryItems[Number(node.dataset.i)];
      if (!e) return;
      pop.innerHTML = this.popHtml(e);
      pop.classList.remove("hidden");
      if (window.matchMedia("(max-width:767px)").matches) {
        pop.style.left = pop.style.top = pop.style.transform = "";
        return;
      }
      const nb = node.getBoundingClientRect();
      const wb = wrap.getBoundingClientRect();
      let left = nb.left - wb.left + nb.width / 2;
      const half = pop.offsetWidth / 2;
      left = Math.max(half + 4, Math.min(wb.width - half - 4, left));
      pop.style.left = left + "px";
      if (nb.top - wb.top > pop.offsetHeight + 16) {
        pop.style.top = nb.top - wb.top - 10 + "px";
        pop.style.transform = "translate(-50%, -100%)";
      } else {
        pop.style.top = nb.bottom - wb.top + 10 + "px";
        pop.style.transform = "translate(-50%, 0)";
      }
    };
    const hide = () => pop.classList.add("hidden");
    const noHover = window.matchMedia("(hover: none)").matches;
    let activeNode = null;
    wrap.querySelectorAll(".act-node").forEach((n) => {
      n.addEventListener("mouseenter", () => show(n));
      n.addEventListener("mouseleave", hide);
      n.addEventListener("focus", () => show(n));
      n.addEventListener("blur", hide);
      n.addEventListener("click", () => {
        const e = this.orreryItems[Number(n.dataset.i)];
        if (!noHover) {
          if (e) this.ctx.openDocHistory(e.path);
          return;
        }
        if (activeNode === n) {
          if (e) this.ctx.openDocHistory(e.path);
        } else {
          activeNode = n;
          show(n);
        }
      });
    });
    wrap.addEventListener("click", (ev) => {
      if (!ev.target.closest(".act-node")) {
        hide();
        activeNode = null;
      }
    });
  }
  wireSun(container) {
    const sun = container.querySelector(".act-sun");
    const spin = container.querySelector(".act-spin");
    const egg = container.querySelector(".act-egg");
    if (!sun) return;
    if (spin) spin.addEventListener("animationend", () => spin.classList.remove("spinning"));
    sun.addEventListener("animationend", () => sun.classList.remove("pop"));
    if (egg) egg.addEventListener("animationend", () => egg.classList.remove("show"));
    let n = 0;
    sun.addEventListener("click", () => {
      n += 1;
      if (spin) {
        spin.classList.remove("spinning");
        void spin.getBBox();
        spin.classList.add("spinning");
      }
      sun.classList.remove("pop");
      void sun.getBBox();
      sun.classList.add("pop");
      if (n % 5 === 0 && egg) {
        egg.textContent = ActivityIcons.EGG_LINES[(n / 5 - 1) % ActivityIcons.EGG_LINES.length];
        egg.classList.remove("show");
        void egg.offsetWidth;
        egg.classList.add("show");
      }
    });
  }
}

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
class ActivityHealth {
  constructor(ctx) {
    this.ctx = ctx;
    __publicField(this, "health", null);
    __publicField(this, "healthExpanded", false);
    __publicField(this, "candExpanded", false);
    // 13c: persisted Santé sub-view.
    __publicField(this, "healthTab", (() => {
      try {
        return localStorage.getItem("atlas:healthTab") || "stale";
      } catch (_) {
        return "stale";
      }
    })());
  }
  // 13c: Santé, obsolescence (déterministe serveur) + candidats de contradiction (pré-filtre
  // serveur ; l'IA juge via MCP). Les clics sur un doc rouvrent son historique.
  async load(container) {
    let stale = [];
    let cands = [];
    if (IS_OFFLINE_BUILD) {
      stale = EMBED_ACTIVITY && EMBED_ACTIVITY.stale || [];
      cands = EMBED_ACTIVITY && EMBED_ACTIVITY.contradictions || [];
    } else {
      try {
        const [rs, rc] = await Promise.all([
          fetch("/api/stale?months=6&limit=40"),
          fetch("/api/contradictions?limit=50")
        ]);
        if (rs.ok) stale = (await rs.json()).stale || [];
        if (rc.ok) cands = (await rc.json()).candidates || [];
      } catch (_) {
      }
    }
    this.health = { stale, cands };
    container.innerHTML = this.html();
  }
  html() {
    const tab = (active, v, label) => `<button type="button" data-htab="${v}" class="px-3 py-1.5 text-xs font-medium transition ${active ? "text-accent" : "text-ink-400 hover:text-ink-200"}" style="border-bottom:2px solid ${active ? "#1d9bd1" : "transparent"};margin-bottom:-1px">${label}</button>`;
    const toggle = `<div class="flex mb-3" style="border-bottom:1px solid #2a2a32">` + tab(this.healthTab === "stale", "stale", t("healthTabStale")) + tab(this.healthTab === "cont", "cont", t("healthTabCont")) + `</div>`;
    const body = !this.health ? this.ctx.skelRows(3) : this.healthTab === "stale" ? this.staleHtml() : this.contHtml();
    return toggle + body;
  }
  staleHtml() {
    const stale = this.health.stale;
    if (!stale.length) return `<div class="text-ink-500 text-sm py-1">${t("healthNoStale")}</div>`;
    const shown = this.healthExpanded ? stale : stale.slice(0, 8);
    let out = shown.map((s) => `<div class="act-row" data-path="${escapeHtml(s.path)}" data-tip="${escapeHtml(t("healthOpenHist"))}"><div class="flex items-center justify-between gap-3"><div class="min-w-0"><div class="text-sm text-ink-200 truncate">${escapeHtml(this.ctx.docTitle(s.path))}</div><div class="text-xs text-ink-500 truncate">${escapeHtml(s.path)}</div></div><div class="shrink-0 text-xs text-ink-500">${t("healthMonthsAgo", Math.round(s.months_ago))}</div></div></div>`).join("");
    if (stale.length > 8) {
      out += `<div class="text-right mt-1"><a class="act-hsee text-sm text-accent hover:underline cursor-pointer">${this.healthExpanded ? t("actCollapse") : t("actSeeAllN", stale.length)}</a></div>`;
    }
    return out;
  }
  contHtml() {
    const cands = this.health.cands;
    if (!cands.length) return `<div class="text-ink-500 text-sm py-1">${t("healthNoCand")}</div>`;
    const shown = this.candExpanded ? cands : cands.slice(0, 8);
    let out = `<div class="text-xs text-ink-500 mb-2">${t("healthAskAi")}</div>`;
    out += shown.map((c) => {
      const meta = c.kind === "cluster" ? escapeHtml(c.evidence && c.evidence.length && c.evidence[0].text || c.subject || "") : t("healthValueConflict", escapeHtml(c.subject || ""), escapeHtml(c.a_value || ""), escapeHtml(c.b_value || ""));
      const confPill = c.confidence === "high" ? `<span class="shrink-0 text-xs px-1.5 py-0.5 rounded" style="background:#1d3a5b;color:#9ecbff" data-tip="${escapeHtml(t("healthConfHighHint"))}">${t("healthConfHigh")}</span>` : `<span class="shrink-0 text-xs px-1.5 py-0.5 rounded" style="background:#2a2a32;color:#9a9aa5" data-tip="${escapeHtml(t("healthReviewHint"))}">${t("healthReview")}</span>`;
      return `<div class="py-1.5"><div class="flex items-center gap-2 text-sm"><div class="flex items-center gap-2 min-w-0 flex-1">` + (c.verdict === "real" ? `<span class="shrink-0 text-xs px-1.5 py-0.5 rounded" style="background:#5b1d1d;color:#ffb4b4">${t("healthReal")}</span>` : confPill) + `<span class="text-ink-200 hover:text-accent cursor-pointer truncate" data-path="${escapeHtml(c.a)}">${escapeHtml(this.ctx.docTitle(c.a))}</span><span class="text-ink-500 shrink-0">⇄</span><span class="text-ink-200 hover:text-accent cursor-pointer truncate" data-path="${escapeHtml(c.b)}">${escapeHtml(this.ctx.docTitle(c.b))}</span></div><button type="button" class="act-cdismiss shrink-0 inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-lg border subtle-border bg-navy-600 hover:bg-navy-500 text-ink-300 hover:text-ink-100 transition" data-a="${escapeHtml(c.a)}" data-b="${escapeHtml(c.b)}" data-aline="${c.a_line || ""}" data-bline="${c.b_line || ""}" data-tip="${escapeHtml(t("healthDismissHint"))}">✓ ${t("healthDismiss")}</button></div>` + (meta ? `<div class="text-xs text-ink-500 mt-0.5 truncate">${meta}</div>` : "") + "</div>";
    }).join("");
    if (cands.length > 8) out += `<div class="text-right mt-1"><a class="act-csee text-sm text-accent hover:underline cursor-pointer">${this.candExpanded ? t("actCollapse") : t("actSeeAllN", cands.length)}</a></div>`;
    return out;
  }
  toggleStale(host) {
    this.healthExpanded = !this.healthExpanded;
    host.innerHTML = this.html();
  }
  toggleCand(host) {
    this.candExpanded = !this.candExpanded;
    host.innerHTML = this.html();
  }
  setTab(tab, host) {
    this.healthTab = tab;
    try {
      localStorage.setItem("atlas:healthTab", this.healthTab);
    } catch (_) {
    }
    host.innerHTML = this.html();
  }
  // Human verdict "pas une contradiction" (13c) → POST none, drop the row. The global fetch
  // wrapper injects the CSRF token. The pair resurfaces only if a doc is edited.
  dismiss(cd, host) {
    const { a, b, aline, bline } = cd.dataset;
    cd.disabled = true;
    const body = { a, b, verdict: "none" };
    if (aline) body.a_line = Number(aline);
    if (bline) body.b_line = Number(bline);
    fetch("/api/contradiction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then((r) => {
      if (r.ok) {
        this.health.cands = this.health.cands.filter((c) => !(c.a === a && c.b === b || c.a === b && c.b === a));
        host.innerHTML = this.html();
      } else {
        cd.disabled = false;
      }
    }).catch(() => {
      cd.disabled = false;
    });
  }
}

const activityCard = new ActivityCard();
window.mountActivity = () => activityCard.mount();
window.refreshActivityData = () => activityCard.refreshData();
window.mountActivity();

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
const esc = escapeHtml;
const _Inbox = class _Inbox {
  constructor() {
    // ---- state ----
    __publicField(this, "inbox", null);
    // the queue | []
    __publicField(this, "total", 0);
    // baseline length, for the "X / Y traités" progress
    __publicField(this, "filter", null);
    // enabled source keys (null = all on)
    __publicField(this, "session", { kept: 0, trashed: 0, snoozed: 0 });
    __publicField(this, "overrides", {});
    // path -> edits, re-applied across reloads
    __publicField(this, "leaving", false);
    // an action is mid-flight (swipe-out guard)
    __publicField(this, "pollTimer", null);
    __publicField(this, "box", null);
    // the #activity-inbox container, owned after mount
    __publicField(this, "app", null);
    __publicField(this, "keyHandler", null);
    // inline-editor state — replaces the old DOM-sniffing editing() guard
    __publicField(this, "editingDest", false);
    __publicField(this, "editingTag", false);
    __publicField(this, "cb", null);
    // AtlasCombobox controller while the dest editor is open
    __publicField(this, "destInput", null);
    __publicField(this, "tagInput", null);
    // the sub region snapshot, refreshed only while NOT editing (the don't-move-the-input invariant)
    __publicField(this, "subSources", []);
    __publicField(this, "subDone", 0);
    __publicField(this, "subTotal", 0);
    // toast state (a keyed vnode, not an appended node)
    __publicField(this, "toastN", 0);
    __publicField(this, "toastShow", false);
    __publicField(this, "toastTimer", null);
  }
  editing() {
    return this.editingDest || this.editingTag;
  }
  draw() {
    if (this.app) this.app.render();
  }
  // ---- small helpers ----
  svg(d) {
    return raw('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="' + d + '"/></svg>');
  }
  rel(min) {
    if (min < 1) return t("relJustNow");
    if (min < 60) return Math.round(min) + " min";
    const h2 = Math.round(min / 60);
    if (h2 < 24) return h2 + " h";
    const d = Math.round(min / 1440);
    if (d === 1) return t("relYesterday");
    return t("relDaysAgo", d);
  }
  srcMeta(src) {
    const s = _Inbox.ISRC[src];
    return s ? { tint: s.tint, d: s.d } : { tint: "#868a90", d: _Inbox.IDOC };
  }
  srcIc(src) {
    const m = this.srcMeta(src);
    return h("span", { class: "ibx-ic", style: "background:" + m.tint + "22;color:" + m.tint }, this.svg(m.d));
  }
  tier(c) {
    return c >= 0.75 ? "hi" : c >= 0.4 ? "md" : "lo";
  }
  tierLabel(c) {
    return c >= 0.75 ? t("inboxConfHigh") : c >= 0.4 ? t("inboxConfMed") : t("inboxConfLow");
  }
  ago(it) {
    return this.rel(it.captured_at ? Math.max(0, (Date.now() / 1e3 - it.captured_at) / 60) : 0);
  }
  // Destination Keep promotes to: your edited override, else the agent's suggest_dest, else the FOLDER
  // of the top same-subject neighbour. Editable, and the promoted doc inherits the chosen folder's ACL.
  suggestDest(it) {
    if (it._dest != null) return it._dest;
    if (it.suggest_dest) return it.suggest_dest;
    const nb = it.neighbors && it.neighbors[0];
    return nb && nb.indexOf("/") >= 0 ? nb.replace(/\/[^/]*$/, "") + "/" : "";
  }
  tags(it) {
    return it._tags != null ? it._tags : it.suggest_tags || [];
  }
  storeOverride(it) {
    this.overrides[it.path] = { dest: it._dest, tags: it._tags };
  }
  // Tags the destination folder auto-derives, so they aren't offered again (the folder IS a tag).
  folderTags(it) {
    const d = this.suggestDest(it);
    return d && typeof folderTagsOf === "function" ? folderTagsOf(d.replace(/\/+$/, "") + "/_.md") : [];
  }
  queue() {
    if (!this.inbox) return [];
    return this.filter ? this.inbox.filter((i) => this.filter.has(i.source)) : this.inbox;
  }
  snoozeDate() {
    const d = /* @__PURE__ */ new Date();
    d.setDate(d.getDate() + 3);
    return d.toISOString().slice(0, 10);
  }
  updateBadge() {
    const b = document.getElementById("inbox-badge");
    if (b) {
      const n = this.queue().length;
      b.textContent = String(n);
      b.classList.toggle("hidden", !n);
    }
  }
  // ---- views (vnode trees; the keyed reconciler reuses live nodes by key) ----
  tagsView(it) {
    const fset = new Set(this.folderTags(it));
    const custom = this.tags(it).filter((tg) => !fset.has(tg));
    const out = [];
    for (const tg of fset) {
      out.push(h("span", { key: "f:" + tg, class: "doc-tag doc-tag-folder", title: esc(t("folderTagTitle")) }, "#" + tg));
    }
    for (const tg of custom) {
      out.push(
        h(
          "span",
          { key: "c:" + tg, class: "doc-tag" },
          "#" + tg,
          h("button", { class: "doc-tag-x ibx-rmtag", title: esc(t("removeTag")), onClick: () => this.removeTag(it, tg) }, "×")
        )
      );
    }
    out.push(
      this.editingTag ? h("input", {
        key: "tagedit",
        class: "ibx-tagedit-input",
        autocomplete: "off",
        placeholder: t("inboxNewTag"),
        ref: (el) => {
          this.tagInput = el;
          if (el) el.focus();
        },
        onKeydown: (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            this.commitTag(it);
          } else if (e.key === "Escape") {
            e.preventDefault();
            this.endEdit();
          }
        },
        onBlur: () => setTimeout(() => {
          if (this.editingTag) this.commitTag(it);
        }, 150)
      }) : h("button", { key: "addtag", type: "button", class: "doc-tag-add ibx-addtag", title: esc(t("addTag")), onClick: () => {
        this.editingTag = true;
        this.draw();
      } }, "+")
    );
    return out;
  }
  destView(it) {
    if (this.editingDest) {
      return [
        h("span", { class: "ibx-lbl" }, t("inboxFileUnder")),
        h("input", {
          key: "destedit",
          class: "ibx-destedit",
          value: this.suggestDest(it),
          autocomplete: "off",
          placeholder: t("inboxPickOrType"),
          ref: (el) => this.destEditorRef(it, el),
          onKeydown: (e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              this.endEdit();
            }
          },
          onBlur: () => setTimeout(() => {
            if (this.editingDest) this.commitDest(it);
          }, 180)
        })
      ];
    }
    const sd = this.suggestDest(it);
    const chip = sd ? h("span", { class: "ibx-destchip editable", onClick: () => this.openDest() }, this.svg(_Inbox.IDOC), sd, this.svg(_Inbox.IPENCIL)) : h("span", { class: "ibx-destchip editable empty", onClick: () => this.openDest() }, t("inboxChooseFolder"), this.svg(_Inbox.IPENCIL));
    return [h("span", { class: "ibx-lbl" }, t("inboxFileUnder")), chip];
  }
  focusView(it) {
    const tr = this.tier(it.confidence);
    const sd = this.suggestDest(it);
    const nb = it.neighbors && it.neighbors[0];
    return h(
      "div",
      { key: "focus:" + it.path, class: "ibx-focus" + (this.leaving ? " ibx-leaving" : " ibx-entering"), id: "ibx-focus" },
      h(
        "div",
        { class: "ibx-frow" },
        h("span", { class: "ibx-src" }, this.srcIc(it.source), it.source),
        h("span", { class: "ibx-pill " + tr, title: Math.round(it.confidence * 100) + "%" }, this.tierLabel(it.confidence)),
        h("span", { class: "ibx-spacer" }),
        h("span", { class: "ibx-ago" }, this.ago(it))
      ),
      h("div", { class: "ibx-title" }, it.title),
      it.preview ? h("p", { class: "ibx-body" }, it.preview) : null,
      nb ? h(
        "div",
        { class: "ibx-signal" },
        h("span", { class: "sic" }, this.svg(_Inbox.ILINK)),
        h("div", null, h("b", null, t("inboxSameSubject")), " ", h("span", { class: "doc" }, nb))
      ) : null,
      h("div", { class: "ibx-dest" }, this.destView(it), h("span", { class: "ibx-lbl" }, "tags"), h("span", { class: "ibx-tags" }, this.tagsView(it))),
      h(
        "div",
        { class: "ibx-actions" },
        h(
          "button",
          { type: "button", class: "ibx-btn keep" + (sd ? "" : " disabled"), disabled: !sd, title: sd ? null : t("inboxPickFolderFirst"), onClick: () => this.act("keep") },
          this.svg(_Inbox.ICHECK),
          t("inboxKeep") + " ",
          h("span", { class: "k" }, "K")
        ),
        h(
          "button",
          { type: "button", class: "ibx-btn trash", onClick: () => this.act("trash") },
          this.svg(_Inbox.ITRASH),
          t("inboxTrash") + " ",
          h("span", { class: "k" }, "X")
        ),
        h(
          "button",
          { type: "button", class: "ibx-btn snooze", onClick: () => this.act("snooze") },
          this.svg(_Inbox.ISNOOZE),
          t("inboxSnooze") + " ",
          h("span", { class: "k" }, "S")
        ),
        h("span", { class: "ibx-spacer" }),
        h("button", { type: "button", class: "ibx-btn ghost", onClick: () => this.act("next") }, t("inboxNext") + " ", h("span", { class: "k" }, "J"))
      )
    );
  }
  qRowView(it) {
    return h(
      "div",
      { key: "row:" + it.path, class: "ibx-qrow", "data-ipath": it.path, onClick: () => this.select(it.path) },
      this.srcIc(it.source),
      h("span", { class: "ibx-qt" }, it.title),
      h("span", { class: "ibx-mini " + this.tier(it.confidence), title: this.tierLabel(it.confidence) }),
      h("span", { class: "ibx-qa" }, this.ago(it))
    );
  }
  chipsView() {
    return h(
      "div",
      { class: "ibx-chips" },
      this.subSources.map((s) => {
        const on = !this.filter || this.filter.has(s);
        const m = this.srcMeta(s);
        return h(
          "button",
          { key: s, type: "button", class: "ibx-chip " + (on ? "on" : ""), onClick: () => this.toggleFilter(s) },
          h("span", { class: "g", style: "color:" + m.tint }, this.svg(m.d)),
          s
        );
      })
    );
  }
  subView() {
    const pct = this.subTotal ? Math.round(this.subDone / this.subTotal * 100) : 0;
    return h(
      "div",
      { key: "sub", class: "ibx-sub", id: "ibx-sub" },
      h(
        "div",
        { class: "ibx-progress" },
        h("b", { id: "ibx-done" }, String(this.subDone)),
        " / ",
        h("span", { id: "ibx-total" }, String(this.subTotal)),
        " " + t("inboxDone"),
        h("span", { class: "track" }, h("span", { class: "fill", id: "ibx-fill", style: "width:" + pct + "%" }))
      ),
      h("div", { id: "ibx-chips-wrap" }, this.chipsView())
    );
  }
  zeroView() {
    const s = this.session;
    const total = s.kept + s.trashed + s.snoozed;
    const dp = (d, n, l, col) => h("span", { class: "ibx-dpill" }, h("span", { style: "color:" + col }, this.svg(d)), h("b", null, String(n)), " " + l);
    return h(
      "div",
      { key: "zero", class: "ibx-zero" },
      h("div", { class: "ibx-mark" }, this.svg(_Inbox.ICHECK)),
      h("h3", null, t("inboxZeroTitle")),
      h("p", null, t("inboxZeroSub")),
      total ? h(
        "div",
        { class: "ibx-digest" },
        dp(_Inbox.ICHECK, s.kept, t("inboxKept"), "#5fd0a6"),
        dp(_Inbox.ITRASH, s.trashed, t("inboxTrashed"), "#868a90"),
        dp(_Inbox.ISNOOZE, s.snoozed, t("inboxSnoozed"), "#e8941c")
      ) : null
    );
  }
  skelView() {
    const row = (i) => h(
      "div",
      { key: "sk:" + i, class: "ibx-skelrow" },
      h("div", { class: "ibx-skel", style: "width:30px;height:30px;border-radius:8px" }),
      h(
        "div",
        { style: "flex:1" },
        h("div", { class: "ibx-skel", style: "width:42%;height:10px" }),
        h("div", { class: "ibx-skel", style: "width:26%;height:8px;margin-top:6px" })
      )
    );
    return h("div", { key: "skel" }, [0, 1, 2].map(row));
  }
  toastView() {
    if (!this.toastN) return null;
    return h("div", { key: "toast", id: "ibx-toast", class: "ibx-toast" + (this.toastShow ? " show" : "") }, t("inboxNew", this.toastN));
  }
  nextView(up) {
    return h(
      "div",
      { key: "next", id: "ibx-next" },
      h("div", { class: "ibx-next-h", id: "ibx-next-h", style: up.length ? null : "display:none" }, up.length ? t("inboxUpNext") + " · " + up.length : ""),
      h("div", { id: "ibx-next-rows" }, up.map((it) => this.qRowView(it)))
    );
  }
  // Refresh the sub snapshot (source chips + progress). Skipped while editing so the input never shifts.
  refreshSub() {
    const srcs = [];
    (this.inbox || []).forEach((i) => {
      if (srcs.indexOf(i.source) < 0) srcs.push(i.source);
    });
    this.subSources = srcs;
    this.subDone = Math.max(0, this.total - (this.inbox ? this.inbox.length : 0));
    this.subTotal = this.total;
  }
  view() {
    if (this.inbox === null) return this.skelView();
    const q = this.queue();
    if (!q.length) return this.zeroView();
    if (!this.editing()) this.refreshSub();
    return [this.subView(), this.focusView(q[0]), this.nextView(q.slice(1)), this.toastView()];
  }
  // ---- data + live poll ----
  applyOverride(it) {
    const o = this.overrides[it.path];
    if (o) {
      if (o.dest != null) it._dest = o.dest;
      if (o.tags != null) it._tags = o.tags;
    }
  }
  async load(force) {
    if (this.inbox && !force) {
      this.draw();
      return;
    }
    let inbox = [];
    try {
      const r = await fetch("/api/inbox?limit=200");
      if (r.ok) inbox = (await r.json()).inbox || [];
    } catch (_) {
    }
    inbox.forEach((it) => this.applyOverride(it));
    this.inbox = inbox;
    this.total = inbox.length;
    this.session = { kept: 0, trashed: 0, snoozed: 0 };
    this.filter = null;
    this.draw();
  }
  // Detect new items and grow ONLY the list; while an editor is open the sub region stays frozen, so
  // the input never shifts and the combobox popup stays anchored.
  poll() {
    if (!this.box || this.box.classList.contains("hidden") || !this.inbox) return;
    fetch("/api/inbox?limit=200").then((r) => r.ok ? r.json() : null).then((d) => {
      if (!d) return;
      const have = new Set(this.inbox.map((i) => i.path));
      const fresh = (d.inbox || []).filter((i) => !have.has(i.path));
      if (!fresh.length) return;
      fresh.forEach((it) => this.applyOverride(it));
      this.inbox = this.inbox.concat(fresh);
      this.total += fresh.length;
      this.updateBadge();
      if (!this.editing()) this.showToast(fresh.length);
      this.draw();
    }).catch(() => {
    });
  }
  startPoll() {
    this.stopPoll();
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), 5e3);
  }
  stopPoll() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
  showToast(n) {
    this.toastN = n;
    this.toastShow = true;
    this.draw();
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toastShow = false;
      this.draw();
    }, 3200);
  }
  // ---- actions ----
  act(kind) {
    const q = this.queue();
    if (!q.length || this.leaving) return;
    const it = q[0];
    if (kind === "next") {
      this.inbox = this.inbox.filter((x) => x.path !== it.path).concat([it]);
      this.draw();
      return;
    }
    if (kind === "keep" && !this.suggestDest(it)) return;
    const body = { action: kind, path: it.path };
    if (kind === "keep") {
      body.dest = this.suggestDest(it);
      const fset = new Set(this.folderTags(it));
      body.tags = this.tags(it).filter((tg) => !fset.has(tg));
    }
    if (kind === "snooze") body.until = this.snoozeDate();
    this.leaving = true;
    this.draw();
    fetch("/api/inbox/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => {
      if (r.ok) {
        if (_Inbox.SKEY[kind]) this.session[_Inbox.SKEY[kind]]++;
        setTimeout(() => {
          this.inbox = this.inbox.filter((x) => x.path !== it.path);
          delete this.overrides[it.path];
          this.leaving = false;
          this.draw();
        }, 180);
      } else {
        this.leaving = false;
        this.draw();
      }
    }).catch(() => {
      this.leaving = false;
      this.draw();
    });
  }
  select(path) {
    const it = this.inbox && this.inbox.find((x) => x.path === path);
    if (!it) return;
    this.inbox = [it].concat(this.inbox.filter((x) => x.path !== path));
    this.draw();
  }
  toggleFilter(src) {
    if (!this.filter) this.filter = new Set(this.inbox.map((i) => i.source));
    if (this.filter.has(src) && this.filter.size > 1) this.filter.delete(src);
    else this.filter.add(src);
    this.draw();
  }
  // ---- inline editors ----
  openDest() {
    this.editingDest = true;
    this.draw();
  }
  // Mount/tear the folder combobox on the dest input as it enters/leaves the DOM. ref fires after the
  // node is attached, so getBoundingClientRect (the popup anchor) is valid.
  destEditorRef(it, el) {
    if (el) {
      this.destInput = el;
      if (typeof AtlasCombobox === "function" && typeof getAllDirs === "function") {
        this.cb = AtlasCombobox(el, { source: getAllDirs, creatable: true, onSelect: (v) => this.commitDest(it, v) });
      }
      el.focus();
      el.select();
    } else {
      this.destInput = null;
      if (this.cb) {
        this.cb.destroy();
        this.cb = null;
      }
    }
  }
  commitDest(it, v) {
    it._dest = (v != null ? v : this.destInput ? this.destInput.value : "").trim();
    this.storeOverride(it);
    this.endEdit();
  }
  removeTag(it, tg) {
    it._tags = this.tags(it).filter((x) => x !== tg);
    this.storeOverride(it);
    this.draw();
  }
  commitTag(it) {
    const tg = (this.tagInput ? this.tagInput.value : "").trim().replace(/^#/, "");
    const cur = this.tags(it);
    it._tags = tg && cur.indexOf(tg) < 0 ? cur.concat([tg]) : cur.slice();
    this.storeOverride(it);
    this.endEdit();
  }
  // Close any open inline editor and re-render (the sub region catches up to the live state).
  endEdit() {
    this.editingDest = false;
    this.editingTag = false;
    this.draw();
  }
  // ---- document keyboard shortcuts (K/X/S/J) ----
  onKey(ev) {
    const ae = document.activeElement;
    if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return;
    if (!this.box || this.box.classList.contains("hidden") || !this.queue().length) return;
    const k = ev.key.toLowerCase();
    const a = k === "k" ? "keep" : k === "x" ? "trash" : k === "s" ? "snooze" : k === "j" || ev.key === "ArrowDown" ? "next" : null;
    if (!a) return;
    ev.preventDefault();
    this.act(a);
  }
  // ---- public API (called by the Activity card's setView) ----
  mount(container) {
    this.box = container;
    this.app = createApp(container, () => this.view());
    if (this.keyHandler) document.removeEventListener("keydown", this.keyHandler);
    this.keyHandler = (ev) => this.onKey(ev);
    document.addEventListener("keydown", this.keyHandler);
    this.load(false);
  }
  show() {
    this.startPoll();
  }
  hide() {
    this.stopPoll();
  }
  // Keep the header count live without opening the tab. If the tab is on screen the poll owns the
  // badge, so skip. Seeds inbox so a later open is instant. No-op offline (the fetch just fails).
  async refreshBadge() {
    const live = document.querySelector("#activity-inbox");
    if (live && !live.classList.contains("hidden")) return;
    try {
      const r = await fetch("/api/inbox?limit=200");
      if (!r.ok) return;
      const fresh = (await r.json()).inbox || [];
      fresh.forEach((it) => this.applyOverride(it));
      this.inbox = fresh;
      this.total = fresh.length;
      this.updateBadge();
    } catch (_) {
    }
  }
};
// ---- icons (Heroicons v2 outline, the viewer's set) ----
__publicField(_Inbox, "ISRC", {
  gmail: { tint: "#5db5e8", d: "M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75" },
  sentry: { tint: "#e8941c", d: "M14.857 17.082a23.85 23.85 0 0 0 5.454-1.31A8.97 8.97 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.97 8.97 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.26 24.26 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0" },
  scraper: { tint: "#5fd0a6", d: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0 0a8.95 8.95 0 0 0 0-18m0 18a8.95 8.95 0 0 1 0-18M3 12h18" },
  webhook: { tint: "#b58be8", d: "M3.75 13.5 14.25 2.25 12 10.5h8.25L9.75 21.75 12 13.5H3.75Z" },
  slack: { tint: "#e85b8b", d: "M2.25 12.76c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.184-4.183a1.14 1.14 0 0 1 .778-.332 48.3 48.3 0 0 0 5.83-.498c1.585-.233 2.708-1.626 2.708-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.4 48.4 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" },
  manual: { tint: "#b0b1b5", d: "m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.931-8.931Zm0 0L19.5 7.125" }
});
__publicField(_Inbox, "IDOC", "M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z");
__publicField(_Inbox, "ILINK", "M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244");
__publicField(_Inbox, "ICHECK", "M4.5 12.75l6 6 9-13.5");
__publicField(_Inbox, "ITRASH", "M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.1 48.1 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.1 48.1 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.96 51.96 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.67 48.67 0 0 0-7.5 0");
__publicField(_Inbox, "ISNOOZE", "M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5");
__publicField(_Inbox, "IPENCIL", "m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.931-8.931Zm0 0L19.5 7.125");
__publicField(_Inbox, "SKEY", { keep: "kept", trash: "trashed", snooze: "snoozed" });
let Inbox = _Inbox;
if (typeof escapeHtml === "function") {
  window.AtlasInbox = new Inbox();
}

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
class Boot {
  constructor() {
    __publicField(this, "swReloading", false);
    __publicField(this, "swUpdatePending", false);
    __publicField(this, "swReg", null);
    __publicField(this, "hadController", false);
  }
  start() {
    if (isServerMode) this.serverBoot();
    else this.fileBoot();
  }
  serverBoot() {
    treeEl.innerHTML = Array.from({ length: 7 }, (_, i) => `<div class="skeleton" style="height:1rem;margin:.55rem .5rem;width:${55 + i * 17 % 40}%"></div>`).join("");
    contentEl.innerHTML = '<div class="not-prose" style="max-width:46rem;margin:0 auto;padding-top:2.5rem"><div class="skeleton-title" style="height:2.2rem;width:55%;margin-bottom:1.6rem"></div>' + Array.from({ length: 6 }, (_, i) => `<div class="skeleton" style="height:.9rem;margin:.7rem 0;width:${70 + i * 13 % 26}%"></div>`).join("") + "</div>";
    fetch("/api/me").then((r) => r.json()).then((data) => {
      meState = data;
      if (data.authenticated) {
        if (data.csrf_token) setCsrfToken(data.csrf_token);
        if (typeof data.totp_enabled === "boolean") totpEnabled = data.totp_enabled;
        if (data.cloud && data.email) {
          document.getElementById("user-email").textContent = data.name || data.email;
          const avatar = document.getElementById("user-avatar");
          if (avatar) avatar.innerHTML = constellationSvg(avatarSeed(data.first_name, data.last_name, data.email), 30);
          document.getElementById("user-bar").classList.remove("hidden");
        }
        if (data.role && data.role !== "admin") document.body.classList.add("viewer-mode");
        if (data.cloud && data.role === "admin") document.body.classList.add("admin-cloud");
        if (data.cloud) {
          document.body.classList.add("cloud-authed");
          refreshSecurityState();
        }
      }
      this.softReload();
    }).catch((e) => {
      console.warn("boot /api/me failed:", e);
      this.softReload();
    });
    refresh();
    setInterval(refresh, 1e4);
    window.softReload = () => this.softReload();
    this.setupSse();
    this.setupServiceWorker();
  }
  fileBoot() {
    todoList.innerHTML = '<li class="px-3 py-4 text-center text-xs text-slate-500">' + t("fileModeTodosHtml") + "</li>";
    todoInput.disabled = true;
    todoForm.querySelector("button").disabled = true;
    setStatus(t("serverRequired"), "err");
    newFileBtn.classList.add("hidden");
    qcBtn.classList.add("hidden");
  }
  // Bail conditions for a live-reload: anything the user is mid-action on that a re-render would
  // clobber. Pure business POLICY (no DOM-destruction crutch — the runtime handles that). Checked
  // BOTH before the fetch AND after the await (the SSE 'reload' fires exactly when a doc changed,
  // so an Edit started during the network RTT must still abort the stale reload).
  shouldAbortReload() {
    if (editMode) return true;
    if (document.querySelector(".todo-edit")) return true;
    if (!newFileBackdrop.classList.contains("hidden")) return true;
    if (!qcBackdrop.classList.contains("hidden")) return true;
    if (!shareBackdrop.classList.contains("hidden")) return true;
    if (!dirRenameBackdrop.classList.contains("hidden")) return true;
    if (document.querySelector("[data-atlas-modal]:not(.hidden)")) return true;
    if (currentFile && sse.isSelfSaveMuted(currentFile.path)) return true;
    return false;
  }
  async softReload() {
    if (this.shouldAbortReload()) return;
    try {
      const res = await fetch("/api/tree");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const newTree = await res.json();
      if (this.shouldAbortReload()) return;
      TREE.children = newTree.children;
      TREE.name = newTree.name;
      for (const k in fileMap) delete fileMap[k];
      mdCount = 0;
      otherCount = 0;
      index(TREE);
      statsEl.textContent = t("statsLine", mdCount, otherCount);
      contentTree.reload();
      decorateTreeBadges();
      contentTree.decorateRemoteOrigins();
      renderRecent();
      backlinksIndex = null;
      backlinksLoading = null;
      miniSearch = null;
      searchInitPromise = null;
      _wlMaps = null;
      if (currentFile) {
        const newFile = fileMap[currentFile.path];
        if (!newFile) {
          showNotFound(currentFile.path);
        } else if (newFile.mtime !== currentFile.mtime) {
          contentCache.delete(newFile.path);
          newFile.content = void 0;
          const main = document.querySelector("main");
          const scrollPos = main.scrollTop;
          await showMarkdown(newFile);
          main.scrollTop = scrollPos;
        } else {
          currentFile = newFile;
        }
      } else if (document.getElementById("home-activity-mount") && window.refreshActivityData) {
        window.refreshActivityData();
      } else {
        const main = document.querySelector("main");
        const sp = main.scrollTop;
        routeFromHash();
        main.scrollTop = sp;
      }
    } catch (e) {
      console.warn("softReload skipped (transient):", e);
    }
  }
  setupSse() {
    try {
      const es = new EventSource("/api/events");
      es.addEventListener("message", (e) => {
        if (e.data === "reload") this.softReload();
      });
    } catch (e) {
      console.warn("SSE live-reload unavailable:", e);
    }
  }
  // Service worker (offline + instant-loading PWA). On deploy the new SW takes control → reload ONCE
  // for fresh assets. Skip the first install, never clobber an open editor (deferred update retried
  // when the tab regains focus).
  setupServiceWorker() {
    if (!("serviceWorker" in navigator) || !location.protocol.startsWith("http")) return;
    this.hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!this.hadController) return;
      this.swUpdatePending = true;
      this.reloadForUpdate();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      if (this.swUpdatePending) this.reloadForUpdate();
      else if (this.swReg) this.swReg.update();
    });
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).then((reg) => {
        this.swReg = reg;
        reg.update();
      }).catch((e) => console.warn("SW register failed", e));
    });
  }
  reloadForUpdate() {
    if (this.swReloading || document.getElementById("md-editor")) return;
    this.swReloading = true;
    location.reload();
  }
}
new Boot().start();
