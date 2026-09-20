import { ALL_FORMATS, BlobSource, BufferTarget, Conversion, CustomPathedSource, Input, Mp4OutputFormat, Output } from 'mediabunny';
import { SabrStream } from 'googlevideo/sabr-stream';
import { VideoPlaybackAbrRequest } from 'googlevideo/protos';
import { buildSabrFormat, EnabledTrackTypes, Logger, LogLevel } from 'googlevideo/utils';
import type { FormatStream } from 'googlevideo/shared-types';
import { bindSabrSession } from './shared/sabr-session';
import { downloadBlob } from './shared/download';
import { dashDownloadPlan } from './shared/manifest';
import { chooseVideoSize, type MediaResource } from './shared/media-resource';
import type { YoutubeSession } from './shared/page-media';
import { errorCode, POLICY, TaskError } from './shared/model';

Logger.getInstance().setLogLevels(LogLevel.NONE);
const callbacks = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
function parent<T>(type: string, data: unknown): Promise<T> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => { callbacks.set(id, { resolve, reject }); self.postMessage({ rpc: true, id, type, data }); });
}
const authorize = (url: string) => parent<boolean>('authorize', { url });
let operationId: string;
const progress = (loaded: number, total: number) => {
  self.postMessage({ id: operationId, activity: true });
  return parent<void>('progress', { loaded, total });
};

async function download(resource: MediaResource, maxSide: number) {
  const signal = new AbortController().signal;
  if (resource.kind === 'file') return downloadBlob(resource.url, signal, progress, POLICY.inputBytes, authorize);
  let loaded = 0, rootText: string | undefined, rootUrl = resource.url;
  const files = new Map<string, Promise<Blob>>();
  let downloading = Promise.resolve();
  function file(url: string) {
    if (!files.has(url)) {
      const result = downloading.then(async () => {
        const before = loaded;
        const manifest = /\.(?:m3u8|mpd)(?:[?#]|$)/i.test(url);
        const blob = await downloadBlob(url, signal, (bytes) => progress(before + bytes, 0), Math.min(POLICY.inputBytes - before, manifest ? 1024 * 1024 : POLICY.inputBytes), authorize);
        loaded += blob.size;
        if (/\.m3u8(?:[?#]|$)/i.test(url)) {
          const text = await blob.text();
          if (/#EXTINF:/.test(text) && !/#EXT-X-ENDLIST/.test(text)) throw new TaskError('invalidSegment');
          if (/#EXT-X-KEY:.*(?:METHOD=SAMPLE-AES|KEYFORMAT="(?!identity))/.test(text)) throw new TaskError('protectedMedia');
        }
        return blob;
      });
      files.set(url, result); downloading = result.then(() => {});
      // Store failed downloads too: do not retry a changed or expired resource mid-remux.
      void downloading.catch(() => {});
    }
    return files.get(url)!;
  }
  if (resource.kind === 'dash') {
    const manifest = await file(rootUrl);
    if (manifest.size > 1024 * 1024) throw new TaskError('inputTooLarge');
    const plan = dashDownloadPlan(await manifest.text(), rootUrl, maxSide);
    if (plan.kind === 'file') return file(plan.url);
    rootText = plan.playlist;
  }
  const input = new Input({ formats: ALL_FORMATS, formatOptions: { hls: { offsetTimestampsByDateTime: false } },
    source: new CustomPathedSource(rootUrl, async request => new BlobSource(request.isRoot && rootText !== undefined ? new Blob([rootText]) : await file(String(request.path)))) });
  try {
    const tracks = await input.getVideoTracks();
    const sizes = await Promise.all(tracks.map(async track => ({ track, width: await track.getDisplayWidth(), height: await track.getDisplayHeight() })));
    const track = chooseVideoSize(sizes, item => item, maxSide)?.track;
    if (!track) throw new TaskError('unsupportedVideo');
    if (!Number.isFinite(await track.computeDuration())) throw new TaskError('invalidSegment');
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
    const conversion = await Conversion.init({ input, output, tracks: 'all', copy: { mode: 'forced' },
      video: candidate => ({ discard: candidate !== track }), audio: { discard: true }, showWarnings: false });
    if (!conversion.isValid) throw new TaskError('unsupportedVideo');
    await conversion.execute();
    if (!target.buffer || target.buffer.byteLength > POLICY.inputBytes) throw new TaskError('inputTooLarge');
    await progress(loaded, loaded);
    return new Blob([target.buffer], { type: 'video/mp4' });
  } finally { input.dispose(); }
}

async function downloadYoutube(session: YoutubeSession, maxSide: number) {
  if (!session.url || !session.request || !session.config) throw new TaskError('mediaDiscoveryRequired');
  const original = VideoPlaybackAbrRequest.decode(Uint8Array.from(session.request));
  if (!original.streamerContext?.clientInfo) throw new TaskError('downloadFailed');
  const formats = session.formats.map(format => buildSabrFormat(format as unknown as FormatStream));
  const videos = formats.filter(format => format.width && format.height && format.mimeType?.startsWith('video/'));
  const h264 = videos.filter(format => format.mimeType?.includes('avc1'));
  const video = chooseVideoSize(h264.length ? h264 : videos, format => ({ width: format.width!, height: format.height! }), maxSide);
  if (!video) throw new TaskError('unsupportedVideo');
  if ((video.contentLength ?? 0) > POLICY.inputBytes) throw new TaskError('inputTooLarge');
  let received = 0, lastProgress = 0;
  const streamingUrl = new URL(session.url);
  // A download owns its request sequence; do not reuse the player's playback nonce.
  streamingUrl.searchParams.set('cpn', btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(12)))).replaceAll('+', '-').replaceAll('/', '_'));
  const stream = new SabrStream({ formats, serverAbrStreamingUrl: streamingUrl.href, videoPlaybackUstreamerConfig: session.config,
    clientInfo: original.streamerContext.clientInfo,
    poToken: original.streamerContext.poToken?.length ? btoa(String.fromCharCode(...original.streamerContext.poToken)) : undefined,
    durationMs: session.duration * 1000,
    fetch: async (url, init) => {
      const href = url instanceof Request ? url.url : String(url);
      const target = new URL(href);
      if (target.protocol !== 'https:' || !target.hostname.endsWith('.googlevideo.com')) throw new TaskError('downloadFailed');
      if (!await authorize(href)) throw new TaskError('permissionRequired');
      // v0.1.7: the first playback request can carry a bootstrap token. Re-read the
      // selected player's current session for each request; never freeze it for a full download.
      const latest = await parent<YoutubeSession>('youtube-session', {});
      if (latest.videoId !== session.videoId || !latest.request) throw new TaskError('sourceChanged');
      const body = bindSabrSession(init?.body as Uint8Array, Uint8Array.from(latest.request));
      const blob = await parent<Blob>('youtube-fetch', { url: href, body });
      return new Response(blob, { status: 200, headers: { 'Content-Type': blob.type } });
    } });
  let identityError = false, identityConfirmed = false, finished = false, expired = false;
  stream.on('finish', () => { finished = true; });
  stream.on('formatInitialization', initialized => {
    if (initialized.formatInitializationMetadata.videoId !== session.videoId) { identityError = true; stream.abort(); }
    else identityConfirmed = true;
  });
  stream.on('reloadPlayerResponse', () => { expired = true; stream.abort(); });
  try {
    const { videoStream } = await stream.start({ videoFormat: video, enabledTrackTypes: EnabledTrackTypes.VIDEO_ONLY, maxRetries: 2, stallDetectionMs: POLICY.networkTimeoutMs });
    const reader = videoStream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      received += value.byteLength;
      if (received > POLICY.inputBytes) throw new TaskError('inputTooLarge');
      chunks.push(value);
      if (performance.now() - lastProgress > 250) { lastProgress = performance.now(); await progress(received, video.contentLength ?? 0); }
    }
    if (identityError) throw new TaskError('sourceChanged');
    if (expired) throw new TaskError('mediaDiscoveryRequired');
    if (!received || !finished || !identityConfirmed) throw new TaskError('downloadFailed');
    await progress(received, received);
    return new Blob(chunks as BlobPart[], { type: video.mimeType?.split(';')[0] });
  } catch (error) {
    throw error instanceof TaskError ? error : new TaskError(identityError ? 'sourceChanged' : 'downloadFailed');
  } finally { stream.abort(); }
}

self.onmessage = async event => {
  const { id, type, resource, session, maxSide } = event.data;
  if (event.data.parentReply) {
    const callback = callbacks.get(id); callbacks.delete(id);
    if (callback) event.data.ok ? callback.resolve(event.data.data) : callback.reject(new TaskError(event.data.error));
    return;
  }
  operationId = id;
  try { self.postMessage({ id, ok: true, data: type === 'youtube' ? await downloadYoutube(session, maxSide) : await download(resource, maxSide) }); }
  catch (error) { self.postMessage({ id, ok: false, error: errorCode(error) }); }
};
