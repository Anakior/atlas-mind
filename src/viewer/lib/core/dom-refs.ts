// Cached DOM element refs for the viewer chrome. These ids are guaranteed by the static
// viewer markup (partials), so the lookups are asserted non-null — downstream modules
// import and use them without a null guard.
export const treeEl = document.getElementById('tree')!;
export const contentEl = document.getElementById('content')!;
export const breadcrumbPath = document.getElementById('breadcrumb-path')!;
export const breadcrumbDate = document.getElementById('breadcrumb-date')!;
export const breadcrumbActions = document.getElementById('breadcrumb-actions')!;
export const btnEdit = document.getElementById('btn-edit')!;
export const btnSave = document.getElementById('btn-save')!;
export const btnCancel = document.getElementById('btn-cancel')!;
export const searchEl = document.getElementById('search')!;
export const searchResultsEl = document.getElementById('search-results')!;
export const recentSection = document.getElementById('recent-section')!;
export const recentList = document.getElementById('recent-list')!;
export const sharedSection = document.getElementById('shared-section')!;
export const sharedList = document.getElementById('shared-list')!;
export const statsEl = document.getElementById('stats')!;
export const tocPanel = document.getElementById('toc-panel')!;
export const tocList = document.getElementById('toc-list')!;
export const tocLinks = document.getElementById('toc-links')!;
export const tocNotes = document.getElementById('toc-notes')!;
