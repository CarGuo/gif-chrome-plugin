import { chromium } from 'playwright';
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { parseGIF } = createRequire(import.meta.url)('gifuct-js');

// v0.1.5: test production UI → settings/history → WASM → independently decoded GIF clocks/pixels.
const artifacts = resolve('test-results/drop-frames'); await mkdir(artifacts, { recursive: true });
const extension = resolve(artifacts, 'extension'); await cp(resolve('dist'), extension, { recursive: true });
const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['https://example.test/*'];
await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
const colorsGif = (await readFile('tests/fixtures/drop-frames.gif')).toString('base64');
const transparentWebp = (await readFile('tests/fixtures/transparent.webp')).toString('base64');
const portrait = (await readFile('tests/fixtures/portrait.mp4')).toString('base64');
const context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true,
  viewport: { width: 430, height: 1200 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
const errors = []; context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  // A previously versioned record has no optional-removal preference. Upgrade must default off.
  const settings = { maxBytes: 4_000_000, maxSide: 800, fps: 10, speed: 1 };
  await worker.evaluate(values => chrome.storage.local.set({ exportPreferences: { version: 1, values } }), settings);
  await context.route('https://example.test/**', route => route.fulfill({ contentType: 'text/html', body:
    `<!doctype html><title>Frame removal fixtures</title><img title="Color holds" src="data:image/gif;base64,${colorsGif}"><img title="Transparency" src="data:image/webp;base64,${transparentWebp}"><video title="Portrait" src="data:video/mp4;base64,${portrait}" preload="auto"></video>` }));
  const page = await context.newPage(); await page.goto('https://example.test/');
  await page.waitForFunction(() => document.querySelector('video').readyState >= 2);
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://example.test/*' }))[0].id);
  const panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/panel.html`);
  const rpc = (type, data = {}) => panel.evaluate(async ({ type, data }) => {
    const reply = await chrome.runtime.sendMessage({ target: 'background', type, ...data });
    if (!reply.ok) throw Error(reply.error); return reply.data;
  }, { type, data });
  async function done(ids) {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const all = await rpc('list'); const jobs = ids.map(id => all.find(job => job.id === id));
      if (jobs.every(job => job && ['completed', 'failed', 'cancelled'].includes(job.stage))) {
        for (const job of jobs) assert.equal(job.stage, 'completed', JSON.stringify(job));
        return jobs;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw Error('Frame removal jobs timed out');
  }
  async function bytes(job) {
    return Uint8Array.from(await panel.evaluate(async id => {
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open('gif-toolkit', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      const blob = await new Promise((resolve, reject) => { const r = db.transaction('results').objectStore('results').get(id); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      db.close(); return [...new Uint8Array(await blob.arrayBuffer())];
    }, job.id));
  }
  async function decode(data) {
    return panel.evaluate(async values => {
      const decoder = new ImageDecoder({ data: Uint8Array.from(values), type: 'image/gif' }); await decoder.tracks.ready;
      const frames = [];
      for (let i = 0; i < decoder.tracks.selectedTrack.frameCount; i++) {
        const { image } = await decoder.decode({ frameIndex: i });
        const canvas = new OffscreenCanvas(image.displayWidth, image.displayHeight); const g = canvas.getContext('2d'); g.drawImage(image, 0, 0); image.close();
        const rgba = g.getImageData(0, 0, canvas.width, canvas.height).data;
        frames.push({ color: [...rgba.slice(0, 3)], opaque: rgba.filter((v, index) => index % 4 === 3 && v > 0).length });
      }
      decoder.close(); return frames;
    }, [...data]);
  }
  const sources = await rpc('scan', { tabId });
  const source = sources.find(source => source.title === 'Color holds'); assert.ok(source);
  await panel.locator('.source').filter({ hasText: 'Color holds' }).click();
  const control = panel.getByRole('combobox', { name: 'Drop frames', exact: true });
  assert.equal(await control.inputValue(), 'none');
  assert.equal(await control.locator('option').count(), 5);
  await control.selectOption('every3');
  await panel.screenshot({ path: resolve(artifacts, 'settings-0.1.5.png'), fullPage: true });
  await panel.getByRole('button', { name: 'Make GIF', exact: true }).click();
  await panel.waitForFunction(() => document.querySelector('.job'), null, { timeout: 15000 });
  const [uiJob] = await done((await rpc('list')).map(job => job.id));
  assert.equal(uiJob.settings.dropFrames, 'every3');
  await panel.reload();
  await panel.locator('.source').filter({ hasText: 'Color holds' }).click();
  await panel.waitForFunction(() => !document.querySelector('#drop-frames')?.disabled);
  assert.equal(await control.inputValue(), 'every3', 'chosen removal survives panel reload');
  await control.selectOption('none');
  await panel.locator('.job').first().getByRole('button', { name: 'Adjust clip', exact: true }).click();
  assert.equal(await control.inputValue(), 'every3', 'editing history restores its removal mode');
  const modes = ['none', 'duplicates', 'every2', 'every3', 'every4'];
  const items = modes.map(dropFrames => ({ source, settings: { ...settings, dropFrames }, segment: { id: dropFrames, start: 0, end: 1.2 } }));
  const jobs = await done(await rpc('enqueue', { items }));
  const original = ['r', 'r', 'r', 'g', 'b', 'b', 'r', 'g', 'g', 'g', 'g', 'b'];
  const expectedIndices = { none: [...original.keys()], duplicates: [0, 3, 4, 6, 7, 11], every2: [0, 2, 4, 6, 8, 10], every3: [0, 1, 3, 4, 6, 7, 9, 10], every4: [0, 1, 2, 4, 5, 6, 8, 9, 10] };
  const colors = { r: [255, 0, 0], g: [0, 255, 0], b: [0, 0, 255] };
  async function verify(job, indices, duration, fps) {
    const data = await bytes(job); const parsed = parseGIF(data.buffer);
    await writeFile(resolve(artifacts, `${job.settings.dropFrames}-${job.id}.gif`), data);
    const frames = parsed.frames.filter(frame => 'image' in frame);
    const decoded = await decode(data);
    assert.equal(frames.length, indices.length, job.settings.dropFrames);
    assert.deepEqual(decoded.map(frame => frame.color), indices.map(index => colors[original[index]]), job.settings.dropFrames);
    const times = indices.map(index => Math.round(index * 100 / fps));
    assert.deepEqual(frames.map(frame => frame.gce.delay), times.map((time, i) => (times[i + 1] ?? Math.round(duration * 100)) - time));
    assert.ok(Math.abs(job.result.duration - duration) < 0.011);
    assert.ok(data.length <= job.settings.maxBytes && parsed.lsd.width <= 800 && parsed.lsd.height <= 800);
    await writeFile(resolve(artifacts, job.result.filename), data);
  }
  for (const job of jobs) await verify(job, expectedIndices[job.settings.dropFrames], 1.2, 10);
  await verify(uiJob, expectedIndices.every3, 1.2, 10);
  console.log('PASS all modes: exact retained colors, every frame delay, dropped tails, repeats, default off and UI persistence');
  const [hold] = await done(await rpc('enqueue', { items: [{ ...items[1], segment: { id: 'hold', start: 0, end: 0.3 } }] }));
  await verify(hold, [0], 0.3, 10);
  const speedItems = [0.5, 2].map(speed => ({ ...items[1], settings: { ...settings, speed, dropFrames: 'duplicates' } }));
  const speedJobs = await done(await rpc('enqueue', { items: speedItems }));
  for (const job of speedJobs) {
    assert.ok(Math.abs(job.result.duration - 1.2 / job.settings.speed) < 0.011);
    assert.ok(job.result.frames < Math.ceil(12 / job.settings.speed));
  }
  console.log('PASS single retained frame, 0.5× and 2× preserve the selected clip duration');
  const fractional = await done(await rpc('enqueue', { items: [
    { source, settings: { ...settings, fps: 12, speed: 1.5, dropFrames: 'every3' }, segment: { id: 'fractional', start: 0, end: 1.2 } },
    { source, settings: { ...settings, fps: 12, speed: 2.5, dropFrames: 'every4' }, segment: { id: 'fractional-tail', start: 0, end: 1.1 } },
  ] }));
  for (const job of fractional) {
    const data = await bytes(job); const frames = parseGIF(data.buffer).frames.filter(frame => 'image' in frame);
    const duration = job.segment.end / job.settings.speed;
    const n = job.settings.dropFrames === 'every3' ? 3 : 4;
    const indices = Array.from({ length: Math.ceil(duration * 12) }, (_, i) => i).filter(i => (i + 1) % n !== 0);
    const times = indices.map(i => Math.round(i * 100 / 12));
    assert.deepEqual(frames.map(frame => frame.gce.delay), times.map((time, i) => (times[i + 1] ?? Math.round(duration * 100)) - time));
    assert.ok(Math.abs(job.result.duration - duration) < 0.011);
  }
  console.log('PASS fractional 12 fps clocks, 1.5×/2.5× and partial last-frame durations');
  const alpha = sources.find(source => source.title === 'Transparency');
  const alphaJobs = await done(await rpc('enqueue', { items: modes.filter(mode => mode !== 'none').map(dropFrames => ({ source: alpha, settings: { ...settings, dropFrames }, segment: { id: dropFrames, start: 0, end: 1 } })) }));
  for (const job of alphaJobs) {
    const decoded = await decode(await bytes(job));
    assert.ok(decoded.length > 1 && decoded.every(frame => frame.opaque >= 900 && frame.opaque <= 1050), 'transparent disposal must not leave trails');
    assert.ok(Math.abs(job.result.duration - 1) < 0.011);
  }
  console.log('PASS transparent WebP under all removal modes without residual pixels');
  const [compressed] = await done(await rpc('enqueue', { items: [{ source: sources.find(source => source.title === 'Portrait'), settings: { ...settings, dropFrames: 'every3', maxBytes: 50_000 }, segment: { id: 'budget', start: 0, end: 1.5 } }] }));
  // v0.1.6: size prediction and optimization precede this explicitly requested frame removal.
  assert.ok(compressed.attempt <= 4 && compressed.result.height < 800 && compressed.result.bytes <= 50_000, JSON.stringify({ result: compressed.result, metrics: compressed.metrics }));
  assert.equal(compressed.result.frames, 10, 'preserve the requested 10 fps clock before removing every third frame');
  assert.ok(Math.abs(compressed.result.duration - 1.5) < 0.011);
  console.log('PASS resize/optimization followed by explicit frame removal, with the requested clock preserved');
  assert.deepEqual(errors, []);
  await writeFile(resolve(artifacts, 'verification.json'), JSON.stringify({ date: new Date().toISOString(), version: manifest.version, jobs: [uiJob, ...jobs, hold, ...speedJobs, ...fractional, ...alphaJobs, compressed].map(({ settings, result, attempt }) => ({ settings, result, attempt })), errors }, null, 2));
} finally { await context.close(); }
