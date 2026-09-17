import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { zip } from 'fflate';

// v0.1.5 release: distribute pinned source archives beside the unmodified GPL encoder binary.
// Build credentials are unnecessary: only public, fixed-revision source URLs are requested.
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const lock = JSON.parse(await readFile('third_party/sources.lock.json', 'utf8'));
const hash = data => createHash('sha256').update(data).digest('hex');
await mkdir('artifacts/vendor-sources', { recursive: true });
const files = {};
for (const source of lock.sources) {
  const path = `artifacts/vendor-sources/${source.filename}`;
  let bytes;
  try { bytes = await readFile(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!bytes) {
    const response = await fetch(source.url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw Error(`Source download failed: ${source.name} (${response.status})`);
    bytes = new Uint8Array(await response.arrayBuffer());
    if (hash(bytes) !== source.sha256) throw Error(`Source checksum mismatch: ${source.name}`);
    await writeFile(path, bytes);
  }
  if (hash(bytes) !== source.sha256) throw Error(`Cached source checksum mismatch: ${source.name}`);
  files[`sources/${source.filename}`] = [bytes, { level: 0 }];
  console.log(`Verified ${source.name}`);
}
// v0.1.6: retain the exact MPL-covered TypeScript sources used by the pinned package.
async function includeTree(directory, prefix) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`, key = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await includeTree(path, key);
    else files[key] = new Uint8Array(await readFile(path));
  }
}
await includeTree('node_modules/mediabunny/src', 'mediabunny/src');
for (const name of ['LICENSE', 'package.json']) files[`mediabunny/${name}`] = new Uint8Array(await readFile(`node_modules/mediabunny/${name}`));
files['SOURCES.md'] = new Uint8Array(await readFile('third_party/SOURCES.md'));
files['sources.lock.json'] = new Uint8Array(await readFile('third_party/sources.lock.json'));
files['LICENSE'] = new Uint8Array(await readFile('LICENSE'));
const output = `artifacts/gif-toolkit-chrome-${pkg.version}-third-party-sources.zip`;
await writeFile(output, await new Promise((resolve, reject) => zip(files, { level: 0 }, (error, data) => error ? reject(error) : resolve(data))));
console.log(output);
