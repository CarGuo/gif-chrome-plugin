// v0.1.9: real IndexedDB + side-panel UI regression; isolated profile and self-generated GIFs.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';

const folder = resolve('test-results/history'); await mkdir(folder, { recursive: true });
const gif = await readFile('tests/fixtures/animation.gif');
const waiting = new Set(); let released = false;
const sendGif = response => { response.end(gif); waiting.delete(response); };
const server = createServer((request, response) => {
  if (request.url === '/pending.gif') {
    response.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': gif.length }); response.flushHeaders();
    if (released) sendGif(response); else waiting.add(response);
  } else { response.setHeader('Content-Type', 'text/html'); response.end('<title>History fixture</title><p>Source page</p>'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const extension = resolve(folder, 'extension'); await cp('dist', extension, { recursive: true });
const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*']; await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
const profile = await mkdtemp(join(folder, 'profile-')), downloads = await mkdtemp(join(folder, 'downloads-'));
await mkdir(join(profile, 'Default'));
await writeFile(join(profile, 'Default/Preferences'), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }));
const launch = () => chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 430, height: 1000 },
  args: [`--load-extension=${extension}`, `--disable-extensions-except=${extension}`] });
let context = await launch();
const checks = [], check = value => { checks.push(value); console.log('PASS', value); };
let panel;
const rpc = (type, data = {}, page = panel) => page.evaluate(async ({ type, data }) => {
  const response = await chrome.runtime.sendMessage({ target: 'background', type, ...data });
  if (!response.ok) throw Error(response.error); return response.data;
}, { type, data });
const seed = (jobs, orphan = false) => panel.evaluate(async ({ jobs, bytes, orphan }) => {
  const database = await new Promise((resolve, reject) => { const r = indexedDB.open('gif-toolkit'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  await new Promise((resolve, reject) => {
    const tx = database.transaction(['jobs', 'results'], 'readwrite');
    for (const job of jobs) {
      tx.objectStore('jobs').put(job);
      if (job.result) tx.objectStore('results').put(new Blob([Uint8Array.from(bytes)], { type: 'image/gif' }), job.id);
    }
    if (orphan) tx.objectStore('results').put(new Blob([Uint8Array.from(bytes)], { type: 'image/gif' }), 'orphan-file');
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  }); database.close();
}, { jobs, bytes: [...gif], orphan });
const savedSettings = { maxBytes: 2_000_000, maxSide: 480, fps: 12, speed: 2, dropFrames: 'duplicates' };
const settings = { maxBytes: 4_000_000, maxSide: 320, fps: 10, speed: 1, dropFrames: 'none' };
const source = { id: 'fixture', documentKey: 'fixture', tabId: 1, frameId: 0, kind: 'gif', url: `${origin}/pending.gif`, pageUrl: origin,
  title: 'History fixture', width: 160, height: 90, duration: 1, currentTime: 0, frameCount: 6 };
const job = (id, title, stage = 'completed', age = 0) => ({ id, source: { ...source, title, pageUrl: `${origin}/${id}` }, settings: { ...settings },
  segment: { id, start: 0, end: 1, endMode: 'source' }, stage, progress: 1, createdAt: Date.now() - age, updatedAt: Date.now() - age,
  ...(stage === 'completed' ? { result: { bytes: gif.length, width: 160, height: 90, duration: 1, frames: 6, filename: `${id}.gif` } } : {}) });
async function openPanel() {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  panel = await context.newPage(); await panel.goto(`chrome-extension://${id}/panel.html`);
  await rpc('list'); return id;
}
async function openHistory(page = panel) {
  await page.getByRole('button', { name: /^History/ }).click();
  await page.getByRole('heading', { name: 'History', exact: true }).waitFor();
}
async function waitForJobs(ids, stages) {
  for (let i = 0; i < 160; i++) {
    const jobs = await rpc('list'); const selected = ids.map(id => jobs.find(job => job.id === id));
    if (selected.every(job => job && stages.includes(job.stage))) return selected;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error(`Jobs did not reach ${stages}`);
}
try {
  const session = await context.browser().newBrowserCDPSession();
  await session.send('Browser.setDownloadBehavior', { behavior: 'default' }); await session.detach();
  const id = await openPanel();
  const initial = [job('alpha', 'Alpha sunset'), job('beta', 'Beta river', 'completed', 1000), job('cat', '猫咪动画', 'completed', 2000),
    job('failed', 'Failed task', 'failed', 3000), job('cancelled', 'Cancelled task', 'cancelled', 4000)];
  // Older saved settings and result records have no new availability flag.
  delete initial[1].settings.speed; initial[1].settings = { maxBytes: 4_000_000, maxSide: 320, fps: 12 };
  await seed(initial, true); await rpc('save-preferences', { settings: savedSettings });
  await panel.reload(); await openHistory();
  await panel.locator('[data-job-id]').nth(4).waitFor();
  assert.equal(await panel.locator('[data-job-id]').count(), 5);
  await panel.getByRole('searchbox', { name: 'Search history' }).fill('猫'); assert.equal(await panel.locator('[data-job-id]').count(), 1);
  await panel.getByRole('searchbox', { name: 'Search history' }).fill('/beta'); assert.equal(await panel.locator('[data-job-id]').count(), 1);
  await panel.getByRole('searchbox', { name: 'Search history' }).fill('');
  await panel.getByRole('combobox', { name: 'Status', exact: true }).selectOption('failed'); assert.equal(await panel.locator('[data-job-id]').count(), 1);
  await panel.getByRole('combobox', { name: 'Status', exact: true }).selectOption('all');
  assert.equal(await panel.locator('[data-job-id="beta"] .history-origin a').getAttribute('href'), `${origin}/beta`);
  assert.ok(await panel.locator('[data-job-id="alpha"] time').getAttribute('datetime'));
  assert.equal((await rpc('list')).find(job => job.id === 'beta').settings.speed, 1);
  const summary = await rpc('cache-summary'); assert.equal(summary.ids.length, 4); assert.equal(summary.bytes, gif.length * 4);
  await panel.screenshot({ path: join(folder, 'history-430.png'), fullPage: true });
  await panel.setViewportSize({ width: 320, height: 850 });
  assert.ok(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await panel.screenshot({ path: join(folder, 'history-320.png'), fullPage: true });
  await panel.setViewportSize({ width: 430, height: 1000 });
  check('history works without a source page, searches names/websites, filters statuses and reads legacy records');

  const second = await context.newPage(); await second.goto(`chrome-extension://${id}/panel.html`); await openHistory(second);
  await second.locator('[data-job-id="alpha"]').getByRole('button', { name: 'Preview GIF', exact: true }).click();
  await second.getByRole('dialog', { name: 'Preview GIF' }).waitFor();
  await second.waitForFunction(() => document.querySelector('.preview-modal img')?.naturalWidth > 0);
  // A real browser save must still exist after the extension's cached copy is removed.
  const downloadId = await rpc('download', { id: 'alpha', title: 'Saved history fixture', saveAs: false });
  let saved;
  for (let i = 0; i < 100; i++) {
    saved = await panel.evaluate(async id => (await chrome.downloads.search({ id }))[0], downloadId);
    if (saved.state === 'complete') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(saved.state, 'complete'); assert.deepEqual(await readFile(saved.filename), gif);
  let releasedSaveUrl = false;
  for (let i = 0; i < 50; i++) {
    releasedSaveUrl = await panel.evaluate(async url => { try { await fetch(url); return false; } catch { return true; } }, saved.url);
    if (releasedSaveUrl) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(releasedSaveUrl, 'completed browser downloads release their memory URL');
  const lease = await panel.evaluate(async () => (await chrome.runtime.sendMessage({ target: 'offscreen', type: 'result-url', id: 'alpha' })).data);
  await panel.getByRole('button', { name: 'Clear cache', exact: true }).click();
  let dialog = panel.getByRole('dialog', { name: 'Clear cache' }); await dialog.waitFor();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal((await rpc('cache-summary')).ids.length, 4);
  await panel.getByRole('button', { name: 'Clear cache', exact: true }).click();
  dialog = panel.getByRole('dialog', { name: 'Clear cache' }); await dialog.waitFor();
  await panel.screenshot({ path: join(folder, 'clear-cache-dialog.png') });
  const later = job('later', 'Created after confirmation'); await seed([later]);
  await dialog.getByRole('button', { name: 'Clear cache', exact: true }).click();
  await panel.getByRole('alert').filter({ hasText: 'Cleared 4 files' }).waitFor();
  await second.getByRole('dialog', { name: 'Preview GIF' }).waitFor({ state: 'hidden' });
  const after = await rpc('list'); assert.equal(after.length, 6);
  assert.ok(after.find(job => job.id === 'alpha').result.clearedAt);
  assert.equal(after.find(job => job.id === 'later').result.clearedAt, undefined);
  assert.deepEqual((await rpc('cache-summary')).ids, ['later']);
  const repeated = await rpc('clear-cache', { ids: summary.ids });
  assert.deepEqual(repeated, { ids: [], bytes: 0 }, 'a second panel clearing an old snapshot must not count files twice');
  assert.equal(await panel.locator('[data-job-id="alpha"]').getByRole('button', { name: 'Preview GIF' }).count(), 0);
  assert.equal(await panel.locator('[data-job-id="alpha"]').getByRole('button', { name: /Save GIF/ }).count(), 0);
  assert.deepEqual(await readFile(saved.filename), gif);
  assert.equal(await panel.evaluate(async url => (await (await fetch(url)).blob()).size, lease), gif.length);
  await panel.evaluate(async url => chrome.runtime.sendMessage({ target: 'offscreen', type: 'release-result-url', url }), lease);
  assert.equal(await panel.evaluate(async url => { try { await fetch(url); return true; } catch { return false; } }, lease), false);
  assert.equal(await panel.evaluate(async id => (await chrome.runtime.sendMessage({ target: 'background', type: 'download', id })).error, 'alpha'), 'resultUnavailable');
  assert.deepEqual(await rpc('load-preferences'), savedSettings);
  check('cache cleanup is cancellable, preserves history/settings/saved files, closes other previews and clears orphan files');
  check('reviewed cleanup IDs exclude new results, and download URL leases survive cleanup until released');

  const ids = await rpc('enqueue', { items: [1, 2].map(index => ({ source: { ...source, title: `Running ${index}` }, settings: { ...settings, speed: 1 }, segment: { id: `active-${index}`, start: 0, end: 1 } })) });
  await waitForJobs([ids[0]], ['downloading']); await waitForJobs([ids[1]], ['queued']);
  assert.deepEqual((await rpc('clear-history', { ids })).ids, [], 'backend independently protects queued and active jobs');
  await panel.getByRole('button', { name: 'Clear history', exact: true }).click();
  dialog = panel.getByRole('dialog', { name: 'Clear history' }); await dialog.waitFor();
  await dialog.getByRole('button', { name: 'Clear history', exact: true }).click();
  await panel.getByRole('alert').filter({ hasText: 'Removed 6 history records' }).waitFor();
  assert.deepEqual((await rpc('list')).map(job => job.id).sort(), ids.sort());
  assert.equal((await rpc('cache-summary')).bytes, 0);
  released = true; for (const response of [...waiting]) sendGif(response);
  const completed = await waitForJobs(ids, ['completed']); assert.ok(completed.every(job => job.result.bytes > 0));
  assert.deepEqual(await rpc('load-preferences'), savedSettings);
  check('clearing history preserves active/queued jobs, which finish normally after cleanup');

  await context.close(); context = await launch(); await openPanel(); await openHistory();
  assert.equal((await rpc('list')).length, 2); assert.equal((await rpc('cache-summary')).ids.length, 2);
  assert.deepEqual(await rpc('load-preferences'), savedSettings);
  await panel.locator(`[data-job-id="${ids[0]}"]`).getByRole('button', { name: 'Remove task', exact: true }).click();
  await panel.locator(`[data-job-id="${ids[0]}"]`).waitFor({ state: 'detached' });
  assert.equal((await rpc('list')).length, 1); assert.equal((await rpc('cache-summary')).ids.length, 1);
  check('history/files persist across browser restart, and individual deletion removes both atomically');
} finally {
  for (const response of [...waiting]) response.destroy();
  await writeFile(join(folder, 'report.json'), JSON.stringify({ version: manifest.version, checks }, null, 2));
  await context.close(); await new Promise(resolve => server.close(resolve));
}
