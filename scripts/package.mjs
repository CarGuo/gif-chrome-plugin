import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { zip } from 'fflate';
const root = resolve('dist'); const files = {};
async function collect(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = resolve(folder, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (!entry.name.endsWith('.map')) files[relative(root, path).replaceAll('\\', '/')] = new Uint8Array(await readFile(path));
  }
}
await collect(root);
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
if (manifest.version !== pkg.version) throw new Error('Build version differs from package.json; rebuild before packaging.');
if (manifest.host_permissions) throw new Error('Refusing to package a test-only manifest with extra site permissions.');
for (const required of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'third_party/SOURCES.md', 'third_party/sources.lock.json']) {
  if (!files[required]?.length) throw new Error(`Missing release notice: ${required}`);
}
if (Object.keys(files).some(name => /(^|\/)(\.env(?:\..*)?|\.git|\.research|test-results|node_modules)(\/|$)/i.test(name))) throw new Error('Unexpected private or development files in dist.');
const output = resolve(`artifacts/gif-toolkit-chrome-${manifest.version}.zip`);
await mkdir('artifacts', { recursive: true });
await writeFile(output, await new Promise((resolve, reject) => zip(files, { level: 6 }, (error, data) => error ? reject(error) : resolve(data))));
console.log(output);
