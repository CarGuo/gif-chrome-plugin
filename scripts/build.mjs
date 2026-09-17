import { build } from 'vite';
import { build as bundle } from 'esbuild';
import { mkdir, copyFile, writeFile, readFile, cp } from 'node:fs/promises';
import { resolve } from 'node:path';
import gifsicle from 'gifsicle-wasm-browser';

await build();
await bundle({ entryPoints: ['src/content.ts'], outfile: 'dist/content.js', bundle: true, format: 'iife', target: 'chrome148', sourcemap: true });
await bundle({ entryPoints: ['src/page-observer-entry.ts'], outfile: 'dist/page-observer.js', bundle: true, format: 'iife', target: 'chrome148', sourcemap: true });
// v0.1.6: emit the pinned upstream worker verbatim as packaged code, compatible with MV3 CSP.
await writeFile('dist/gifsicle-worker.js', gifsicle.tool.workerLocalUrl);
await mkdir('dist/ffmpeg', { recursive: true });
for (const file of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  await copyFile(resolve('node_modules/@ffmpeg/core/dist/esm', file), resolve('dist/ffmpeg', file));
}
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const manifest = {
  manifest_version: 3, name: '__MSG_appName__', description: '__MSG_appDescription__', version: pkg.version,
  minimum_chrome_version: '148', default_locale: 'en',
  // v0.1: frame blobs use bounded structured messages; JSON would silently destroy Blob data.
  message_serialization: 'structured_clone',
  permissions: ['contextMenus', 'activeTab', 'scripting', 'sidePanel', 'storage', 'downloads', 'offscreen'],
  optional_host_permissions: ['http://*/*', 'https://*/*'],
  action: { default_title: '__MSG_appName__' },
  background: { service_worker: 'background.js', type: 'module' },
  side_panel: { default_path: 'panel.html' },
  content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" }
};
await writeFile('dist/manifest.json', JSON.stringify(manifest, null, 2));
for (const lang of ['en', 'zh_CN']) {
  await mkdir(`dist/_locales/${lang}`, { recursive: true });
  await copyFile(`src/locales/${lang}.json`, `dist/_locales/${lang}/messages.json`);
}
await copyFile('THIRD_PARTY_NOTICES.md', 'dist/THIRD_PARTY_NOTICES.md');
// v0.1.5 release: installation archives must retain project and bundled-component notices.
await copyFile('LICENSE', 'dist/LICENSE');
await cp('third_party', 'dist/third_party', { recursive: true });
console.log('Load unpacked extension from:', resolve('dist'));
