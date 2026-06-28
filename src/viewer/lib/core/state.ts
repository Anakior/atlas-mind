// Mutable runtime state shared across the viewer.
// These stay module-level `let`s exposed through explicit setters: ES modules forbid reassigning
// an imported binding, so cross-module writers (editor, backlinks, notes-panel, bootstrap, tree)
// go through setX() while readers import the live binding.
import { IS_OFFLINE_BUILD } from './data-csrf';

// The right panel shows up if it has a table of contents OR links OR notes.
// renderBacklinksFor / renderNotesFor update these flags then call applyToc().
export let tocHasLinks = false;

export function setTocHasLinks(v: boolean): void {
  tocHasLinks = v;
}

export let tocHasNotes = false;

export function setTocHasNotes(v: boolean): void {
  tocHasNotes = v;
}

export let currentFile: FileNode | null = null;

export function setCurrentFile(v: FileNode | null): void {
  currentFile = v;
}

export let editMode = false;

export function setEditMode(v: boolean): void {
  editMode = v;
}

export let editTextarea: HTMLTextAreaElement | null = null;

export function setEditTextarea(v: HTMLTextAreaElement | null): void {
  editTextarea = v;
}

// File counters for the stats line, populated by index() in tree.ts.
export let mdCount = 0;

export function setMdCount(v: number): void {
  mdCount = v;
}

export let otherCount = 0;

export function setOtherCount(v: number): void {
  otherCount = v;
}

// App-mode flags, decided once at load from the URL/build (read across the viewer).
// EMBED_MIND: the landing page iframes this viewer as a chrome-less Mind hero (#mind in the URL).
export const EMBED_MIND = location.hash.replace(/^#/, '') === 'mind';
// A static OFFLINE build (EMBED_CONTENT inlined) is NEVER in server mode, even when hosted over
// http(s) — e.g. the GitHub Pages /demo/. Keying this on the protocol alone made such a build hit
// /api/* endpoints and a service worker that don't exist there → 404s and a home stuck on skeletons.
// Offline = read from the embed.
export const isServerMode = (location.protocol === 'http:' || location.protocol === 'https:') && !IS_OFFLINE_BUILD;
