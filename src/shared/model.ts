// v0.1: use decimal bytes throughout; 4 MiB can exceed a platform's 4 MB cap.
export const POLICY = {
  defaultBytes: 4_000_000, maxSide: 800, fps: 10, speed: 1, minSpeed: 0.1, maxSpeed: 10,
  staticImageSeconds: 1, decodedFrameBuffers: 8,
  inputBytes: 128 * 1024 * 1024, frameBytes: 160 * 1024 * 1024, decodedBytes: 512 * 1024 * 1024,
  maxFrames: 600, maxSourcePixels: 40_000_000, maxJobs: 24,
  spatialLevels: 8, paletteColors: [256, 128, 64], shrinkRatio: 0.82, minimumSide: 240, minimumFps: 6,
  networkTimeoutMs: 30_000, seekTimeoutMs: 15_000, historyCount: 30,
} as const;
export type MediaKind = 'video' | 'gif' | 'webp' | 'image';
export interface MediaSource {
  id: string; documentKey: string; tabId: number; frameId: number;
  kind: MediaKind; url: string; pageUrl: string; title: string;
  width: number; height: number; duration: number | null; currentTime: number;
  poster?: string; selected?: boolean; frameCount?: number;
}
export interface Segment { id: string; start: number; end: number }
export const DROP_FRAME_MODES = ['none', 'duplicates', 'every2', 'every3', 'every4'] as const;
export type DropFrames = typeof DROP_FRAME_MODES[number];
export interface ExportSettings { maxBytes: number; maxSide: number; fps: number; speed: number; dropFrames: DropFrames }
export type SavedExportSettings = Omit<ExportSettings, 'speed' | 'dropFrames'> & Partial<Pick<ExportSettings, 'speed' | 'dropFrames'>>;
export const DEFAULT_SETTINGS: ExportSettings = { maxBytes: POLICY.defaultBytes, maxSide: POLICY.maxSide, fps: POLICY.fps, speed: POLICY.speed, dropFrames: 'none' };
export type Stage = 'queued' | 'loading' | 'capturing' | 'encoding' | 'validating' | 'completed' | 'cancelled' | 'failed';
export interface Job {
  id: string; source: MediaSource; segment: Segment; settings: ExportSettings;
  stage: Stage; progress: number; createdAt: number; updatedAt: number;
  attempt?: number; error?: ErrorCode; detail?: string;
  result?: { bytes: number; width: number; height: number; duration: number; frames: number; filename: string };
}
export type ErrorCode = 'invalidName' | 'invalidSettings' | 'invalidSegment' | 'sourceGone' | 'sourceChanged' | 'sourceNotReady' | 'protectedMedia' | 'crossOriginPixels' | 'seekFailed' | 'inputTooLarge' | 'tooManyFrames' | 'downloadFailed' | 'permissionRequired' | 'unsupportedImage' | 'encodingFailed' | 'budgetUnreachable' | 'cancelled' | 'interrupted' | 'invalidOutput' | 'noMedia' | 'playerBusy' | 'pageUnavailable' | 'storageFull';
export class TaskError extends Error {
  constructor(public code: ErrorCode, message?: string) { super(message ?? code); }
}
export function errorCode(error: unknown): ErrorCode {
  if (error instanceof TaskError) return error.code;
  if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
  if (error instanceof DOMException && error.name === 'QuotaExceededError') return 'storageFull';
  return 'encodingFailed';
}
export const isTerminal = (stage: Stage) => ['completed', 'failed', 'cancelled'].includes(stage);
export function fitDimensions(width: number, height: number, limit: number) {
  if (![width, height, limit].every(v => Number.isFinite(v) && v > 0)) throw new TaskError('sourceNotReady');
  // v0.1: calculate the capped long axis as an integer. Multiplying a floating scale can turn 480 into 479.
  const longest = Math.min(Math.floor(limit), POLICY.maxSide, Math.max(width, height));
  return width >= height
    ? { width: longest, height: Math.max(1, Math.floor(height * longest / width)) }
    : { width: Math.max(1, Math.floor(width * longest / height)), height: longest };
}
export function validateSettings(settings: SavedExportSettings): ExportSettings {
  // v0.1.2: existing saved jobs/settings had no speed; schema migration means normal playback.
  const speed = settings?.speed === undefined ? POLICY.speed : settings.speed;
  // v0.1.5: additive migration keeps manual frame removal off for old preferences and job history.
  const dropFrames = settings?.dropFrames === undefined ? 'none' : settings.dropFrames;
  if (!settings || ![settings.maxBytes, settings.maxSide, settings.fps, speed].every(Number.isFinite) ||
    settings.maxBytes < 1024 || settings.maxBytes > POLICY.inputBytes ||
    settings.maxSide < 16 || settings.maxSide > POLICY.maxSide || !Number.isInteger(settings.maxSide) ||
    settings.fps < 1 || settings.fps > 30 || !Number.isInteger(settings.fps) ||
    speed < POLICY.minSpeed || speed > POLICY.maxSpeed || !DROP_FRAME_MODES.includes(dropFrames)) throw new TaskError('invalidSettings');
  return { ...settings, speed, dropFrames, maxBytes: Math.floor(settings.maxBytes) };
}
export function outputDuration(segment: Segment, speed: number) { return (segment.end - segment.start) / speed; }
export function sampleCount(segment: Segment, fps: number, speed: number) {
  return Math.max(1, Math.ceil(outputDuration(segment, speed) * fps - 1e-7));
}
export function sampleTime(segment: Segment, index: number, fps: number, speed: number) {
  // v0.1.2: map the output clock to original media BEFORE scaling or encoding. No cumulative seeking error.
  return segment.start + index * speed / fps;
}
export function validateSegment(segment: Segment, duration: number | null, fps: number, speed = POLICY.speed as number) {
  if (!Number.isFinite(speed) || speed < POLICY.minSpeed || speed > POLICY.maxSpeed) throw new TaskError('invalidSettings');
  if (!segment || !Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.start < 0 || segment.end <= segment.start ||
    (duration !== null && segment.end > duration + 0.001)) throw new TaskError('invalidSegment');
  if (sampleCount(segment, fps, speed) > POLICY.maxFrames) throw new TaskError('tooManyFrames');
  return segment;
}
export function validateWorkload(width: number, height: number, count: number) {
  // v0.1.2: two separate palette passes stream frames instead of retaining both complete RGBA streams.
  // Bound the live decoded working set; total frame count and PNG storage have separate limits.
  if (count > POLICY.maxFrames) throw new TaskError('tooManyFrames');
  if (width * height * 4 * POLICY.decodedFrameBuffers > POLICY.decodedBytes) throw new TaskError('inputTooLarge');
}
export function defaultSegment(source: MediaSource): Segment {
  // v0.1.2: the default is the entire source, independent of the current playhead. Unknown is not five seconds.
  return { id: crypto.randomUUID(), start: 0, end: source.duration ?? (source.frameCount === 1 ? POLICY.staticImageSeconds : 0) };
}
export const normalizeOutputName = (value: string) => value.replace(/\s+/g, ' ').trim();
export function validateOutputName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new TaskError('invalidName');
  return normalizeOutputName(value);
}
export function httpOrigin(url: string) {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new TaskError('pageUnavailable'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new TaskError('pageUnavailable');
  return `${parsed.origin}/*`;
}
export type Reply<T = unknown> = { ok: true; data: T } | { ok: false; error: ErrorCode };
export async function rpc<T = unknown>(message: unknown): Promise<T> {
  const response: Reply<T> = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new TaskError(response?.error ?? 'interrupted');
  return response.data;
}
