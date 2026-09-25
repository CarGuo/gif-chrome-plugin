import { chromium } from 'playwright';
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

// v0.1.3 regression: upgrading an existing profile, not only a clean install.
const extension = resolve('test-results/preferences-extension');
await mkdir(extension, { recursive: true }); await cp(resolve('dist'), extension, { recursive: true });
const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['https://x.com/*', 'https://example.test/*'];
await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
const clip = (await readFile('tests/fixtures/motion.mp4')).toString('base64');
const context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true,
  viewport: { width: 430, height: 1200 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const legacy = { maxBytes: 4_000_000, maxSide: 800, fps: 12 };
  await worker.evaluate(settings => chrome.storage.local.set({ settings }), legacy);
  // All X requests in this disposable profile are local fixtures, never the user's session.
  await context.route('https://x.com/**', route => route.fulfill({ contentType: 'text/html', body:
    `<!doctype html><title>X timeline</title><article><div data-testid="tweetText">A tiny cat\n chasing a leaf</div><video id="first" aria-label="嵌入式视频" src="data:video/mp4;base64,${clip}" preload="auto"></video></article>
     <article><div data-testid="tweetText">A different post</div><video aria-label="Embedded video"></video></article>
     <article><a href="https://x.com/artist/status/456"><time>Today</time></a><video aria-label="Embedded video"></video></article>` }));
  const page = await context.newPage(); await page.goto('https://x.com/fixture/status/123');
  await page.waitForFunction(() => document.querySelector('#first').readyState >= 2);
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://x.com/*' }))[0].id);
  const panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/panel.html`);
  const texts = await panel.evaluate(() => Object.fromEntries(['speed','speedPresets','fps','start','end','outputName','generateOne'].map(key => [key, chrome.i18n.getMessage(key)])));
  const sources = await panel.evaluate(async tabId => {
    const response = await chrome.runtime.sendMessage({ target: 'background', type: 'scan', tabId });
    if (!response.ok) throw Error(response.error); return response.data;
  }, tabId);
  assert.deepEqual(sources.map(s => s.title), ['X · A tiny cat chasing a leaf', 'X · A different post', 'X · @artist · 456']);
  await panel.locator('.source').first().click();
  const fps = panel.getByRole('spinbutton', { name: texts.fps });
  await panel.waitForFunction(() => document.querySelector('#playback-speed') && !document.querySelector('#playback-speed').disabled);
  assert.equal(await fps.inputValue(), '10');
  assert.equal(await panel.getByRole('spinbutton', { name: texts.start }).inputValue(), '0');
  assert.equal(Number(await panel.getByRole('spinbutton', { name: texts.end }).inputValue()), sources[0].duration);
  await panel.getByRole('group', { name: texts.speedPresets }).getByRole('button', { name: '2×', exact: true }).click();
  assert.equal(await panel.getByRole('spinbutton', { name: texts.speed, exact: true }).inputValue(), '2');
  assert.match(await panel.locator('.clip-output').textContent(), /1\.5/);
  const customName = '猫咪 / chasing a leaf';
  await panel.locator('.clips').getByRole('textbox', { name: texts.outputName }).fill(customName);
  assert.equal(await panel.locator('.source').first().locator('strong').textContent(), customName);
  await panel.screenshot({ path: `test-results/preferences-${manifest.version}.png`, fullPage: true });
  // Use the real enqueue button so the UI name and speed must reach the job and encoder.
  await panel.getByRole('button', { name: texts.generateOne, exact: true }).click();
  await panel.waitForFunction(() => document.querySelector('.job.completed, .job.failed'), null, { timeout: 120000 });
  assert.equal(await panel.locator('.job').first().getAttribute('data-stage'), 'completed', await panel.locator('.job').first().textContent());
  const jobs = await panel.evaluate(async () => (await chrome.runtime.sendMessage({ target: 'background', type: 'list' })).data);
  assert.equal(jobs[0].source.title, customName);
  assert.equal(jobs[0].settings.fps, 10); assert.equal(jobs[0].settings.speed, 2);
  assert.equal(jobs[0].result.filename, `${Buffer.from(customName).toString('base64url')}_${jobs[0].createdAt}_${jobs[0].id.replaceAll('-', '')}.gif`);
  assert.equal(jobs[0].result.frames, 15); assert.ok(Math.abs(jobs[0].result.duration - 1.5) < 0.001);
  const renamed = '猫咪 · final';
  await panel.locator('.job').first().getByRole('textbox', { name: texts.outputName }).fill(renamed);
  assert.equal(await panel.locator('.filename-preview').first().textContent(), `${Buffer.from(renamed).toString('base64url')}_${jobs[0].createdAt}_${jobs[0].id.replaceAll('-', '')}.gif`);
  // The versioned preference record must preserve a deliberate 12 fps thereafter.
  await panel.evaluate(async settings => {
    const reply = await chrome.runtime.sendMessage({ target: 'background', type: 'save-preferences', settings: { ...settings, speed: 2 } });
    if (!reply.ok) throw Error(reply.error);
  }, legacy);
  await panel.reload();
  await panel.locator('.source').first().click();
  await panel.waitForFunction(() => document.querySelector('#playback-speed') && !document.querySelector('#playback-speed').disabled);
  assert.equal(await fps.inputValue(), '12');
  assert.equal(await panel.getByRole('spinbutton', { name: texts.speed, exact: true }).inputValue(), '2');
  // v0.1.4: evicting old results must also remove their cards while the panel stays open.
  await panel.evaluate(async () => {
    const database = await new Promise((resolve, reject) => { const r = indexedDB.open('gif-toolkit'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const template = (await chrome.runtime.sendMessage({ target: 'background', type: 'list' })).data[0];
    await new Promise((resolve, reject) => {
      const tx = database.transaction('jobs', 'readwrite');
      for (let index = 0; index < 30; index++) tx.objectStore('jobs').put({ ...template, id: crypto.randomUUID(), stage: 'failed', result: undefined, error: 'cancelled', createdAt: template.createdAt - 1000 - index });
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
  });
  await panel.reload();
  await panel.waitForFunction(() => document.querySelectorAll('.job').length === 31);
  await panel.locator('.source').first().click();
  await panel.getByRole('button', { name: texts.generateOne, exact: true }).click();
  let historySynced = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    const stored = await panel.evaluate(async () => (await chrome.runtime.sendMessage({ target: 'background', type: 'list' })).data);
    if (stored.length === 30 && stored.every(job => ['completed', 'failed', 'cancelled'].includes(job.stage)) && await panel.locator('.job').count() === 30) { historySynced = true; break; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(historySynced, 'evicted results must disappear from the open panel');
  await context.route('https://example.test/**', route => route.fulfill({ contentType: 'text/html', body:
    '<!doctype html><title>A meaningful page title</title><video aria-label="Embedded video"></video><figure><video aria-label="嵌入式视频"></video><figcaption>Named figure</figcaption></figure><video title="Named video" aria-label="Embedded video"></video>' }));
  await page.goto('https://example.test/');
  const generic = await panel.evaluate(async tabId => (await chrome.runtime.sendMessage({ target: 'background', type: 'scan', tabId })).data, tabId);
  assert.deepEqual(generic.map(s => s.title), ['A meaningful page title', 'Named figure', 'Named video']);
  console.log('PASS legacy 12→10 migration, later explicit 12 preserved, full duration, speed preset→real 2× output, editable names, scoped X captions and semantic titles, history eviction updates visible cards');
} finally { await context.close(); }
