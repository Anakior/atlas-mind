// Cached DOM element refs for the viewer chrome. Split out of the old 01-i18n-state.js.
// These ids are guaranteed by the static viewer markup (partials), so the lookups are
// asserted non-null — downstream modules use them without a null guard. Foundation layer:
// top-level so the refs are shared globals.
const treeEl = document.getElementById('tree')!;
const contentEl = document.getElementById('content')!;
const breadcrumbPath = document.getElementById('breadcrumb-path')!;
const breadcrumbDate = document.getElementById('breadcrumb-date')!;
const breadcrumbActions = document.getElementById('breadcrumb-actions')!;
const btnEdit = document.getElementById('btn-edit')!;
const btnSave = document.getElementById('btn-save')!;
const btnCancel = document.getElementById('btn-cancel')!;
const searchEl = document.getElementById('search')!;
const searchResultsEl = document.getElementById('search-results')!;
const recentSection = document.getElementById('recent-section')!;
const recentList = document.getElementById('recent-list')!;
const sharedSection = document.getElementById('shared-section')!;
const sharedList = document.getElementById('shared-list')!;
const statsEl = document.getElementById('stats')!;
const tocPanel = document.getElementById('toc-panel')!;
const tocList = document.getElementById('toc-list')!;
const tocLinks = document.getElementById('toc-links')!;
const tocNotes = document.getElementById('toc-notes')!;
