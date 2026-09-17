import { httpOrigin, POLICY, rpc, TaskError, type MediaSource } from './model';
import { acquisition, xMetadataUrl, xVideoUrl } from './acquisition';

export async function downloadBlob(url: string, signal: AbortSignal, progress?: (loaded: number, total: number) => Promise<void>, maxBytes: number = POLICY.inputBytes,
  authorize: (url: string) => Promise<boolean> = url => rpc<boolean>({ target: 'background', type: 'media-permission', url }), request?: RequestInit): Promise<Blob> {
  if (!url.startsWith('data:') && !url.startsWith('blob:')) {
    httpOrigin(url);
    if (!await authorize(url)) throw new TaskError('permissionRequired');
  }
  // v0.1.6: video downloads can legitimately take longer than an image's 30-second limit.
  // Bound inactivity, not total transfer time; retain the byte cap and immediate cancellation.
  const idle = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const activity = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(), POLICY.networkTimeoutMs); };
  const combined = AbortSignal.any([signal, idle.signal]);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  activity();
  try {
    const response = await fetch(url, { credentials: 'include', ...request, signal: combined });
    if (!response.ok || !response.body) throw new TaskError('downloadFailed');
    const total = Number(response.headers.get('content-length'));
    if (total > maxBytes) { await response.body.cancel(); throw new TaskError('inputTooLarge'); }
    reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let length = 0, lastUpdate = 0;
    activity();
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      activity();
      length += value.byteLength;
      if (length > maxBytes) throw new TaskError('inputTooLarge');
      chunks.push(value);
      if (progress && performance.now() - lastUpdate > 250) { lastUpdate = performance.now(); await progress(length, total); }
    }
    if (progress) await progress(length, length);
    return new Blob(chunks as BlobPart[], { type: response.headers.get('content-type') ?? '' });
  } catch (error) {
    if (error instanceof TaskError) throw error;
    throw new TaskError(signal.aborted ? 'cancelled' : 'downloadFailed');
  } finally { clearTimeout(timer!); await reader?.cancel().catch(() => {}); }
}

export async function downloadSource(source: MediaSource, signal: AbortSignal, progress?: (loaded: number, total: number) => Promise<void>, maxSide: number = POLICY.maxSide) {
  let url = source.url;
  if (acquisition(source) === 'x') {
    const metadata = await downloadBlob(xMetadataUrl(source), signal, undefined, 1024 * 1024);
    let data: unknown;
    try { data = JSON.parse(await metadata.text()); } catch { throw new TaskError('downloadFailed'); }
    url = xVideoUrl(source, data, maxSide);
  }
  return downloadBlob(url, signal, progress);
}
