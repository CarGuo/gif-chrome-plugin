import { describe, expect, it } from 'vitest';
import { acquisition, mediaOrigins } from '../src/shared/acquisition';
import { POLICY, type MediaSource } from '../src/shared/model';
import { createLocalSource, isLocalSource, LOCAL_PAGE_URL } from '../src/shared/local-source';
import { migrateJob } from '../src/shared/history';

const meta = { width: 1280, height: 720, duration: 12.5 };
const file = (name = 'clip.mp4', size = 1024) => new File([new Uint8Array(size)], name, { type: 'video/mp4' });

describe('local video sources', () => {
  it('builds a self-contained source with no tab, frame or network origin', () => {
    const source = createLocalSource(file('My Movie.mp4'), meta);
    expect(isLocalSource(source)).toBe(true);
    expect(source.local).toBe(true);
    expect(source.kind).toBe('video');
    expect(source.tabId).toBe(-1);
    expect(source.frameId).toBe(0);
    expect(source.pageUrl).toBe(LOCAL_PAGE_URL);
    expect(source.title).toBe('My Movie');
    expect(source.documentKey).toBe(`local:${source.id}`);
    expect(source.url).toBe(`local-file:${source.id}`);
    expect(source.width).toBe(1280);
    expect(source.height).toBe(720);
    expect(source.duration).toBe(12.5);
  });

  it('falls back to the full filename when there is no title stem', () => {
    expect(createLocalSource(file('.mp4'), meta).title).toBe('.mp4');
  });

  it('rejects empty or oversized files and unusable metadata explicitly', () => {
    expect(() => createLocalSource(file('empty.mp4', 0), meta)).toThrow('inputTooLarge');
    const huge = file('huge.mp4', POLICY.inputBytes + 1);
    expect(() => createLocalSource(huge, meta)).toThrow('inputTooLarge');
    expect(() => createLocalSource(file(), { width: 0, height: 720, duration: 1 })).toThrow('unsupportedVideo');
    expect(() => createLocalSource(file(), { width: 1280, height: 720, duration: NaN })).toThrow('unsupportedVideo');
  });

  it('is detected as the local acquisition path and requests no web origin', () => {
    const source = createLocalSource(file(), meta);
    expect(acquisition(source)).toBe('local');
    expect(mediaOrigins([source])).toEqual([]);
    const web = { kind: 'video', url: 'https://cdn.test/a.mp4', pageUrl: 'https://page.test/', duration: 1 } as MediaSource;
    expect(mediaOrigins([source, web])).toEqual(['https://cdn.test/*']);
  });

  it('does not treat ordinary web sources as local', () => {
    const web = { kind: 'video', local: false, url: 'https://cdn.test/a.mp4', pageUrl: 'https://page.test/' } as MediaSource;
    expect(isLocalSource(web)).toBe(false);
    expect(acquisition(web)).toBe('download');
  });

  it('survives history validation instead of being flagged as a damaged record', () => {
    const source = createLocalSource(file('History Clip.mp4'), meta);
    const record = {
      id: crypto.randomUUID(), source, segment: { id: crypto.randomUUID(), start: 0, end: 12.5 },
      settings: { maxBytes: 4000000, maxSide: 800, fps: 10, speed: 1, dropFrames: 'none' },
      stage: 'completed', progress: 1, createdAt: 1000, updatedAt: 1000,
      result: { bytes: 100, width: 1280, height: 720, duration: 12.5, frames: 125, filename: 'x.gif' },
    };
    const migrated = migrateJob(record);
    expect(migrated.source.id).toBe(source.id);
    expect(isLocalSource(migrated.source)).toBe(true);
    expect(migrated.result?.filename).toContain('.gif');
  });
});
