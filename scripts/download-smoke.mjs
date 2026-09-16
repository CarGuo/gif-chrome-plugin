import { chromium } from 'playwright';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const folder = resolve('dist'); const downloads = resolve('test-results/downloads'); await mkdir(downloads, { recursive: true });
const report = JSON.parse(await readFile('test-results/verification.json', 'utf8')); const item = report.jobs[0];
const bytes = [...await readFile(resolve('test-results', item.result.filename))];
const actualDownloads = await mkdtemp(join(downloads, 'rename-'));
const profile = await mkdtemp(resolve('test-results/download-profile-'));
await mkdir(join(profile, 'Default'));
await writeFile(join(profile, 'Default/Preferences'), JSON.stringify({ download: { default_directory: actualDownloads, prompt_for_download: false } }));
const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: [`--load-extension=${folder}`, `--disable-extensions-except=${folder}`] });
try {
  // DevTools overrides bypass extension filename determination (Playwright issue #19885).
  // Use Chrome's default behavior in our own fresh profile to test the actual saved name.
  const browserSession = await context.browser().newBrowserCDPSession();
  await browserSession.send('Browser.setDownloadBehavior', { behavior: 'default' });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'); const id = new URL(worker.url()).host;
  const panel = await context.newPage(); await panel.goto(`chrome-extension://${id}/panel.html`);
  const result = await panel.evaluate(async ({ bytes, item }) => {
    const initialized = await chrome.runtime.sendMessage({ target: 'background', type: 'list' }); if (!initialized.ok) throw Error(initialized.error);
    const database = await new Promise((resolve, reject) => { const r = indexedDB.open('gif-toolkit', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const id = crypto.randomUUID();
    await new Promise((resolve, reject) => { const tx = database.transaction(['jobs', 'results'], 'readwrite');
      tx.objectStore('jobs').put({ id, stage: 'completed', progress: 1, createdAt: Date.now(), updatedAt: Date.now(),
        source: { id: 'fixture', documentKey: 'fixture', tabId: 0, frameId: 0, kind: 'video', url: 'https://example.test/motion.mp4', pageUrl: 'https://example.test/', title: item.title, width: 320, height: 180, duration: 3, currentTime: 0 },
        segment: { id: 'fixture', start: 0.5, end: 1.5 }, settings: { maxBytes: 4_000_000, maxSide: 800, fps: 12 }, result: item.result });
      tx.objectStore('results').put(new Blob([Uint8Array.from(bytes)], { type: 'image/gif' }), id);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    // v0.1.3: a completed legacy result can be renamed without changing its settings or GIF bytes.
    const downloaded = await chrome.runtime.sendMessage({ target: 'background', type: 'download', id, title: '自定义 / X clip', saveAs: false }); if (!downloaded.ok) throw Error(downloaded.error);
    const persisted = (await chrome.runtime.sendMessage({ target: 'background', type: 'list' })).data.find(job => job.id === id);
    const expectedName = `${btoa(String.fromCharCode(...new TextEncoder().encode('自定义 / X clip'))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}_${persisted.createdAt}_${id.replaceAll('-', '')}.gif`;
    if (persisted.source.title !== '自定义 / X clip' || persisted.result.filename !== expectedName || persisted.settings.fps !== 12) throw Error('Rename did not persist, or changed historical settings');
    for (let attempt = 0; attempt < 50; attempt++) {
      const [state] = await chrome.downloads.search({ id: downloaded.data });
      if (state.state === 'complete' || state.state === 'interrupted') return { ...state, expectedName };
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error('Download timeout');
  }, { bytes, item });
  if (result.state !== 'complete') throw Error(JSON.stringify(result));
  console.log('PASS chrome.downloads completed:', { bytes: result.fileSize, expected: bytes.length, filename: result.filename });
  if (result.fileSize !== bytes.length) throw Error('Byte count mismatch');
  assert.ok(result.filename.endsWith(result.expectedName));
  assert.match(result.expectedName, /^[A-Za-z0-9_-]+_[0-9]{13}_[a-f0-9]{32}\.gif$/);
  assert.deepEqual([...await readFile(result.filename)], bytes);
} finally { await context.close(); }
