import { chromium } from 'playwright';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

// Public sample in a disposable Chromium profile. This never attaches to a user's logged-in browser.
const url = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
const folder = resolve('test-results/platform-extension');
await mkdir(folder, { recursive: true }); await cp(resolve('dist'), folder, { recursive: true });
const manifest = JSON.parse(await readFile(resolve(folder, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['https://www.youtube.com/*'];
await writeFile(resolve(folder, 'manifest.json'), JSON.stringify(manifest));
const context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true,
  args: [`--load-extension=${folder}`, `--disable-extensions-except=${folder}`, '--autoplay-policy=no-user-gesture-required'] });
const report = { date: new Date().toISOString(), version: manifest.version, url, status: 'unverified' };
try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage(); await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('video', { timeout: 20000 });
  await page.locator('video').first().evaluate(video => { video.muted = true; return video.play(); });
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2 && document.querySelector('video')?.duration > 500 && !document.querySelector('.ad-showing'), null, { timeout: 30000 });
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://www.youtube.com/*' }))[0].id);
  const panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/panel.html`);
  const rpc = (type, data = {}) => panel.evaluate(async ({ type, data }) => {
    const reply = await chrome.runtime.sendMessage({ target: 'background', type, ...data });
    if (!reply.ok) throw Error(reply.error); return reply.data;
  }, { type, data });
  const source = (await rpc('scan', { tabId })).find(source => source.kind === 'video' && source.duration > 500);
  assert.ok(source); report.title = source.title;
  const [id] = await rpc('enqueue', { items: [{ source, settings: { maxBytes: 4000000, maxSide: 480, fps: 10, speed: 2 }, segment: { id: 'youtube-review', start: 10, end: 11 } }] });
  let job;
  for (let attempt = 0; attempt < 120; attempt++) {
    job = (await rpc('list')).find(job => job.id === id);
    if (job && ['completed', 'failed', 'cancelled'].includes(job.stage)) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(job.stage, 'completed', JSON.stringify(job));
  assert.ok(job.result.bytes <= 4000000 && job.result.width <= 480 && job.result.height <= 480);
  assert.ok(Math.abs(job.result.duration - 0.5) < 0.11);
  assert.match(job.result.filename, /^[A-Za-z0-9_-]+_[0-9]{13}_[a-f0-9]{32}\.gif$/);
  report.status = 'passed'; report.result = job.result;
  console.log('PASS live public YouTube conversion:', report);
} catch (error) {
  report.error = String(error); console.error('YouTube remains unverified:', report.error); process.exitCode = 1;
} finally {
  await writeFile('test-results/platform-verification.json', JSON.stringify(report, null, 2));
  await context.close();
}
