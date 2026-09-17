// v0.1.6: reproducible full-extension benchmark. Supply your own media; no remote fixture is committed.
// node scripts/benchmark.mjs <video.mp4> [--speed 5] [--channel chrome] [--x-post <url> --poster <url>]
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { parseGIF } = createRequire(import.meta.url)('gifuct-js');
const [filename, ...args] = process.argv.slice(2);
if (!filename) throw Error('Supply a video file path. Optional: --speed 5 --channel chrome --x-post URL --poster URL');
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const speed = Number(option('--speed', 5)), post = option('--x-post'), poster = option('--poster'), channel = option('--channel', 'chromium');
const presentationDuration = Number(option('--page-duration', 0));
const mime = option('--mime', 'video/mp4; codecs="avc1.640020"');
if (!['chrome', 'chromium'].includes(channel)) throw Error('--channel must be chrome or chromium');
if (post && !poster) throw Error('--x-post requires --poster to verify exact media identity');
const videoPath = resolve(filename), size = (await stat(videoPath)).size;
const artifacts = resolve('test-results', `${post ? 'benchmark-x' : 'benchmark'}${channel === 'chrome' ? '-chrome' : ''}`); await mkdir(artifacts, { recursive: true });
const safe = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const server = createServer(async (request, response) => {
  if (request.url === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<title>Pipeline benchmark</title><article><a href="${safe(post)}"><time>Source</time></a><video controls muted preload="auto" poster="${safe(poster)}" data-seeks="0"></video></article><script>
      const v=document.querySelector('video');v.addEventListener('seeking',()=>v.dataset.seeks=String(Number(v.dataset.seeks)+1));
      ${presentationDuration ? `
        window.ready=(async()=>{const media=new MediaSource();v.src=URL.createObjectURL(media);
        await new Promise(r=>media.addEventListener('sourceopen',r,{once:true}));
        const buffer=media.addSourceBuffer(${JSON.stringify(mime)});
        const bytes=await(await fetch('/input.mp4')).arrayBuffer();
        await new Promise(r=>{buffer.addEventListener('updateend',r,{once:true});buffer.appendBuffer(bytes);});
        media.duration=${presentationDuration};})();`
        : post ? "fetch('/input.mp4').then(r=>r.blob()).then(b=>v.src=URL.createObjectURL(b));" : "v.src='/input.mp4';"}
    </script>`); return;
  }
  if (request.url !== '/input.mp4') { response.writeHead(404); response.end(); return; }
  response.setHeader('Content-Type', 'video/mp4'); response.setHeader('Accept-Ranges', 'bytes');
  const range = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? '');
  const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (range) response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
  else response.setHeader('Content-Length', size);
  createReadStream(videoPath, { start, end }).pipe(response);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const extension = resolve(artifacts, 'extension'); await cp('dist', extension, { recursive: true });
const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*', ...(post ? ['https://cdn.syndication.twimg.com/*', 'https://video.twimg.com/*'] : [])];
await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
// Chrome 137+ removed --load-extension. Its supported DevTools loading method is restricted
// to this fresh temporary test profile, using the debugging pipe; never attach a user profile.
const context = await chromium.launchPersistentContext('', { channel, headless: true,
  ...(channel === 'chrome' ? { ignoreDefaultArgs: ['--disable-extensions'] } : {}),
  args: channel === 'chrome' ? ['--enable-unsafe-extension-debugging'] : [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
try {
  if (channel === 'chrome') {
    const devtools = await context.browser().newBrowserCDPSession();
    await devtools.send('Extensions.loadUnpacked', { path: extension }); await devtools.detach();
  }
  const background = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const id = new URL(background.url()).host;
  const page = await context.newPage(); await page.goto(origin);
  if (presentationDuration) await page.evaluate(() => window.ready);
  await page.waitForFunction(() => document.querySelector('video').readyState >= 2);
  const tabId = await background.evaluate(async origin => (await chrome.tabs.query({ url: origin + '/*' }))[0].id, origin);
  const panel = await context.newPage(); await panel.goto(`chrome-extension://${id}/panel.html`);
  const rpc = (type, data = {}) => panel.evaluate(async ({ type, data }) => {
    const reply = await chrome.runtime.sendMessage({ target: 'background', type, ...data });
    if (!reply.ok) throw Error(reply.error); return reply.data;
  }, { type, data });
  const [source] = await rpc('scan', { tabId });
  if (post) assert.equal(source.mediaPageUrl, post);
  if (presentationDuration) assert.ok(Math.abs(source.duration - presentationDuration) < 0.00001);
  const settings = { maxBytes: 4_000_000, maxSide: 800, fps: 10, speed, dropFrames: 'none' };
  const [jobId] = await rpc('enqueue', { items: [{ source, settings, segment: { id: 'full', start: 0, end: source.duration, endMode: 'source' } }] });
  const started = Date.now(), stages = []; let job;
  do {
    [job] = (await rpc('list')).filter(j => j.id === jobId);
    const status = `${job.stage}:${job.attempt ?? 0}`;
    if (stages.at(-1)?.status !== status) { stages.push({ status, ms: Date.now() - started }); console.log(status, Math.round((Date.now() - started) / 1000), 's'); }
    if (['completed', 'failed', 'cancelled'].includes(job.stage)) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() - started < 300_000);
  const report = { browser: context.browser()?.version(), version: manifest.version, inputBytes: size,
    acquisition: post ? 'X public resolver + real CDN download, using a controlled player fixture' : 'localhost download', post,
    presentation: { duration: source.duration, width: source.width, height: source.height, mse: !!presentationDuration }, job, stages };
  await writeFile(resolve(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  assert.equal(job.stage, 'completed', JSON.stringify({ stage: job.stage, error: job.error, metrics: job.metrics }));
  assert.equal(await page.locator('video').getAttribute('data-seeks'), '0', 'downloaded sources must never seek the page player');
  const data = await panel.evaluate(async id => {
    const database = await new Promise(resolve => { const r = indexedDB.open('gif-toolkit', 1); r.onsuccess = () => resolve(r.result); });
    const blob = await new Promise(resolve => { const r = database.transaction('results').objectStore('results').get(id); r.onsuccess = () => resolve(r.result); });
    return [...new Uint8Array(await blob.arrayBuffer())];
  }, jobId);
  const bytes = Uint8Array.from(data), gif = parseGIF(bytes.buffer), frames = gif.frames.filter(f => f.image);
  assert.ok(bytes.length <= settings.maxBytes);
  assert.equal(job.segment.end, job.metrics.downloadedDuration, 'a full clip ends at the downloaded file end');
  assert.ok(Math.abs(frames.reduce((s, f) => s + f.gce.delay / 100, 0) - job.metrics.downloadedDuration / speed) <= 0.011);
  assert.equal(frames.length, Math.ceil(job.metrics.downloadedDuration / speed * settings.fps - 1e-7), 'this case should fit without automatic frame removal');
  await writeFile(resolve(artifacts, 'output.gif'), bytes);
  console.log(JSON.stringify({ result: job.result, metrics: job.metrics }, null, 2));
} finally { await context.close(); await new Promise(resolve => server.close(resolve)); }
