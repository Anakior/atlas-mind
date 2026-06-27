// Mutable runtime state shared across the viewer. Split out of the old 01-i18n-state.js.
// Foundation layer: these stay plain top-level `let`s (NOT an IIFE / state object) because
// sibling .js modules reassign them by name (09-editor.js writes currentFile/editMode/
// editTextarea; 05-backlinks-notes.js writes tocHasLinks/tocHasNotes). The conversion to a
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
