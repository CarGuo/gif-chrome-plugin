import { describe, expect, it } from 'vitest';
import { defaultSegment, DEFAULT_SETTINGS, editSegment, fitDimensions, outputDuration, prepareSegment, sampleCount, sampleTime, validateSegment, validateSettings, validateWorkload, type MediaSource } from '../src/shared/model';
import en from '../src/locales/en.json';
import zh from '../src/locales/zh_CN.json';

describe('export contract', () => {
  it.each([[1920, 1080, 800, 450], [1080, 1920, 450, 800], [400, 300, 400, 300], [9000, 1000, 800, 88]])('caps both axes without enlarging %d × %d', (w, h, expectedW, expectedH) => {
    expect(fitDimensions(w, h, 800)).toEqual({ width: expectedW, height: expectedH });
  });
  it('does not lose a long-axis pixel through floating point multiplication', () => {
    expect(fitDimensions(854, 480, 480).width).toBe(480);
  });
  it('rejects NaN, infinity, negative budgets and a dimension above the product cap', () => {
    for (const maxBytes of [NaN, Infinity, -4, 0]) expect(() => validateSettings({ ...DEFAULT_SETTINGS, maxBytes })).toThrow();
    expect(() => validateSettings({ ...DEFAULT_SETTINGS, maxSide: 801 })).toThrow();
  });
  it('defines default MB in real bytes, not a rounded display comparison', () => {
    expect(validateSettings(DEFAULT_SETTINGS).maxBytes).toBe(4_000_000);
    expect(DEFAULT_SETTINGS.fps).toBe(10);
    expect(DEFAULT_SETTINGS.speed).toBe(1);
  });
  it('defaults to the full known source regardless of playhead and does not invent an unknown duration', () => {
    const source = { kind: 'video', duration: 82.45, currentTime: 76 } as MediaSource;
    expect(defaultSegment(source)).toMatchObject({ start: 0, end: 82.45 });
    expect(defaultSegment({ ...source, duration: null })).toMatchObject({ start: 0, end: 0 });
    expect(defaultSegment({ ...source, kind: 'webp', duration: 1.25 })).toMatchObject({ start: 0, end: 1.25 });
  });
  it('migrates pre-speed settings without losing a user frame-rate preference', () => {
    expect(validateSettings({ maxBytes: 4_000_000, maxSide: 800, fps: 12 })).toEqual({ maxBytes: 4_000_000, maxSide: 800, fps: 12, speed: 1, dropFrames: 'none' });
    for (const speed of [0, -1, NaN, Infinity, 0.09, 10.01]) expect(() => validateSettings({ ...DEFAULT_SETTINGS, speed })).toThrow();
  });
  it('resolves whole-source intent against downloaded metadata in either duration direction', () => {
    const source = { kind: 'video', duration: 127.893333 } as MediaSource;
    const full = prepareSegment(defaultSegment(source), source, 10, 5);
    expect(validateSegment(full, 127.85, 10, 5).end).toBe(127.85);
    expect(validateSegment(full, 128, 10, 5).end).toBe(128);
    const legacy = { id: 'old', start: 0, end: source.duration! };
    expect(validateSegment(prepareSegment(legacy, source, 10, 5), 127.85, 10, 5).end).toBe(127.85);
  });
  it('keeps manual trims fixed and does not hide a truly invalid end or start', () => {
    const source = { kind: 'video', duration: 127.893333 } as MediaSource;
    const full = defaultSegment(source);
    const tail = editSegment(full, { start: 120 }, source.duration);
    expect(validateSegment(tail, 127.85, 10, 5)).toMatchObject({ start: 120, end: 127.85 });
    const trim = editSegment(full, { start: 5, end: 10 }, source.duration);
    expect(validateSegment(trim, 127.85, 10, 5)).toMatchObject({ start: 5, end: 10, endMode: 'time' });
    expect(() => validateSegment(editSegment(full, { end: 127.89 }, source.duration), 127.85, 10, 5)).toThrow('invalidSegment');
    expect(() => validateSegment(editSegment(full, { start: 128 }, source.duration), 127.85, 10, 5)).toThrow('invalidSegment');
    expect(editSegment(trim, { end: source.duration! }, source.duration).endMode).toBe('source');
  });
  it('enforces the full-source frame budget using the file duration, not a page estimate', () => {
    const source = { kind: 'video', duration: 60.08 } as MediaSource;
    const selection = prepareSegment(defaultSegment(source), source, 10, 1);
    expect(() => validateSegment(selection, 60, 10, 1)).not.toThrow();
    expect(() => validateSegment(selection, 60.08, 10, 1)).toThrow('tooManyFrames');
    expect(() => prepareSegment({ ...selection, endMode: 'time' }, source, 10, 1)).toThrow('tooManyFrames');
  });
  it.each([0.5, 1, 1.5, 2, 10])('maps the complete source range to a constant output rate at %dx', speed => {
    const segment = { id: 'speed', start: 2, end: 8 };
    expect(outputDuration(segment, speed)).toBe(6 / speed);
    const count = sampleCount(segment, 10, speed);
    expect(count).toBe(Math.ceil(60 / speed));
    expect(sampleTime(segment, 0, 10, speed)).toBe(2);
    const last = sampleTime(segment, count - 1, 10, speed);
    expect(last).toBeLessThan(8);
    expect(8 - last).toBeLessThanOrEqual(speed / 10 + 1e-7);
  });
  it('applies the frame budget to output duration rather than unmodified source duration', () => {
    const segment = { id: 'a', start: 0, end: 120 };
    expect(() => validateSegment(segment, 120, 10, 2)).not.toThrow();
    expect(() => validateSegment(segment, 120, 10, 1)).toThrow();
    expect(() => validateSegment({ ...segment, end: 30.1 }, 120, 10, 0.5)).toThrow();
  });
  it('rejects invalid ranges and uses total sampled frames as the resource limit', () => {
    expect(() => validateSegment({ id: 'a', start: 12, end: 10 }, 20, 12)).toThrow();
    expect(() => validateSegment({ id: 'a', start: 12, end: 22 }, 20, 12)).toThrow();
    expect(() => validateSegment({ id: 'a', start: 0, end: 51 }, 100, 12)).toThrow();
    expect(() => validateSegment({ id: 'a', start: 40, end: 90 }, 100, 12)).not.toThrow();
  });
  it('bounds the decoded working set for streaming two-pass encoding separately from frame count', () => {
    expect(() => validateWorkload(800, 800, 600)).not.toThrow();
    expect(() => validateWorkload(5000, 5000, 1)).toThrow();
    expect(() => validateWorkload(100, 100, 601)).toThrow();
    expect(() => validateWorkload(400, 225, 60)).not.toThrow();
  });
});
describe('localization contract', () => {
  it('ships matching message keys and substitution schemas for both languages', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en)) {
      const left = (en as Record<string, { message: string; placeholders?: object }>)[key];
      const right = (zh as Record<string, { message: string; placeholders?: object }>)[key];
      expect(right.message.trim()).not.toBe('');
      expect(Object.keys(right.placeholders ?? {})).toEqual(Object.keys(left.placeholders ?? {}));
    }
  });
});
