import { parseGIF } from 'gifuct-js';
import { POLICY, TaskError } from './model';
import type { FramePlan } from './frame-plan';
export interface Candidate { width: number; height: number; fps: number; colors: number }
function frameFilter(candidate: Candidate, plan?: FramePlan) {
  const filter = `fps=${candidate.fps}:round=up:eof_action=pass,scale=${candidate.width}:${candidate.height}:flags=lanczos`;
  // v0.1.6: selection only changes timestamps. Do not force an intermediate pixel format;
  // let scale negotiate the palette filters' format. RGBA is required only for frame hashes.
  return plan ? `${filter},select='${plan.indices.map(index => `eq(n,${index})`).join('+')}'` : filter;
}
function frameInput(inputFps: number, inputPattern: string) {
  return ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-framerate', String(inputFps), '-i', inputPattern];
}
export function buildFrameHashArgs(candidate: Candidate, inputFps: number, inputPattern: string, output: string) {
  return [...frameInput(inputFps, inputPattern), '-filter_threads', '1', '-vf', `${frameFilter(candidate)},format=rgba`,
    '-c:v', 'rawvideo', '-fps_mode', 'passthrough', '-f', 'framehash', '-hash', 'sha256', '-y', output];
}
export function buildPaletteArgs(candidate: Candidate, inputFps: number, inputPattern: string, palette: string, plan?: FramePlan) {
  // v0.1.2: the palette must finish before paletteuse starts, so a full clip is not buffered in a split graph.
  // v0.1.5: count all retained pixels. The bundled FFmpeg diff histogram can miss a color
  // introduced by the last scene (exposed by dropping the tail), mapping that scene to a wrong color.
  return [...frameInput(inputFps, inputPattern), '-filter_threads', '1', '-vf',
    `${frameFilter(candidate, plan)},palettegen=max_colors=${candidate.colors}:reserve_transparent=1:stats_mode=full`,
    '-frames:v', '1', '-update', '1', '-y', palette];
}
export function buildEncodeArgs(candidate: Candidate, inputFps: number, inputPattern: string, output: string, palette = 'palette.png', plan?: FramePlan, finalDelay = plan?.finalDelay) {
  // v0.1.6: ordered dithering matches desktop gif-toolkit's video path. A stable spatial
  // pattern avoids propagating new diffusion noise across frames and improves GIF compression.
  const graph = `[0:v]${frameFilter(candidate, plan)}[frames];[frames][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
  return [...frameInput(inputFps, inputPattern), '-i', palette,
    '-filter_complex_threads', '1', '-filter_complex', graph, '-an', '-gifflags', '+offsetting+transdiff', '-loop', '0',
    ...(finalDelay !== undefined ? ['-fps_mode', 'passthrough', '-enc_time_base', '1:100', '-final_delay', String(finalDelay)] : []), '-y', output];
}
export function inspectGif(bytes: Uint8Array, expected: { maxBytes: number; maxSide: number; duration: number; fps: number; frames?: number }) {
  if (bytes.length < 14 || bytes[bytes.length - 1] !== 0x3b) throw new TaskError('invalidOutput');
  const parsed = parseGIF(bytes.slice().buffer as ArrayBuffer);
  if (parsed.header.signature !== 'GIF') throw new TaskError('invalidOutput');
  const frames = parsed.frames.filter(f => 'image' in f);
  // v0.1.5: a variable-rate plan must survive encoding without reinserted or lost frames.
  if (expected.frames !== undefined && frames.length !== expected.frames) throw new TaskError('invalidOutput');
  const duration = frames.reduce((sum, f) => sum + ('gce' in f ? (f.gce.delay || 0) / 100 : 0), 0);
  const { width, height } = parsed.lsd;
  if (!frames.length || width <= 0 || height <= 0 || width > Math.min(POLICY.maxSide, expected.maxSide) || height > Math.min(POLICY.maxSide, expected.maxSide)) throw new TaskError('invalidOutput');
  if (bytes.length > expected.maxBytes) throw new TaskError('budgetUnreachable');
  // GIF timing has 10 ms granularity; fps sampling may shift the boundary by one output frame.
  // v0.1.4: a single-frame result still has to preserve an animated source's selected duration.
  // Only an explicitly static source (expected duration 0) is exempt from timeline validation.
  const tolerance = expected.frames !== undefined ? 0.011 : 1 / expected.fps + 0.035;
  if (expected.duration > 0 && Math.abs(duration - expected.duration) > tolerance) throw new TaskError('invalidOutput');
  return { bytes: bytes.length, width, height, frames: frames.length, duration };
}
