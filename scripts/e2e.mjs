import { chromium } from 'playwright';
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseGIF, decompressFrames } = require('gifuct-js');

const artifacts = resolve('test-results'); await mkdir(artifacts, { recursive: true });
const fixtureRoot = resolve('tests/fixtures');
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Motion study · GIF fixtures</title><style>body{background:#20332d;color:white;font:16px sans-serif}video,img{width:320px;display:block;margin:12px}</style><h1>Local media test</h1><video id="first" src="/motion.mp4" controls muted preload="auto" title="Motion study"></video><video id="second" src="/portrait.mp4" controls muted preload="auto" title="Portrait movement"></video><img src="/animation.gif" alt="Animated GIF"><img src="/animation.webp" alt="Animated WebP"><img src="/transparent.webp" alt="Transparent WebP">'); return;
  }
  try {
    const filename = resolve(fixtureRoot, '.' + path);
    if (!filename.startsWith(fixtureRoot + sep)) throw Error('invalid path');
    const body = await readFile(filename); const size = body.length;
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Content-Type', ({ '.mp4': 'video/mp4', '.gif': 'image/gif', '.webp': 'image/webp' })[extname(filename)] || 'application/octet-stream');
    response.setHeader('Accept-Ranges', 'bytes');
    if (request.headers.range) {
      const match = request.headers.range.match(/bytes=(\d+)-(\d*)/); const start = Number(match[1]); const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 }); response.end(body.subarray(start, end + 1));
    } else { response.setHeader('Content-Length', size); response.end(body); }
  } catch { response.statusCode = 404; response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const extension = resolve(artifacts, 'extension'); await cp(resolve('dist'), extension, { recursive: true });
const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
// Test-only origins model site access granted by the user. Production retains optional site access.
manifest.host_permissions = ['http://127.0.0.1/*', ...(process.env.TEST_YOUTUBE ? ['https://www.youtube.com/*'] : [])];
await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
const context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, locale: 'zh-CN', viewport: { width: 1024, height: 800 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--autoplay-policy=no-user-gesture-required'] });
const errors = [];
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
let worker;
try {
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15000 });
  const id = new URL(worker.url()).host;
  console.log('Browser', context.browser()?.version(), 'Extension loaded');
  const page = await context.newPage(); await page.goto(origin);
  await page.waitForFunction(() => [...document.querySelectorAll('video')].every(v => v.readyState >= 2));
  const tabId = await worker.evaluate(async origin => (await chrome.tabs.query({ url: origin + '/*' }))[0].id, origin);
  let panel = await context.newPage(); await panel.goto(`chrome-extension://${id}/panel.html`); await panel.setViewportSize({ width: 430, height: 1100 });
  const rpc = (type, data = {}) => panel.evaluate(async ({ type, data }) => { const r = await chrome.runtime.sendMessage({ target: 'background', type, ...data }); if (!r.ok) throw Error(r.error); return r.data; }, { type, data });
  const sources = await rpc('scan', { tabId }); assert.equal(sources.length, 5); console.log('PASS discovery: two videos, GIF and two WebP images');
  assert.equal(await panel.getByRole('spinbutton', { name: /Frame rate/ }).count(), 0, 'settings appear when a source is chosen');
  // Capture the genuine content-script context event and verify exact selection among two videos.
  await page.locator('#second').click({ button: 'right' });
  await rpc('scan', { tabId, focus: { frameId: 0, mediaType: 'video' } });
  await panel.waitForFunction(() => [...document.querySelectorAll('.source.selected')].some(el => el.textContent.includes('Portrait')));
  const selected = await worker.evaluate(() => chrome.storage.session.get('sources'));
  assert.equal(selected.sources.filter(s => s.selected).length, 1); assert.match(selected.sources.find(s => s.selected).title, /Portrait/);
  assert.equal(Number(await panel.locator('.clip-inputs input').nth(0).inputValue()), 0);
  assert.equal(Number(await panel.locator('.clip-inputs input').nth(1).inputValue()), sources.find(s => s.title === 'Portrait movement').duration);
  assert.equal(Number(await panel.getByRole('spinbutton', { name: /Frame rate/ }).inputValue()), 10);
  assert.equal(Number(await panel.getByRole('spinbutton', { name: /Speed/ }).inputValue()), 1);
  console.log('PASS right-click identity');
  await page.keyboard.press('Escape');
  const source = sources.find(s => s.title === 'Motion study');
  await page.locator('#first').evaluate(v => { v.pause(); v.currentTime = 0.3; });
  const settings = { maxBytes: 4_000_000, maxSide: 800, fps: 10, speed: 1 };
  const jobIds = await rpc('enqueue', { items: [
    { source, settings, segment: { id: 'a', start: 0.5, end: 1.5 } },
    { source: sources.find(s => s.title === 'Portrait movement'), settings, segment: { id: 'b', start: 0.2, end: 1.2 } },
    { source, settings, segment: { id: 'c', start: 1.8, end: 2.4 } },
  ] });
  async function awaitDone(ids, targetPanel = panel) {
    const start = Date.now(); let previous = '';
    while (Date.now() - start < 180_000) {
      const jobs = await targetPanel.evaluate(async () => (await chrome.runtime.sendMessage({ target: 'background', type: 'list' })).data);
      const selected = ids.map(id => jobs.find(j => j.id === id));
      const state = selected.map(j => `${j?.stage}:${j?.progress?.toFixed(2)}:${j?.error ?? ''}`).join(' | ');
      if (state !== previous) { console.log(state); previous = state; }
      if (selected.every(j => j && ['completed', 'failed', 'cancelled'].includes(j.stage))) return selected;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw Error('Tasks exceeded end-to-end timeout');
  }
  let completed = await awaitDone(jobIds); assert.ok(completed.every(j => j.stage === 'completed'), JSON.stringify(completed));
  assert.equal(completed[1].result.height, 800); assert.ok(completed[1].result.width < 800);
  const restored = await page.locator('#first').evaluate(v => ({ time: v.currentTime, paused: v.paused }));
  assert.ok(Math.abs(restored.time - 0.3) < 0.05); assert.equal(restored.paused, true);
  assert.equal(new Set(completed.map(job => job.result.filename)).size, 3);
  assert.ok(Math.abs(completed[2].result.duration - 0.6) < 0.11);
  console.log('PASS two ranges of one video plus a second video, unique filenames, portrait 800 px cap, player restoration');
  // Exercise the actual UI, then close/reopen it while the offscreen job is running.
  await panel.locator('.source').filter({ hasText: 'Portrait movement' }).click();
  await panel.locator('.source').filter({ hasText: 'Motion study' }).click();
  await panel.locator('.clip-inputs input').nth(1).fill('1');
  await panel.getByRole('spinbutton', { name: /Speed/ }).fill('2');
  assert.match(await panel.locator('.clip-output').innerText(), /0.5 s at 2/);
  await panel.getByRole('button', { name: 'Make GIF', exact: true }).click();
  await panel.waitForFunction(oldIds => [...document.querySelectorAll('[data-job-id]')].some(el => !oldIds.includes(el.getAttribute('data-job-id'))), jobIds);
  const uiId = (await rpc('list'))[0].id;
  await panel.close();
  panel = await context.newPage(); await panel.goto(`chrome-extension://${id}/panel.html`); await panel.setViewportSize({ width: 430, height: 1100 });
  const uiJob = (await awaitDone([uiId]))[0];
  assert.equal(uiJob.stage, 'completed'); assert.equal(uiJob.settings.speed, 2);
  assert.ok(Math.abs(uiJob.result.duration - 0.5) <= 0.11);
  console.log('PASS UI speed, predicted duration, full default selection and reopen during background processing');
  const speedIds = await rpc('enqueue', { items: [0.5, 2].map(speed => ({ source, settings: { ...settings, speed }, segment: { id: `speed-${speed}`, start: 0, end: source.duration } })) });
  const speedJobs = await awaitDone(speedIds);
  for (const job of speedJobs) {
    assert.equal(job.stage, 'completed', JSON.stringify(job));
    const expected = source.duration / job.settings.speed;
    assert.ok(Math.abs(job.result.duration - expected) < 0.11);
    assert.equal(job.result.frames, Math.ceil(expected * settings.fps));
  }
  console.log('PASS complete video at 0.5x and 2x with constant output frame rate');
  const compressedIds = await rpc('enqueue', { items: [{ source: sources.find(s => s.title === 'Portrait movement'), settings: { ...settings, maxBytes: 80_000 }, segment: { id: 'compress', start: 0, end: 1.5 } }] });
  const compressed = (await awaitDone(compressedIds))[0];
  assert.equal(compressed.stage, 'completed', JSON.stringify(compressed));
  assert.ok(compressed.attempt > 3); assert.ok(compressed.result.height < 800); assert.ok(compressed.result.bytes <= 80_000);
  assert.ok(Math.abs(compressed.result.duration - 1.5) < 0.2);
  console.log('PASS actual oversized clip: palette passes, then resize/drop frames, then recompress');
  // v0.1.4 regression: right-clicked animation must allow editing before generation, and a rescan
  // must preserve both decoded metadata and the user's ranges instead of silently selecting all.
  await page.locator('img').first().click({ button: 'right' });
  await rpc('scan', { tabId, focus: { frameId: 0, mediaType: 'image' } });
  await page.keyboard.press('Escape');
  await panel.getByRole('button', { name: 'Read animation to choose clips', exact: true }).click();
  const otherSelections = panel.locator('.source.selected').filter({ hasNotText: 'Animated GIF' });
  while (await otherSelections.count()) await otherSelections.first().click();
  const animationGroup = panel.locator('.clip-group').filter({ hasText: 'Animated GIF' });
  await animationGroup.locator('.clip-inputs input').nth(0).fill('0.1');
  await animationGroup.locator('.clip-inputs input').nth(1).fill('0.5');
  await animationGroup.getByRole('button', { name: '+ Add clip', exact: true }).click();
  await animationGroup.locator('.clip-inputs input').nth(2).fill('0.5');
  await animationGroup.locator('.clip-inputs input').nth(3).fill('0.9');
  const rescanned = await rpc('scan', { tabId });
  assert.equal(rescanned.find(s => s.title === 'Animated GIF').duration, 1);
  assert.ok(rescanned.find(s => s.title === 'Animated GIF').frameCount > 1);
  assert.deepEqual(await animationGroup.locator('.clip-inputs input').evaluateAll(inputs => inputs.map(input => Number(input.value))), [0.1, 0.5, 0.5, 0.9]);
  const beforeAnimation = (await rpc('list')).map(job => job.id);
  await panel.getByRole('button', { name: 'Make 2 GIFs', exact: true }).click();
  await panel.waitForFunction(oldIds => document.querySelectorAll('.job').length > oldIds.length, beforeAnimation);
  const editedIds = (await rpc('list')).filter(job => !beforeAnimation.includes(job.id)).map(job => job.id);
  assert.equal(editedIds.length, 2);
  const editedAnimations = await awaitDone(editedIds);
  assert.ok(editedAnimations.every(job => job.stage === 'completed'), JSON.stringify(editedAnimations));
  assert.deepEqual(editedAnimations.map(job => [job.segment.start, job.segment.end]).sort((a, b) => a[0] - b[0]), [[0.1, 0.5], [0.5, 0.9]]);
  assert.ok(editedAnimations.every(job => Math.abs(job.result.duration - 0.2) < 0.11));
  console.log('PASS right-click animation editing, rescan retains two chosen ranges, output durations and unique task results');
  const imageSources = sources.filter(s => s.kind !== 'video');
  const imageItems = [];
  for (const source of imageSources) {
    const meta = await rpc('inspect-image', { source }); assert.ok(meta.frames > 1); assert.ok(meta.duration > 0);
    imageItems.push({ source: { ...source, ...meta }, settings, segment: { id: source.id, start: 0, end: meta.duration } });
  }
  const imageIds = await rpc('enqueue', { items: imageItems });
  const imageJobs = await awaitDone(imageIds); assert.ok(imageJobs.every(j => j.stage === 'completed'), JSON.stringify(imageJobs));
  console.log('PASS real animated GIF and WebP conversion');
  const imageSpeedIds = await rpc('enqueue', { items: imageItems.map(item => ({ ...item, settings: { ...settings, speed: 2 } })) });
  const imageSpeedJobs = await awaitDone(imageSpeedIds);
  for (const job of imageSpeedJobs) {
    assert.equal(job.stage, 'completed', JSON.stringify(job));
    assert.ok(Math.abs(job.result.duration - job.source.duration / 2) < 0.11);
  }
  console.log('PASS animated GIF / WebP / transparency at 2x');
  const oversized = await rpc('enqueue', { items: [{ source, settings: { ...settings, maxBytes: 1024 }, segment: { id: 'hard', start: 0, end: 2 } }] });
  const rejected = (await awaitDone(oversized))[0]; assert.equal(rejected.stage, 'failed'); assert.equal(rejected.error, 'budgetUnreachable'); assert.equal(rejected.result, undefined);
  console.log('PASS impossible size target is not marked successful');
  const cancelIds = await rpc('enqueue', { items: [{ source, settings, segment: { id: 'cancel', start: 0, end: 2 } }] });
  await rpc('cancel', { id: cancelIds[0] });
  assert.equal((await awaitDone(cancelIds))[0].stage, 'cancelled'); console.log('PASS cancellation');
  await page.locator('#first').evaluate(v => { v.src = '/portrait.mp4'; v.load(); });
  await page.waitForFunction(() => document.querySelector('#first').readyState >= 2);
  const changedIds = await rpc('enqueue', { items: [{ source, settings, segment: { id: 'changed', start: 0, end: 1 } }] });
  const changed = (await awaitDone(changedIds))[0]; assert.equal(changed.stage, 'failed'); assert.equal(changed.error, 'sourceChanged');
  console.log('PASS reused player nodes cannot silently capture different content');
  await panel.screenshot({ path: resolve(artifacts, 'panel.png'), fullPage: true });
  // Read saved bytes from the same public extension storage used by the preview; parse using an independent reader.
  const artifactJobs = [...completed, ...imageJobs, ...speedJobs, ...imageSpeedJobs, compressed, ...editedAnimations];
  for (const job of artifactJobs) {
    const bytes = await panel.evaluate(async id => {
      const database = await new Promise((resolve, reject) => { const r = indexedDB.open('gif-toolkit', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      const blob = await new Promise((resolve, reject) => { const r = database.transaction('results').objectStore('results').get(id); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      return [...new Uint8Array(await blob.arrayBuffer())];
    }, job.id);
    const data = Uint8Array.from(bytes); const parsed = parseGIF(data.buffer); const frames = decompressFrames(parsed, true);
    assert.match(job.result.filename, /^[A-Za-z0-9_-]+_[0-9]{13}_[a-f0-9]{32}\.gif$/);
    assert.ok(job.result.filename.includes(`_${job.createdAt}_`));
    assert.ok(frames.length > 1); assert.ok(data.length <= job.settings.maxBytes); assert.ok(parsed.lsd.width <= 800 && parsed.lsd.height <= 800);
    assert.ok(frames.some(f => f.patch.some((v, i) => i % 4 !== 3 && v > 0)), 'must contain colored picture data, not just an alpha channel');
    if (job.source.title === 'Transparent WebP') {
      const opaqueCounts = await panel.evaluate(async bytes => {
        const decoder = new ImageDecoder({ data: Uint8Array.from(bytes), type: 'image/gif' }); await decoder.tracks.ready;
        const counts = [];
        for (let index = 0; index < decoder.tracks.selectedTrack.frameCount; index++) {
          const { image } = await decoder.decode({ frameIndex: index });
          const canvas = new OffscreenCanvas(image.displayWidth, image.displayHeight); const g = canvas.getContext('2d'); g.drawImage(image, 0, 0); image.close();
          const rgba = g.getImageData(0, 0, canvas.width, canvas.height).data;
          counts.push(rgba.filter((value, index) => index % 4 === 3 && value > 0).length);
        }
        decoder.close(); return counts;
      }, bytes);
      assert.ok(opaqueCounts.length > 1);
      assert.ok(opaqueCounts.every(count => count >= 900 && count <= 1050), `transparent disposal must not leave trails: ${opaqueCounts}`);
      console.log('PASS transparent animation compositing without trails');
    }
    await writeFile(resolve(artifacts, job.result.filename), data);
  }
  console.log('PASS independent decoding of saved artifacts');
  const queueSource = (await rpc('scan', { tabId })).find(s => s.title === 'Portrait movement');
  const admissions = await Promise.allSettled([0, 1, 2].map(batch => rpc('enqueue', { items: Array.from({ length: 12 }, (_, index) => ({ source: queueSource, settings: { ...settings, speed: 0.1 }, segment: { id: `race-${batch}-${index}`, start: 0, end: 3 } })) })));
  assert.equal(admissions.filter(r => r.status === 'fulfilled').length, 2);
  assert.equal(admissions.filter(r => r.status === 'rejected').length, 1);
  assert.match(String(admissions.find(r => r.status === 'rejected').reason), /playerBusy/);
  const admittedIds = admissions.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
  await Promise.all(admittedIds.map(id => rpc('cancel', { id })));
  const cancelledBatch = await awaitDone(admittedIds);
  assert.ok(cancelledBatch.every(job => job.stage === 'cancelled'));
  console.log('PASS concurrent queue admission stays within 24 jobs; cancellation isolates every admitted task');
  if (process.env.TEST_YOUTUBE) {
    const youtube = await context.newPage();
    await youtube.goto('https://www.youtube.com/watch?v=aqz-KE-bpKQ', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await youtube.waitForSelector('video', { timeout: 20000 });
    await youtube.locator('video').evaluate(v => { v.muted = true; return v.play(); });
    await youtube.waitForFunction(() => document.querySelector('video')?.readyState >= 2, { timeout: 25000 });
    const youtubeTab = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://www.youtube.com/*' }))[0].id);
    const ytSources = await rpc('scan', { tabId: youtubeTab });
    const yt = ytSources.find(s => s.kind === 'video' && s.duration > 10); assert.ok(yt);
    const ids = await rpc('enqueue', { items: [{ source: yt, settings: { ...settings, maxSide: 480, fps: 8 }, segment: { id: 'youtube', start: 10, end: 11 } }] });
    const jobs = await awaitDone(ids); assert.equal(jobs[0].stage, 'completed', JSON.stringify(jobs));
    console.log('PASS LIVE YOUTUBE:', jobs[0].result);
  }
  assert.deepEqual(errors, []);
  await writeFile(resolve(artifacts, 'verification.json'), JSON.stringify({ date: new Date().toISOString(), jobs: artifactJobs.map(j => ({ title: j.source.title, settings: j.settings, segment: j.segment, attempt: j.attempt, result: j.result })), youtube: !!process.env.TEST_YOUTUBE, errors }, null, 2));
  console.log('All end-to-end checks passed.');
} finally { await context.close(); await new Promise(resolve => server.close(resolve)); }
