import { fitDimensions, POLICY, type ExportSettings } from './model';
import type { Candidate } from './encoding';

// v0.1.6: measure a few short windows across the sped-up timeline, including its tail.
// Contiguous windows preserve inter-frame compression; one thumbnail cannot estimate GIF size.
export function probeIndices(count: number): number[] {
  if (count <= POLICY.probeFrames) return Array.from({ length: count }, (_, i) => i);
  const window = POLICY.probeFrames / POLICY.probeWindows;
  return [...new Set(Array.from({ length: POLICY.probeWindows }, (_, i) => Math.floor((count - window) * i / (POLICY.probeWindows - 1)))
    .flatMap(start => Array.from({ length: window }, (_, i) => start + i)))];
}

export function estimateSize(probe: { bytes: number; width: number; height: number; frames: number }, width: number, height: number, frames: number): number {
  return probe.bytes * (width * height) / (probe.width * probe.height) * frames / probe.frames;
}

export function predictedDimensions(width: number, height: number, bytes: number, settings: ExportSettings) {
  const base = fitDimensions(width, height, settings.maxSide);
  const minimum = Math.min(POLICY.minimumSide, Math.max(base.width, base.height));
  const ratio = bytes <= settings.maxBytes ? 1 : Math.sqrt(settings.maxBytes * POLICY.fitHeadroom / bytes);
  return fitDimensions(width, height, Math.max(minimum, Math.floor(Math.max(base.width, base.height) * ratio)));
}

export function nextDimensions(candidate: Candidate, bytes: number, settings: ExportSettings, source = candidate): Candidate | undefined {
  const side = Math.max(candidate.width, candidate.height);
  const minimum = Math.min(POLICY.minimumSide, settings.maxSide);
  if (side <= minimum || bytes <= settings.maxBytes) return;
  // Same area model as desktop gif-toolkit: react to measured bytes, not a fixed size ladder.
  const next = Math.max(minimum, Math.min(side - 1, Math.floor(side * Math.sqrt(settings.maxBytes * POLICY.fitHeadroom / bytes))));
  return { ...candidate, ...fitDimensions(source.width, source.height, next) };
}

export function lastResortFps(candidate: Candidate, bytes: number, settings: ExportSettings): Candidate | undefined {
  const minimum = Math.min(POLICY.minimumFps, settings.fps);
  if (Math.max(candidate.width, candidate.height) > Math.min(POLICY.minimumSide, settings.maxSide)) return;
  if (candidate.fps <= minimum || bytes <= settings.maxBytes) return;
  const fps = Math.max(minimum, Math.min(candidate.fps - 1, Math.floor(candidate.fps * settings.maxBytes * POLICY.fitHeadroom / bytes)));
  return { ...candidate, fps };
}

export function nextLossy(bytes: number, maxBytes: number, previous = 0): number | undefined {
  if (bytes <= maxBytes || previous >= POLICY.maxLossy) return;
  return Math.min(POLICY.maxLossy, Math.max(previous + POLICY.lossyStep, Math.ceil((previous || POLICY.lossyStep) * bytes / maxBytes)));
}
