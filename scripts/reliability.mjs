// v0.1.11: isolate a corrupt record and a silent decoder in a disposable extension.
// The stalled worker wrapper is written ONLY into the test copy, never the shipped build.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';

const folder = resolve('test-results/reliability'); await mkdir(folder, { recursive: true });
const movie = await readFile('tests/fixtures/motion.mp4'), portrait = await readFile('tests/fixtures/portrait.mp4');
const gif = await readFile('tests/fixtures/animation.gif');
const server = createServer((request, response) => {
  if (request.url === '/stall.mp4' || request.url === '/good.mp4') {
    const bytes = request.url === '/stall.mp4' ? movie : portrait;
    response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length }); response.end(bytes);
  } else { response.setHeader('Content-Type', 'text/html'); response.end('<title>Recovery fixture</title><video src="/stall.mp4" muted preload="auto"></video><video src="/good.mp4" muted preload="auto"></video>'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const extension = await mkdtemp(join(folder, 'extension-')); await cp('dist', extension, { recursive: true });
const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*']; await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
// Inject a single storage rejection in the actual offscreen progress writer. Keeping
// this in the disposable package avoids a production-only testing switch.
await writeFile(join(extension, 'storage-fault.js'), `
let armed = false, encodingWrites = 0, failures = 0;
const unhandled = [], originalPut = IDBObjectStore.prototype.put;
addEventListener('unhandledrejection', event => unhandled.push(String(event.reason)));
IDBObjectStore.prototype.put = function(value, ...args) {
  if (this.name === 'jobs' && armed && value.stage === 'encoding' && ++encodingWrites === 2) {
    armed = false; failures++; throw new DOMException('Injected progress write failure', 'QuotaExceededError');
  }
  return originalPut.call(this, value, ...args);
};
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.target !== 'storage-fault') return;
  if (message.arm) { armed = true; encodingWrites = 0; }
  reply({ failures, unhandled });
});`);
const offscreenPath = join(extension, 'offscreen.html');
await writeFile(offscreenPath, (await readFile(offscreenPath, 'utf8')).replace('<head>', '<head><script src="storage-fault.js"></script>'));
const assets = join(extension, 'assets');
const workerAsset = (await readdir(assets)).find(name => /^video-worker-.*\.js$/.test(name)); assert.ok(workerAsset);
await rename(join(assets, workerAsset), join(assets, 'original-video-worker.js'));
await writeFile(join(assets, workerAsset), `import './original-video-worker.js';
const original = self.onmessage; let stall = false;
self.onmessage = event => {
  if (event.data.type === 'open') stall = event.data.blob.size === ${movie.length};
  if (stall && event.data.type === 'frame') return;
  return original.call(self, event);
};`);
const profile = await mkdtemp(join(folder, 'profile-'));
const channel = process.env.TEST_BROWSER ?? 'chromium';
assert.ok(['chrome', 'chromium'].includes(channel));
const context = await chromium.launchPersistentContext(profile, { channel, headless: true, viewport: { width: 430, height: 950 },
  ...(channel === 'chrome' ? { ignoreDefaultArgs: ['--disable-extensions'] } : {}),
  args: channel === 'chrome' ? ['--enable-unsafe-extension-debugging'] : [`--load-extension=${extension}`, `--disable-extensions-except=${extension}`] });
const checks = [], errors = [];
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
const check = value => { checks.push(value); console.log('PASS', value); };
try {
  if (channel === 'chrome') {
    const session = await context.browser().newBrowserCDPSession(); await session.send('Extensions.loadUnpacked', { path: extension }); await session.detach();
  }
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const settings = { maxBytes: 4_000_000, maxSide: 160, fps: 10, speed: 1, dropFrames: 'none' };
  const source = { id: 'fixture', documentKey: 'fixture', tabId: 1, frameId: 0, kind: 'gif', url: origin + '/a.gif', pageUrl: origin,
    title: 'Legacy valid', width: 160, height: 90, duration: 1, currentTime: 0 };
  const legacy = { id: crypto.randomUUID(), source, settings: { maxBytes: 4_000_000, maxSide: 160, fps: 12 },
    segment: { id: 'segment', start: 0, end: 1 }, createdAt: Date.now(), updatedAt: Date.now(), stage: 'completed', progress: 1,
    result: { bytes: gif.length, width: 160, height: 90, duration: 1, frames: 6, filename: 'old filename.gif' } };
  const broken = { ...legacy, id: crypto.randomUUID(), source: { ...source, title: 'Broken settings' }, settings: { ...settings, fps: 0 } };
  await worker.evaluate(async ({ jobs, bytes }) => {
    const database = await new Promise((resolve, reject) => {
      const r = indexedDB.open('gif-toolkit', 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('jobs', { keyPath: 'id' }); r.result.createObjectStore('results'); };
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
    await new Promise((resolve, reject) => {
      const tx = database.transaction(['jobs', 'results'], 'readwrite');
      for (const job of jobs) { tx.objectStore('jobs').put(job); tx.objectStore('results').put(new Blob([Uint8Array.from(bytes)], { type: 'image/gif' }), job.id); }
      tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
    }); database.close();
  }, { jobs: [legacy, broken], bytes: [...gif] });
  const panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/panel.html`);
  const rpc = (type, data = {}) => panel.evaluate(async ({ type, data }) => {
    const reply = await chrome.runtime.sendMessage({ target: 'background', type, ...data });
    if (!reply.ok) throw Error(reply.error); return reply.data;
  }, { type, data });
  const history = await rpc('history'); assert.equal(history.jobs.length, 1); assert.equal(history.problems.length, 1);
  assert.equal(history.jobs[0].settings.speed, 1); assert.equal(history.jobs[0].settings.dropFrames, 'none');
  assert.equal(history.jobs[0].result.filename, `${Buffer.from(source.title).toString('base64url')}_${legacy.createdAt}_${legacy.id.replaceAll('-', '')}.gif`);
  assert.equal((await rpc('cache-summary')).ids.length, 2);
  await panel.getByRole('button', { name: /^History/ }).first().click();
  await panel.locator(`[data-history-problem="${broken.id}"]`).waitFor();
  await panel.screenshot({ path: join(folder, 'damaged-history.png') });
  check('one corrupt record remains visible and raw; valid legacy settings/filenames and cache APIs still work at startup');

  const page = await context.newPage(); await page.goto(origin);
  await page.waitForFunction(() => [...document.querySelectorAll('video')].every(video => video.readyState >= 2));
  const tabId = await worker.evaluate(async origin => (await chrome.tabs.query({ url: origin + '/*' }))[0].id, origin);
  const sources = await rpc('scan', { tabId });
  const ordered = ['/stall.mp4', '/good.mp4'].map(path => sources.find(source => source.url.endsWith(path))); assert.ok(ordered.every(Boolean));
  const ids = await rpc('enqueue', { items: ordered.map(source => ({ source, settings, segment: { id: crypto.randomUUID(), start: 0, end: 0.3, endMode: 'time' } })) });
  await panel.waitForFunction(ids => ids.every(id => ['completed', 'failed'].includes(document.querySelector(`[data-job-id="${id}"]`)?.getAttribute('data-stage'))), ids, { timeout: 60000 });
  const completed = await rpc('list');
  assert.equal(completed.find(job => job.id === ids[0]).error, 'workerTimeout');
  assert.equal(completed.find(job => job.id === ids[1]).stage, 'completed');
  assert.equal((await rpc('history')).problems.length, 1);
  const raw = await panel.evaluate(async id => {
    const database = await new Promise(resolve => { const r = indexedDB.open('gif-toolkit'); r.onsuccess = () => resolve(r.result); });
    const value = await new Promise(resolve => { const r = database.transaction('jobs').objectStore('jobs').get(id); r.onsuccess = () => resolve(r.result); }); database.close(); return value;
  }, broken.id);
  assert.deepEqual(raw, broken);
  check('a silently stalled decoder times out, terminates, and the next real video finishes while corrupt history stays untouched');

  await panel.evaluate(() => chrome.runtime.sendMessage({ target: 'storage-fault', arm: true }));
  const recoveryIds = await rpc('enqueue', { items: [ordered[1], ordered[1]].map(source => ({ source, settings,
    segment: { id: crypto.randomUUID(), start: 0, end: 0.3, endMode: 'time' } })) });
  await panel.waitForFunction(ids => ids.every(id => ['completed', 'failed'].includes(document.querySelector(`[data-job-id="${id}"]`)?.getAttribute('data-stage'))), recoveryIds, { timeout: 60000 });
  const afterStorageFailure = await rpc('list');
  assert.equal(afterStorageFailure.find(job => job.id === recoveryIds[0]).error, 'storageFull');
  assert.equal(afterStorageFailure.find(job => job.id === recoveryIds[1]).stage, 'completed');
  const faultState = await panel.evaluate(() => chrome.runtime.sendMessage({ target: 'storage-fault' }));
  assert.equal(faultState.failures, 1); assert.deepEqual(faultState.unhandled, []);
  check('a rejected progress write keeps its storageFull diagnosis without an unhandled rejection; the next job finishes');

  await panel.locator(`[data-history-problem="${broken.id}"]`).getByRole('button', { name: 'Remove task', exact: true }).click();
  await panel.locator(`[data-history-problem="${broken.id}"]`).waitFor({ state: 'detached' });
  assert.equal((await rpc('history')).problems.length, 0);
  assert.ok((await rpc('list')).some(job => job.id === legacy.id));
  assert.ok(!(await rpc('cache-summary')).ids.includes(broken.id));
  await worker.evaluate(() => chrome.offscreen.closeDocument()); await panel.reload();
  assert.equal((await rpc('history')).problems.length, 0);
  assert.equal((await rpc('list')).find(job => job.id === ids[1]).stage, 'completed');
  check('the damaged record and its file can be deleted from UI; healthy jobs survive processor restart');
  assert.deepEqual(errors, []);
} finally {
  await writeFile(join(folder, `verification-${channel}.json`), JSON.stringify({ date: new Date().toISOString(), version: manifest.version, browser: context.browser().version(), checks, errors }, null, 2));
  await context.close(); await new Promise(resolve => server.close(resolve));
}
