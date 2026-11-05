// The URL fragment names the page: #<doc path>, #settings/<section>, nothing for the home. Opening a
// page pushes it, so Back and Forward walk the pages instead of leaving Atlas; home-view.ts routes
// on popstate. A page that only changes its own name (a rename, a move) replaces its entry.

export function docHash(path: string): string {
  return '#' + encodeURIComponent(path);
}

function target(hash: string): string {
  return hash || location.pathname + location.search;
}

export function pushRoute(hash: string): void {
  if (hash !== location.hash) history.pushState(null, '', target(hash));
}

export function replaceRoute(hash: string): void {
  history.replaceState(null, '', target(hash));
}
