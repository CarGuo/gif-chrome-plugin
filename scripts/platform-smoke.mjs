import { chromium } from 'playwright';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

// Public sample in a disposable Chromium profile. This never attaches to a user's logged-in browser.
const platform = process.env.TEST_PLATFORM ?? 'youtube';
const channel = process.env.TEST_BROWSER ?? 'chromium';
assert.ok(['chrome', 'chromium'].includes(channel));
const url = platform === 'vimeo' ? 'https://player.vimeo.com/video/1223244513?h=36ddeb3405&autoplay=1&muted=1' : 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
const origin = new URL(url).origin;
const expectedDuration = platform === 'vimeo' ? 49.06666666666667 : 634.601;
const folder = resolve(`test-results/platform-${platform}-extension`);
await mkdir(folder, { recursive: true }); await cp(resolve('dist'), folder, { recursive: true });
const manifest = JSON.parse(await readFile(resolve(folder, 'manifest.json'), 'utf8'));
manifest.host_permissions = platform === 'vimeo' ? ['https://*/*'] : ['https://www.youtube.com/*', 'https://*.googlevideo.com/*'];
manifest.content_scripts = [{ matches: [origin + '/*'], js: ['page-observer.js'], run_at: 'document_start', world: 'MAIN' }];
await writeFile(resolve(folder, 'manifest.json'), JSON.stringify(manifest));
const context = await chromium.launchPersistentContext('', { channel, headless: true,
  ...(channel === 'chrome' ? { ignoreDefaultArgs: ['--disable-extensions'] } : {}),
  args: [...(channel === 'chrome' ? ['--enable-unsafe-extension-debugging'] : [`--load-extension=${folder}`, `--disable-extensions-except=${folder}`]), '--autoplay-policy=no-user-gesture-required'] });
const report = { date: new Date().toISOString(), version: manifest.version, browser: context.browser().version(), url, status: 'unverified' };
try {
  if (channel === 'chrome') {
    const devtools = await context.browser().newBrowserCDPSession();
    await devtools.send('Extensions.loadUnpacked', { path: folder }); await devtools.detach();
  }
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage(); await page.bringToFront(); await page.goto(url, { waitUntil: 'commit', timeout: 45000, ...(platform === 'vimeo' ? {referer:'https://openai.com/index/gpt-6-astra-next-generation-work/'} : {}) });
  await page.waitForSelector('video', { timeout: 20000 });
  await page.locator('video').first().evaluate(video => { video.muted = true; return video.play(); });
  await page.waitForFunction(expected => document.querySelector('video')?.readyState >= 2 && Math.abs(document.querySelector('video')?.duration - expected) < 1 && !document.querySelector('.ad-showing'), expectedDuration, { timeout: 45000 });
  const tabId = await worker.evaluate(async origin => (await chrome.tabs.query({ url: origin + '/*' }))[0].id, origin);
  const panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/panel.html`); await page.bringToFront();
  const rpc = (type, data = {}) => panel.evaluate(async ({ type, data }) => {
    const reply = await chrome.runtime.sendMessage({ target: 'background', type, ...data });
    if (!reply.ok) throw Error(reply.error); return reply.data;
  }, { type, data });
  const source = (await rpc('scan', { tabId })).find(source => source.kind === 'video' && Math.abs(source.duration - expectedDuration) < 1);
  assert.ok(source);
  report.title = source.title; report.sourceDuration = source.duration; report.transport = source.resources?.map(r=>r.kind) ?? [];
  if (platform !== 'youtube') await page.locator('video').first().evaluate(video=>video.pause());
  await page.evaluate(() => { window.testSeeks = 0; document.querySelector('video').addEventListener('seeking', () => window.testSeeks++); });
  const [id] = await rpc('enqueue', { items: [{ source, settings: { maxBytes: 4000000, maxSide: 480, fps: 10, speed: 2 }, segment: { id: 'youtube-review', start: 10, end: 11 } }] });
  let job, lastStage;
  for (let attempt = 0; attempt < 600; attempt++) {
    job = (await rpc('list')).find(job => job.id === id);
    if (job && job.stage !== lastStage) { lastStage = job.stage; console.log('STAGE', job.stage, job.metrics?.downloadedBytes); }
    if (job && ['completed', 'failed', 'cancelled'].includes(job.stage)) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(job.stage, 'completed', JSON.stringify({ stage:job.stage, error:job.error, metrics:job.metrics }));
  assert.ok(job.result.bytes <= 4000000 && job.result.width <= 480 && job.result.height <= 480);
  assert.ok(Math.abs(job.result.duration - 0.5) < 0.11);
  assert.match(job.result.filename, /^[A-Za-z0-9_-]+_[0-9]{13}_[a-f0-9]{32}\.gif$/);
  assert.equal(await page.evaluate(() => window.testSeeks), 0);
  assert.ok(job.metrics.downloadMs > 0); assert.ok(Math.abs(job.metrics.downloadedDuration - expectedDuration) < 0.1, 'download must contain the complete video'); report.status = 'passed'; report.result = job.result; report.metrics = job.metrics;
  const resultUrl = await panel.evaluate(async id => (await chrome.runtime.sendMessage({ target: 'offscreen', type: 'result-url', id })).data, id);
  const bytes = await panel.evaluate(async url => [...new Uint8Array(await (await fetch(url)).arrayBuffer())], resultUrl);
  await writeFile(`test-results/platform-${platform}.gif`, Buffer.from(bytes));
  console.log('PASS', platform, 'full download and conversion:', report);
} catch (error) {
  report.error = String(error); console.error(platform, 'remains unverified:', report.error); process.exitCode = 1;
} finally {
  await writeFile(`test-results/platform-${platform}-verification.json`, JSON.stringify(report, null, 2));
  await context.close();
}
