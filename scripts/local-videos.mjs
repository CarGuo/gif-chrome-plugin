import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { parseGIF } from 'gifuct-js';

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
// Exercise the shipped recorder helper with known pixels, without adding a production test hook.
await build({ entryPoints: ['src/shared/region-recorder.ts'], outfile: resolve(extension, 'recorder-check.js'), bundle: true, format: 'esm', target: 'chrome148' });
const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*'];
await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));

const context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, locale: 'en', viewport: null,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--enable-unsafe-extension-debugging', '--window-size=1000,1000'] });
const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15000 });
const extensionId = new URL(worker.url()).host;

const webPage = await context.newPage();
await webPage.goto(`${origin}/`);
const webTabId = await worker.evaluate(async origin => (await chrome.tabs.query({ url: origin + '/*' }))[0].id, origin);

const panel = await context.newPage();
await panel.goto(`chrome-extension://${extensionId}/panel.html`);

// v0.1.14: completion alone missed stretched crops and resources left running after sharing ended.
const recorderChecks = await panel.evaluate(async () => {
  const { createStreamRegionRecorder } = await import(chrome.runtime.getURL('recorder-check.js'));
  const canvas = document.createElement('canvas');
  canvas.width = 1800; canvas.height = 600;
  const ctx = canvas.getContext('2d');
  const draw = () => {
    ctx.fillStyle = '#ff00ff'; ctx.fillRect(0, 0, 1800, 600);
    ctx.fillStyle = '#00ff00'; ctx.fillRect(100, 100, 1600, 400);
    ctx.fillStyle = '#00ffff'; ctx.fillRect(500, 200, 400, 200);
  };
  draw();
  const inputFrames = window.setInterval(draw, 30);
  try {
    const region = { x: 100, y: 100, width: 1600, height: 400, viewportWidth: 1800, viewportHeight: 600 };
    const recorder = await createStreamRegionRecorder(canvas.captureStream(30), region);
    await new Promise(resolve => setTimeout(resolve, 250));
    const blob = await recorder.stop();
    const video = document.createElement('video'); video.muted = true;
    const url = URL.createObjectURL(blob); video.src = url;
    await video.play(); video.pause();
    await new Promise(resolve => { video.onseeked = resolve; video.currentTime = 0.1; });
    const output = document.createElement('canvas'); output.width = video.videoWidth; output.height = video.videoHeight;
    const outputCtx = output.getContext('2d'); outputCtx.drawImage(video, 0, 0);
    const pixels = [[20, 20], [300, 100]].map(([x, y]) => [...outputCtx.getImageData(x, y, 1, 1).data].slice(0, 3));
    const dimensions = [video.videoWidth, video.videoHeight];
    video.src = ''; URL.revokeObjectURL(url);

    const stream = canvas.captureStream(30), timers = new Set(), outputStreams = [];
    const originalSet = window.setInterval, originalClear = window.clearInterval;
    const originalCapture = HTMLCanvasElement.prototype.captureStream;
    let ended = 0;
    window.setInterval = (...args) => { const id = originalSet(...args); timers.add(id); return id; };
    window.clearInterval = id => { timers.delete(id); originalClear(id); };
    HTMLCanvasElement.prototype.captureStream = function(...args) { const captured = originalCapture.apply(this, args); outputStreams.push(captured); return captured; };
    try {
      await createStreamRegionRecorder(stream, region, () => ended++);
      stream.getVideoTracks()[0].dispatchEvent(new Event('ended'));
      return { dimensions, pixels, ended, activeTimers: timers.size,
        tracksEnded: [...stream.getTracks(), ...outputStreams.flatMap(s => s.getTracks())].every(t => t.readyState === 'ended') };
    } finally {
      for (const id of timers) originalClear(id);
      window.setInterval = originalSet; window.clearInterval = originalClear;
      HTMLCanvasElement.prototype.captureStream = originalCapture;
      stream.getTracks().forEach(track => track.stop()); outputStreams.forEach(s => s.getTracks().forEach(track => track.stop()));
    }
  } finally { window.clearInterval(inputFrames); }
});
assert.deepEqual(recorderChecks.dimensions, [800, 200], 'large region keeps its 4:1 aspect ratio');
assert.ok(recorderChecks.pixels[0][1] > 220 && recorderChecks.pixels[0][0] < 30 && recorderChecks.pixels[0][2] < 30, 'crop excludes the magenta surrounding area');
assert.ok(recorderChecks.pixels[1][1] > 220 && recorderChecks.pixels[1][2] > 220 && recorderChecks.pixels[1][0] < 30, 'crop preserves the cyan marker at its proportional position');
assert.equal(recorderChecks.ended, 1);
assert.equal(recorderChecks.activeTimers, 0, 'external sharing end releases the drawing timer');
assert.equal(recorderChecks.tracksEnded, true, 'external sharing end stops input and canvas tracks');
console.log('PASS region recorder: proportional crop pixels and sharing-end cleanup');

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

// v0.1.14: inspect the encoded MP4 in the browser. The old setpts-only path
// reported success while 2x/10x clips gained tail frames and slow clips lost time.
for (const [start, end, speed, fps] of [[1, 3, 0.5, 10], [1, 3, 2, 10], [1, 3, 10, 10], [0, 2.95, 1, 30], [0.01, 3, 1, 30]]) {
  await panel.getByRole('spinbutton', { name: 'Start (s)', exact: true }).fill(String(start));
  await panel.getByRole('spinbutton', { name: 'End (s)', exact: true }).fill(String(end));
  await panel.getByRole('spinbutton', { name: 'Frame rate' }).fill(String(fps));
  await panel.locator('#playback-speed').fill(String(speed));
  await panel.locator('.generate-video').click();
  await panel.waitForFunction(() => document.querySelectorAll('.job').length === 3 &&
    [...document.querySelectorAll('.job')].every(job => ['completed', 'failed'].includes(job.dataset.stage)), { timeout: 60000 });
  const job = panel.locator('.job').first();
  assert.equal(await job.getAttribute('data-stage'), 'completed', `trimmed ${speed}x video must encode`);
  await job.getByRole('button', { name: 'Preview video', exact: true }).click();
  await panel.waitForFunction(() => document.querySelector('.preview-modal video')?.readyState >= 2);
  const result = await panel.locator('.preview-modal video').evaluate(video => ({
    duration: video.duration, width: video.videoWidth, height: video.videoHeight,
  }));
  const expected = Math.ceil((end - start) / speed * fps - 1e-7) / fps;
  assert.ok(Math.abs(result.duration - expected) < 0.02, `[${start}, ${end}] at ${speed}x MP4 duration ${result.duration} must match ${expected}`);
  assert.deepEqual([result.width, result.height], [320, 180], 'trimmed MP4 preserves fitted dimensions');
  await panel.locator('.preview-close').click();
  await job.locator('.delete').click();
  await panel.waitForFunction(() => document.querySelectorAll('.job').length === 2);
}
console.log('PASS video export: decoded MP4 duration at 0.5x/2x/10x and sub-frame trim boundaries');
await panel.locator('#playback-speed').fill('1');
await panel.getByRole('spinbutton', { name: 'Frame rate' }).fill('10');
await panel.evaluate(async () => {
  const preferences = await chrome.runtime.sendMessage({ target: 'background', type: 'load-preferences' });
  if (!preferences?.ok) throw new Error(preferences?.error || 'load-preferences failed');
  const saved = await chrome.runtime.sendMessage({ target: 'background', type: 'save-preferences', settings: { ...preferences.data, speed: 1, fps: 10 } });
  if (!saved?.ok) throw new Error(saved?.error || 'save-preferences failed');
});

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
// Invoke the real extension action in this disposable browser, as a user does
// before recording. Host permissions alone do not grant tabCapture's activeTab access.
const browserSession = await context.browser().newBrowserCDPSession();
const { targetInfos } = await browserSession.send('Target.getTargets', { filter: [{ type: 'tab' }] });
const targetInfo = targetInfos.find(target => target.url === webPage.url());
assert.ok(targetInfo, 'the recording page has a browser tab target');
await browserSession.send('Extensions.triggerAction', { id: extensionId, targetId: targetInfo.targetId });
await browserSession.detach();
const staleTab = await context.newPage();
await staleTab.goto(`${origin}/stale`);
const staleTabId = await worker.evaluate(async origin => (await chrome.tabs.query({ url: origin + '/stale' }))[0].id, origin);
await worker.evaluate(tabId => chrome.storage.session.set({ activeTabId: tabId }), staleTabId);
await webPage.bringToFront();
const selectedTabId = await panel.evaluate(async () => {
  const res = await chrome.runtime.sendMessage({ target: 'background', type: 'start-region-select' });
  if (!res?.ok) throw new Error(res?.error || 'start-region-select failed');
  return res.data.tabId;
});
assert.equal(selectedTabId, webTabId, 'new recording follows the active page instead of the last scanned tab');
await webPage.waitForFunction(() => Boolean(document.querySelector('#gif-toolkit-region-root')), { timeout: 10000 });
await webPage.mouse.move(40, 40);
await webPage.mouse.down();
await webPage.mouse.move(280, 220, { steps: 8 });
await webPage.mouse.up();

await panel.waitForSelector('.region-record-card[data-stage="selected"]', { timeout: 10000 });
await webPage.screenshot({ path: resolve('test-results/region-page.png') });
await webPage.locator('#gif-toolkit-region-root [data-action="start-record"]').click();
await panel.waitForSelector('.region-record-card[data-stage="recording"]', { timeout: 15000 });
const lateEditStages = await worker.evaluate(async tabId => {
  const [frame] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: async () => {
    const stages = [];
    for (const type of ['region-updated', 'recording-reselect']) {
      const reply = await chrome.runtime.sendMessage({ target: 'background', type, region: { x: 0, y: 0, width: 40, height: 40, viewportWidth: innerWidth, viewportHeight: innerHeight } });
      if (!reply?.ok) throw Error(reply?.error || type);
      stages.push(reply.data.stage);
    }
    return stages;
  } });
  return frame.result;
}, webTabId);
assert.deepEqual(lateEditStages, ['recording', 'recording'], 'late edits from the recording tab cannot move it back to selection');
await new Promise(r => setTimeout(r, 900));
await panel.locator('.region-record-card').getByRole('button', { name: 'Save Video', exact: true }).click();
await panel.waitForFunction(() => document.querySelectorAll('[data-stage="completed"]').length === 3, { timeout: 60000 });
assert.equal(await panel.locator('.format-badge.video').count(), 2, 'region recording saved as MP4 video');
await panel.locator('.job').first().getByRole('button', { name: 'Preview video', exact: true }).click();
await panel.waitForFunction(() => document.querySelector('.preview-modal video')?.readyState >= 2);
const recordingVideo = await panel.locator('.preview-modal video').evaluate(async video => {
  video.pause();
  const canvas = document.createElement('canvas'); canvas.width = 60; canvas.height = 45;
  const ctx = canvas.getContext('2d');
  async function frame(time) {
    await new Promise(resolve => { video.onseeked = resolve; video.currentTime = time; });
    ctx.drawImage(video, 0, 0, 60, 45);
    return ctx.getImageData(0, 0, 60, 45).data;
  }
  const first = await frame(0.1), last = await frame(Math.min(0.6, video.duration - 0.1));
  return { width: video.videoWidth, height: video.videoHeight, duration: video.duration,
    difference: first.reduce((sum, value, i) => sum + (i % 4 === 3 ? 0 : Math.abs(value - last[i])), 0),
    background: [...first.slice((2 * 60 + 2) * 4, (2 * 60 + 2) * 4 + 3)] };
});
await writeFile(resolve('test-results/region-recording.mp4'), Buffer.from(await panel.locator('.preview-modal video').evaluate(async video => [...new Uint8Array(await (await fetch(video.src)).arrayBuffer())])));
assert.deepEqual([recordingVideo.width, recordingVideo.height], [240, 180], 'real tab recording preserves the selected region');
assert.ok(recordingVideo.duration >= 0.5 && recordingVideo.duration < 4, `real recording duration is plausible: ${recordingVideo.duration}`);
assert.ok(recordingVideo.difference > 5000, `recording contains changing page pixels, not a blank or frozen frame: ${JSON.stringify(recordingVideo)}`);
assert.ok(recordingVideo.background[2] > 35 && recordingVideo.background[0] < 45, `crop starts inside the fixture canvas: ${recordingVideo.background}`);
await panel.locator('.preview-close').click();

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
await panel.locator('.job').first().getByRole('button', { name: 'Preview GIF', exact: true }).click();
await panel.waitForFunction(() => document.querySelector('.preview-modal img')?.naturalWidth > 0);
const gifBytes = await panel.locator('.preview-modal img').evaluate(async img => [...new Uint8Array(await (await fetch(img.src)).arrayBuffer())]);
const gif = parseGIF(Uint8Array.from(gifBytes).buffer);
assert.deepEqual([gif.lsd.width, gif.lsd.height], [200, 160]);
assert.ok(gif.frames.filter(frame => 'image' in frame).length > 1, 'recording GIF contains multiple decoded frames');
await panel.locator('.preview-close').click();

console.log('PASS local videos: file picker + drag-and-drop import, Make GIF, Save Video, region screen recording');
await context.close();
server.close();
