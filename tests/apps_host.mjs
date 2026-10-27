// A stand-in MCP Apps host (what Claude Desktop does for a view), driven by tests/test_app_resume.py:
// it loads the view in a sandboxed iframe, answers its handshake, calls the tool on a live Atlas
// and pushes the input then the result to the view, sizes the frame to the height it reports,
// relays its tools/call to the server, records every message it sends, then acts like a user.
// Prints a JSON report.
//
//   node apps_host.mjs <view.html> <mcp url> <args json> <theme> [screenshot.png]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '..', 'src', 'viewer', 'build', 'package.json'));
const { chromium } = require('@playwright/test');

const [viewFile, mcpUrl, argsJson, theme, screenshot] = process.argv.slice(2);
let rpcId = 0;
async function mcp(method, params) {
  const res = await fetch(mcpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  return (await res.json()).result;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 720, height: 900 } });
await page.exposeFunction('callTool', (params) => mcp('tools/call', params));
await page.setContent('<!doctype html><body style="margin:0;background:#888"></body>');
await page.evaluate(({ html, args, theme }) => {
  window.__log = [];
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.style.cssText = 'border:0;width:680px;height:860px;display:block;margin:20px';
  frame.srcdoc = html;
  document.body.appendChild(frame);
  const toView = (message) => frame.contentWindow.postMessage({ jsonrpc: '2.0', ...message }, '*');
  window.addEventListener('message', async (event) => {
    if (event.source !== frame.contentWindow) return;
    const m = event.data;
    window.__log.push(m);
    if (m.method === 'ui/initialize') {
      toView({ id: m.id, result: { protocolVersion: '2026-01-26', hostInfo: { name: 'test-host', version: '0' },
        hostCapabilities: { serverTools: {} }, hostContext: { theme, locale: 'en' } } });
    } else if (m.method === 'ui/notifications/initialized') {
      toView({ method: 'ui/notifications/tool-input', params: { arguments: args } });
      toView({ method: 'ui/notifications/tool-result', params: await window.callTool({ name: 'resume_session', arguments: args }) });
    } else if (m.method === 'ui/notifications/size-changed') {
      frame.style.height = `${m.params.height}px`;
    } else if (m.method === 'tools/call') {
      toView({ id: m.id, result: await window.callTool(m.params) });
    } else if (m.id != null) {
      toView({ id: m.id, result: {} });
    }
  });
}, { html: fs.readFileSync(viewFile, 'utf8'), args: JSON.parse(argsJson), theme });

const view = page.frameLocator('iframe');
await view.locator('h1, .save').first().waitFor();
const report = { title: await view.locator('h1').count() ? await view.locator('h1').textContent() : null };
report.points = await view.locator('.point').count();
report.moved = await view.locator('.moved').allTextContents();
report.linked = await view.locator('details summary .doc').allTextContents();
report.excerpt = await view.locator('pre div').allTextContents();
report.saves = await view.locator('.save b').allTextContents();
if (screenshot) {
  await page.waitForTimeout(400);  // the frame resized, the entrance animation over
  await page.locator('iframe').screenshot({ path: screenshot });
}
if (report.points) {
  await view.locator('.point input').first().uncheck();
  await view.locator('.primary').click();
}
if (report.saves.length) {
  await view.locator('.save').first().click();
  await view.locator('h1').waitFor();
  report.opened = await view.locator('h1').textContent();
}
await page.waitForTimeout(200);
report.log = await page.evaluate(() => window.__log);
await browser.close();
process.stdout.write(JSON.stringify(report));
