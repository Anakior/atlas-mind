import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

// The goldens drive the ONLINE viewer served by `atlas dev` (cloud sandbox: login,
// SSE, admin, git off). Offline (file://) is a non-SSE local fallback and is out of
// scope here. `atlas dev` rebuilds the bundle on every start, so the goldens always
// run against the current src/web/js sources.
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const PORT = 8799;
const authFile = path.join(__dirname, 'e2e', '.auth', 'state.json');

export default defineConfig({
  testDir: './e2e',
  // One live backend with real timers (the 5s inbox poll, SSE): run serially rather
  // than racing a shared server.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  globalSetup: './e2e/global-setup.ts',
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    storageState: authFile,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `python src/cli.py dev .e2e-mind --port ${PORT}`,
    cwd: repoRoot,
    port: PORT,
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
