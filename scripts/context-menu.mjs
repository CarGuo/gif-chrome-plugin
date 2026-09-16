import { chromium } from 'playwright';
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';

// v0.1.1 regression: model a site that cancels contextmenu at window capture, before bubbling.
const server = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(`<!doctype html><title>Context menu regression</title>
    <script>window.siteMenus = []; window.addEventListener('contextmenu', event => {
      window.siteMenus.push(event.target.id); event.preventDefault();
    }, true);</script>
    <style>.player{display:inline-block;position:relative;width:240px;height:160px}video{width:100%;height:100%}.overlay{position:absolute;inset:0}button{position:absolute;bottom:0;left:8px}</style>
    <article><p id="text">Ordinary article text</p>
    <div class="player"><video id="first" title="First"></video><div id="overlay-first" class="overlay"></div><button id="control">Player settings</button></div>
    <div class="player"><video id="second" title="Second"></video><div id="overlay-second" class="overlay"></div></div></article>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const extension = resolve('test-results/context-menu-extension');
await mkdir(extension, { recursive: true }); await cp(resolve('dist'), extension, { recursive: true });
const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*'];
await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
const context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  await worker.evaluate(() => chrome.scripting.registerContentScripts([{
    id: 'site-regression', matches: ['http://127.0.0.1/*'], js: ['content.js'], runAt: 'document_start', allFrames: true,
  }]));
  const page = await context.newPage(); await page.goto(origin);
  const tabId = await worker.evaluate(async origin => (await chrome.tabs.query({ url: origin + '/*' }))[0].id, origin);
  const scan = () => worker.evaluate(async tabId => {
    const result = await chrome.tabs.sendMessage(tabId, { target: 'content', type: 'scan', focus: { useContext: true } });
    return result.data.filter(source => source.selected).map(source => source.title);
  }, tabId);
  await page.locator('#overlay-second').click({ button: 'right' });
  assert.deepEqual(await scan(), ['Second']);
  assert.deepEqual(await page.evaluate(() => window.siteMenus), []);
  // A cancelled DOM event suppresses the native menu. Verify the extension leaves this default intact.
  assert.equal(await page.locator('#overlay-second').evaluate(target => {
    const rect = target.getBoundingClientRect();
    return target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, composed: true, clientX: rect.x + 30, clientY: rect.y + 30 }));
  }), true);
  await page.keyboard.press('Escape');
  await page.locator('#overlay-first').click({ button: 'right', modifiers: ['Alt'] });
  assert.deepEqual(await page.evaluate(() => window.siteMenus), ['overlay-first']);
  await page.locator('#text').click({ button: 'right' }); assert.deepEqual(await scan(), []);
  await page.locator('#control').click({ button: 'right' }); assert.deepEqual(await scan(), []);
  assert.deepEqual(await page.evaluate(() => window.siteMenus), ['overlay-first', 'text', 'control']);
  await page.reload();
  await page.locator('#overlay-first').click({ button: 'right' });
  assert.deepEqual(await scan(), ['First']); assert.deepEqual(await page.evaluate(() => window.siteMenus), []);
  console.log('PASS native-menu default, early site interception, exact overlay target, Alt site menu, ordinary text / controls, reload persistence');
} finally { await context.close(); await new Promise(resolve => server.close(resolve)); }
