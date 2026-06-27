// Ambient declarations for the SHARED GLOBAL SCOPE during the .js/.ts coexistence.
// transform-concat keeps every module in one scope, so a symbol defined in one file
// is visible in the others without import; tsc needs them declared here.
//
// Discipline: when a module migrates to .ts and defines a symbol with a real type,
// REMOVE its declaration from this file (otherwise "Duplicate identifier"). This file
// shrinks at every phase.

// Raw build-substitution barewords: render.py pastes a JSON literal over each in one
// regex pass. 00-data-csrf.ts reads them (const TREE = __DATA__). `declare` is type-only,
// erased by esbuild, so the bareword survives into the bundle for the Python build to fill.
declare const __DATA__: TreeNode;
declare const __EMBED_CONTENT__: Record<string, string> | null;
declare const __EMBED_BACKLINKS__: any;
declare const __EMBED_NOTES__: any;
declare const __EMBED_TASKS__: any;
declare const __EMBED_ACTIVITY__: any;
declare const __TEMPLATES__: Record<string, string>;
declare const __TAGLINE_JSON__: string;
declare const __SITE_PREFIX_JSON__: string;

// Still owned by un-migrated .js modules (removed as each migrates to .ts).
declare const TODO_CATEGORIES: Array<{ cat: string; label: string }>;
