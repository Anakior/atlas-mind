import { chromium, type FullConfig } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

// Log in once as the seeded dev admin (atlas dev: dev@local / dev) and persist the
// session, so every golden starts already past the cloud login wall — the real
// production shape we want to lock down.
const authFile = path.join(__dirname, '.auth', 'state.json');

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0].use.baseURL!;
  fs.mkdirSync(path.dirname(authFile), { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({ baseURL });
  await page.goto('/login');
  await page.fill('#login-email', 'dev@local');
  await page.fill('#login-password', 'dev');
  await page.click('#login-step-credentials button[type="submit"]');
  // Success leaves /login for the viewer shell; wait for the sidebar tree to exist.
  await page.waitForSelector('#tree', { timeout: 30_000 });
  await page.context().storageState({ path: authFile });
  await browser.close();
}
