import { chromium } from 'playwright';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const extension = resolve('dist');
const context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, locale: 'en', viewport: { width: 430, height: 1000 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15000 });
const extensionId = new URL(worker.url()).host;
const panel = await context.newPage();
await panel.goto(`chrome-extension://${extensionId}/panel.html`);

async function importVideos(paths) {
  const promise = panel.waitForEvent('filechooser');
  await panel.locator('.local-import').click();
  const chooser = await promise;
  await chooser.setFiles(paths);
}
const rowCount = () => panel.locator('.source').count();

await importVideos([resolve('tests/fixtures/motion.mp4')]);
await panel.waitForFunction(() => document.querySelectorAll('.source').length === 1, { timeout: 15000 });

await panel.getByRole('button', { name: 'Make GIF', exact: true }).click();
await panel.waitForFunction(() => {
  const job = document.querySelector('[data-job-id]');
  return job && (job.getAttribute('data-stage') === 'completed' || job.getAttribute('data-stage') === 'failed');
}, { timeout: 60000 });
const stage = await panel.locator('[data-job-id]').first().getAttribute('data-stage');
assert.equal(stage, 'completed', 'local video GIF generation must finish before cleanup');

await panel.locator('.source-remove').first().click();
await panel.waitForFunction(() => !document.querySelector('.source'), { timeout: 10000 });
assert.equal(await rowCount(), 0, 'the local source is removable after the GIF is made');
assert.equal(await panel.locator('[data-stage="completed"]').count(), 1, 'the finished GIF stays available');

await importVideos([resolve('tests/fixtures/motion.mp4'), resolve('tests/fixtures/portrait.mp4')]);
await panel.waitForFunction(() => document.querySelectorAll('.source').length === 2, { timeout: 15000 });
await panel.locator('.clear-local').click();
await panel.waitForFunction(() => !document.querySelector('.source'), { timeout: 10000 });
assert.equal(await rowCount(), 0, 'clear-all removes every imported video');

console.log('PASS local videos: batch import, generate, then per-row remove and clear all after completion');
await context.close();
