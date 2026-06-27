// ─── Data injected by build.py ───────────────────────────────────────────
// Online: EMBED_* are null, loaded on demand from the server.
// Offline: they hold the inline data (standalone HTML).
const TREE = __DATA__;
const EMBED_CONTENT = __EMBED_CONTENT__;
const EMBED_BACKLINKS = __EMBED_BACKLINKS__;
const EMBED_NOTES = __EMBED_NOTES__;
const EMBED_TASKS = __EMBED_TASKS__;
// Frozen activity-layer snapshot {events, stale, contradictions} for the offline
// build (public minds); null online → the home fetches /api/activity live.
const EMBED_ACTIVITY = __EMBED_ACTIVITY__;
// New-document skeletons {label: markdown}, label = file name without extension.
// Engine templates/ merged with <mind>/templates/ (mind overrides).
const DOC_TEMPLATES = __TEMPLATES__;
const IS_OFFLINE_BUILD = EMBED_CONTENT !== null;
// Captured from <title> BEFORE the todos badge mutates it. Entities are already
// decoded by the parser, so re-escape via escapeHtml when displaying.
const SITE_NAME = document.title;
// Injected as JSON constants, not raw text placeholders: a backtick or ${…} in
// atlas.toml must neither break the script nor evaluate code.
const TAGLINE = __TAGLINE_JSON__;
const SITE_PREFIX = __SITE_PREFIX_JSON__;

// ─── CSRF synchronizer ───────────────────────────────────────────────────────
// In cloud mode every authenticated MUTATING request needs the X-CSRF-Token
// header (HMAC of email|epoch). We wrap window.fetch ONCE so any same-origin
// mutating request gets it automatically. Token source, by priority:
//   1. /api/me csrf_token — authoritative after epoch rotation;
//   2. else the kb_csrf cookie (readable, not HttpOnly) — for the first call
//      before /api/me responds.
// Refreshed via setCsrfToken() after any epoch bump (logout-all, TOTP enable/disable).
let csrfToken = null;
let meState = null; // latest /api/me (email, role, cloud, totp_enabled…)
let totpEnabled = false; // 2FA state of the current account (cloud)

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

  window.fetch = function (input, init) {
    init = init || {};
    const method = (
      init.method ||
      (typeof input !== 'string' && input && input.method) ||
      'GET'
    ).toUpperCase();
    // Only mutating requests to a relative (same-origin) URL: an absolute URL
    // (CDN, external) must never receive our token.
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const sameOrigin = url && !/^https?:\/\//i.test(url);

    if (MUTATING[method] && sameOrigin) {
      const token = currentCsrfToken();

      if (token) {
        const headers = new Headers(
          init.headers || (typeof input !== 'string' && input && input.headers) || {},
        );

        if (!headers.has('X-CSRF-Token')) headers.set('X-CSRF-Token', token);
        init = Object.assign({}, init, { headers });
      }
    }

    return nativeFetch(input, init);
  };
})();

// ─── i18n (fr/en — language from atlas.toml, set by build.py on <html lang>) ───
// All UI labels go through t(key, ...args). Technical values (CSS classes, API
// keys, todo category data) are NOT translated.

const LANG = (document.documentElement.lang || 'fr').toLowerCase().startsWith('en') ? 'en' : 'fr';
const STRINGS = {
  fr: {
    // Génériques
    cancel: 'Annuler',
    confirm: 'Confirmer',
    ok: 'OK',
    errorTitle: 'Erreur',
    offlineTitle: 'Mode hors-ligne',
    offlineDisabled: 'Cette fonctionnalité est désactivée.',
    save: 'Enregistrer',
    close: 'Fermer',
    del: 'Supprimer',
    copy: 'Copier',
    copied: 'Copié',
    copiedBang: 'Copié !',
    validate: 'Valider',
    create: 'Créer',
    err: (m) => 'Erreur: ' + m,
    errSp: (m) => 'Erreur : ' + m,
    nameRequired: 'Nom requis',
    titleRequired: 'Titre requis',
    noSlashes: 'Pas de / ni \\ dans le nom',
    // Dates relatives
    justNow: "à l'instant",
    minAgo: (n) => `il y a ${n} min`,
    hoursAgo: (n) => `il y a ${n} h`,
    daysAgo: (n) => `il y a ${n} j`,
    // Sidebar / arbre
    homeTitle: 'Accueil',
    collapseSidebar: 'Replier (Ctrl+B)',
    showSidebar: 'Afficher la sidebar (Ctrl+B)',
    searchPlaceholder: 'Rechercher…',
    graphBtnTitle: 'The Mind (Ctrl+G)',
    expandAllFolders: 'Tout déplier / replier',
    newDocTitle: 'Nouveau document (N)',
    pinnedHeader: 'Épinglés',
    recentHeader: 'Récents',
    sharedHeader: 'Partagés avec vous',
    treeContentHeader: 'Contenu',
    signedInAs: 'Connecté en tant que',
    logoutTitle: 'Se déconnecter',
    logoutLabel: 'Déco',
    statsLine: (md, other) => `${md} markdown / ${other} autres`,
    renameFolder: 'Renommer le dossier',
    renameFile: 'Renommer le fichier',
    treeRemoteBadge: 'lié',
    remotesLabel: 'Nœuds mentaux',
    shareAsNode: 'Partager en nœud',
    notesBadge: (n) => n + ' note(s)',
    // Barre d'actions du document
    pin: 'Épingler',
    unpin: 'Désépingler',
    downloadTitle: 'Télécharger le fichier',
    downloadBtn: 'Télécharger',
    moreActions: "Plus d'actions",
    menuRename: 'Renommer',
    menuMove: 'Déplacer…',
    shareTitle: 'Générer un lien public partagé',
    shareBtn: 'Partager',
    editBtn: 'Éditer',
    saveBtn: 'Sauvegarder',
    saving: 'Sauvegarde…',
    modifiedAgo: (d) => 'modifié ' + d,
    sharedByLabel: (n) => '· partagé par ' + n,
    readingTime: (min, words) => `${min} min · ${words} mots`,
    // Contenu / rendu
    loadingDoc: 'Chargement du document',
    loadError: (m) => 'Erreur de chargement : ' + m,
    offlineMissing: 'contenu manquant dans le build offline',
    brokenLink: (tgt) => 'Doc introuvable : ' + tgt,
    htmlDocBanner: 'Document HTML · rendu isolé (clique dans le cadre pour naviguer au clavier)',
    demoBannerTitle: 'Démo en lecture seule',
    demoBannerText: 'L’édition, les comptes, le partage & la collaboration, l’historique des versions, ton IA (MCP/API) et la synchro Hive nécessitent ta propre instance.',
    demoBannerCta: 'Installer la tienne ↗',
    pdfDocBanner: 'Document PDF · aperçu',
    pdfOfflineHint: 'Aperçu PDF indisponible en mode hors-ligne :',
    docxError: (e) => `Impossible d'afficher ce document Word (${e}). Télécharger :`,
    openFullscreen: 'Ouvrir en plein écran ↗',
    cantLoadDoc: (m) => 'Impossible de charger le document: ' + m,
    fileModeNoEdit: 'Édition indisponible en mode hors-ligne',
    // Tags
    folderTagTitle: 'Tag de dossier (toujours présent)',
    removeTag: 'Retirer',
    addTag: 'Ajouter un tag',
    tagSaveFailed: (m) => 'Échec de la sauvegarde du tag : ' + m,
    tagEditorTitle: 'Tags custom',
    tagPlaceholder: 'nouveau tag…',
    tagEditorHint: 'Entrée pour ajouter · les tags de dossier restent toujours',
    noCustomTags: 'Aucun tag custom.',
    docsWithTag: (n) => n + ' document' + (n > 1 ? 's' : '') + ' avec ce tag.',
    // Panneau latéral (sommaire / liens / notes)
    tocHeader: 'Sur ce doc',
    hideToc: 'Masquer (Ctrl+J)',
    showToc: 'Afficher le sommaire (Ctrl+J)',
    linksTitle: 'Liens',
    historyTitle: 'Historique du document',
    historyLabel: 'Historique',
    historyHeader: 'Historique',
    historyClose: 'Fermer (Esc)',
    historyPick: 'Sélectionne une révision à gauche.',
    historyEmpty: 'Aucun historique pour ce document.',
    historyAiOnly: 'Écritures IA',
    historyNoAi: 'Aucune écriture IA sur ce document.',
    digestWeek: 'Cette semaine',
    digestDocs: (n) => 'doc' + (n > 1 ? 's' : ''),
    digestCreated: (n) => 'créé' + (n > 1 ? 's' : ''),
    digestChecked: (n) => 'tâche' + (n > 1 ? 's' : ''),
    digestContributors: () => 'pers.',
    digestViaAi: () => 'IA',
    actTitle: 'Activité',
    actJournal: 'Journal',
    actConstellation: 'Constellation',
    actHealth: 'Santé',
    actAiOnly: 'IA seulement',
    actSeeAll: 'Voir tout →',
    actCollapse: 'Réduire ↑',
    actSeeAllN: (n) => `Voir tout (${n}) →`,
    actSeeChanges: 'Voir les modifications',
    actEmptyAi: 'Aucune écriture IA récente.',
    actEmpty: 'Aucune activité récente.',
    actInbox: 'Inbox',
    inboxKeep: 'Garder',
    inboxTrash: 'Jeter',
    inboxSnooze: 'Snooze',
    inboxZero: 'Inbox vide, rien à trier 👌',
    inboxConfHigh: 'confiance haute',
    inboxConfMed: 'confiance moyenne',
    inboxConfLow: 'confiance basse',
    inboxNext: 'Suivant',
    inboxFileUnder: 'classer dans',
    inboxChooseFolder: 'choisir un dossier',
    inboxPickFolderFirst: "choisis d'abord un dossier",
    inboxPickOrType: 'choisis ou tape un dossier',
    inboxNewTag: 'nouveau tag',
    inboxSameSubject: "Même sujet qu'un doc déjà classé :",
    inboxDone: 'traités',
    inboxUpNext: 'À suivre',
    inboxNew: (n) => (n === 1 ? '1 nouveau' : n + ' nouveaux'),
    inboxZeroTitle: 'Inbox',
    inboxZeroSub: "Tes agents font les recherches à ta place. Tu viens de garder l'essentiel.",
    inboxKept: 'gardés → graphe',
    inboxTrashed: 'jetés',
    inboxSnoozed: 'snoozés',
    relJustNow: "à l'instant",
    relYesterday: 'hier',
    relDaysAgo: (d) => 'il y a ' + d + ' j',
    healthTabStale: 'Obsolescence',
    healthTabCont: 'Contradictions',
    healthNoStale: 'Rien de périmé 👌',
    healthMonthsAgo: (n) => `il y a ${n} mois`,
    healthOpenHist: "Ouvrir l'historique",
    healthValueConflict: (s, a, b) => (s ? s + ' : ' : '') + a + ' vs ' + b,
    healthConfHigh: 'valeur ≠',
    healthConfHighHint: 'Deux docs donnent une valeur différente pour la même ligne de tableau. Signal fort.',
    healthReview: 'à vérifier',
    healthReviewHint: 'Même sujet. Piste à lire et juger, rien n’est affirmé.',
    healthNoCand: "Aucune contradiction détectée 👌. Demande à l'IA d'analyser les docs proches.",
    healthAskAi: "Valeurs divergentes et contradictions confirmées. Demande à l'IA d'en chercher d'autres dans les docs proches.",
    healthReal: 'contradiction',
    healthDismiss: 'pas une contradiction',
    healthDismissHint: 'Marquer cette paire comme non contradictoire (réapparaît si un des deux docs est modifié).',
    historyError: 'Impossible de charger l’historique.',
    historyNoChange: 'Aucun changement dans cette révision.',
    historyViewVersion: 'Voir cette version',
    historyViewChanges: 'Voir les changements',
    historyRestore: 'Restaurer cette version',
    historyRestoreBtn: 'Restaurer',
    historyRestoreConfirm:
      'Elle remplacera le contenu actuel du document. Rien n’est perdu : la version actuelle restera dans l’historique, tu pourras y revenir.',
    historyRestored: 'Version restaurée.',
    historyRestoreError: 'Échec de la restauration.',
    referencedBy: (n) => `← Référencé par (${n})`,
    outgoingLinks: (n) => `→ Sortantes (${n})`,
    sameTopic: (n) => `~ Même sujet (${n})`,
    // Annotations
    noteBtn: 'Noter',
    sanitizerMissing:
      'Sanitizer introuvable : rendu bloqué (aucun HTML non assaini). Vérifie /vendor/purify.min.js et le build.',
    appropriateDestPlaceholder: 'dossier/copie',
    notesTitle: (n) => `Notes (${n})`,
    copyAllNotes: 'Copier toutes les notes',
    notesCopied: (n) =>
      `${n} note${n > 1 ? 's' : ''} copiée${n > 1 ? 's' : ''} dans le presse-papier`,
    orphanShort: '⚠ passage introuvable',
    orphanLong: (q) => '⚠ Passage introuvable (texte modifié) : “' + q + '”',
    notePlaceholder: 'Ta note sur ce passage…',
    noteSaveFailed: (m) => 'Échec de l’enregistrement de la note : ' + m,
    actionFailed: (m) => 'Échec : ' + m,
    deleteNoteTitle: 'Supprimer cette note ?',
    deleteNoteMsg: (txt) => 'L’annotation « ' + txt + ' » sera définitivement supprimée.',
    // Recherche
    searching: 'Recherche…',
    noResults: (q) => `Aucun résultat pour "${q}"`,
    nResults: (n) => n + ' résultat' + (n > 1 ? 's' : ''),
    cappedSuffix: ' (50 affichés)',
    paletteResultsCapped: (n) => n + ' résultats (30 affichés)',
    cdnFailMiniSearch: 'Impossible de charger MiniSearch',
    // Accueil
    heatNone: 'Aucune modif',
    heatCount: (n) => n + ' modif' + (n > 1 ? 's' : ''),
    statDocs: 'Documents',
    statDocsSub: 'markdown',
    statWords: 'Mots totaux',
    statWordsSub: (n) => `~${n} min lecture`,
    statWeek: 'Cette semaine',
    statWeekSub: 'docs modifiés (vs précédente)',
    statTodoSub: 'fait / total',
    activityTitle: 'Activité (année glissante)',
    lessLabel: 'moins',
    moreLabel: 'plus',
    favorites: 'Favoris',
    noFavorites: 'Aucun favori. Épingle un doc avec le bouton favori de sa barre.',
    graphLabel: 'The Mind',
    noTags: 'Aucun tag.',
    recentlyModified: 'Récemment modifiés',
    noRecentDocs: 'Aucun document récent.',
    categories: 'Catégories',
    longestDocs: 'Plus longs documents',
    hintPalette: 'palette',
    hintSearch: 'recherche',
    hintSidebar: 'sidebar',
    hintToc: 'sommaire',
    hintEdit: 'éditer',
    hintNewTodo: 'nouvelle todo',
    rootLabel: 'racine',
    // Palette de commandes
    actHome: 'Accueil',
    actHomeHint: "Vue d'ensemble",
    actSidebar: 'Replier / déplier la sidebar',
    actToc: 'Masquer / afficher le sommaire',
    actEdit: 'Éditer le document courant',
    actDownload: 'Télécharger le document courant',
    actSearch: 'Focus recherche',
    actGraph: "The Mind (vue d'ensemble)",
    actReload: 'Recharger la page',
    palettePlaceholder: 'Rechercher un fichier ou une action…',
    paletteNavigate: 'naviguer',
    paletteOpen: 'ouvrir',
    // Graphe
    graphTitle: 'The Mind',
    mindSubtitle: 'ton palais mental, celui que ton IA arpente avec toi',
    graphHint: 'molette : zoom · glisser : déplacer · clic : ouvrir',
    graphModeOrganic: 'Cerveau',
    graphModeStructured: 'Cellules',
    graphTagsToggle: 'Afficher / masquer les tags',
    closeEsc: 'Fermer (Esc)',
    graphStats: (docs, links, tags) => docs + ' docs · ' + links + ' liens, ' + tags + ' tags',
    tasksBtnTitle: 'Tâches',
    tasksTitle: 'Tâches',
    tasksShowDone: 'Afficher les faites',
    tasksEmpty: 'Aucune tâche à faire 🎉',
    tasksLoading: 'Chargement des tâches',
    tasksStats: (open, total) => open + ' à faire · ' + total + ' au total',
    nDocs: (n) => n + ' doc' + (n > 1 ? 's' : ''),
    // Widget to-do
    nPending: (n) => `${n} à faire`,
    addTodoIn: (label) => 'Ajouter dans ' + label + '…',
    todoAddPlaceholder: 'Ajouter une tâche…',
    enterKey: 'Entrée',
    showDone: (n) => `Afficher faits (${n})`,
    hideDone: (n) => `Masquer faits (${n})`,
    clearDoneTitle: 'Supprimer toutes les tâches faites',
    clearDoneBtn: 'Vider faits',
    noTasksIn: (label) => `Aucune tâche dans ${label}. Ajoute-en une.`,
    allDone: (done) =>
      `Tout est fait ${done > 0 ? `(${done} masqu${done > 1 ? 'ées' : 'ée'})` : ''}`,
    updated: 'Modifié',
    synced: 'Synchronisé',
    offlinePrefix: (m) => 'Hors-ligne: ' + m,
    fileModeTodoStatus: 'Indisponible en mode hors-ligne',
    adding: 'Ajout…',
    added: 'Ajouté',
    doneStatus: 'Terminé',
    reopened: 'Réouvert',
    deletedStatus: 'Supprimé',
    clearDoneConfirmTitle: (n) => `Vider ${n} tâche${n > 1 ? 's' : ''} faite${n > 1 ? 's' : ''} ?`,
    clearDoneConfirmMsg: 'Les tâches cochées seront définitivement supprimées.',
    clearBtn: 'Vider',
    clearing: 'Vidage…',
    nCleared: (n) => `${n} supprimé${n > 1 ? 'es' : 'e'}`,
    serverRequired: 'Serveur requis',
    fileModeTodosHtml: 'Les tâches sont indisponibles en mode hors-ligne',
    // Modales document (renommer / déplacer / supprimer / nouveau)
    renameDocTitle: 'Renommer le document',
    moveDocTitle: 'Déplacer le document',
    folderLabel: 'Dossier',
    dirPlaceholder: 'ex: notes/projets',
    filenameLabel: 'Nom du fichier',
    filenamePlaceholder: 'nom-du-fichier',
    fileExistsAt: 'Un fichier existe deja a cet emplacement',
    docMoved: 'Document deplace',
    docRenamed: 'Document renomme',
    deleteDocTitle: 'Supprimer ce document ?',
    deleteDocMsg: (path) =>
      'Le fichier "' + path + '" sera definitivement supprime (un commit Git garde l\'historique).',
    docDeleted: 'Document supprime',
    newDocHeader: 'Nouveau document',
    templateLabel: 'Template',
    visibilityLabel: 'Visibilité',
    visibilityPrivate: 'Privé, moi seul',
    visibilityCommons: 'Commun, toute l\'équipe',
    tplBlank: 'Vide',
    docNamePlaceholder: 'mon-document',
    fileExists: 'Fichier deja existant',
    docCreated: 'Document cree',
    // Partage
    shareModalTitle: 'Partager ce document',
    shareDuration: 'Durée de validité',
    hours24: '24h',
    days7: '7 jours',
    days30: '30 jours',
    never: 'Jamais',
    shareGenerated: 'Lien généré',
    shareOther: 'Autre durée',
    done: 'Terminé',
    shareExistingHeader: 'Liens existants pour ce document',
    nLinks: (n) => n + (n > 1 ? ' liens' : ' lien'),
    expiresShort: (d) => 'expire ' + d,
    noExpiry: 'sans expiration',
    createdShort: (d) => 'créé ' + d,
    revokeTitle: 'Revoquer',
    revoke: 'Révoquer',
    revokeConfirmTitle: 'Révoquer ce lien ?',
    revokeConfirmMsg:
      'Le lien arrêtera de fonctionner immédiatement. Cette action est irréversible.',
    expiresAt: (d) => 'Expire le ' + d,
    neverExpires: "N'expire jamais",
    shareBroken: '(lien cassé)',
    shareReactivate: 'Réactiver',
    shareReactivateTitle: 'Réactiver ce lien',
    shareReactivateMsg: (p) =>
      `Le document « ${p} » est introuvable (déplacé ou supprimé hors de l'app). Indique son nouveau chemin : le lien repartira sur la même URL.`,
    shareReactivatePlaceholder: 'dossier/document.md',
    // Paramètres (admin)
    settingsTitle: 'Paramètres',
    settingsTabUsers: 'Utilisateurs',
    settingsTabTokens: 'Tokens',
    settingsTabShares: 'Partages',
    settingsEmailLabel: 'Email',
    settingsRoleLabel: 'Rôle',
    settingsRoleViewer: 'Membre',
    settingsRoleAdmin: 'Admin',
    settingsPasswordLabel: 'Mot de passe',
    settingsPasswordPlaceholder: '8 car. min.',
    settingsEmailPlaceholder: 'utilisateur@exemple.com',
    settingsAddUser: 'Inviter',
    settingsInviteHint: 'L\'invité reçoit un lien et choisit lui-même son mot de passe.',
    settingsInviteOnce: 'Copiez le lien maintenant : il ne sera plus jamais affiché',
    settingsInviteLink: 'Lien d\'invitation',
    settingsInvitePending: 'En attente',
    settingsResendInvite: 'Renvoyer le lien',
    settingsResetPassword: 'Réinitialiser le mot de passe',
    settingsResetPasswordShort: 'Réinitialiser',
    settingsResetPasswordTitle: 'Réinitialiser le mot de passe',
    settingsResetPasswordFor: 'Nouveau mot de passe pour',
    settingsNewPasswordLabel: 'Nouveau mot de passe',
    settingsConfirmPasswordLabel: 'Confirmer le mot de passe',
    settingsConfirmPasswordPlaceholder: 'Saisir à nouveau',
    settingsPasswordRule: '8 caractères minimum.',
    settingsPasswordTooShort: 'Le mot de passe doit faire au moins 8 caractères.',
    settingsPasswordMismatch: 'Les deux mots de passe ne sont pas identiques.',
    settingsPasswordUpdated: 'Mot de passe mis à jour.',
    settingsUpdatePassword: 'Mettre à jour',
    settingsTogglePassword: 'Afficher / masquer le mot de passe',
    settingsDeleteUser: 'Supprimer',
    settingsDeleteUserTitle: 'Supprimer cet utilisateur ?',
    settingsDeleteUserMsg: (e) => `Le compte ${e} sera supprimé définitivement.`,
    settingsLastAdmin: 'Impossible de supprimer le dernier admin.',
    settingsUpdateAvailable:
      'Mise à jour disponible : version {latest} (vous avez {current}). Voir sur PyPI →',
    settingsNoUsers: 'Aucun utilisateur.',
    settingsTokenLabel: 'Libellé',
    settingsTokenLabelPlaceholder: 'claude, mcp-perso...',
    settingsCreateToken: 'Créer un token',
    settingsTokenOnce: 'Copiez-le maintenant : il ne sera plus jamais affiché',
    settingsTokenPlain: 'Token',
    settingsMcpUrl: 'URL connecteur MCP',
    settingsRevokeToken: 'Révoquer',
    settingsRevokeTokenTitle: 'Révoquer ce token ?',
    settingsRevokeTokenMsg: (l) => `Le token « ${l} » cessera de fonctionner immédiatement.`,
    settingsNoTokens: 'Aucun token API.',
    settingsTokenRevoked: 'révoqué',
    settingsSharesHint: 'Liens publics actifs vers des documents.',
    settingsNoShares: 'Aucun lien de partage actif.',
    settingsTabNodes: 'Nœuds',
    settingsNodesHint:
      'Publie un dossier ou un document en nœud : un autre atlas pourra s’y abonner en lecture seule via le lien.',
    settingsNodeName: 'Nom du nœud',
    settingsNodeNamePlaceholder: 'guide-equipe',
    settingsNodePath: 'Chemin (dossier ou .md/.html)',
    settingsNodePathPlaceholder: 'equipe/onboarding',
    settingsNodePublish: 'Publier',
    settingsNodeOnce: 'Copiez ce lien maintenant : il ne sera plus jamais affiché',
    settingsNodeLink: 'Lien du nœud',
    settingsNoNodes: 'Aucun nœud publié.',
    settingsNodeRelink: 'Nouveau lien',
    settingsNodeRelinkTitle: 'Régénérer le lien ?',
    settingsNodeRelinkMsg: (n) =>
      `Republier « ${n} » génère un nouveau lien ; l’ancien cessera de fonctionner.`,
    settingsRevokeNodeTitle: 'Révoquer ce nœud ?',
    settingsRevokeNodeMsg: (n) =>
      `Le nœud « ${n} » et son lien cesseront de fonctionner immédiatement. Les abonnés perdront l’accès.`,
    settingsNodesPublished: 'Mes nœuds publiés',
    settingsRemotesHeader: 'Abonnements',
    settingsRemotesHint: 'Colle le lien d’un nœud partagé pour le suivre en lecture seule.',
    settingsRemoteLink: 'Lien du nœud',
    settingsRemoteLinkPlaceholder: 'atlas-node:…',
    settingsRemoteAdd: 'S’abonner',
    settingsNoRemotes: 'Aucun abonnement.',
    settingsRemoteSynced: (d) => 'synchronisé ' + d,
    settingsRemoteNeverSynced: 'jamais synchronisé',
    settingsRemoteFrom: (h) => 'depuis ' + h,
    settingsRemoteError: (msg) => 'erreur : ' + msg,
    settingsRemoteSync: 'Synchroniser',
    settingsRemoteSyncFailed: (msg) =>
      `Synchronisation impossible (émetteur injoignable ?) : ${msg}`,
    settingsRemoteAppropriate: 'S’approprier',
    settingsRemoteAppropriateTitle: 'Copier ce nœud dans tes documents (copie éditable, détachée)',
    settingsRemoteAppropriatePrompt: (n) =>
      `S’approprier « ${n} » : destination dans tes documents ?`,
    settingsRemoteAppropriated: (c) =>
      `Copié (${c} fichier(s)). La copie est éditable dans tes documents.`,
    settingsRemoteRemove: 'Se désabonner',
    settingsRemoteRemoveTitle: 'Se désabonner ?',
    settingsRemoteRemoveMsg: (n) =>
      `Le miroir local de « ${n} » sera supprimé. Tu pourras te réabonner avec le lien.`,
    nodeAppropriateBtn: 'S’approprier',
    nodeAppropriateTitle: 'Copier ce nœud dans tes documents (copie éditable, détachée)',
    nodeAppropriateWholePrompt: (n) =>
      `S’approprier le nœud « ${n} » entier : destination dans tes documents ?`,
    nodeAppropriateFilePrompt: (f) => `S’approprier « ${f} » : destination dans tes documents ?`,
    nodeRemoveBtn: 'Retirer',
    nodeRemoveTitle: 'Se désabonner de ce nœud',
    settingsErrForbidden: 'Accès refusé : droits administrateur requis.',
    settingsErrConflict: 'Conflit : cette opération a été refusée.',
    settingsErrGeneric: 'Une erreur est survenue. Réessaie.',
    // Groupes (modèle B, principals group:<nom>)
    settingsTabGroups: 'Groupes',
    settingsGroupsHint: 'Crée des groupes pour partager des documents avec plusieurs personnes d’un coup.',
    settingsGroupNameLabel: 'Nom du groupe',
    settingsGroupMembersLabel: 'Membres (emails séparés par des virgules)',
    settingsGroupSave: 'Enregistrer le groupe',
    settingsNoGroups: 'Aucun groupe.',
    settingsGroupEmpty: 'aucun membre',
    settingsGroupEdit: 'Éditer',
    settingsGroupDelete: 'Supprimer',
    settingsGroupDeleteTitle: 'Supprimer le groupe ?',
    settingsGroupDeleteMsg: (name) => `Le groupe « ${name} » sera supprimé. Les partages qui le visent ne donneront plus accès.`,
    // Accès & partage par document (modèle B)
    aclBtn: 'Accès',
    aclBtnTitle: 'Gérer l’accès (privé / partagé)',
    aclModalTitle: 'Accès & partage',
    aclPrivate: 'Privé',
    aclCommons: 'Commun, visible par tous les comptes',
    aclOwner: 'propriétaire :',
    aclCreatedBy: 'créé par',
    comboCreate: (q) => 'Créer « ' + q + ' »',
    noResults: 'Aucun résultat',
    closeEsc: 'Fermer (Esc)',
    aclKindLabel: 'Type',
    aclLevelLabel: 'Niveau',
    aclValueLabel: 'Email ou groupe',
    aclYou: 'vous',
    aclNoGrants: 'Partagé avec personne.',
    aclEveryone: 'Tous les comptes',
    aclKindUser: 'Personne',
    aclKindGroup: 'Groupe',
    aclKindAll: 'Tout le monde',
    aclValuePlaceholder: 'email ou nom de groupe',
    aclLevelView: 'Lecture',
    aclLevelComment: 'Commentaire',
    aclLevelEdit: 'Édition',
    aclLinkPrincipal: 'Lien public',
    aclAdd: 'Ajouter',
    aclRemove: 'Retirer',
    aclMakePrivate: 'Rendre privé',
    aclMakeCommons: 'Mettre en commun',
    aclMakeCommonsConfirm: 'Remettre en commun supprime le propriétaire ET tous les partages de ce document. Continuer ?',
    aclSharedToast: 'Partage mis à jour',
    aclRevokedToast: 'Accès retiré',
    aclNowPrivateToast: 'Document rendu privé',
    aclNowCommonsToast: 'Document remis en commun',
    aclVisibilityHelp: 'Privé = vous seul (+ les accès ci-dessus). Commun = visible par toute l\'équipe.',
    visPrivate: 'Privé',
    visShared: 'Partagé',
    visGranted: 'Partagé avec vous',
    notFoundTitle: 'Document introuvable ou accès non autorisé',
    notFoundBody: 'Ce document n\'existe pas, ou vous n\'y avez pas accès.',
    notFoundHome: 'Retour à l\'accueil',
    titleLabel: 'Titre',
    bodyLabel: 'Corps',
    // Profil + Sécurité (nom, 2FA, sessions)
    settingsTabProfile: 'Profil',
    profileNameTitle: 'Votre nom',
    profileNameHint: "Affiché dans l'application.",
    profileFirstName: 'Prénom',
    profileLastName: 'Nom',
    profileSave: 'Enregistrer',
    profileSaved: 'Enregistré',
    securityTotpTitle: 'Authentification à deux facteurs',
    securityTotpHint: 'Ajoute un code à usage unique depuis ton application d’authentification.',
    securityTotpStatusOn: 'Actif',
    securityTotpStatusOff: 'Inactif',
    securityTotpEnable: 'Activer le 2FA',
    securityTotpDisable: 'Désactiver le 2FA',
    securitySessionsTitle: 'Sessions',
    securitySessionsHint:
      'Déconnecte tous les appareils où ce compte est connecté, y compris celui-ci.',
    securityLogoutAll: 'Déconnecter toutes mes sessions',
    securityLogoutAllConfirmTitle: 'Déconnecter toutes les sessions ?',
    securityLogoutAllConfirmMsg:
      'Tu seras déconnecté ici et sur tous tes autres appareils. Tu devras te reconnecter.',
    securityLogoutAllConfirm: 'Tout déconnecter',
    // Modale 2FA
    totpModalTitle: 'Activer le 2FA',
    totpModalDisableTitle: 'Désactiver le 2FA',
    totpScanHint:
      'Scanne ce QR code avec ton application d’authentification, ou ajoute la clé manuellement.',
    totpSecretLabel: 'Clé secrète',
    totpVerifyLabel: 'Code de vérification',
    totpConfirmEnable: 'Confirmer et activer',
    totpInvalidCode: 'Code invalide. Vérifie l’heure de ton téléphone et réessaie.',
    totpRecoveryWarn:
      'Conserve ces codes de secours en lieu sûr. Ils ne seront plus jamais affichés et chacun ne fonctionne qu’une fois.',
    totpRecoveryCopy: 'Copier les codes',
    totpEnabledToast: '2FA activé.',
    totpDisabledToast: '2FA désactivé.',
    totpDisableHint:
      'Saisis un code de ton application (ou un code de secours) pour désactiver le 2FA.',
    totpConfirmDisable: 'Désactiver',
    totpCodeRequired: 'Saisis un code.',
    securityLoggedOutAll: 'Toutes les sessions ont été déconnectées.',
    // Capture rapide
    quickCaptureTitle: 'Capture rapide',
    quickCaptureHint: 'Crée une note dans',
    titlePlaceholder: 'Titre',
    qcBodyPlaceholder: '(optionnel) corps de la note',
    noteSaved: 'Note enregistree dans inbox/',
    // Renommage de dossier
    currentFolder: 'Dossier actuel :',
    newNameLabel: 'Nouveau nom',
    dirRenameNote: 'Tous les fichiers du dossier seront déplacés automatiquement.',
    folderRenamed: 'Dossier renomme',
    // Barre d'outils markdown
    tbBold: 'Gras (Ctrl+B)',
    tbItalic: 'Italique (Ctrl+I)',
    tbStrike: 'Barré',
    tbUl: 'Liste à puces',
    tbUlLabel: '• Liste',
    tbOl: 'Liste numérotée',
    tbOlLabel: '1. Liste',
    tbTodo: 'Case à cocher',
    tbQuote: 'Citation',
    tbQuoteLabel: '&ldquo; Citation',
    tbLink: 'Lien (Ctrl+L)',
    tbLinkLabel: '🔗 Lien',
    tbCode: 'Code inline',
    tbCodeblock: 'Bloc de code',
    tbCodeblockLabel: '{ } Bloc',
    tbTable: 'Tableau',
    tbHr: 'Séparateur',
    phText: 'texte',
    phLabel: 'libellé',
  },
  en: {
    // Generic
    cancel: 'Cancel',
    confirm: 'Confirm',
    ok: 'OK',
    errorTitle: 'Error',
    offlineTitle: 'Offline mode',
    offlineDisabled: 'This feature is disabled.',
    save: 'Save',
    close: 'Close',
    del: 'Delete',
    copy: 'Copy',
    copied: 'Copied',
    copiedBang: 'Copied!',
    validate: 'Confirm',
    create: 'Create',
    err: (m) => 'Error: ' + m,
    errSp: (m) => 'Error: ' + m,
    nameRequired: 'Name required',
    titleRequired: 'Title required',
    noSlashes: 'No / or \\ in the name',
    // Relative dates
    justNow: 'just now',
    minAgo: (n) => `${n} min ago`,
    hoursAgo: (n) => `${n} h ago`,
    daysAgo: (n) => `${n} d ago`,
    // Sidebar / tree
    homeTitle: 'Home',
    collapseSidebar: 'Collapse (Ctrl+B)',
    showSidebar: 'Show sidebar (Ctrl+B)',
    searchPlaceholder: 'Search…',
    graphBtnTitle: 'The Mind (Ctrl+G)',
    expandAllFolders: 'Expand / collapse all',
    newDocTitle: 'New document (N)',
    pinnedHeader: 'Pinned',
    recentHeader: 'Recent',
    sharedHeader: 'Shared with you',
    treeContentHeader: 'Content',
    signedInAs: 'Signed in as',
    logoutTitle: 'Log out',
    logoutLabel: 'Logout',
    statsLine: (md, other) => `${md} markdown / ${other} other`,
    renameFolder: 'Rename folder',
    renameFile: 'Rename file',
    treeRemoteBadge: 'linked',
    remotesLabel: 'Mental nodes',
    shareAsNode: 'Share as node',
    notesBadge: (n) => n + ' note(s)',
    // Document action bar
    pin: 'Pin',
    unpin: 'Unpin',
    downloadTitle: 'Download the file',
    downloadBtn: 'Download',
    moreActions: 'More actions',
    menuRename: 'Rename',
    menuMove: 'Move…',
    shareTitle: 'Generate a public share link',
    shareBtn: 'Share',
    editBtn: 'Edit',
    saveBtn: 'Save',
    saving: 'Saving…',
    modifiedAgo: (d) => 'modified ' + d,
    sharedByLabel: (n) => '· shared by ' + n,
    readingTime: (min, words) => `${min} min · ${words} words`,
    // Content / rendering
    loadingDoc: 'Loading document',
    loadError: (m) => 'Load error: ' + m,
    offlineMissing: 'content missing from the offline build',
    brokenLink: (tgt) => 'Document not found: ' + tgt,
    htmlDocBanner:
      'HTML document · isolated rendering (click inside the frame for keyboard navigation)',
    demoBannerTitle: 'Read-only demo',
    demoBannerText: 'Editing, accounts, sharing & collaboration, version history, your AI (MCP/API) and Hive sync all need your own instance.',
    demoBannerCta: 'Get your own ↗',
    pdfDocBanner: 'PDF document · preview',
    pdfOfflineHint: 'PDF preview unavailable offline:',
    docxError: (e) => `Can't display this Word document (${e}). Download:`,
    openFullscreen: 'Open full screen ↗',
    cantLoadDoc: (m) => 'Could not load the document: ' + m,
    fileModeNoEdit: 'Editing unavailable in offline mode',
    // Tags
    folderTagTitle: 'Folder tag (always present)',
    removeTag: 'Remove',
    addTag: 'Add a tag',
    tagSaveFailed: (m) => 'Failed to save the tag: ' + m,
    tagEditorTitle: 'Custom tags',
    tagPlaceholder: 'new tag…',
    tagEditorHint: 'Enter to add · folder tags always remain',
    noCustomTags: 'No custom tags.',
    docsWithTag: (n) => n + ' document' + (n > 1 ? 's' : '') + ' with this tag.',
    // Side panel (outline / links / notes)
    tocHeader: 'On this doc',
    hideToc: 'Hide (Ctrl+J)',
    showToc: 'Show the outline (Ctrl+J)',
    linksTitle: 'Links',
    historyTitle: 'Document history',
    historyLabel: 'History',
    historyHeader: 'History',
    historyClose: 'Close (Esc)',
    historyPick: 'Pick a revision on the left.',
    historyEmpty: 'No history for this document.',
    historyAiOnly: 'AI writes',
    historyNoAi: 'No AI writes on this document.',
    digestWeek: 'This week',
    digestDocs: (n) => 'doc' + (n > 1 ? 's' : ''),
    digestCreated: () => 'new',
    digestChecked: (n) => 'task' + (n > 1 ? 's' : ''),
    digestContributors: () => 'people',
    digestViaAi: () => 'AI',
    actTitle: 'Activity',
    actJournal: 'Journal',
    actConstellation: 'Constellation',
    actHealth: 'Health',
    actAiOnly: 'AI only',
    actSeeAll: 'See all →',
    actCollapse: 'Collapse ↑',
    actSeeAllN: (n) => `See all (${n}) →`,
    actSeeChanges: 'View changes',
    actEmptyAi: 'No recent AI writes.',
    actEmpty: 'No recent activity.',
    actInbox: 'Inbox',
    inboxKeep: 'Keep',
    inboxTrash: 'Trash',
    inboxSnooze: 'Snooze',
    inboxZero: 'Inbox empty, nothing to triage 👌',
    inboxConfHigh: 'high confidence',
    inboxConfMed: 'medium confidence',
    inboxConfLow: 'low confidence',
    inboxNext: 'Next',
    inboxFileUnder: 'file under',
    inboxChooseFolder: 'choose a folder',
    inboxPickFolderFirst: 'pick a folder first',
    inboxPickOrType: 'pick or type a folder',
    inboxNewTag: 'new tag',
    inboxSameSubject: 'Same subject as a filed doc:',
    inboxDone: 'done',
    inboxUpNext: 'Up next',
    inboxNew: (n) => (n === 1 ? '1 new item' : n + ' new items'),
    inboxZeroTitle: 'Inbox',
    inboxZeroSub: 'Your agents do the research for you. You just kept what matters.',
    inboxKept: 'kept → graph',
    inboxTrashed: 'trashed',
    inboxSnoozed: 'snoozed',
    relJustNow: 'just now',
    relYesterday: 'yesterday',
    relDaysAgo: (d) => d + 'd ago',
    healthTabStale: 'Obsolescence',
    healthTabCont: 'Contradictions',
    healthNoStale: 'Nothing stale 👌',
    healthMonthsAgo: (n) => `${n} month${n > 1 ? 's' : ''} ago`,
    healthOpenHist: 'Open history',
    healthValueConflict: (s, a, b) => (s ? s + ': ' : '') + a + ' vs ' + b,
    healthConfHigh: 'value ≠',
    healthConfHighHint: 'Two docs give a different value for the same table row. Strong signal.',
    healthReview: 'to check',
    healthReviewHint: 'Same subject. A lead to read and judge, nothing is asserted.',
    healthNoCand: 'No contradiction detected 👌. Ask the AI to scan related docs.',
    healthAskAi: 'Diverging values and confirmed contradictions. Ask the AI to find more in related docs.',
    healthReal: 'contradiction',
    healthDismiss: 'not a contradiction',
    healthDismissHint: 'Mark this pair as non-contradictory (it resurfaces if either doc is edited).',
    historyError: 'Couldn’t load the history.',
    historyNoChange: 'No change in this revision.',
    historyViewVersion: 'View this version',
    historyViewChanges: 'View changes',
    historyRestore: 'Restore this version',
    historyRestoreBtn: 'Restore',
    historyRestoreConfirm:
      'It will replace the document’s current content. Nothing is lost: the current version stays in the history, you can come back to it.',
    historyRestored: 'Version restored.',
    historyRestoreError: 'Restore failed.',
    referencedBy: (n) => `← Referenced by (${n})`,
    outgoingLinks: (n) => `→ Outgoing (${n})`,
    sameTopic: (n) => `~ Same topic (${n})`,
    // Annotations
    noteBtn: 'Note',
    sanitizerMissing:
      'Sanitizer not found: rendering blocked (never unsanitized HTML). Check /vendor/purify.min.js and the build.',
    appropriateDestPlaceholder: 'folder/copy',
    notesTitle: (n) => `Notes (${n})`,
    copyAllNotes: 'Copy all notes',
    notesCopied: (n) => `${n} note${n > 1 ? 's' : ''} copied to clipboard`,
    orphanShort: '⚠ passage not found',
    orphanLong: (q) => '⚠ Passage not found (text changed): “' + q + '”',
    notePlaceholder: 'Your note on this passage…',
    noteSaveFailed: (m) => 'Failed to save the note: ' + m,
    actionFailed: (m) => 'Failed: ' + m,
    deleteNoteTitle: 'Delete this note?',
    deleteNoteMsg: (txt) => 'The annotation “' + txt + '” will be permanently deleted.',
    // Search
    searching: 'Searching…',
    noResults: (q) => `No results for "${q}"`,
    nResults: (n) => n + ' result' + (n === 1 ? '' : 's'),
    cappedSuffix: ' (50 shown)',
    paletteResultsCapped: (n) => n + ' results (30 shown)',
    cdnFailMiniSearch: 'Could not load MiniSearch',
    // Home
    heatNone: 'No changes',
    heatCount: (n) => n + ' change' + (n > 1 ? 's' : ''),
    statDocs: 'Documents',
    statDocsSub: 'markdown',
    statWords: 'Total words',
    statWordsSub: (n) => `~${n} min read`,
    statWeek: 'This week',
    statWeekSub: 'docs modified (vs previous)',
    statTodoSub: 'done / total',
    activityTitle: 'Activity (rolling year)',
    lessLabel: 'less',
    moreLabel: 'more',
    favorites: 'Favorites',
    noFavorites: 'No favorites. Pin a doc with the favorite button in its bar.',
    graphLabel: 'The Mind',
    noTags: 'No tags.',
    recentlyModified: 'Recently modified',
    noRecentDocs: 'No recent documents.',
    categories: 'Categories',
    longestDocs: 'Longest documents',
    hintPalette: 'palette',
    hintSearch: 'search',
    hintSidebar: 'sidebar',
    hintToc: 'outline',
    hintEdit: 'edit',
    hintNewTodo: 'new todo',
    rootLabel: 'root',
    // Command palette
    actHome: 'Home',
    actHomeHint: 'Overview',
    actSidebar: 'Collapse / expand the sidebar',
    actToc: 'Hide / show the outline',
    actEdit: 'Edit the current document',
    actDownload: 'Download the current document',
    actSearch: 'Focus search',
    actGraph: 'The Mind (overview)',
    actReload: 'Reload the page',
    palettePlaceholder: 'Search a file or an action…',
    paletteNavigate: 'navigate',
    paletteOpen: 'open',
    // Graph
    graphTitle: 'The Mind',
    mindSubtitle: 'your mind palace, the one your AI walks with you',
    graphHint: 'wheel: zoom · drag: pan · click: open',
    graphModeOrganic: 'Brain',
    graphModeStructured: 'Cells',
    graphTagsToggle: 'Show / hide tags',
    closeEsc: 'Close (Esc)',
    graphStats: (docs, links, tags) => docs + ' docs · ' + links + ' links, ' + tags + ' tags',
    tasksBtnTitle: 'Tasks',
    tasksTitle: 'Tasks',
    tasksShowDone: 'Show completed',
    tasksEmpty: 'Nothing to do 🎉',
    tasksLoading: 'Loading tasks',
    tasksStats: (open, total) => open + ' to do · ' + total + ' total',
    nDocs: (n) => n + ' doc' + (n > 1 ? 's' : ''),
    // To-do widget
    nPending: (n) => `${n} to do`,
    addTodoIn: (label) => 'Add to ' + label + '…',
    todoAddPlaceholder: 'Add a task…',
    enterKey: 'Enter',
    showDone: (n) => `Show done (${n})`,
    hideDone: (n) => `Hide done (${n})`,
    clearDoneTitle: 'Delete all completed tasks',
    clearDoneBtn: 'Clear done',
    noTasksIn: (label) => `No tasks in ${label}. Add one.`,
    allDone: (done) => `All done ${done > 0 ? `(${done} hidden)` : ''}`,
    updated: 'Updated',
    synced: 'Synced',
    offlinePrefix: (m) => 'Offline: ' + m,
    fileModeTodoStatus: 'Unavailable in offline mode',
    adding: 'Adding…',
    added: 'Added',
    doneStatus: 'Done',
    reopened: 'Reopened',
    deletedStatus: 'Deleted',
    clearDoneConfirmTitle: (n) => `Clear ${n} completed task${n > 1 ? 's' : ''}?`,
    clearDoneConfirmMsg: 'Checked tasks will be permanently deleted.',
    clearBtn: 'Clear',
    clearing: 'Clearing…',
    nCleared: (n) => `${n} deleted`,
    serverRequired: 'Server required',
    fileModeTodosHtml: 'To-dos are unavailable in offline mode',
    // Document modals (rename / move / delete / new)
    renameDocTitle: 'Rename the document',
    moveDocTitle: 'Move the document',
    folderLabel: 'Folder',
    dirPlaceholder: 'e.g. notes/projects',
    filenameLabel: 'File name',
    filenamePlaceholder: 'file-name',
    fileExistsAt: 'A file already exists at this location',
    docMoved: 'Document moved',
    docRenamed: 'Document renamed',
    deleteDocTitle: 'Delete this document?',
    deleteDocMsg: (path) =>
      'The file "' + path + '" will be permanently deleted (a Git commit keeps the history).',
    docDeleted: 'Document deleted',
    newDocHeader: 'New document',
    templateLabel: 'Template',
    visibilityLabel: 'Visibility',
    visibilityPrivate: 'Private, only me',
    visibilityCommons: 'Common, whole team',
    tplBlank: 'Blank',
    docNamePlaceholder: 'my-document',
    fileExists: 'File already exists',
    docCreated: 'Document created',
    // Sharing
    shareModalTitle: 'Share this document',
    shareDuration: 'Validity period',
    hours24: '24h',
    days7: '7 days',
    days30: '30 days',
    never: 'Never',
    shareGenerated: 'Generated link',
    shareOther: 'Another duration',
    done: 'Done',
    shareExistingHeader: 'Existing links for this document',
    nLinks: (n) => n + (n > 1 ? ' links' : ' link'),
    expiresShort: (d) => 'expires ' + d,
    noExpiry: 'no expiry',
    createdShort: (d) => 'created ' + d,
    revokeTitle: 'Revoke',
    revoke: 'Revoke',
    revokeConfirmTitle: 'Revoke this link?',
    revokeConfirmMsg: 'The link will stop working immediately. This action is irreversible.',
    expiresAt: (d) => 'Expires on ' + d,
    neverExpires: 'Never expires',
    shareBroken: '(broken link)',
    shareReactivate: 'Reactivate',
    shareReactivateTitle: 'Reactivate this link',
    shareReactivateMsg: (p) =>
      `The document "${p}" is missing (moved or deleted outside the app). Enter its new path: the link will resume on the same URL.`,
    shareReactivatePlaceholder: 'folder/document.md',
    // Settings (admin)
    settingsTitle: 'Settings',
    settingsTabUsers: 'Users',
    settingsTabTokens: 'Tokens',
    settingsTabShares: 'Shares',
    settingsEmailLabel: 'Email',
    settingsRoleLabel: 'Role',
    settingsRoleViewer: 'Member',
    settingsRoleAdmin: 'Admin',
    settingsPasswordLabel: 'Password',
    settingsPasswordPlaceholder: '8 chars min.',
    settingsEmailPlaceholder: 'user@example.com',
    settingsAddUser: 'Invite',
    settingsInviteHint: 'The invitee gets a link and sets their own password.',
    settingsInviteOnce: 'Copy the link now, it will never be shown again',
    settingsInviteLink: 'Invitation link',
    settingsInvitePending: 'Pending',
    settingsResendInvite: 'Resend link',
    settingsResetPassword: 'Reset password',
    settingsResetPasswordShort: 'Reset',
    settingsResetPasswordTitle: 'Reset password',
    settingsResetPasswordFor: 'New password for',
    settingsNewPasswordLabel: 'New password',
    settingsConfirmPasswordLabel: 'Confirm password',
    settingsConfirmPasswordPlaceholder: 'Type it again',
    settingsPasswordRule: '8 characters minimum.',
    settingsPasswordTooShort: 'Password must be at least 8 characters.',
    settingsPasswordMismatch: 'The two passwords do not match.',
    settingsPasswordUpdated: 'Password updated.',
    settingsUpdatePassword: 'Update',
    settingsTogglePassword: 'Show / hide password',
    settingsDeleteUser: 'Delete',
    settingsDeleteUserTitle: 'Delete this user?',
    settingsDeleteUserMsg: (e) => `The account ${e} will be permanently deleted.`,
    settingsLastAdmin: 'Cannot delete the last admin.',
    settingsUpdateAvailable:
      'Update available: version {latest} (you have {current}). View on PyPI →',
    settingsNoUsers: 'No users.',
    settingsTokenLabel: 'Label',
    settingsTokenLabelPlaceholder: 'claude, my-mcp...',
    settingsCreateToken: 'Create token',
    settingsTokenOnce: 'Copy it now: it will never be shown again',
    settingsTokenPlain: 'Token',
    settingsMcpUrl: 'MCP connector URL',
    settingsRevokeToken: 'Revoke',
    settingsRevokeTokenTitle: 'Revoke this token?',
    settingsRevokeTokenMsg: (l) => `The token "${l}" will stop working immediately.`,
    settingsNoTokens: 'No API tokens.',
    settingsTokenRevoked: 'revoked',
    settingsSharesHint: 'Active public links to documents.',
    settingsNoShares: 'No active share links.',
    settingsTabNodes: 'Nodes',
    settingsNodesHint:
      'Publish a folder or a document as a node: another atlas can subscribe to it read-only via the link.',
    settingsNodeName: 'Node name',
    settingsNodeNamePlaceholder: 'team-guide',
    settingsNodePath: 'Path (folder or .md/.html)',
    settingsNodePathPlaceholder: 'team/onboarding',
    settingsNodePublish: 'Publish',
    settingsNodeOnce: 'Copy this link now: it will never be shown again',
    settingsNodeLink: 'Node link',
    settingsNoNodes: 'No published nodes.',
    settingsNodeRelink: 'New link',
    settingsNodeRelinkTitle: 'Regenerate link?',
    settingsNodeRelinkMsg: (n) =>
      `Re-publishing "${n}" generates a new link; the old one will stop working.`,
    settingsRevokeNodeTitle: 'Revoke this node?',
    settingsRevokeNodeMsg: (n) =>
      `Node "${n}" and its link will stop working immediately. Subscribers will lose access.`,
    settingsNodesPublished: 'My published nodes',
    settingsRemotesHeader: 'Subscriptions',
    settingsRemotesHint: 'Paste a shared node link to follow it read-only.',
    settingsRemoteLink: 'Node link',
    settingsRemoteLinkPlaceholder: 'atlas-node:…',
    settingsRemoteAdd: 'Subscribe',
    settingsNoRemotes: 'No subscriptions.',
    settingsRemoteSynced: (d) => 'synced ' + d,
    settingsRemoteNeverSynced: 'never synced',
    settingsRemoteFrom: (h) => 'from ' + h,
    settingsRemoteError: (msg) => 'error: ' + msg,
    settingsRemoteSync: 'Sync',
    settingsRemoteSyncFailed: (msg) => `Sync failed (publisher unreachable?): ${msg}`,
    settingsRemoteAppropriate: 'Make mine',
    settingsRemoteAppropriateTitle: 'Copy this node into your documents (editable, detached copy)',
    settingsRemoteAppropriatePrompt: (n) => `Make "${n}" yours: destination in your documents?`,
    settingsRemoteAppropriated: (c) =>
      `Copied (${c} file(s)). The copy is editable in your documents.`,
    settingsRemoteRemove: 'Unsubscribe',
    settingsRemoteRemoveTitle: 'Unsubscribe?',
    settingsRemoteRemoveMsg: (n) =>
      `The local mirror of "${n}" will be deleted. You can re-subscribe with the link.`,
    nodeAppropriateBtn: 'Make mine',
    nodeAppropriateTitle: 'Copy this node into your documents (editable, detached copy)',
    nodeAppropriateWholePrompt: (n) =>
      `Make the whole node "${n}" yours: destination in your documents?`,
    nodeAppropriateFilePrompt: (f) => `Make "${f}" yours: destination in your documents?`,
    nodeRemoveBtn: 'Remove',
    nodeRemoveTitle: 'Unsubscribe from this node',
    settingsErrForbidden: 'Access denied: administrator rights required.',
    settingsErrConflict: 'Conflict: this operation was refused.',
    settingsErrGeneric: 'Something went wrong. Try again.',
    // Groups (model B, principals group:<name>)
    settingsTabGroups: 'Groups',
    settingsGroupsHint: 'Create groups to share documents with several people at once.',
    settingsGroupNameLabel: 'Group name',
    settingsGroupMembersLabel: 'Members (comma-separated emails)',
    settingsGroupSave: 'Save group',
    settingsNoGroups: 'No groups yet.',
    settingsGroupEmpty: 'no members',
    settingsGroupEdit: 'Edit',
    settingsGroupDelete: 'Delete',
    settingsGroupDeleteTitle: 'Delete group?',
    settingsGroupDeleteMsg: (name) => `Group "${name}" will be deleted. Shares targeting it will no longer grant access.`,
    // Per-document access & sharing (model B)
    aclBtn: 'Access',
    aclBtnTitle: 'Manage access (private / shared)',
    aclModalTitle: 'Access & sharing',
    aclPrivate: 'Private',
    aclCommons: 'Common, visible to all accounts',
    aclOwner: 'owner:',
    aclCreatedBy: 'created by',
    comboCreate: (q) => 'Create "' + q + '"',
    noResults: 'No results',
    closeEsc: 'Close (Esc)',
    aclKindLabel: 'Type',
    aclLevelLabel: 'Level',
    aclValueLabel: 'Email or group',
    aclYou: 'you',
    aclNoGrants: 'Not shared with anyone.',
    aclEveryone: 'Everyone (authenticated)',
    aclKindUser: 'Person',
    aclKindGroup: 'Group',
    aclKindAll: 'Everyone',
    aclValuePlaceholder: 'email or group name',
    aclLevelView: 'View',
    aclLevelComment: 'Comment',
    aclLevelEdit: 'Edit',
    aclLinkPrincipal: 'Public link',
    aclAdd: 'Add',
    aclRemove: 'Remove',
    aclMakePrivate: 'Make private',
    aclMakeCommons: 'Make common',
    aclMakeCommonsConfirm: 'Moving to the commons removes the owner AND every share of this document. Continue?',
    aclSharedToast: 'Sharing updated',
    aclRevokedToast: 'Access removed',
    aclNowPrivateToast: 'Document made private',
    aclNowCommonsToast: 'Document moved to the commons',
    aclVisibilityHelp: 'Private = only you (+ the access above). Common = visible to the whole team.',
    visPrivate: 'Private',
    visShared: 'Shared',
    visGranted: 'Shared with you',
    notFoundTitle: 'Document not found or access denied',
    notFoundBody: 'This document doesn\'t exist, or you don\'t have access to it.',
    notFoundHome: 'Back home',
    titleLabel: 'Title',
    bodyLabel: 'Body',
    // Profile + Security (name, 2FA, sessions)
    settingsTabProfile: 'Profile',
    profileNameTitle: 'Your name',
    profileNameHint: 'Shown across the app.',
    profileFirstName: 'First name',
    profileLastName: 'Last name',
    profileSave: 'Save',
    profileSaved: 'Saved',
    securityTotpTitle: 'Two-factor authentication',
    securityTotpHint: 'Add a one-time code from your authenticator app.',
    securityTotpStatusOn: 'On',
    securityTotpStatusOff: 'Off',
    securityTotpEnable: 'Enable 2FA',
    securityTotpDisable: 'Disable 2FA',
    securitySessionsTitle: 'Sessions',
    securitySessionsHint:
      'Sign out every device where this account is signed in, including this one.',
    securityLogoutAll: 'Sign out all my sessions',
    securityLogoutAllConfirmTitle: 'Sign out all sessions?',
    securityLogoutAllConfirmMsg:
      'You will be signed out here and on all your other devices. You will need to sign in again.',
    securityLogoutAllConfirm: 'Sign out everywhere',
    // 2FA modal
    totpModalTitle: 'Enable 2FA',
    totpModalDisableTitle: 'Disable 2FA',
    totpScanHint: 'Scan this QR code with your authenticator app, or add the key manually.',
    totpSecretLabel: 'Secret key',
    totpVerifyLabel: 'Verification code',
    totpConfirmEnable: 'Confirm and enable',
    totpInvalidCode: 'Invalid code. Check your phone’s clock and try again.',
    totpRecoveryWarn:
      'Keep these recovery codes somewhere safe. They will never be shown again and each one works only once.',
    totpRecoveryCopy: 'Copy codes',
    totpEnabledToast: '2FA enabled.',
    totpDisabledToast: '2FA disabled.',
    totpDisableHint: 'Enter a code from your app (or a recovery code) to disable 2FA.',
    totpConfirmDisable: 'Disable',
    totpCodeRequired: 'Enter a code.',
    securityLoggedOutAll: 'All sessions have been signed out.',
    // Quick capture
    quickCaptureTitle: 'Quick capture',
    quickCaptureHint: 'Creates a note in',
    titlePlaceholder: 'Title',
    qcBodyPlaceholder: '(optional) note body',
    noteSaved: 'Note saved to inbox/',
    // Folder rename
    currentFolder: 'Current folder:',
    newNameLabel: 'New name',
    dirRenameNote: 'All files in the folder will be moved automatically.',
    folderRenamed: 'Folder renamed',
    // Markdown toolbar
    tbBold: 'Bold (Ctrl+B)',
    tbItalic: 'Italic (Ctrl+I)',
    tbStrike: 'Strikethrough',
    tbUl: 'Bullet list',
    tbUlLabel: '• List',
    tbOl: 'Numbered list',
    tbOlLabel: '1. List',
    tbTodo: 'Checkbox',
    tbQuote: 'Quote',
    tbQuoteLabel: '&ldquo; Quote',
    tbLink: 'Link (Ctrl+L)',
    tbLinkLabel: '🔗 Link',
    tbCode: 'Inline code',
    tbCodeblock: 'Code block',
    tbCodeblockLabel: '{ } Block',
    tbTable: 'Table',
    tbHr: 'Divider',
    phText: 'text',
    phLabel: 'label',
  },
};

function t(key, ...args) {
  const dict = STRINGS[LANG] || STRINGS.fr;
  let entry = dict[key];

  if (entry === undefined) entry = STRINGS.fr[key];

  if (entry === undefined) return key;

  return typeof entry === 'function' ? entry(...args) : entry;
}

// Static HTML labels via data-i18n / -title / -placeholder. Single source of
// truth = STRINGS; the FR text in the markup is only a fallback when JS is off.
function applyStaticI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
}

applyStaticI18n();

const treeEl = document.getElementById('tree');
const contentEl = document.getElementById('content');
const breadcrumbPath = document.getElementById('breadcrumb-path');
const breadcrumbDate = document.getElementById('breadcrumb-date');
const breadcrumbActions = document.getElementById('breadcrumb-actions');
const btnEdit = document.getElementById('btn-edit');
const btnSave = document.getElementById('btn-save');
const btnCancel = document.getElementById('btn-cancel');
const searchEl = document.getElementById('search');
const searchResultsEl = document.getElementById('search-results');
const recentSection = document.getElementById('recent-section');
const recentList = document.getElementById('recent-list');
const sharedSection = document.getElementById('shared-section');
const sharedList = document.getElementById('shared-list');
const statsEl = document.getElementById('stats');
const tocPanel = document.getElementById('toc-panel');
const tocList = document.getElementById('toc-list');
const tocLinks = document.getElementById('toc-links');
const tocNotes = document.getElementById('toc-notes');
// The right panel shows up if it has a table of contents OR links OR notes.
// renderBacklinksFor / renderNotesFor update these flags then call applyToc().
let tocHasLinks = false;
let tocHasNotes = false;

let currentFile = null;
let editMode = false;
let editTextarea = null;

function relativeDate(epoch) {
  if (!epoch) return '';
  const diff = Date.now() / 1000 - epoch;

  if (diff < 60) return t('justNow');

  if (diff < 3600) return t('minAgo', Math.floor(diff / 60));

  if (diff < 86400) return t('hoursAgo', Math.floor(diff / 3600));

  if (diff < 86400 * 7) return t('daysAgo', Math.floor(diff / 86400));

  return new Date(epoch * 1000).toLocaleDateString(LANG, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function slugify(s) {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

let mdCount = 0,
  otherCount = 0;
const fileMap = {};

function index(node) {
  for (const c of node.children || []) {
    if (c.type === 'file') {
      fileMap[c.path] = c;

      if (c.ext === '.md') mdCount++;
      else otherCount++;
    } else index(c);
  }
}

// Offline build only: index the baked FULL tree into fileMap. In SERVER mode that
// baked tree is the owner's complete build-time view, so indexing it here would
// leak private doc names + the total count through every fileMap consumer (Recent,
// search, the Mind, stats) BEFORE softReload() swaps in the per-account filtered
// /api/tree. Gated on IS_OFFLINE_BUILD, NOT the protocol: a static offline build is
// served over https on GitHub Pages, so a file:// check would wrongly skip it.
if (IS_OFFLINE_BUILD) {
  index(TREE);
}
statsEl.textContent = t('statsLine', mdCount, otherCount);

// ─── Content loader (lazy fetch in online mode, embed in offline mode) ────────

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

const contentCache = new Map();

async function loadContent(file) {
  if (file.content != null) return file.content;

  if (contentCache.has(file.path)) {
    file.content = contentCache.get(file.path);

    return file.content;
  }

  if (IS_OFFLINE_BUILD) {
    const c = EMBED_CONTENT[file.path];

    if (c == null) throw new Error(t('offlineMissing'));
    contentCache.set(file.path, c);
    file.content = c;

    return c;
  }

  // Versioned by mtime for cache busting.
  const url =
    '/' +
    file.path.split('/').map(encodeURIComponent).join('/') +
    (file.mtime ? '?v=' + file.mtime : '');
  const res = await fetch(url);

  if (!res.ok) throw new Error('HTTP ' + res.status);
  const text = await res.text();

  contentCache.set(file.path, text);
  file.content = text;

  return text;
}

// Shared between todo widget and showWelcome; declared early to avoid TDZ.
let todos = [];
// Notes index {path: count} for tree badges. Declared early: decorateTreeBadges()
// runs at top-level right after the tree renders, before the annotations section
// (otherwise TDZ → ReferenceError, badges missing on first render).
let notesIndex = null;

const ICONS = {
  '.md':
    '<svg class="w-4 h-4 text-sky-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>',
  '.pdf':
    '<svg class="w-4 h-4 text-rose-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>',
  '.pptx':
    '<svg class="w-4 h-4 text-orange-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"/></svg>',
  '.html':
    '<svg class="w-4 h-4 text-purple-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/></svg>',
  '.docx':
    '<svg class="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>',
};
const FOLDER_ICON =
  '<svg class="w-4 h-4 text-[#fbc678] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/></svg>';
// « Mental nodes » umbrella icon: teal network node, distinct from the yellow folder.
const REMOTE_FOLDER_ICON =
  '<svg class="w-4 h-4 text-[#59d0cf] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.933-2.185 2.25 2.25 0 0 0-3.933 2.185Z"/></svg>';
// « Share as node » icon (Heroicons link) shown on hover over folders/docs.
const LINK_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="w-3.5 h-3.5"><path stroke-linecap="round" stroke-linejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244"/></svg>';
// « Rename » icon (Heroicons pencil).
const PENCIL_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="w-3.5 h-3.5"><path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.862 4.487Z"/></svg>';
const FILE_ICON =
  '<svg class="w-4 h-4 text-ink-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>';

function iconFor(ext) {
  return ICONS[ext] || FILE_ICON;
}

function renderTree(node, depth = 0, prefix = '') {
  const ul = document.createElement('ul');

  ul.className =
    depth === 0 ? 'space-y-0.5' : 'ml-3 border-l border-navy-600 pl-2 space-y-0.5 mt-0.5';

  // At the root, the « Nœuds mentaux » (remotes/) umbrella is pushed to the very
  // bottom and visually fenced off (cf. .tree-section--remotes): it holds mirrors
  // of OTHER atlases, not your own content, so it shouldn't sit amid your folders.
  let children = node.children || [];

  if (depth === 0) {
    const own = [],
      remotes = [];

    for (const c of children) {
      (c.type === 'dir' && c.name === 'remotes' ? remotes : own).push(c);
    }
    children = own.concat(remotes);
  }

  for (const child of children) {
    const li = document.createElement('li');

    if (child.type === 'dir') {
      const childPath = prefix ? prefix + '/' + child.name : child.name;
      // remotes/ = mirrors of remote nodes: read-only (rename hidden by .tree-remote CSS).
      const isRemoteRoot = childPath === 'remotes';
      if (isRemoteRoot) li.className = 'tree-section--remotes';
      const isRemote = isRemoteRoot || childPath.startsWith('remotes/');
      const btn = document.createElement('button');

      btn.className =
        'tree-item group w-full text-left px-2 py-1.5 rounded flex items-center gap-2 font-semibold text-ink-100' +
        (isRemote ? ' tree-remote' : '');
      btn.dataset.dirPath = childPath;
      // remotes/ umbrella → label « Mental nodes »; children keep their name
      // and get their origin via decorateRemoteOrigins().
      const dirLabel = isRemoteRoot ? t('remotesLabel') : child.name;
      // « Share as node » on hover, not on mirrors (don't re-publish another atlas's content).
      const dirShareBtn = isRemote
        ? ''
        : `<span class="dir-share-btn tree-action-btn tree-action-btn--share" title="${t('shareAsNode')}">${LINK_ICON}</span>`;
      // Manage the folder's ACL (model B): cascades to children by inheritance.
      const dirAccessBtn = isRemote
        ? ''
        : `<span class="dir-access-btn tree-action-btn" title="${t('aclBtnTitle')}"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"/></svg></span>`;

      btn.innerHTML = `<span class="caret text-xs text-ink-400">&#9656;</span>${isRemoteRoot ? REMOTE_FOLDER_ICON : FOLDER_ICON}<span class="truncate min-w-0 flex-1" data-name="${escapeHtml(child.name)}">${escapeHtml(dirLabel)}</span>${dirAccessBtn}<span class="dir-rename-btn tree-action-btn" title="${t('renameFolder')}">${PENCIL_ICON}</span>${dirShareBtn}`;
      const sub = renderTree(child, depth + 1, childPath);

      sub.classList.add('hidden');
      btn.addEventListener('click', (e) => {
        if (e.target.closest('.dir-access-btn')) {
          e.stopPropagation();
          if (window.openAccessFor) window.openAccessFor(childPath);

          return;
        }

        if (e.target.closest('.dir-share-btn')) {
          e.stopPropagation();
          openPublishNode(childPath);

          return;
        }

        if (e.target.closest('.dir-rename-btn')) {
          e.stopPropagation();
          openDirRenameModal(childPath);

          return;
        }

        sub.classList.toggle('hidden');
        btn.querySelector('.caret').classList.toggle('open');
      });

      if (depth === 0) {
        sub.classList.remove('hidden');
        btn.querySelector('.caret').classList.add('open');
      }

      li.appendChild(btn);
      li.appendChild(sub);
    } else {
      const isRemoteFile = child.path.startsWith('remotes/');
      const a = document.createElement('a');

      a.className =
        'tree-item group w-full px-2 py-1.5 rounded flex items-start gap-2 cursor-pointer text-ink-200' +
        (isRemoteFile ? ' tree-remote' : '');
      a.dataset.path = child.path;
      const nameHtml = `<span class="truncate min-w-0 flex-1 leading-snug" data-name="${escapeHtml(child.name)}">${escapeHtml(child.name)}</span>`;
      // Sharing-state dot: private = amber, shared-by-me = sky,
      // shared-with-me (granted) = emerald, commons = none.
      const visBadge =
        child.vis === 'private'
          ? `<span class="flex-shrink-0 mt-1.5 w-1.5 h-1.5 rounded-full" style="background-color:rgba(251,191,36,.85)" title="${t('visPrivate')}"></span>`
          : child.vis === 'shared'
            ? `<span class="flex-shrink-0 mt-1.5 w-1.5 h-1.5 rounded-full" style="background-color:rgba(56,189,248,.85)" title="${t('visShared')}"></span>`
            : child.vis === 'granted'
              ? `<span class="flex-shrink-0 mt-1.5 w-1.5 h-1.5 rounded-full" style="background-color:rgba(52,211,153,.9)" title="${t('visGranted')}"></span>`
              : '';
      // Buttons on hover over your own document (.md/.html): rename + share.
      const fileActionable = !isRemoteFile && (child.ext === '.md' || child.ext === '.html');
      const fileRenameBtn = fileActionable
        ? `<span class="file-rename-btn tree-action-btn" title="${t('renameFile')}">${PENCIL_ICON}</span>`
        : '';
      const fileShareBtn = fileActionable
        ? `<span class="file-share-btn tree-action-btn tree-action-btn--share" title="${t('shareAsNode')}">${LINK_ICON}</span>`
        : '';
      // Manage the file's ACL (model B) — mirror of the folder's access button.
      const fileAccessBtn = fileActionable
        ? `<span class="file-access-btn tree-action-btn" title="${t('aclBtnTitle')}"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"/></svg></span>`
        : '';

      a.innerHTML = `${iconFor(child.ext)}${nameHtml}${visBadge}${fileAccessBtn}${fileRenameBtn}${fileShareBtn}`;

      if (
        child.ext === '.md' ||
        child.ext === '.html' ||
        child.ext === '.pdf' ||
        child.ext === '.docx'
      ) {
        // showMarkdown dispatches: .md → marked, .html → iframe, .pdf → native, .docx → mammoth.
        a.addEventListener('click', (e) => {
          if (e.target.closest('.file-access-btn')) {
            e.preventDefault();
            e.stopPropagation();
            if (window.openAccessFor) window.openAccessFor(child.path);

            return;
          }

          if (e.target.closest('.file-share-btn')) {
            e.preventDefault();
            e.stopPropagation();
            openPublishNode(child.path);

            return;
          }

          if (e.target.closest('.file-rename-btn')) {
            e.preventDefault();
            e.stopPropagation();
            showMarkdown(child);
            openRenameModal('rename');

            return;
          }

          e.preventDefault();
          showMarkdown(child);
          history.replaceState(null, '', '#' + encodeURIComponent(child.path));
        });
      } else {
        a.href = encodeURI(child.path);
      }

      li.appendChild(a);
    }

    ul.appendChild(li);
  }

  return ul;
}

// Under each mirror (remotes/<name>), show which atlas it comes from — useful
// when following several sources. Admin-only data → silent best-effort.
async function decorateRemoteOrigins() {
  let remotes;

  try {
    const resp = await fetch('/api/admin/remotes', { headers: { Accept: 'application/json' } });

    if (!resp.ok) return;
    remotes = await resp.json();
  } catch (_) {
    return;
  }

  if (!Array.isArray(remotes)) return;

  for (const r of remotes) {
    const host = (r.url || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');

    if (!host) continue;
    const sel =
      'button[data-dir-path="remotes/' +
      (window.CSS && CSS.escape ? CSS.escape(r.name) : r.name) +
      '"]';
    const btn = treeEl.querySelector(sel);

    if (!btn || btn.querySelector('.tree-remote-origin')) continue;
    const span = document.createElement('span');

    span.className = 'tree-remote-origin';
    span.textContent = host;
    span.title = r.url || '';
    btn.insertBefore(span, btn.querySelector('.dir-rename-btn'));
  }
}

// In SERVER mode the baked tree is the FULL build-time view (generated as the
// owner). Never render it — a viewer would see private names in the menu. The
// bootstrap fetches /api/tree (filtered per account) on init via softReload().
// Only the offline build renders the embedded tree directly. Gated on
// IS_OFFLINE_BUILD, NOT the protocol: GitHub Pages serves the offline build over
// https, so a file:// check would leave the demo with an empty tree.
if (IS_OFFLINE_BUILD) {
  treeEl.appendChild(renderTree(TREE));
  decorateTreeBadges();
  decorateRemoteOrigins();
}

// Toolbar button: expand or collapse every folder of the tree in one click.
// Stateless toggle — flips on each press; operates on whatever is currently
// rendered, so it keeps working after a softReload re-renders the tree.
(function () {
  const btn = document.getElementById('tree-toggle-all');

  if (!btn) return;
  // One static label for both directions (the global [data-tip] hover, like
  // "Voir les modifications" — not the native title). aria mirrors it.
  btn.dataset.tip = t('expandAllFolders');
  btn.setAttribute('aria-label', t('expandAllFolders'));

  btn.addEventListener('click', () => {
    const dirs = treeEl.querySelectorAll('button[data-dir-path]');
    // Derive the action from the actual tree, not a remembered flag: if anything is
    // open, collapse everything; only expand when all folders are already closed.
    const expand = ![...dirs].some((b) => b.querySelector('.caret')?.classList.contains('open'));

    dirs.forEach((b) => {
      const caret = b.querySelector('.caret');
      const sub = b.parentElement.querySelector('ul');

      if (!caret || !sub) return;
      caret.classList.toggle('open', expand);
      sub.classList.toggle('hidden', !expand);
    });
  });
})();

marked.setOptions({ gfm: true, breaks: false });
// marked ≥ v5 removed the `highlight` setOptions option (silently ignored by the
// vendored v15), so we highlight in a custom `code` renderer instead. The hljs
// output survives DOMPurify; the `hljs` class enables the vendored github-dark theme.
marked.use({
  renderer: {
    code({ text, lang }) {
      const language = (lang || '').trim().split(/\s+/)[0];
      let html;

      try {
        html =
          language && hljs.getLanguage(language)
            ? hljs.highlight(text, { language }).value
            : hljs.highlightAuto(text).value;
      } catch (e) {
        html = escapeHtml(text);
      }

      const cls = language ? ' language-' + escapeHtml(language) : '';

      return '<pre><code class="hljs' + cls + '">' + html + '</code></pre>\n';
    },
  },
});

// ─── Wikilinks [[doc]] ─────────────────────────────────────────────────────────
// Target → path resolution (same logic as the build): direct path, else stem.
// Maps built once over fileMap. Any openable doc is a valid target, not just .md.
const WL_TARGET_EXTS = ['.md', '.html', '.pdf', '.docx'];
let _wlMaps = null;

function wlMaps() {
  if (_wlMaps) return _wlMaps;
  const byPath = {},
    byStem = {};

  for (const f of Object.values(fileMap)) {
    if (!WL_TARGET_EXTS.includes(f.ext)) continue;
    byPath[f.path.toLowerCase()] = f.path;
    const stem = f.name.replace(/\.[^.]+$/, '').toLowerCase();

    if (!(stem in byStem)) byStem[stem] = f.path;
  }

  _wlMaps = { byPath, byStem };

  return _wlMaps;
}

function resolveWikilink(target) {
  const { byPath, byStem } = wlMaps();
  const t = target.split('|')[0].trim().toLowerCase();

  if (!t) return null;

  // Exact path, with or without one of the known extensions.
  for (const ext of ['', ...WL_TARGET_EXTS]) {
    if (byPath[t + ext]) return byPath[t + ext];
  }

  // Fallback: match on the file stem (last segment, extension stripped).
  const stem = t
    .split('/')
    .pop()
    .replace(/\.[^.]+$/, '');

  return byStem[stem] || null;
}

// marked extension: [[target]] or [[target|text]] → navigable link (or .broken if
// unresolved). Handled as an inline token → ignored inside code blocks.
marked.use({
  extensions: [
    {
      name: 'wikilink',
      level: 'inline',
      start(src) {
        return src.indexOf('[[');
      },
      tokenizer(src) {
        const m = /^\[\[([^\[\]\n]+?)\]\]/.exec(src);

        if (m) return { type: 'wikilink', raw: m[0], target: m[1].trim() };
      },
      renderer(token) {
        const parts = token.target.split('|');
        const label = (parts[1] || parts[0]).trim();
        const path = resolveWikilink(parts[0].trim());

        if (path)
          return (
            '<a class="wikilink" data-path="' + escapeHtml(path) + '">' + escapeHtml(label) + '</a>'
          );

        return (
          '<a class="wikilink broken" title="' +
          escapeHtml(t('brokenLink', parts[0].trim())) +
          '">' +
          escapeHtml(label) +
          '</a>'
        );
      },
    },
  ],
});

// Markdown → secure HTML rendering. marked doesn't neutralize raw HTML: a doc
// containing <script>/<img onerror> would run in the innerHTML. We pass the
// output through DOMPurify — a local lib (/vendor/, inlined in the offline build):
// if it's missing that's a build bug, we show an error and NEVER render
// unsanitized HTML.
function renderMd(md) {
  if (typeof DOMPurify === 'undefined') {
    console.error('DOMPurify absent : asset /vendor/purify.min.js manquant (bug de build).');

    return '<p class="text-red-400 font-sans">' + escapeHtml(t('sanitizerMissing')) + '</p>';
  }

  return DOMPurify.sanitize(marked.parse(md || ''));
}

// Live-reload suppression window (per path): after we write a doc ourselves (a
// checkbox toggle), the SSE that follows the commit must NOT re-render it — cf.
// softReload.
const _selfSaveUntil = {};
// In-flight checkbox PUTs. The rollup is computed live from disk, so
// loadTasksIndex awaits these before fetching — else it reads the pre-toggle file.
const _taskWrites = new Set();
// Flipping the Nth rendered checkbox flips the Nth source marker, so the count
// must mirror marked exactly: skip fenced-code tasks (no checkbox), count
// blockquoted ones (marked renders them) — and a fence nested in a blockquote is
// not honoured here, so detect fences only outside blockquotes.
const TASK_MARK_RE = /^(\s*(?:[-*+]|\d+\.)\s+\[)([ xX])(\])/;
const _FENCE_RE = /^(?:`{3,}|~{3,})/;
const _BQ_RE = /^\s*>[ \t]?/;

function _stripBlockquote(line) {
  let s = line,
    quoted = false;

  while (_BQ_RE.test(s)) {
    s = s.replace(_BQ_RE, '');
    quoted = true;
  }

  return [s, quoted];
}

function toggleNthTaskMarker(content, index, checked) {
  const lines = content.split('\n');
  let n = -1,
    inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const [unquoted, quoted] = _stripBlockquote(lines[i]);

    if (!quoted && _FENCE_RE.test(lines[i].trimStart())) {
      inFence = !inFence;
      continue;
    }

    if (inFence) continue;

    if (!TASK_MARK_RE.test(unquoted)) continue;
    n++;

    if (n === index) {
      const prefix = lines[i].slice(0, lines[i].length - unquoted.length); // keep the `>`

      lines[i] = prefix + unquoted.replace(TASK_MARK_RE, '$1' + (checked ? 'x' : ' ') + '$3');

      return lines.join('\n');
    }
  }

  return null;
}

function wireTaskCheckboxes(file, fullContent) {
  // Offline (file://) or read-only shared view: no writing possible.
  if (!isServerMode || window.__viewerMode) return;
  const boxes = contentEl.querySelectorAll('input[type="checkbox"]');

  if (!boxes.length) return;
  let docContent = fullContent;

  boxes.forEach((box, index) => {
    box.disabled = false;
    box.style.cursor = 'pointer';
    box.addEventListener('change', () => {
      const desired = box.checked;
      const newContent = toggleNthTaskMarker(docContent, index, desired);

      if (newContent == null) {
        box.checked = !desired;

        return;
      }

      // Optimistic: advance local state now, PUT in the background, no re-render.
      const prev = docContent;

      docContent = newContent;
      contentCache.set(file.path, newContent);

      if (currentFile && currentFile.path === file.path) currentFile.content = newContent;
      _selfSaveUntil[file.path] = Date.now() + 6000; // mute the self-triggered SSE reload
      // The task's own text (drop nested sub-tasks) → a "checked:/unchecked:" commit subject.
      const li = box.closest('li');
      let taskText = '';

      if (li) {
        const clone = li.cloneNode(true);

        clone.querySelectorAll('ul, ol').forEach((n) => n.remove());
        taskText = clone.textContent.replace(/\s+/g, ' ').trim();
      }

      // Tracked in _taskWrites so the rollup waits for it before reading from disk.
      const write = fetch('/api/file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: file.path,
          content: newContent,
          task: { text: taskText, checked: desired },
        }),
      })
        .then((res) => {
          if (!res.ok) throw new Error('HTTP ' + res.status);

          return res.json();
        })
        .then((data) => {
          if (currentFile && currentFile.path === file.path && data.mtime)
            currentFile.mtime = data.mtime;
        })
        .catch((e) => {
          // Failure: we roll back the optimistic update (state + visual).
          docContent = prev;
          contentCache.set(file.path, prev);

          if (currentFile && currentFile.path === file.path) currentFile.content = prev;
          box.checked = !desired;
          notifyError('err', e.message);
        });

      _taskWrites.add(write);
      write.finally(() => _taskWrites.delete(write));
    });
  });
}

function buildToc() {
  tocList.innerHTML = '';
  const headings = contentEl.querySelectorAll('h2, h3');

  if (headings.length < 2) {
    tocList.classList.add('hidden'); // no table of contents → no empty area

    if (typeof applyToc === 'function') applyToc();
    else {
      tocPanel.classList.add('hidden');
      tocPanel.classList.remove('flex');
    }

    return;
  }

  tocList.classList.remove('hidden');
  const used = new Set();

  headings.forEach((h) => {
    let id = slugify(h.textContent);
    let base = id,
      n = 2;

    while (used.has(id)) {
      id = base + '-' + n;
      n++;
    }

    used.add(id);
    h.id = id;
    const a = document.createElement('a');

    a.href = '#' + id;
    a.textContent = h.textContent;
    a.className =
      'block px-2 py-1 rounded hover:bg-white/5 text-ink-300 hover:text-accent truncate ' +
      (h.tagName === 'H3' ? 'pl-5 text-[11px] text-ink-400' : 'font-medium');
    a.addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById(id).scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    tocList.appendChild(a);
  });

  if (typeof applyToc === 'function') applyToc();
  else {
    tocPanel.classList.remove('hidden');
    tocPanel.classList.add('flex');
  }
}

function readingTimeFromWords(words) {
  if (!words) return null;
  const minutes = Math.max(1, Math.round(words / 220));

  return { words, minutes };
}

// ─── Backlinks (index pre-computed at build time) ─────────────────────────────

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
        const res = await fetch('/_backlinks.json', { cache: 'no-cache' });

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
  // Synchronous reset (before the await): applyToc() from buildToc() will see a clean state.
  tocHasLinks = false;

  if (tocLinks) {
    tocLinks.innerHTML = '';
    tocLinks.classList.remove('border-t', 'panel-divider');
  }

  const idx = await loadBacklinksIndex();

  if (currentFile !== file) return; // user changed page mid-load
  const entry = idx[file.path] || { out: [], in: [] };
  const resolve = (paths) => (paths || []).map((p) => fileMap[p]).filter(Boolean);
  const incoming = resolve(entry.in);
  const outgoing = resolve(entry.out);
  // Same-topic docs: shared tags (excluding the current doc), ranked by shared-tag
  // count then recency.
  const tagSet = new Set(file.tags || []);
  const shared = (f) => (f.tags || []).filter((t) => tagSet.has(t)).length;
  const related = tagSet.size
    ? Object.values(fileMap)
        .filter((f) => f.ext === '.md' && f.path !== file.path && shared(f) > 0)
        .sort((a, b) => shared(b) - shared(a) || (b.mtime || 0) - (a.mtime || 0))
        .slice(0, 8)
    : [];

  tocHasLinks = !!(incoming.length || outgoing.length || related.length);
  tocLinks.classList.toggle('hidden', !tocHasLinks); // empty section → no gap

  if (!tocHasLinks) {
    applyToc();

    return;
  }

  const card = (f) =>
    '<a class="block px-2 py-1 rounded hover:bg-white/5 text-ink-300 hover:text-accent cursor-pointer truncate" ' +
    'data-conn="' +
    escapeHtml(f.path) +
    '" title="' +
    escapeHtml(f.path) +
    '">' +
    escapeHtml(f.name) +
    '</a>';
  const group = (title, items) =>
    items.length
      ? '<div class="mt-2"><div class="px-2 pb-0.5 text-[10px] uppercase tracking-[0.1em] text-ink-500 font-bold">' +
        title +
        '</div>' +
        items.map(card).join('') +
        '</div>'
      : '';

  tocLinks.classList.add('border-t', 'panel-divider');
  tocLinks.innerHTML =
    '<div class="px-2 pb-1 text-[10px] uppercase tracking-[0.12em] text-accent font-bold">' +
    t('linksTitle') +
    '</div>' +
    group(t('referencedBy', incoming.length), incoming) +
    group(t('outgoingLinks', outgoing.length), outgoing) +
    group(t('sameTopic', related.length), related);
  tocLinks.querySelectorAll('[data-conn]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const f = fileMap[a.dataset.conn];

      if (f) {
        showMarkdown(f);
        history.replaceState(null, '', '#' + encodeURIComponent(f.path));
      }
    });
  });
  applyToc();
}

// ─── Passage annotations ─────────────────────────────────────────────────────
// Data: sidecar .notes/<doc>.json server-side (offline: EMBED_NOTES). Text-quote
// anchoring (exact + prefix/suffix + approx. pos), W3C Web Annotation style:
// resilient to text shifts; if the passage disappears the note becomes orphaned.
const CTX_LEN = 60; // captured prefix/suffix context length
// Notes are the (deferred) comment level — admin-only for now. A member has the
// `viewer-mode` body class (but writes its own docs), so gate notes on the class.
const notesCanEdit = () => !IS_OFFLINE_BUILD && !document.body.classList.contains('viewer-mode');
let notesForDoc = []; // notes of the current doc (anchors resolved on the fly)
// notesIndex ({path: count}, tree badges) is declared at the top of the script so
// it's visible from the top-level decorateTreeBadges().

const noteAddBtn = document.getElementById('kb-note-add');
const notePop = document.getElementById('kb-note-pop');

// Global text offset of a (node, offset) within contentEl, by walking the text
// nodes. -1 if the node isn't under contentEl.
function textOffsetOf(node, offset) {
  if (!contentEl.contains(node)) return -1;
  const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT);
  let acc = 0,
    n;

  while ((n = walker.nextNode())) {
    if (n === node) return acc + offset;
    acc += n.nodeValue.length;
  }

  return -1;
}

// Builds a text-quote anchor from the current selection.
function selectionToAnchor() {
  const sel = window.getSelection();

  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);

  if (!contentEl.contains(r.commonAncestorContainer)) return null;
  const start = textOffsetOf(r.startContainer, r.startOffset);
  const end = textOffsetOf(r.endContainer, r.endOffset);

  if (start < 0 || end < 0 || end <= start) return null;
  const full = contentEl.textContent;
  const exact = full.slice(start, end);

  if (!exact.trim()) return null;

  return {
    exact,
    prefix: full.slice(Math.max(0, start - CTX_LEN), start),
    suffix: full.slice(end, end + CTX_LEN),
    pos: start,
  };
}

// Re-locates an anchor in the current text → {start, end} or null (orphan).
// Searches all occurrences of `exact`, scores by prefix/suffix context and
// proximity to `pos`, keeps the best one.
function locateAnchor(a) {
  const full = contentEl.textContent;

  if (!a.exact) return null;
  const idxs = [];
  let i = full.indexOf(a.exact);

  while (i !== -1) {
    idxs.push(i);
    i = full.indexOf(a.exact, i + 1);
  }

  if (!idxs.length) return null;
  let best = idxs[0],
    bestScore = -Infinity;

  for (const s of idxs) {
    let score = 0;
    const before = full.slice(Math.max(0, s - CTX_LEN), s);
    const after = full.slice(s + a.exact.length, s + a.exact.length + CTX_LEN);

    if (a.prefix && before.endsWith(a.prefix)) score += 100;
    else if (a.prefix) {
      let k = 0;

      while (
        k < a.prefix.length &&
        before[before.length - 1 - k] === a.prefix[a.prefix.length - 1 - k]
      )
        k++;
      score += k;
    }

    if (a.suffix && after.startsWith(a.suffix)) score += 100;
    else if (a.suffix) {
      let k = 0;

      while (k < a.suffix.length && after[k] === a.suffix[k]) k++;
      score += k;
    }

    score -= Math.abs(s - (a.pos || 0)) / 1000;

    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }

  return { start: best, end: best + a.exact.length };
}

// Wraps the global text range [start,end) in <mark> (one per traversed text node),
// with data-* + click handler. Injected AFTER DOMPurify, so the note text never
// goes through markdown rendering.
function highlightRange(start, end, note) {
  const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT);
  let acc = 0,
    n;
  const todo = [];

  while ((n = walker.nextNode())) {
    const len = n.nodeValue.length;
    const ns = acc,
      ne = acc + len;

    if (ne > start && ns < end) {
      todo.push({ node: n, from: Math.max(0, start - ns), to: Math.min(len, end - ns) });
    }

    acc = ne;

    if (ns >= end) break;
  }

  for (const t of todo) {
    let node = t.node;

    if (t.to < node.nodeValue.length) node.splitText(t.to);

    if (t.from > 0) node = node.splitText(t.from);
    const mark = document.createElement('mark');

    mark.className = 'kb-annot';
    mark.dataset.noteId = note.id;
    node.parentNode.insertBefore(mark, node);
    mark.appendChild(node);
    mark.addEventListener('click', (e) => {
      e.stopPropagation();
      openNotePopForExisting(note, mark);
    });
  }

  return todo.length > 0;
}

async function fetchNotes(file) {
  if (IS_OFFLINE_BUILD) return (EMBED_NOTES && EMBED_NOTES[file.path]) || [];

  try {
    const res = await fetch('/api/notes?path=' + encodeURIComponent(file.path), {
      cache: 'no-cache',
    });

    return res.ok ? await res.json() : [];
  } catch (e) {
    return [];
  }
}

async function renderNotesFor(file) {
  tocHasNotes = false;

  if (tocNotes) {
    tocNotes.innerHTML = '';
    tocNotes.classList.remove('border-t', 'panel-divider');
  }

  notesForDoc = [];
  const notes = await fetchNotes(file);

  if (currentFile !== file) return; // page changed during the fetch
  notesForDoc = notes;

  if (!notes.length) {
    applyToc();

    return;
  }

  // Resolve each anchor in the rendered DOM and highlight it.
  notes.forEach((note) => {
    const loc = locateAnchor(note);

    note._orphan = !(loc && highlightRange(loc.start, loc.end, note));
  });
  renderNotesPanel(file);
}

function renderNotesPanel(file) {
  tocHasNotes = notesForDoc.length > 0;
  tocNotes.classList.toggle('hidden', !tocHasNotes); // empty section → no gap

  if (!tocHasNotes) {
    applyToc();

    return;
  }

  const row = (note) => {
    const by = note.author ? '✍ ' + escapeHtml(String(note.author).split('@')[0]) : '';
    const when = note.created ? relativeDate(note.created) : '';
    const byline = [by, when].filter(Boolean).join(' · ');
    return (
      '<button class="kb-note-row' +
      (note._orphan ? ' kb-orphan' : '') +
      '" data-note-id="' +
      escapeHtml(note.id) +
      '">' +
      '<span class="kb-note-snip">' +
      escapeHtml(note.note.length > 90 ? note.note.slice(0, 90) + '…' : note.note) +
      '</span>' +
      '<span class="kb-note-meta">' +
      (note._orphan
        ? t('orphanShort')
        : '“' +
          escapeHtml(note.exact.length > 40 ? note.exact.slice(0, 40) + '…' : note.exact) +
          '”') +
      '</span>' +
      (byline
        ? '<span class="kb-note-meta" style="opacity:.65">' + byline + '</span>'
        : '') +
      '</button>'
    );
  };

  tocNotes.classList.add('border-t', 'panel-divider');
  // Header with counter + « copy all notes » button (share annotations, incl.
  // from a read-only remote node).
  tocNotes.innerHTML =
    '<div class="px-2 pb-1 flex items-center justify-between gap-2">' +
    '<span class="text-[10px] uppercase tracking-[0.12em] text-amber-300 font-bold">' +
    t('notesTitle', notesForDoc.length) +
    '</span>' +
    '<button id="toc-notes-copy" class="p-0.5 -mr-0.5 text-ink-500 hover:text-amber-300 rounded hover:bg-white/5 flex-shrink-0" title="' +
    escapeHtml(t('copyAllNotes')) +
    '"><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184"/></svg></button>' +
    '</div>' +
    notesForDoc.map(row).join('');
  const copyBtn = tocNotes.querySelector('#toc-notes-copy');

  if (copyBtn)
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      copyAllNotes(copyBtn);
    });
  tocNotes.querySelectorAll('[data-note-id]').forEach((el) => {
    el.addEventListener('click', () => {
      const note = notesForDoc.find((n) => n.id === el.dataset.noteId);

      if (!note) return;
      const mark = contentEl.querySelector(
        'mark.kb-annot[data-note-id="' + CSS.escape(note.id) + '"]',
      );

      if (mark) {
        mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
        openNotePopForExisting(note, mark);
      } else openNotePopForExisting(note, el); // orphan: anchor the popover on the row
    });
  });
  applyToc();
}

// Copies all notes of the current doc as markdown (quote + note) for sharing.
async function copyAllNotes(btn) {
  if (!notesForDoc.length) return;
  const lines = [];
  const title = currentFile ? currentFile.name || currentFile.path : '';

  if (title) lines.push('# Notes — ' + title, '');
  notesForDoc.forEach((n) => {
    if (n.exact && !n._orphan) lines.push('> ' + n.exact);
    lines.push(n.note);
    const meta = [];
    if (n.author) meta.push(String(n.author));
    if (n.created) meta.push(new Date(n.created * 1000).toLocaleString(LANG));
    if (meta.length) lines.push('— ' + meta.join(' · '));
    lines.push('');
  });
  await copyToClipboard(lines.join('\n').trim() + '\n');

  if (btn) {
    btn.classList.add('text-emerald-400');
    setTimeout(() => btn.classList.remove('text-emerald-400'), 1200);
  }

  setStatus(t('notesCopied', notesForDoc.length), 'ok');
}

// ─── Popover create / read-edit ──────────────────────────────────────────────
let pendingAnchor = null;

function positionPop(el, anchorRect) {
  const margin = 8;
  let top = window.scrollY + anchorRect.bottom + margin;
  let left = window.scrollX + anchorRect.left;

  el.style.display = 'block';
  const w = el.offsetWidth,
    h = el.offsetHeight;

  if (left + w > window.scrollX + document.documentElement.clientWidth - margin)
    left = window.scrollX + document.documentElement.clientWidth - w - margin;

  if (anchorRect.bottom + margin + h > document.documentElement.clientHeight)
    top = window.scrollY + anchorRect.top - h - margin;
  el.style.top = Math.max(window.scrollY + margin, top) + 'px';
  el.style.left = Math.max(margin, left) + 'px';
}

function closeNotePop() {
  notePop.style.display = 'none';
  notePop.innerHTML = '';
  pendingAnchor = null;
  contentEl
    .querySelectorAll('mark.kb-annot.kb-annot-active')
    .forEach((m) => m.classList.remove('kb-annot-active'));
}

function openNotePopForNew(anchor, rect) {
  pendingAnchor = anchor;
  notePop.innerHTML =
    '<div class="kb-quote">“' +
    escapeHtml(anchor.exact.length > 160 ? anchor.exact.slice(0, 160) + '…' : anchor.exact) +
    '”</div>' +
    '<textarea placeholder="' +
    escapeHtml(t('notePlaceholder')) +
    '"></textarea>' +
    '<div class="kb-pop-actions"><button class="kb-btn-ghost" data-act="cancel">' +
    t('cancel') +
    '</button><button class="kb-btn-save" data-act="save">' +
    t('save') +
    '</button></div>';
  positionPop(notePop, rect);
  const ta = notePop.querySelector('textarea');

  ta.focus();
  notePop.querySelector('[data-act="cancel"]').onclick = closeNotePop;
  notePop.querySelector('[data-act="save"]').onclick = () => saveNewNote(ta.value);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveNewNote(ta.value);
  });
}

function openNotePopForExisting(note, anchorEl) {
  closeNotePop();
  contentEl
    .querySelectorAll('mark.kb-annot[data-note-id="' + CSS.escape(note.id) + '"]')
    .forEach((m) => m.classList.add('kb-annot-active'));
  const canEdit = notesCanEdit();
  const created = note.created ? relativeDate(note.created) : '';
  const by = note.author ? '✍ ' + escapeHtml(String(note.author).split('@')[0]) : '';
  const meta = [by, created].filter(Boolean).join(' · ');

  notePop.innerHTML =
    (note._orphan
      ? '<div class="kb-quote">' + t('orphanLong', escapeHtml(note.exact.slice(0, 120))) + '</div>'
      : '') +
    (canEdit
      ? '<textarea>' + escapeHtml(note.note) + '</textarea>'
      : '<div style="font-size:0.82rem;color:#e7e7ec;white-space:pre-wrap">' +
        escapeHtml(note.note) +
        '</div>') +
    (meta
      ? '<div class="kb-note-meta" style="font-size:0.66rem;color:#6b7280;margin-top:0.5rem">' +
        meta +
        '</div>'
      : '') +
    '<div class="kb-pop-actions">' +
    (canEdit ? '<button class="kb-btn-del" data-act="del">' + t('del') + '</button>' : '') +
    '<button class="kb-btn-ghost" data-act="cancel">' +
    t('close') +
    '</button>' +
    (canEdit ? '<button class="kb-btn-save" data-act="save">' + t('save') + '</button>' : '') +
    '</div>';
  positionPop(notePop, anchorEl.getBoundingClientRect());
  notePop.querySelector('[data-act="cancel"]').onclick = closeNotePop;

  if (canEdit) {
    const ta = notePop.querySelector('textarea');

    ta.focus();
    notePop.querySelector('[data-act="save"]').onclick = () => saveEditNote(note, ta.value);
    notePop.querySelector('[data-act="del"]').onclick = () => deleteNote(note);
  }
}

async function saveNewNote(text) {
  text = (text || '').trim();

  if (!text || !pendingAnchor || !currentFile) return;
  const body = Object.assign({ path: currentFile.path, note: text }, pendingAnchor);

  try {
    const res = await fetch('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error('HTTP ' + res.status);
  } catch (e) {
    notifyError('noteSaveFailed', e.message);

    return;
  }

  closeNotePop();
  window.getSelection().removeAllRanges();
  refreshNotes();
}

async function saveEditNote(note, text) {
  text = (text || '').trim();

  if (!text || !currentFile) return;

  try {
    const res = await fetch(
      '/api/notes?path=' +
        encodeURIComponent(currentFile.path) +
        '&id=' +
        encodeURIComponent(note.id),
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: text }),
      },
    );

    if (!res.ok) throw new Error('HTTP ' + res.status);
  } catch (e) {
    notifyError('actionFailed', e.message);

    return;
  }

  closeNotePop();
  refreshNotes();
}

async function deleteNote(note) {
  if (!currentFile) return;
  const ok = await confirmDialog({
    title: t('deleteNoteTitle'),
    message: t('deleteNoteMsg', note.note.length > 80 ? note.note.slice(0, 80) + '…' : note.note),
    confirmLabel: t('del'),
    destructive: true,
  });

  if (!ok) return;

  try {
    const res = await fetch(
      '/api/notes?path=' +
        encodeURIComponent(currentFile.path) +
        '&id=' +
        encodeURIComponent(note.id),
      { method: 'DELETE' },
    );

    if (!res.ok) throw new Error('HTTP ' + res.status);
  } catch (e) {
    notifyError('actionFailed', e.message);

    return;
  }

  closeNotePop();
  refreshNotes();
}

// Full re-render of the current doc + live tree-badge update. We recount notes
// from the SOURCE (/api/notes) because _notes-index.json is only regenerated at
// the next build — without this the badge only appeared after a reload.
async function refreshNotes() {
  if (!currentFile) return;
  const path = currentFile.path;

  try {
    const res = await fetch('/api/notes?path=' + encodeURIComponent(path), { cache: 'no-cache' });
    const list = res.ok ? await res.json() : null;

    if (Array.isArray(list)) {
      const idx = await loadNotesIndex();

      if (list.length) idx[path] = list.length;
      else delete idx[path];
      decorateTreeBadges();
    }
  } catch (_) {}

  showMarkdown(currentFile);
}

// Text selection → floating "Note" button (edit mode only). We store the anchor +
// rect at selection time, so the button tap doesn't need the selection to survive
// (on mobile the tap collapses it).
function updateNoteButton() {
  // Notes anchor into a markdown doc: no meaning on the home page (no currentFile)
  // nor a .html/.pdf (isolated iframe).
  if (
    !notesCanEdit() ||
    editMode ||
    notePop.style.display === 'block' ||
    !currentFile ||
    currentFile.ext !== '.md'
  ) {
    noteAddBtn.style.display = 'none';

    return;
  }

  const a = selectionToAnchor();

  if (!a) {
    noteAddBtn.style.display = 'none';

    return;
  }

  const rect = window.getSelection().getRangeAt(0).getBoundingClientRect();

  noteAddBtn._anchor = a;
  noteAddBtn._rect = rect;
  noteAddBtn.style.display = 'inline-flex';
  // Placed BELOW the selection: the native copy/paste bar (mobile) is above it.
  const bw = noteAddBtn.offsetWidth || 96;
  let left = window.scrollX + rect.left;
  const maxLeft = window.scrollX + document.documentElement.clientWidth - bw - 8;

  if (left > maxLeft) left = maxLeft;
  noteAddBtn.style.top = window.scrollY + rect.bottom + 8 + 'px';
  noteAddBtn.style.left = Math.max(8, left) + 'px';
}

// Desktop: immediate mouseup. Mobile/keyboard: selectionchange (touch handles emit
// no mouseup) debounced until the selection stabilizes — the delay also lets the
// button tap land before the collapse clears it.
let _selTimer = null;

contentEl.addEventListener('mouseup', () => setTimeout(updateNoteButton, 10));
document.addEventListener('selectionchange', () => {
  clearTimeout(_selTimer);
  _selTimer = setTimeout(updateNoteButton, 350);
});

function triggerNoteCreate() {
  if (!noteAddBtn._anchor) return;
  noteAddBtn.style.display = 'none';
  openNotePopForNew(noteAddBtn._anchor, noteAddBtn._rect);
}

noteAddBtn.addEventListener('click', triggerNoteCreate);
// dedicated touchend: on mobile the click can be swallowed by the selection dismiss.
noteAddBtn.addEventListener('touchend', (e) => {
  e.preventDefault();
  triggerNoteCreate();
});

function maybeCloseOutside(e) {
  if (
    !notePop.contains(e.target) &&
    e.target !== noteAddBtn &&
    !noteAddBtn.contains(e.target) &&
    !e.target.closest('mark.kb-annot') &&
    !e.target.closest('.kb-note-row')
  ) {
    if (notePop.style.display === 'block') closeNotePop();

    if (!e.target.closest('#content')) noteAddBtn.style.display = 'none';
  }
}

document.addEventListener('mousedown', maybeCloseOutside);
document.addEventListener('touchstart', maybeCloseOutside, { passive: true });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeNotePop();
    noteAddBtn.style.display = 'none';
  }
});

// Notes index (tree badges). Online: _notes-index.json ; offline: EMBED_NOTES.
async function loadNotesIndex() {
  if (notesIndex) return notesIndex;

  if (IS_OFFLINE_BUILD) {
    notesIndex = {};

    for (const p in EMBED_NOTES || {}) notesIndex[p] = EMBED_NOTES[p].length;

    return notesIndex;
  }

  try {
    const res = await fetch('/_notes-index.json', { cache: 'no-cache' });

    notesIndex = res.ok ? await res.json() : {};
  } catch (e) {
    notesIndex = {};
  }

  return notesIndex;
}

async function decorateTreeBadges() {
  const idx = await loadNotesIndex();

  document.querySelectorAll('.kb-tree-badge').forEach((b) => b.remove());

  for (const path in idx) {
    const link = treeEl.querySelector('a[data-path="' + CSS.escape(path) + '"]');

    if (!link) continue;
    const badge = document.createElement('span');

    badge.className = 'kb-tree-badge';
    badge.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="w-3 h-3"><path stroke-linecap="round" stroke-linejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 0 1 .865-.501 48.172 48.172 0 0 0 3.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z"/></svg><span>' +
      idx[path] +
      '</span>';
    badge.title = t('notesBadge', idx[path]);
    link.appendChild(badge);
  }
}

function attachCopyButtons() {
  contentEl.querySelectorAll('pre').forEach((pre) => {
    if (pre.querySelector('.copy-btn')) return;
    pre.style.position = 'relative';
    const btn = document.createElement('button');

    btn.className =
      'copy-btn absolute top-2 right-2 opacity-0 transition-opacity px-2 py-1 text-[11px] bg-white/8 hover:bg-white/15 text-ink-300 hover:text-white rounded font-mono';
    btn.innerHTML =
      '<svg class="w-3 h-3 inline mr-1 -mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>' +
      t('copy');
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const code = pre.querySelector('code')
        ? pre.querySelector('code').textContent
        : pre.textContent;

      try {
        await navigator.clipboard.writeText(code);
        btn.innerHTML =
          '<svg class="w-3 h-3 inline mr-1 -mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>' +
          t('copied');
        btn.classList.add('text-emerald-400');
        setTimeout(() => {
          btn.innerHTML =
            '<svg class="w-3 h-3 inline mr-1 -mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>' +
            t('copy');
          btn.classList.remove('text-emerald-400');
        }, 1500);
      } catch (e) {}
    });
    pre.appendChild(btn);
    pre.addEventListener('mouseenter', () => (btn.style.opacity = '1'));
    pre.addEventListener('mouseleave', () => (btn.style.opacity = '0'));
  });
}

function renderSkeleton(file) {
  // Deterministic per-path skeleton (same doc → same layout). LCG seeded by hashStr(path).
  let state = (file && file.path ? hashStr(file.path) : 1) || 1;
  const next = () => (state = (state * 1664525 + 1013904223) >>> 0);
  const range = (min, max) => min + (next() % (max - min + 1));
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

    return (
      '<div style="display:flex;flex-direction:column;gap:.55rem;margin-bottom:1.75rem;">' +
      rows.join('') +
      '</div>'
    );
  };

  const h2 = () =>
    '<div class="skeleton-h2" style="height:1.6rem;width:' +
    range(28, 58) +
    '%;margin-bottom:1rem;margin-top:.5rem;"></div>';
  const code = () =>
    '<div class="skeleton-code" style="height:' +
    range(4, 9) +
    'rem;margin-bottom:1.75rem;"></div>';

  parts.push(
    '<div class="skeleton-title" style="height:2.4rem;width:' +
      range(48, 78) +
      '%;margin-bottom:1rem;"></div>',
  );
  parts.push(
    '<div style="display:flex;gap:.5rem;margin-bottom:2rem;">' +
      '<div class="skeleton" style="height:.7rem;width:' +
      range(5, 9) +
      'rem;"></div>' +
      '<div class="skeleton" style="height:.7rem;width:' +
      range(4, 7) +
      'rem;"></div>' +
      '</div>',
  );

  parts.push(para(range(3, 5)));

  const sections = range(1, 3);

  for (let s = 0; s < sections; s++) {
    parts.push(h2());
    parts.push(para(range(2, 5)));

    if (coin(0.4)) parts.push(code());
  }

  return (
    '<div class="not-prose" aria-busy="true" aria-label="' +
    t('loadingDoc') +
    '">' +
    parts.join('') +
    '</div>'
  );
}

function hashStr(s) {
  // djb2 — small stable fingerprint to seed the skeleton's LCG
  let h = 5381;

  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;

  return h;
}

async function showMarkdown(file, highlightQuery) {
  if (editMode) exitEditMode(false);
  currentFile = file;
  // Reset the overrides set by HTML rendering (cf. renderHtmlFrame): a .md doc
  // after a .html must get back the prose width/padding, and the todos widget
  // (hidden during the HTML preview) must reappear.
  contentEl.style.maxWidth = '';
  contentEl.style.padding = '';
  document.getElementById('todo-widget')?.classList.remove('hidden');
  contentEl.innerHTML = renderSkeleton(file);
  // Breadcrumb: we replace the technical prefix « remotes/ » with the label
  // « Mental nodes / » (consistent with the tree).
  breadcrumbPath.textContent = file.path.startsWith('remotes/')
    ? t('remotesLabel') + ' / ' + file.path.slice('remotes/'.length)
    : file.path;
  const parts = [];

  if (file.mtime) parts.push(t('modifiedAgo', relativeDate(file.mtime)));
  const rt = readingTimeFromWords(file.words);

  if (rt) parts.push(t('readingTime', rt.minutes, rt.words.toLocaleString(LANG)));
  breadcrumbDate.textContent = parts.length ? '· ' + parts.join(' · ') : '';
  breadcrumbActions.classList.remove('hidden');
  breadcrumbActions.classList.add('flex');
  // Mirror doc (under remotes/) = read-only mental node of another atlas: no Edit
  // (write → 403), no Share (don't re-share others' content), no ⋯ menu
  // (rename/move/delete → 403).
  const isRemoteDoc = (file.path || '').startsWith('remotes/');

  btnEdit.classList.toggle('hidden', isRemoteDoc);
  btnSave.classList.add('hidden');
  btnCancel.classList.add('hidden');
  document.getElementById('btn-share')?.classList.toggle('hidden', isRemoteDoc);
  document.getElementById('btn-access')?.classList.toggle('hidden', isRemoteDoc || IS_OFFLINE_BUILD);
  document.getElementById('btn-more-wrap')?.classList.toggle('hidden', isRemoteDoc);
  // "Shared by" badge: if this doc is owned by someone else (shared WITH you),
  // surface who shared it inline — no need to open the access dialog. Fire-and-
  // forget; cloud-only; guarded against a stale response after navigating away.
  const sharedByEl = document.getElementById('breadcrumb-sharedby');
  if (sharedByEl) {
    sharedByEl.textContent = '';
    sharedByEl.title = '';
    if (location.protocol.startsWith('http') && !isRemoteDoc && !IS_OFFLINE_BUILD) {
      fetch('/api/acl?path=' + encodeURIComponent(file.path))
        .then((r) => (r.ok ? r.json() : null))
        .then((a) => {
          if (a && a.owner && !a.can_manage && currentFile && currentFile.path === file.path) {
            const who = String(a.owner).replace(/^user:/, '');
            sharedByEl.textContent = ' ' + t('sharedByLabel', who.split('@')[0]);
            sharedByEl.title = t('sharedByLabel', who);
          }
        })
        .catch(() => {});
    }
  }
  // Remote node actions: only on a mirror doc, never offline (no server to
  // appropriate/remove against — the buttons would 404).
  const showNodeActions = isRemoteDoc && !IS_OFFLINE_BUILD;

  document.getElementById('btn-node-appropriate')?.classList.toggle('hidden', !showNodeActions);
  document.getElementById('btn-node-remove')?.classList.toggle('hidden', !showNodeActions);
  // Download button label = the doc's actual extension (.md/.html/.pdf/.docx).
  const dlExt = document.getElementById('btn-download-ext');

  if (dlExt) dlExt.textContent = file.ext || '';
  // Close any history panel left open from the previous doc so it never shows
  // stale revisions; the button itself is gated by historyAvailable().
  closeHistory();
  document.getElementById('btn-history')?.classList.toggle('hidden', !historyAvailable(file));
  updatePinButton(file);
  document.querySelectorAll('.tree-item').forEach((el) => el.classList.remove('active'));
  const active = document.querySelector(`[data-path="${file.path}"]`);

  if (active) {
    active.classList.add('active');
    let p = active.parentElement;

    while (p && p !== treeEl) {
      if (p.tagName === 'UL' && p.classList.contains('hidden')) {
        p.classList.remove('hidden');
        const btn = p.previousElementSibling;

        if (btn) btn.querySelector('.caret')?.classList.add('open');
      }

      p = p.parentElement;
    }
  }

  document.querySelector('main').scrollTop = 0;

  // .html document → standalone render in an isolated iframe, no markdown pipeline.
  if (file.ext === '.html') {
    renderHtmlFrame(file);

    return;
  }

  // .pdf document → browser's native viewer in an iframe, no markdown.
  if (file.ext === '.pdf') {
    renderPdfFrame(file);

    return;
  }

  // Word document → converted to readable HTML in the browser (read-only).
  if (file.ext === '.docx') {
    renderDocxFrame(file);

    return;
  }

  let content;

  try {
    content = await loadContent(file);
  } catch (e) {
    if (currentFile !== file) return;
    contentEl.innerHTML =
      '<div class="text-rose-400 text-sm">' + escapeHtml(t('loadError', e.message)) + '</div>';

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
  // Extensions hook: the doc has just been rendered (path + markdown without
  // frontmatter). Extensions listen to decorate / track the current doc.
  document.dispatchEvent(
    new CustomEvent('atlas:doc-rendered', { detail: { path: file.path, markdown: body } }),
  );

  if (highlightQuery) highlightFirstMatch(contentEl, highlightQuery);
}

// ─── Git history (revisions + diff) ──────────────────────────────────────────
// Each doc is versioned git. This panel lists a doc's revisions and shows, per
// revision, what that commit changed (diff against the previous revision) or the
// full version at that point. Backed by /api/history|diff|revision, which require
// an authenticated admin/viewer — so the button is hidden in offline builds and
// read-only share views, where those endpoints don't exist / return 401.
const historyOverlay = document.getElementById('history-overlay');
const historyList = document.getElementById('history-list');
const historyDetail = document.getElementById('history-detail');
const historyPathEl = document.getElementById('history-path');
let historyFile = null;

function historyAvailable(file) {
  // Inline the protocol check rather than reference the `isServerMode` const:
  // showMarkdown calls this synchronously before its first await, so on an initial
  // deep-link it can run before that const is initialized (TDZ).
  const serverMode = location.protocol === 'http:' || location.protocol === 'https:';

  return (
    !!file &&
    (file.ext === '.md' || file.ext === '.html') &&
    serverMode &&
    !IS_OFFLINE_BUILD &&
    !window.__viewerMode &&
    !(file.path || '').startsWith('remotes/')
  );
}

function closeHistory() {
  historyFile = null;
  historyOverlay.classList.add('hidden');
}

function formatRevDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);

  return isNaN(d)
    ? ''
    : d.toLocaleDateString(LANG, { day: 'numeric', month: 'short', year: 'numeric' });
}

async function openHistory(file) {
  // Optional target → the activity feed can peek a doc's history without navigating. Guard on a
  // real file (path is a string): btn-history binds this as a click handler, so a passed MouseEvent
  // (or its array-valued .path on old Chrome) must NOT be taken as `file`.
  file = (file && typeof file.path === 'string') ? file : currentFile;

  if (!historyAvailable(file)) return;
  historyFile = file;
  historyPathEl.textContent = file.path;
  historyList.innerHTML = '<div class="text-ink-500 px-2 py-1">…</div>';
  historyDetail.innerHTML = '<div class="text-ink-500">' + escapeHtml(t('historyPick')) + '</div>';
  historyOverlay.classList.remove('hidden');
  let data;

  try {
    data = await api('GET', '/api/history?path=' + encodeURIComponent(file.path));
  } catch (e) {
    if (historyFile !== file) return;
    historyList.innerHTML =
      '<div class="text-rose-400 px-2 py-1">' + escapeHtml(t('historyError')) + '</div>';

    return;
  }

  if (historyFile !== file) return; // user closed / navigated mid-load
  const revisions = data.revisions || [];

  if (!revisions.length) {
    historyList.innerHTML =
      '<div class="text-ink-500 px-2 py-1">' + escapeHtml(t('historyEmpty')) + '</div>';

    return;
  }

  historyAllRevisions = revisions;
  historyAiOnly = false; // each doc opens unfiltered
  historyCurrentSha = null;
  renderHistoryList(file);
}

// 13d — AI-only filter on the revision list. State + renderer are module-level so the
// toggle can re-render in place. showVersion always receives the FULL revisions array +
// the absolute index, so the diff (parent = revisions[i+1]) stays correct when filtered.
let historyAllRevisions = [];
let historyAiOnly = false;
let historyCurrentSha = null; // the revision shown in the detail pane (preserved across a filter toggle)

function renderHistoryList(file) {
  const revisions = historyAllRevisions;
  const hasAi = revisions.some((r) => r.ai);
  const shown = historyAiOnly ? revisions.filter((r) => r.ai) : revisions;
  historyList.innerHTML = '';

  if (hasAi) {
    const tg = document.createElement('button');

    tg.type = 'button';
    tg.className =
      'flex items-center gap-1.5 w-full text-left px-2 py-1.5 mb-1.5 text-xs transition ' +
      (historyAiOnly ? 'text-accent' : 'text-ink-400 hover:text-ink-200');
    tg.innerHTML =
      '<span style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;' +
      'border-radius:4px;font-size:10px;color:#fff;border:1.5px solid ' +
      (historyAiOnly ? '#1d9bd1' : '#5e6066') + ';background:' +
      (historyAiOnly ? '#1d9bd1' : 'transparent') + '">' + (historyAiOnly ? '✓' : '') + '</span>' +
      escapeHtml(t('historyAiOnly')) + ' seulement';
    tg.addEventListener('click', () => {
      historyAiOnly = !historyAiOnly;
      renderHistoryList(file);
    });
    historyList.appendChild(tg);
  }

  if (!shown.length) {
    const empty = document.createElement('div');

    empty.className = 'text-ink-500 px-2 py-2 text-xs';
    empty.textContent = t('historyNoAi');
    historyList.appendChild(empty);

    return;
  }

  shown.forEach((rev) => {
    const i = revisions.indexOf(rev); // absolute index → keeps diff/parent correct under the filter
    const when = formatRevDate(rev.date);
    const row = document.createElement('button');

    row.type = 'button';
    row.className =
      'history-rev block w-full text-left px-3 py-2 rounded-lg hover:bg-white/5 mb-0.5 transition';
    row.innerHTML =
      '<div class="text-ink-200 truncate">' +
      escapeHtml(rev.subject || '(' + rev.sha.slice(0, 7) + ')') +
      (rev.ai ? ' <span class="text-accent text-xs font-medium">· ' + escapeHtml(rev.ai) + '</span>' : '') +
      '</div>' +
      '<div class="text-xs text-ink-500 font-mono mt-0.5">' +
      escapeHtml(rev.sha.slice(0, 7)) +
      (when ? ' · ' + escapeHtml(when) : '') +
      (rev.author ? ' · ' + escapeHtml(rev.author) : '') +
      '</div>';
    row.addEventListener('click', () => {
      historyList.querySelectorAll('.history-rev').forEach((b) => b.classList.remove('bg-accent/15'));
      row.classList.add('bg-accent/15');
      historyCurrentSha = rev.sha;
      showVersion(file, revisions, i);
    });
    historyList.appendChild(row);
  });
  // Keep the shown revision selected across a filter toggle (no re-fetch → no flash);
  // only auto-load when nothing is selected yet or the selection was filtered out.
  const rows = historyList.querySelectorAll('.history-rev');
  const keepIdx = shown.findIndex((r) => r.sha === historyCurrentSha);
  if (keepIdx >= 0) rows[keepIdx].classList.add('bg-accent/15');
  else rows[0]?.click();
}

// `toggle` = { label, handler } for the secondary button: document view ↔ diff
// view. The document is the default (cf. row click).
function revisionHeader(file, revisions, i, toggle) {
  const rev = revisions[i];
  const wrap = document.createElement('div');

  wrap.className = 'mb-3 pb-2 border-b subtle-border';
  const when = rev.date ? new Date(rev.date).toLocaleString(LANG) : '';

  wrap.innerHTML =
    '<div class="text-ink-100 font-medium">' +
    escapeHtml(rev.subject || '') +
    '</div>' +
    '<div class="text-xs text-ink-500 font-mono mt-0.5">' +
    escapeHtml(rev.sha.slice(0, 7)) +
    (when ? ' · ' + escapeHtml(when) : '') +
    (rev.author ? ' · ' + escapeHtml(rev.author) : '') +
    '</div>';
  // Actions in a flex-wrap row (gap, no per-button margin): stay left-aligned
  // whether they sit on one line (desktop) or wrap to two (mobile) — the old
  // marginLeft hack left the wrapped button indented by 8px.
  const actions = document.createElement('div');

  actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:8px';
  const view = document.createElement('button');

  view.type = 'button';
  view.className =
    'px-3 py-1.5 text-sm font-medium bg-white/5 hover:bg-white/10 text-ink-200 rounded-lg transition';
  view.textContent = t(toggle.label);
  view.addEventListener('click', toggle.handler);
  actions.appendChild(view);
  const restore = document.createElement('button');

  restore.type = 'button';
  restore.className =
    'px-3 py-1.5 text-sm font-medium bg-accent/15 hover:bg-accent/25 text-accent rounded-lg transition';
  restore.textContent = t('historyRestore');
  restore.addEventListener('click', () => revertToRevision(file, rev));
  actions.appendChild(restore);
  wrap.appendChild(actions);

  return wrap;
}

async function showRevision(file, revisions, i) {
  const rev = revisions[i];
  const parent = revisions[i + 1]; // newest-first → the next entry is the older revision

  historyDetail.innerHTML = '';
  historyDetail.appendChild(
    revisionHeader(file, revisions, i, {
      label: 'historyViewVersion',
      handler: () => showVersion(file, revisions, i),
    }),
  );
  const body = document.createElement('div');

  body.className = 'text-ink-500';
  body.textContent = '…';
  historyDetail.appendChild(body);

  try {
    if (parent) {
      const data = await api(
        'GET',
        '/api/diff?path=' +
          encodeURIComponent(file.path) +
          '&from=' +
          parent.sha +
          '&to=' +
          rev.sha,
      );

      if (historyFile !== file) return;
      body.replaceWith(
        data.diff && data.diff.trim() ? diffToDom(data.diff) : simpleNode(t('historyNoChange')),
      );
    } else {
      // Oldest revision: no parent to diff against → show the full version as introduced.
      const data = await api(
        'GET',
        '/api/revision?path=' + encodeURIComponent(file.path) + '&rev=' + rev.sha,
      );

      if (historyFile !== file) return;
      body.replaceWith(plainTextNode(data.content));
    }
  } catch (e) {
    if (historyFile !== file) return;
    body.textContent = t('historyError');
    body.className = 'text-rose-400';
  }
}

// Default view when a revision is picked: the DOCUMENT at that revision (what the
// reader cares about first), with a button to switch to the git diff.
async function showVersion(file, revisions, i) {
  const rev = revisions[i];

  historyDetail.innerHTML = '';
  historyDetail.appendChild(
    revisionHeader(file, revisions, i, {
      label: 'historyViewChanges',
      handler: () => showRevision(file, revisions, i),
    }),
  );
  const wrap = document.createElement('div');

  // max-w-none: let the rendered version fill the (now wide) detail pane instead
  // of the default ~65ch prose cap, so md uses the room on large screens.
  wrap.className = 'prose prose-invert max-w-none text-base mt-1';
  wrap.innerHTML = '<p class="text-ink-500">…</p>';
  historyDetail.appendChild(wrap);
  let data;

  try {
    data = await api(
      'GET',
      '/api/revision?path=' + encodeURIComponent(file.path) + '&rev=' + rev.sha,
    );
  } catch (e) {
    if (historyFile !== file) return;
    wrap.innerHTML = '<p class="text-rose-400">' + escapeHtml(t('historyError')) + '</p>';

    return;
  }

  if (historyFile !== file) return;

  // .html doc: render the past version as-is in a sandboxed iframe (no markdown
  // pipeline), mirroring the live render (cf. renderHtmlFrame). srcdoc set as a
  // property so the raw HTML is never concatenated into the viewer DOM; its JS
  // runs in an opaque origin (allow-scripts, no same-origin) with no access to
  // the viewer's cookies/DOM.
  if (file.ext === '.html') {
    const frame = document.createElement('iframe');

    frame.setAttribute('sandbox', 'allow-scripts');
    frame.title = file.name;
    frame.srcdoc = data.content || '';
    frame.style.cssText =
      'width:100%;height:60vh;border:0;display:block;background:#0b0d13;border-radius:.5rem';
    wrap.replaceWith(frame);

    return;
  }

  wrap.innerHTML = renderMd(stripFrontmatter(data.content || '')); // sanitized via DOMPurify
}

// Restore a doc to a past revision by writing that content back as a new,
// forward-moving change (kept in git history). Admin-only server-side; CSRF is
// auto-injected by the global fetch wrapper.
async function revertToRevision(file, rev) {
  const ok = await confirmDialog({
    title: t('historyRestore'),
    message: t('historyRestoreConfirm'),
    confirmLabel: t('historyRestoreBtn'),
  });

  if (!ok) return;

  try {
    await api('POST', '/api/revert', { path: file.path, rev: rev.sha });
  } catch (e) {
    setStatus(t('historyRestoreError'), 'err');

    return;
  }

  contentCache.delete(file.path); // force a fresh load of the restored content
  closeHistory();
  setStatus(t('historyRestored'), 'info');
  showMarkdown(file);
}

function simpleNode(text) {
  const d = document.createElement('div');

  d.className = 'text-ink-500';
  d.textContent = text;

  return d;
}

function plainTextNode(text) {
  const pre = document.createElement('pre');

  pre.className = 'font-mono text-[15px] leading-relaxed text-ink-300';
  pre.style.whiteSpace = 'pre-wrap';
  pre.style.wordBreak = 'break-word';
  pre.textContent = text || '';

  return pre;
}

// Unified diff → escaped, color-coded DOM. Diff colors use inline styles because
// the green/emerald utilities aren't in the precompiled tailwind.css.
function diffToDom(diffText) {
  const wrap = document.createElement('div');

  wrap.className = 'font-mono text-[15px] leading-relaxed';
  wrap.style.whiteSpace = 'pre-wrap';
  wrap.style.wordBreak = 'break-word';
  // Skip everything before the first @@ (git plumbing: diff --git / index / --- /
  // +++, noise for a reader). Each @@ → a thin separator. After the first @@ every
  // line is content, so a content line starting with --- is rendered, not skipped.
  let hunks = 0;

  for (const line of (diffText || '').split('\n')) {
    if (line.startsWith('@@')) {
      if (hunks > 0) {
        const sep = document.createElement('div');

        sep.className = 'border-t subtle-border';
        sep.style.margin = '8px 0';
        wrap.appendChild(sep);
      }

      hunks++;
      continue;
    }

    if (hunks === 0) continue;
    const row = document.createElement('div');

    row.className = 'px-2';

    if (line[0] === '+') {
      row.style.color = '#86efac';
      row.style.background = 'rgba(16,185,129,0.10)';
    } else if (line[0] === '-') {
      row.style.color = '#fca5a5';
      row.style.background = 'rgba(244,63,94,0.10)';
    } else {
      row.className += ' text-ink-400';
    }

    row.textContent = line === '' ? ' ' : line;
    wrap.appendChild(row);
  }

  return wrap;
}

document.getElementById('btn-history').addEventListener('click', () => openHistory());
document.getElementById('history-close').addEventListener('click', closeHistory);
historyOverlay.addEventListener('click', (e) => {
  if (e.target === historyOverlay) closeHistory();
});

// Render a .html doc (slide deck, dashboard…) as-is in a sandboxed iframe.
// sandbox="allow-scripts" runs its JS but isolates it in an opaque origin (no
// access to the viewer's DOM/cookies); allow="fullscreen" enables fullscreen.
// The raw HTML is never injected into the viewer's DOM.

function renderHtmlFrame(file) {
  btnEdit.classList.add('hidden'); // no inline HTML editing via the viewer
  btnSave.classList.add('hidden');
  btnCancel.classList.add('hidden');
  // The prose article is narrow and padded: full width for the deck.
  contentEl.style.maxWidth = 'none';
  contentEl.style.padding = '0';
  const url =
    '/' +
    file.path.split('/').map(encodeURIComponent).join('/') +
    (file.mtime ? '?v=' + file.mtime : '');
  const u = escapeHtml(url);
  // Online: iframe src=URL. Offline (file://) the absolute URL doesn't resolve →
  // inject the embedded content via srcdoc.
  const offlineSrc =
    typeof IS_OFFLINE_BUILD !== 'undefined' && IS_OFFLINE_BUILD
      ? file.content != null
        ? file.content
        : typeof EMBED_CONTENT !== 'undefined'
          ? EMBED_CONTENT[file.path]
          : null
      : null;
  const frameAttr =
    offlineSrc != null ? 'srcdoc="' + escapeHtml(offlineSrc) + '"' : 'src="' + u + '"';

  contentEl.innerHTML =
    '<div class="flex items-center justify-between px-4 py-2 border-b border-navy-500 bg-navy-800 text-xs">' +
    '<span class="text-ink-400 font-mono">' +
    t('htmlDocBanner') +
    '</span>' +
    '<a href="' +
    u +
    '" target="_blank" rel="noopener" class="text-sky-400 hover:underline whitespace-nowrap ml-3">' +
    t('openFullscreen') +
    '</a>' +
    '</div>' +
    '<iframe ' +
    frameAttr +
    ' sandbox="allow-scripts" allow="fullscreen" title="' +
    escapeHtml(file.name) +
    '" ' +
    'style="width:100%;height:calc(100vh - 150px);border:0;display:block;background:#0b0d13"></iframe>';
  // TOC/backlinks/notes + todos widget make no sense over a standalone HTML doc:
  // hide them (restored on the next .md doc via showMarkdown).
  tocList.innerHTML = '';
  tocLinks.innerHTML = '';
  tocNotes.innerHTML = '';
  tocPanel.classList.add('hidden');
  tocPanel.classList.remove('flex');

  if (typeof tocShow !== 'undefined' && tocShow) tocShow.classList.add('hidden');
  document.getElementById('todo-widget')?.classList.add('hidden');
}

// Render a .pdf in the browser's native viewer via a same-origin iframe
// (X-Frame-Options SAMEORIGIN allows our own framing). Offline, a binary can't be
// inlined → we offer direct opening instead.
function renderPdfFrame(file) {
  btnEdit.classList.add('hidden');
  btnSave.classList.add('hidden');
  btnCancel.classList.add('hidden');
  contentEl.style.maxWidth = 'none';
  contentEl.style.padding = '0';
  const url =
    '/' +
    file.path.split('/').map(encodeURIComponent).join('/') +
    (file.mtime ? '?v=' + file.mtime : '');
  const u = escapeHtml(url);
  const offline = typeof IS_OFFLINE_BUILD !== 'undefined' && IS_OFFLINE_BUILD;
  const body = offline
    ? '<div class="p-6 text-sm text-ink-400">' +
      t('pdfOfflineHint') +
      ' <a href="' +
      u +
      '" class="text-sky-400 hover:underline">' +
      escapeHtml(file.name) +
      '</a></div>'
    : '<iframe src="' +
      u +
      '" title="' +
      escapeHtml(file.name) +
      '" style="width:100%;height:calc(100vh - 150px);border:0;display:block;background:#0b0d13"></iframe>';

  contentEl.innerHTML =
    '<div class="flex items-center justify-between px-4 py-2 border-b border-navy-500 bg-navy-800 text-xs">' +
    '<span class="text-ink-400 font-mono">' +
    t('pdfDocBanner') +
    '</span>' +
    '<a href="' +
    u +
    '" target="_blank" rel="noopener" class="text-sky-400 hover:underline whitespace-nowrap ml-3">' +
    t('openFullscreen') +
    '</a>' +
    '</div>' +
    body;
  tocList.innerHTML = '';
  tocLinks.innerHTML = '';
  tocNotes.innerHTML = '';
  tocPanel.classList.add('hidden');
  tocPanel.classList.remove('flex');

  if (typeof tocShow !== 'undefined' && tocShow) tocShow.classList.add('hidden');
  document.getElementById('todo-widget')?.classList.add('hidden');
}

// mammoth.js (DOCX → HTML) loaded ON DEMAND: ~640 KB, no point embedding it
// in the <head> when most sessions never open a .docx.
let _mammothPromise = null;

function loadMammoth() {
  if (window.mammoth) return Promise.resolve(window.mammoth);

  if (_mammothPromise) return _mammothPromise;
  _mammothPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');

    s.src = '/vendor/mammoth.min.js';
    s.onload = () => (window.mammoth ? resolve(window.mammoth) : reject(new Error('mammoth')));
    s.onerror = () => {
      _mammothPromise = null;
      reject(new Error('mammoth load failed'));
    };

    document.head.appendChild(s);
  });

  return _mammothPromise;
}

// .docx → HTML via mammoth, injected into .prose. Read-only, client-side.
async function renderDocxFrame(file) {
  btnEdit.classList.add('hidden');
  btnSave.classList.add('hidden');
  btnCancel.classList.add('hidden');
  contentEl.style.maxWidth = '';
  contentEl.style.padding = '';
  contentEl.innerHTML = renderSkeleton(file);
  tocList.innerHTML = '';
  tocLinks.innerHTML = '';
  tocNotes.innerHTML = '';
  tocPanel.classList.add('hidden');
  tocPanel.classList.remove('flex');

  if (typeof tocShow !== 'undefined' && tocShow) tocShow.classList.add('hidden');
  document.getElementById('todo-widget')?.classList.add('hidden');

  try {
    const mammoth = await loadMammoth();
    const url =
      '/' +
      file.path.split('/').map(encodeURIComponent).join('/') +
      (file.mtime ? '?v=' + file.mtime : '');
    const buf = await (await fetch(url, { cache: 'no-cache' })).arrayBuffer();

    if (currentFile !== file) return; // page changed during the fetch/parse
    const result = await mammoth.convertToHtml({ arrayBuffer: buf });

    if (currentFile !== file) return;
    contentEl.innerHTML = '<div class="docx-doc">' + DOMPurify.sanitize(result.value) + '</div>';
  } catch (e) {
    if (currentFile !== file) return;
    const url = '/' + file.path.split('/').map(encodeURIComponent).join('/');

    contentEl.innerHTML =
      '<div class="text-rose-400 text-sm">' +
      escapeHtml(t('docxError', e.message)) +
      ' <a href="' +
      escapeHtml(url) +
      '" class="text-sky-400 hover:underline">' +
      escapeHtml(file.name) +
      '</a></div>';
  }
}

// Strips the leading YAML frontmatter (--- ... ---) before rendering (same regex
// as the build). The raw content keeps the frontmatter (tag editing).

function stripFrontmatter(text) {
  return text.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, '');
}

function folderTagsOf(path) {
  return path
    .split('/')
    .slice(0, -1)
    .map((s) => s.toLowerCase());
}

// Clickable tag chips for the doc (→ view by tag).
function renderDocTags(file) {
  if (!file || file.ext !== '.md') return '';
  // Mirror doc = read-only: no +/× (any tag write would 403).
  const canEdit =
    !IS_OFFLINE_BUILD && !window.__viewerMode && !(file.path || '').startsWith('remotes/');
  const folderSet = new Set(folderTagsOf(file.path));
  const chips = (file.tags || [])
    .map((tg) =>
      folderSet.has(tg)
        ? '<span class="doc-tag doc-tag-folder" data-tag="' +
          escapeHtml(tg) +
          '" title="' +
          escapeHtml(t('folderTagTitle')) +
          '">#' +
          escapeHtml(tg) +
          '</span>'
        : '<span class="doc-tag" data-tag="' +
          escapeHtml(tg) +
          '">#' +
          escapeHtml(tg) +
          (canEdit
            ? '<button class="doc-tag-x" data-removetag="' +
              escapeHtml(tg) +
              '" title="' +
              escapeHtml(t('removeTag')) +
              '">×</button>'
            : '') +
          '</span>',
    )
    .join('');

  if (!chips && !canEdit) return '';

  return (
    '<div class="doc-tags not-prose">' +
    chips +
    (canEdit
      ? '<button class="doc-tag-add" title="' + escapeHtml(t('addTag')) + '">+</button>'
      : '') +
    '</div>'
  );
}

function allTagsList() {
  const s = new Set();

  for (const f of Object.values(fileMap))
    if (f.ext === '.md') for (const t of f.tags || []) s.add(t);

  return [...s].sort();
}

// Rewrites the `tags:` frontmatter key (custom tags only — folder tags are derived
// at build). Empty list → removes the key (and the frontmatter block if it empties).
function setFrontmatterTags(content, customTags) {
  const tagsLine = customTags.length ? 'tags: [' + customTags.join(', ') + ']' : null;
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
    const cleaned = out.filter((l) => l.trim().length).join('\n');
    const body = content.slice(m[0].length).replace(/^\n+/, '');

    return cleaned ? '---\n' + cleaned + '\n---\n\n' + body : body;
  }

  return tagsLine ? '---\n' + tagsLine + '\n---\n\n' + content : content;
}

// Persists custom tags: rewrite frontmatter, PUT /api/file (server rebuilds +
// commits), then update fileMap and re-render the chips locally.
async function persistTags(file, customTags) {
  let raw;

  try {
    raw = await loadContent(file);
  } catch (e) {
    return false;
  }

  const newContent = setFrontmatterTags(raw, customTags);

  try {
    const res = await fetch('/api/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: file.path, content: newContent }),
    });

    if (!res.ok) throw new Error('HTTP ' + res.status);
  } catch (err) {
    notifyError('tagSaveFailed', err.message);

    return false;
  }

  contentCache.set(file.path, newContent);
  file.content = newContent;
  const merged = folderTagsOf(file.path);

  for (const t of customTags) if (!merged.includes(t)) merged.push(t);
  file.tags = merged;

  if (currentFile === file) {
    const wrap = contentEl.querySelector('.doc-tags');

    if (wrap) wrap.outerHTML = renderDocTags(file);
  }

  return true;
}

async function addCustomTag(file, tag) {
  tag = (tag || '').trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-');

  if (!file || !tag) return;
  const folderSet = new Set(folderTagsOf(file.path));

  if (folderSet.has(tag)) return; // already covered by the folder
  const custom = (file.tags || []).filter((t) => !folderSet.has(t));

  if (custom.includes(tag)) return;
  custom.push(tag);
  await persistTags(file, custom);
}

async function removeCustomTag(file, tag) {
  if (!file) return;
  const folderSet = new Set(folderTagsOf(file.path));
  const custom = (file.tags || []).filter((t) => !folderSet.has(t) && t !== tag);

  await persistTags(file, custom);
}

// Tag editing popup anchored below the « + » button.
let tagEditorEl = null;
let tagEditorCb = null;

function closeTagEditor() {
  if (tagEditorCb) {
    tagEditorCb.destroy();
    tagEditorCb = null;
  }
  if (tagEditorEl) {
    tagEditorEl.remove();
    tagEditorEl = null;
  }
}

function openTagEditor(file, anchorEl) {
  if (!file) return;
  closeTagEditor();
  const folderSet = new Set(folderTagsOf(file.path));
  const el = document.createElement('div');

  el.id = 'tag-editor';
  el.className =
    'fixed z-50 w-64 bg-navy-800 border subtle-border rounded-lg shadow-2xl shadow-black/70 p-3';
  el.innerHTML =
    '<div class="text-[11px] uppercase tracking-wider text-ink-500 font-semibold mb-2 font-sans">' +
    t('tagEditorTitle') +
    '</div>' +
    '<div id="tag-ed-list" class="flex flex-wrap gap-1.5 mb-2"></div>' +
    '<input id="tag-ed-input" placeholder="' +
    escapeHtml(t('tagPlaceholder')) +
    '" autocomplete="off" class="w-full px-3 py-2 text-sm bg-black/30 border subtle-border rounded text-ink-100 placeholder-ink-500 focus:outline-none focus:ring-2 focus:ring-accent/40">' +
    '<div class="text-[10px] text-ink-500 mt-1.5 font-sans">' +
    t('tagEditorHint') +
    '</div>';
  document.body.appendChild(el);
  tagEditorEl = el;
  const r = anchorEl.getBoundingClientRect();

  el.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 272)) + 'px';
  el.style.top = r.bottom + 6 + 'px';
  const input = el.querySelector('#tag-ed-input');
  const renderList = () => {
    const cur = (file.tags || []).filter((t) => !folderSet.has(t));
    const box = el.querySelector('#tag-ed-list');

    box.innerHTML = cur.length
      ? cur
          .map(
            (t) =>
              '<span class="doc-tag" style="cursor:default">#' +
              escapeHtml(t) +
              '<button class="doc-tag-x" data-ed-rm="' +
              escapeHtml(t) +
              '">×</button></span>',
          )
          .join('')
      : '<span class="text-[11px] text-ink-500">' + t('noCustomTags') + '</span>';
    box.querySelectorAll('[data-ed-rm]').forEach((b) =>
      b.addEventListener('click', async () => {
        await removeCustomTag(file, b.dataset.edRm);
        renderList();
      }),
    );
  };

  renderList();
  tagEditorCb = AtlasCombobox(input, {
    source: allTagsList,
    creatable: true,
    onSelect: async (v) => {
      input.value = '';
      if (v && v.trim()) {
        await addCustomTag(file, v);
        renderList();
        tagEditorCb.refresh();
      }
    },
  });
  input.focus();
  input.addEventListener('keydown', (e) => {
    // Enter is handled by the combobox (select/create → onSelect). Escape here
    // closes the editor (the combobox swallowed it if its dropdown was open).
    if (e.key === 'Escape') {
      e.preventDefault();
      closeTagEditor();
    }
  });
}

document.addEventListener('click', (e) => {
  if (tagEditorEl && !tagEditorEl.contains(e.target) && !e.target.closest('.doc-tag-add'))
    closeTagEditor();
});

// View « all docs carrying this tag ».
function showTag(tag) {
  if (editMode) exitEditMode(false);
  currentFile = null;
  document.querySelector('main').scrollTop = 0;
  const docs = Object.values(fileMap)
    .filter((f) => f.ext === '.md' && (f.tags || []).includes(tag))
    .sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  let html =
    '<h1 class="!mb-1">#' +
    escapeHtml(tag) +
    '</h1>' +
    '<p class="lead text-ink-400 !mt-0">' +
    t('docsWithTag', docs.length) +
    '</p>' +
    '<ul class="not-prose mt-6 space-y-2">';

  for (const f of docs) {
    html +=
      '<li><a class="block p-3 bg-black/20 hover:bg-black/30 border subtle-border rounded-lg cursor-pointer transition" data-tagdoc="' +
      escapeHtml(f.path) +
      '">' +
      '<div class="text-sm text-ink-100 font-medium font-sans truncate">' +
      escapeHtml(f.name) +
      '</div>' +
      '<div class="text-[10px] text-ink-500 mt-0.5 font-mono truncate">' +
      escapeHtml(f.path) +
      '</div></a></li>';
  }

  contentEl.innerHTML = html + '</ul>';
  contentEl.querySelectorAll('[data-tagdoc]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const f = fileMap[a.dataset.tagdoc];

      if (f) {
        showMarkdown(f);
        history.replaceState(null, '', '#' + encodeURIComponent(f.path));
      }
    }),
  );
  breadcrumbPath.textContent = '#' + tag;
  breadcrumbDate.textContent = '';
  breadcrumbActions.classList.add('hidden');
  breadcrumbActions.classList.remove('flex');
  tocPanel.classList.add('hidden');
  tocPanel.classList.remove('flex');
  document.querySelectorAll('.tree-item').forEach((el) => el.classList.remove('active'));
}

// Delegation: clicks on tag chips and wikilinks rendered in the content.
contentEl.addEventListener('click', (e) => {
  const rm = e.target.closest('[data-removetag]');

  if (rm) {
    e.preventDefault();
    e.stopPropagation();
    removeCustomTag(currentFile, rm.dataset.removetag);

    return;
  }

  const add = e.target.closest('.doc-tag-add');

  if (add) {
    e.preventDefault();
    openTagEditor(currentFile, add);

    return;
  }

  const tagBtn = e.target.closest('.doc-tag');

  if (tagBtn && tagBtn.dataset.tag) {
    e.preventDefault();
    showTag(tagBtn.dataset.tag);

    return;
  }

  const wl = e.target.closest('a.wikilink');

  if (wl) {
    e.preventDefault();
    const f = wl.dataset.path && fileMap[wl.dataset.path];

    if (f) {
      showMarkdown(f);
      history.replaceState(null, '', '#' + encodeURIComponent(f.path));
    }
  }
});

// Highlights + scrolls to the 1st occurrence of a search term in the rendered doc.
// Walks text nodes to avoid breaking marked's HTML. Case-insensitive; on an accent
// mismatch there's no match and the scroll stays at the top.
function highlightFirstMatch(container, query) {
  const tokens = query
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  if (!tokens.length) return;
  const re = new RegExp('(' + tokens.join('|') + ')', 'i');
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.nodeValue && re.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  });
  const node = walker.nextNode();

  if (!node) return;
  const m = node.nodeValue.match(re);

  if (!m) return;
  const after = node.splitText(m.index);

  after.nodeValue = after.nodeValue.slice(m[0].length);
  const mark = document.createElement('mark');

  mark.className = 'search-hit';
  mark.textContent = m[0];
  after.parentNode.insertBefore(mark, after);
  mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function mdInsertWrap(before, after, placeholderIfEmpty) {
  if (!editTextarea) return;
  const start = editTextarea.selectionStart;
  const end = editTextarea.selectionEnd;
  const sel = editTextarea.value.substring(start, end) || placeholderIfEmpty || '';
  const replacement = before + sel + after;

  editTextarea.setRangeText(replacement, start, end, 'end');

  if (
    !editTextarea.value.substring(start, end + replacement.length - (before.length + after.length))
  ) {
    editTextarea.selectionStart = editTextarea.selectionEnd = start + before.length + sel.length;
  } else {
    editTextarea.selectionStart = start + before.length;
    editTextarea.selectionEnd = start + before.length + sel.length;
  }

  editTextarea.dispatchEvent(new Event('input'));
}

function mdInsertLineStart(prefix) {
  if (!editTextarea) return;
  const v = editTextarea.value;
  const start = editTextarea.selectionStart;
  let lineStart = start;

  while (lineStart > 0 && v[lineStart - 1] !== '\n') lineStart--;
  editTextarea.setRangeText(prefix, lineStart, lineStart, 'end');
  editTextarea.selectionStart = editTextarea.selectionEnd = start + prefix.length;
  editTextarea.dispatchEvent(new Event('input'));
}

function mdInsertAtCursor(text) {
  if (!editTextarea) return;
  const start = editTextarea.selectionStart;

  editTextarea.setRangeText(text, start, editTextarea.selectionEnd, 'end');
  editTextarea.dispatchEvent(new Event('input'));
}

function mdHandleAction(action) {
  if (!editTextarea) return;
  editTextarea.focus();

  switch (action) {
    case 'bold':
      mdInsertWrap('**', '**', t('phText'));
      break;
    case 'italic':
      mdInsertWrap('*', '*', t('phText'));
      break;
    case 'strike':
      mdInsertWrap('~~', '~~', t('phText'));
      break;
    case 'h1':
      mdInsertLineStart('# ');
      break;
    case 'h2':
      mdInsertLineStart('## ');
      break;
    case 'h3':
      mdInsertLineStart('### ');
      break;
    case 'ul':
      mdInsertLineStart('- ');
      break;
    case 'ol':
      mdInsertLineStart('1. ');
      break;
    case 'todo':
      mdInsertLineStart('- [ ] ');
      break;
    case 'quote':
      mdInsertLineStart('> ');
      break;
    case 'link':
      mdInsertWrap('[', '](url)', t('phLabel'));
      break;
    case 'code':
      mdInsertWrap('`', '`', 'code');
      break;
    case 'codeblock':
      mdInsertWrap('\n```\n', '\n```\n', 'code');
      break;
    case 'hr':
      mdInsertAtCursor('\n\n---\n\n');
      break;
    case 'table':
      mdInsertAtCursor('\n| Col 1 | Col 2 |\n| --- | --- |\n| A | B |\n');
      break;
  }
}

const MD_TOOLBAR_HTML =
  '' +
  '<button data-md="bold" class="md-tb-btn" title="' +
  t('tbBold') +
  '"><b>B</b></button>' +
  '<button data-md="italic" class="md-tb-btn" title="' +
  t('tbItalic') +
  '"><i>I</i></button>' +
  '<button data-md="strike" class="md-tb-btn" title="' +
  t('tbStrike') +
  '"><s>S</s></button>' +
  '<span class="md-tb-sep"></span>' +
  '<button data-md="h1" class="md-tb-btn">H1</button>' +
  '<button data-md="h2" class="md-tb-btn">H2</button>' +
  '<button data-md="h3" class="md-tb-btn">H3</button>' +
  '<span class="md-tb-sep"></span>' +
  '<button data-md="ul" class="md-tb-btn" title="' +
  t('tbUl') +
  '">' +
  t('tbUlLabel') +
  '</button>' +
  '<button data-md="ol" class="md-tb-btn" title="' +
  t('tbOl') +
  '">' +
  t('tbOlLabel') +
  '</button>' +
  '<button data-md="todo" class="md-tb-btn" title="' +
  t('tbTodo') +
  '">☐ Todo</button>' +
  '<button data-md="quote" class="md-tb-btn" title="' +
  t('tbQuote') +
  '">' +
  t('tbQuoteLabel') +
  '</button>' +
  '<span class="md-tb-sep"></span>' +
  '<button data-md="link" class="md-tb-btn" title="' +
  t('tbLink') +
  '">' +
  t('tbLinkLabel') +
  '</button>' +
  '<button data-md="code" class="md-tb-btn" title="' +
  t('tbCode') +
  '">&lt;/&gt;</button>' +
  '<button data-md="codeblock" class="md-tb-btn" title="' +
  t('tbCodeblock') +
  '">' +
  t('tbCodeblockLabel') +
  '</button>' +
  '<button data-md="table" class="md-tb-btn" title="' +
  t('tbTable') +
  '">⊞ Table</button>' +
  '<button data-md="hr" class="md-tb-btn" title="' +
  t('tbHr') +
  '">— HR</button>';

// ─── [[wikilink]] autocomplete in the editor ──────────────────────────────────
// Triggered by typing `[[`: suggests docs (filtered by name/path), keyboard nav,
// inserts an always-resolvable target (name only if unique, full path otherwise).
// Client-side, from fileMap.
let wlOpen = false,
  wlItems = [],
  wlActive = 0,
  wlStart = -1,
  wlCands = null,
  wlMenuEl = null;

function wlMenu() {
  if (wlMenuEl) return wlMenuEl;
  wlMenuEl = document.createElement('div');
  wlMenuEl.id = 'wl-autocomplete';
  wlMenuEl.className =
    'fixed z-50 hidden w-80 max-h-64 overflow-y-auto rounded-md border subtle-border bg-navy-800 shadow-xl scrollbar-thin text-sm';
  document.body.appendChild(wlMenuEl);
  wlMenuEl.addEventListener('mousedown', (e) => {
    const opt = e.target.closest('.wl-opt');

    if (!opt) return;
    e.preventDefault(); // keeps the textarea focus
    wlInsert(+opt.dataset.i);
  });
  document.addEventListener('mousedown', (e) => {
    if (wlOpen && !wlMenuEl.contains(e.target) && e.target !== editTextarea) wlClose();
  });

  return wlMenuEl;
}

function wlClose() {
  wlOpen = false;
  wlStart = -1;
  wlItems = [];

  if (wlMenuEl) {
    wlMenuEl.classList.add('hidden');
    wlMenuEl.innerHTML = '';
  }
}

function wlBuildCands() {
  const out = [];

  for (const f of Object.values(fileMap)) {
    if (!WL_TARGET_EXTS.includes(f.ext)) continue;
    const stem = f.name.replace(/\.[^.]+$/, '');

    out.push({
      path: f.path,
      label: stem,
      sub: f.path,
      mtime: f.mtime || 0,
      _name: stem.toLowerCase(),
      _hay: (stem + ' ' + f.path).toLowerCase(),
    });
  }

  return out;
}

function wlQueryAtCursor() {
  const v = editTextarea.value,
    cur = editTextarea.selectionStart;
  const open = v.lastIndexOf('[[', cur - 2);

  if (open === -1 || open + 2 > cur) return null;
  const between = v.slice(open + 2, cur);

  if (/[\]\n]/.test(between)) return null;

  return { start: open, query: between };
}

function wlFilter(query) {
  if (!wlCands) wlCands = wlBuildCands();
  const q = query.trim().toLowerCase();
  let res;

  if (q) {
    res = wlCands.filter((c) => c._hay.includes(q));
    const rank = (c) => (c._name.startsWith(q) ? 0 : c._name.includes(q) ? 1 : 2);

    res.sort((a, b) => rank(a) - rank(b) || b.mtime - a.mtime);
  } else {
    res = wlCands.slice().sort((a, b) => b.mtime - a.mtime);
  }

  return res.slice(0, 8);
}

function wlRender() {
  const m = wlMenu();

  m.innerHTML = wlItems
    .map(
      (c, i) =>
        '<div class="wl-opt px-3 py-1.5 cursor-pointer ' +
        (i === wlActive ? 'bg-white/10' : '') +
        '" data-i="' +
        i +
        '">' +
        '<div class="text-ink-100 truncate">' +
        escapeHtml(c.label) +
        '</div>' +
        '<div class="text-[11px] text-ink-400 truncate">' +
        escapeHtml(c.sub) +
        '</div>' +
        '</div>',
    )
    .join('');
  m.classList.remove('hidden');

  if (m.children[wlActive]) m.children[wlActive].scrollIntoView({ block: 'nearest' });
}

function wlCaretCoords() {
  const ta = editTextarea,
    pos = ta.selectionStart,
    s = getComputedStyle(ta);
  const div = document.createElement('div');

  [
    'boxSizing',
    'width',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'borderTopWidth',
    'borderRightWidth',
    'borderBottomWidth',
    'borderLeftWidth',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'fontStyle',
    'letterSpacing',
    'lineHeight',
    'textTransform',
    'wordSpacing',
    'textIndent',
    'tabSize',
  ].forEach((p) => {
    div.style[p] = s[p];
  });
  div.style.position = 'absolute';
  div.style.visibility = 'hidden';
  div.style.whiteSpace = 'pre-wrap';
  div.style.wordWrap = 'break-word';
  div.style.overflow = 'hidden';
  div.textContent = ta.value.slice(0, pos);
  const span = document.createElement('span');

  span.textContent = ta.value.slice(pos) || '.';
  div.appendChild(span);
  document.body.appendChild(div);
  const lh = parseInt(s.lineHeight, 10) || parseInt(s.fontSize, 10) || 16;
  const rect = ta.getBoundingClientRect();
  const top = rect.top + span.offsetTop - ta.scrollTop + lh;
  const left = rect.left + span.offsetLeft - ta.scrollLeft;

  document.body.removeChild(div);

  return { top, left, lineHeight: lh };
}

function wlPosition() {
  const m = wlMenu();
  const c = wlCaretCoords();
  let top = c.top + 4,
    left = c.left;
  const mh = m.offsetHeight || 200,
    mw = m.offsetWidth || 320;

  if (top + mh > window.innerHeight - 8) top = c.top - c.lineHeight - mh - 4;

  if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
  m.style.top = Math.max(8, top) + 'px';
  m.style.left = Math.max(8, left) + 'px';
}

function wlTargetFor(path) {
  const stem = fileMap[path].name.replace(/\.[^.]+$/, '');
  const stemLc = stem.toLowerCase();
  let count = 0;

  for (const f of Object.values(fileMap)) {
    if (WL_TARGET_EXTS.includes(f.ext) && f.name.replace(/\.[^.]+$/, '').toLowerCase() === stemLc)
      count++;
  }

  return count <= 1 ? stem : path.replace(/\.[^.]+$/, '');
}

function wlUpdate() {
  if (!editTextarea) return;
  const q = wlQueryAtCursor();

  if (!q) {
    wlClose();

    return;
  }

  wlStart = q.start;
  wlItems = wlFilter(q.query);

  if (!wlItems.length) {
    wlClose();

    return;
  }

  wlActive = 0;
  wlOpen = true;
  wlRender();
  wlPosition();
}

function wlInsert(i) {
  const c = wlItems[i];

  if (!c || wlStart < 0) {
    wlClose();

    return;
  }

  const cur = editTextarea.selectionStart;

  editTextarea.setRangeText('[[' + wlTargetFor(c.path) + ']]', wlStart, cur, 'end');
  wlClose();
  editTextarea.focus();
  editTextarea.dispatchEvent(new Event('input'));
}

function wlHandleKeydown(e) {
  if (!wlOpen) return false;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    wlActive = (wlActive + 1) % wlItems.length;
    wlRender();

    return true;
  }

  if (e.key === 'ArrowUp') {
    e.preventDefault();
    wlActive = (wlActive - 1 + wlItems.length) % wlItems.length;
    wlRender();

    return true;
  }

  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    wlInsert(wlActive);

    return true;
  }

  if (e.key === 'Escape') {
    e.preventDefault();
    wlClose();

    return true;
  }

  return false;
}

async function enterEditMode() {
  if (!currentFile) return;
  // Make sure we have the content before switching to edit mode.
  let content;

  try {
    content = await loadContent(currentFile);
  } catch (e) {
    notifyError('cantLoadDoc', e.message);

    return;
  }

  editMode = true;
  contentEl.classList.remove('max-w-4xl', 'px-10', 'py-10', 'prose', 'prose-invert');
  contentEl.classList.add('max-w-none', 'px-4', 'py-4');

  const wrap = document.createElement('div');

  wrap.className = 'flex flex-col';
  wrap.style.height = 'calc(100vh - 11rem)';

  const toolbar = document.createElement('div');

  toolbar.className =
    'flex flex-wrap items-center gap-1 px-3 py-2 border subtle-border rounded-t-md bg-navy-800';
  toolbar.innerHTML = MD_TOOLBAR_HTML;

  const splitWrap = document.createElement('div');

  splitWrap.className =
    'flex flex-1 min-h-0 border-l border-r border-b subtle-border rounded-b-md overflow-hidden bg-navy-900';

  editTextarea = document.createElement('textarea');
  editTextarea.id = 'md-editor';
  editTextarea.value = content;
  editTextarea.spellcheck = false;
  editTextarea.className =
    'min-w-0 p-5 bg-transparent text-ink-100 resize-none focus:outline-none scrollbar-thin';
  editTextarea.style.flex = '1 1 0';

  const divider = document.createElement('div');

  divider.className = 'w-px bg-[#2a2a32] flex-shrink-0';

  const preview = document.createElement('article');

  preview.id = 'md-preview';
  preview.className =
    'min-w-0 px-8 py-6 overflow-y-auto scrollbar-thin prose prose-sm prose-invert max-w-none';
  preview.style.flex = '1 1 0';
  preview.innerHTML = renderMd(content);

  splitWrap.appendChild(editTextarea);
  splitWrap.appendChild(divider);
  splitWrap.appendChild(preview);

  wrap.appendChild(toolbar);
  wrap.appendChild(splitWrap);

  contentEl.innerHTML = '';
  contentEl.appendChild(wrap);

  toolbar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-md]');

    if (btn) mdHandleAction(btn.dataset.md);
  });

  wlCands = null; // recomputed on the 1st keystroke (catches any new docs)
  let previewTimer = null;

  editTextarea.addEventListener('input', () => {
    wlUpdate();
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      preview.innerHTML = renderMd(editTextarea.value);
    }, 150);
  });
  editTextarea.addEventListener('blur', () => setTimeout(wlClose, 150));
  editTextarea.addEventListener('keydown', (e) => {
    if (wlHandleKeydown(e)) return;

    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();

      if (k === 'b') {
        e.preventDefault();
        mdHandleAction('bold');

        return;
      }

      if (k === 'i') {
        e.preventDefault();
        mdHandleAction('italic');

        return;
      }

      if (k === 'l') {
        e.preventDefault();
        mdHandleAction('link');

        return;
      }
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      mdInsertAtCursor('  ');
    }
  });

  editTextarea.focus();
  editTextarea.setSelectionRange(0, 0);
  editTextarea.scrollTop = 0;

  btnEdit.classList.add('hidden');
  btnSave.classList.remove('hidden');
  btnCancel.classList.remove('hidden');
  // Extensions hook: entering edit mode (hide their doc actions).
  document.dispatchEvent(new CustomEvent('atlas:edit-enter'));
  tocPanel.classList.add('hidden');
  tocPanel.classList.remove('flex');

  if (typeof tocShow !== 'undefined' && tocShow) tocShow.classList.add('hidden');
}

async function saveEdit() {
  if (!editMode || !currentFile) return;

  if (!isServerMode) {
    notifyError('fileModeNoEdit');

    return;
  }

  const newContent = editTextarea.value;

  btnSave.disabled = true;
  btnSave.textContent = t('saving');

  try {
    const res = await fetch('/api/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: currentFile.path, content: newContent }),
    });

    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();

    currentFile.content = newContent;
    contentCache.set(currentFile.path, newContent);
    currentFile.mtime = data.mtime || Math.floor(Date.now() / 1000);
    // Neutralize the live-reload SSE that follows the commit, to avoid a 2nd
    // re-render (flash) on top of the one done when exiting edit mode. Same trick
    // as the checkboxes.
    _selfSaveUntil[currentFile.path] = Date.now() + 6000;
    exitEditMode(true);
  } catch (e) {
    notifyError('err', e.message);
  } finally {
    btnSave.disabled = false;
    btnSave.textContent = t('saveBtn');
  }
}

function exitEditMode(reload) {
  wlClose();
  editMode = false;
  editTextarea = null;
  contentEl.classList.add('max-w-4xl', 'px-10', 'py-10', 'prose', 'prose-invert');
  contentEl.classList.remove('max-w-none', 'px-4', 'py-4');

  if (reload && currentFile) showMarkdown(currentFile);
  else if (currentFile) {
    btnEdit.classList.remove('hidden');
    btnSave.classList.add('hidden');
    btnCancel.classList.add('hidden');
    // Re-render from the cached content (always present since we were editing).
    const cached =
      currentFile.content != null ? currentFile.content : contentCache.get(currentFile.path);

    contentEl.innerHTML = renderMd(cached || '');
    attachCopyButtons();
    wireTaskCheckboxes(currentFile, cached || '');
    renderBacklinksFor(currentFile);
    buildToc();
    document.dispatchEvent(
      new CustomEvent('atlas:doc-rendered', {
        detail: { path: currentFile.path, markdown: cached || '' },
      }),
    );
  }
}

btnEdit.addEventListener('click', enterEditMode);
btnSave.addEventListener('click', saveEdit);
btnCancel.addEventListener('click', () => exitEditMode(false));

// ─── Search (MiniSearch, lazy-loaded on first call) ───────────────────────────────
let miniSearch = null;
let searchInitPromise = null;
const SEARCH_FIELDS = ['name', 'path', 'content'];
const SEARCH_STORE = ['name', 'path', 'preview'];

// Local lib (/vendor/); in an offline build (file://) it's inlined into the
// monolith by build.py, so the typeof short-circuits — no fetch.
async function loadMiniSearchLib() {
  if (typeof MiniSearch !== 'undefined') return;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');

    s.src = '/vendor/minisearch.min.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error(t('cdnFailMiniSearch')));
    document.head.appendChild(s);
  });
}

// MiniSearch is only used in offline builds (file://, no server). Online,
// search goes through /api/search. We index the already-embedded content.
async function getSearchData() {
  const docs = [];

  for (const f of Object.values(fileMap)) {
    if (f.ext !== '.md') continue;
    const c = EMBED_CONTENT[f.path] || '';

    docs.push({ id: f.path, name: f.name, path: f.path, content: c, preview: c.slice(0, 240) });
  }

  return docs;
}

async function initMiniSearch() {
  if (miniSearch) return miniSearch;

  if (searchInitPromise) return searchInitPromise;
  searchInitPromise = (async () => {
    await loadMiniSearchLib();
    const docs = await getSearchData();
    const ms = new MiniSearch({
      idField: 'id',
      fields: SEARCH_FIELDS,
      storeFields: SEARCH_STORE,
      searchOptions: {
        boost: { name: 3, path: 2 },
        fuzzy: 0.2,
        prefix: true,
        combineWith: 'AND',
      },
      tokenize: (text) =>
        text
          .normalize('NFD')
          .replace(/[̀-ͯ]/g, '')
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter(Boolean),
      processTerm: (term) => term.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(),
    });

    ms.addAll(docs);
    miniSearch = ms;

    return ms;
  })();

  return searchInitPromise;
}

function makeSnippet(preview, query) {
  if (!preview) return '';
  const words = query
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/\s+/)
    .filter(Boolean);
  const lower = preview.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  let idx = -1,
    term = null;

  for (const w of words) {
    const i = lower.indexOf(w);

    if (i >= 0 && (idx < 0 || i < idx)) {
      idx = i;
      term = w;
    }
  }

  if (idx < 0) return preview.slice(0, 160) + (preview.length > 160 ? '…' : '');
  const start = Math.max(0, idx - 40);
  const end = Math.min(preview.length, idx + term.length + 80);

  return (start > 0 ? '…' : '') + preview.slice(start, end) + (end < preview.length ? '…' : '');
}

// Online: server-side search (/api/search) → transfer O(results), nothing to
// download. Offline (file:// monolith): MiniSearch over the embedded content.
// Each branch returns a normalized array [{path, snippet}].
async function getSearchHits(q) {
  if (IS_OFFLINE_BUILD) {
    const ms = await initMiniSearch();
    const matches = ms.search(q, { boost: { name: 3, path: 2 }, fuzzy: 0.2, prefix: true });

    return matches.map((m) => ({ path: m.path, snippet: makeSnippet(m.preview || '', q) }));
  }

  const res = await fetch('/api/search?q=' + encodeURIComponent(q) + '&limit=50', {
    cache: 'no-store',
  });

  if (!res.ok) throw new Error('search HTTP ' + res.status);
  const hits = await res.json();

  return hits.map((h) => ({ path: h.path, snippet: h.snippet || '' }));
}

async function renderSearchResults(q) {
  searchResultsEl.innerHTML =
    '<div class="px-3 py-4 text-xs text-ink-500">' + t('searching') + '</div>';
  let hits;

  try {
    hits = await getSearchHits(q);
  } catch (e) {
    searchResultsEl.innerHTML =
      '<div class="px-3 py-4 text-xs text-rose-400">' + escapeHtml(t('err', e.message)) + '</div>';

    return;
  }

  if (searchEl.value.trim() !== q) return; // user typed something else in the meantime

  if (hits.length === 0) {
    searchResultsEl.innerHTML =
      '<div class="px-3 py-4 text-xs text-ink-500">' + escapeHtml(t('noResults', q)) + '</div>';

    return;
  }

  const top = hits.slice(0, 50);

  searchResultsEl.innerHTML =
    '<div class="px-2 pb-2 text-[10px] uppercase tracking-wider text-ink-500 font-semibold">' +
    t('nResults', hits.length) +
    (hits.length > 50 ? t('cappedSuffix') : '') +
    '</div>';
  const tokens = q
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .split(/\s+/)
    .filter(Boolean);
  const highlightRe = tokens.length ? new RegExp('(' + tokens.join('|') + ')', 'gi') : null;

  for (const m of top) {
    const file = fileMap[m.path];

    if (!file) continue;
    const a = document.createElement('a');

    a.className = 'tree-item block px-2 py-1.5 rounded cursor-pointer text-ink-200 mb-0.5';
    a.dataset.path = file.path;
    const snippet = m.snippet;
    const snippetHtml =
      snippet && highlightRe
        ? '<div class="text-[11px] text-ink-400 mt-0.5 leading-snug">' +
          escapeHtml(snippet).replace(
            highlightRe,
            '<mark class="bg-blue-500/30 text-blue-200 rounded px-0.5">$1</mark>',
          ) +
          '</div>'
        : '';

    a.innerHTML =
      '<div class="text-sm font-medium text-ink-100 truncate">' +
      escapeHtml(file.name) +
      '</div><div class="text-[10px] text-ink-500">' +
      file.path +
      '</div>' +
      snippetHtml;

    if (file.ext === '.md' || file.ext === '.html') {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        showMarkdown(file, q);
      });
    } else {
      a.href = encodeURI(file.path);
    }

    searchResultsEl.appendChild(a);
  }
}

let searchDebounce = null;

searchEl.addEventListener('input', () => {
  const q = searchEl.value.trim();

  clearTimeout(searchDebounce);

  if (!q) {
    searchResultsEl.classList.add('hidden');
    treeEl.classList.remove('hidden');
    if (treeHeaderEl) treeHeaderEl.classList.remove('hidden');

    if (recentList.children.length > 0) recentSection.classList.remove('hidden');

    return;
  }

  treeEl.classList.add('hidden');
  if (treeHeaderEl) treeHeaderEl.classList.add('hidden');
  recentSection.classList.add('hidden');
  searchResultsEl.classList.remove('hidden');
  searchDebounce = setTimeout(() => renderSearchResults(q), 140);
});

// Recent files (top 5 most recent .md)

function renderRecent() {
  const files = Object.values(fileMap)
    .filter((f) => f.ext === '.md' && f.mtime)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 3);

  if (files.length === 0) return;
  recentSection.classList.remove('hidden');
  recentList.innerHTML = files
    .map(
      (f) => `
    <li class="overflow-hidden"><a class="tree-item w-full flex flex-col px-2 py-1 rounded cursor-pointer" data-path="${f.path}">
      <span class="block text-xs text-ink-200 truncate w-full" data-name="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
      <span class="text-[10px] text-ink-500">${relativeDate(f.mtime)}</span>
    </a></li>
  `,
    )
    .join('');
  recentList.querySelectorAll('a').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const f = fileMap[a.dataset.path];

      if (f) {
        showMarkdown(f);
        history.replaceState(null, '', '#' + encodeURIComponent(f.path));
      }
    });
  });
}

renderRecent();

// "Shared with me": docs another member shared WITH the viewer, discovered
// via /api/shared-with-me. Cloud-only and fully defensive — any failure (offline
// build, local mode, empty list, network error) just leaves the section hidden, so
// it can never break the home view.
async function renderSharedWithMe() {
  if (!sharedSection || IS_OFFLINE_BUILD || !location.protocol.startsWith('http')) return;
  let docs;
  try {
    const r = await fetch('/api/shared-with-me');
    if (!r.ok) return;
    docs = await r.json();
  } catch (e) {
    return;
  }
  if (!Array.isArray(docs) || docs.length === 0) return;
  sharedSection.classList.remove('hidden');
  sharedList.innerHTML = docs
    .slice(0, 8)
    .map((d) => {
      const name = String(d.path).split('/').pop();
      const by = d.granted_by ? String(d.granted_by).replace(/^user:/, '') : '';
      return `
    <li class="overflow-hidden"><a class="tree-item w-full flex flex-col px-2 py-1 rounded cursor-pointer" data-path="${escapeHtml(d.path)}">
      <span class="block text-xs text-ink-200 truncate w-full" data-name="${escapeHtml(name)}">${escapeHtml(name)}</span>
      ${by ? `<span class="text-[10px] text-ink-500">${escapeHtml(by)}</span>` : ''}
    </a></li>`;
    })
    .join('');
  sharedList.querySelectorAll('a').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const f = fileMap[a.dataset.path];
      if (f) {
        showMarkdown(f);
        history.replaceState(null, '', '#' + encodeURIComponent(f.path));
      }
    });
  });
}

renderSharedWithMe();

// Custom tooltip for truncated filenames
const tooltipEl = document.createElement('div');

tooltipEl.className =
  'fixed pointer-events-none bg-navy-800/95 border subtle-border text-ink-100 text-xs px-3 py-1.5 rounded-md shadow-2xl shadow-black/70 z-50 opacity-0 max-w-md whitespace-nowrap font-medium';
tooltipEl.style.cssText +=
  ';backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);transition:opacity 0.12s ease, transform 0.12s ease;transform:translateY(-50%) translateX(-4px);';
document.body.appendChild(tooltipEl);

function isTruncated(el) {
  return el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight;
}

function positionTooltip(target) {
  const rect = target.getBoundingClientRect();
  const GAP = 14;

  tooltipEl.style.left = rect.right + GAP + 'px';
  tooltipEl.style.top = rect.top + rect.height / 2 + 'px';
  requestAnimationFrame(() => {
    const tipRect = tooltipEl.getBoundingClientRect();

    if (tipRect.right > window.innerWidth - 8) {
      tooltipEl.style.left = rect.left - tipRect.width - GAP + 'px';
    }
  });
}

function hideTooltip() {
  tooltipEl.style.opacity = '0';
  tooltipEl.style.transform = 'translateY(-50%) translateX(-4px)';
}

document.addEventListener('mouseover', (e) => {
  const target = e.target.closest('[data-name], [data-tip]');
  // data-tip: an explicit tooltip string, shown as-is (and allowed to wrap). data-name:
  // the full filename, shown only when the on-screen label is actually truncated.
  const isTip = !!(target && target.dataset.tip);
  const text = !target ? '' : (isTip ? target.dataset.tip
    : (isTruncated(target) ? target.dataset.name : ''));
  if (!text) {
    hideTooltip();
    return;
  }
  tooltipEl.style.whiteSpace = isTip ? 'normal' : 'nowrap';
  tooltipEl.textContent = text;
  positionTooltip(target);
  tooltipEl.style.opacity = '1';
  tooltipEl.style.transform = 'translateY(-50%) translateX(0)';
});
document.addEventListener('mouseout', (e) => {
  if (!e.relatedTarget || !e.relatedTarget.closest || !e.relatedTarget.closest('[data-name], [data-tip]')) {
    hideTooltip();
  }
});

function showNotFound(path) {
  // A doc the viewer can't reach (filtered out of the tree) or that doesn't exist:
  // a clean in-app page instead of silently bouncing to the home. The wording is
  // deliberately ambiguous (not-found OR no-access) to keep the no-existence-oracle.
  currentFile = null;
  contentEl.style.maxWidth = '';
  contentEl.style.padding = '';
  document.getElementById('todo-widget')?.classList.remove('hidden');
  // Reset the doc header/breadcrumb (path + mtime + actions) — else it would keep
  // revealing the path's existence and a "modified X ago" (an existence oracle).
  breadcrumbPath.textContent = '/';
  breadcrumbDate.textContent = '';
  breadcrumbActions.classList.add('hidden');
  breadcrumbActions.classList.remove('flex');
  tocPanel.classList.add('hidden');
  contentEl.innerHTML =
    '<div class="max-w-md mx-auto mt-24 text-center">' +
    '<div class="text-5xl mb-4 opacity-60">🔒</div>' +
    '<h1 class="text-xl font-semibold text-ink-100 mb-2 !border-0 !p-0">' +
    escapeHtml(t('notFoundTitle')) + '</h1>' +
    '<p class="text-sm text-ink-400 mb-1">' + escapeHtml(t('notFoundBody')) + '</p>' +
    '<p class="text-[11px] text-ink-500 font-mono mb-6 break-all">' + escapeHtml(path) + '</p>' +
    '<button id="nf-home" class="px-3 py-1.5 text-sm bg-accent hover:brightness-110 text-white rounded font-medium">' +
    escapeHtml(t('notFoundHome')) + '</button></div>';
  document.getElementById('nf-home')?.addEventListener('click', () => {
    history.replaceState(null, '', location.pathname);
    showWelcome();
  });
}

function routeFromHash() {
  // Route from the URL hash once fileMap reflects the viewer's accessible docs.
  const hash = location.hash ? decodeURIComponent(location.hash.slice(1)) : '';
  if (!hash || hash === 'mind') return showWelcome();
  const f = fileMap[hash];
  if (f && f.ext === '.md') return showMarkdown(f);
  if (f) return showWelcome();
  // Not in the (per-viewer filtered) tree. Only declare "not found / no access"
  // once the tree is actually loaded (server mode loads it async via softReload) —
  // before that, hold on the welcome to avoid a false flash.
  if (Object.keys(fileMap).length) showNotFound(hash);
  else showWelcome();
}

function showWelcome() {
  currentFile = null;
  document.querySelector('main').scrollTop = 0;  // a fresh home view starts at the top
  // Reset width/padding overrides left by a previous .html render
  // (renderHtmlFrame), else the home page inherits full-width; restore the
  // todo widget hidden during the HTML preview.
  contentEl.style.maxWidth = '';
  contentEl.style.padding = '';
  document.getElementById('todo-widget')?.classList.remove('hidden');
  const byCategory = {};
  let totalWords = 0;
  let longestDoc = null;

  for (const f of Object.values(fileMap)) {
    if (f.ext !== '.md') continue;
    const parts = f.path.split('/');
    const cat = parts.length >= 2 ? parts[0] + (parts.length >= 3 ? '/' + parts[1] : '') : 'root';

    byCategory[cat] = (byCategory[cat] || 0) + 1;

    if (f.words) {
      totalWords += f.words;

      if (!longestDoc || f.words > longestDoc.words) longestDoc = { file: f, words: f.words };
    }
  }

  const catEntries = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
  const recent = Object.values(fileMap)
    .filter((f) => f.ext === '.md' && f.mtime)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 4);
  const todoSummary = todos.length ? `${todos.filter((t) => t.done).length}/${todos.length}` : '–';

  const HEATMAP_WEEKS = 53;
  const dayMs = 86400 * 1000;
  const now = new Date();

  now.setHours(0, 0, 0, 0);
  const todayDow = (now.getDay() + 6) % 7;
  const monday = new Date(now.getTime() - todayDow * dayMs);
  const startDate = new Date(monday.getTime() - (HEATMAP_WEEKS - 1) * 7 * dayMs);
  const cells = Array.from({ length: HEATMAP_WEEKS * 7 }, () => 0);
  let weekModif = 0,
    prevWeekModif = 0;
  const startOfThisWeek = monday.getTime() / 1000;
  const startOfPrevWeek = (monday.getTime() - 7 * dayMs) / 1000;

  for (const f of Object.values(fileMap)) {
    if (f.ext !== '.md' || !f.mtime) continue;
    const d = new Date(f.mtime * 1000);

    d.setHours(0, 0, 0, 0);
    const diffDays = Math.floor((d.getTime() - startDate.getTime()) / dayMs);

    if (diffDays >= 0 && diffDays < HEATMAP_WEEKS * 7) {
      const week = Math.floor(diffDays / 7);
      const day = diffDays % 7;

      cells[week * 7 + day] += 1;
    }

    if (f.mtime >= startOfThisWeek) weekModif += 1;
    else if (f.mtime >= startOfPrevWeek) prevWeekModif += 1;
  }

  const maxCell = Math.max(1, ...cells);
  const heatmapCells = [];

  for (let w = 0; w < HEATMAP_WEEKS; w++) {
    for (let d = 0; d < 7; d++) {
      const count = cells[w * 7 + d];
      const intensity = count === 0 ? 0 : Math.min(4, Math.ceil((count / maxCell) * 4));
      const cellDate = new Date(startDate.getTime() + (w * 7 + d) * dayMs);
      const color = [
        '#1a1820',
        'rgba(29,155,209,0.18)',
        'rgba(29,155,209,0.36)',
        'rgba(29,155,209,0.6)',
        '#1d9bd1',
      ][intensity];
      const dateStr = cellDate.toLocaleDateString(LANG, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      });
      const tip = (count === 0 ? t('heatNone') : t('heatCount', count)) + ' · ' + dateStr;

      heatmapCells.push(
        '<div data-tip="' +
          tip +
          '" style="background:' +
          color +
          ';border-radius:2px;cursor:default;"></div>',
      );
    }
  }

  const weekDelta = weekModif - prevWeekModif;
  const weekDeltaTxt = weekDelta === 0 ? '=' : (weekDelta > 0 ? '+' : '') + weekDelta;
  const weekDeltaColor = weekDelta > 0 ? '#4ade80' : weekDelta < 0 ? '#f87171' : '#868a90';

  const categoryItems = catEntries
    .map(([cat, n]) => {
      return (
        '<div class="flex items-center justify-between px-3 py-2 rounded border subtle-border bg-black/15 hover:bg-black/25 transition"><span class="text-sm text-ink-200 font-mono truncate">' +
        escapeHtml(cat) +
        '</span><span class="text-xs text-ink-400 font-semibold ml-2">' +
        n +
        '</span></div>'
      );
    })
    .join('');

  const recentItems = recent
    .map((f) => {
      return (
        '<a data-recent-path="' +
        f.path +
        '" class="block p-3 rounded-lg border subtle-border bg-black/15 hover:bg-black/30 hover:border-accent/30 transition cursor-pointer">' +
        '<div class="text-sm text-ink-100 font-medium font-sans truncate">' +
        escapeHtml(f.name) +
        '</div>' +
        '<div class="text-[11px] text-ink-500 mt-0.5 font-sans">' +
        relativeDate(f.mtime) +
        ' · ' +
        escapeHtml(f.path.split('/').slice(0, -1).join('/') || t('rootLabel')) +
        '</div>' +
        '</a>'
      );
    })
    .join('');

  const longest = Object.values(fileMap)
    .filter((f) => f.ext === '.md' && f.words)
    .sort((a, b) => b.words - a.words)
    .slice(0, 6);
  const maxWords = longest.length ? longest[0].words : 1;
  const rankingHtml = longest.length
    ? longest
        .map((f, i) => {
          const pct = Math.max(4, Math.round((100 * f.words) / maxWords));

          return (
            '<a data-recent-path="' +
            f.path +
            '" class="block cursor-pointer group">' +
            '<div class="flex items-center gap-2">' +
            '<span class="text-ink-500 font-mono text-xs w-4 text-right">' +
            (i + 1) +
            '</span>' +
            '<span class="text-sm text-ink-200 group-hover:text-accent truncate flex-1">' +
            escapeHtml(f.name) +
            '</span>' +
            '<span class="text-[11px] text-ink-500 font-mono whitespace-nowrap">' +
            f.words.toLocaleString(LANG) +
            '</span>' +
            '</div>' +
            '<div class="h-1 mt-1 ml-6 rounded bg-black/30 overflow-hidden"><div class="h-full rounded" style="width:' +
            pct +
            '%;background:rgba(29,155,209,0.55)"></div></div>' +
            '</a>'
          );
        })
        .join('')
    : '<span class="text-sm text-ink-500">—</span>';

  // Tag cloud: font size ∝ number of docs.
  const tagCounts = {};

  for (const f of Object.values(fileMap)) {
    if (f.ext !== '.md') continue;

    for (const t of f.tags || []) tagCounts[t] = (tagCounts[t] || 0) + 1;
  }

  const tagEntries = Object.entries(tagCounts).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  const maxTagCount = tagEntries.length ? tagEntries[0][1] : 1;
  const tagCloud = tagEntries
    .map(([t, n]) => {
      const scale = (0.78 + 0.5 * (n / maxTagCount)).toFixed(2);

      return (
        '<button class="doc-tag" data-hometag="' +
        escapeHtml(t) +
        '" style="font-size:' +
        scale +
        'rem">#' +
        escapeHtml(t) +
        '<span class="doc-tag-count">' +
        n +
        '</span></button>'
      );
    })
    .join('');

  contentEl.innerHTML = `
    <h1 class="!mb-2"><span style="font-family:'Corinthia',cursive;font-weight:700;font-size:1.7em;line-height:.9;color:#eef0f2">${escapeHtml(SITE_PREFIX)}</span> <span style="display:inline-flex;align-items:center;gap:.4em;line-height:1;margin-left:.22em"><span style="font-family:'Lora',Georgia,serif;font-style:italic;font-weight:600;font-size:1.3em;color:#e8941c;text-shadow:0 1px 2px rgba(0,0,0,0.6),0 0 1px rgba(0,0,0,0.85)">Atlas</span><span class="nebula-pill">Mind</span></span></h1>
    <p class="lead text-ink-400 !mt-0">${escapeHtml(TAGLINE)}</p>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 not-prose mt-6 mb-8">
      <div class="border subtle-border rounded-lg p-4 bg-black/15">
        <div class="text-[10px] uppercase tracking-wider text-ink-500 font-semibold">${t('statDocs')}</div>
        <div class="text-3xl font-extrabold text-accent mt-1 font-sans">${mdCount}</div>
        <div class="text-[11px] text-ink-400 mt-0.5">${t('statDocsSub')}</div>
      </div>
      <div class="border subtle-border rounded-lg p-4 bg-black/15">
        <div class="text-[10px] uppercase tracking-wider text-ink-500 font-semibold">${t('statWords')}</div>
        <div class="text-3xl font-extrabold text-accent mt-1 font-sans">${(totalWords / 1000).toFixed(1)}k</div>
        <div class="text-[11px] text-ink-400 mt-0.5">${t('statWordsSub', Math.round(totalWords / 220))}</div>
      </div>
      <div class="border subtle-border rounded-lg p-4 bg-black/15">
        <div class="text-[10px] uppercase tracking-wider text-ink-500 font-semibold">${t('statWeek')}</div>
        <div class="text-3xl font-extrabold text-accent mt-1 font-sans">${weekModif} <span class="text-sm font-bold ml-1" style="color:${weekDeltaColor}">${weekDeltaTxt}</span></div>
        <div class="text-[11px] text-ink-400 mt-0.5">${t('statWeekSub')}</div>
      </div>
      <div class="border subtle-border rounded-lg p-4 bg-black/15">
        <div class="text-[10px] uppercase tracking-wider text-ink-500 font-semibold">To-do</div>
        <div id="home-todo-stat" class="text-3xl font-extrabold text-accent mt-1 font-sans">${escapeHtml(todoSummary)}</div>
        <div class="text-[11px] text-ink-400 mt-0.5">${t('statTodoSub')}</div>
      </div>
    </div>

    <div class="not-prose mb-10" id="home-activity-mount"></div>

    <div class="not-prose mb-10">
      <div class="flex items-center justify-between mb-4">
        <h2 class="!mb-0 !mt-0">Tags</h2>
        <button id="home-graph-btn" class="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs bg-navy-600 hover:bg-navy-500 text-ink-100 rounded-lg border subtle-border transition" title="${t('graphBtnTitle')}"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/></svg>${t('graphLabel')}</button>
      </div>
      <div class="doc-tags">${tagCloud || '<span class="text-sm text-ink-500">' + t('noTags') + '</span>'}</div>
    </div>

    <h2 class="!mt-0 !mb-4">${t('recentlyModified')}</h2>
    <div class="not-prose grid grid-cols-1 md:grid-cols-2 gap-3 mb-10">${recentItems || '<div class="text-sm text-ink-500">' + t('noRecentDocs') + '</div>'}</div>

    <div class="not-prose grid grid-cols-1 md:grid-cols-2 gap-6 mb-10">
      <div>
        <h2 class="!mb-4 !mt-0">${t('categories')}</h2>
        <div class="grid grid-cols-1 gap-2">${categoryItems}</div>
      </div>
      <div>
        <h2 class="!mb-4 !mt-0">${t('longestDocs')}</h2>
        <div class="space-y-2.5">${rankingHtml}</div>
      </div>
    </div>

    <div class="not-prose mt-8 text-xs text-ink-500 flex flex-wrap gap-x-4 gap-y-2 items-center">
      <span><kbd class="bg-black/30 border subtle-border px-1.5 py-0.5 rounded font-mono">Ctrl+K</kbd> ${t('hintPalette')}</span>
      <span><kbd class="bg-black/30 border subtle-border px-1.5 py-0.5 rounded font-mono">/</kbd> ${t('hintSearch')}</span>
      <span><kbd class="bg-black/30 border subtle-border px-1.5 py-0.5 rounded font-mono">Ctrl+B</kbd> ${t('hintSidebar')}</span>
      <span><kbd class="bg-black/30 border subtle-border px-1.5 py-0.5 rounded font-mono">Ctrl+J</kbd> ${t('hintToc')}</span>
      <span><kbd class="bg-black/30 border subtle-border px-1.5 py-0.5 rounded font-mono">E</kbd> ${t('hintEdit')}</span>
      <span><kbd class="bg-black/30 border subtle-border px-1.5 py-0.5 rounded font-mono">N</kbd> ${t('hintNewTodo')}</span>
    </div>
  `;
  contentEl.querySelectorAll('[data-recent-path]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const f = fileMap[a.dataset.recentPath];

      if (f) {
        showMarkdown(f);
        history.replaceState(null, '', '#' + encodeURIComponent(f.path));
      }
    });
  });
  contentEl.querySelectorAll('[data-hometag]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.preventDefault();
      showTag(b.dataset.hometag);
    }),
  );
  const homeGraphBtn = contentEl.querySelector('#home-graph-btn');

  if (homeGraphBtn) homeGraphBtn.addEventListener('click', openGraph);
  if (window.mountActivity) window.mountActivity();
  const hm = contentEl.querySelector('#home-heatmap');

  if (hm) {
    let tip = document.getElementById('hm-tip');

    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'hm-tip';
      tip.style.cssText =
        'position:fixed;z-index:60;pointer-events:none;opacity:0;transition:opacity .1s;background:#1a1d29;border:1px solid #2a2c36;color:#e5e7eb;font:500 11px system-ui,sans-serif;padding:4px 8px;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.45);white-space:nowrap;';
      document.body.appendChild(tip);
    }

    hm.addEventListener('mouseover', (e) => {
      const cell = e.target.closest('[data-tip]');

      if (cell) {
        tip.textContent = cell.dataset.tip;
        tip.style.opacity = '1';
      } else {
        tip.style.opacity = '0';
      }
    });
    hm.addEventListener('mousemove', (e) => {
      tip.style.left = e.clientX + 12 + 'px';
      tip.style.top = e.clientY - 34 + 'px';
    });
    hm.addEventListener('mouseleave', () => {
      tip.style.opacity = '0';
    });
  }

  breadcrumbPath.textContent = '/';
  breadcrumbDate.textContent = '';
  breadcrumbActions.classList.add('hidden');
  breadcrumbActions.classList.remove('flex');
  tocPanel.classList.add('hidden');
  tocPanel.classList.remove('flex');

  if (typeof tocShow !== 'undefined' && tocShow) tocShow.classList.add('hidden');
}

// Sidebar + TOC collapse
const sidebarEl = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebarShowInline = document.getElementById('sidebar-show-inline');
const tocClose = document.getElementById('toc-close');
const tocShow = document.getElementById('toc-show');

let sidebarCollapsed = localStorage.getItem('sidebar-collapsed') === '1';
let tocHiddenMap = {};

try {
  tocHiddenMap = JSON.parse(localStorage.getItem('toc-hidden-per-doc') || '{}');
} catch (e) {}

const isMobile = () => window.matchMedia('(max-width: 767px)').matches;

function applySidebar() {
  if (isMobile()) {
    sidebarEl.style.marginLeft = '';
    sidebarShowInline.classList.remove('hidden');

    return;
  }

  if (sidebarCollapsed) {
    sidebarEl.style.marginLeft = '-20rem';
    sidebarShowInline.classList.remove('hidden');
  } else {
    sidebarEl.style.marginLeft = '';
    sidebarShowInline.classList.add('hidden');
  }
}

function toggleSidebar() {
  if (isMobile()) {
    document.body.classList.toggle('sidebar-open');

    return;
  }

  sidebarCollapsed = !sidebarCollapsed;
  localStorage.setItem('sidebar-collapsed', sidebarCollapsed ? '1' : '0');
  applySidebar();
}

const sidebarBackdrop = document.getElementById('sidebar-backdrop');

sidebarBackdrop.addEventListener('click', () => document.body.classList.remove('sidebar-open'));
treeEl.addEventListener('click', (e) => {
  if (isMobile() && e.target.closest('a[data-path]'))
    document.body.classList.remove('sidebar-open');
});
window.addEventListener('resize', () => {
  if (!isMobile()) document.body.classList.remove('sidebar-open');
  applySidebar();
  applyToc();
});

function isTocHiddenForCurrent() {
  if (!currentFile) return false;

  return tocHiddenMap[currentFile.path] === true;
}

function applyToc() {
  if (!currentFile) {
    tocPanel.classList.add('hidden');
    tocPanel.classList.remove('flex');
    tocShow.classList.add('hidden');

    return;
  }

  const hasContent = tocList.children.length >= 2 || tocHasLinks || tocHasNotes;

  if (isMobile()) {
    tocPanel.classList.add('hidden');
    tocPanel.classList.remove('flex');
    tocShow.classList.toggle('hidden', !hasContent);

    return;
  }

  const hidden = isTocHiddenForCurrent();

  if (hidden || !hasContent) {
    tocPanel.classList.add('hidden');
    tocPanel.classList.remove('flex');
    tocShow.classList.toggle('hidden', !hasContent || !hidden);
  } else {
    tocPanel.classList.remove('hidden');
    tocPanel.classList.add('flex');
    tocShow.classList.add('hidden');
  }
}

function toggleToc() {
  if (!currentFile) return;

  if (isMobile()) {
    const wasHidden = tocPanel.classList.contains('hidden');

    tocPanel.classList.toggle('hidden', !wasHidden);
    tocPanel.classList.toggle('flex', wasHidden);
    tocShow.classList.toggle('hidden', wasHidden);

    return;
  }

  const path = currentFile.path;

  tocHiddenMap[path] = !isTocHiddenForCurrent();

  if (!tocHiddenMap[path]) delete tocHiddenMap[path];
  localStorage.setItem('toc-hidden-per-doc', JSON.stringify(tocHiddenMap));
  applyToc();
}

sidebarToggle.addEventListener('click', toggleSidebar);
sidebarShowInline.addEventListener('click', toggleSidebar);
tocClose.addEventListener('click', toggleToc);
tocShow.addEventListener('click', toggleToc);
applySidebar();

document.getElementById('home-link').addEventListener('click', () => {
  showWelcome();
  history.replaceState(null, '', location.pathname);
});

// Download .md button
document.getElementById('btn-download').addEventListener('click', async () => {
  if (!currentFile) return;

  // Non-.md: download the ORIGINAL served as-is — loadContent would return text
  // and corrupt a binary .pdf/.docx.
  if (currentFile.ext !== '.md') {
    const fileUrl = '/' + currentFile.path.split('/').map(encodeURIComponent).join('/');
    const a = document.createElement('a');

    a.href = fileUrl;
    a.download = currentFile.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    return;
  }

  let content;

  try {
    content = await loadContent(currentFile);
  } catch (e) {
    notifyError('cantLoadDoc', e.message);

    return;
  }

  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');

  a.href = url;
  a.download = currentFile.name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
});

// Command palette (Ctrl+K)
const paletteBackdrop = document.getElementById('palette-backdrop');
const paletteInput = document.getElementById('palette-input');
const paletteList = document.getElementById('palette-list');
const paletteCount = document.getElementById('palette-count');
let paletteItems = [];
let paletteIdx = 0;
let paletteNav = []; // actions + files matched by name/path (instant)
let paletteContent = []; // files matched by content (async, via getSearchHits)
let paletteSearchDebounce = null;
let paletteSearchSeq = 0;

const PALETTE_ACTIONS = [
  {
    label: t('actHome'),
    hint: t('actHomeHint'),
    icon: 'home',
    action: () => {
      showWelcome();
      history.replaceState(null, '', location.pathname);
    },
  },
  { label: t('actSidebar'), hint: 'Ctrl+B', icon: 'sidebar', action: toggleSidebar },
  { label: t('actToc'), hint: 'Ctrl+J', icon: 'toc', action: toggleToc },
  {
    label: t('actEdit'),
    hint: 'E',
    icon: 'edit',
    action: () => currentFile && !editMode && enterEditMode(),
  },
  {
    label: t('actDownload'),
    hint: '',
    icon: 'download',
    action: () => currentFile && document.getElementById('btn-download').click(),
  },
  {
    label: t('actSearch'),
    hint: '/',
    icon: 'search',
    action: () => {
      closePalette();
      searchEl.focus();
    },
  },
  {
    label: t('actGraph'),
    hint: 'Ctrl+G',
    icon: 'graph',
    action: () => {
      closePalette();
      openGraph();
    },
  },
  { label: t('actReload'), hint: 'F5', icon: 'reload', action: () => location.reload() },
];

const ICON_PATHS = {
  home: 'M3 12l9-9 9 9M5 10v10a1 1 0 001 1h3v-7h6v7h3a1 1 0 001-1V10',
  sidebar: 'M4 6h16M4 12h7M4 18h16',
  toc: 'M4 6h16M4 12h16M4 18h7',
  edit: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
  download: 'M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4',
  search: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z',
  reload:
    'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15',
  file: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
  graph:
    'M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4',
};

function iconSvg(name) {
  const p = ICON_PATHS[name] || ICON_PATHS.file;

  return (
    '<svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="' +
    p +
    '"/></svg>'
  );
}

function openPalette() {
  paletteBackdrop.classList.remove('hidden');
  paletteInput.value = '';
  renderPaletteResults('');
  setTimeout(() => paletteInput.focus(), 0);
}

function closePalette() {
  paletteBackdrop.classList.add('hidden');
}

function renderPaletteResults(q) {
  const raw = q.trim();

  q = raw.toLowerCase();
  // Instant pass: actions + files matched by name/path.
  const nav = [];

  for (const a of PALETTE_ACTIONS) {
    if (!q || a.label.toLowerCase().includes(q)) nav.push({ kind: 'action', ...a });
  }

  const seen = new Set();

  for (const f of Object.values(fileMap)) {
    if (f.ext !== '.md') continue;

    if (!q || f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)) {
      nav.push({ kind: 'file', label: f.name, hint: f.path, file: f, query: raw });
      seen.add(f.path);
    }
  }

  paletteNav = nav;
  paletteContent = [];
  paintPalette();
  // Async pass: full-text content search via getSearchHits (same engine as the
  // search bar). Debounced; skips files already listed by name/path.
  const seq = ++paletteSearchSeq;

  clearTimeout(paletteSearchDebounce);

  if (q.length >= 2) {
    paletteSearchDebounce = setTimeout(async () => {
      let hits;

      try {
        hits = await getSearchHits(raw);
      } catch (e) {
        return;
      }

      if (seq !== paletteSearchSeq) return; // stale request, we bail out
      const extra = [];

      for (const h of hits) {
        if (seen.has(h.path)) continue;
        const f = fileMap[h.path];

        if (f)
          extra.push({
            kind: 'file',
            label: f.name,
            hint: f.path,
            file: f,
            snippet: h.snippet,
            query: raw,
          });
      }

      paletteContent = extra;
      paintPalette();
    }, 160);
  }
}

function paintPalette() {
  const items = paletteNav.concat(paletteContent);

  paletteItems = items.slice(0, 30);
  paletteIdx = 0;
  paletteCount.textContent =
    items.length > 30 ? t('paletteResultsCapped', items.length) : t('nResults', items.length);
  paletteList.innerHTML = paletteItems
    .map((item, i) => {
      const secondary = item.snippet
        ? '<div class="text-[10px] text-ink-400 truncate">' + escapeHtml(item.snippet) + '</div>'
        : item.hint
          ? '<div class="text-[10px] text-ink-500 truncate font-mono">' +
            escapeHtml(item.hint) +
            '</div>'
          : '';
      const kbd =
        item.kind === 'action' && item.hint
          ? '<kbd class="text-[10px] text-ink-500 bg-black/30 border subtle-border px-1.5 py-0.5 rounded font-mono">' +
            escapeHtml(item.hint) +
            '</kbd>'
          : '';

      return `
    <li data-idx="${i}" class="palette-item flex items-center gap-3 px-4 py-2.5 cursor-pointer ${i === 0 ? 'palette-active' : ''}">
      <span class="text-ink-400">${iconSvg(item.icon || (item.kind === 'file' ? 'file' : 'edit'))}</span>
      <div class="flex-1 min-w-0">
        <div class="text-sm text-ink-100 truncate">${escapeHtml(item.label)}</div>
        ${secondary}
      </div>
      ${kbd}
    </li>`;
    })
    .join('');
  paletteList.querySelectorAll('.palette-item').forEach((el, i) => {
    el.addEventListener('mouseenter', () => {
      paletteIdx = i;
      updatePaletteHighlight();
    });
    el.addEventListener('click', () => selectPaletteItem(i));
  });
}

function updatePaletteHighlight() {
  paletteList.querySelectorAll('.palette-item').forEach((li, i) => {
    li.classList.toggle('palette-active', i === paletteIdx);
  });
  const active = paletteList.querySelector('.palette-active');

  if (active) active.scrollIntoView({ block: 'nearest' });
}

function selectPaletteItem(i) {
  const item = paletteItems[i];

  if (!item) return;
  closePalette();

  if (item.kind === 'action') item.action();
  else if (item.kind === 'file') {
    showMarkdown(item.file, item.query);
    history.replaceState(null, '', '#' + encodeURIComponent(item.file.path));
  }
}

paletteInput.addEventListener('input', (e) => renderPaletteResults(e.target.value));
paletteInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    paletteIdx = Math.min(paletteItems.length - 1, paletteIdx + 1);
    updatePaletteHighlight();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    paletteIdx = Math.max(0, paletteIdx - 1);
    updatePaletteHighlight();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    selectPaletteItem(paletteIdx);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closePalette();
  }
});
paletteBackdrop.addEventListener('click', (e) => {
  if (e.target === paletteBackdrop) closePalette();
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openPalette();

    return;
  }

  if (e.key === 'Escape' && !historyOverlay.classList.contains('hidden')) {
    closeHistory();

    return;
  }

  if (e.key === 'Escape' && !tasksOverlay.classList.contains('hidden')) {
    closeTasks();

    return;
  }

  if (e.key === 'Escape' && !graphOverlay.classList.contains('hidden')) {
    closeGraph();

    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') {
    e.preventDefault();
    openGraph();

    return;
  }

  if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    if (e.key === 'Escape' && document.activeElement === searchEl) {
      searchEl.value = '';
      searchEl.dispatchEvent(new Event('input'));
      searchEl.blur();
    }

    return;
  }

  if (e.key === '/') {
    e.preventDefault();
    searchEl.focus();
  }

  if (e.key === 'e' && currentFile && !editMode && !window.__viewerMode) {
    e.preventDefault();
    enterEditMode();
  }

  if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
    e.preventDefault();
    toggleSidebar();
  }

  if ((e.ctrlKey || e.metaKey) && e.key === 'j') {
    e.preventDefault();
    toggleToc();
  }
});

// ─── Pinned favorites ────────────────────────────────────────────────────────────
const pinnedSection = document.getElementById('pinned-section');
const pinnedList = document.getElementById('pinned-list');
const btnPin = document.getElementById('btn-pin');
const btnPinIcon = document.getElementById('btn-pin-icon');
let pins = [];

try {
  pins = (JSON.parse(localStorage.getItem('kb-pins') || '[]') || []).filter((p) => fileMap[p]);
} catch (e) {
  pins = [];
}

function savePins() {
  try {
    localStorage.setItem('kb-pins', JSON.stringify(pins));
  } catch (e) {}
}

function isPinned(path) {
  return pins.includes(path);
}

function togglePin(path) {
  if (!path) return;
  const i = pins.indexOf(path);

  if (i >= 0) pins.splice(i, 1);
  else pins.unshift(path);
  savePins();
  renderPinned();

  if (currentFile) updatePinButton(currentFile);
}

function updatePinButton(file) {
  if (!file || file.ext !== '.md') {
    btnPin.classList.add('hidden');

    return;
  }

  btnPin.classList.remove('hidden');
  const on = isPinned(file.path);

  btnPinIcon.setAttribute('fill', on ? 'currentColor' : 'none');
  btnPin.classList.toggle('text-amber-300', on);
  btnPin.title = on ? t('unpin') : t('pin');
}

function renderPinned() {
  const items = pins.map((p) => fileMap[p]).filter(Boolean);

  if (!items.length) {
    pinnedSection.classList.add('hidden');
    pinnedList.innerHTML = '';

    return;
  }

  pinnedSection.classList.remove('hidden');
  pinnedList.innerHTML = items
    .map(
      (f) => `
    <li class="overflow-hidden group flex items-center">
      <a class="tree-item flex-1 min-w-0 flex items-center px-2 py-1 rounded cursor-pointer" data-pinpath="${escapeHtml(f.path)}">
        <span class="block text-xs text-ink-200 truncate w-full">${escapeHtml(f.name)}</span>
      </a>
      <button class="px-1.5 text-ink-600 hover:text-rose-300 opacity-0 group-hover:opacity-100 transition-opacity" data-unpin="${escapeHtml(f.path)}" title="${escapeHtml(t('unpin'))}">&times;</button>
    </li>`,
    )
    .join('');
  pinnedList.querySelectorAll('[data-pinpath]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const f = fileMap[a.dataset.pinpath];

      if (f) {
        showMarkdown(f);
        history.replaceState(null, '', '#' + encodeURIComponent(f.path));
      }
    }),
  );
  pinnedList.querySelectorAll('[data-unpin]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePin(b.dataset.unpin);
    }),
  );
}

btnPin.addEventListener('click', () => {
  if (currentFile) togglePin(currentFile.path);
});
renderPinned();

// Embed mode (#mind): landing page iframes this viewer as a chrome-less Mind hero.
// Build the base view here; the graph opens (controls hidden) once fully wired, below.
const EMBED_MIND = location.hash.replace(/^#/, '') === 'mind';

if (EMBED_MIND) {
  showWelcome();
} else {
  routeFromHash();
}

// ─── Connections graph view ────────────────────────────────────────────────────
const graphOverlay = document.getElementById('graph-overlay');
const graphCanvas = document.getElementById('graph-canvas');
const graphTooltip = document.getElementById('graph-tooltip');
const graphStats = document.getElementById('graph-stats');
const GRAPH_COLORS = [
  '#5db5e8',
  '#fbc678',
  '#a78bfa',
  '#34d399',
  '#f472b6',
  '#f87171',
  '#22d3ee',
  '#facc15',
  '#c084fc',
  '#4ade80',
];
let graphState = null,
  graphRaf = null;

function tagColor(tag) {
  if (!tag) return '#6b7280';
  let h = 0;

  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;

  return GRAPH_COLORS[h % GRAPH_COLORS.length];
}

// Hierarchical folder color: a top-level folder maps to a stable family HUE (golden-angle
// spread, populated once in openGraph so families never collide), and the immediate
// subfolder under it varies LIGHTNESS/SATURATION within that hue. So a dominant family
// (e.g. wizishop) stays one recognizable hue while its subfolders read as distinct tints.
let _familyHue = {};

// HSL→#rrggbb. MUST return the 6-hex form: every consumer appends an alpha byte
// (n.color + '30', col + '2b', …), so an hsl() string would corrupt every gradient stop.
function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (k) => {
    const x = (k + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(x - 3, 9 - x, 1));
    return Math.round(255 * c)
      .toString(16)
      .padStart(2, '0');
  };
  return '#' + f(0) + f(8) + f(4);
}

function hierColor(family, sub) {
  if (!family) return '#6b7280'; // root-level docs: neutral (matches the old tagColor(''))
  let fh = 0;
  for (let i = 0; i < family.length; i++) fh = (fh * 31 + family.charCodeAt(i)) >>> 0;
  const baseHue = family in _familyHue ? _familyHue[family] : fh % 360;
  if (!sub) return hslToHex(baseHue, 68, 55); // family anchor color (blobs + sub-less docs)
  // Spread subfolders on a 3D hue/sat/light grid — a single axis crowds for a family with
  // ~8 subfolders. The hue jitter stays small (±16°, well within the gap between family
  // hues) so the family is still recognizable. Mid-band lightness keeps cores legible and
  // the additive bloom from washing to white.
  let h = 0;
  for (let i = 0; i < sub.length; i++) h = (h * 31 + sub.charCodeAt(i)) >>> 0;
  const hue = (baseHue + ((h % 5) - 2) * 8 + 360) % 360; // ±16° within the family band
  const light = 46 + (Math.floor(h / 5) % 5) * 5; // 46,51,56,61,66
  const sat = 60 + (Math.floor(h / 25) % 3) * 9; // 60,69,78
  return hslToHex(hue, sat, light);
}

// ── Mind view modes: "organic" (force-directed brain) ⇄ "structured" (folder map) ──

// Which nodes/edges are active for the current mode. Organic shows the folder-zoned
// force graph with TAGS HIDDEN by default — tags carry ~3× the edges of real wikilinks
// and drown the structure. The hero (EMBED_MIND) keeps its full tag web for the landing.
function applyGraphView(st) {
  const tags = st.mode === 'organic' && (st.showTags || EMBED_MIND);

  st.nodes = tags ? st.allNodes : st.allNodes.filter((n) => n.kind !== 'tag');
  st.edges = st.allEdges.filter((e) => e.kind === 'link' || (tags && e.kind === 'tag'));
  st.hover = null;
}

// Re-seed organic positions near each node's folder anchor (used when switching back
// from the structured map so the force layout relaxes from an already-zoned start).
function reseedOrganic(st) {
  for (const n of st.nodes) {
    const anc = (st.subAnchors && st.subAnchors[n.subKey]) || (st.regionAnchors && st.regionAnchors[n.region]);

    n.x = anc ? anc.x + (Math.random() - 0.5) * 70 : (Math.random() - 0.5) * 520;
    n.y = anc ? anc.y + (Math.random() - 0.5) * 70 : (Math.random() - 0.5) * 520;
    n.vx = 0;
    n.vy = 0;
  }
}

// Fit the camera to the whole layout. Organic fits the anchor ring (nodes spread as the
// sim relaxes); structured fits the fixed packed bbox. The hero keeps its own framing.
function fitGraphCamera(st) {
  st.cam.ox = graphCanvas.clientWidth / 2;
  st.cam.oy = graphCanvas.clientHeight / 2;

  if (EMBED_MIND) return;
  let half;

  if (st.mode === 'structured') {
    half = 60;
    for (const n of st.nodes) half = Math.max(half, Math.abs(n.x) + n.r, Math.abs(n.y) + n.r);
    half += 70;
  } else {
    half = (st.ring || 360) + 220;
  }

  st.cam.scale = Math.min(
    1,
    (Math.min(graphCanvas.clientWidth, graphCanvas.clientHeight) / (2 * half)) * 0.92,
  );
}

// Deterministic "map" layout: docs pack in a phyllotaxis disc per subfolder; subfolder
// discs pack into a family box; family boxes pack across the canvas. No physics → tidy
// and stable, the opposite of the organic hairball. Fills st.clusters + st.families for
// the scaffold drawing, and sets each doc's fixed x/y.
function layoutStructured(st) {
  const docs = st.nodes.filter((n) => n.kind === 'doc');
  const fams = {};

  for (const n of docs) {
    const fam = n.region || '·root';
    const ckey = n.subRegion || '';
    const f = (fams[fam] = fams[fam] || { name: fam, clusters: {} });

    (f.clusters[ckey] = f.clusters[ckey] || { sub: ckey, docs: [] }).docs.push(n);
  }

  const DOC_SP = 15,
    CL_GAP = 22,
    FAM_GAP = 56,
    FAM_PAD = 28;

  // Phyllotaxis pack of a cluster's docs around a local (0,0); sets c.r.
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

  // Row-pack square items {w,h} into maxW; sets it.x/it.y, returns the bounding {w,h}.
  const rowPack = (items, maxW, gap) => {
    let x = 0,
      y = 0,
      rowH = 0,
      totalW = 0;

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

  // Each family becomes a "cell": its subfolder clusters are arranged, then wrapped
  // in ONE enclosing circle (radius = the clusters' extent from their centre + pad)
  // rather than a box — so the map reads as cells, not rectangles.
  for (const f of famList) {
    const cl = Object.values(f.clusters);

    cl.forEach(packCluster);
    cl.sort((a, b) => b.r - a.r);
    f._items = cl.map((c) => ({ c, w: c.r * 2, h: c.r * 2 }));
    const area = f._items.reduce((s, it) => s + it.w * it.h, 0);
    const box = rowPack(f._items, Math.max(f._items[0].w, Math.sqrt(area) * 1.25), CL_GAP);
    // Offsets are measured from the clusters' bounding-box centre; the cell radius is
    // the farthest cluster edge from it.
    const bcx = box.w / 2,
      bcy = box.h / 2;
    let rad = 0;

    for (const it of f._items) {
      it._dx = it.x + it.c.r - bcx;
      it._dy = it.y + it.c.r - bcy;
      rad = Math.max(rad, Math.hypot(it._dx, it._dy) + it.c.r);
    }
    f._r = rad + FAM_PAD;
  }

  // Pack the cells: a square of side 2r per family → the circles tile a grid and
  // never overlap. Largest first keeps it tidy.
  famList.sort((a, b) => b._r - a._r);
  const famItems = famList.map((f) => ({ f, w: f._r * 2, h: f._r * 2 }));
  const totalArea = famItems.reduce((s, it) => s + it.w * it.h, 0);
  const total = rowPack(famItems, Math.max(famItems[0].w, Math.sqrt(totalArea) * 1.3), FAM_GAP);

  const cx = total.w / 2,
    cy = total.h / 2;
  const clusters = [],
    families = [];

  for (const fit of famItems) {
    const f = fit.f;
    const fx = fit.x + f._r - cx,
      fy = fit.y + f._r - cy;

    families.push({ x: fx, y: fy, r: f._r, name: f.name, color: hierColor(f.name, '') });

    for (const it of f._items) {
      const ccx = fx + it._dx,
        ccy = fy + it._dy;

      it.c.docs.forEach((n) => {
        n.x = ccx + n._lx;
        n.y = ccy + n._ly;
        n.vx = 0;
        n.vy = 0;
      });
      clusters.push({ x: ccx, y: ccy, r: it.c.r, sub: it.c.sub, color: hierColor(f.name, it.c.sub) });
    }
  }

  st.clusters = clusters;
  st.families = families;
}

async function openGraph() {
  const idx = await loadBacklinksIndex();

  graphOverlay.classList.remove('hidden');
  const nodes = [],
    byPath = {},
    tagNodes = {};
  // Every previewable doc is a node (not just Markdown), so media docs cluster by region too.
  const GRAPH_EXTS = new Set(['.md', '.html', '.pdf', '.docx']);

  // ── Folder families + subfolders → hierarchical color AND layout anchors ──
  // Built ONCE before the node loop so each node can be colored and SEEDED near its
  // folder's zone. Families sit on a ring (even spacing); each family's subfolders orbit
  // its anchor by sorted index (NOT a hash → no two subfolders re-collide at one spot).
  const famSet = new Set();
  const subByFam = {};

  for (const f of Object.values(fileMap)) {
    if (!GRAPH_EXTS.has(f.ext)) continue;
    const fp = f.path.split('/');
    const isRemoteDoc = f.path.startsWith('remotes/');
    const fam = isRemoteDoc ? '⧫ ' + (fp[1] || 'node') : fp.length > 1 ? fp[0] : '';

    if (!fam) continue; // root-level docs have no family
    famSet.add(fam);

    if (!isRemoteDoc && fp.length > 2) {
      (subByFam[fam] = subByFam[fam] || new Set()).add(fp[1]);
    }
  }

  const families = [...famSet].sort();
  const regionAnchors = {};
  const subAnchors = {};
  const RING = Math.max(260, 78 * families.length); // ring radius grows with family count

  _familyHue = {};
  families.forEach((fam, i) => {
    _familyHue[fam] = (i * 137.5) % 360; // golden-angle hue: maximal family separation
    const a = (i / families.length) * Math.PI * 2; // even placement on the ring
    regionAnchors[fam] = { x: Math.cos(a) * RING, y: Math.sin(a) * RING };
    const subs = subByFam[fam] ? [...subByFam[fam]].sort() : [];
    subs.forEach((sub, k) => {
      const a2 = a + (k / subs.length) * Math.PI * 2; // distribute subs around the family
      subAnchors[fam + '/' + sub] = {
        x: regionAnchors[fam].x + Math.cos(a2) * 130,
        y: regionAnchors[fam].y + Math.sin(a2) * 130,
      };
    });
  });

  for (const f of Object.values(fileMap)) {
    if (!GRAPH_EXTS.has(f.ext)) continue;
    const parts = f.path.split('/');
    // Mirror doc (remotes/<source>/…) → own region per source, diamond-prefixed to
    // avoid colliding with a same-named directory and to signal non-personal content.
    const isRemote = f.path.startsWith('remotes/');
    const region = isRemote ? '⧫ ' + (parts[1] || 'node') : parts.length > 1 ? parts[0] : '';
    // Immediate subfolder (one level under the family) → color tint + a layout sub-anchor.
    const subRegion = !isRemote && parts.length > 2 ? parts[1] : '';
    const subKey = subRegion ? region + '/' + subRegion : '';
    const anchor = subAnchors[subKey] || regionAnchors[region] || null;
    const n = {
      kind: 'doc',
      path: f.path,
      name: f.name.replace(/\.(md|html|pdf|docx)$/i, ''),
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
    };

    // Remote nodes get AI teal; otherwise color = family hue + subfolder tint.
    n.color = isRemote ? '#59d0cf' : hierColor(region, subRegion);
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
          kind: 'tag',
          tag: tg,
          name: '#' + tg,
          color: tagColor(tg),
          docs: 0,
          x: (Math.random() - 0.5) * 520,
          y: (Math.random() - 0.5) * 520,
          vx: 0,
          vy: 0,
          deg: 0,
        };
        tagNodes[tg] = tn;
        nodes.push(tn);
      }

      tn.docs++;
      edges.push({ s: dn, t: tn, kind: 'tag' });
      dn.deg++;
      tn.deg++;
    }
  }

  const seen = new Set();

  for (const [p, e] of Object.entries(idx)) {
    for (const q of e.out || []) {
      const key = p < q ? p + '\n' + q : q + '\n' + p;

      if (seen.has(key)) continue;
      seen.add(key);
      const s = byPath[p],
        t = byPath[q];

      if (s && t) {
        edges.push({ s, t, kind: 'link' });
        s.deg++;
        t.deg++;
        linkCount++;
      }
    }
  }

  // Node radius: docs larger than tags, scaled by degree (hubs grow).
  for (const n of nodes)
    n.r = (n.kind === 'tag' ? 3 : 5) + Math.sqrt(n.deg) * (n.kind === 'tag' ? 1.2 : 2.6);
  // Docs edited < 14 days ago → halo at render time ("active thoughts").
  const RECENT_CUTOFF = Date.now() / 1000 - 14 * 86400;

  for (const n of nodes) if (n.kind === 'doc') n.recent = n.mtime > RECENT_CUTOFF;
  graphStats.textContent = t('graphStats', docCount, linkCount, Object.keys(tagNodes).length);
  graphState = {
    allNodes: nodes,
    allEdges: edges,
    nodes,
    edges,
    regionAnchors,
    subAnchors,
    ring: RING,
    mode: 'organic',
    showTags: false, // de-cluttered by default; toggle to bring the tag web back
    clusters: [],
    families: [],
    cam: { scale: 1, ox: 0, oy: 0 },
    ticks: 0,
    hover: null,
    drag: null,
    panFrom: null,
    moved: false,
  };
  applyGraphView(graphState);
  resizeGraph();
  fitGraphCamera(graphState);

  // Embed hero: pre-settle the layout off-screen so it appears already organized
  // (no nodes flying into place on the landing page).
  if (EMBED_MIND) {
    for (let i = 0; i < 480; i++) graphSimStep(graphState);
    graphState.ticks = 480;
  }

  cancelAnimationFrame(graphRaf);
  graphLoop();
  updateGraphModeUI();
}

function closeGraph() {
  graphOverlay.classList.add('hidden');
  cancelAnimationFrame(graphRaf);
  graphRaf = null;
  graphState = null;
  graphTooltip.classList.add('hidden');
}

// ─── Tasks rollup — every - [ ] / - [x] across the mind in one view ───────────
// Reads EMBED_TASKS (offline) or /_tasks-index.json (server). A row click opens
// its doc and scrolls to the task text (highlightFirstMatch), like a search result.

const tasksOverlay = document.getElementById('tasks-overlay');
const tasksList = document.getElementById('tasks-list');
const tasksStats = document.getElementById('tasks-stats');
const tasksShowDone = document.getElementById('tasks-show-done');
let _tasksIndex = [];

async function loadTasksIndex() {
  if (IS_OFFLINE_BUILD) return EMBED_TASKS || [];

  // Let in-flight checkbox PUTs land first, then fetch fresh: the rollup is read
  // live from disk, so fetching mid-write would return the pre-toggle state.
  if (_taskWrites.size) await Promise.allSettled([..._taskWrites]);

  try {
    const res = await fetch('/_tasks-index.json', { cache: 'no-cache' });

    return res.ok ? await res.json() : [];
  } catch (e) {
    return [];
  }
}

async function openTasks() {
  tasksOverlay.classList.remove('hidden');
  showTasksLoading(); // skeleton first → never flash the stale previous list
  _tasksIndex = await loadTasksIndex(); // kept for the "show done" toggle re-render
  renderTasks(_tasksIndex);
}

function closeTasks() {
  tasksOverlay.classList.add('hidden');
}

// Skeleton mirrors renderTasks layout (no jump on swap). Seeded LCG → same skeleton each open.
function renderTasksSkeleton() {
  let state = 0x9e3779b9 >>> 0;
  const next = () => (state = (state * 1664525 + 1013904223) >>> 0);
  const range = (min, max) => min + (next() % (max - min + 1));
  const sections = [];

  for (let s = 0; s < 3; s++) {
    const rows = [];

    for (let r = 0, n = range(2, 4); r < n; r++) {
      rows.push(
        '<div style="display:flex;align-items:flex-start;gap:0.75rem;padding:0.5rem 0.75rem;">' +
          '<span class="skeleton" style="flex-shrink:0;width:19px;height:19px;border-radius:5px;margin-top:3px;"></span>' +
          '<span class="skeleton" style="height:0.95rem;width:' +
          range(45, 90) +
          '%;margin-top:5px;"></span>' +
          '</div>',
      );
    }

    sections.push(
      '<div style="margin-bottom:1.75rem;">' +
        '<div class="skeleton" style="height:0.7rem;width:' +
        range(22, 42) +
        '%;border-radius:4px;margin-bottom:0.6rem;"></div>' +
        rows.join('') +
        '</div>',
    );
  }

  return sections.join('');
}

function showTasksLoading() {
  tasksStats.innerHTML =
    '<span class="skeleton" style="display:inline-block;height:0.7rem;width:9rem;border-radius:4px;vertical-align:middle;"></span>';
  tasksList.innerHTML =
    '<div aria-busy="true" aria-label="' +
    t('tasksLoading') +
    '">' +
    renderTasksSkeleton() +
    '</div>';
}

// Normalize a task line for matching against rendered text: the index stores raw
// markdown, the rendered doc shows plain text. Drop wikilink/link syntax + inline
// marks, lowercase, collapse spaces.
function _normTask(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Scroll the open doc to the checkbox of `task` and flash it. Primary = the Nth
// rendered checkbox (task._docIndex); on rare index/render drift, fall back to
// matching by text, then to a loose text highlight.
function scrollToTaskCheckbox(task) {
  const want = _normTask(task.text);
  const boxes = [...contentEl.querySelectorAll('input[type=checkbox]')];
  const liOf = (b) => b && (b.closest('li') || b.parentElement);
  let li = liOf(boxes[task._docIndex]);

  if (!(li && want && _normTask(li.textContent).includes(want))) {
    li = null;

    if (want) {
      for (const b of boxes) {
        const candidate = liOf(b);

        if (candidate && _normTask(candidate.textContent).includes(want)) {
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

  li.scrollIntoView({ behavior: 'smooth', block: 'center' });
  li.style.transition = 'background-color 0.4s';
  li.style.backgroundColor = 'rgba(89,208,207,0.18)';
  li.style.borderRadius = '4px';
  setTimeout(() => {
    li.style.backgroundColor = '';
  }, 1600);
}

// Render a task's inline markdown like the rest of the app. Links/images stripped
// to text (the row is itself a button — no nested navigation).
function renderTaskText(s) {
  // On any unexpected error fall back to ESCAPED text (never raw, unsanitized HTML).
  try {
    return DOMPurify.sanitize(marked.parseInline(s), { FORBID_TAGS: ['a', 'img'] });
  } catch (e) {
    return escapeHtml(s);
  }
}

function renderTasks(tasks) {
  // _docIndex = position among its OWN doc's tasks → matches the Nth rendered
  // checkbox, so a click scrolls straight to it regardless of the "show done" filter.
  const perDoc = {};

  for (const tk of tasks) tk._docIndex = perDoc[tk.path] = (perDoc[tk.path] ?? -1) + 1;
  const open = tasks.filter((x) => !x.done).length;

  tasksStats.textContent = t('tasksStats', open, tasks.length);
  const visible = tasksShowDone.checked ? tasks : tasks.filter((x) => !x.done);

  tasksList.innerHTML = '';

  if (!visible.length) {
    const empty = document.createElement('div');

    empty.className = 'text-ink-500 text-sm font-sans';
    empty.textContent = t('tasksEmpty');
    tasksList.appendChild(empty);

    return;
  }

  const byDoc = {};

  for (const task of visible) (byDoc[task.path] = byDoc[task.path] || []).push(task);

  for (const p of Object.keys(byDoc).sort()) {
    const file = fileMap[p];
    const section = document.createElement('div');

    section.style.marginBottom = '1.75rem';
    const head = document.createElement('div');

    head.className = 'text-[11px] uppercase tracking-[0.12em] text-ink-500 font-bold font-mono';
    head.style.marginBottom = '0.6rem';
    head.textContent = p;
    section.appendChild(head);

    for (const task of byDoc[p]) {
      const row = document.createElement('button');

      row.type = 'button';
      row.className =
        'flex items-start gap-3 w-full text-left px-3 py-2 rounded-lg hover:bg-white/5 text-base font-sans';
      const box = document.createElement('span');

      box.className = 'flex-shrink-0';
      box.style.marginTop = '3px';
      box.innerHTML = task.done
        ? '<svg viewBox="0 0 24 24" fill="none" class="text-accent" style="width:19px;height:19px"><rect x="3" y="3" width="18" height="18" rx="5" fill="currentColor"/><path d="M7.4 12.4l3 3 6.2-6.7" fill="none" stroke="#0e0d12" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" class="text-ink-500" style="width:19px;height:19px"><rect x="3" y="3" width="18" height="18" rx="5" stroke="currentColor" stroke-width="2"/></svg>';
      const txt = document.createElement('span');

      txt.className = task.done ? 'text-ink-500' : 'text-ink-100';

      if (task.done) txt.style.textDecoration = 'line-through';
      txt.innerHTML = renderTaskText(task.text);
      row.appendChild(box);
      row.appendChild(txt);
      row.addEventListener('click', async () => {
        closeTasks();

        if (!file) return;
        await showMarkdown(file);
        history.replaceState(null, '', '#' + encodeURIComponent(file.path));
        scrollToTaskCheckbox(task);
      });
      section.appendChild(row);
    }

    tasksList.appendChild(section);
  }
}

document.getElementById('tasks-btn').addEventListener('click', openTasks);
document.getElementById('tasks-close').addEventListener('click', closeTasks);
tasksShowDone.addEventListener('change', () => renderTasks(_tasksIndex));

function resizeGraph() {
  const dpr = window.devicePixelRatio || 1;

  graphCanvas.width = graphCanvas.clientWidth * dpr;
  graphCanvas.height = graphCanvas.clientHeight * dpr;
  graphCanvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
}

function graphSimStep(st) {
  const { nodes, edges } = st;
  const REP = 13000,
    SPRING = 0.02,
    REST = 120,
    CENTER = 0.0034,
    GRAVITY = 0.009;

  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];

    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      let dx = a.x - b.x,
        dy = a.y - b.y,
        d2 = dx * dx + dy * dy || 0.01,
        d = Math.sqrt(d2);
      const f = REP / d2,
        fx = (f * dx) / d,
        fy = (f * dy) / d;

      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }

    // Folder gravity: pull each node toward its subfolder (or folder) anchor so folders
    // settle into distinct spatial zones. GRAVITY < SPRING, so wikilinks still bend the
    // clusters and the layout stays organic. Tags + root docs (no anchor) keep the old
    // weak center pull.
    const anc = (st.subAnchors && st.subAnchors[a.subKey]) || (st.regionAnchors && st.regionAnchors[a.region]);

    if (anc) {
      a.vx += (anc.x - a.x) * GRAVITY;
      a.vy += (anc.y - a.y) * GRAVITY;
    } else {
      a.vx -= a.x * CENTER;
      a.vy -= a.y * CENTER;
    }
  }

  for (const e of edges) {
    const a = e.s,
      b = e.t;
    let dx = b.x - a.x,
      dy = b.y - a.y,
      d = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const f = SPRING * (d - REST),
      fx = (f * dx) / d,
      fy = (f * dy) / d;

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

// Organic mode: a translucent radial blob + label per top-level folder, drawn at the
// centroid/hull of wherever that family's nodes settled.
function drawOrganicZones(ctx, st) {
  const { cam, nodes } = st;
  const regions = {};

  for (const n of nodes) {
    if (n.kind !== 'doc' || !n.region) continue;
    (regions[n.region] = regions[n.region] || []).push(n);
  }

  for (const name in regions) {
    const rn = regions[name];
    let cx = 0,
      cy = 0;

    for (const n of rn) {
      cx += n.x;
      cy += n.y;
    }

    cx /= rn.length;
    cy /= rn.length;
    let rad = 70;

    for (const n of rn) rad = Math.max(rad, Math.hypot(n.x - cx, n.y - cy) + 46);
    const scx = cx * cam.scale + cam.ox,
      scy = cy * cam.scale + cam.oy,
      sr = rad * cam.scale;
    // Remote region (mental node from another atlas): teal + dashed ring, to
    // detach it from the personal regions.
    const isRemoteRegion = rn.some((n) => n.remote);
    const col = isRemoteRegion ? '#59d0cf' : hierColor(name, '');
    const grad = ctx.createRadialGradient(scx, scy, sr * 0.2, scx, scy, sr);

    grad.addColorStop(0, col + (isRemoteRegion ? '3d' : '2b'));
    grad.addColorStop(1, col + '00');
    ctx.beginPath();
    ctx.arc(scx, scy, sr, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    if (isRemoteRegion) {
      ctx.save();
      ctx.setLineDash([6, 5]);
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = col + '99';
      ctx.beginPath();
      ctx.arc(scx, scy, sr, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    ctx.font = '600 13px Manrope, system-ui, sans-serif';
    ctx.fillStyle = col + (isRemoteRegion ? 'ff' : 'dd');
    ctx.textAlign = 'center';
    ctx.fillText(name, scx, scy - sr + 16);
    ctx.textAlign = 'left';
  }
}

// Structured "map" mode: a soft labeled container per family, with a thin ring + label
// per subfolder cluster. Positions come from layoutStructured (fixed, no physics).
function drawStructuredScaffold(ctx, st) {
  const s = st.cam.scale;
  const SX = (x) => x * s + st.cam.ox;
  const SY = (y) => y * s + st.cam.oy;

  for (const f of st.families) {
    const x = SX(f.x),
      y = SY(f.y),
      r = f.r * s;

    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    const grad = ctx.createRadialGradient(x, y, r * 0.25, x, y, r);

    grad.addColorStop(0, f.color + '18');
    grad.addColorStop(1, f.color + '05');
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = f.color + '33';
    ctx.stroke();
    ctx.font = '600 ' + Math.max(11, 13 * s) + 'px Manrope, system-ui, sans-serif';
    ctx.fillStyle = f.color + 'ee';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(f.name, x, y - r - 7 * s);
    ctx.textAlign = 'left';
  }

  ctx.textBaseline = 'middle';

  for (const c of st.clusters) {
    if (!c.sub) continue; // family-direct docs have no separate ring
    const x = SX(c.x),
      y = SY(c.y),
      r = c.r * s;

    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = c.color + '40';
    ctx.stroke();
    ctx.font = '500 ' + Math.max(9, 11 * s) + 'px Manrope, system-ui, sans-serif';
    ctx.fillStyle = c.color + 'cc';
    ctx.textAlign = 'center';
    ctx.fillText(c.sub, x, y - r - 9 * s);
    ctx.textAlign = 'left';
  }
}

function graphDraw(st) {
  const ctx = graphCanvas.getContext('2d');
  const w = graphCanvas.clientWidth,
    h = graphCanvas.clientHeight;

  ctx.clearRect(0, 0, w, h);
  const { cam, nodes, edges, hover } = st;
  const SX = (n) => n.x * cam.scale + cam.ox,
    SY = (n) => n.y * cam.scale + cam.oy;
  // Scaffold UNDER the nodes: structured "map" mode → tidy folder boxes + subfolder
  // rings; organic mode → translucent zone blobs per top-level folder.
  if (st.mode === 'structured') {
    drawStructuredScaffold(ctx, st);
  } else {
    drawOrganicZones(ctx, st);
  }

  // ── Render pass: link arcs + node glow ──
  const now = performance.now();

  // 1) Wikilinks bow into arcs (additive glow); tag links stay faint and straight.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  for (const e of edges) {
    const hot = hover && (e.s === hover || e.t === hover);
    const ax = SX(e.s),
      ay = SY(e.s),
      bx = SX(e.t),
      by = SY(e.t);

    if (e.kind === 'link') {
      const dx = bx - ax,
        dy = by - ay,
        len = Math.hypot(dx, dy) || 1;
      const bow = Math.min(26, len * 0.16);

      e._cx = (ax + bx) / 2 - (dy / len) * bow;
      e._cy = (ay + by) / 2 + (dx / len) * bow;
      ctx.strokeStyle = hot ? 'rgba(196,181,253,0.95)' : 'rgba(150,130,246,0.28)';
      ctx.lineWidth = hot ? 2 : 1.1;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.quadraticCurveTo(e._cx, e._cy, bx, by);
      ctx.stroke();
    } else {
      ctx.strokeStyle = hot ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.05)';
      ctx.lineWidth = hot ? 1.2 : 0.7;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }
  }

  // 2) Firing synapses: a pulse of light travels along each wikilink arc.
  let pi = 0;

  for (const e of edges) {
    if (e.kind !== 'link') continue;
    const ax = SX(e.s),
      ay = SY(e.s),
      bx = SX(e.t),
      by = SY(e.t);
    const tt = (now * 0.00016 + pi++ * 0.1379) % 1,
      u = 1 - tt;
    const px = u * u * ax + 2 * u * tt * e._cx + tt * tt * bx;
    const py = u * u * ay + 2 * u * tt * e._cy + tt * tt * by;
    const env = Math.sin(tt * Math.PI); // fade in/out along the arc
    const gr = 0.9 + env * 1.0;

    ctx.globalAlpha = 0.3 + env * 0.3;
    ctx.beginPath();
    ctx.arc(px, py, gr, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(200,188,250,0.9)';
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  ctx.restore();
  // 3) Radial glow under each doc node; recently-edited ones pulse.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  for (const n of nodes) {
    if (n.kind !== 'doc') continue;
    const dim = hover && n !== hover && !n._adj;

    if (dim) continue;
    const r = Math.max(2, n.r * cam.scale),
      x = SX(n),
      y = SY(n);
    const breath = n.recent
      ? 1 +
        0.12 * Math.sin(now * 0.004 + (n._ph || (n._ph = (Math.abs(n.x) + Math.abs(n.y)) % 6.28)))
      : 1;
    const gr = (r + (n.recent ? 7 : 4)) * 2.1 * breath;
    const g = ctx.createRadialGradient(x, y, 0, x, y, gr);

    g.addColorStop(0, n.color + (n.recent ? '3a' : '30'));
    g.addColorStop(1, n.color + '00');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, gr, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();

  // 4) Neuron cores: solid doc discs, hollow-tinted tags, a ring on media docs.
  for (const n of nodes) {
    const dim = hover && n !== hover && !n._adj;
    const orphan = n.kind === 'doc' && n.deg === 0;
    const r = Math.max(2, n.r * cam.scale),
      x = SX(n),
      y = SY(n);

    // Orphans (no link, no tag) muted when not hovered: disconnected thoughts.
    ctx.globalAlpha = !dim && !hover && orphan ? 0.45 : 1;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = dim ? 'rgba(110,110,130,0.3)' : n.kind === 'tag' ? n.color + '33' : n.color;
    ctx.fill();

    if (n.kind === 'tag') {
      ctx.lineWidth = dim ? 1 : 1.6;
      ctx.strokeStyle = dim ? 'rgba(150,150,160,0.3)' : n.color;
      ctx.stroke();
    } else if (n.doctype && n.doctype !== '.md' && !dim) {
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.72)';
      ctx.stroke();
    }

    if (n === hover) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
  }

  ctx.font = '12px Manrope, system-ui, sans-serif';
  ctx.textBaseline = 'middle';

  for (const n of nodes) {
    // Node labels only on hover / neighborhood / zoom: region names (above)
    // carry the orientation, so labels don't clutter the default view. EXCEPTION:
    // when the tag layer is explicitly toggled on, label every tag so turning it on
    // visibly shows the tags (otherwise they're faint rings lost in the dense zones).
    const tagAlways = n.kind === 'tag' && st.showTags && st.mode === 'organic';

    if (!(tagAlways || n === hover || n._adj || cam.scale > 1.35)) continue;
    ctx.font = (n.kind === 'tag' ? '600 12px' : '12px') + ' Manrope, system-ui, sans-serif';
    ctx.fillStyle =
      hover && n !== hover && !n._adj
        ? 'rgba(150,150,160,0.5)'
        : n.kind === 'tag'
          ? n.color
          : '#e5e6e8';
    ctx.fillText(n.name, SX(n) + Math.max(2, n.r * cam.scale) + 4, SY(n));
  }
}

function graphLoop() {
  const st = graphState;

  if (!st) return;

  // Structured "map" mode has fixed positions → no physics, just draw (hover/zoom/pan
  // and node breathing still animate).
  if (st.mode !== 'structured' && st.ticks < 480) {
    graphSimStep(st);
    st.ticks++;
  }

  graphDraw(st);
  graphRaf = requestAnimationFrame(graphLoop);
}

function graphNodeAt(st, sx, sy) {
  const { cam, nodes } = st;

  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    const dx = sx - (n.x * cam.scale + cam.ox),
      dy = sy - (n.y * cam.scale + cam.oy);
    const r = Math.max(6, n.r * cam.scale + 4);

    if (dx * dx + dy * dy <= r * r) return n;
  }

  return null;
}

graphCanvas.addEventListener('mousedown', (e) => {
  const st = graphState;

  if (!st) return;
  st.drag = graphNodeAt(st, e.offsetX, e.offsetY);
  st.panFrom = { x: e.offsetX, y: e.offsetY, ox: st.cam.ox, oy: st.cam.oy };
  st.moved = false;
});
graphCanvas.addEventListener('mousemove', (e) => {
  const st = graphState;

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

  const n = graphNodeAt(st, e.offsetX, e.offsetY);

  if (n !== st.hover) {
    st.nodes.forEach((x) => (x._adj = false));

    if (n)
      for (const e2 of st.edges) {
        if (e2.s === n) e2.t._adj = true;
        else if (e2.t === n) e2.s._adj = true;
      }

    st.hover = n;
  }

  graphCanvas.style.cursor = n ? 'pointer' : 'grab';

  if (n) {
    graphTooltip.textContent =
      n.kind === 'tag'
        ? n.name + '  ' + t('nDocs', n.docs)
        : n.name + (n.tags.length ? '  ' + n.tags.map((tag) => '#' + tag).join(' ') : '');
    graphTooltip.style.left = e.offsetX + 14 + 'px';
    graphTooltip.style.top = e.offsetY + 12 + 'px';
    graphTooltip.classList.remove('hidden');
  } else graphTooltip.classList.add('hidden');
});
window.addEventListener('mouseup', () => {
  const st = graphState;

  if (!st || !st.panFrom) return;
  const node = st.drag,
    moved = st.moved;

  st.panFrom = null;
  st.drag = null;

  if (node && !moved) {
    if (node.kind === 'tag') {
      closeGraph();
      showTag(node.tag);

      return;
    }

    const f = fileMap[node.path];

    closeGraph();

    if (f) {
      showMarkdown(f);
      history.replaceState(null, '', '#' + encodeURIComponent(f.path));
    }
  }
});
graphCanvas.addEventListener(
  'wheel',
  (e) => {
    const st = graphState;

    if (!st) return;
    e.preventDefault();
    const ns = Math.max(0.2, Math.min(4, st.cam.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));

    st.cam.ox = e.offsetX - (e.offsetX - st.cam.ox) * (ns / st.cam.scale);
    st.cam.oy = e.offsetY - (e.offsetY - st.cam.oy) * (ns / st.cam.scale);
    st.cam.scale = ns;
  },
  { passive: false },
);
document.getElementById('graph-close').addEventListener('click', closeGraph);
document.getElementById('graph-btn').addEventListener('click', openGraph);

// ── View-mode toggle: organic brain ⇄ structured folder map (+ tag-layer toggle) ──
function updateGraphModeUI() {
  const st = graphState;
  const orgBtn = document.getElementById('graph-mode-organic');

  if (!st || !orgBtn) return;
  const strBtn = document.getElementById('graph-mode-structured');
  const tagBtn = document.getElementById('graph-tags-toggle');
  const setActive = (btn, on) => {
    btn.classList.toggle('bg-white/15', on);
    btn.classList.toggle('text-white', on);
    btn.classList.toggle('text-ink-400', !on);
  };

  setActive(orgBtn, st.mode === 'organic');
  setActive(strBtn, st.mode === 'structured');

  if (tagBtn) {
    // Tags only matter in organic mode.
    tagBtn.style.opacity = st.mode === 'organic' ? '1' : '.4';
    tagBtn.style.pointerEvents = st.mode === 'organic' ? 'auto' : 'none';
    setActive(tagBtn, st.mode === 'organic' && st.showTags);
  }
}

function setGraphMode(mode) {
  const st = graphState;

  if (!st || st.mode === mode) return;
  st.mode = mode;
  applyGraphView(st);

  if (mode === 'structured') {
    layoutStructured(st);
  } else {
    reseedOrganic(st);
  }

  st.ticks = 0;
  st.hover = null;
  fitGraphCamera(st);
  updateGraphModeUI();
}

function toggleGraphTags() {
  const st = graphState;

  if (!st || st.mode !== 'organic') return;
  st.showTags = !st.showTags;
  applyGraphView(st);

  // Seed each freshly-shown tag at the centroid of the docs it links, so it appears in
  // place instead of flying in from a random corner. Docs keep their settled positions
  // (no full re-seed → the layout doesn't jump), then a short re-settle integrates the tags.
  if (st.showTags) {
    for (const n of st.nodes) {
      if (n.kind !== 'tag') continue;
      let cx = 0,
        cy = 0,
        k = 0;

      for (const e of st.edges) {
        if (e.kind === 'tag' && e.t === n) {
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

  st.ticks = Math.min(st.ticks, 360); // a gentle re-settle, not a full upheaval
  updateGraphModeUI();
}

document.getElementById('graph-mode-organic')?.addEventListener('click', () => setGraphMode('organic'));
document.getElementById('graph-mode-structured')?.addEventListener('click', () => setGraphMode('structured'));
document.getElementById('graph-tags-toggle')?.addEventListener('click', toggleGraphTags);
window.addEventListener('resize', () => {
  if (graphState) resizeGraph();
});

// Embed hero: open the graph chrome-less. The host iframe is pointer-events:none,
// so there is nothing to interact with — it just lives.
if (EMBED_MIND) {
  const gc = document.getElementById('graph-controls');

  if (gc) gc.style.display = 'none';
  openGraph();
}

// To-do widget
// A static OFFLINE build (EMBED_CONTENT inlined) is NEVER in server mode, even when
// hosted over http(s) — e.g. the GitHub Pages /demo/. Keying this on the protocol
// alone made such a build hit /api/* endpoints and a service worker that don't exist
// there → 404s and a home stuck on skeletons. Offline = read from the embed.
const isServerMode = (location.protocol === 'http:' || location.protocol === 'https:') && !IS_OFFLINE_BUILD;
const todoWidget = document.getElementById('todo-widget');
const todoHeader = document.getElementById('todo-header');
const todoBody = document.getElementById('todo-body');
const todoChevron = document.getElementById('todo-chevron');
const todoList = document.getElementById('todo-list');
const todoForm = document.getElementById('todo-form');
const todoInput = document.getElementById('todo-input');
const todoCount = document.getElementById('todo-count');
const todoBubbleCount = document.getElementById('todo-bubble-count');
const todoStatus = document.getElementById('todo-status');

let collapsed;

{
  const stored = localStorage.getItem('todo-collapsed');

  collapsed = stored === null ? isMobile() : stored === '1';
}

applyCollapsed();

function applyCollapsed() {
  if (collapsed) {
    todoBody.classList.add('hidden');
    todoChevron.style.transform = 'rotate(-90deg)';
    todoWidget.classList.add('is-collapsed');
  } else {
    todoBody.classList.remove('hidden');
    todoChevron.style.transform = '';
    todoWidget.classList.remove('is-collapsed');
  }
}

todoHeader.addEventListener('click', () => {
  collapsed = !collapsed;
  localStorage.setItem('todo-collapsed', collapsed ? '1' : '0');
  applyCollapsed();
});

function updateHomeTodoStat() {
  const el = document.getElementById('home-todo-stat');

  if (!el) return;
  el.textContent = todos.length ? `${todos.filter((t) => t.done).length}/${todos.length}` : '–';
}

function buildFavicon(count) {
  const badge =
    count > 0
      ? "<circle cx='23' cy='9' r='8' fill='#ef4444' stroke='#0e0d12' stroke-width='1.5'/>" +
        "<text x='23' y='12.5' font-family='system-ui,Arial,sans-serif' font-size='" +
        (count > 9 ? '8.5' : '10') +
        "' font-weight='800' fill='white' text-anchor='middle'>" +
        (count > 9 ? '9+' : count) +
        '</text>'
      : '';
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>" +
    '<defs>' +
    "<radialGradient id='sky' cx='50%' cy='40%' r='65%'><stop offset='0%' stop-color='#1f1d2a'/><stop offset='100%' stop-color='#0a0a12'/></radialGradient>" +
    "<radialGradient id='glow' cx='50%' cy='50%' r='50%'><stop offset='0%' stop-color='#fbc678' stop-opacity='0.75'/><stop offset='100%' stop-color='#fbc678' stop-opacity='0'/></radialGradient>" +
    '</defs>' +
    "<rect width='32' height='32' rx='7' fill='url(#sky)'/>" +
    "<circle cx='16' cy='16' r='9' fill='none' stroke='#fff' stroke-width='0.7' opacity='0.4'/>" +
    "<circle cx='16' cy='16' r='1.2' fill='#fff' opacity='0.85'/>" +
    "<circle cx='22.36' cy='9.64' r='4' fill='url(#glow)'/>" +
    "<circle cx='22.36' cy='9.64' r='1.9' fill='#fbc678'/>" +
    badge +
    '</svg>';

  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

function updateTabBadge() {
  const pending = todos.filter((t) => !t.done).length;

  document.title = pending > 0 ? '(' + pending + ') ' + SITE_NAME : SITE_NAME;
  const link = document.querySelector("link[rel='icon']");

  if (link) link.href = buildFavicon(pending);
}

let showDoneTodos = localStorage.getItem('todo-show-done') === '1';
// Todo categories injected at build time from atlas.toml ([todo].categories);
// tabs, labels and filter all derive from them.
const TODO_CATEGORIES = __TODO_CATEGORIES_JSON__;
const TODO_CATS = TODO_CATEGORIES.map((c) => c.cat);
const TODO_FILTER_LABELS = Object.fromEntries(TODO_CATEGORIES.map((c) => [c.cat, c.label]));
// An unknown cat (todo from a category removed from the config) falls back to the
// first configured category (the default), instead of a hard-coded "work".
const tcat = (t) => (TODO_CATS.includes(t.cat) ? t.cat : TODO_CATS[0]);
let todoFilter = localStorage.getItem('todo-filter');

if (!TODO_CATS.includes(todoFilter)) todoFilter = TODO_CATS[0];
(function buildTodoFilterTabs() {
  const wrap = document.getElementById('todo-filter');

  if (!wrap) return;
  wrap.innerHTML = TODO_CATEGORIES.map(
    (c) =>
      `<button type="button" data-cat="${escapeHtml(c.cat)}" class="todo-filter-btn flex-1 px-3 py-2 transition hover:bg-white/5 text-ink-500">${escapeHtml(c.label)}</button>`,
  ).join('');
})();

function renderTodoFilterTabs() {
  document.querySelectorAll('.todo-filter-btn').forEach((btn) => {
    const cat = btn.dataset.cat;
    const active = cat === todoFilter;
    const pending = todos.filter((t) => tcat(t) === cat && !t.done).length;

    btn.classList.toggle('text-accent', active);
    btn.classList.toggle('bg-accent/10', active);
    btn.classList.toggle('text-ink-500', !active);
    btn.textContent =
      pending > 0 ? `${TODO_FILTER_LABELS[cat]} (${pending})` : TODO_FILTER_LABELS[cat];
  });
}

// ── Read-only demo banner ────────────────────────────────────────────────────
// Shown ONLY on the static/offline build (the demo) — the live server has working
// write features, so it never appears there. Dismissible per tab session: a new
// visitor still sees it, but it doesn't nag while browsing.
(function () {
  if (!IS_OFFLINE_BUILD || window.__viewerMode) return;
  // Don't nag inside an embed: the landing page iframes the demo (./demo/#mind) as
  // a live hero, where the banner would be noise. Any iframe → skip it.
  try {
    if (window.self !== window.top) return;
  } catch (e) {
    return; // cross-origin embed (can't read window.top) → definitely embedded
  }
  const banner = document.getElementById('demo-banner');
  if (!banner) return;
  try {
    if (sessionStorage.getItem('demoBannerDismissed') === '1') return;
  } catch (e) {
    /* sessionStorage unavailable (file://, private mode) → just show it */
  }
  banner.classList.remove('hidden');
  document.getElementById('demo-banner-close')?.addEventListener('click', () => {
    banner.classList.add('hidden');
    try {
      sessionStorage.setItem('demoBannerDismissed', '1');
    } catch (e) {
      /* ignore */
    }
  });
})();

// ── Atlas combobox — one reusable "search + create" field ───────────────────
// Factory (the viewer is concatenated IIFEs, not ES modules):
// AtlasCombobox(input, opts) -> controller.
//
//   opts.source     : () => string[] | async () => string[]   current suggestions
//   opts.creatable  : bool   offer « Créer "X" » when the typed value has no match
//   opts.multi      : bool   chips mode (tags, group members); getValue() -> array
//   opts.separator  : ','    serialize/parse a CSV string (setValue in multi)
//   opts.normalize  : v=>v   e.g. lowercase emails (ACL)
//   opts.format     : v=>html  row rendering (default escapeHtml)
//   opts.maxItems   : 50     display cap
//   opts.onSelect   : v=>{}  callback on pick (else writes to the input)
//
// controller: getValue/setValue/refresh/clear/focus/open/close/destroy.

// Shared dialog/button class tokens (design system) — used by the combobox AND to
// stop duplicating Tailwind strings in confirmDialog / acl grant-rows / history.
window.AtlasUI = {
  btnPrimary: 'px-3 py-1.5 text-sm bg-accent hover:brightness-110 text-white rounded font-medium',
  btnDanger: 'px-3 py-1.5 text-sm bg-rose-500/80 hover:bg-rose-500 text-white rounded font-medium',
  btnSecondary: 'px-3 py-1.5 text-sm bg-navy-700 hover:bg-navy-600 text-ink-200 rounded',
  input: 'w-full px-3 py-2 text-sm bg-navy-900 border subtle-border rounded text-ink-100 placeholder-ink-500 focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent',
  label: 'text-[11px] uppercase tracking-wider text-ink-500 font-semibold mb-1 block',
};

(function () {
  function AtlasCombobox(input, opts) {
    opts = opts || {};
    input.removeAttribute('list'); // kill the native datalist
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'false');

    const pop = document.createElement('div');
    pop.className =
      'atlas-cb-pop fixed hidden max-h-64 overflow-y-auto scrollbar-thin ' +
      'rounded-md border subtle-border shadow-2xl shadow-black/70 text-sm';
    // z-index inline: an arbitrary Tailwind z-[..] in a JS string isn't compiled (see 03-panels.css).
    pop.style.zIndex = '80';
    document.body.appendChild(pop);

    const norm = opts.normalize || ((v) => v);
    const fmt = opts.format || ((v) => escapeHtml(v));
    let all = [];
    let items = []; // strings, plus an optional {__create} sentinel at the end
    let active = 0;
    let isOpen = false;
    let chipBox = null;
    let values = []; // multi mode

    async function load() {
      try {
        all = (await (opts.source ? opts.source() : [])) || [];
      } catch (_) {
        all = [];
      }
    }

    function compute() {
      const raw = input.value.trim();
      const q = raw.toLowerCase();
      let res = q ? all.filter((v) => String(v).toLowerCase().includes(q)) : all.slice();
      if (q) {
        const rk = (v) => (String(v).toLowerCase().startsWith(q) ? 0 : 1);
        res.sort((a, b) => rk(a) - rk(b));
      }
      res = res.slice(0, opts.maxItems || 50).filter((v) => !(opts.multi && values.includes(v)));
      const exact = all.some((v) => String(v).toLowerCase() === q);
      return { res, create: opts.creatable && raw && !exact ? raw : null };
    }

    function render() {
      const { res, create } = compute();
      items = res.slice();
      let html = res
        .map(
          (v, i) =>
            '<div class="atlas-cb-opt px-3 py-1.5 cursor-pointer hover:bg-white/5 ' +
            (i === active ? 'bg-white/10' : '') +
            '" data-i="' + i + '">' + fmt(v) + '</div>',
        )
        .join('');
      if (create) {
        const ci = res.length;
        html +=
          '<div class="atlas-cb-create px-3 py-1.5 cursor-pointer hover:bg-white/5 text-accent ' +
          'flex items-center gap-2 ' + (active === ci ? 'bg-white/10' : '') +
          '" data-create="1"><span class="text-base leading-none">+</span>' +
          escapeHtml(t('comboCreate', create)) + '</div>';
        items.push({ __create: create });
      }
      if (!items.length) {
        pop.innerHTML = '<div class="px-3 py-1.5 text-ink-500">' + escapeHtml(t('noResults')) + '</div>';
      } else {
        pop.innerHTML = html;
      }
      const r = input.getBoundingClientRect();
      pop.style.left = r.left + 'px';
      pop.style.top = r.bottom + 4 + 'px';
      pop.style.width = r.width + 'px';
      pop.classList.remove('hidden');
      isOpen = true;
      input.setAttribute('aria-expanded', 'true');
      const a = pop.children[active];
      if (a && a.scrollIntoView) a.scrollIntoView({ block: 'nearest' });
    }

    function close() {
      pop.classList.add('hidden');
      isOpen = false;
      input.setAttribute('aria-expanded', 'false');
    }

    function choose(it) {
      if (it == null) return;
      const val = norm(typeof it === 'object' && it.__create != null ? it.__create : it);
      if (opts.multi) {
        addChip(val);
        input.value = '';
      } else {
        input.value = val;
      }
      close();
      if (opts.onSelect) opts.onSelect(val);
    }

    // chips (multi) — reuse the existing .doc-tag / .doc-tag-x styling.
    function ensureChipBox() {
      if (opts.multi && !chipBox) {
        chipBox = document.createElement('div');
        chipBox.className = 'flex flex-wrap gap-1.5 mb-1.5 empty:hidden';
        input.parentNode.insertBefore(chipBox, input);
        chipBox.addEventListener('click', (e) => {
          const b = e.target.closest('[data-rm]');
          if (b) {
            values = values.filter((x) => x !== b.dataset.rm);
            renderChips();
          }
        });
      }
    }
    function renderChips() {
      if (!chipBox) return;
      chipBox.innerHTML = values
        .map(
          (v) =>
            '<span class="doc-tag">' + escapeHtml(v) +
            '<button type="button" class="doc-tag-x ml-1" data-rm="' + escapeHtml(v) + '">×</button></span>',
        )
        .join('');
    }
    function addChip(v) {
      ensureChipBox();
      if (!v || values.includes(v)) return;
      values.push(v);
      renderChips();
    }

    input.addEventListener('focus', async () => {
      await load();
      active = 0;
      render();
    });
    input.addEventListener('input', () => {
      active = 0;
      render();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && opts.multi && !input.value && values.length) {
        values.pop();
        renderChips();
        return;
      }
      if (!isOpen) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        active = Math.min(active + 1, items.length - 1);
        render();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        active = Math.max(active - 1, 0);
        render();
      } else if (e.key === 'Enter') {
        if (items[active] != null) {
          e.preventDefault();
          choose(items[active]);
        }
      } else if (e.key === 'Escape') {
        e.stopPropagation(); // close the dropdown, NOT the dialog
        close();
      }
    });
    pop.addEventListener('mousedown', (e) => {
      const el = e.target.closest('[data-i],[data-create]');
      if (!el) return;
      e.preventDefault(); // keep focus on the input
      choose(el.dataset.create ? items[items.length - 1] : items[+el.dataset.i]);
    });
    input.addEventListener('blur', () => setTimeout(close, 120));

    return {
      getValue: () => (opts.multi ? values.slice() : input.value.trim()),
      setValue: (v) => {
        if (opts.multi) {
          values = Array.isArray(v)
            ? v.slice()
            : String(v || '').split(opts.separator || ',').map((s) => s.trim()).filter(Boolean);
          ensureChipBox();
          renderChips();
        } else {
          input.value = v || '';
        }
      },
      refresh: async () => {
        await load();
        if (isOpen) render();
      },
      clear: () => {
        if (opts.multi) {
          values = [];
          renderChips();
        } else {
          input.value = '';
        }
      },
      focus: () => input.focus(),
      open: () => render(),
      close,
      destroy: () => {
        pop.remove();
        if (chipBox) chipBox.remove();
      },
    };
  }

  window.AtlasCombobox = AtlasCombobox;
})();

function renderTodos() {
  const inCat = todos.filter((t) => tcat(t) === todoFilter);
  const total = inCat.length;
  const done = inCat.filter((t) => t.done).length;
  const pendingAll = todos.filter((t) => !t.done).length;

  // Title shows the cumulative total across both categories; the per-category
  // remaining count already lives on the Work/Personal tabs.
  todoCount.textContent = pendingAll ? t('nPending', pendingAll) : '';
  todoBubbleCount.textContent = pendingAll > 9 ? '9+' : String(pendingAll);
  todoBubbleCount.classList.toggle('empty', pendingAll === 0);
  renderTodoFilterTabs();

  if (todoInput) todoInput.placeholder = t('addTodoIn', TODO_FILTER_LABELS[todoFilter]);
  updateHomeTodoStat();
  updateTabBadge();

  const controls = document.getElementById('todo-controls');
  const toggleLabel = document.getElementById('todo-toggle-label');
  const toggleIcon = document.getElementById('todo-toggle-icon');

  if (done > 0) {
    controls.classList.remove('hidden');
    controls.classList.add('flex');
    toggleLabel.textContent = showDoneTodos ? t('hideDone', done) : t('showDone', done);
    toggleIcon.style.transform = showDoneTodos ? 'rotate(180deg)' : '';
  } else {
    controls.classList.add('hidden');
    controls.classList.remove('flex');
  }

  if (inCat.length === 0) {
    todoList.innerHTML = `<li class="px-3 py-4 text-center text-xs text-ink-500">${t('noTasksIn', TODO_FILTER_LABELS[todoFilter])}</li>`;

    return;
  }

  const visible = showDoneTodos ? inCat : inCat.filter((t) => !t.done);

  if (visible.length === 0) {
    todoList.innerHTML = `<li class="px-3 py-4 text-center text-xs text-ink-500">${t('allDone', done)}</li>`;

    return;
  }

  todoList.innerHTML = visible
    .map(
      (item) => `
    <li class="todo-row group flex items-start gap-2 px-3 py-2 hover:bg-navy-800/40" data-id="${item.id}">
      <input type="checkbox" ${item.done ? 'checked' : ''}
        class="todo-check mt-0.5 w-4 h-4 rounded border-navy-600 bg-navy-900 text-blue-500 focus:ring-blue-400/40 cursor-pointer accent-blue-500">
      <span class="todo-text flex-1 text-sm leading-snug ${item.done ? 'line-through text-ink-500' : 'text-ink-100'} cursor-pointer">${escapeHtml(item.text)}</span>
      <button class="todo-del opacity-0 group-hover:opacity-100 text-ink-500 hover:text-rose-400 text-base leading-none transition-opacity" title="${escapeHtml(t('del'))}">&times;</button>
    </li>
  `,
    )
    .join('');
}

function startInlineEdit(row) {
  const id = parseInt(row.dataset.id);
  const item = todos.find((t) => t.id === id);

  if (!item) return;
  const textSpan = row.querySelector('.todo-text');

  if (!textSpan) return;
  const input = document.createElement('input');

  input.type = 'text';
  input.value = item.text;
  input.className =
    'todo-edit flex-1 px-2 py-0.5 text-sm bg-navy-900 border border-blue-400 rounded text-ink-100 focus:outline-none focus:ring-1 focus:ring-blue-400/40';
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
        todos = await api('PATCH', '/api/todos/' + id, { text: newText });
        renderTodos();
        setStatus(t('updated'), 'ok');

        return;
      } catch (e) {
        setStatus(t('err', e.message), 'err');
      }
    }

    renderTodos();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      commit(false);
    }
  });
  input.addEventListener('blur', () => commit(true));
}

function setStatus(msg, kind) {
  const colors = { ok: 'text-emerald-400', err: 'text-rose-400', info: 'text-ink-500' };

  todoStatus.innerHTML = `<span class="${colors[kind] || colors.info}">${msg}</span><span class="text-ink-600">${location.host}</span>`;
}

async function api(method, path, body) {
  const opts = { method, headers: {} };

  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(path, opts);

  if (!res.ok) throw new Error('HTTP ' + res.status);

  return res.json();
}

async function refresh() {
  if (!isServerMode) return;

  try {
    todos = await api('GET', '/api/todos');
    renderTodos();
    setStatus(t('synced'), 'info');
  } catch (e) {
    setStatus(t('offlinePrefix', e.message), 'err');
  }
}

todoForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = todoInput.value.trim();

  if (!text) return;
  todoInput.value = '';

  if (!isServerMode) {
    setStatus(t('fileModeTodoStatus'), 'err');

    return;
  }

  try {
    setStatus(t('adding'), 'info');
    todos = await api('POST', '/api/todos', { text, cat: todoFilter });
    renderTodos();
    setStatus(t('added'), 'ok');
  } catch (e) {
    setStatus(t('err', e.message), 'err');
  }
});

todoList.addEventListener('click', async (e) => {
  const row = e.target.closest('.todo-row');

  if (!row) return;
  const id = parseInt(row.dataset.id);

  if (e.target.closest('.todo-check')) {
    const check = e.target.closest('.todo-check');

    try {
      todos = await api('PATCH', '/api/todos/' + id, { done: check.checked });
      renderTodos();
      setStatus(check.checked ? t('doneStatus') : t('reopened'), 'ok');
    } catch (e) {
      setStatus(t('err', e.message), 'err');
      check.checked = !check.checked;
    }

    return;
  }

  if (e.target.closest('.todo-del')) {
    try {
      todos = await api('DELETE', '/api/todos/' + id);
      renderTodos();
      setStatus(t('deletedStatus'), 'ok');
    } catch (e) {
      setStatus(t('err', e.message), 'err');
    }

    return;
  }

  if (e.target.closest('.todo-text')) {
    startInlineEdit(row);
  }
});

document.getElementById('todo-filter').addEventListener('click', (e) => {
  const btn = e.target.closest('.todo-filter-btn');

  if (!btn || btn.dataset.cat === todoFilter) return;
  todoFilter = btn.dataset.cat;
  localStorage.setItem('todo-filter', todoFilter);
  renderTodos();
});

document.getElementById('todo-toggle-done').addEventListener('click', () => {
  showDoneTodos = !showDoneTodos;
  localStorage.setItem('todo-show-done', showDoneTodos ? '1' : '0');
  renderTodos();
});

document.getElementById('todo-clear-done').addEventListener('click', async () => {
  const doneTodos = todos.filter((t) => t.done && tcat(t) === todoFilter);

  if (doneTodos.length === 0) return;
  const ok = await confirmDialog({
    title: t('clearDoneConfirmTitle', doneTodos.length),
    message: t('clearDoneConfirmMsg'),
    confirmLabel: t('clearBtn'),
    destructive: true,
  });

  if (!ok) return;
  // Delete largest id first: the server indexes by position, so deleting N shifts
  // all > N; descending order keeps the remaining indices valid.
  const idsDesc = doneTodos.map((t) => t.id).sort((a, b) => b - a);

  try {
    setStatus(t('clearing'), 'info');

    for (const id of idsDesc) {
      todos = await api('DELETE', '/api/todos/' + id);
    }

    renderTodos();
    setStatus(t('nCleared', idsDesc.length), 'ok');
  } catch (e) {
    setStatus(t('err', e.message), 'err');
  }
});

// ── More actions menu + Rename modal (admin) ─────────────────────────────────
const btnMore = document.getElementById('btn-more');
const btnMoreMenu = document.getElementById('btn-more-menu');
const renameBackdrop = document.getElementById('rename-backdrop');
const renameForm = document.getElementById('rename-form');
const renameTitle = document.getElementById('rename-title');
const renameDir = document.getElementById('rename-dir');
const renameDirWrap = document.getElementById('rename-dir-wrap');
const renameName = document.getElementById('rename-name');
const renameDirCb = AtlasCombobox(renameDir, { source: getAllDirs, creatable: true });
const renameError = document.getElementById('rename-error');
const renameCancel = document.getElementById('rename-cancel');

let renameMode = null;

function openRenameModal(mode) {
  if (!currentFile || window.__viewerMode) return;
  renameMode = mode;
  renameError.classList.add('hidden');
  const parts = currentFile.path.split('/');
  const currentName = parts.pop().replace(/\.(md|html)$/i, '');
  const currentDir = parts.join('/');

  renameName.value = currentName;
  renameDir.value = currentDir;

  if (mode === 'rename') {
    renameTitle.textContent = t('renameDocTitle');
    renameDirWrap.classList.add('hidden');
  } else {
    renameTitle.textContent = t('moveDocTitle');
    renameDirWrap.classList.remove('hidden');
  }

  renameBackdrop.classList.remove('hidden');
  setTimeout(() => (mode === 'rename' ? renameName : renameDir).focus(), 50);
}

function closeRenameModal() {
  renameBackdrop.classList.add('hidden');
}

btnMore.addEventListener('click', (e) => {
  e.stopPropagation();
  btnMoreMenu.classList.toggle('hidden');
});
document.addEventListener('click', () => btnMoreMenu.classList.add('hidden'));
btnMoreMenu.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');

  if (!btn) return;
  btnMoreMenu.classList.add('hidden');
  const action = btn.dataset.action;

  if (action === 'rename') return openRenameModal('rename');

  if (action === 'move') return openRenameModal('move');

  if (action === 'delete') {
    const ok = await confirmDialog({
      title: t('deleteDocTitle'),
      message: t('deleteDocMsg', currentFile.path),
      confirmLabel: t('del'),
      destructive: true,
    });

    if (!ok) return;

    try {
      const res = await fetch('/api/file', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: currentFile.path }),
      });

      if (!res.ok) throw new Error('HTTP ' + res.status);
      location.hash = '';
      setStatus(t('docDeleted'), 'ok');
      await refreshTreeOrReload();
    } catch (e) {
      notifyError('err', e.message);
    }
  }
});

renameCancel.addEventListener('click', closeRenameModal);
document.getElementById('rename-close')?.addEventListener('click', closeRenameModal);
renameBackdrop.addEventListener('click', (e) => {
  if (e.target === renameBackdrop) closeRenameModal();
});

renameForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  renameError.classList.add('hidden');
  let name = renameName.value.trim();

  if (!name) {
    renameError.textContent = t('nameRequired');
    renameError.classList.remove('hidden');

    return;
  }

  if (/[\\\/]/.test(name)) {
    renameError.textContent = t('noSlashes');
    renameError.classList.remove('hidden');

    return;
  }

  // Preserve the original extension if the user didn't type it.
  if (!/\.(md|html)$/i.test(name)) {
    const ext = (/\.(md|html)$/i.exec(currentFile.path) || [, 'md'])[1].toLowerCase();

    name += '.' + ext;
  }

  const dir = (
    renameMode === 'move'
      ? renameDir.value.trim()
      : currentFile.path.split('/').slice(0, -1).join('/')
  ).replace(/^\/+|\/+$/g, '');
  const newPath = dir ? dir + '/' + name : name;

  if (newPath === currentFile.path) {
    closeRenameModal();

    return;
  }

  if (fileMap[newPath]) {
    renameError.textContent = t('fileExistsAt');
    renameError.classList.remove('hidden');

    return;
  }

  try {
    const res = await fetch('/api/file/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: currentFile.path, to: newPath }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));

      throw new Error(err.error || 'HTTP ' + res.status);
    }

    closeRenameModal();
    // Move the content cache to the new path to avoid a needless re-fetch.
    const cached = contentCache.get(currentFile.path);

    if (cached !== undefined) {
      contentCache.delete(currentFile.path);
      contentCache.set(newPath, cached);
    }

    currentFile.path = newPath;
    location.hash = '#' + encodeURIComponent(newPath);
    setStatus(renameMode === 'move' ? t('docMoved') : t('docRenamed'), 'ok');
    await refreshTreeOrReload();
  } catch (e) {
    renameError.textContent = t('err', e.message);
    renameError.classList.remove('hidden');
  }
});

// ── Confirm dialog (replaces native confirm()) ───────────────────────────────
const confirmBackdrop = document.getElementById('confirm-backdrop');
const confirmTitle = document.getElementById('confirm-title');
const confirmMessage = document.getElementById('confirm-message');
const confirmOk = document.getElementById('confirm-ok');
const confirmCancel = document.getElementById('confirm-cancel');

function confirmDialog(opts) {
  return new Promise((resolve) => {
    const o = typeof opts === 'string' ? { message: opts } : opts || {};

    confirmTitle.textContent = o.title || t('confirm');
    confirmMessage.textContent = o.message || '';
    confirmOk.textContent = o.confirmLabel || t('confirm');
    confirmCancel.textContent = o.cancelLabel || t('cancel');
    confirmOk.className = o.destructive
      ? 'px-3 py-1.5 text-sm bg-rose-500/80 hover:bg-rose-500 text-white rounded font-medium'
      : 'px-3 py-1.5 text-sm bg-accent hover:brightness-110 text-white rounded font-medium';
    confirmBackdrop.classList.remove('hidden');
    setTimeout(() => confirmOk.focus(), 50);
    const cleanup = () => {
      confirmBackdrop.classList.add('hidden');
      confirmOk.removeEventListener('click', onOk);
      confirmCancel.removeEventListener('click', onCancel);
      confirmBackdrop.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
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
      if (e.target === confirmBackdrop) onCancel();
    };

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        onOk();
      }
    };

    confirmOk.addEventListener('click', onOk);
    confirmCancel.addEventListener('click', onCancel);
    confirmBackdrop.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
  });
}

// ── Alert popup (replaces the native alert()) ────────────────────────────────
// A single-button notice reusing the confirm dialog's chrome, so it matches every
// other modal. Fire-and-forget: callers don't await it.
function alertDialog(opts) {
  const o = typeof opts === 'string' ? { message: opts } : (opts || {});
  return new Promise((resolve) => {
    confirmTitle.textContent = o.title || t('errorTitle');
    confirmMessage.textContent = o.message || '';
    confirmOk.textContent = o.okLabel || t('ok');
    confirmOk.className = 'px-3 py-1.5 text-sm bg-accent hover:brightness-110 text-white rounded font-medium';
    confirmCancel.classList.add('hidden');   // alert = one OK button only
    confirmBackdrop.classList.remove('hidden');
    setTimeout(() => confirmOk.focus(), 50);
    const cleanup = () => {
      confirmBackdrop.classList.add('hidden');
      confirmCancel.classList.remove('hidden');   // restore for confirmDialog
      confirmOk.removeEventListener('click', done);
      confirmBackdrop.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
    };
    const done = () => { cleanup(); resolve(); };
    const onBackdrop = (e) => { if (e.target === confirmBackdrop) done(); };
    const onKey = (e) => {
      if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); done(); }
    };
    confirmOk.addEventListener('click', done);
    confirmBackdrop.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
  });
}

// Error notice. In an OFFLINE build every server-backed action is disabled, so we
// always show one clear "disabled offline" message (in the UI language) rather
// than leaking a raw network error; online we show the specific message for `key`.
function notifyError(key, ...args) {
  if (IS_OFFLINE_BUILD) {
    return alertDialog({ title: t('offlineTitle'), message: t('offlineDisabled') });
  }
  return alertDialog({ title: t('errorTitle'), message: t(key, ...args) });
}

// Input modal (replaces the native prompt, banned from the viewer). Resolves the
// entered value (trimmed) or null if cancelled/empty.
function promptDialog(opts) {
  const o = opts || {};
  const backdrop = document.getElementById('prompt-backdrop');
  const input = document.getElementById('prompt-input');

  document.getElementById('prompt-title').textContent = o.title || '';
  document.getElementById('prompt-message').textContent = o.message || '';
  input.placeholder = o.placeholder || '';
  input.value = o.value || '';
  const okBtn = document.getElementById('prompt-ok');
  const cancelBtn = document.getElementById('prompt-cancel');

  okBtn.textContent = o.confirmLabel || t('confirm');

  return new Promise((resolve) => {
    backdrop.classList.remove('hidden');
    setTimeout(() => {
      input.focus();
      input.select();
    }, 50);
    const cleanup = () => {
      backdrop.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      backdrop.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
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
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        onOk();
      }
    };

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    backdrop.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
  });
}

// ── Reset password modal (admin + cloud) ─────────────────────────────────────
// Replaces the native prompt: entry + confirmation, length validation (min 8),
// live equality check, show/hide toggle, inline success.
const RESET_PW_MIN = 8;
const resetPwBackdrop = document.getElementById('reset-pw-backdrop');
const resetPwForm = document.getElementById('reset-pw-form');
const resetPwEmail = document.getElementById('reset-pw-email');
const resetPwInput = document.getElementById('reset-pw-input');
const resetPwConfirm = document.getElementById('reset-pw-confirm');
const resetPwToggle = document.getElementById('reset-pw-toggle');
const resetPwEye = document.getElementById('reset-pw-eye');
const resetPwEyeOff = document.getElementById('reset-pw-eye-off');
const resetPwError = document.getElementById('reset-pw-error');
const resetPwSuccess = document.getElementById('reset-pw-success');
const resetPwSubmit = document.getElementById('reset-pw-submit');
const resetPwCancel = document.getElementById('reset-pw-cancel');
const resetPwClose = document.getElementById('reset-pw-close');
let resetPwTargetEmail = null;
let resetPwCloseTimer = null;

function resetPwValidationError() {
  const pw = resetPwInput.value;
  const confirm = resetPwConfirm.value;

  if (pw.length < RESET_PW_MIN) return t('settingsPasswordTooShort');

  if (pw !== confirm) return t('settingsPasswordMismatch');

  return null;
}

function refreshResetPwState() {
  resetPwError.classList.add('hidden');
  // Disable only while the 1st field is too short (immediate signal, doesn't block
  // typing the confirmation); otherwise stay enabled and show the precise error on submit.
  const tooShort = resetPwInput.value.length < RESET_PW_MIN;

  resetPwSubmit.disabled = tooShort || resetPwConfirm.value.length === 0;
}

function setResetPwVisibility(show) {
  resetPwInput.type = show ? 'text' : 'password';
  resetPwConfirm.type = show ? 'text' : 'password';
  resetPwEye.classList.toggle('hidden', show);
  resetPwEyeOff.classList.toggle('hidden', !show);
  resetPwToggle.setAttribute('aria-pressed', show ? 'true' : 'false');
}

function openResetPassword(email) {
  if (resetPwCloseTimer) {
    clearTimeout(resetPwCloseTimer);
    resetPwCloseTimer = null;
  }

  resetPwTargetEmail = email || '';
  resetPwEmail.textContent = resetPwTargetEmail;
  resetPwInput.value = '';
  resetPwConfirm.value = '';
  resetPwError.classList.add('hidden');
  resetPwSuccess.classList.add('hidden');
  setResetPwVisibility(false);
  refreshResetPwState();
  resetPwBackdrop.classList.remove('hidden');
  document.addEventListener('keydown', onResetPwKey, true);
  setTimeout(() => resetPwInput.focus(), 50);
}

function closeResetPassword() {
  if (resetPwCloseTimer) {
    clearTimeout(resetPwCloseTimer);
    resetPwCloseTimer = null;
  }

  resetPwBackdrop.classList.add('hidden');
  document.removeEventListener('keydown', onResetPwKey, true);
  resetPwTargetEmail = null;
}

function onResetPwKey(e) {
  // Capture-phase + stopPropagation so Esc closes ONLY this modal (stacked over
  // Settings), not the panel beneath, and runs before the global handler.
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeResetPassword();
  }
}

resetPwInput.addEventListener('input', refreshResetPwState);
resetPwConfirm.addEventListener('input', refreshResetPwState);
resetPwToggle.addEventListener('click', () =>
  setResetPwVisibility(resetPwInput.type === 'password'),
);
resetPwCancel.addEventListener('click', closeResetPassword);
resetPwClose.addEventListener('click', closeResetPassword);
resetPwBackdrop.addEventListener('click', (e) => {
  if (e.target === resetPwBackdrop) closeResetPassword();
});

resetPwForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  resetPwError.classList.add('hidden');
  resetPwSuccess.classList.add('hidden');
  const validationError = resetPwValidationError();

  if (validationError) {
    resetPwError.textContent = validationError;
    resetPwError.classList.remove('hidden');

    return;
  }

  const email = resetPwTargetEmail;

  resetPwSubmit.disabled = true;

  try {
    await settingsFetch('/api/admin/users/password', {
      method: 'POST',
      body: JSON.stringify({ email, password: resetPwInput.value }),
    });
    clearSettingsError();
    resetPwSuccess.classList.remove('hidden');
    resetPwCloseTimer = setTimeout(closeResetPassword, 1200);
  } catch (err) {
    resetPwError.textContent = err.message;
    resetPwError.classList.remove('hidden');
    resetPwSubmit.disabled = false;
  }
});

// ── Share modal (admin + server mode) ────────────────────────────────────────
const btnShare = document.getElementById('btn-share');
const shareBackdrop = document.getElementById('share-backdrop');
const sharePath = document.getElementById('share-path');
const shareStep1 = document.getElementById('share-step1');
const shareStep2 = document.getElementById('share-step2');
const shareUrl = document.getElementById('share-url');
const shareCopy = document.getElementById('share-copy');
const shareExpiry = document.getElementById('share-expiry');
const shareError = document.getElementById('share-error');
const shareCancel = document.getElementById('share-cancel');
const shareClose = document.getElementById('share-close');
const shareNew = document.getElementById('share-new');
const shareExisting = document.getElementById('share-existing');
const shareExistingList = document.getElementById('share-existing-list');
const shareExistingCount = document.getElementById('share-existing-count');

function shareFormatDate(ts) {
  if (!ts) return '';

  return new Date(ts * 1000).toLocaleDateString(LANG, {
    day: 'numeric',
    month: 'short',
    year: '2-digit',
  });
}

async function refreshShareList() {
  if (!currentFile) return;
  shareExisting.classList.add('hidden');
  shareExistingList.innerHTML = '';

  try {
    const res = await fetch('/api/share/list?path=' + encodeURIComponent(currentFile.path));

    if (!res.ok) return;
    const items = await res.json();

    if (!Array.isArray(items) || items.length === 0) return;
    shareExisting.classList.remove('hidden');
    shareExistingCount.textContent = t('nLinks', items.length);
    shareExistingList.innerHTML = items
      .map((item) => {
        const url = location.origin + '/s/' + item.token;
        const exp = item.expires_at
          ? t('expiresShort', shareFormatDate(item.expires_at))
          : t('noExpiry');
        const created = item.created_at ? t('createdShort', shareFormatDate(item.created_at)) : '';

        return (
          '<li class="bg-navy-900 border subtle-border rounded p-2 flex items-center gap-2 text-xs">' +
          '<div class="flex-1 min-w-0">' +
          '<div class="text-ink-300 font-mono truncate" title="' +
          escapeHtml(url) +
          '">' +
          escapeHtml(url) +
          '</div>' +
          '<div class="text-ink-500 text-[10px] mt-0.5">' +
          created +
          ' &middot; ' +
          exp +
          '</div>' +
          '</div>' +
          '<button class="share-existing-copy px-2 py-1 text-[11px] bg-navy-700 hover:bg-navy-600 text-ink-200 rounded" data-url="' +
          escapeHtml(url) +
          '" title="' +
          escapeHtml(t('copy')) +
          '">' +
          t('copy') +
          '</button>' +
          '<button class="share-existing-del px-2 py-1 text-[11px] bg-navy-700 hover:bg-rose-500/30 hover:text-rose-300 text-ink-200 rounded" data-id="' +
          escapeHtml(item.id) +
          '" title="' +
          escapeHtml(t('revokeTitle')) +
          '">&times;</button>' +
          '</li>'
        );
      })
      .join('');
  } catch (e) {}
}

function openShareModal() {
  if (!currentFile || window.__viewerMode) return;
  sharePath.textContent = currentFile.path;
  shareStep1.classList.remove('hidden');
  shareStep2.classList.add('hidden');
  shareError.classList.add('hidden');
  shareBackdrop.classList.remove('hidden');
  refreshShareList();
}

function closeShareModal() {
  shareBackdrop.classList.add('hidden');
}

shareExistingList.addEventListener('click', async (e) => {
  const copyBtn = e.target.closest('.share-existing-copy');

  if (copyBtn) {
    try {
      await navigator.clipboard.writeText(copyBtn.dataset.url);
      copyBtn.textContent = t('copied');
      setTimeout(() => (copyBtn.textContent = t('copy')), 1200);
    } catch (e) {}

    return;
  }

  const delBtn = e.target.closest('.share-existing-del');

  if (delBtn) {
    const ok = await confirmDialog({
      title: t('revokeConfirmTitle'),
      message: t('revokeConfirmMsg'),
      confirmLabel: t('revoke'),
      destructive: true,
    });

    if (!ok) return;
    shareError.classList.add('hidden');

    try {
      const res = await fetch('/api/share/' + delBtn.dataset.id, { method: 'DELETE' });

      if (!res.ok) throw new Error('HTTP ' + res.status);
      refreshShareList();
    } catch (e) {
      shareError.textContent = t('err', e.message);
      shareError.classList.remove('hidden');
    }
  }
});

btnShare.addEventListener('click', openShareModal);
shareCancel.addEventListener('click', closeShareModal);
shareClose.addEventListener('click', closeShareModal);
document.getElementById('share-close-x')?.addEventListener('click', closeShareModal);
shareBackdrop.addEventListener('click', (e) => {
  if (e.target === shareBackdrop) closeShareModal();
});
shareNew.addEventListener('click', () => {
  shareStep2.classList.add('hidden');
  shareStep1.classList.remove('hidden');
});

document.querySelectorAll('.share-dur').forEach((btn) => {
  btn.addEventListener('click', async () => {
    if (!currentFile) return;
    shareError.classList.add('hidden');
    const days = parseInt(btn.dataset.days, 10);

    btn.disabled = true;

    try {
      const res = await fetch('/api/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: currentFile.path, expires_days: days }),
      });

      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const fullUrl = location.origin + '/s/' + data.token;

      shareUrl.value = fullUrl;
      shareExpiry.textContent = data.expires_at
        ? t('expiresAt', new Date(data.expires_at * 1000).toLocaleString(LANG))
        : t('neverExpires');
      shareStep1.classList.add('hidden');
      shareStep2.classList.remove('hidden');
      setTimeout(() => {
        shareUrl.select();
      }, 50);
      refreshShareList();
    } catch (e) {
      shareError.textContent = t('err', e.message);
      shareError.classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  });
});

shareCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(shareUrl.value);
    shareCopy.textContent = t('copiedBang');
    setTimeout(() => {
      shareCopy.textContent = t('copy');
    }, 1500);
  } catch (e) {
    shareUrl.select();
    document.execCommand('copy');
  }
});

// ── Settings panel (admin + cloud mode) ──────────────────────────────────────
// Entry point: user-bar gear, visible only when body.admin-cloud is set. All
// mutations go through fetch() on /api/admin/* and /api/share/* (JSON, same origin).
const settingsBtn = document.getElementById('settings-btn');
const settingsBackdrop = document.getElementById('settings-backdrop');
const settingsClose = document.getElementById('settings-close');
const settingsError = document.getElementById('settings-error');
const settingsUsersList = document.getElementById('settings-users-list');
const settingsTokensList = document.getElementById('settings-tokens-list');
const settingsSharesList = document.getElementById('settings-shares-list');
const settingsUserForm = document.getElementById('settings-user-form');
const settingsTokenForm = document.getElementById('settings-token-form');
const settingsTokenResult = document.getElementById('settings-token-result');
const settingsInviteResult = document.getElementById('settings-invite-result');
const settingsNodesList = document.getElementById('settings-nodes-list');
const settingsNodeForm = document.getElementById('settings-node-form');
const settingsNodeResult = document.getElementById('settings-node-result');
const settingsRemotesList = document.getElementById('settings-remotes-list');
const settingsRemoteForm = document.getElementById('settings-remote-form');

// HTTP status → human message (never the raw technical detail).
function settingsHttpMessage(status) {
  if (status === 403 || status === 401) return t('settingsErrForbidden');

  if (status === 409) return t('settingsErrConflict');

  return t('settingsErrGeneric');
}

function showSettingsError(message) {
  settingsError.textContent = message;
  settingsError.classList.remove('hidden');
}

function clearSettingsError() {
  settingsError.classList.add('hidden');
}

// Shared JSON fetch for admin mutations: adds Content-Type, parses the body and
// raises a readable message (not the server detail) on failure.
async function settingsFetch(url, options) {
  const opts = Object.assign({ headers: {} }, options || {});

  if (opts.body) opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers);
  const res = await fetch(url, opts);
  let payload = null;

  try {
    payload = await res.json();
  } catch (_) {}

  if (!res.ok) {
    const human =
      payload && payload.error === 'cannot delete the last admin'
        ? t('settingsLastAdmin')
        : settingsHttpMessage(res.status);
    const err = new Error(human);

    err.status = res.status;
    throw err;
  }

  return payload;
}

function settingsSelectTab(name) {
  document.querySelectorAll('.settings-tab').forEach((tab) => {
    tab.classList.toggle('is-active', tab.dataset.tab === name);
  });
  document.querySelectorAll('.settings-pane').forEach((pane) => {
    pane.classList.add('hidden');
  });
  document.getElementById('settings-pane-' + name).classList.remove('hidden');
  clearSettingsError();

  if (name === 'users') loadSettingsUsers();
  else if (name === 'tokens') loadSettingsTokens();
  else if (name === 'shares') loadSettingsShares();
  else if (name === 'nodes') {
    loadSettingsNodes();
    loadSettingsRemotes();
  } else if (name === 'groups') loadSettingsGroups();
  else if (name === 'security') {
    refreshSecurityState();
    loadAccountProfile();
  }
}

// Node name from a path: last segment, slugified.
function suggestNodeName(path) {
  const base = (String(path).split('/').pop() || path).replace(/\.(md|html)$/i, '');

  return (
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'noeud'
  );
}

// Opens Settings → Nodes with the path pre-filled (from the tree button).
function openPublishNode(path) {
  openSettings();
  settingsSelectTab('nodes');
  hideNodeResult();
  const pathEl = document.getElementById('settings-node-path');
  const nameEl = document.getElementById('settings-node-name');

  if (pathEl) pathEl.value = path;

  if (nameEl) {
    nameEl.value = suggestNodeName(path);
    nameEl.focus();
    nameEl.select();
  }
}

// Info about the remote node a mirror doc belongs to (remotes/<name>/…).
function remoteNodeInfo(path) {
  const parts = (path || '').split('/');

  if (parts[0] !== 'remotes' || parts.length < 3) return null;
  const name = parts[1];
  const prefix = 'remotes/' + name + '/';
  const fileCount = Object.keys(fileMap).filter((p) => p.startsWith(prefix)).length;

  return { name, sourceRel: parts.slice(2).join('/'), fileCount };
}

// Appropriate from a mirror doc: node's only file → whole node, otherwise just
// that file. Produces a detached, editable copy in your documents.
document.getElementById('btn-node-appropriate').addEventListener('click', async () => {
  if (!currentFile) return;
  const info = remoteNodeInfo(currentFile.path);

  if (!info) return;
  const whole = info.fileCount <= 1;
  const dest = await promptDialog({
    title: t('nodeAppropriateBtn'),
    message: whole
      ? t('nodeAppropriateWholePrompt', info.name)
      : t('nodeAppropriateFilePrompt', currentFile.name),
    value: whole ? info.name : currentFile.name || '',
    confirmLabel: t('nodeAppropriateBtn'),
  });

  if (!dest) return;

  try {
    const res = await settingsFetch('/api/admin/remotes/appropriate', {
      method: 'POST',
      body: JSON.stringify({ name: info.name, source: whole ? '' : info.sourceRel, dest }),
    });

    setStatus(t('settingsRemoteAppropriated', String(res.copied || 0)), 'ok');
    await refreshTreeOrReload();
  } catch (e) {
    setStatus(t('err', e.message), 'err');
  }
});

// Remove from a mirror doc = unsubscribe entirely: a single removed file would
// just come back on the next sync, so we drop the whole subscription.
document.getElementById('btn-node-remove').addEventListener('click', async () => {
  if (!currentFile) return;
  const info = remoteNodeInfo(currentFile.path);

  if (!info) return;
  const ok = await confirmDialog({
    title: t('nodeRemoveTitle'),
    message: t('settingsRemoteRemoveMsg', info.name),
    confirmLabel: t('settingsRemoteRemove'),
    destructive: true,
  });

  if (!ok) return;

  try {
    await settingsFetch('/api/admin/remotes', {
      method: 'DELETE',
      body: JSON.stringify({ name: info.name }),
    });
    showWelcome();
    await refreshTreeOrReload();
  } catch (e) {
    setStatus(t('err', e.message), 'err');
  }
});

// ── Users ──
async function loadSettingsUsers() {
  settingsUsersList.innerHTML = '';

  try {
    const users = await settingsFetch('/api/admin/users');

    if (!Array.isArray(users) || users.length === 0) {
      settingsUsersList.innerHTML =
        '<li class="text-sm text-ink-500">' + t('settingsNoUsers') + '</li>';

      return;
    }

    settingsUsersList.innerHTML = users
      .map((u) => {
        const roleLabel = u.role === 'admin' ? t('settingsRoleAdmin') : t('settingsRoleViewer');
        const roleCls = u.role === 'admin' ? 'text-accent' : 'text-ink-400';
        const emailEsc = escapeHtml(u.email);
        const fullName = [u.first_name, u.last_name].map((p) => (p || '').trim()).filter(Boolean).join(' ');
        const nameLine = fullName
          ? '<div class="text-ink-100 font-medium truncate" title="' +
            escapeHtml(fullName) +
            '">' +
            escapeHtml(fullName) +
            '</div>'
          : '';
        // A pending account was invited but hasn't set a password yet: show a
        // badge, and offer "resend invite" instead of "reset password" (which 404s
        // on a pending account — the password is set via the invite link).
        const pendingBadge = u.pending
          ? ' <span class="settings-pending-badge">' +
            escapeHtml(t('settingsInvitePending')) +
            '</span>'
          : '';
        const actionBtn = u.pending
          ? '<button class="settings-user-resend px-3 py-1.5 text-sm bg-navy-700 hover:bg-navy-600 text-ink-200 rounded" data-email="' +
            emailEsc +
            '" data-role="' +
            escapeHtml(u.role || '') +
            '">' +
            escapeHtml(t('settingsResendInvite')) +
            '</button>'
          : '<button class="settings-user-reset px-3 py-1.5 text-sm bg-navy-700 hover:bg-navy-600 text-ink-200 rounded" data-email="' +
            emailEsc +
            '" title="' +
            escapeHtml(t('settingsResetPassword')) +
            '">' +
            escapeHtml(t('settingsResetPasswordShort')) +
            '</button>';
        return (
          '<li class="bg-navy-900 border subtle-border rounded p-2.5 text-sm">' +
          '<div class="admin-row">' +
          '<div class="flex-shrink-0 mr-2.5">' + constellationSvg(avatarSeed(u.first_name, u.last_name, u.email), 28) + '</div>' +
          '<div class="flex-1 min-w-0">' +
          nameLine +
          '<div class="' +
          (fullName ? 'text-ink-400 text-xs' : 'text-ink-100 font-medium') +
          ' truncate" title="' +
          emailEsc +
          '">' +
          emailEsc +
          '</div>' +
          '<div class="' +
          roleCls +
          ' text-xs uppercase tracking-wider font-semibold mt-0.5">' +
          escapeHtml(roleLabel) +
          pendingBadge +
          '</div>' +
          '</div>' +
          '<div class="admin-row__actions">' +
          actionBtn +
          '<button class="settings-user-del px-3 py-1.5 text-sm bg-navy-700 hover:bg-rose-500/30 hover:text-rose-300 text-ink-200 rounded" data-email="' +
          emailEsc +
          '" data-role="' +
          escapeHtml(u.role || '') +
          '">' +
          t('settingsDeleteUser') +
          '</button>' +
          '</div>' +
          '</div>' +
          '</li>'
        );
      })
      .join('');
  } catch (e) {
    showSettingsError(e.message);
  }
}

settingsUserForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearSettingsError();
  const email = document.getElementById('settings-user-email').value.trim();
  const role = document.getElementById('settings-user-role').value;

  try {
    const data = await settingsFetch('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email, role }),
    });
    // One-time display: the invite link is returned once and never again.
    showInviteResult(data.invite_url);
    settingsUserForm.reset();
    loadSettingsUsers();
  } catch (err) {
    showSettingsError(err.message);
  }
});

settingsUsersList.addEventListener('click', async (e) => {
  const resendBtn = e.target.closest('.settings-user-resend');

  if (resendBtn) {
    try {
      const data = await settingsFetch('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({ email: resendBtn.dataset.email, role: resendBtn.dataset.role }),
      });
      showInviteResult(data.invite_url);
      loadSettingsUsers();
    } catch (err) {
      showSettingsError(err.message);
    }

    return;
  }

  const resetBtn = e.target.closest('.settings-user-reset');

  if (resetBtn) {
    openResetPassword(resetBtn.dataset.email);

    return;
  }

  const delBtn = e.target.closest('.settings-user-del');

  if (delBtn) {
    const ok = await confirmDialog({
      title: t('settingsDeleteUserTitle'),
      message: t('settingsDeleteUserMsg', delBtn.dataset.email),
      confirmLabel: t('settingsDeleteUser'),
      destructive: true,
    });

    if (!ok) return;

    try {
      await settingsFetch('/api/admin/users', {
        method: 'DELETE',
        body: JSON.stringify({ email: delBtn.dataset.email }),
      });
      loadSettingsUsers();
    } catch (err) {
      showSettingsError(err.message);
    }
  }
});

// ── Tokens ──
async function loadSettingsTokens() {
  settingsTokensList.innerHTML = '';

  try {
    const tokens = await settingsFetch('/api/tokens');
    const active = Array.isArray(tokens) ? tokens.filter((tk) => !tk.revoked) : [];

    if (active.length === 0) {
      settingsTokensList.innerHTML =
        '<li class="text-sm text-ink-500">' + t('settingsNoTokens') + '</li>';

      return;
    }

    settingsTokensList.innerHTML = active
      .map((tk) => {
        const created = tk.created_at ? t('createdShort', shareFormatDate(tk.created_at)) : '';
        const labelText = tk.label || tk.email || '';
        const labelEsc = escapeHtml(labelText);

        return (
          '<li class="admin-row bg-navy-900 border subtle-border rounded p-2.5 text-sm">' +
          '<div class="flex-1 min-w-0">' +
          '<div class="text-ink-100 font-medium font-mono truncate" title="' +
          labelEsc +
          '">' +
          labelEsc +
          '</div>' +
          '<div class="text-ink-500 text-xs mt-0.5">' +
          escapeHtml(created) +
          '</div>' +
          '</div>' +
          '<div class="admin-row__actions">' +
          '<button class="settings-token-revoke px-3 py-1.5 text-sm bg-navy-700 hover:bg-rose-500/30 hover:text-rose-300 text-ink-200 rounded" data-id="' +
          escapeHtml(tk.id || '') +
          '" data-label="' +
          labelEsc +
          '">' +
          t('settingsRevokeToken') +
          '</button>' +
          '</div>' +
          '</li>'
        );
      })
      .join('');
  } catch (e) {
    showSettingsError(e.message);
  }
}

settingsTokenForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearSettingsError();
  const labelInput = document.getElementById('settings-token-label');
  const label = labelInput.value.trim();

  if (!label) return;

  try {
    const data = await settingsFetch('/api/tokens', {
      method: 'POST',
      body: JSON.stringify({ label }),
    });

    // One-time display: the plaintext token NEVER comes back after this point.
    document.getElementById('settings-token-plain').value = data.token || '';
    document.getElementById('settings-token-mcp').value = data.mcp_url || '';
    settingsTokenResult.classList.remove('hidden');
    labelInput.value = '';
    loadSettingsTokens();
  } catch (err) {
    showSettingsError(err.message);
  }
});

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);

    return true;
  } catch (_) {
    return false;
  }
}

function flashCopied(btn) {
  btn.textContent = t('copied');
  btn.classList.add('is-copied');
  setTimeout(() => {
    btn.textContent = t('copy');
    btn.classList.remove('is-copied');
  }, 1200);
}

document.getElementById('settings-token-copy').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const input = document.getElementById('settings-token-plain');
  const ok = await copyToClipboard(input.value);

  if (!ok) {
    input.select();
    document.execCommand('copy');
  }

  flashCopied(btn);
  // Hide the secret after the flash — it's in the clipboard and never reappears.
  setTimeout(hideTokenResult, 1400);
});
document.getElementById('settings-token-mcp-copy').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const input = document.getElementById('settings-token-mcp');
  const ok = await copyToClipboard(input.value);

  if (!ok) {
    input.select();
    document.execCommand('copy');
  }

  flashCopied(btn);
});

function hideTokenResult() {
  settingsTokenResult.classList.add('hidden');
  // Clear the secret from the DOM — no residue in the inspector.
  document.getElementById('settings-token-plain').value = '';
  document.getElementById('settings-token-mcp').value = '';
}

document.getElementById('settings-token-close').addEventListener('click', hideTokenResult);

// ── Invite link one-time display (mirror of the token result) ──
function showInviteResult(url) {
  if (!url) return;
  document.getElementById('settings-invite-link').value = url;
  settingsInviteResult.classList.remove('hidden');
}

function hideInviteResult() {
  settingsInviteResult.classList.add('hidden');
  document.getElementById('settings-invite-link').value = '';
}

document.getElementById('settings-invite-copy').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const input = document.getElementById('settings-invite-link');
  const ok = await copyToClipboard(input.value);

  if (!ok) {
    input.select();
    document.execCommand('copy');
  }

  flashCopied(btn);
});

document.getElementById('settings-invite-close').addEventListener('click', hideInviteResult);

settingsTokensList.addEventListener('click', async (e) => {
  const revokeBtn = e.target.closest('.settings-token-revoke');

  if (!revokeBtn) return;
  const ok = await confirmDialog({
    title: t('settingsRevokeTokenTitle'),
    message: t('settingsRevokeTokenMsg', revokeBtn.dataset.label),
    confirmLabel: t('settingsRevokeToken'),
    destructive: true,
  });

  if (!ok) return;

  try {
    // Prefer id over label: the label may be reused after revocation.
    const body = revokeBtn.dataset.id
      ? { id: revokeBtn.dataset.id }
      : { label: revokeBtn.dataset.label };

    await settingsFetch('/api/tokens', {
      method: 'DELETE',
      body: JSON.stringify(body),
    });
    loadSettingsTokens();
  } catch (err) {
    showSettingsError(err.message);
  }
});

// ── Shares ──
async function loadSettingsShares() {
  settingsSharesList.innerHTML = '';

  try {
    const shares = await settingsFetch('/api/share/list');

    if (!Array.isArray(shares) || shares.length === 0) {
      settingsSharesList.innerHTML =
        '<li class="text-sm text-ink-500">' + t('settingsNoShares') + '</li>';

      return;
    }

    settingsSharesList.innerHTML = shares
      .map((item) => {
        const exp = item.expires_at
          ? t('expiresShort', shareFormatDate(item.expires_at))
          : t('noExpiry');
        const created = item.created_at ? t('createdShort', shareFormatDate(item.created_at)) : '';
        const pathEsc = escapeHtml(item.path || '');
        const broken = item.file_exists === false;
        const url = item.token ? location.origin + '/s/' + item.token : '';
        const urlEsc = escapeHtml(url);
        const urlLine = url
          ? '<div class="text-ink-300 font-mono text-xs truncate mt-0.5" title="' +
            urlEsc +
            '">' +
            urlEsc +
            '</div>'
          : '';
        const copyBtn = url
          ? '<button class="settings-share-copy px-3 py-1.5 text-sm bg-navy-700 hover:bg-navy-600 text-ink-200 rounded" data-url="' +
            urlEsc +
            '" title="' +
            escapeHtml(t('copy')) +
            '">' +
            t('copy') +
            '</button>'
          : '';

        return (
          '<li class="admin-row bg-navy-900 border subtle-border rounded p-2.5 text-sm">' +
          '<div class="flex-1 min-w-0">' +
          '<div class="text-ink-100 font-medium truncate" title="' +
          pathEsc +
          '">' +
          pathEsc +
          (broken
            ? ' <span class="text-rose-300 text-xs font-normal">' + t('shareBroken') + '</span>'
            : '') +
          '</div>' +
          urlLine +
          '<div class="text-ink-500 text-xs mt-0.5">' +
          escapeHtml(created) +
          ' &middot; ' +
          escapeHtml(exp) +
          '</div>' +
          '</div>' +
          '<div class="admin-row__actions">' +
          copyBtn +
          (broken
            ? '<button class="settings-share-reactivate px-3 py-1.5 text-sm bg-navy-700 hover:bg-emerald-500/30 hover:text-emerald-300 text-ink-200 rounded" data-id="' +
              escapeHtml(item.id || '') +
              '" data-path="' +
              pathEsc +
              '" data-suggested="' +
              escapeHtml(item.suggested_path || '') +
              '">' +
              t('shareReactivate') +
              '</button>'
            : '') +
          '<button class="settings-share-revoke px-3 py-1.5 text-sm bg-navy-700 hover:bg-rose-500/30 hover:text-rose-300 text-ink-200 rounded" data-id="' +
          escapeHtml(item.id || '') +
          '">' +
          t('revoke') +
          '</button>' +
          '</div>' +
          '</li>'
        );
      })
      .join('');
  } catch (e) {
    showSettingsError(e.message);
  }
}

settingsSharesList.addEventListener('click', async (e) => {
  const copyBtn = e.target.closest('.settings-share-copy');

  if (copyBtn) {
    try {
      await navigator.clipboard.writeText(copyBtn.dataset.url);
      copyBtn.textContent = t('copied');
      setTimeout(() => (copyBtn.textContent = t('copy')), 1200);
    } catch (_) {}

    return;
  }

  const reactivateBtn = e.target.closest('.settings-share-reactivate');

  if (reactivateBtn) {
    // Doc moved/disappeared: point the link at its new path (URL stays the same).
    const newPath = await promptDialog({
      title: t('shareReactivateTitle'),
      message: t('shareReactivateMsg', reactivateBtn.dataset.path || ''),
      value: reactivateBtn.dataset.suggested || '',
      placeholder: t('shareReactivatePlaceholder'),
      confirmLabel: t('shareReactivate'),
    });

    if (!newPath) return;

    try {
      await settingsFetch('/api/share/' + reactivateBtn.dataset.id, {
        method: 'PATCH',
        body: JSON.stringify({ path: newPath.trim() }),
      });
      loadSettingsShares();
    } catch (err) {
      showSettingsError(err.message);
    }

    return;
  }

  const revokeBtn = e.target.closest('.settings-share-revoke');

  if (!revokeBtn || !revokeBtn.dataset.id) return;
  const ok = await confirmDialog({
    title: t('revokeConfirmTitle'),
    message: t('revokeConfirmMsg'),
    confirmLabel: t('revoke'),
    destructive: true,
  });

  if (!ok) return;

  try {
    await settingsFetch('/api/share/' + revokeBtn.dataset.id, { method: 'DELETE' });
    loadSettingsShares();
  } catch (err) {
    showSettingsError(err.message);
  }
});

// ── Nodes (hive) ──
async function loadSettingsNodes() {
  settingsNodesList.innerHTML = '';

  try {
    const nodes = await settingsFetch('/api/admin/nodes');
    const active = Array.isArray(nodes) ? nodes.filter((n) => !n.revoked) : [];

    if (active.length === 0) {
      settingsNodesList.innerHTML =
        '<li class="text-sm text-ink-500">' + t('settingsNoNodes') + '</li>';

      return;
    }

    settingsNodesList.innerHTML = active
      .map((n) => {
        const created = n.created_at ? t('createdShort', shareFormatDate(n.created_at)) : '';
        const nameEsc = escapeHtml(n.name || '');
        const pathEsc = escapeHtml(n.path || '');

        return (
          '<li class="admin-row bg-navy-900 border subtle-border rounded p-3 text-sm">' +
          '<div class="flex-1 min-w-0">' +
          '<div class="text-ink-100 font-medium font-mono truncate" title="' +
          nameEsc +
          '">' +
          nameEsc +
          '</div>' +
          '<div class="text-ink-300 font-mono text-xs truncate mt-0.5" title="' +
          pathEsc +
          '">' +
          pathEsc +
          '</div>' +
          '<div class="text-ink-500 text-xs mt-0.5">' +
          escapeHtml(created) +
          '</div>' +
          '</div>' +
          '<div class="admin-row__actions">' +
          '<button class="settings-node-relink px-3 py-1.5 text-sm bg-navy-700 hover:bg-navy-600 text-ink-200 rounded" data-name="' +
          nameEsc +
          '" data-path="' +
          pathEsc +
          '" title="' +
          escapeHtml(t('settingsNodeRelinkTitle')) +
          '">' +
          t('settingsNodeRelink') +
          '</button>' +
          '<button class="settings-node-revoke px-3 py-1.5 text-sm bg-navy-700 hover:bg-rose-500/30 hover:text-rose-300 text-ink-200 rounded" data-name="' +
          nameEsc +
          '">' +
          t('revoke') +
          '</button>' +
          '</div>' +
          '</li>'
        );
      })
      .join('');
  } catch (e) {
    showSettingsError(e.message);
  }
}

async function publishNode(name, path) {
  // One-time display: the link (which carries the token) NEVER comes back after.
  const data = await settingsFetch('/api/admin/nodes', {
    method: 'POST',
    body: JSON.stringify({ name, path }),
  });

  document.getElementById('settings-node-link').value = data.link || '';
  settingsNodeResult.classList.remove('hidden');
  loadSettingsNodes();
}

settingsNodeForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearSettingsError();
  const name = document.getElementById('settings-node-name').value.trim();
  const path = document.getElementById('settings-node-path').value.trim();

  if (!name || !path) return;

  try {
    await publishNode(name, path);
    settingsNodeForm.reset();
  } catch (err) {
    showSettingsError(err.message);
  }
});

document.getElementById('settings-node-copy').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const input = document.getElementById('settings-node-link');
  const ok = await copyToClipboard(input.value);

  if (!ok) {
    input.select();
    document.execCommand('copy');
  }

  flashCopied(btn);
});

function hideNodeResult() {
  settingsNodeResult.classList.add('hidden');
  document.getElementById('settings-node-link').value = '';
}

document.getElementById('settings-node-close').addEventListener('click', hideNodeResult);

settingsNodesList.addEventListener('click', async (e) => {
  const relinkBtn = e.target.closest('.settings-node-relink');

  if (relinkBtn) {
    // Re-publishing regenerates the token (old link dies), but it's the only way
    // to get a copyable link back — hence the warning.
    const ok = await confirmDialog({
      title: t('settingsNodeRelinkTitle'),
      message: t('settingsNodeRelinkMsg', relinkBtn.dataset.name),
      confirmLabel: t('settingsNodeRelink'),
    });

    if (!ok) return;

    try {
      await publishNode(relinkBtn.dataset.name, relinkBtn.dataset.path);
    } catch (err) {
      showSettingsError(err.message);
    }

    return;
  }

  const revokeBtn = e.target.closest('.settings-node-revoke');

  if (!revokeBtn || !revokeBtn.dataset.name) return;
  const ok = await confirmDialog({
    title: t('settingsRevokeNodeTitle'),
    message: t('settingsRevokeNodeMsg', revokeBtn.dataset.name),
    confirmLabel: t('revoke'),
    destructive: true,
  });

  if (!ok) return;

  try {
    await settingsFetch('/api/admin/nodes', {
      method: 'DELETE',
      body: JSON.stringify({ name: revokeBtn.dataset.name }),
    });
    loadSettingsNodes();
  } catch (err) {
    showSettingsError(err.message);
  }
});

// ── Subscriptions (followed remote nodes) ──
async function loadSettingsRemotes() {
  settingsRemotesList.innerHTML = '';

  try {
    const remotes = await settingsFetch('/api/admin/remotes');

    if (!Array.isArray(remotes) || remotes.length === 0) {
      settingsRemotesList.innerHTML =
        '<li class="text-sm text-ink-500">' + t('settingsNoRemotes') + '</li>';

      return;
    }

    settingsRemotesList.innerHTML = remotes
      .map((r) => {
        const nameEsc = escapeHtml(r.name || '');
        const pathEsc = escapeHtml(r.path || '');
        const synced = r.last_sync_at
          ? t('settingsRemoteSynced', shareFormatDate(r.last_sync_at))
          : t('settingsRemoteNeverSynced');
        const originHost = (r.url || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        const originLine = originHost
          ? '<div class="text-xs text-sky-300/70 mt-0.5 truncate" title="' +
            escapeHtml(r.url || '') +
            '">' +
            escapeHtml(t('settingsRemoteFrom', originHost)) +
            '</div>'
          : '';
        const errLine = r.last_error
          ? '<div class="text-rose-400 text-xs mt-0.5 truncate" title="' +
            escapeHtml(r.last_error) +
            '">' +
            escapeHtml(t('settingsRemoteError', r.last_error)) +
            '</div>'
          : '';

        return (
          '<li class="admin-row bg-navy-900 border subtle-border rounded p-3 text-sm">' +
          '<div class="flex-1 min-w-0">' +
          '<div class="text-ink-100 font-medium font-mono truncate" title="' +
          nameEsc +
          '">' +
          nameEsc +
          '</div>' +
          '<div class="text-ink-300 font-mono text-xs truncate mt-0.5" title="' +
          pathEsc +
          '">' +
          pathEsc +
          '</div>' +
          originLine +
          '<div class="text-ink-500 text-xs mt-0.5">' +
          escapeHtml(synced) +
          '</div>' +
          errLine +
          '</div>' +
          '<div class="admin-row__actions">' +
          '<button class="settings-remote-sync px-3 py-1.5 text-sm bg-navy-700 hover:bg-navy-600 text-ink-200 rounded" data-name="' +
          nameEsc +
          '">' +
          t('settingsRemoteSync') +
          '</button>' +
          '<button class="settings-remote-appropriate px-3 py-1.5 text-sm bg-navy-700 hover:bg-navy-600 text-ink-200 rounded" data-name="' +
          nameEsc +
          '" title="' +
          escapeHtml(t('settingsRemoteAppropriateTitle')) +
          '">' +
          t('settingsRemoteAppropriate') +
          '</button>' +
          '<button class="settings-remote-del px-3 py-1.5 text-sm bg-navy-700 hover:bg-rose-500/30 hover:text-rose-300 text-ink-200 rounded" data-name="' +
          nameEsc +
          '">' +
          t('settingsRemoteRemove') +
          '</button>' +
          '</div>' +
          '</li>'
        );
      })
      .join('');
  } catch (e) {
    showSettingsError(e.message);
  }
}

settingsRemoteForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearSettingsError();
  const input = document.getElementById('settings-remote-link');
  const link = input.value.trim();

  if (!link) return;

  try {
    const res = await settingsFetch('/api/admin/remotes', {
      method: 'POST',
      body: JSON.stringify({ link }),
    });

    input.value = '';

    // Issuer unreachable: sync fails but the subscription is created — report
    // without blocking (the periodic sync retries).
    if (res && res.sync && res.sync.ok === false) {
      showSettingsError(t('settingsRemoteSyncFailed', res.sync.error || ''));
    }

    loadSettingsRemotes();
  } catch (err) {
    showSettingsError(err.message);
  }
});

settingsRemotesList.addEventListener('click', async (e) => {
  const syncBtn = e.target.closest('.settings-remote-sync');

  if (syncBtn) {
    syncBtn.disabled = true;

    try {
      const res = await settingsFetch('/api/admin/remotes/sync', {
        method: 'POST',
        body: JSON.stringify({ name: syncBtn.dataset.name }),
      });
      const r = res && res.results ? res.results[syncBtn.dataset.name] : null;

      if (r && r.ok === false) showSettingsError(t('settingsRemoteSyncFailed', r.error || ''));
    } catch (err) {
      showSettingsError(err.message);
    }

    loadSettingsRemotes();

    return;
  }

  const apprBtn = e.target.closest('.settings-remote-appropriate');

  if (apprBtn) {
    const name = apprBtn.dataset.name;
    // Free-form destination via modal. Default = node name, at the root of your documents.
    const dest = await promptDialog({
      title: t('settingsRemoteAppropriate'),
      message: t('settingsRemoteAppropriatePrompt', name),
      value: name,
      placeholder: t('appropriateDestPlaceholder'),
      confirmLabel: t('settingsRemoteAppropriate'),
    });

    if (!dest) return;

    try {
      const res = await settingsFetch('/api/admin/remotes/appropriate', {
        method: 'POST',
        body: JSON.stringify({ name, source: '', dest }),
      });

      showSettingsError(t('settingsRemoteAppropriated', String(res.copied || 0)));
    } catch (err) {
      showSettingsError(err.message);
    }

    return;
  }

  const delBtn = e.target.closest('.settings-remote-del');

  if (!delBtn || !delBtn.dataset.name) return;
  const ok = await confirmDialog({
    title: t('settingsRemoteRemoveTitle'),
    message: t('settingsRemoteRemoveMsg', delBtn.dataset.name),
    confirmLabel: t('settingsRemoteRemove'),
    destructive: true,
  });

  if (!ok) return;

  try {
    await settingsFetch('/api/admin/remotes', {
      method: 'DELETE',
      body: JSON.stringify({ name: delBtn.dataset.name }),
    });
    loadSettingsRemotes();
  } catch (err) {
    showSettingsError(err.message);
  }
});

// ── Groups (principals group:<name>) ──
async function loadSettingsGroups() {
  const list = document.getElementById('settings-groups-list');

  if (!list) return;
  list.innerHTML = '';

  try {
    const groups = await settingsFetch('/api/admin/groups'); // { name: [emails] }
    const names = Object.keys(groups || {}).sort();

    if (!names.length) {
      list.innerHTML = '<li class="text-sm text-ink-500">' + t('settingsNoGroups') + '</li>';

      return;
    }

    list.innerHTML = names
      .map((name) => {
        const members = groups[name] || [];
        const nameEsc = escapeHtml(name);
        const membersEsc = escapeHtml(members.join(', '));

        return (
          '<li class="bg-navy-900 border subtle-border rounded p-2.5 text-sm">' +
          '<div class="admin-row">' +
          '<div class="flex-1 min-w-0">' +
          '<div class="text-ink-100 font-medium font-mono truncate">' +
          nameEsc +
          '</div>' +
          '<div class="text-ink-400 text-xs mt-0.5 truncate" title="' +
          membersEsc +
          '">' +
          (members.length
            ? membersEsc
            : '<span class="text-ink-500">' + t('settingsGroupEmpty') + '</span>') +
          '</div>' +
          '</div>' +
          '<div class="admin-row__actions">' +
          '<button class="settings-group-edit px-3 py-1.5 text-sm bg-navy-700 hover:bg-navy-600 text-ink-200 rounded" data-name="' +
          nameEsc +
          '" data-members="' +
          membersEsc +
          '">' +
          t('settingsGroupEdit') +
          '</button>' +
          '<button class="settings-group-del px-3 py-1.5 text-sm bg-navy-700 hover:bg-rose-500/30 hover:text-rose-300 text-ink-200 rounded" data-name="' +
          nameEsc +
          '">' +
          t('settingsGroupDelete') +
          '</button>' +
          '</div>' +
          '</div>' +
          '</li>'
        );
      })
      .join('');
  } catch (e) {
    showSettingsError(e.message);
  }
}

// Node path = a creatable combobox over the mind's existing folders (publish an existing
// folder as a federation node, or type a new path) — like the new-file folder field.
const settingsNodePathEl = document.getElementById('settings-node-path');
if (settingsNodePathEl) AtlasCombobox(settingsNodePathEl, { source: getAllDirs, creatable: true });

const settingsGroupForm = document.getElementById('settings-group-form');

if (settingsGroupForm) {
  // Members = a creatable multi/chips combobox (pick known accounts via /api/directory
  // or type a new email), replacing the bare comma-separated input.
  const groupMembersCb = AtlasCombobox(document.getElementById('settings-group-members'), {
    source: async () => {
      try {
        const r = await fetch('/api/directory');
        return r.ok ? (await r.json()).users || [] : [];
      } catch (_) {
        return [];
      }
    },
    creatable: true,
    multi: true,
    separator: ',',
  });

  settingsGroupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearSettingsError();
    const name = document.getElementById('settings-group-name').value.trim();
    const members = groupMembersCb.getValue();

    try {
      await settingsFetch('/api/admin/groups', {
        method: 'POST',
        body: JSON.stringify({ name, members }),
      });
      settingsGroupForm.reset();
      groupMembersCb.clear();
      loadSettingsGroups();
    } catch (err) {
      showSettingsError(err.message);
    }
  });

  document.getElementById('settings-groups-list').addEventListener('click', async (e) => {
    const editBtn = e.target.closest('.settings-group-edit');

    if (editBtn) {
      document.getElementById('settings-group-name').value = editBtn.dataset.name;
      groupMembersCb.setValue(editBtn.dataset.members);
      document.getElementById('settings-group-name').focus();

      return;
    }

    const delBtn = e.target.closest('.settings-group-del');

    if (delBtn) {
      const ok = await confirmDialog({
        title: t('settingsGroupDeleteTitle'),
        message: t('settingsGroupDeleteMsg', delBtn.dataset.name),
        confirmLabel: t('settingsGroupDelete'),
        destructive: true,
      });

      if (!ok) return;

      try {
        await settingsFetch('/api/admin/groups', {
          method: 'DELETE',
          body: JSON.stringify({ name: delBtn.dataset.name }),
        });
        loadSettingsGroups();
      } catch (err) {
        showSettingsError(err.message);
      }
    }
  });
}

async function refreshUpdateBanner() {
  // Admin-only, best-effort: never block Settings if the check fails/offline.
  const banner = document.getElementById('settings-update-banner');

  if (!banner) return;
  banner.classList.add('hidden');

  try {
    const data = await settingsFetch('/api/admin/update-check');

    if (data && data.update_available && data.latest) {
      banner.textContent = t('settingsUpdateAvailable')
        .replace('{latest}', data.latest)
        .replace('{current}', data.current || '?');
      banner.href = data.url || 'https://pypi.org/project/atlas-mind/';
      banner.classList.remove('hidden');
    }
  } catch (_) {
    /* best-effort */
  }
}

function openSettings() {
  hideTokenResult();
  settingsBackdrop.classList.remove('hidden');
  // Everyone lands on Profile (the per-account tab, first in the bar); admin-only
  // tabs are one click away.
  const isAdmin = document.body.classList.contains('admin-cloud');

  settingsSelectTab('security');

  if (isAdmin) refreshUpdateBanner();
}

function closeSettings() {
  settingsBackdrop.classList.add('hidden');
}

settingsBtn.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
settingsBackdrop.addEventListener('click', (e) => {
  if (e.target === settingsBackdrop) closeSettings();
});
document.querySelectorAll('.settings-tab').forEach((tab) => {
  tab.addEventListener('click', () => settingsSelectTab(tab.dataset.tab));
});

// ── Your name (self-service, Profil tab) ──────────────────────────────────────
// The form is static in 05-settings.html; here we just prefill + save it.
async function loadAccountProfile() {
  const form = document.getElementById('account-profile-form');
  const first = document.getElementById('account-profile-first');
  const last = document.getElementById('account-profile-last');
  if (!form || !first || !last) return;
  if (!form.dataset.wired) {
    form.dataset.wired = '1';
    form.addEventListener('submit', saveAccountProfile);
  }
  try {
    const data = await settingsFetch('/api/account/profile');
    first.value = data.first_name || '';
    last.value = data.last_name || '';
    const avatar = document.getElementById('account-profile-avatar');
    if (avatar && data.email) avatar.innerHTML = constellationSvg(avatarSeed(data.first_name, data.last_name, data.email), 64);
  } catch (e) {
    showSettingsError(e.message);
  }
}

async function saveAccountProfile(e) {
  e.preventDefault();
  clearSettingsError();
  const btn = e.target.querySelector('button[type="submit"]');
  const first = document.getElementById('account-profile-first').value.trim();
  const last = document.getElementById('account-profile-last').value.trim();
  btn.disabled = true;
  try {
    await settingsFetch('/api/account/profile', {
      method: 'POST',
      body: JSON.stringify({ first_name: first, last_name: last }),
    });
    const status = document.getElementById('account-profile-status');
    if (status) {
      status.textContent = t('profileSaved');
      status.classList.remove('hidden');
      setTimeout(() => status.classList.add('hidden'), 2500);
    }
  } catch (err) {
    showSettingsError(err.message);
  } finally {
    btn.disabled = false;
  }
}

// ── Minimal QR code generator (no external lib) ───────────────────────────────
// QR Model 2, byte mode, EC level L — enough for an otpauth:// URI (~120 bytes →
// version 6/7).
// On encoding failure (improbably long URI) the caller falls back to the plaintext secret.

const QR = (function () {
  // GF(256) tables (primitive 0x11d).
  const EXP = new Array(512),
    LOG = new Array(256);

  (function () {
    let x = 1;

    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;

      if (x & 0x100) x ^= 0x11d;
    }

    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  function gfMul(a, b) {
    return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
  }

  function rsGenPoly(n) {
    let poly = [1];

    for (let i = 0; i < n; i++) {
      const next = new Array(poly.length + 1).fill(0);

      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], EXP[i]);
      }

      poly = next;
    }

    return poly;
  }

  function rsEncode(data, ecLen) {
    // GF(256) polynomial division of (data + ecLen zeros) by the generator;
    // the remainder is the ecLen correction bytes.
    const gen = rsGenPoly(ecLen); // length ecLen+1, gen[0] === 1
    const buf = data.concat(new Array(ecLen).fill(0));

    for (let i = 0; i < data.length; i++) {
      const coef = buf[i];

      if (coef === 0) continue;

      for (let j = 1; j < gen.length; j++) buf[i + j] ^= gfMul(gen[j], coef);
    }

    return buf.slice(data.length);
  }

  // EC level L. [version, totalCodewords, ecPerBlock, blocks, maxPayloadBytes].
  // Exact ISO/IEC 18004 values. WARNING: from v6 on the data is split into
  // MULTIPLE RS blocks (ecPerBlock ≠ total ec) then interleaved — treating it as
  // a single block produces an unreadable QR.
  // maxPayloadBytes = dataCodewords − header overhead (mode + counter, ~2 bytes up to v9).
  const VERSIONS = [
    [1, 26, 7, 1, 17],
    [2, 44, 10, 1, 32],
    [3, 70, 15, 1, 53],
    [4, 100, 20, 1, 78],
    [5, 134, 26, 1, 106],
    [6, 172, 18, 2, 134],
    [7, 196, 20, 2, 154],
    [8, 242, 24, 2, 192],
    [9, 292, 30, 2, 230],
    [10, 346, 18, 4, 271],
  ];

  function pickVersion(len) {
    for (const v of VERSIONS) {
      if (len <= v[4]) return v;
    }

    return null;
  }

  // Alignment pattern centers per version.
  const ALIGN = {
    1: [],
    2: [6, 18],
    3: [6, 22],
    4: [6, 26],
    5: [6, 30],
    6: [6, 34],
    7: [6, 22, 38],
    8: [6, 24, 42],
    9: [6, 26, 46],
    10: [6, 28, 50],
  };

  function buildMatrix(version, codewords) {
    const size = 17 + version * 4;
    const m = [];
    const reserved = [];

    for (let r = 0; r < size; r++) {
      m.push(new Array(size).fill(null));
      reserved.push(new Array(size).fill(false));
    }

    function setF(r, c, v) {
      m[r][c] = v ? 1 : 0;
      reserved[r][c] = true;
    }

    // Finder patterns + separators.
    function finder(r, c) {
      for (let i = -1; i <= 7; i++)
        for (let j = -1; j <= 7; j++) {
          const rr = r + i,
            cc = c + j;

          if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
          const inRing =
            (i >= 0 && i <= 6 && (j === 0 || j === 6)) ||
            (j >= 0 && j <= 6 && (i === 0 || i === 6));
          const inCore = i >= 2 && i <= 4 && j >= 2 && j <= 4;

          setF(rr, cc, inRing || inCore ? 1 : 0);
        }
    }

    finder(0, 0);
    finder(0, size - 7);
    finder(size - 7, 0);

    // Timing patterns.
    for (let i = 8; i < size - 8; i++) {
      setF(6, i, i % 2 === 0 ? 1 : 0);
      setF(i, 6, i % 2 === 0 ? 1 : 0);
    }

    // Dark module.
    setF(size - 8, 8, 1);
    // Alignment patterns.
    const ac = ALIGN[version];

    for (const r of ac)
      for (const c of ac) {
        if ((r <= 7 && c <= 7) || (r <= 7 && c >= size - 8) || (r >= size - 8 && c <= 7)) continue;

        for (let i = -2; i <= 2; i++)
          for (let j = -2; j <= 2; j++) {
            const ring = Math.max(Math.abs(i), Math.abs(j));

            setF(r + i, c + j, ring === 2 || ring === 0 ? 1 : 0);
          }
      }

    // Version information (mandatory from v7 on): 18 bits = 6 version bits +
    // 12 BCH(18,6) bits (generator 0x1f25), placed in two 6×3 blocks (left of
    // the top-right finder and above the bottom-left finder).
    if (version >= 7) {
      let vbits = version << 12;
      const vg = 0x1f25;

      for (let i = 5; i >= 0; i--) if ((vbits >> (i + 12)) & 1) vbits ^= vg << i;
      const vfull = (version << 12) | vbits;

      for (let i = 0; i < 18; i++) {
        const bit = (vfull >> i) & 1;
        const r = Math.floor(i / 3);
        const c = i % 3;

        // Bottom-left block: rows size-11..size-9, columns 0..5.
        setF(size - 11 + c, r, bit);
        // Top-right block: rows 0..5, columns size-11..size-9 (transposed).
        setF(r, size - 11 + c, bit);
      }
    }

    // Reserve EXACTLY the format-info modules (same cells as placeFormat).
    // Over-reserving (dark module, neighboring data cells) would shift data
    // placement → unreadable QR.
    for (let i = 0; i <= 8; i++) {
      reserved[8][i] = true;
      reserved[i][8] = true;
    }

    for (let i = 0; i < 7; i++) reserved[size - 1 - i][8] = true; // col 8, rows size-1..size-7

    for (let i = 0; i < 8; i++) reserved[8][size - 1 - i] = true; // row 8, cols size-1..size-8
    // Places the data bits in zigzag.
    let bitIdx = 0;
    const totalBits = codewords.length * 8;

    function bitAt(i) {
      return i < totalBits ? (codewords[i >> 3] >> (7 - (i & 7))) & 1 : 0;
    }

    let dir = -1;

    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;

      for (let n = 0; n < size; n++) {
        const row = dir < 0 ? size - 1 - n : n;

        for (let k = 0; k < 2; k++) {
          const cc = col - k;

          if (reserved[row][cc]) continue;
          m[row][cc] = bitAt(bitIdx++);
        }
      }

      dir = -dir;
    }

    return { m, reserved, size };
  }

  function applyMask(m, reserved, size, mask) {
    const out = [];

    for (let r = 0; r < size; r++) out.push(m[r].slice());

    for (let r = 0; r < size; r++)
      for (let c = 0; c < size; c++) {
        if (reserved[r][c]) continue;
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
            flip = ((r * c) % 2) + ((r * c) % 3) === 0;
            break;
          case 6:
            flip = (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
            break;
          case 7:
            flip = (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
            break;
        }

        if (flip) out[r][c] ^= 1;
      }

    return out;
  }

  function placeFormat(m, size, mask) {
    // ECC level L = 01. Format bits = BCH(15,5) then XOR mask 0x5412.
    // Placement per ISO/IEC 18004: each bit i (LSB→MSB) appears in TWO copies
    // (around the top-left finder + spread over the top-right/bottom-left
    // finders), exactly like the reference implementation.
    const lvl = 1; // L
    const data = (lvl << 3) | mask;
    let bits = data << 10;
    const g = 0x537;

    for (let i = 4; i >= 0; i--) if ((bits >> (i + 10)) & 1) bits ^= g << i;
    const fmt = ((data << 10) | bits) ^ 0x5412;

    // For each bit i (LSB→MSB), two copies at the ISO/IEC 18004 positions.
    // Strip A: around the top-left finder, on row 8 (and its corner);
    // Strip B: on column 8 (top-left/bottom-left/top-right finders).
    for (let i = 0; i < 15; i++) {
      const bit = (fmt >> i) & 1;
      // Vertical strip (column 8): top-left finder (i<8) then bottom-left.
      let vr;

      if (i < 6) vr = i;
      else if (i < 8) vr = i + 1;
      else vr = size - 15 + i;
      m[vr][8] = bit;
      // Horizontal strip (row 8): copy spread over row 8 (top-right i<8) then
      // around the top-left finder.
      let hc;

      if (i < 8) hc = size - i - 1;
      else if (i < 9) hc = 15 - i;
      else hc = 15 - i - 1;
      m[8][hc] = bit;
    }
  }

  function penalty(m, size) {
    let p = 0;

    // Rule 1: runs >=5 of the same color (rows + columns).
    for (let r = 0; r < size; r++)
      for (const horiz of [true, false]) {
        let run = 1,
          prev = -1;

        for (let c = 0; c < size; c++) {
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

    // Rule 3: finder-like pattern (approximation good enough to pick a mask).
    return p;
  }

  // Encodes an ASCII/UTF-8 string → boolean matrix.
  function encode(text) {
    const bytes = [];

    for (let i = 0; i < text.length; i++) {
      const cp = text.charCodeAt(i);

      if (cp < 0x80) bytes.push(cp);
      else if (cp < 0x800) {
        bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
      } else {
        bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      }
    }

    const ver = pickVersion(bytes.length);

    if (!ver) return null;
    const [version, total, ecLen, blocks, cap] = ver;
    const countBits = version <= 9 ? 8 : 16;
    // Bitstream: mode 0100, count, data, terminator, pad.
    let bits = [];

    function push(val, n) {
      for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1);
    }

    push(0b0100, 4);
    push(bytes.length, countBits);

    for (const b of bytes) push(b, 8);
    const dataCw = total - ecLen * blocks;
    const maxBits = dataCw * 8;

    for (let i = 0; i < 4 && bits.length < maxBits; i++) bits.push(0); // terminator

    while (bits.length % 8 !== 0) bits.push(0);
    const dataBytes = [];

    for (let i = 0; i < bits.length; i += 8) {
      let b = 0;

      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      dataBytes.push(b);
    }

    const pads = [0xec, 0x11];
    let pi = 0;

    while (dataBytes.length < dataCw) {
      dataBytes.push(pads[pi & 1]);
      pi++;
    }

    // Splitting into blocks + EC, then interleaving.
    const perBlock = Math.floor(dataCw / blocks);
    const remainder = dataCw - perBlock * blocks;
    const dataBlocks = [],
      ecBlocks = [];
    let off = 0;

    for (let bI = 0; bI < blocks; bI++) {
      const sz = perBlock + (bI >= blocks - remainder ? 1 : 0);
      const chunk = dataBytes.slice(off, off + sz);

      off += sz;
      dataBlocks.push(chunk);
      ecBlocks.push(rsEncode(chunk, ecLen));
    }

    const finalCw = [];
    const maxData = Math.max(...dataBlocks.map((b) => b.length));

    for (let i = 0; i < maxData; i++)
      for (const blk of dataBlocks) if (i < blk.length) finalCw.push(blk[i]);

    for (let i = 0; i < ecLen; i++) for (const blk of ecBlocks) finalCw.push(blk[i]);
    const { m, reserved, size } = buildMatrix(version, finalCw);
    // Pick the mask with the minimal penalty.
    let best = null,
      bestPen = Infinity;

    for (let mask = 0; mask < 8; mask++) {
      const masked = applyMask(m, reserved, size, mask);

      placeFormat(masked, size, mask);
      const pen = penalty(masked, size);

      if (pen < bestPen) {
        bestPen = pen;
        best = masked;
      }
    }

    return best;
  }

  // Renders the matrix into a container via a crisp <canvas> (square pixels).
  function render(container, text, sizePx) {
    const matrix = encode(text);

    if (!matrix) return false;
    const n = matrix.length,
      quiet = 4,
      total = n + quiet * 2;
    const scale = Math.max(2, Math.floor((sizePx || 180) / total));
    const px = total * scale;
    const canvas = document.createElement('canvas');

    canvas.width = px;
    canvas.height = px;
    canvas.style.width = px + 'px';
    canvas.style.height = px + 'px';
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = '#000';

    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++) {
        if (matrix[r][c]) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
      }

    container.innerHTML = '';
    container.appendChild(canvas);

    return true;
  }

  return { render: render, encode: encode };
})();

// ── Security: 2FA (TOTP) + sessions ──────────────────────────────────────────
const securityTotpStatus = document.getElementById('security-totp-status');
const securityTotpEnableBtn = document.getElementById('security-totp-enable');
const securityTotpDisableBtn = document.getElementById('security-totp-disable');
const securityLogoutAllBtn = document.getElementById('security-logout-all');

const totpBackdrop = document.getElementById('totp-backdrop');
const totpTitle = document.getElementById('totp-title');
const totpError = document.getElementById('totp-error');
const totpClose = document.getElementById('totp-close');
const totpStepEnroll = document.getElementById('totp-step-enroll');
const totpStepRecovery = document.getElementById('totp-step-recovery');
const totpStepDisable = document.getElementById('totp-step-disable');
const totpQr = document.getElementById('totp-qr');
const totpSecretValue = document.getElementById('totp-secret-value');
const totpSecretCopy = document.getElementById('totp-secret-copy');
const totpVerifyForm = document.getElementById('totp-verify-form');
const totpVerifyCode = document.getElementById('totp-verify-code');
const totpVerifySubmit = document.getElementById('totp-verify-submit');
const totpEnrollCancel = document.getElementById('totp-enroll-cancel');
const totpRecoveryList = document.getElementById('totp-recovery-list');
const totpRecoveryCopy = document.getElementById('totp-recovery-copy');
const totpRecoveryDone = document.getElementById('totp-recovery-done');
const totpDisableForm = document.getElementById('totp-disable-form');
const totpDisableCode = document.getElementById('totp-disable-code');
const totpDisableSubmit = document.getElementById('totp-disable-submit');
const totpDisableCancel = document.getElementById('totp-disable-cancel');
let pendingRecoveryCodes = [];

function refreshSecurityState() {
  // totpEnabled is updated by /api/me and by the enable/disable actions.
  securityTotpStatus.textContent = totpEnabled
    ? t('securityTotpStatusOn')
    : t('securityTotpStatusOff');
  securityTotpStatus.classList.toggle('bg-emerald-500/20', totpEnabled);
  securityTotpStatus.classList.toggle('text-emerald-300', totpEnabled);
  securityTotpStatus.classList.toggle('bg-ink-500/15', !totpEnabled);
  securityTotpStatus.classList.toggle('text-ink-400', !totpEnabled);
  securityTotpEnableBtn.classList.toggle('hidden', totpEnabled);
  securityTotpDisableBtn.classList.toggle('hidden', !totpEnabled);
}

function showTotpError(msg) {
  totpError.textContent = msg;
  totpError.classList.remove('hidden');
}

function clearTotpError() {
  totpError.classList.add('hidden');
  totpError.textContent = '';
}

function closeTotpModal() {
  totpBackdrop.classList.add('hidden');
  document.removeEventListener('keydown', onTotpKey, true);
  pendingRecoveryCodes = [];
}

function onTotpKey(e) {
  // Capture + stopPropagation so Escape closes only the 2FA modal, never the
  // Settings panel underneath. While recovery codes are shown, Escape is blocked
  // entirely (explicit "Done" required).
  if (e.key !== 'Escape') return;
  e.preventDefault();
  e.stopPropagation();

  if (totpStepRecovery.classList.contains('hidden')) closeTotpModal();
}

function openTotpModal(mode) {
  clearTotpError();
  totpStepEnroll.classList.toggle('hidden', mode !== 'enroll');
  totpStepRecovery.classList.add('hidden');
  totpStepDisable.classList.toggle('hidden', mode !== 'disable');
  totpTitle.textContent = mode === 'disable' ? t('totpModalDisableTitle') : t('totpModalTitle');
  totpBackdrop.classList.remove('hidden');
  document.addEventListener('keydown', onTotpKey, true);
}

// Enable 2FA: init (secret + URI) → show QR + secret → verification.
securityTotpEnableBtn.addEventListener('click', async () => {
  securityTotpEnableBtn.disabled = true;

  try {
    const data = await settingsFetch('/api/account/totp/init', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    totpSecretValue.value = data.secret || '';
    totpVerifyCode.value = '';
    // QR rendered client-side; silent fallback to the plaintext secret if the
    // URI is too long for our encoder.
    totpQr.innerHTML = '';
    const ok = data.otpauth_uri && QR.render(totpQr, data.otpauth_uri, 184);

    totpQr.classList.toggle('hidden', !ok);
    openTotpModal('enroll');
    setTimeout(() => totpVerifyCode.focus(), 60);
  } catch (err) {
    showSettingsError(err.message || t('settingsErrGeneric'));
  } finally {
    securityTotpEnableBtn.disabled = false;
  }
});

totpVerifyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearTotpError();
  const code = totpVerifyCode.value.trim();

  if (!code) {
    showTotpError(t('totpCodeRequired'));

    return;
  }

  totpVerifySubmit.disabled = true;

  try {
    const data = await settingsFetch('/api/account/totp/enable', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });

    // enable bumps the epoch → fresh session + kb_csrf cookies; reload the CSRF
    // token so the next mutating requests don't break.
    setCsrfToken(readCsrfCookie());
    totpEnabled = true;
    refreshSecurityState();
    // Recovery codes are shown ONCE.
    pendingRecoveryCodes = Array.isArray(data.recovery_codes) ? data.recovery_codes : [];
    totpRecoveryList.innerHTML = pendingRecoveryCodes
      .map(
        (c) =>
          '<li class="bg-black/40 border subtle-border rounded px-2 py-1.5 text-center select-all">' +
          escapeHtml(c) +
          '</li>',
      )
      .join('');
    totpStepEnroll.classList.add('hidden');
    totpStepRecovery.classList.remove('hidden');
    setStatus(t('totpEnabledToast'), 'ok');
  } catch (err) {
    showTotpError(
      err.status === 400 ? t('totpInvalidCode') : err.message || t('settingsErrGeneric'),
    );
  } finally {
    totpVerifySubmit.disabled = false;
  }
});

totpSecretCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(totpSecretValue.value);
    totpSecretCopy.textContent = t('copied');
    setTimeout(() => (totpSecretCopy.textContent = t('copy')), 1200);
  } catch (e) {
    totpSecretValue.select();
  }
});
totpRecoveryCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(pendingRecoveryCodes.join('\n'));
    totpRecoveryCopy.textContent = t('copied');
    setTimeout(() => (totpRecoveryCopy.textContent = t('totpRecoveryCopy')), 1200);
  } catch (e) {}
});
totpEnrollCancel.addEventListener('click', closeTotpModal);
totpRecoveryDone.addEventListener('click', closeTotpModal);
totpClose.addEventListener('click', () => {
  if (totpStepRecovery.classList.contains('hidden')) closeTotpModal();
});
totpBackdrop.addEventListener('click', (e) => {
  if (e.target === totpBackdrop && totpStepRecovery.classList.contains('hidden')) closeTotpModal();
});

// Disable 2FA: asks for a code (TOTP or recovery).
securityTotpDisableBtn.addEventListener('click', () => {
  totpDisableCode.value = '';
  openTotpModal('disable');
  setTimeout(() => totpDisableCode.focus(), 60);
});
totpDisableForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearTotpError();
  const code = totpDisableCode.value.trim();

  if (!code) {
    showTotpError(t('totpCodeRequired'));

    return;
  }

  totpDisableSubmit.disabled = true;

  try {
    // A 6-digit code = TOTP; otherwise treated as a recovery code.
    const body = /^[0-9]{6}$/.test(code) ? { code } : { recovery: code };

    await settingsFetch('/api/account/totp/disable', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    setCsrfToken(readCsrfCookie());
    totpEnabled = false;
    refreshSecurityState();
    closeTotpModal();
    setStatus(t('totpDisabledToast'), 'ok');
  } catch (err) {
    showTotpError(
      err.status === 400 ? t('totpInvalidCode') : err.message || t('settingsErrGeneric'),
    );
  } finally {
    totpDisableSubmit.disabled = false;
  }
});

// Log out all my sessions: in-app confirmation then redirect to /login.
securityLogoutAllBtn.addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: t('securityLogoutAllConfirmTitle'),
    message: t('securityLogoutAllConfirmMsg'),
    confirmLabel: t('securityLogoutAllConfirm'),
    destructive: true,
  });

  if (!ok) return;
  securityLogoutAllBtn.disabled = true;

  try {
    await settingsFetch('/api/account/logout-all', { method: 'POST', body: JSON.stringify({}) });
    // Epoch changed: current session is revoked (cookie cleared server-side) → /login.
    window.location = '/login';
  } catch (err) {
    showSettingsError(err.message || t('settingsErrGeneric'));
    securityLogoutAllBtn.disabled = false;
  }
});

// ── Quick capture ────────────────────────────────────────────────────────────
const qcBtn = document.getElementById('quick-capture-btn');
const qcBackdrop = document.getElementById('quick-capture-backdrop');
const qcForm = document.getElementById('quick-capture-form');
const qcTitle = document.getElementById('quick-capture-title');
const qcBody = document.getElementById('quick-capture-body');
const qcCancel = document.getElementById('quick-capture-cancel');
const qcError = document.getElementById('quick-capture-error');

function openQuickCapture() {
  if (window.__viewerMode) return;
  qcError.classList.add('hidden');
  qcTitle.value = '';
  qcBody.value = '';
  qcBackdrop.classList.remove('hidden');
  setTimeout(() => qcTitle.focus(), 50);
}

function closeQuickCapture() {
  qcBackdrop.classList.add('hidden');
}

qcBtn.addEventListener('click', openQuickCapture);
qcCancel.addEventListener('click', closeQuickCapture);
document.getElementById('quick-capture-close')?.addEventListener('click', closeQuickCapture);
qcBackdrop.addEventListener('click', (e) => {
  if (e.target === qcBackdrop) closeQuickCapture();
});

qcForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  qcError.classList.add('hidden');
  const title = qcTitle.value.trim();

  if (!title) {
    qcError.textContent = t('titleRequired');
    qcError.classList.remove('hidden');

    return;
  }

  const body = qcBody.value.trim();
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr =
    now.getFullYear() +
    '-' +
    pad(now.getMonth() + 1) +
    '-' +
    pad(now.getDate()) +
    '-' +
    pad(now.getHours()) +
    pad(now.getMinutes());
  const slug = (slugify(title) || 'note').slice(0, 50);
  const path = 'inbox/' + dateStr + '-' + slug + '.md';
  const content =
    '# ' + title + '\n\n_Capture : ' + now.toLocaleString('fr-FR') + '_\n\n' + body + '\n';

  try {
    const res = await fetch('/api/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content }),
    });

    if (!res.ok) throw new Error('HTTP ' + res.status);
    closeQuickCapture();
    setStatus(t('noteSaved'), 'ok');
  } catch (e) {
    qcError.textContent = t('err', e.message);
    qcError.classList.remove('hidden');
  }
});

// ── New file modal ───────────────────────────────────────────────────────────
const newFileBtn = document.getElementById('new-file-btn');
const newFileBackdrop = document.getElementById('new-file-backdrop');
const newFileForm = document.getElementById('new-file-form');
const newFileDir = document.getElementById('new-file-dir');
const newFileName = document.getElementById('new-file-name');
const newFileDirCb = AtlasCombobox(newFileDir, { source: getAllDirs, creatable: true });
const newFileTemplate = document.getElementById('new-file-template');
const newFileVisibility = document.getElementById('new-file-visibility');
const newFileError = document.getElementById('new-file-error');
const newFileCancel = document.getElementById('new-file-cancel');
const newFileExtArea = document.getElementById('new-file-ext-area');

async function refreshTreeOrReload() {
  if (window.softReload) await window.softReload();
  else location.reload();
}

// Fills a DOC_TEMPLATES skeleton: tokens {{title}}, {{date}} (UI locale long
// form), {{isoDate}} (YYYY-MM-DD). Unknown kind (incl. 'blank') → title only.
function buildTemplateContent(kind, title) {
  const template = DOC_TEMPLATES && DOC_TEMPLATES[kind];

  if (!template) {
    return '# ' + title + '\n\n';
  }

  const locale = LANG === 'en' ? 'en-GB' : 'fr-FR';
  const today = new Date().toLocaleDateString(locale, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const isoDate = new Date().toISOString().slice(0, 10);

  return template
    .replaceAll('{{title}}', title)
    .replaceAll('{{date}}', today)
    .replaceAll('{{isoDate}}', isoDate);
}

// "Blank" stays the reserved first option; skeleton names cannot override it.
(function populateTemplateOptions() {
  for (const name of Object.keys(DOC_TEMPLATES || {}).sort()) {
    if (name === 'blank') continue;
    const option = document.createElement('option');

    option.value = name;
    option.textContent = name;
    newFileTemplate.appendChild(option);
  }
})();

// ─── Extension templates + window.Atlas API ───────────────────────────────────
// Extensions (loaded after this script, inlined by build.py) register a
// new-document template and drive the viewer via window.Atlas. Events emitted on
// document: atlas:doc-rendered {path, markdown}, atlas:edit-enter.
// A modal carrying [data-atlas-modal] blocks the soft-reload while visible.
const templateProviders = Object.create(null);

function updateTemplateExtras() {
  const active = templateProviders[newFileTemplate.value] || null;

  for (const value in templateProviders) {
    const provider = templateProviders[value];

    if (provider.block) provider.block.classList.toggle('hidden', provider !== active);
  }

  newFileName.placeholder = (active && active.namePlaceholder) || t('docNamePlaceholder');

  if (active && active.defaultDir && !newFileDir.value.trim()) {
    newFileDir.value = active.defaultDir;
  }
}

window.Atlas = {
  version: 1,
  t,
  escapeHtml,
  setStatus,
  refresh: refreshTreeOrReload,
  // Markdown doc currently displayed ({path}) or null.
  currentDoc() {
    return currentFile ? { path: currentFile.path } : null;
  },
  // Drop a doc's cache after a write outside the viewer → next display re-fetches.
  invalidateDoc(path) {
    contentCache.delete(path);

    if (currentFile && currentFile.path === path) {
      currentFile.content = null;
      currentFile.mtime = 0;
    }
  },
  // Registers a new-document template. provider:
  //   label           : label of the select option (default: value)
  //   generate()      : async → {content, slug?}; a thrown error is shown
  //                     as-is to the user (message already localized)
  //   block           : optional form element (shown when selected)
  //   namePlaceholder : placeholder of the name field when selected
  //   defaultDir      : suggested folder if the folder field is empty
  //   successMessage  : status shown after creation (default: docCreated)
  //   onOpen()        : called on every opening of the modal (resets the block)
  // Rejected values: 'blank', a DOC_TEMPLATES skeleton with the same name, an
  // extension template already registered.
  registerTemplate(value, provider) {
    if (!value || !provider || typeof provider.generate !== 'function') return false;

    if (value === 'blank' || templateProviders[value] || (DOC_TEMPLATES && DOC_TEMPLATES[value]))
      return false;
    templateProviders[value] = provider;
    const option = document.createElement('option');

    option.value = value;
    option.textContent = provider.label || value;
    newFileTemplate.appendChild(option);

    if (provider.block) {
      provider.block.classList.add('hidden');
      newFileExtArea.appendChild(provider.block);
    }

    return true;
  },
};

function getAllDirs() {
  const dirs = new Set();

  (function walk(node, prefix) {
    for (const c of node.children || []) {
      if (c.type === 'dir') {
        const path = prefix ? prefix + '/' + c.name : c.name;

        dirs.add(path);
        walk(c, path);
      }
    }
  })(TREE, '');

  return Array.from(dirs).sort();
}

function openNewFileModal(presetDir) {
  if (window.__viewerMode) return;
  newFileError.classList.add('hidden');
  newFileDir.value = presetDir || '';
  newFileName.value = '';
  newFileTemplate.value = 'blank';
  if (newFileVisibility) {
    // Default: PRIVATE (Notion sense), pre-selected to the user's last choice. A
    // doc created inside a private folder is private regardless (server enforces).
    newFileVisibility.value =
      localStorage.getItem('atlas:newdoc-visibility') === 'commons' ? 'commons' : 'private';
  }

  for (const value in templateProviders) {
    const provider = templateProviders[value];

    if (provider.onOpen) {
      try {
        provider.onOpen();
      } catch (err) {
        console.warn('[extension] onOpen', value, err);
      }
    }
  }

  updateTemplateExtras();
  newFileBackdrop.classList.remove('hidden');
  setTimeout(() => (presetDir ? newFileName : newFileDir).focus(), 50);
}

function closeNewFileModal() {
  newFileBackdrop.classList.add('hidden');
}

newFileBtn.addEventListener('click', () => openNewFileModal());
newFileCancel.addEventListener('click', closeNewFileModal);
document.getElementById('new-file-close')?.addEventListener('click', closeNewFileModal);
newFileBackdrop.addEventListener('click', (e) => {
  if (e.target === newFileBackdrop) closeNewFileModal();
});
newFileTemplate.addEventListener('change', updateTemplateExtras);

function showNewFileError(msg) {
  newFileError.textContent = msg;
  newFileError.classList.remove('hidden');
}

newFileForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  newFileError.classList.add('hidden');
  const dir = newFileDir.value.trim().replace(/^\/+|\/+$/g, '');
  let name = newFileName.value.trim();
  const provider = templateProviders[newFileTemplate.value] || null;

  let content;

  if (provider) {
    // Extension generator produces the content (+ fallback slug). Thrown error = user message.
    try {
      const built = await provider.generate();

      content = built.content;

      if (!name) name = (built.slug || '').trim();
    } catch (err) {
      return showNewFileError(err.message);
    }
  }

  if (!name) return showNewFileError(t('nameRequired'));

  if (/[\\\/]/.test(name)) return showNewFileError(t('noSlashes'));

  if (!name.endsWith('.md')) name += '.md';
  const path = dir ? dir + '/' + name : name;

  if (fileMap[path]) return showNewFileError(t('fileExists'));

  if (!provider) {
    const title = name
      .replace(/\.md$/, '')
      .replace(/[-_]/g, ' ')
      .replace(/(?:^|\s)\S/g, (c) => c.toUpperCase());

    content = buildTemplateContent(newFileTemplate.value, title);
  }

  const visibility = newFileVisibility ? newFileVisibility.value : 'private';
  try { localStorage.setItem('atlas:newdoc-visibility', visibility); } catch (_) { /* ignore */ }

  try {
    const res = await fetch('/api/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content, private: visibility === 'private' }),
    });

    if (!res.ok) throw new Error('HTTP ' + res.status);
    closeNewFileModal();
    location.hash = '#' + encodeURIComponent(path);
    setStatus((provider && provider.successMessage) || t('docCreated'), 'ok');
    await refreshTreeOrReload();
  } catch (err) {
    showNewFileError(t('errSp', err.message));
  }
});

// ── Dir rename modal ─────────────────────────────────────────────────────────
const dirRenameBackdrop = document.getElementById('dir-rename-backdrop');
const dirRenameForm = document.getElementById('dir-rename-form');
const dirRenameInput = document.getElementById('dir-rename-input');
const dirRenameCurrent = document.getElementById('dir-rename-current');
const dirRenameError = document.getElementById('dir-rename-error');
const dirRenameCancel = document.getElementById('dir-rename-cancel');
let dirRenameSourcePath = null;

function openDirRenameModal(path) {
  if (window.__viewerMode || !path) return;
  dirRenameSourcePath = path;
  const parts = path.split('/');
  const name = parts[parts.length - 1];

  dirRenameCurrent.textContent = path;
  dirRenameInput.value = name;
  dirRenameError.classList.add('hidden');
  dirRenameBackdrop.classList.remove('hidden');
  setTimeout(() => {
    dirRenameInput.focus();
    dirRenameInput.select();
  }, 50);
}

function closeDirRenameModal() {
  dirRenameBackdrop.classList.add('hidden');
  dirRenameSourcePath = null;
}

dirRenameCancel.addEventListener('click', closeDirRenameModal);
document.getElementById('dir-rename-close')?.addEventListener('click', closeDirRenameModal);
dirRenameBackdrop.addEventListener('click', (e) => {
  if (e.target === dirRenameBackdrop) closeDirRenameModal();
});

dirRenameForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  dirRenameError.classList.add('hidden');

  if (!dirRenameSourcePath) return;
  const newName = dirRenameInput.value.trim().replace(/^\/+|\/+$/g, '');

  if (!newName) {
    dirRenameError.textContent = t('nameRequired');
    dirRenameError.classList.remove('hidden');

    return;
  }

  if (/[\\\/]/.test(newName)) {
    dirRenameError.textContent = t('noSlashes');
    dirRenameError.classList.remove('hidden');

    return;
  }

  const parts = dirRenameSourcePath.split('/');

  parts[parts.length - 1] = newName;
  const newPath = parts.join('/');

  if (newPath === dirRenameSourcePath) {
    closeDirRenameModal();

    return;
  }

  try {
    const res = await fetch('/api/dir/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: dirRenameSourcePath, to: newPath }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));

      throw new Error(err.error || 'HTTP ' + res.status);
    }

    closeDirRenameModal();
    // Re-key the content caches under the new prefix + update currentFile.
    const oldPrefix = dirRenameSourcePath + '/';
    const newPrefix = newPath + '/';
    const toMove = [];

    for (const k of contentCache.keys()) {
      if (k.startsWith(oldPrefix)) toMove.push(k);
    }

    for (const oldK of toMove) {
      const v = contentCache.get(oldK);

      contentCache.delete(oldK);
      contentCache.set(newPrefix + oldK.slice(oldPrefix.length), v);
    }

    if (currentFile && currentFile.path.startsWith(oldPrefix)) {
      currentFile.path = newPrefix + currentFile.path.slice(oldPrefix.length);
      location.hash = '#' + encodeURIComponent(currentFile.path);
    }

    setStatus(t('folderRenamed'), 'ok');
    await refreshTreeOrReload();
  } catch (err) {
    dirRenameError.textContent = t('errSp', err.message);
    dirRenameError.classList.remove('hidden');
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!settingsBackdrop.classList.contains('hidden')) {
      closeSettings();

      return;
    }

    if (!newFileBackdrop.classList.contains('hidden')) {
      closeNewFileModal();

      return;
    }

    if (!dirRenameBackdrop.classList.contains('hidden')) {
      closeDirRenameModal();

      return;
    }

    if (!qcBackdrop.classList.contains('hidden')) {
      closeQuickCapture();

      return;
    }

    if (!shareBackdrop.classList.contains('hidden')) {
      closeShareModal();

      return;
    }

    if (!renameBackdrop.classList.contains('hidden')) {
      closeRenameModal();

      return;
    }
  }

  if (
    e.key === 'n' &&
    !window.__viewerMode &&
    !editMode &&
    !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)
  ) {
    e.preventDefault();
    openNewFileModal();
  }
});

// ── Access & sharing (per-document ACL) ──────────────────────────────────────
// The "Accès" button on a doc opens a dialog to see/own/share it with users,
// groups, or everyone — backed by /api/acl. Read-only for a non-manager.
(function () {
  const backdrop = document.getElementById('acl-backdrop');

  if (!backdrop) return; // offline build without the dialog partial

  const pathEl = document.getElementById('acl-path');
  const statusEl = document.getElementById('acl-status');
  const grantsEl = document.getElementById('acl-grants');
  const manageEl = document.getElementById('acl-manage');
  const form = document.getElementById('acl-grant-form');
  const kindSel = document.getElementById('acl-kind');
  const valueInp = document.getElementById('acl-value');
  const levelSel = document.getElementById('acl-level');
  const errEl = document.getElementById('acl-error');

  let cur = null; // { path, owner, grants, can_manage }
  let dir = null; // { users:[emails], groups:[names] } — cached for autocompletion

  // The value field is a creatable combobox: pick a known user/group OR type a new
  // one. Its source flips with the kind select (users vs groups) → refresh() on change.
  const aclCb = AtlasCombobox(valueInp, {
    source: () => (kindSel.value === 'group' ? (dir && dir.groups) || [] : (dir && dir.users) || []),
    creatable: true,
  });

  async function loadDir() {
    if (!dir) {
      try {
        const r = await fetch('/api/directory');
        if (r.ok) dir = await r.json();
      } catch (_) {
        /* best-effort */
      }
    }
    return dir || { users: [], groups: [] };
  }

  function myPrincipal() {
    return meState && meState.email ? 'user:' + meState.email : null;
  }

  function principalLabel(p) {
    if (p === '*') return '🌐 ' + t('aclEveryone');
    if (p.startsWith('user:')) return '👤 ' + p.slice(5);
    if (p.startsWith('group:')) return '👥 ' + p.slice(6);
    if (p.startsWith('anon:')) return '🔗 ' + t('aclLinkPrincipal');

    return p;
  }

  function levelLabel(l) {
    if (l === 'edit') return t('aclLevelEdit');
    if (l === 'comment') return t('aclLevelComment');

    return t('aclLevelView');
  }

  function render() {
    pathEl.textContent = cur.path;

    if (cur.owner) {
      const mine = myPrincipal();
      const who = mine && cur.owner === mine
        ? t('aclYou')
        : cur.owner.startsWith('user:') ? cur.owner.slice(5) : cur.owner;
      statusEl.innerHTML =
        '<span class="text-amber-300 font-medium">' + escapeHtml(t('aclPrivate')) + '</span> · ' +
        escapeHtml(t('aclOwner')) + ' ' + escapeHtml(who);
    } else {
      statusEl.innerHTML =
        '<span class="text-emerald-300 font-medium">' + escapeHtml(t('aclCommons')) + '</span>';
    }

    if (cur.creator) {
      const mine = myPrincipal();
      const who = mine && cur.creator === mine
        ? t('aclYou')
        : cur.creator.startsWith('user:') ? cur.creator.slice(5) : cur.creator;
      statusEl.innerHTML +=
        ' <span class="text-ink-500">· ' + escapeHtml(t('aclCreatedBy')) + ' ' + escapeHtml(who) + '</span>';
    }

    const grants = cur.grants || [];

    grantsEl.innerHTML = grants.length
      ? grants
          .map(
            (g) =>
              '<li class="flex items-center justify-between gap-2 bg-navy-900 border subtle-border rounded px-2.5 py-1.5 text-xs">' +
              '<span class="truncate text-ink-200">' +
              escapeHtml(principalLabel(g.principal)) +
              ' · <span class="text-ink-400">' +
              escapeHtml(levelLabel(g.level)) +
              '</span></span>' +
              (cur.can_manage
                ? '<button class="acl-revoke text-ink-500 hover:text-rose-300 px-1 flex-shrink-0" data-principal="' +
                  escapeHtml(g.principal) +
                  '" title="' +
                  escapeHtml(t('aclRemove')) +
                  '">✕</button>'
                : '') +
              '</li>',
          )
          .join('')
      : '<li class="text-[11px] text-ink-500">' + escapeHtml(t('aclNoGrants')) + '</li>';

    manageEl.classList.toggle('hidden', !cur.can_manage);
    errEl.classList.add('hidden');
  }

  async function refresh() {
    const res = await fetch('/api/acl?path=' + encodeURIComponent(cur.path));

    if (res.ok) {
      cur = await res.json();
      render();
    }
  }

  async function openAccessFor(path) {
    if (!path) return;

    try {
      const res = await fetch('/api/acl?path=' + encodeURIComponent(path));

      if (!res.ok) return; // not readable → nothing to show
      cur = await res.json();
      kindSel.value = 'user';
      document.getElementById('acl-value-wrap').classList.remove('hidden');
      aclCb.clear();
      render();
      backdrop.classList.remove('hidden');
      loadDir().then(() => aclCb.refresh());
    } catch (_) {
      /* best-effort */
    }
  }

  function close() {
    backdrop.classList.add('hidden');
  }

  async function post(body) {
    errEl.classList.add('hidden');

    const res = await fetch('/api/acl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const p = await res.json().catch(() => null);

      errEl.textContent = (p && p.error) || 'HTTP ' + res.status;
      errEl.classList.remove('hidden');

      return false;
    }

    await refresh();

    return true;
  }

  window.openAccessFor = openAccessFor;

  document.getElementById('btn-access')?.addEventListener('click', () => {
    if (currentFile) openAccessFor(currentFile.path);
  });
  document.getElementById('acl-close').addEventListener('click', close);
  document.getElementById('acl-close-x')?.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  kindSel.addEventListener('change', () => {
    document.getElementById('acl-value-wrap').classList.toggle('hidden', kindSel.value === '*');
    aclCb.refresh();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    let principal;

    if (kindSel.value === '*') {
      principal = '*';
    } else {
      const v = aclCb.getValue();

      if (!v) return;
      principal = kindSel.value + ':' + (kindSel.value === 'user' ? v.toLowerCase() : v);
    }

    if (await post({ path: cur.path, action: 'grant', principal, level: levelSel.value })) {
      aclCb.clear();
      setStatus(t('aclSharedToast'), 'ok');
    }
  });

  grantsEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('.acl-revoke');

    if (btn && (await post({ path: cur.path, action: 'revoke', principal: btn.dataset.principal }))) {
      setStatus(t('aclRevokedToast'), 'ok');
    }
  });

  document.getElementById('acl-make-private').addEventListener('click', async () => {
    const mine = myPrincipal();

    if (mine && (await post({ path: cur.path, action: 'set_owner', principal: mine }))) {
      setStatus(t('aclNowPrivateToast'), 'ok');
    }
  });

  document.getElementById('acl-make-commons').addEventListener('click', async () => {
    // Destructive: removes the owner AND every grant of this doc → confirm first.
    const ok = await confirmDialog({
      title: t('aclMakeCommons'),
      message: t('aclMakeCommonsConfirm'),
      confirmLabel: t('aclMakeCommons'),
      destructive: true,
    });

    if (ok && (await post({ path: cur.path, action: 'make_commons' }))) {
      setStatus(t('aclNowCommonsToast'), 'ok');
    }
  });
})();

// Activity card (home): Journal / Constellation / Santé views over the attributed git history.
// Reads GET /api/activity (the read side of the attribution layer); reuses the real
// constellation avatars. Hidden offline / when there is nothing to show.
(function () {
  const esc = escapeHtml;  // canonical (escapes ' too), from 01-i18n-state.js

  // CDC event types -> display label + tint + Heroicons-v2 outline path (clean line
  // icons, matching the rest of the app). Keyed by the type /api/activity returns.
  const TYPES = {
    create: { label: 'created', color: '#e8941c', d: 'M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z' },
    edit: { label: 'edited', color: '#1d9bd1', d: 'm16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.931-8.931Zm0 0L19.5 7.125' },
    move: { label: 'moved', color: '#1d9bd1', d: 'M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5' },
    delete: { label: 'deleted', color: '#868a90', d: 'm14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0' },
    check: { label: 'checked', color: '#5fd0a6', d: 'M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z' },
    revert: { label: 'reverted', color: '#e8941c', d: 'M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3' },
    // Mental-node subscriptions: the share/nodes glyph, tinted green (added) / grey (removed).
    node_add: { label: 'added node', color: '#5fd0a6', d: 'M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.933-2.185 2.25 2.25 0 0 0-3.933 2.185Z' },
    node_remove: { label: 'removed node', color: '#868a90', d: 'M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.933-2.185 2.25 2.25 0 0 0-3.933 2.185Z' },
  };
  const TY = (t) => TYPES[t] || TYPES.edit;

  // Verb labels by UI language (LANG from 01-i18n-state.js). A local map (vs t()) keeps
  // them next to TYPES and avoids colliding with existing STRINGS keys (create/edit…).
  const VERB = {
    fr: { create: 'créé', edit: 'édité', move: 'déplacé', delete: 'supprimé', check: 'coché', revert: 'restauré', node_add: 'ajouté le nœud', node_remove: 'retiré le nœud' },
    en: { create: 'created', edit: 'edited', move: 'moved', delete: 'deleted', check: 'checked', revert: 'reverted', node_add: 'added the node', node_remove: 'removed the node' },
  };
  const verb = (type) => (VERB[LANG] || VERB.fr)[type] || type;
  // In a sentence ("Ludovic a créé X"), French wants the auxiliary; English doesn't.
  // The bare verb() stays for the orrery legend, where chips read as labels, not sentences.
  const verbPhrase = (type) => (LANG === 'en' ? '' : 'a ') + verb(type);
  const docTitle = (p) => ((p || '').split('/').pop() || p).replace(/\.(md|html)$/i, '');

  const AI = {
    claude: 'M12 2.6l1.6 5.9 5.9 1.6-5.9 1.6L12 21.4l-1.6-7.7L4.5 12l5.9-1.6L12 2.6Z',
    chatgpt: 'M12 3.2 18.5 7v8L12 18.8 5.5 15V7L12 3.2Z',
    gemini: 'M12 3c.6 4.5 2.4 6.3 6.9 6.9-4.5.6-6.3 2.4-6.9 6.9-.6-4.5-2.4-6.3-6.9-6.9C9.6 9.3 11.4 7.5 12 3Z',
    generic: 'M12 4l2 6 6 2-6 2-2 6-2-6-6-2 6-2 2-6Z',
  };

  const iconSvg = (type, size) => {
    const t = TY(type);
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${t.color}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="${t.d}"/></svg>`;
  };

  const aiBadge = (family) =>
    `<span class="activity-badge"><svg width="9" height="9" viewBox="0 0 24 24" fill="#e8941c"><path d="${AI[family] || AI.generic}"/></svg></span>`;

  // Atlas Bot (the app's own automated writes) shows the application logo itself.
  const botAvatar = (size) =>
    `<img src="/icon.svg" width="${size}" height="${size}" alt="Atlas" style="display:block">`;

  const avatar = (e, size) => {
    // The bot shows the app logo, served at /icon.svg. That URL 404s in a
    // single-file OFFLINE build (the img src is built at runtime, so the offline
    // inliner can't rewrite it), so there we fall back to a constellation glyph
    // rather than a broken image.
    if (e.bot && !IS_OFFLINE_BUILD) return botAvatar(size);
    try {
      return constellationSvg(avatarSeed(e.first, e.last, e.email), size);
    } catch (_) {
      return `<span class="inline-block rounded-lg" style="width:${size}px;height:${size}px;background:#23222a"></span>`;
    }
  };

  function rel(min) {
    const en = LANG === 'en';
    if (min < 1) return en ? 'just now' : "à l'instant";
    if (min < 60) return Math.round(min) + ' min';
    const h = Math.round(min / 60);
    if (h < 24) return h + ' h';
    const d = Math.round(min / 1440);
    if (d === 1) return en ? 'yesterday' : 'hier';
    return en ? d + 'd ago' : 'il y a ' + d + ' j';
  }
  function dayKey(min) {
    const d = new Date(Date.now() - min * 60000);
    const now = new Date();
    const a = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const b = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diff = Math.round((a - b) / 86400000);
    if (diff <= 0) return LANG === 'en' ? 'Today' : "Aujourd'hui";
    if (diff === 1) return LANG === 'en' ? 'Yesterday' : 'Hier';
    return d.toLocaleDateString(LANG === 'en' ? 'en-US' : 'fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  function toItem(e) {
    const author = (e.author || e.email || '').trim();
    const parts = author.split(/\s+/);
    const t = Date.parse(e.date);
    return {
      who: author,
      first: parts[0] || e.email || '',
      last: parts.slice(1).join(' '),
      email: e.email || '',
      ai: e.ai || null,
      bot: /atlas bot/i.test(author),
      type: e.type,
      title: e.title || (e.paths && e.paths[0]) || '',
      agoMin: isNaN(t) ? 0 : Math.max(0, Math.round((Date.now() - t) / 60000)),
      sha: e.short_sha || (e.sha || '').slice(0, 7),
      path: (e.paths && e.paths[0]) || '',
      subject: e.subject || '',
    };
  }

  // Show the doc's history overlay in place ("voir les modifications"), no navigation,
  // the activity feed stays put. No-ops if the doc no longer exists (deleted/moved).
  function openDocHistory(path) {
    if (!path || typeof fileMap === 'undefined' || typeof openHistory !== 'function') return;
    const f = fileMap[path];
    if (f) openHistory(f);
  }

  let _items = null;
  let _orreryItems = [];   // the list the constellation nodes index into (respects the filter)
  let _aiOnly = false;     // 13d: filter the feed to AI-authored events only
  let _digest = null;      // 13b: factual digest of the last 7 days (computed from the events)
  let _health = null;      // 13c: { stale, cands } for the Santé view
  let _healthExpanded = false;
  let _candExpanded = false;
  let _healthTab = (() => { try { return localStorage.getItem('atlas:healthTab') || 'stale'; } catch (_) { return 'stale'; } })();  // 13c: persisted Santé sub-view
  const shownItems = () => (_aiOnly ? _items.filter((i) => i.ai) : _items);

  async function load() {
    // Offline build: read the activity snapshot frozen into the page at build
    // time (public minds only) instead of hitting /api/activity.
    if (IS_OFFLINE_BUILD) {
      return EMBED_ACTIVITY ? EMBED_ACTIVITY.events.map(toItem) : null;
    }
    if (!location.protocol.startsWith('http')) return null;
    try {
      const r = await fetch('/api/activity?since=60&limit=200');
      if (!r.ok) return null;
      const data = await r.json();
      return Array.isArray(data.events) ? data.events.map(toItem) : null;
    } catch (_) {
      return null;
    }
  }

  // Collapse a run of consecutive events on the SAME doc by the same actor + type into
  // one entry with a count: a burst of edits to one doc shouldn't read as N identical
  // lines (CDC §9). Events arrive newest-first, so the kept time is the most recent.
  function aggregate(items) {
    const out = [];
    for (const e of items) {
      const last = out[out.length - 1];
      if (last && last.path === e.path && last.who === e.who
          && last.type === e.type && last.ai === e.ai) {
        last.count += 1;
      } else {
        out.push(Object.assign({ count: 1 }, e));
      }
    }
    return out;
  }

  // ── Journal ───────────────────────────────────────────────────────────
  function row(e) {
    const ty = TY(e.type);
    const via = e.ai ? `<span class="text-ink-500 text-xs">· via ${esc(e.ai)}</span>` : '';
    return (
      `<div class="act-row flex items-center gap-3" data-path="${esc(e.path)}" data-tip="${esc(t('actSeeChanges'))}">
        <div class="relative shrink-0" style="line-height:0">${avatar(e, 30)}${e.ai ? aiBadge(e.ai) : ''}</div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5"><span class="text-sm font-semibold text-ink-100">${esc(e.who)}</span>${via}</div>
          <div class="flex items-center gap-1.5 text-sm mt-0.5">
            <span class="shrink-0" style="line-height:0">${iconSvg(e.type, 14)}</span>
            <span class="shrink-0" style="color:${ty.color};font-weight:600;white-space:nowrap">${verbPhrase(e.type)}</span>
            <span class="text-ink-300 truncate min-w-0">${esc(e.title)}</span>
            ${e.count > 1 ? `<span class="text-ink-500 text-xs shrink-0">×${e.count}</span>` : ''}
          </div>
        </div>
        <div class="shrink-0 text-xs text-ink-500 font-mono" title="${esc(e.sha)}">${rel(e.agoMin)}</div>
      </div>`
    );
  }

  const JOURNAL_PREVIEW = 8;
  let _expanded = false;

  function journalHtml() {
    const all = shownItems();
    if (!all.length) return `<div class="text-ink-500 text-sm py-4 text-center">${_aiOnly ? t('actEmptyAi') : t('actEmpty')}</div>`;
    let out = '';
    let day = '';
    const shown = _expanded ? all : all.slice(0, JOURNAL_PREVIEW);
    shown.forEach((e) => {
      const k = dayKey(e.agoMin);
      if (k !== day) {
        day = k;
        out += `<div class="text-[11px] uppercase tracking-wider text-ink-500 font-semibold mt-3 mb-1 first:mt-0">${esc(day)}</div>`;
      }
      out += row(e);
    });
    // Toggle in place, no extra view to navigate to, the feed just unfolds.
    if (all.length > JOURNAL_PREVIEW) {
      out += `<div class="text-right mt-3"><a class="act-seeall text-sm text-accent hover:underline cursor-pointer">${_expanded ? t('actCollapse') : t('actSeeAll')}</a></div>`;
    }
    return out;
  }

  // ── Constellation ─────────────────────────────────────────────────────
  const ORRERY_CAP = 18;  // aggregated entries (distinct doc-activities), not raw commits

  function orreryNodes() {
    const cx = 360, cy = 265;
    const radii = [104, 172, 236];
    // Cap + even split by recency RANK (not raw time): each ring gets a balanced share
    // so a burst of recent edits can't pile onto one ring. Inner = most recent.
    const items = (_orreryItems = shownItems()).slice(0, ORRERY_CAP).map((e, i) => ({ e, i }));
    const perRing = Math.max(1, Math.ceil(items.length / 3));
    const rings = [[], [], []];
    items.forEach((it, idx) => rings[Math.min(2, Math.floor(idx / perRing))].push(it));
    let nodes = '';
    rings.forEach((arr, ri) => {
      const r = radii[ri];
      const off = ri * 0.7 + 0.15;  // stagger rings so nodes don't align radially
      arr.forEach((it, k) => {
        const ang = (k + 0.5) / arr.length * Math.PI * 2 - Math.PI / 2 + off;
        const x = cx + r * Math.cos(ang), y = cy + r * Math.sin(ang);
        const c = TY(it.e.type).color;
        nodes +=
          `<g class="act-node" data-i="${it.i}" tabindex="0" transform="translate(${x.toFixed(1)},${y.toFixed(1)})">
            <g class="act-node-inner">
              <circle r="19" fill="#14131a" stroke="${c}" stroke-opacity=".6"/>
              <svg x="-11" y="-11" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${TY(it.e.type).d}"/></svg>
              ${it.e.ai ? '<circle cx="13" cy="-13" r="5" fill="#14131a" stroke="#e8941c" stroke-opacity=".8"/><circle cx="13" cy="-13" r="1.8" fill="#e8941c"/>' : ''}
            </g>
          </g>`;
      });
    });
    const ringSvg = radii
      .map((r) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#6a7180" stroke-opacity=".4" stroke-width="1" stroke-dasharray="3 7"/>`)
      .join('');
    return { ringSvg, nodes, cx, cy };
  }

  function orreryHtml() {
    const { ringSvg, nodes, cx, cy } = orreryNodes();
    const legend = Object.keys(TYPES)
      .map((k) => `<span class="act-legend-chip">${iconSvg(k, 12)}<span>${verb(k)}</span></span>`)
      .join('');
    return (
      `<div class="act-orrery flex items-start gap-4">
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
      </div>`
    );
  }

  function popHtml(e) {
    const ty = TY(e.type);
    const via = e.ai ? `<span class="text-ink-500 text-xs">· via ${esc(e.ai)}</span>` : '';
    return (
      `<div class="flex items-center gap-2 mb-1.5"><span style="line-height:0">${avatar(e, 26)}</span><span class="text-sm font-semibold text-ink-100">${esc(e.who)}</span>${via}</div>
       <div class="flex items-baseline gap-1.5 text-sm"><span style="color:${ty.color};font-weight:600;white-space:nowrap">${verbPhrase(e.type)}</span><span class="text-ink-300" style="min-width:0;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(e.title)}</span>${e.count > 1 ? `<span class="text-ink-500 text-xs" style="white-space:nowrap">×${e.count}</span>` : ''}</div>
       <div class="text-xs text-ink-500 font-mono mt-1.5">${rel(e.agoMin)} · ${esc(e.sha)}</div>`
    );
  }

  function wireOrreryHover(container) {
    const wrap = container.querySelector('.act-sky');
    const pop = container.querySelector('.act-pop');
    if (!wrap || !pop) return;
    const show = (node) => {
      const e = _orreryItems[+node.dataset.i];
      if (!e) return;
      pop.innerHTML = popHtml(e);
      pop.classList.remove('hidden');
      if (window.matchMedia('(max-width:767px)').matches) {
        pop.style.left = pop.style.top = pop.style.transform = '';  // CSS bottom-sheet positions it
        return;
      }
      const nb = node.getBoundingClientRect(), wb = wrap.getBoundingClientRect();
      let left = nb.left - wb.left + nb.width / 2;
      const half = pop.offsetWidth / 2;
      left = Math.max(half + 4, Math.min(wb.width - half - 4, left));
      pop.style.left = left + 'px';
      // flip below the node when there isn't room above (keeps it off the toggle / top edge)
      if (nb.top - wb.top > pop.offsetHeight + 16) {
        pop.style.top = (nb.top - wb.top - 10) + 'px';
        pop.style.transform = 'translate(-50%, -100%)';
      } else {
        pop.style.top = (nb.bottom - wb.top + 10) + 'px';
        pop.style.transform = 'translate(-50%, 0)';
      }
    };
    const hide = () => pop.classList.add('hidden');
    const noHover = window.matchMedia('(hover: none)').matches;  // touch: no hover → tap to reveal
    let activeNode = null;
    wrap.querySelectorAll('.act-node').forEach((n) => {
      n.addEventListener('mouseenter', () => show(n));
      n.addEventListener('mouseleave', hide);
      n.addEventListener('focus', () => show(n));
      n.addEventListener('blur', hide);
      n.addEventListener('click', () => {
        const e = _orreryItems[+n.dataset.i];
        if (!noHover) { if (e) openDocHistory(e.path); return; }
        if (activeNode === n) { if (e) openDocHistory(e.path); }   // 2nd tap on same node → open history
        else { activeNode = n; show(n); }                          // 1st tap → reveal the popover
      });
    });
    wrap.addEventListener('click', (ev) => {
      if (!ev.target.closest('.act-node')) { hide(); activeNode = null; }  // tap the empty sky → dismiss
    });
  }

  // Easter egg: flick the orrery (one full orbit) + bounce the sun on click; every 5th
  // click, a little supernova line floats up. Pure fun; reduced-motion gets just the line.
  const EGG_LINES = [
    '✨ tu as trouvé le cœur du mind',
    '🪐 Atlas porte le ciel… et ton bordel',
    '☄️ supernova !',
    '🌟 fais un vœu',
    '🔭 continue d’explorer',
  ];
  function wireSun(container) {
    const sun = container.querySelector('.act-sun');
    const spin = container.querySelector('.act-spin');
    const egg = container.querySelector('.act-egg');
    if (!sun) return;
    // Drop each one-shot class when its animation ends, so it doesn't persist and replay
    // when the hidden orrery is shown again (Journal ⇄ Constellation switch re-displays it).
    if (spin) spin.addEventListener('animationend', () => spin.classList.remove('spinning'));
    sun.addEventListener('animationend', () => sun.classList.remove('pop'));
    if (egg) egg.addEventListener('animationend', () => egg.classList.remove('show'));
    let n = 0;
    sun.addEventListener('click', () => {
      n += 1;
      if (spin) { spin.classList.remove('spinning'); void spin.getBBox(); spin.classList.add('spinning'); }
      sun.classList.remove('pop'); void sun.getBBox(); sun.classList.add('pop');
      if (n % 5 === 0 && egg) {
        egg.textContent = EGG_LINES[(n / 5 - 1) % EGG_LINES.length];
        egg.classList.remove('show'); void egg.offsetWidth; egg.classList.add('show');
      }
    });
  }

  // ── Card shell + view switch ──────────────────────────────────────────
  const segClass = (active) =>
    'activity-seg px-3 py-1 text-xs font-medium ' + (active ? 'is-active bg-accent text-white' : 'text-ink-300');
  // A checkbox-style filter (small box + label), not a button, reads as "filter the feed".
  const aiFilterHtml = () =>
    `<button type="button" data-ai-filter class="flex items-center gap-1.5 text-xs transition ${_aiOnly ? 'text-accent' : 'text-ink-400 hover:text-ink-200'}" title="${t('actAiOnly')}">` +
    `<span style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:4px;font-size:10px;color:#fff;border:1.5px solid ${_aiOnly ? '#1d9bd1' : '#5e6066'};background:${_aiOnly ? '#1d9bd1' : 'transparent'}">${_aiOnly ? '✓' : ''}</span>` +
    `${t('actAiOnly')}</button>`;

  // 13b: factual digest over the last 7 days (deterministic, derived from the events;
  // the narrative side is the AI via the existing `activity` MCP tool, on demand).
  function computeDigest(items) {
    const WIN = 7 * 24 * 60; // minutes in 7 days
    const docs = new Set(), authors = new Set();
    let created = 0, checked = 0, ai = 0;
    for (const i of items) {
      if (i.agoMin > WIN) continue;
      if (i.path) docs.add(i.path);
      if (i.who) authors.add(i.who);
      if (i.type === 'create') created += 1;
      if (i.type === 'check' && /^checked/i.test(i.subject || '')) checked += 1;
      if (i.ai) ai += 1;
    }
    return { docs: docs.size, created, checked, contributors: authors.size, ai };
  }

  function digestHtml() {
    const d = _digest;
    if (!d) return '';
    const ic = (path, color) =>
      `<svg width="13" height="13" fill="none" stroke="${color}" stroke-width="1.9" viewBox="0 0 24 24" style="flex-shrink:0"><path stroke-linecap="round" stroke-linejoin="round" d="${path}"/></svg>`;
    const pill = (icon, n, label) =>
      `<span class="act-legend-chip">${icon}<span class="text-ink-100 font-semibold">${n}</span> ${label}</span>`;
    const parts = [];
    if (d.docs) parts.push(pill(ic('M9 12h6m-6 4h6m2 4H7a2 2 0 01-2-2V5a2 2 0 012-2h7l5 5v11a2 2 0 01-2 2z', '#5e6066'), d.docs, t('digestDocs', d.docs)));
    if (d.created) parts.push(pill(ic('M12 4v16m8-8H4', TY('create').color), d.created, t('digestCreated', d.created)));
    if (d.checked) parts.push(pill(ic('M5 13l4 4L19 7', TY('check').color), d.checked, t('digestChecked', d.checked)));
    if (d.contributors) parts.push(pill(ic('M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-1.13a4 4 0 10-4-4 4 4 0 004 4z', '#5e6066'), d.contributors, t('digestContributors', d.contributors)));
    if (d.ai) parts.push(pill(ic('M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9l4.2-1.4z', '#e8941c'), d.ai, t('digestViaAi', d.ai)));
    if (!parts.length) return '';
    const hr = '<hr style="border:none;border-top:1px solid #2a2a32;margin:0">';
    return (
      `<div style="position:relative;margin-bottom:12px">
        ${hr}
        <div style="display:flex;flex-wrap:wrap;justify-content:center;gap:6px;margin:10px 0 9px">${parts.join('')}</div>
        ${hr}
        <span class="act-digest-when text-ink-500" style="position:absolute;right:0;bottom:5px;font-size:10px;text-transform:uppercase;letter-spacing:.06em;pointer-events:none">${t('digestWeek')}</span>
      </div>`
    );
  }

  // 13c: Santé, obsolescence (déterministe serveur) + candidats de contradiction (pré-filtre
  // serveur ; l'IA juge via MCP). Les clics sur un doc rouvrent son historique.
  async function loadHealth(h) {
    let stale = [], cands = [];
    if (IS_OFFLINE_BUILD) {
      // Offline: from the embedded snapshot (same shape as /api/stale and the
      // /api/contradictions candidates), no network.
      stale = (EMBED_ACTIVITY && EMBED_ACTIVITY.stale) || [];
      cands = (EMBED_ACTIVITY && EMBED_ACTIVITY.contradictions) || [];
    } else {
      try {
        const [rs, rc] = await Promise.all([
          fetch('/api/stale?months=6&limit=40'),
          fetch('/api/contradictions?limit=50'),
        ]);
        if (rs.ok) stale = (await rs.json()).stale || [];
        if (rc.ok) cands = (await rc.json()).candidates || [];
      } catch (_) {}
    }
    _health = { stale, cands };
    h.innerHTML = healthHtml();
  }

  function healthHtml() {
    const tab = (active, v, label) =>
      `<button type="button" data-htab="${v}" class="px-3 py-1.5 text-xs font-medium transition ${active ? 'text-accent' : 'text-ink-400 hover:text-ink-200'}" style="border-bottom:2px solid ${active ? '#1d9bd1' : 'transparent'};margin-bottom:-1px">${label}</button>`;
    const toggle =
      `<div class="flex mb-3" style="border-bottom:1px solid #2a2a32">`
      + tab(_healthTab === 'stale', 'stale', t('healthTabStale'))
      + tab(_healthTab === 'cont', 'cont', t('healthTabCont'))
      + `</div>`;
    // Keep the sub-toggle stable; only the body swaps skeleton → content on fetch.
    const body = !_health ? skelRows(3) : (_healthTab === 'stale' ? staleHtml() : contHtml());
    return toggle + body;
  }

  function staleHtml() {
    const stale = _health.stale;
    if (!stale.length) return `<div class="text-ink-500 text-sm py-1">${t('healthNoStale')}</div>`;
    const shown = _healthExpanded ? stale : stale.slice(0, 8);
    let out = shown.map((s) =>
      `<div class="act-row" data-path="${esc(s.path)}" data-tip="${esc(t('healthOpenHist'))}"><div class="flex items-center justify-between gap-3">`
      + `<div class="min-w-0"><div class="text-sm text-ink-200 truncate">${esc(docTitle(s.path))}</div>`
      + `<div class="text-xs text-ink-500 truncate">${esc(s.path)}</div></div>`
      + `<div class="shrink-0 text-xs text-ink-500">${t('healthMonthsAgo', Math.round(s.months_ago))}</div></div></div>`).join('');
    if (stale.length > 8) {
      out += `<div class="text-right mt-1"><a class="act-hsee text-sm text-accent hover:underline cursor-pointer">${_healthExpanded ? t('actCollapse') : t('actSeeAllN', stale.length)}</a></div>`;
    }
    return out;
  }

  function contHtml() {
    const cands = _health.cands;
    if (!cands.length) return `<div class="text-ink-500 text-sm py-1">${t('healthNoCand')}</div>`;
    const shown = _candExpanded ? cands : cands.slice(0, 8);
    let out = `<div class="text-xs text-ink-500 mb-2">${t('healthAskAi')}</div>`;
    out += shown.map((c) => {
      // Detector rows carry the conflicting values + their lines; cluster rows show the first
      // "à vérifier" evidence line if any, else the shared subject.
      const meta = c.kind === 'cluster'
        ? esc((c.evidence && c.evidence.length && c.evidence[0].text) || c.subject || '')
        : t('healthValueConflict', esc(c.subject || ''), esc(c.a_value || ''), esc(c.b_value || ''));
      const confPill = c.confidence === 'high'
        ? `<span class="shrink-0 text-xs px-1.5 py-0.5 rounded" style="background:#1d3a5b;color:#9ecbff" data-tip="${esc(t('healthConfHighHint'))}">${t('healthConfHigh')}</span>`
        : `<span class="shrink-0 text-xs px-1.5 py-0.5 rounded" style="background:#2a2a32;color:#9a9aa5" data-tip="${esc(t('healthReviewHint'))}">${t('healthReview')}</span>`;
      return `<div class="py-1.5"><div class="flex items-center gap-2 text-sm">`
        + `<div class="flex items-center gap-2 min-w-0 flex-1">`
        + (c.verdict === 'real' ? `<span class="shrink-0 text-xs px-1.5 py-0.5 rounded" style="background:#5b1d1d;color:#ffb4b4">${t('healthReal')}</span>` : confPill)
        + `<span class="text-ink-200 hover:text-accent cursor-pointer truncate" data-path="${esc(c.a)}">${esc(docTitle(c.a))}</span>`
        + `<span class="text-ink-500 shrink-0">⇄</span>`
        + `<span class="text-ink-200 hover:text-accent cursor-pointer truncate" data-path="${esc(c.b)}">${esc(docTitle(c.b))}</span></div>`
        + `<button type="button" class="act-cdismiss shrink-0 inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-lg border subtle-border bg-navy-600 hover:bg-navy-500 text-ink-300 hover:text-ink-100 transition" data-a="${esc(c.a)}" data-b="${esc(c.b)}" data-aline="${c.a_line || ''}" data-bline="${c.b_line || ''}" data-tip="${esc(t('healthDismissHint'))}">✓ ${t('healthDismiss')}</button></div>`
        + (meta ? `<div class="text-xs text-ink-500 mt-0.5 truncate">${meta}</div>` : '') + '</div>';
    }).join('');
    if (cands.length > 8) out += `<div class="text-right mt-1"><a class="act-csee text-sm text-accent hover:underline cursor-pointer">${_candExpanded ? t('actCollapse') : t('actSeeAllN', cands.length)}</a></div>`;
    return out;
  }

  function skelRow() {
    return '<div class="flex items-center gap-3 py-2">'
      + '<div class="act-skel" style="width:30px;height:30px;border-radius:8px"></div>'
      + '<div class="flex-1"><div class="act-skel" style="width:42%;height:10px"></div>'
      + '<div class="act-skel" style="width:26%;height:8px;margin-top:6px"></div></div>'
      + '<div class="act-skel" style="width:38px;height:8px"></div></div>';
  }
  function skelRows(n) {
    let s = '';
    for (let i = 0; i < n; i++) s += skelRow();
    return s;
  }
  function skeletonHtml() {
    return '<div class="border subtle-border rounded-lg p-4 bg-black/15">'
      + '<div class="flex items-center justify-between mb-4">'
      + '<div class="act-skel" style="width:90px;height:18px"></div>'
      + '<div class="act-skel" style="width:150px;height:26px;border-radius:8px"></div></div>'
      + skelRows(4) + '</div>';
  }

  function cardHtml() {
    return (
      `<div id="home-activity-card" class="border subtle-border rounded-lg p-4 bg-black/15">
        <div class="act-card-head flex items-center justify-between gap-3 mb-3">
          <h2 class="!mb-0 !mt-0">${t('actTitle')}</h2>
          <div class="act-card-controls flex items-center gap-2 shrink-0">
            ${aiFilterHtml()}
            <div class="act-seg-group inline-flex rounded-lg border subtle-border overflow-hidden">
              <button type="button" data-view="journal" class="${segClass(true)}">${t('actJournal')}</button>
              <button type="button" data-view="orrery" class="${segClass(false)}">${t('actConstellation')}</button>
              <button type="button" data-view="health" class="${segClass(false)}">${t('actHealth')}</button>
              ${IS_OFFLINE_BUILD ? '' : `<button type="button" data-view="inbox" class="${segClass(false)}">${t('actInbox')} <span id="inbox-badge" class="act-ibadge hidden"></span></button>`}
            </div>
          </div>
        </div>
        <div id="activity-digest">${digestHtml()}</div>
        <div id="activity-journal">${journalHtml()}</div>
        <div id="activity-orrery" class="hidden"></div>
        <div id="activity-health" class="hidden"></div>
        <div id="activity-inbox" class="hidden"></div>
      </div>`
    );
  }

  function setView(card, v, persist) {
    const j = card.querySelector('#activity-journal');
    const o = card.querySelector('#activity-orrery');
    const h = card.querySelector('#activity-health');
    const ib = card.querySelector('#activity-inbox');
    const dg = card.querySelector('#activity-digest');  // the weekly digest belongs to Journal only
    if (dg) dg.classList.toggle('hidden', v !== 'journal');
    if (v === 'orrery') {
      if (!o.dataset.rendered) { o.innerHTML = orreryHtml(); o.dataset.rendered = '1'; wireOrreryHover(o); wireSun(o); }
      // clear leftover one-shot animation classes so re-showing the tab never replays them
      o.querySelectorAll('.act-spin,.act-sun,.act-egg').forEach((el) => el.classList.remove('spinning', 'pop', 'show'));
    } else if (v === 'health' && !h.dataset.rendered) {
      h.dataset.rendered = '1'; h.innerHTML = healthHtml(); loadHealth(h);
    } else if (v === 'inbox' && ib && !ib.dataset.rendered && window.AtlasInbox) {
      ib.dataset.rendered = '1'; AtlasInbox.mount(ib);  // the Inbox is its own module (22-inbox.js)
    }
    j.classList.toggle('hidden', v !== 'journal');
    o.classList.toggle('hidden', v !== 'orrery');
    h.classList.toggle('hidden', v !== 'health');
    if (ib) ib.classList.toggle('hidden', v !== 'inbox');
    if (window.AtlasInbox) { if (v === 'inbox') AtlasInbox.show(); else AtlasInbox.hide(); }
    card.querySelectorAll('[data-view]').forEach((b) => { b.className = segClass(b.dataset.view === v); });
    if (persist) { try { localStorage.setItem('atlas:activityView', v); } catch (_) {} }
  }

  function wire(card) {
    let saved = 'journal';
    try { saved = localStorage.getItem('atlas:activityView') || 'journal'; } catch (_) {}
    const q = new URLSearchParams(location.search).get('view');
    if (q === 'journal' || q === 'orrery' || q === 'health' || q === 'inbox') saved = q;
    if (saved === 'inbox' && IS_OFFLINE_BUILD) saved = 'journal';  // inbox tab is online-only
    setView(card, saved, false);
    card.querySelectorAll('[data-view]').forEach((b) =>
      b.addEventListener('click', () => setView(card, b.dataset.view, true)));
    card.addEventListener('click', (ev) => {
      const fbtn = ev.target.closest('[data-ai-filter]');
      if (fbtn) {
        _aiOnly = !_aiOnly;
        _expanded = false;
        fbtn.outerHTML = aiFilterHtml();
        card.querySelector('#activity-journal').innerHTML = journalHtml();
        const o = card.querySelector('#activity-orrery');
        if (o.dataset.rendered) { o.innerHTML = orreryHtml(); wireOrreryHover(o); wireSun(o); }
        return;
      }
      if (ev.target.closest('[data-view]')) return;
      if (ev.target.closest('.act-seeall')) {
        _expanded = !_expanded;
        card.querySelector('#activity-journal').innerHTML = journalHtml();
        return;
      }
      if (ev.target.closest('.act-hsee')) {
        _healthExpanded = !_healthExpanded;
        card.querySelector('#activity-health').innerHTML = healthHtml();
        return;
      }
      if (ev.target.closest('.act-csee')) {
        _candExpanded = !_candExpanded;
        card.querySelector('#activity-health').innerHTML = healthHtml();
        return;
      }
      const ht = ev.target.closest('[data-htab]');
      if (ht) {
        _healthTab = ht.dataset.htab;
        try { localStorage.setItem('atlas:healthTab', _healthTab); } catch (_) {}
        card.querySelector('#activity-health').innerHTML = healthHtml();
        return;
      }
      const cd = ev.target.closest('.act-cdismiss');
      if (cd) {
        // Human verdict "pas une contradiction" (13c) → POST none, drop the row. The global
        // fetch wrapper injects the CSRF token. The pair resurfaces only if a doc is edited.
        const { a, b, aline, bline } = cd.dataset;
        cd.disabled = true;
        // Pass the judged line numbers (value collisions carry them) so the verdict is
        // span-bound (F1): it survives edits ELSEWHERE in either doc, not just any edit.
        const body = { a, b, verdict: 'none' };
        if (aline) body.a_line = Number(aline);
        if (bline) body.b_line = Number(bline);
        fetch('/api/contradiction', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).then((r) => {
          if (r.ok) {
            _health.cands = _health.cands.filter((c) => !((c.a === a && c.b === b) || (c.a === b && c.b === a)));
            card.querySelector('#activity-health').innerHTML = healthHtml();
          } else { cd.disabled = false; }
        }).catch(() => { cd.disabled = false; });
        return;
      }
      const row = ev.target.closest('[data-path]');
      if (row && row.dataset.path) openDocHistory(row.dataset.path);
    });
  }

  // Fill the mount left by showWelcome(). Robust to load order (showWelcome may run at
  // boot before this file defines the renderer, so we also mount on our own load).
  window.mountActivity = async function () {
    const m = document.getElementById('home-activity-mount');
    if (!m) return;
    // Re-fetch on every mount: the feed must reflect edits made since the home was
    // last shown (e.g. a task toggle), no caching, or it stays stale until reload.
    _expanded = false;
    // Don't leave the card slot blank while /api/activity fetches: cached card
    // instantly on re-visit, a skeleton on the very first load.
    if (_items && _items.length) { m.innerHTML = cardHtml(); wire(m.querySelector('#home-activity-card')); }
    else if (_items === null) m.innerHTML = skeletonHtml();
    const raw = await load();
    _items = raw ? aggregate(raw) : raw;
    _digest = raw ? computeDigest(raw) : null;
    if (!_items || !_items.length) { m.innerHTML = ''; return; }  // offline / nothing → no card
    m.innerHTML = cardHtml();
    wire(m.querySelector('#home-activity-card'));
    if (!IS_OFFLINE_BUILD && window.AtlasInbox) AtlasInbox.refreshBadge();  // light count without opening the tab
  };

  // Live-reload refresh that does NOT re-mount the card: softReload() calls this so only the active
  // tab updates in place. Dormant tabs and the self-managing Inbox are left untouched.
  window.refreshActivityData = async function () {
    const card = document.getElementById('home-activity-card');
    if (!card) return;
    const inbox = card.querySelector('#activity-inbox');
    if (inbox && !inbox.classList.contains('hidden')) return;  // Inbox active: it manages itself
    if (!IS_OFFLINE_BUILD && window.AtlasInbox) AtlasInbox.refreshBadge();  // keep the home badge live
    const raw = await load();
    if (!raw) return;
    _items = aggregate(raw);
    _digest = computeDigest(raw);
    const journal = card.querySelector('#activity-journal');
    if (journal && !journal.classList.contains('hidden')) {
      journal.innerHTML = journalHtml();
      const dg = card.querySelector('#activity-digest');
      if (dg && !dg.classList.contains('hidden')) dg.innerHTML = digestHtml();
      return;
    }
    const orrery = card.querySelector('#activity-orrery');
    if (orrery && !orrery.classList.contains('hidden') && orrery.dataset.rendered) {
      orrery.innerHTML = orreryHtml(); wireOrreryHover(orrery); wireSun(orrery);
    }
  };
  window.mountActivity();

})();

// Inbox triage: the home Activity card's "Inbox" tab, as its own module.
//
// Agents pre-triage upstream and drop ready-to-file items into a per-person inbox lane via the MCP;
// you keep / trash / snooze them here. The Activity card (21-activity.js) owns only the tab button,
// the #inbox-badge and the empty #activity-inbox slot, and calls AtlasInbox.{mount,show,hide}.
// CSS lives in styles/10-inbox.css.
//
// Component-based, not a re-render-the-world blob: the focus card and each queue row are stable DOM
// nodes. The poll only appends rows to the list; the focus card is rebuilt only on a real selection
// change (click a row, Keep/Trash/Snooze, Next). This split is the whole reason an open editor or the
// scroll position survives a live update.
(function () {
  if (typeof escapeHtml !== 'function') return;  // viewer core absent (some headless shells)
  const esc = escapeHtml;

  // ---- state ----
  let _inbox = null;       // [{path,title,preview,source,confidence,suggest_dest,neighbors,...}] | []
  let _total = 0;          // baseline queue length, for the "X / Y traités" progress
  let _filter = null;      // Set of enabled source keys (null = all sources on)
  let _session = { kept: 0, trashed: 0, snoozed: 0 };
  let _overrides = {};     // path -> {dest, tags}: your edits, re-applied across any reload
  let _focusPath = null;   // animate the focus card only when it actually changes
  let _leaving = false;    // an action is mid-flight (swipe-out animation guard)
  let _poll = null;        // live-poll interval while the tab is open
  let _box = null;         // the #activity-inbox container (owned after mount)
  let _keyHandler = null;  // document keydown for K/X/S/J (swapped per mount, no leak)

  // ---- icons (Heroicons v2 outline, the viewer's set) ----
  const _ISRC = {
    gmail: { tint: '#5db5e8', d: 'M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75' },
    sentry: { tint: '#e8941c', d: 'M14.857 17.082a23.85 23.85 0 0 0 5.454-1.31A8.97 8.97 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.97 8.97 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.26 24.26 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0' },
    scraper: { tint: '#5fd0a6', d: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0 0a8.95 8.95 0 0 0 0-18m0 18a8.95 8.95 0 0 1 0-18M3 12h18' },
    webhook: { tint: '#b58be8', d: 'M3.75 13.5 14.25 2.25 12 10.5h8.25L9.75 21.75 12 13.5H3.75Z' },
    slack: { tint: '#e85b8b', d: 'M2.25 12.76c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.184-4.183a1.14 1.14 0 0 1 .778-.332 48.3 48.3 0 0 0 5.83-.498c1.585-.233 2.708-1.626 2.708-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.4 48.4 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z' },
    manual: { tint: '#b0b1b5', d: 'm16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.931-8.931Zm0 0L19.5 7.125' },
  };
  const _IDOC = 'M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z';
  const _ILINK = 'M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244';
  const _ICHECK = 'M4.5 12.75l6 6 9-13.5';
  const _ITRASH = 'M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.1 48.1 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.1 48.1 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.96 51.96 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.67 48.67 0 0 0-7.5 0';
  const _ISNOOZE = 'M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5';
  const _IPENCIL = 'm16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.931-8.931Zm0 0L19.5 7.125';
  const _SKEY = { keep: 'kept', trash: 'trashed', snooze: 'snoozed' };
  const _isvg = (d) =>
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="' + d + '"/></svg>';

  // ---- small helpers ----
  // Relative time (own copy; the activity card's is in a separate scope).
  function rel(min) {
    if (min < 1) return t('relJustNow');
    if (min < 60) return Math.round(min) + ' min';
    const h = Math.round(min / 60);
    if (h < 24) return h + ' h';
    const d = Math.round(min / 1440);
    if (d === 1) return t('relYesterday');
    return t('relDaysAgo', d);
  }
  function srcMeta(src) {
    const s = _ISRC[src];
    return s ? { tint: s.tint, d: s.d } : { tint: '#868a90', d: _IDOC };
  }
  function srcIc(src) {
    const m = srcMeta(src);
    return `<span class="ibx-ic" style="background:${m.tint}22;color:${m.tint}">${_isvg(m.d)}</span>`;
  }
  const tier = (c) => (c >= 0.75 ? 'hi' : c >= 0.4 ? 'md' : 'lo');
  const tierLabel = (c) => (c >= 0.75 ? t('inboxConfHigh') : c >= 0.4 ? t('inboxConfMed') : t('inboxConfLow'));
  const ago = (it) => rel(it.captured_at ? Math.max(0, (Date.now() / 1000 - it.captured_at) / 60) : 0);

  // Destination Keep promotes to: your edited override, else the agent's suggest_dest, else the FOLDER
  // of the top same-subject neighbour. Editable, and the promoted doc inherits the chosen folder's ACL
  // (so filing into a private folder keeps it private).
  function suggestDest(it) {
    if (it._dest != null) return it._dest;
    if (it.suggest_dest) return it.suggest_dest;
    const nb = it.neighbors && it.neighbors[0];
    // The folder of the top neighbour, or '' (root) if it sits at the root: a bare filename is not a
    // destination folder.
    return nb && nb.indexOf('/') >= 0 ? nb.replace(/\/[^/]*$/, '') + '/' : '';
  }
  const tags = (it) => (it._tags != null ? it._tags : (it.suggest_tags || []));
  const storeOverride = (it) => { _overrides[it.path] = { dest: it._dest, tags: it._tags }; };
  // Tags the destination folder auto-derives, so they aren't offered again (the folder IS a tag).
  function folderTags(it) {
    const d = suggestDest(it);
    return d && typeof folderTagsOf === 'function' ? folderTagsOf(d.replace(/\/+$/, '') + '/_.md') : [];
  }
  // Tags as doc-tag chips (the doc view's component), inline in the focus row: folder tags greyed,
  // custom tags removable, a + to add.
  function tagsHtml(it) {
    const fset = new Set(folderTags(it));
    const custom = tags(it).filter((tg) => !fset.has(tg));
    const fchips = [...fset].map((tg) =>
      `<span class="doc-tag doc-tag-folder" title="${esc(t('folderTagTitle'))}">#${esc(tg)}</span>`).join('');
    const cchips = custom.map((tg) =>
      `<span class="doc-tag">#${esc(tg)}<button class="doc-tag-x ibx-rmtag" data-tag="${esc(tg)}" title="${esc(t('removeTag'))}">×</button></span>`).join('');
    return fchips + cchips + `<button type="button" class="doc-tag-add ibx-addtag" title="${esc(t('addTag'))}">+</button>`;
  }
  function queue() {
    if (!_inbox) return [];
    return _filter ? _inbox.filter((i) => _filter.has(i.source)) : _inbox;
  }
  function snoozeDate() {
    const d = new Date();
    d.setDate(d.getDate() + 3);
    return d.toISOString().slice(0, 10);
  }
  const editing = () => !!(_box && _box.querySelector('.ibx-destedit, .ibx-tagedit-input'));
  function updateBadge() {
    const b = document.getElementById('inbox-badge');
    if (b) { const n = queue().length; b.textContent = n; b.classList.toggle('hidden', !n); }
  }

  // ---- component HTML ----
  function focusHtml(it) {
    const tr = tier(it.confidence);
    const sd = suggestDest(it);
    const nb = it.neighbors && it.neighbors[0];
    const sig = nb
      ? `<div class="ibx-signal"><span class="sic">${_isvg(_ILINK)}</span><div><b>`
        + `${t('inboxSameSubject')}</b> `
        + `<span class="doc">${esc(nb)}</span></div></div>` : '';
    const destChip = sd
      ? `<span class="ibx-destchip editable" data-act="editdest">${_isvg(_IDOC)}${esc(sd)}${_isvg(_IPENCIL)}</span>`
      : `<span class="ibx-destchip editable empty" data-act="editdest">${t('inboxChooseFolder')}${_isvg(_IPENCIL)}</span>`;
    const dest = `<span class="ibx-lbl">${t('inboxFileUnder')}</span>${destChip}`;
    const animate = it.path !== _focusPath;  // only a NEW focus pops in
    _focusPath = it.path;
    return `<div class="ibx-focus${animate ? ' ibx-entering' : ''}" id="ibx-focus">`
      + `<div class="ibx-frow"><span class="ibx-src">${srcIc(it.source)}${esc(it.source)}</span>`
      + `<span class="ibx-pill ${tr}" title="${Math.round(it.confidence * 100)}%">${tierLabel(it.confidence)}</span>`
      + `<span class="ibx-spacer"></span><span class="ibx-ago">${ago(it)}</span></div>`
      + `<div class="ibx-title">${esc(it.title)}</div>`
      + (it.preview ? `<p class="ibx-body">${esc(it.preview)}</p>` : '')
      + sig
      + `<div class="ibx-dest">${dest}<span class="ibx-lbl">tags</span>`
      + `<span class="ibx-tags">${tagsHtml(it)}</span></div>`
      + `<div class="ibx-actions">`
      + `<button type="button" class="ibx-btn keep${sd ? '' : ' disabled'}" data-act="keep"${sd ? '' : ' disabled title="' + t('inboxPickFolderFirst') + '"'}>${_isvg(_ICHECK)}${t('inboxKeep')} <span class="k">K</span></button>`
      + `<button type="button" class="ibx-btn trash" data-act="trash">${_isvg(_ITRASH)}${t('inboxTrash')} <span class="k">X</span></button>`
      + `<button type="button" class="ibx-btn snooze" data-act="snooze">${_isvg(_ISNOOZE)}${t('inboxSnooze')} <span class="k">S</span></button>`
      + `<span class="ibx-spacer"></span><button type="button" class="ibx-btn ghost" data-act="next">${t('inboxNext')} <span class="k">J</span></button>`
      + `</div></div>`;
  }
  function qRowHtml(it) {
    return `<div class="ibx-qrow" data-ipath="${esc(it.path)}">${srcIc(it.source)}`
      + `<span class="ibx-qt">${esc(it.title)}</span>`
      + `<span class="ibx-mini ${tier(it.confidence)}" title="${tierLabel(it.confidence)}"></span>`
      + `<span class="ibx-qa">${ago(it)}</span></div>`;
  }
  function chipsHtml() {
    const srcs = [];
    _inbox.forEach((i) => { if (srcs.indexOf(i.source) < 0) srcs.push(i.source); });
    let c = '<div class="ibx-chips">';
    srcs.forEach((s) => {
      const on = !_filter || _filter.has(s);
      const m = srcMeta(s);
      c += `<button type="button" class="ibx-chip ${on ? 'on' : ''}" data-src="${esc(s)}">`
        + `<span class="g" style="color:${m.tint}">${_isvg(m.d)}</span>${esc(s)}</button>`;
    });
    return c + '</div>';
  }
  function subInner() {
    const done = Math.max(0, _total - _inbox.length);
    const pct = _total ? Math.round(done / _total * 100) : 0;
    return `<div class="ibx-progress"><b id="ibx-done">${done}</b> / <span id="ibx-total">${_total}</span> ${t('inboxDone')}`
      + `<span class="track"><span class="fill" id="ibx-fill" style="width:${pct}%"></span></span></div>`
      + `<div id="ibx-chips-wrap">${chipsHtml()}</div>`;
  }
  function zeroHtml() {
    const s = _session;
    const total = s.kept + s.trashed + s.snoozed;
    const dp = (d, n, l, col) => `<span class="ibx-dpill"><span style="color:${col}">${_isvg(d)}</span><b>${n}</b> ${l}</span>`;
    return `<div class="ibx-zero"><div class="ibx-mark">${_isvg(_ICHECK)}</div>`
      + `<h3>${t('inboxZeroTitle')}</h3>`
      + `<p>${t('inboxZeroSub')}</p>`
      + (total ? `<div class="ibx-digest">`
        + dp(_ICHECK, s.kept, t('inboxKept'), '#5fd0a6')
        + dp(_ITRASH, s.trashed, t('inboxTrashed'), '#868a90')
        + dp(_ISNOOZE, s.snoozed, t('inboxSnoozed'), '#e8941c')
        + `</div>` : '')
      + `</div>`;
  }
  function skelHtml() {
    let s = '';
    for (let i = 0; i < 3; i++) {
      s += '<div class="ibx-skelrow"><div class="ibx-skel" style="width:30px;height:30px;border-radius:8px"></div>'
        + '<div style="flex:1"><div class="ibx-skel" style="width:42%;height:10px"></div>'
        + '<div class="ibx-skel" style="width:26%;height:8px;margin-top:6px"></div></div></div>';
    }
    return s;
  }

  // ---- DOM ops: the focus card and the list are separate, independently-updated nodes ----
  function renderShell() {
    if (!_box) return;
    if (!_inbox) { _box.innerHTML = skelHtml(); return; }
    const q = queue();
    if (!q.length) { _box.innerHTML = zeroHtml(); updateBadge(); return; }
    _box.innerHTML =
      `<div class="ibx-sub" id="ibx-sub">${subInner()}</div>`
      + focusHtml(q[0])
      + `<div id="ibx-next"><div class="ibx-next-h" id="ibx-next-h"></div><div id="ibx-next-rows"></div></div>`;
    renderList();
    updateBadge();
  }
  // Selection changed: rebuild the focus card + the list. Never called by the poll.
  function renderFocusAndList() {
    if (!_box) return;
    const q = queue();
    if (!q.length || !_box.querySelector('#ibx-sub')) { renderShell(); return; }  // -> zero, or was zero
    const fc = _box.querySelector('#ibx-focus');
    if (!fc) { renderShell(); return; }
    fc.outerHTML = focusHtml(q[0]);
    renderList();
    updateProgress();
    renderChips();
    updateBadge();
  }
  // The focus card alone (a dest/tag edit changes only it, not the list).
  function renderFocus() {
    if (!_box) return;
    const q = queue();
    if (!q.length || !_box.querySelector('#ibx-sub')) { renderShell(); return; }
    const fc = _box.querySelector('#ibx-focus');
    if (fc) fc.outerHTML = focusHtml(q[0]); else renderShell();
  }
  function renderList() {
    const rows = _box && _box.querySelector('#ibx-next-rows');
    if (!rows) return;
    const up = queue().slice(1);
    rows.innerHTML = up.map(qRowHtml).join('');
    setNextHeader(up.length);
  }
  function setNextHeader(n) {
    const h = _box && _box.querySelector('#ibx-next-h');
    if (!h) return;
    h.textContent = n > 0 ? t('inboxUpNext') + ' · ' + n : '';
    h.style.display = n > 0 ? '' : 'none';
  }
  // The poll's ONLY structural change: append one new queue row. Surgical: leaves the focus card and
  // every existing row untouched.
  function addRow(it) {
    const rows = _box && _box.querySelector('#ibx-next-rows');
    if (!rows) return;
    if (_filter && !_filter.has(it.source)) return;  // filtered out: counted, not shown
    rows.insertAdjacentHTML('beforeend', qRowHtml(it));
    setNextHeader(rows.children.length);
  }
  function updateProgress() {
    if (!_box) return;
    const done = Math.max(0, _total - _inbox.length);
    const d = _box.querySelector('#ibx-done'); if (d) d.textContent = done;
    const tt = _box.querySelector('#ibx-total'); if (tt) tt.textContent = _total;
    const f = _box.querySelector('#ibx-fill'); if (f) f.style.width = (_total ? Math.round(done / _total * 100) : 0) + '%';
  }
  function renderChips() {
    const w = _box && _box.querySelector('#ibx-chips-wrap');
    if (w) w.innerHTML = chipsHtml();
  }
  function toast(n) {
    if (!_box) return;
    let el = _box.querySelector('#ibx-toast');
    if (!el) { el = document.createElement('div'); el.id = 'ibx-toast'; el.className = 'ibx-toast'; _box.appendChild(el); }
    el.textContent = t('inboxNew', n);
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 3200);
  }

  // ---- data + live poll ----
  async function load(force) {
    // A re-mount (e.g. an SSE soft-reload after a Keep enters the corpus) must NOT re-fetch and
    // re-sort: that would yank the focus card away to the highest-confidence item. Reuse the loaded
    // state (order, focus, edits); the poll brings new items into the list.
    if (_inbox && !force) { renderShell(); return; }
    let inbox = [];
    try {
      const r = await fetch('/api/inbox?limit=200');
      if (r.ok) inbox = (await r.json()).inbox || [];
    } catch (_) {}
    inbox.forEach((it) => {
      const o = _overrides[it.path];
      if (o) { if (o.dest != null) it._dest = o.dest; if (o.tags != null) it._tags = o.tags; }
    });
    _inbox = inbox;
    _total = inbox.length;
    _session = { kept: 0, trashed: 0, snoozed: 0 };
    _filter = null;
    renderShell();
  }
  // Detect new items and grow ONLY the list; the focus card is never re-rendered here, so an open
  // editor or the scroll position is never disturbed.
  function poll() {
    if (!_box || _box.classList.contains('hidden') || !_inbox) return;
    fetch('/api/inbox?limit=200').then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (!d) return;
      const have = new Set(_inbox.map((i) => i.path));
      const fresh = (d.inbox || []).filter((i) => !have.has(i.path));
      if (!fresh.length) return;
      fresh.forEach((it) => {
        const o = _overrides[it.path];
        if (o) { if (o.dest != null) it._dest = o.dest; if (o.tags != null) it._tags = o.tags; }
      });
      _inbox = _inbox.concat(fresh);  // to the BACK: the focus item never moves
      _total += fresh.length;
      if (!_box.querySelector('#ibx-focus')) { renderShell(); return; }  // was empty/zero -> first card
      // UP NEXT is BELOW the focus card, so appending rows never shifts it. The progress bar + chips
      // are ABOVE it: refreshing them mid-edit would slide the input and detach the combobox popup, so
      // while an edit is open they are left alone and recomputed on commit (editEnd).
      fresh.forEach(addRow);
      updateBadge();  // in the card header, never shifts the inbox body
      if (!editing()) {
        updateProgress();
        renderChips();
        toast(fresh.length);
      }
    }).catch(() => {});
  }
  function startPoll() { stopPoll(); poll(); _poll = setInterval(poll, 5000); }
  function stopPoll() { if (_poll) { clearInterval(_poll); _poll = null; } }

  // ---- actions ----
  function act(kind) {
    const q = queue();
    if (!q.length || _leaving) return;
    const it = q[0];
    if (kind === 'next') {  // rotate the focus item to the back of the queue
      _inbox = _inbox.filter((x) => x.path !== it.path).concat([it]);
      renderFocusAndList();
      return;
    }
    if (kind === 'keep' && !suggestDest(it)) return;  // no destination -> Keep is inert
    const body = { action: kind, path: it.path };
    if (kind === 'keep') {
      body.dest = suggestDest(it);
      const fset = new Set(folderTags(it));  // folder auto-tags at build; don't write them twice
      body.tags = tags(it).filter((tg) => !fset.has(tg));
    }
    if (kind === 'snooze') body.until = snoozeDate();
    _leaving = true;
    const fc = _box.querySelector('#ibx-focus');
    if (fc) fc.classList.add('ibx-leaving');
    fetch('/api/inbox/action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => {
      // Hold _leaving up for the WHOLE swipe-out: the next item is already at queue()[0] but not yet
      // rendered, so releasing the guard now would let a second K/X/S act on it blind (Keep = file a
      // doc unseen). Release only after the card has actually rendered.
      if (r.ok) {
        _inbox = _inbox.filter((x) => x.path !== it.path);  // optimistic drop
        delete _overrides[it.path];
        if (_SKEY[kind]) _session[_SKEY[kind]]++;
        setTimeout(() => { renderFocusAndList(); _leaving = false; }, fc ? 180 : 0);
      } else { _leaving = false; if (fc) fc.classList.remove('ibx-leaving'); }
    }).catch(() => { _leaving = false; if (fc) fc.classList.remove('ibx-leaving'); });
  }
  function select(path) {
    const it = _inbox.find((x) => x.path === path);
    if (!it) return;
    _inbox = [it].concat(_inbox.filter((x) => x.path !== path));  // promote to the focus slot
    renderFocusAndList();
  }
  function toggleFilter(src) {
    if (!_filter) _filter = new Set(_inbox.map((i) => i.source));
    if (_filter.has(src) && _filter.size > 1) _filter.delete(src); else _filter.add(src);
    renderFocusAndList();
  }

  // After an inline edit ends (commit or cancel): re-render the focus card AND recompute progress +
  // chips, which the poll left stale while the editor was open (it can't touch the area above the
  // input without shifting it).
  function editEnd() { renderFocus(); updateProgress(); renderChips(); }

  // ---- inline editors (folder combobox, tag field) ----
  function openDestEditor() {
    const it = queue()[0];
    const wrap = _box.querySelector('#ibx-focus .ibx-dest');
    if (!it || !wrap) return;
    wrap.innerHTML = `<span class="ibx-lbl">${t('inboxFileUnder')}</span>`
      + `<input class="ibx-destedit" value="${esc(suggestDest(it))}" autocomplete="off" `
      + `placeholder="${t('inboxPickOrType')}" />`;
    const inp = wrap.querySelector('input');
    let cb = null;  // the combobox appends a popup to <body> + exposes destroy(): tear it down, or it leaks
    const close = () => { if (cb) { cb.destroy(); cb = null; } editEnd(); };
    const commit = (v) => { it._dest = (v != null ? v : inp.value).trim(); storeOverride(it); close(); };
    if (window.AtlasCombobox && typeof getAllDirs === 'function') {
      cb = AtlasCombobox(inp, { source: getAllDirs, creatable: true, onSelect: (v) => commit(v) });
    }
    inp.focus(); inp.select();
    inp.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } });
    inp.addEventListener('blur', () => setTimeout(() => { if (_box.querySelector('.ibx-destedit')) commit(); }, 180));
  }
  function openTagAdd(addBtn) {
    const it = queue()[0];
    if (!it) return;
    const inp = document.createElement('input');
    inp.className = 'ibx-tagedit-input'; inp.autocomplete = 'off';
    inp.placeholder = t('inboxNewTag');
    addBtn.replaceWith(inp);
    inp.focus();
    const commit = () => {  // Enter OR clicking away both add the typed tag (like the folder field)
      const tg = inp.value.trim().replace(/^#/, '');
      const cur = tags(it);
      it._tags = tg && cur.indexOf(tg) < 0 ? cur.concat([tg]) : cur.slice();
      storeOverride(it);
      editEnd();
    };
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); editEnd(); }  // only Escape cancels
    });
    inp.addEventListener('blur', () => setTimeout(() => { if (_box.querySelector('.ibx-tagedit-input')) commit(); }, 150));
  }

  // ---- events (delegated, on the owned container + document for the shortcuts) ----
  function onClick(ev) {
    if (ev.target.closest('.ibx-destchip')) { openDestEditor(); return; }
    const rm = ev.target.closest('.ibx-rmtag');
    if (rm) { const it = queue()[0]; if (it) { it._tags = tags(it).filter((x) => x !== rm.dataset.tag); storeOverride(it); editEnd(); } return; }
    const add = ev.target.closest('.ibx-addtag');
    if (add) { openTagAdd(add); return; }
    const ibtn = ev.target.closest('.ibx-btn');
    if (ibtn) { act(ibtn.dataset.act); return; }
    const chip = ev.target.closest('.ibx-chip');
    if (chip) { toggleFilter(chip.dataset.src); return; }
    const qrow = ev.target.closest('.ibx-qrow');
    if (qrow && qrow.dataset.ipath) { select(qrow.dataset.ipath); }
  }
  function onKey(ev) {
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
    if (!_box || _box.classList.contains('hidden') || !queue().length) return;
    const k = ev.key.toLowerCase();
    const a = k === 'k' ? 'keep' : k === 'x' ? 'trash' : k === 's' ? 'snooze'
            : (k === 'j' || ev.key === 'ArrowDown') ? 'next' : null;
    if (!a) return;
    ev.preventDefault();
    act(a);
  }

  // ---- public API (called by the Activity card's setView) ----
  window.AtlasInbox = {
    // Mount into a freshly-rendered #activity-inbox slot. Re-called on every card re-mount with a NEW
    // container, so the click listener is attached fresh; the document keydown is swapped (no leak).
    mount(container) {
      _box = container;
      container.addEventListener('click', onClick);
      if (_keyHandler) document.removeEventListener('keydown', _keyHandler);
      _keyHandler = onKey;
      document.addEventListener('keydown', _keyHandler);
      load(false);
    },
    show() { startPoll(); },   // tab activated
    hide() { stopPoll(); },    // tab left
    // Keep the header count live without opening the tab (the point of the feature: signal staged
    // items). If the tab is on screen the poll owns the badge, so skip (don't refetch and clobber the
    // open queue). Seeds _inbox so a later open is instant. No-op offline (the fetch just fails).
    async refreshBadge() {
      const live = document.querySelector('#activity-inbox');
      if (live && !live.classList.contains('hidden')) return;
      try {
        const r = await fetch('/api/inbox?limit=200');
        if (!r.ok) return;
        const fresh = (await r.json()).inbox || [];
        fresh.forEach((it) => {
          const o = _overrides[it.path];
          if (o) { if (o.dest != null) it._dest = o.dest; if (o.tags != null) it._tags = o.tags; }
        });
        _inbox = fresh; _total = fresh.length;
        updateBadge();
      } catch (_) {}
    },
  };
})();

if (isServerMode) {
  // Boot skeleton: in server mode the sidebar tree + content render only AFTER /api/me +
  // /api/tree (the baked tree is the owner's full view, never shown, privacy). Until
  // then, show a shimmer skeleton instead of a flash of empty menu/home. softReload()
  // (called once /api/tree lands) replaces it with the real tree + route.
  treeEl.innerHTML = Array.from({ length: 7 }, (_, i) =>
    `<div class="skeleton" style="height:1rem;margin:.55rem .5rem;width:${55 + ((i * 17) % 40)}%"></div>`).join('');
  contentEl.innerHTML =
    '<div class="not-prose" style="max-width:46rem;margin:0 auto;padding-top:2.5rem">' +
    '<div class="skeleton-title" style="height:2.2rem;width:55%;margin-bottom:1.6rem"></div>' +
    Array.from({ length: 6 }, (_, i) =>
      `<div class="skeleton" style="height:.9rem;margin:.7rem 0;width:${70 + ((i * 13) % 26)}%"></div>`).join('') +
    '</div>';

  fetch('/api/me')
    .then((r) => r.json())
    .then((data) => {
      meState = data;

      // Authoritative CSRF token for all mutating requests (cf. fetch wrapper).
      if (data.csrf_token) setCsrfToken(data.csrf_token);

      if (typeof data.totp_enabled === 'boolean') totpEnabled = data.totp_enabled;

      if (data.cloud && data.authenticated && data.email) {
        const bar = document.getElementById('user-bar');

        document.getElementById('user-email').textContent = data.name || data.email;
        const avatar = document.getElementById('user-avatar');
        if (avatar) avatar.innerHTML = constellationSvg(avatarSeed(data.first_name, data.last_name, data.email), 30);
        bar.classList.remove('hidden');
      }

      if (data.authenticated && data.role && data.role !== 'admin') {
        // Member (non-admin): keep the viewer-mode class (the CSS hides only the global Todos widget)
        // but NOT the __viewerMode flag, so the write affordances stay; per-doc authorization is
        // enforced server-side (a disallowed action just gets a clean 403/404).
        document.body.classList.add('viewer-mode');
        window.__isMember = true;
      }

      // Settings gear: cloud admins only; account/token management is moot
      // without active auth, and the local simulated admin has no one to manage.
      if (data.cloud && data.authenticated && data.role === 'admin') {
        document.body.classList.add('admin-cloud');
      }

      // Security tab (2FA + sessions): any authenticated cloud account, admin OR viewer.
      if (data.cloud && data.authenticated) {
        document.body.classList.add('cloud-authed');
        refreshSecurityState();
      }

      // Render the per-account FILTERED tree (the baked tree is the full
      // build-time view and is intentionally not shown in server mode).
      softReload();
    })
    .catch((e) => {
      // Don't strand the boot skeleton on a transient /api/me blip: log it and load the tree anyway,
      // so the user gets content instead of a frozen shimmer forever.
      console.warn('boot /api/me failed:', e);
      softReload();
    });

  refresh();
  // Poll the todos widget every 10s. The content/tree live-reload is the SSE below (no fallback poll).
  setInterval(refresh, 10000);

  // Bail conditions for a live-reload: anything the user is mid-action on that a DOM rebuild would
  // clobber. Checked BOTH before the fetch AND again after the await: the SSE 'reload' fires exactly
  // when a doc changed, so an Edit started during the network RTT must still abort the stale reload
  // (the TOCTOU that let showMarkdown overwrite a freshly-opened editor).
  function shouldAbortReload() {
    if (editMode) return true;
    if (document.querySelector('.todo-edit')) return true;
    if (!newFileBackdrop.classList.contains('hidden')) return true;
    if (!qcBackdrop.classList.contains('hidden')) return true;
    if (!shareBackdrop.classList.contains('hidden')) return true;
    if (!dirRenameBackdrop.classList.contains('hidden')) return true;
    // Extension modals ([data-atlas-modal]): same consideration as the native ones.
    if (document.querySelector('[data-atlas-modal]:not(.hidden)')) return true;
    // Echo of an edit we just made ourselves (checkbox toggle): skip to avoid a flash.
    if (currentFile && _selfSaveUntil[currentFile.path] && Date.now() < _selfSaveUntil[currentFile.path]) return true;
    return false;
  }

  // Soft reload: fetch /api/tree and patch the DOM in place instead of location.reload().
  async function softReload() {
    if (shouldAbortReload()) return;

    try {
      const res = await fetch('/api/tree');

      if (!res.ok) throw new Error('HTTP ' + res.status);
      const newTree = await res.json();
      if (shouldAbortReload()) return;  // re-check post-await: the user may have started editing during the RTT

      TREE.children = newTree.children;
      TREE.name = newTree.name;

      for (const k in fileMap) delete fileMap[k];
      mdCount = 0;
      otherCount = 0;
      index(TREE);
      statsEl.textContent = t('statsLine', mdCount, otherCount);
      const openDirs = new Set();

      // Key the open/closed state on the full dir path, not the basename, so two same-named folders
      // under different parents don't share it (opening one would re-open the other after a reload).
      treeEl.querySelectorAll('button[data-dir-path]').forEach((b) => {
        if (b.querySelector('.caret.open')) openDirs.add(b.dataset.dirPath);
      });
      treeEl.innerHTML = '';
      treeEl.appendChild(renderTree(TREE));
      decorateTreeBadges();
      decorateRemoteOrigins();
      treeEl.querySelectorAll('button[data-dir-path]').forEach((b) => {
        if (openDirs.has(b.dataset.dirPath)) {
          b.querySelector('.caret').classList.add('open');
          const ul = b.parentElement.querySelector('ul');

          if (ul) ul.classList.remove('hidden');
        }
      });
      renderRecent();
      // Invalidate the lazy indexes: the content / backlinks may have changed.
      backlinksIndex = null;
      backlinksLoading = null;
      miniSearch = null;
      searchInitPromise = null;

      // If a file is open, re-fetch its content if the mtime changed.
      if (currentFile) {
        const newFile = fileMap[currentFile.path];

        if (!newFile) {
          // The open doc is no longer in the viewer's filtered tree → no access /
          // gone. Show the clean not-found page, not a silent bounce to home.
          showNotFound(currentFile.path);
        } else if (newFile.mtime !== currentFile.mtime) {
          contentCache.delete(newFile.path);
          newFile.content = null;
          const scrollPos = document.querySelector('main').scrollTop;

          await showMarkdown(newFile);
          document.querySelector('main').scrollTop = scrollPos;
        } else {
          currentFile = newFile;
        }
      } else if (document.getElementById('home-activity-mount') && window.refreshActivityData) {
        // Home already on screen: do NOT re-render it. Re-rendering re-mounts the activity card and
        // wipes whatever its active tab is doing (an open inbox folder/tag editor, the inbox poll).
        // The tree above is already patched; refresh only the active activity tab's data in place.
        window.refreshActivityData();
      } else {
        // No doc open and the home isn't up yet (first load), or we're on the not-found page:
        // (re-)route from the URL hash now that fileMap reflects the viewer's accessible docs, so a
        // link to a doc they can't see lands on the clean not-found page instead of bouncing home.
        // Preserve scroll so a live re-render doesn't jump to the top under you.
        const sp = document.querySelector('main').scrollTop;
        routeFromHash();
        document.querySelector('main').scrollTop = sp;
      }
    } catch (e) {
      // A transient /api/tree fetch/parse hiccup must NOT nuke the page: the SSE fires right when the
      // server is busy writing, so a blip here would destroy the very state this soft path protects
      // (an open editor, the inbox focus + poll). Skip this cycle; the next SSE event / reconnect retries.
      console.warn('softReload skipped (transient):', e);
    }
  }

  window.softReload = softReload;

  try {
    const es = new EventSource('/api/events');

    es.addEventListener('message', (e) => {
      if (e.data === 'reload') softReload();
    });
  } catch (e) { console.warn('SSE live-reload unavailable:', e); }

  // Service worker (offline + instant loading PWA, cf. /sw.js). On deploy the new
  // SW takes control → reload ONCE to pick up fresh assets (no manual unregister).
  // Skip the first-ever install, never clobber an open editor (deferred update
  // retried when the tab regains focus).
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    let _swReloading = false,
      _swUpdatePending = false,
      _swReg = null;
    const _hadController = !!navigator.serviceWorker.controller;
    const _reloadForUpdate = () => {
      if (_swReloading || document.getElementById('md-editor')) return; // never interrupt an edit
      _swReloading = true;
      location.reload();
    };

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!_hadController) return; // first install: nothing to refresh
      _swUpdatePending = true;
      _reloadForUpdate();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;

      if (_swUpdatePending)
        _reloadForUpdate(); // retry a deferred update reload
      else if (_swReg) _swReg.update(); // catch a deploy made during a long session
    });
    window.addEventListener('load', () => {
      // updateViaCache:'none' → the SW script is always revalidated against the
      // network, so a new version is detected promptly; reg.update() forces that check.
      navigator.serviceWorker
        .register('/sw.js', { updateViaCache: 'none' })
        .then((reg) => {
          _swReg = reg;
          reg.update();
        })
        .catch((e) => console.warn('SW register failed', e));
    });
  }
} else {
  // file:// mode: no server. Reading still works via EMBED_CONTENT.
  todoList.innerHTML =
    '<li class="px-3 py-4 text-center text-xs text-slate-500">' + t('fileModeTodosHtml') + '</li>';
  todoInput.disabled = true;
  todoForm.querySelector('button').disabled = true;
  setStatus(t('serverRequired'), 'err');
  newFileBtn.classList.add('hidden');
  qcBtn.classList.add('hidden');
}
