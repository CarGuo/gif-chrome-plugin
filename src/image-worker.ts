import { fitDimensions, POLICY, TaskError, errorCode } from './shared/model';

// ImageDecoder is a browser WebCodecs API; TypeScript's DOM library does not yet declare it.
interface DecodedImage { displayWidth: number; displayHeight: number; timestamp: number; duration: number | null; close(): void }
interface Decoder {
  completed: Promise<void>; tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } };
  decode(options: { frameIndex: number }): Promise<{ image: DecodedImage }>; close(): void;
}
declare const ImageDecoder: { new(options: { data: ArrayBuffer; type: string; preferAnimation: boolean }): Decoder; isTypeSupported(type: string): Promise<boolean> };
let decoder: Decoder | undefined;
let timings: { startUs: number; endUs: number }[] = [];

async function open(blob: Blob, activity: () => void) {
  decoder?.close(); decoder = undefined; timings = [];
  const bytes = await blob.arrayBuffer();
  const prefix = new TextDecoder().decode(bytes.slice(0, 12));
  const type = prefix.startsWith('GIF8') ? 'image/gif' : prefix.startsWith('RIFF') && prefix.slice(8, 12) === 'WEBP' ? 'image/webp' : '';
  if (!type || !await ImageDecoder.isTypeSupported(type)) throw new TaskError('unsupportedImage');
  decoder = new ImageDecoder({ data: bytes, type, preferAnimation: true });
  await decoder.tracks.ready; await decoder.completed;
  const count = decoder.tracks.selectedTrack.frameCount;
  if (!count || count > 10_000) throw new TaskError('inputTooLarge');
  let durationUs = 0, width = 0, height = 0, lastActivity = performance.now();
  for (let i = 0; i < count; i++) {
    const { image } = await decoder.decode({ frameIndex: i });
    width = image.displayWidth; height = image.displayHeight;
    if (width * height > POLICY.maxSourcePixels) { image.close(); throw new TaskError('inputTooLarge'); }
    // v0.1.5: keep WebCodecs' integer microsecond clock. Accumulated decimal seconds put
    // exact boundaries (e.g. 0.3 + 0.1 + 0.2) inside the previous frame and corrupt held-frame timing.
    const delayUs = Math.max(10_000, image.duration ?? 100_000);
    timings.push({ startUs: durationUs, endUs: durationUs + delayUs }); durationUs += delayUs; image.close();
    if (performance.now() - lastActivity > 250) { activity(); lastActivity = performance.now(); }
  }
  return { width, height, duration: count === 1 ? null : durationUs / 1_000_000, frames: count, kind: type === 'image/gif' ? 'gif' : 'webp' };
}
async function frame(time: number, maxSide: number) {
  if (!decoder) throw new TaskError('unsupportedImage');
  const timeUs = Math.round(time * 1_000_000);
  const found = timings.findIndex(t => timeUs >= t.startUs && timeUs < t.endUs);
  const index = found >= 0 ? found : timings.length - 1;
  const { image } = await decoder.decode({ frameIndex: index });
  try {
    const dims = fitDimensions(image.displayWidth, image.displayHeight, maxSide);
    const canvas = new OffscreenCanvas(dims.width, dims.height);
    const context = canvas.getContext('2d')!;
    // ImageDecoder composes blend/disposal into complete display frames before scaling.
    context.drawImage(image as unknown as CanvasImageSource, 0, 0, dims.width, dims.height);
    return { blob: await canvas.convertToBlob({ type: 'image/png' }), ...dims };
  } finally { image.close(); }
}
self.onmessage = async event => {
  const { id, type, blob, time, maxSide } = event.data;
  try {
    const data = type === 'open' ? await open(blob, () => self.postMessage({ id, activity: true })) : type === 'frame' ? await frame(time, maxSide) : (decoder?.close(), decoder = undefined, null);
    self.postMessage({ id, ok: true, data });
  } catch (error) { self.postMessage({ id, ok: false, error: errorCode(error) }); }
};
