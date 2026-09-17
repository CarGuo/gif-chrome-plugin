import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { unzipSync } from 'fflate';
import gifsicle from 'gifsicle-wasm-browser';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const sourceLock = JSON.parse(await readFile('third_party/sources.lock.json', 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const extensionName = `gif-toolkit-chrome-${pkg.version}.zip`;
const sourcesName = `gif-toolkit-chrome-${pkg.version}-third-party-sources.zip`;
const extensionBytes = await readFile(`artifacts/${extensionName}`);
const extension = unzipSync(extensionBytes);
const manifest = JSON.parse(new TextDecoder().decode(extension['manifest.json']));
assert.equal(manifest.version, pkg.version);
assert.equal(manifest.minimum_chrome_version, '148');
assert.equal(manifest.host_permissions, undefined, 'test-only access must not ship');
assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
for (const required of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'third_party/SOURCES.md', 'third_party/sources.lock.json', 'third_party/licenses/ffmpeg/COPYING.GPLv2', 'third_party/licenses/react/LICENSE', 'third_party/licenses/gifsicle/COPYING', 'third_party/licenses/gifsicle-wasm-browser/LICENSE', 'third_party/licenses/mediabunny/LICENSE', 'page-observer.js', 'third_party/licenses/googlevideo/LICENSE', 'third_party/licenses/mpd-parser/LICENSE', 'third_party/licenses/bufbuild-protobuf/LICENSE', 'third_party/licenses/bufbuild-protobuf/BSD-NOTICE.txt']) assert.ok(extension[required]?.length, `Missing ${required}`);
for (const name of Object.keys(extension)) {
  assert.ok(!/(^|\/)(\.env(?:\..*)?|\.git|\.research|test-results|node_modules)(\/|$)/i.test(name), `Unwanted file: ${name}`);
  assert.ok(!name.endsWith('.map'), `Source map in installation package: ${name}`);
}
for (const file of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  assert.equal(hash(extension[`ffmpeg/${file}`]), hash(await readFile(`node_modules/@ffmpeg/core/dist/esm/${file}`)), `Encoder changed: ${file}`);
}
assert.equal(hash(extension['gifsicle-worker.js']), hash(gifsicle.tool.workerLocalUrl), 'Gifsicle worker changed');
const sourcesBytes = await readFile(`artifacts/${sourcesName}`);
const sources = unzipSync(sourcesBytes);
assert.deepEqual(JSON.parse(new TextDecoder().decode(sources['sources.lock.json'])), sourceLock);
for (const source of sourceLock.sources) assert.equal(hash(sources[`sources/${source.filename}`]), source.sha256, `Source mismatch: ${source.name}`);
assert.ok(sources['mediabunny/LICENSE']?.length && sources['mediabunny/src/input.ts']?.length, 'Missing Mediabunny corresponding source');
const checksumText = `${hash(extensionBytes)}  ${extensionName}\n${hash(sourcesBytes)}  ${sourcesName}\n`;
await writeFile('artifacts/SHA256SUMS.txt', checksumText);
console.log(`Verified v${pkg.version}: clean install package, unchanged core, ${sourceLock.sources.length} pinned source archives. Checksums: artifacts/SHA256SUMS.txt`);
