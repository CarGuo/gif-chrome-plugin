import { describe, expect, it } from 'vitest';
import { makeFilename } from '../src/shared/filename';
import { inspectGif } from '../src/shared/encoding';
import { distinctSourceTitles, imageOrigins, initializeClips, retainImageMetadata } from '../src/shared/sources';
import type { MediaSource } from '../src/shared/model';

const source: MediaSource = { id: 'source', documentKey: 'document', tabId: 1, frameId: 0, kind: 'gif', url: 'https://cdn.test/a.gif', pageUrl: 'https://page.test', title: '猫咪 / hello world 🐱', width: 120, height: 80, duration: null, currentTime: 0 };
describe('v0.1.10 names for several media on one page', () => {
  const numbered = (title: string, index: number) => `Media ${String(index).padStart(2, '0')} · ${title}`;
  it('gives four same-title sources distinct names and Base64 prefixes before creating jobs', () => {
    const items = Array.from({ length: 4 }, (_, index) => ({ ...source, id: String(index), title: '相同的网页标题'.repeat(30) }));
    const named = distinctSourceTitles(items, numbered);
    expect(new Set(named.map(item => item.title)).size).toBe(4);
    expect(named.every(item => item.title.length <= 200)).toBe(true);
    expect(new Set(named.map(item => makeFilename({ source: item, id: 'same-id', createdAt: 1000 }))).size).toBe(4);
    expect(named.map(item => item.id)).toEqual(items.map(item => item.id));
  });
  it('preserves distinct titles and avoids collisions with existing numbered titles', () => {
    const items = ['A', 'Media 01 · A', 'A', 'Named video'].map((title, i) => ({ ...source, id: String(i), title }));
    expect(distinctSourceTitles(items, numbered).map(item => item.title)).toEqual(['Media 02 · A', 'Media 01 · A', 'Media 03 · A', 'Named video']);
    expect(distinctSourceTitles(items, numbered)).toEqual(distinctSourceTitles(items, numbered));
  });
});
describe('v0.1.4 filename contract', () => {
  const job = { source, id: 'abc12345-6789-4000-a123-0123456789ab', createdAt: 1789545600123 };
  it('encodes UTF-8 with filename-safe Base64 and includes the generation timestamp', () => {
    const filename = makeFilename(job);
    expect(filename).toMatch(/^[A-Za-z0-9_-]+_1789545600123_[a-f0-9]{32}\.gif$/);
    const prefix = filename.slice(0, filename.indexOf('_1789545600123_'));
    expect(Buffer.from(prefix, 'base64url').toString('utf8')).toBe(source.title);
    expect(filename).not.toMatch(/[\s\u0080-\uffff/\\+=]/);
    expect(makeFilename(job, '  猫咪   / hello world 🐱  ')).toBe(filename);
  });
  it('keeps a stable timestamp through rename and avoids same-millisecond collisions', () => {
    expect(makeFilename(job)).toBe(makeFilename(job));
    expect(makeFilename(job, 'Changed')).toContain(`_${job.createdAt}_`);
    expect(makeFilename({ ...job, id: crypto.randomUUID() })).not.toBe(makeFilename(job));
  });
  it('bounds filenames for multilingual titles without breaking encoded code points', () => {
    const name = makeFilename(job, '猫咪🐱'.repeat(40));
    expect(name.length).toBeLessThanOrEqual(150);
    const prefix = name.slice(0, name.indexOf(`_${job.createdAt}_`));
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(prefix, 'base64url'));
    expect('猫咪🐱'.repeat(40).startsWith(decoded)).toBe(true);
  });
});
describe('animation source metadata and clip preservation', () => {
  const inspected = { ...source, duration: 2.4, frameCount: 24 };
  it('retains decoded animation metadata across a scan of the same resource', () => {
    expect(retainImageMetadata([source], [inspected])[0]).toMatchObject({ duration: 2.4, frameCount: 24 });
  });
  it.each(['id', 'url', 'documentKey', 'pageUrl'] as const)('invalidates metadata when %s changes', key => {
    expect(retainImageMetadata([{ ...source, [key]: 'changed' }], [inspected])[0].duration).toBeNull();
  });
  it('initializes only unknown default ranges; preserves edited and multiple clips', () => {
    const edited = [{ id: 'first', start: 0.2, end: 0.6 }, { id: 'second', start: 1.2, end: 1.8 }];
    expect(initializeClips(edited, inspected)).toEqual(edited);
    expect(initializeClips([{ id: 'pending', start: 0, end: 0 }], inspected)[0]).toMatchObject({ start: 0, end: 2.4 });
    expect(initializeClips([], inspected)).toEqual([]);
  });
  it('refreshes the preview end of an end-of-source selection without moving a fixed trim', () => {
    const full = { id: 'full', start: 0.2, end: 2.48, endMode: 'source' as const };
    const manual = { id: 'manual', start: 0.2, end: 1.8, endMode: 'time' as const };
    expect(initializeClips([full, manual], inspected)).toEqual([{ ...full, end: 2.4 }, manual]);
  });
  it('collects image origins once and excludes video and data URLs', () => {
    expect(imageOrigins([source, { ...source, url: 'https://cdn.test/b.webp' }, { ...source, url: 'https://other.test/c.gif' }, { ...source, kind: 'video' }, { ...source, url: 'data:image/gif;base64,R0lGOD' }])).toEqual(['https://cdn.test/*', 'https://other.test/*']);
  });
});
describe('single-frame output timing', () => {
  const bytes = Uint8Array.from(Buffer.from('47494638396101000100800000000000ffffff21f904000a0000002c00000000010001000002024401003b', 'hex'));
  it('rejects an animated clip collapsed to a short single frame', () => {
    expect(() => inspectGif(bytes, { maxBytes: 4000000, maxSide: 800, duration: 4, fps: 10 })).toThrow('invalidOutput');
  });
  it('allows true static images and short clips within GIF timing precision', () => {
    for (const duration of [0, 0.1]) expect(inspectGif(bytes, { maxBytes: 4000000, maxSide: 800, duration, fps: 10 }).frames).toBe(1);
  });
});
