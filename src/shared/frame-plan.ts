import { POLICY, TaskError, type DropFrames } from './model';

export interface FrameStamp { index: number; time: number; hash: string }
export interface FramePlan { indices: number[]; finalDelay: number }

// v0.1.5: FFmpeg hashes full RGBA frames in its worker, including alpha. Comparing adjacent
// rendered frames avoids the approximate motion thresholds and alpha loss of mpdecimate.
export function readFrameHashes(text: string): FrameStamp[] {
  const timeBase = text.match(/^#tb\s+0:\s*(\d+)\/(\d+)\s*$/m);
  if (!timeBase || Number(timeBase[1]) <= 0 || Number(timeBase[2]) <= 0) throw new TaskError('invalidOutput');
  const scale = Number(timeBase[1]) / Number(timeBase[2]);
  const frames: FrameStamp[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const fields = line.split(',').map(value => value.trim());
    const pts = Number(fields[2]);
    if (fields.length !== 6 || fields[0] !== '0' || !Number.isSafeInteger(pts) || pts < 0 ||
      !/^[a-f0-9]{64}$/i.test(fields[5]) || Number(fields[4]) <= 0) throw new TaskError('invalidOutput');
    const time = pts * scale;
    if (frames.length ? time <= frames[frames.length - 1].time : time !== 0) throw new TaskError('invalidOutput');
    frames.push({ index: frames.length, time, hash: fields[5] });
  }
  if (!frames.length || frames.length > POLICY.maxFrames) throw new TaskError('invalidOutput');
  return frames;
}

export function planDroppedFrames(frames: FrameStamp[], mode: Exclude<DropFrames, 'none'>, duration: number): FramePlan {
  if (!frames.length || !Number.isFinite(duration) || duration <= 0) throw new TaskError('invalidOutput');
  const interval = { duplicates: 0, every2: 2, every3: 3, every4: 4 }[mode];
  const kept: FrameStamp[] = [];
  for (const frame of frames) {
    // Sampling may round the source endpoint up; a frame at/after the endpoint has no duration.
    if (frame.time >= duration - 1e-7) break;
    if (!kept.length || (interval ? (frame.index + 1) % interval !== 0 : frame.hash !== kept[kept.length - 1].hash)) kept.push(frame);
  }
  if (!kept.length) throw new TaskError('invalidOutput');
  // Keep original PTS, never rebuild a constant-rate timeline after selection. The GIF muxer's
  // default last delay repeats the preceding gap, which truncates or extends dropped tails.
  // Set the actual remaining duration in GIF's centisecond time base, including single-frame GIFs.
  return { indices: kept.map(frame => frame.index), finalDelay: Math.max(1, Math.round(duration * 100) - Math.round(kept[kept.length - 1].time * 100)) };
}
