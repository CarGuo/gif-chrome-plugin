import { describe, expect, it } from 'vitest';
import { estimateSize, lastResortFps, nextDimensions, nextLossy, predictedDimensions, probeIndices } from '../src/shared/fit';
import { DEFAULT_SETTINGS, outputDuration, POLICY, sampleCount } from '../src/shared/model';

describe('v0.1.6 speed → estimate/resize → optimize → frame reduction', () => {
  it('estimates the screenshot workload from the sped-up clock, covering its tail', () => {
    const segment = { id: 'full', start: 0, end: 127.85 };
    const count = sampleCount(segment, 10, 5);
    expect(outputDuration(segment, 5)).toBe(25.57);
    expect(count).toBe(256);
    const indices = probeIndices(count);
    expect(indices).toHaveLength(POLICY.probeFrames);
    expect(indices[0]).toBe(0);
    expect(indices.at(-1)).toBe(255);
    expect(new Set(indices).size).toBe(indices.length);
    expect(indices.every(i => i >= 0 && i < count)).toBe(true);
    expect(probeIndices(3)).toEqual([0, 1, 2]);
  });
  it('scales measured bytes by area and output frame count, avoiding needless full-size encodes', () => {
    const probe = { bytes: 120_000, width: 320, height: 200, frames: 12 };
    const bytes = estimateSize(probe, 800, 500, 256);
    expect(bytes).toBe(16_000_000);
    expect(predictedDimensions(1152, 720, bytes, DEFAULT_SETTINGS)).toEqual({ width: 387, height: 241 });
    expect(estimateSize(probe, 800, 500, 128)).toBe(bytes / 2);
  });
  it('keeps requested size for fitting clips and respects source aspect ratio, caps and quality floor', () => {
    expect(predictedDimensions(1920, 1080, 1000, DEFAULT_SETTINGS)).toEqual({ width: 800, height: 450 });
    expect(predictedDimensions(96, 40, 1e9, DEFAULT_SETTINGS)).toEqual({ width: 96, height: 40 });
    for (const [width, height] of [[1920, 1080], [1080, 1920], [40, 2000]]) {
      const dims = predictedDimensions(width, height, 1e8, DEFAULT_SETTINGS);
      expect(Math.max(dims.width, dims.height)).toBe(240);
      expect(Math.abs(dims.width * height - dims.height * width)).toBeLessThanOrEqual(Math.max(width, height));
    }
  });
  it('corrects dimensions from actual bytes without reducing fps or palette colors', () => {
    const candidate = { width: 600, height: 375, fps: 10, colors: 256 };
    const next = nextDimensions(candidate, 8_000_000, DEFAULT_SETTINGS)!;
    expect(next).toMatchObject({ fps: 10, colors: 256 });
    expect(next.width).toBe(411);
    expect(nextDimensions(next, 5_000_000, DEFAULT_SETTINGS)?.width).toBe(356);
    expect(nextDimensions({ ...next, width: 240, height: 150 }, 5_000_000, DEFAULT_SETTINGS)).toBeUndefined();
    expect(nextDimensions({ ...candidate, width: 301, height: 188 }, 4_059_092, DEFAULT_SETTINGS)?.width).toBeGreaterThan(280);
  });
  it('bounds optimization and last-resort fps by their floors and never goes below a lower user rate', () => {
    expect(nextLossy(8e6, 4e6)).toBe(80);
    expect(nextLossy(8e6, 4e6, 80)).toBe(120);
    expect(nextLossy(8e6, 4e6, 120)).toBeUndefined();
    expect(nextLossy(3e6, 4e6)).toBeUndefined();
    const candidate = { width: 240, height: 150, fps: 10, colors: 256 };
    expect(lastResortFps(candidate, 8e6, DEFAULT_SETTINGS)).toEqual({ ...candidate, fps: 6 });
    expect(lastResortFps({ ...candidate, width: 600, height: 375 }, 8e6, DEFAULT_SETTINGS)).toBeUndefined();
    expect(lastResortFps({ ...candidate, fps: 3 }, 8e6, { ...DEFAULT_SETTINGS, fps: 3 })).toBeUndefined();
  });
});
