import { describe, expect, it } from 'vitest';
import { planDroppedFrames, readFrameHashes } from '../src/shared/frame-plan';
import { DEFAULT_SETTINGS, validateSettings, type DropFrames } from '../src/shared/model';
import { migratePreferences } from '../src/shared/preferences';

const frames = (values: string[], fps = 10) => values.map((hash, index) => ({ index, time: index / fps, hash }));
describe('v0.1.5 optional frame removal', () => {
  it('defaults new and old settings/history to off, preserving selected modes', () => {
    expect(DEFAULT_SETTINGS.dropFrames).toBe('none');
    const { dropFrames: _, ...old } = DEFAULT_SETTINGS;
    expect(validateSettings(old).dropFrames).toBe('none');
    expect(migratePreferences({ exportPreferences: { version: 1, values: old } }).values.dropFrames).toBe('none');
    expect(migratePreferences({ exportPreferences: { version: 1, values: { ...old, dropFrames: 'duplicates' } } }).values.dropFrames).toBe('duplicates');
    expect(() => validateSettings({ ...old, dropFrames: 'garbage' as DropFrames })).toThrow('invalidSettings');
  });
  it.each([
    ['every2', [0, 2, 4, 6, 8], 20],
    ['every3', [0, 1, 3, 4, 6, 7, 9], 10],
    ['every4', [0, 1, 2, 4, 5, 6, 8, 9], 10],
  ] as const)('removes every Nth, retaining the original clock: %s', (mode, indices, finalDelay) => {
    expect(planDroppedFrames(frames('abcdefghij'.split('')), mode, 1)).toEqual({ indices, finalDelay });
  });
  it('only collapses consecutive identical frames, including head/tail holds', () => {
    expect(planDroppedFrames(frames(['a', 'a', 'b', 'b', 'a', 'a']), 'duplicates', 0.6)).toEqual({ indices: [0, 2, 4], finalDelay: 20 });
    expect(planDroppedFrames(frames(['a', 'a', 'a']), 'duplicates', 0.3)).toEqual({ indices: [0], finalDelay: 30 });
  });
  it('uses centisecond endpoints for fractional frame rates and drops padded endpoint frames', () => {
    expect(planDroppedFrames(frames(['a', 'b', 'c', 'd', 'e'], 12), 'every2', 0.31)).toEqual({ indices: [0, 2], finalDelay: 14 });
  });
  it('reads actual FFmpeg timestamps instead of inventing a constant frame count', () => {
    const report = `#format: frame checksums\n#tb 0: 1/12\n0, 0, 0, 1, 64, ${'a'.repeat(64)}\n0, 1, 1, 1, 64, ${'b'.repeat(64)}\n`;
    expect(readFrameHashes(report)).toEqual(frames(['a'.repeat(64), 'b'.repeat(64)], 12));
    expect(() => readFrameHashes(report.replace('#tb 0: 1/12', '#tb 0: 1/0'))).toThrow('invalidOutput');
    expect(() => readFrameHashes(report.replace('0, 1, 1', '0, 1, 0'))).toThrow('invalidOutput');
    expect(() => readFrameHashes('#tb 0: 1/10')).toThrow('invalidOutput');
  });
});
