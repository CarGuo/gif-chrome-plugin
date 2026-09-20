// v0.1.10: four real conversions, ID-based UI selection and actual Chrome disk downloads.
// Only disposable profiles and generated fixtures are used; no user history is modified.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const folder = resolve('test-results/results'); await mkdir(folder, { recursive: true });
const movie = await readFile('tests/fixtures/motion.mp4');
const pageTitle = '同一页面里的四个视频 / Four videos';
const server = createServer((request, response) => {
  if (/^\/clip-\d\.mp4$/.test(request.url)) {
    response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': movie.length }); response.end(movie);
  } else {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<title>${pageTitle}</title>${Array.from({ length: 4 }, (_, i) => `<video muted preload="auto" src="/clip-${i}.mp4"></video>`).join('')}`);
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const extension = join(folder, 'extension'); await cp('dist', extension, { recursive: true });
const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*']; await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
const profile = await mkdtemp(join(folder, 'profile-')), downloads = await mkdtemp(join(folder, 'downloads-'));
await mkdir(join(profile, 'Default'));
await writeFile(join(profile, 'Default/Preferences'), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }));
const channel = process.env.TEST_BROWSER ?? 'chromium'; assert.ok(['chrome', 'chromium'].includes(channel));
const context = await chromium.launchPersistentContext(profile, { channel, headless: true, viewport: { width: 430, height: 900 },
  ...(channel === 'chrome' ? { ignoreDefaultArgs: ['--disable-extensions'] } : {}),
  args: channel === 'chrome' ? ['--enable-unsafe-extension-debugging'] : [`--load-extension=${extension}`, `--disable-extensions-except=${extension}`] });
const checks = [], check = value => { checks.push(value); console.log('PASS', value); };
let panel;
const rpc = (type, data = {}) => panel.evaluate(async ({ type, data }) => {
  const reply = await chrome.runtime.sendMessage({ target: 'background', type, ...data });
  if (!reply.ok) throw Error(reply.error); return reply.data;
}, { type, data });
const expectedBytes = new Map();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  const devtools = await context.browser().newBrowserCDPSession();
  if (channel === 'chrome') await devtools.send('Extensions.loadUnpacked', { path: extension });
  // Keep Chrome's filename determination: Playwright's allow override bypasses it.
  await devtools.send('Browser.setDownloadBehavior', { behavior: 'default' }); await devtools.detach();
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage(); await page.goto(origin);
  await page.waitForFunction(() => [...document.querySelectorAll('video')].every(video => video.readyState >= 2));
  const tabId = await worker.evaluate(async origin => (await chrome.tabs.query({ url: origin + '/*' }))[0].id, origin);
  panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/panel.html`);
  const sources = await rpc('scan', { tabId }); assert.equal(sources.length, 4);
  assert.equal(new Set(sources.map(source => source.title)).size, 4);
  assert.deepEqual((await rpc('scan', { tabId })).map(source => source.title), sources.map(source => source.title));
  for (let i = 0; i < 4; i++) await panel.locator('.source').nth(i).click();
  await panel.getByRole('spinbutton', { name: 'Longest side', exact: false }).fill('320');
  // Different source ranges make every GIF distinct, exposing any wrong-ID/blob mix-up.
  for (let i = 0; i < 4; i++) {
    await panel.getByRole('spinbutton', { name: 'Start (s)', exact: true }).nth(i).fill(String(i * 0.5));
    await panel.getByRole('spinbutton', { name: 'End (s)', exact: true }).nth(i).fill(String(i * 0.5 + 0.3));
  }
  await panel.locator('.generate').click();
  await panel.waitForFunction(() => document.querySelectorAll('.job.completed, .job.failed').length === 4, null, { timeout: 120000 });
  let jobs = await rpc('list'); assert.ok(jobs.every(job => job.stage === 'completed'), JSON.stringify(jobs.map(job => [job.stage, job.error])));
  jobs.sort((a, b) => a.source.url.localeCompare(b.source.url));
  assert.equal(new Set(jobs.map(job => job.source.title)).size, 4);
  assert.equal(new Set(jobs.map(job => job.result.filename.split(`_${job.createdAt}_`)[0])).size, 4);
  for (const job of jobs) {
    const bytes = await panel.evaluate(async id => {
      const reply = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'result-url', id });
      if (!reply.ok) throw Error(reply.error);
      const bytes = [...new Uint8Array(await (await fetch(reply.data)).arrayBuffer())];
      await chrome.runtime.sendMessage({ target: 'offscreen', type: 'release-result-url', url: reply.data }); return bytes;
    }, job.id);
    expectedBytes.set(job.id, Buffer.from(bytes));
  }
  assert.equal(new Set([...expectedBytes.values()].map(hash)).size, 4);
  check('four same-page video selections produce distinct default names, filename prefixes and GIF contents');

  const card = id => panel.locator(`[data-job-id="${id}"]`);
  await card(jobs[1].id).getByRole('checkbox').check();
  await card(jobs[3].id).getByRole('checkbox').check();
  await panel.locator('.result-selection').getByText('2 selected', { exact: true }).waitFor();
  await panel.locator('.results').scrollIntoViewIfNeeded();
  const layout = await panel.locator('.result-list').evaluate(list => ({ height: list.clientHeight, scrollHeight: list.scrollHeight, overflow: getComputedStyle(list).overflowY, pageY: scrollY }));
  assert.ok(layout.height <= 560 && layout.scrollHeight > layout.height); assert.equal(layout.overflow, 'auto');
  await panel.locator('.result-list').evaluate(list => { list.scrollTop = 80; });
  assert.equal(await panel.evaluate(() => scrollY), layout.pageY, 'scrolling results must not move the page');
  await panel.locator('.result-list').evaluate(list => { list.scrollTop = 0; });
  await panel.locator('.results').screenshot({ path: join(folder, 'results-430.png') });
  await panel.setViewportSize({ width: 320, height: 800 });
  assert.ok(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await panel.locator('.results').screenshot({ path: join(folder, 'results-320.png') });
  await panel.setViewportSize({ width: 430, height: 900 });
  check('results scroll inside a bounded region; toolbar and two selections remain usable at 320 and 430 px');

  async function downloadRecords() { return worker.evaluate(() => chrome.downloads.search({})); }
  async function verifyDownloads(records, mapping) {
    for (const record of records) {
      let saved;
      for (let i = 0; i < 100; i++) {
        saved = await worker.evaluate(async id => (await chrome.downloads.search({ id }))[0], record.id);
        if (saved.state !== 'in_progress') break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(saved.state, 'complete', JSON.stringify(saved));
      const jobId = mapping(saved);
      assert.ok(jobId && expectedBytes.has(jobId), `Unexpected download ${basename(saved.filename)}`);
      assert.deepEqual(await readFile(saved.filename), expectedBytes.get(jobId), 'disk file must contain its own selected GIF');
    }
  }
  await panel.getByRole('button', { name: 'Save selected', exact: true }).click();
  await panel.getByRole('alert').getByText('2 GIFs sent to browser downloads.', { exact: true }).waitFor();
  const firstDownloads = await downloadRecords(); assert.equal(firstDownloads.length, 2);
  const selected = [jobs[1], jobs[3]];
  await verifyDownloads(firstDownloads, item => selected.find(job => item.filename.endsWith(job.result.filename))?.id);
  assert.equal(await panel.locator('.job-select:checked').count(), 0);
  check('Save selected downloads exactly the two checked IDs with matching filenames and disk bytes');

  // Same human-supplied title and same-millisecond creation still require distinct files.
  const batch = await rpc('download-many', { items: jobs.map(job => ({ id: job.id, title: 'Same custom name / 同名' })) });
  assert.equal(batch.failed.length, 0); assert.equal(batch.started.length, 4);
  const all = await downloadRecords();
  const four = all.filter(item => batch.started.some(started => started.downloadId === item.id));
  assert.equal(new Set(four.map(item => item.filename)).size, 4);
  await verifyDownloads(four, item => batch.started.find(started => started.downloadId === item.id)?.id);
  const again = await rpc('download', { id: jobs[0].id, title: 'Same custom name / 同名', saveAs: false });
  const repeat = (await downloadRecords()).filter(item => item.id === again);
  await verifyDownloads(repeat, () => jobs[0].id);
  assert.ok(!four.some(item => item.filename === repeat[0].filename));
  await verifyDownloads(four, item => batch.started.find(started => started.downloadId === item.id)?.id);
  check('four explicitly equal titles and repeated saves keep distinct files without replacing or mixing GIF bytes');

  // v0.1.11: submit through UI so per-item validation and retained selections are exercised.
  await card(jobs[0].id).getByRole('checkbox').check(); await card(jobs[2].id).getByRole('checkbox').check();
  await card(jobs[0].id).getByRole('textbox', { name: 'GIF name', exact: true }).fill('');
  const beforeInvalid = new Set((await downloadRecords()).map(item => item.id));
  await panel.getByRole('button', { name: 'Save selected', exact: true }).click();
  await panel.getByRole('alert').getByText(/1 downloads started; 1 could not start/).waitFor();
  assert.match(await panel.getByRole('alert').innerText(), /Same custom name.*Enter a GIF name/s);
  assert.equal(await card(jobs[0].id).getByRole('checkbox').isChecked(), true);
  assert.equal(await card(jobs[2].id).getByRole('checkbox').isChecked(), false);
  const validDespiteBlank = (await downloadRecords()).filter(item => !beforeInvalid.has(item.id)); assert.equal(validDespiteBlank.length, 1);
  await verifyDownloads(validDespiteBlank, () => jobs[2].id);
  await card(jobs[0].id).getByRole('textbox', { name: 'GIF name', exact: true }).fill('Rejected save');
  await card(jobs[2].id).getByRole('checkbox').check();
  await worker.evaluate(() => {
    globalThis.originalReviewDownload = chrome.downloads.download;
    let first = true;
    chrome.downloads.download = options => {
      if (!first) return globalThis.originalReviewDownload(options); first = false;
      return new Promise((resolve, reject) => { globalThis.rejectReviewDownload = () => reject(new Error('Injected download rejection')); });
    };
  });
  const beforeRejection = new Set((await downloadRecords()).map(item => item.id));
  await panel.getByRole('button', { name: 'Save selected', exact: true }).click();
  for (let i = 0; i < 100 && !await worker.evaluate(() => !!globalThis.rejectReviewDownload); i++) await new Promise(resolve => setTimeout(resolve, 20));
  await card(jobs[0].id).getByRole('button', { name: 'Preview GIF', exact: true }).click();
  assert.equal(await panel.getByRole('dialog').getByRole('button', { name: 'Save GIF', exact: true }).isDisabled(), true);
  await worker.evaluate(() => globalThis.rejectReviewDownload());
  await panel.getByRole('alert').getByText(/1 downloads started; 1 could not start/).waitFor();
  assert.match(await panel.getByRole('alert').innerText(), /could not be saved/);
  assert.doesNotMatch(await panel.getByRole('alert').innerText(), /encoder/);
  assert.equal(await panel.locator('.job-select:checked').count(), 1);
  const failedId = await panel.locator('.job-select:checked').evaluate(input => input.closest('[data-job-id]').dataset.jobId);
  const savedId = [jobs[0].id, jobs[2].id].find(id => id !== failedId);
  const validDespiteRejection = (await downloadRecords()).filter(item => !beforeRejection.has(item.id)); assert.equal(validDespiteRejection.length, 1);
  await verifyDownloads(validDespiteRejection, () => savedId);
  await panel.getByRole('dialog').getByRole('button', { name: 'Close preview', exact: true }).click();
  await worker.evaluate(() => { chrome.downloads.download = globalThis.originalReviewDownload; });
  await panel.locator('.job-select:checked').uncheck();
  check('blank names and native save rejection affect only their own item; UI identifies failures, retains selection and guards preview saves');

  await card(jobs[0].id).getByRole('checkbox').check(); await card(jobs[2].id).getByRole('checkbox').check();
  await rpc('clear-cache', { ids: [jobs[0].id] });
  await card(jobs[0].id).getByText('File cleared', { exact: true }).waitFor();
  await panel.locator('.result-selection').getByText('1 selected', { exact: true }).waitFor();
  assert.equal(await card(jobs[0].id).getByRole('checkbox').count(), 0);
  await panel.getByRole('button', { name: /^History/ }).click();
  await panel.getByRole('searchbox', { name: 'Search history' }).fill('No matching source');
  await panel.getByText('No history matches your search.', { exact: true }).waitFor();
  await panel.getByRole('searchbox', { name: 'Search history' }).fill('');
  await panel.locator('.result-selection').getByText('0 selected', { exact: true }).waitFor();
  const mixed = await rpc('download-many', { items: [jobs[1], jobs[0], jobs[3]].map(job => ({ id: job.id, title: job.source.title })) });
  assert.equal(mixed.started.length, 2); assert.deepEqual(mixed.failed, [{ id: jobs[0].id, error: 'resultUnavailable' }]);
  await verifyDownloads((await downloadRecords()).filter(item => mixed.started.some(started => started.downloadId === item.id)), item => mixed.started.find(started => started.downloadId === item.id)?.id);
  check('cleared/filtered results leave selection; a stale unavailable item is reported without mis-saving other IDs');

  await panel.getByRole('button', { name: 'Select all', exact: true }).click();
  await panel.locator('.result-selection').getByText('3 selected', { exact: true }).waitFor();
  const beforeClose = new Set((await downloadRecords()).map(item => item.id));
  await panel.getByRole('button', { name: 'Save selected', exact: true }).click(); await panel.close();
  let afterClose = [];
  for (let i = 0; i < 100; i++) {
    afterClose = (await downloadRecords()).filter(item => !beforeClose.has(item.id));
    if (afterClose.length === 3) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(afterClose.length, 3);
  await verifyDownloads(afterClose, item => jobs.find(job => item.filename.includes(job.id.replaceAll('-', '')))?.id);
  check('a submitted selection continues in the background after the panel closes');
} finally {
  const report = JSON.stringify({ date: new Date().toISOString(), version: manifest.version, channel, browser: context.browser().version(), checks }, null, 2);
  await writeFile(join(folder, 'verification.json'), report);
  await writeFile(join(folder, `verification-${channel}.json`), report);
  await context.close(); await new Promise(resolve => server.close(resolve));
}
