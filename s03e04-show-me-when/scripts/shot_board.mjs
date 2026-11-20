// Screenshot of the local board with the suite's mock (invented incidents, one acked, one failed ack).
// usage (from the repo root): node <this file> <repo dir> <out.png> [locale] [timeZone]
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';

const [repo, out, locale = 'en-NZ', timezoneId = 'Pacific/Auckland'] = process.argv.slice(2);
const require = createRequire(path.resolve(repo, 'package.json'));
const { chromium } = require('playwright');
const { MockApi, incident, installMock } = await import(pathToFileURL(path.resolve(repo, 'tests/mock-api.mjs')));

const port = 4189;
const server = spawn(process.execPath, [path.resolve(repo, 'tests/serve.mjs')], {
  env: { ...process.env, PORT: String(port), BOARD_DIR: 'app' },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 700));

const pages = [[
  incident('INC-1077', '2026-11-18T05:30:00.000Z', { service: 'sched-notifications', region: 'ap-southeast-2', summary: 'reminder queue backlog over threshold for several tenants', severity: 'sev1' }),
  incident('INC-1002', '2026-11-18T04:20:00.000Z', { severity: 'sev2' }),
  incident('INC-1001', '2026-11-18T03:11:00.000Z', { severity: 'sev3' }),
]];
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 520 }, locale, timezoneId });
  const api = new MockApi(pages);
  await installMock(page, api);
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.locator('[data-id="INC-1002"] [data-testid="ack"]').click();
  await page.locator('[data-id="INC-1002"] [data-testid="acked"]').waitFor();
  api.ackOpts.status = 500;
  await page.locator('[data-id="INC-1001"] [data-testid="ack"]').click();
  await page.locator('[data-id="INC-1001"] [role="alert"]').waitFor();
  await page.screenshot({ path: out, fullPage: true });
  console.log('saved', out);
} finally {
  await browser.close();
  server.kill();
}
