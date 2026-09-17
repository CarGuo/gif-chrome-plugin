import { ALL_FORMATS, BlobSource, CanvasSink, Input, type InputVideoTrack, type WrappedCanvas } from 'mediabunny';
import { errorCode, fitDimensions, POLICY, TaskError } from './shared/model';

let input: Input | undefined;
let track: InputVideoTrack | undefined;
let iterator: AsyncGenerator<WrappedCanvas | null, void, unknown> | undefined;

async function open(blob: Blob) {
  input?.dispose();
  input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  track = await input.getPrimaryVideoTrack() ?? undefined;
  if (!track || !await track.canDecode()) throw new TaskError('unsupportedVideo');
  const width = await track.getDisplayWidth(), height = await track.getDisplayHeight();
  if (width * height > POLICY.maxSourcePixels) throw new TaskError('inputTooLarge');
  const duration = await track.computeDuration();
  if (!Number.isFinite(duration) || duration <= 0) throw new TaskError('invalidSegment');
  return { width, height, duration };
}

async function prepare(times: number[], maxSide: number) {
  if (!track) throw new TaskError('sourceNotReady');
  await iterator?.return();
  const dims = fitDimensions(await track.getDisplayWidth(), await track.getDisplayHeight(), maxSide);
  // v0.1.6: WebCodecs decodes downloaded media inside a Worker. Sparse iteration reuses
  // decoded packets; speed is mapped before sampling and resizing, without an MP4 re-encode.
  const sink = new CanvasSink(track, { ...dims, fit: 'fill', alpha: true, poolSize: 1 });
  iterator = sink.canvasesAtTimestamps(times);
  return null;
}

async function frame() {
  const result = await iterator?.next();
  if (!result || result.done || !result.value) throw new TaskError('invalidOutput');
  const canvas = result.value.canvas as OffscreenCanvas;
  return { blob: await canvas.convertToBlob({ type: 'image/png' }), width: canvas.width, height: canvas.height };
}

self.onmessage = async event => {
  const { id, type, blob, times, maxSide } = event.data;
  try {
    const data = type === 'open' ? await open(blob) : type === 'prepare' ? await prepare(times, maxSide) : type === 'frame' ? await frame() : null;
    self.postMessage({ id, ok: true, data });
  } catch (error) { self.postMessage({ id, ok: false, error: errorCode(error) }); }
};
