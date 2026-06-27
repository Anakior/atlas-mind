// Mutable runtime state shared across the viewer. Split out of the old 01-i18n-state.js.
// Foundation layer: these stay plain top-level `let`s (NOT an IIFE / state object) because
// sibling .js modules reassign them by name (09-editor.js writes currentFile/editMode/
// editTextarea; 05-backlinks/05b-notes-panel write tocHasLinks/tocHasNotes). The conversion to a
// state object with setters is deferred to the ES-modules phase.

// The right panel shows up if it has a table of contents OR links OR notes.
// renderBacklinksFor / renderNotesFor update these flags then call applyToc().
let tocHasLinks = false;
let tocHasNotes = false;

let currentFile: FileNode | null = null;
let editMode = false;
let editTextarea: HTMLTextAreaElement | null = null;

// File counters for the stats line, populated by index() in 01-tree.ts.
let mdCount = 0,
  otherCount = 0;

// App-mode flags, decided once at load from the URL/build (read across the viewer).
// EMBED_MIND: the landing page iframes this viewer as a chrome-less Mind hero (#mind in the URL).
const EMBED_MIND = location.hash.replace(/^#/, '') === 'mind';
// A static OFFLINE build (EMBED_CONTENT inlined) is NEVER in server mode, even when hosted over
// http(s) — e.g. the GitHub Pages /demo/. Keying this on the protocol alone made such a build hit
// /api/* endpoints and a service worker that don't exist there → 404s and a home stuck on skeletons.
// Offline = read from the embed.
const isServerMode = (location.protocol === 'http:' || location.protocol === 'https:') && !IS_OFFLINE_BUILD;
