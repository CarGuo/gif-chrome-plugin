import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><title>Region Record Page</title></head><body style="margin:0;background:#111">
    <canvas id="anim" width="480" height="320" style="display:block;width:480px;height:320px"></canvas>
    <script>
      const ctx = document.getElementById('anim').getContext('2d');
      let t = 0;
      setInterval(() => {
        t += 12;
        ctx.fillStyle = '#182438';
        ctx.fillRect(0, 0, 480, 320);
        ctx.fillStyle = '#38bdf8';
        ctx.fillRect((t % 360), 60, 100, 100);
        ctx.fillStyle = '#f97316';
        ctx.fillRect(360 - (t % 320), 170, 90, 90);
      }, 30);
    </script>
  </body></html>`);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const origin = `http://127.0.0.1:${port}`;

const extension = resolve('test-results/local-videos-extension');
await mkdir(extension, { recursive: true });
await cp(resolve('dist'), extension, { recursive: true });
const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*'];
await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));

const context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, locale: 'en', viewport: { width: 640, height: 1000 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--enable-usermedia-screen-capturing', '--auto-select-desktop-capture-source=Region Record Page'] });
const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15000 });
const extensionId = new URL(worker.url()).host;

const webPage = await context.newPage();
await webPage.goto(`${origin}/`);
const webTabId = await worker.evaluate(async origin => (await chrome.tabs.query({ url: origin + '/*' }))[0].id, origin);

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

// 1. Test Make GIF
await panel.getByRole('button', { name: 'Make GIF', exact: true }).click();
await panel.waitForFunction(() => {
  const job = document.querySelector('[data-job-id]');
  return job && (job.getAttribute('data-stage') === 'completed' || job.getAttribute('data-stage') === 'failed');
}, { timeout: 60000 });
const stage = await panel.locator('[data-job-id]').first().getAttribute('data-stage');
assert.equal(stage, 'completed', 'local video GIF generation must finish before cleanup');

// 2. Test Save Video only (.mp4 export + video preview modal)
await panel.locator('.generate-video').click();
await panel.waitForFunction(() => document.querySelectorAll('[data-stage="completed"]').length === 2, { timeout: 60000 });
assert.equal(await panel.locator('.format-badge.video').count(), 1, 'video export renders MP4 badge');
assert.match(await panel.locator('[data-format="video"] .filename-preview').textContent(), /\.mp4$/, 'video export uses .mp4 filename');
await panel.getByRole('button', { name: 'Preview video', exact: true }).click();
await panel.waitForSelector('.preview-modal video', { timeout: 10000 });
await panel.locator('.preview-close').click();

await panel.locator('.source-remove').first().click();
await panel.waitForFunction(() => !document.querySelector('.source'), { timeout: 10000 });
assert.equal(await rowCount(), 0, 'the local source is removable after the GIF and video are made');
assert.equal(await panel.locator('[data-stage="completed"]').count(), 2, 'the finished exports stay available');

// 3. Test drag-and-drop local video import
const motionBytes = Array.from(readFileSync(resolve('tests/fixtures/motion.mp4')));
await panel.evaluate((bytes) => {
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array(bytes)], 'dropped-video.mp4', { type: 'video/mp4' }));
  const zone = document.querySelector('.local-import');
  zone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
}, motionBytes);
await panel.waitForFunction(() => document.querySelectorAll('.source').length === 1, { timeout: 15000 });
assert.equal(await panel.locator('.source strong').first().textContent(), 'dropped-video', 'dragged local video is imported');

await importVideos([resolve('tests/fixtures/motion.mp4'), resolve('tests/fixtures/portrait.mp4')]);
await panel.waitForFunction(() => document.querySelectorAll('.source').length === 3, { timeout: 15000 });
await panel.locator('.clear-local').click();
await panel.waitForFunction(() => !document.querySelector('.source'), { timeout: 10000 });
assert.equal(await rowCount(), 0, 'clear-all removes every imported video');

// 4. Test free-form region recording -> Save Video & Save GIF
await webPage.bringToFront();
await panel.evaluate(async (tabId) => {
  const res = await chrome.runtime.sendMessage({ target: 'background', type: 'start-region-select', tabId });
  if (!res?.ok) throw new Error(res?.error || 'start-region-select failed');
}, webTabId);
await webPage.waitForFunction(() => Boolean(document.querySelector('#gif-toolkit-region-root')), { timeout: 10000 });
await webPage.mouse.move(40, 40);
await webPage.mouse.down();
await webPage.mouse.move(280, 220, { steps: 8 });
await webPage.mouse.up();

await panel.waitForSelector('.region-record-card[data-stage="selected"]', { timeout: 10000 });
await webPage.locator('#gif-toolkit-region-root [data-action="start-record"]').click();
await panel.waitForSelector('.region-record-card[data-stage="recording"]', { timeout: 15000 });
await new Promise(r => setTimeout(r, 900));
await panel.locator('.region-record-card').getByRole('button', { name: 'Save Video', exact: true }).click();
await panel.waitForFunction(() => document.querySelectorAll('[data-stage="completed"]').length === 3, { timeout: 60000 });
assert.equal(await panel.locator('.format-badge.video').count(), 2, 'region recording saved as MP4 video');

// Also test region recording -> Save GIF directly from the on-page floating toolbar
await webPage.bringToFront();
await panel.evaluate(async (tabId) => {
  const res = await chrome.runtime.sendMessage({ target: 'background', type: 'start-region-select', tabId });
  if (!res?.ok) throw new Error(res?.error || 'start-region-select failed');
}, webTabId);
await webPage.waitForFunction(() => Boolean(document.querySelector('#gif-toolkit-region-root')), { timeout: 10000 });
await webPage.mouse.move(50, 50);
await webPage.mouse.down();
await webPage.mouse.move(250, 210, { steps: 8 });
await webPage.mouse.up();
await panel.waitForSelector('.region-record-card[data-stage="selected"]', { timeout: 10000 });
await webPage.locator('#gif-toolkit-region-root [data-action="start-record"]').click();
await panel.waitForSelector('.region-record-card[data-stage="recording"]', { timeout: 15000 });
await new Promise(r => setTimeout(r, 900));
await webPage.locator('#gif-toolkit-region-root [data-action="save-gif"]').click();
await panel.waitForFunction(() => document.querySelectorAll('[data-stage="completed"]').length === 4, { timeout: 60000 });
assert.equal(await panel.locator('.format-badge.gif').count(), 2, 'region recording saved as GIF');

console.log('PASS local videos: file picker + drag-and-drop import, Make GIF, Save Video, region screen recording');
await context.close();
server.close();
