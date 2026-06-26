// Ambient declarations for the SHARED GLOBAL SCOPE during the .js/.ts coexistence.
// transform-concat keeps every module in one scope, so a symbol defined in one file
// is visible in the others without import; tsc needs them declared here.
//
// Discipline: when a module migrates to .ts and defines a symbol with a real type,
// REMOVE its declaration from this file (otherwise "Duplicate identifier"). This file
// shrinks at every phase and the `any` placeholders get real types as types.ts grows.

// Constants injected by the Python build (render.py phase 2). Refined in phase 1c.
declare const TREE: any;
declare const EMBED_CONTENT: Record<string, string> | null;
declare const EMBED_BACKLINKS: any;
declare const EMBED_NOTES: any;
declare const EMBED_TASKS: any;
declare const EMBED_ACTIVITY: any;
declare const DOC_TEMPLATES: Record<string, string>;
declare const TAGLINE: string;
declare const SITE_PREFIX: string;
declare const TODO_CATEGORIES: Array<{ cat: string; label: string }>;
