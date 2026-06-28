// Viewer globals the goldens drive directly from page.evaluate callbacks. softReload is
// exposed on window at 99-bootstrap.js:172. Declared here so the e2e TS world type-checks
// these calls without per-call casts.
export {};

declare global {
  interface Window {
    softReload(): Promise<void>;
  }
}
