import { describe, expect, it } from 'vitest';
import { candidates } from '../src/shared/encoding';
import { defaultSegment, DEFAULT_SETTINGS, fitDimensions, outputDuration, sampleCount, sampleTime, validateSegment, validateSettings, validateWorkload, type MediaSource } from '../src/shared/model';
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
  it('quality search never distorts or enlarges the input or exceeds user fps', () => {
    for (const [width, height] of [[1080, 1920], [96, 40], [2000, 40]]) {
      for (const c of candidates(width, height, { ...DEFAULT_SETTINGS, fps: 3 })) {
        expect(c.width).toBeLessThanOrEqual(Math.min(width, 800));
        expect(c.height).toBeLessThanOrEqual(Math.min(height, 800));
        expect(c.fps).toBeLessThanOrEqual(3);
        expect(Math.abs(c.width * height - c.height * width)).toBeLessThanOrEqual(Math.max(width, height));
      }
    }
  });
  it('compresses at the requested size and fps before any reduction, then re-optimizes each reduced level', () => {
    const plans = candidates(1920, 1080, DEFAULT_SETTINGS);
    expect(plans.slice(0, 3)).toEqual([256, 128, 64].map(colors => ({ width: 800, height: 450, fps: 10, colors })));
    expect(plans[3].width).toBeLessThan(800);
    expect(plans[3].fps).toBeLessThan(10);
    for (let index = 0; index < plans.length; index += 3) {
      const batch = plans.slice(index, index + 3);
      expect(batch.map(c => c.colors)).toEqual([256, 128, 64]);
      expect(new Set(batch.map(c => `${c.width}:${c.height}:${c.fps}`)).size).toBe(1);
    }
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
