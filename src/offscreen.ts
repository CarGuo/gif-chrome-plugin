import { FFmpeg } from '@ffmpeg/ffmpeg';
import { candidates, buildEncodeArgs, buildFrameHashArgs, buildPaletteArgs, inspectGif } from './shared/encoding';
import { planDroppedFrames, readFrameHashes, type FramePlan } from './shared/frame-plan';
import { errorCode, fitDimensions, httpOrigin, isTerminal, outputDuration, sampleCount, sampleTime, POLICY, rpc, TaskError, validateSegment, validateWorkload, type Job, type MediaSource, type Reply } from './shared/model';
import { makeFilename } from './shared/filename';
import { deleteResult, getJob, getJobs, getResult, pruneHistory, removeJob, saveJob, saveJobs, saveResult } from './shared/storage';

const queue: Job[] = [];
let current: { job: Job; abort: AbortController; ffmpeg?: FFmpeg; image?: ImageClient } | undefined;
let pumping = false;
let admission: Promise<unknown> = Promise.resolve();
const resultUrls = new Map<string, string>();

class ImageClient {
  private worker = new Worker(new URL('./image-worker.ts', import.meta.url), { type: 'module' });
  private callbacks = new Map<string, { resolve: (data: any) => void; reject: (error: unknown) => void }>();
  constructor() {
    this.worker.onmessage = event => {
      const response = event.data; const callback = this.callbacks.get(response.id);
      if (!callback) return; this.callbacks.delete(response.id);
      response.ok ? callback.resolve(response.data) : callback.reject(new TaskError(response.error));
    };
    this.worker.onerror = () => this.close(new TaskError('unsupportedImage'));
  }
  request<T>(type: string, data = {}): Promise<T> {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => { this.callbacks.set(id, { resolve, reject }); this.worker.postMessage({ id, type, ...data }); });
  }
  close(error = new TaskError('cancelled')) { this.worker.terminate(); for (const cb of this.callbacks.values()) cb.reject(error); this.callbacks.clear(); }
}
async function update(job: Job, patch: Partial<Job>) {
  Object.assign(job, patch, { updatedAt: Date.now() });
  await saveJob(job);
  await chrome.runtime.sendMessage({ type: 'job-updated', job }).catch(() => {});
}
const recovered = (async () => {
  // v0.1: never present a previously interrupted worker as still running / successfully completed.
  for (const job of await getJobs()) if (!isTerminal(job.stage)) await update(job, { stage: 'failed', error: 'interrupted' });
})();
async function fetchImage(source: MediaSource, signal: AbortSignal) {
  if (!source.url.startsWith('data:')) {
    httpOrigin(source.url);
    if (!await rpc<boolean>({ target: 'background', type: 'image-permission', url: source.url })) throw new TaskError('permissionRequired');
  }
  const combined = AbortSignal.any([signal, AbortSignal.timeout(POLICY.networkTimeoutMs)]);
  let response: Response;
  try { response = await fetch(source.url, { signal: combined, credentials: 'include' }); }
  catch { if (signal.aborted) throw new TaskError('cancelled'); throw new TaskError('downloadFailed'); }
  if (!response.ok || !response.body) throw new TaskError('downloadFailed');
  if (Number(response.headers.get('content-length')) > POLICY.inputBytes) throw new TaskError('inputTooLarge');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > POLICY.inputBytes) throw new TaskError('inputTooLarge');
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof TaskError) throw error;
    throw new TaskError(signal.aborted ? 'cancelled' : 'downloadFailed');
  } finally { await reader.cancel().catch(() => {}); }
  return new Blob(chunks as BlobPart[], { type: response.headers.get('content-type') ?? '' });
}
async function processJob(job: Job) {
  const abort = new AbortController(); const state = { job, abort, ffmpeg: new FFmpeg(), image: undefined as ImageClient | undefined }; current = state;
  let playerStarted = false;
  const check = () => { if (abort.signal.aborted) throw new TaskError('cancelled'); };
  const player = <T>(command: object) => rpc<T>({ target: 'background', type: 'player', jobId: job.id, command });
  try {
    await update(job, { stage: 'loading', progress: 0.01, error: undefined });
    const ffmpeg = state.ffmpeg;
    await ffmpeg.load({ coreURL: chrome.runtime.getURL('ffmpeg/ffmpeg-core.js'), wasmURL: chrome.runtime.getURL('ffmpeg/ffmpeg-core.wasm') }); check();
    let width: number, height: number, duration: number | null, staticImage = false;
    if (job.source.kind === 'video') {
      const meta = await player<{ width: number; height: number; duration: number }>({ type: 'begin' }); playerStarted = true;
      ({ width, height, duration } = meta);
    } else {
      const blob = await fetchImage(job.source, abort.signal); check();
      state.image = new ImageClient();
      const meta = await state.image.request<{ width: number; height: number; duration: number | null; frames: number }>('open', { blob });
      ({ width, height, duration } = meta); staticImage = meta.frames === 1;
    }
    validateSegment(job.segment, duration, job.settings.fps, job.settings.speed); check();
    const clipDuration = outputDuration(job.segment, job.settings.speed);
    const count = staticImage ? 1 : sampleCount(job.segment, job.settings.fps, job.settings.speed);
    const captureSize = fitDimensions(width, height, job.settings.maxSide);
    validateWorkload(captureSize.width, captureSize.height, count);
    let inputSize = 0;
    for (let i = 0; i < count; i++) {
      check();
      const time = sampleTime(job.segment, i, job.settings.fps, job.settings.speed);
      const frame = job.source.kind === 'video'
        ? await player<{ blob: Blob; width: number; height: number }>({ type: 'frame', time, maxSide: job.settings.maxSide })
        : await state.image!.request<{ blob: Blob; width: number; height: number }>('frame', { time, maxSide: job.settings.maxSide });
      check();
      if (!(frame.blob instanceof Blob)) throw new TaskError('invalidOutput');
      inputSize += frame.blob.size;
      if (inputSize > POLICY.frameBytes) throw new TaskError('inputTooLarge');
      await ffmpeg.writeFile(`frame${String(i).padStart(5, '0')}.png`, new Uint8Array(await frame.blob.arrayBuffer()));
      width = frame.width; height = frame.height;
      await update(job, { stage: 'capturing', progress: 0.05 + 0.5 * (i + 1) / count });
    }
    // Release the live player before CPU-heavy compression; always restore again in finally if needed.
    if (playerStarted) { await player({ type: 'restore' }); playerStarted = false; }
    state.image?.close(); state.image = undefined;
    const plans = candidates(width, height, job.settings);
    const framePlans = new Map<string, FramePlan>();
    let bestBytes = Infinity;
    for (let index = 0; index < plans.length; index++) {
      check(); const candidate = plans[index];
      await update(job, { stage: 'encoding', progress: 0.58 + 0.34 * index / plans.length, attempt: index + 1 });
      let framePlan: FramePlan | undefined;
      if (job.settings.dropFrames !== 'none' && !staticImage) {
        // v0.1.5: optional removal follows speed/size sampling and precedes palette optimization.
        // Reuse the worker's frame analysis across palette attempts; recompute when size/fps changes.
        const key = `${candidate.width}:${candidate.height}:${candidate.fps}`;
        framePlan = framePlans.get(key);
        if (!framePlan) {
          const hashStatus = await ffmpeg.exec(buildFrameHashArgs(candidate, job.settings.fps, 'frame%05d.png', 'frames.sha256'), 90_000);
          check(); if (hashStatus !== 0) throw new TaskError('encodingFailed');
          const hashes = await ffmpeg.readFile('frames.sha256', 'utf8');
          if (typeof hashes !== 'string') throw new TaskError('invalidOutput');
          framePlan = planDroppedFrames(readFrameHashes(hashes), job.settings.dropFrames, clipDuration);
          framePlans.set(key, framePlan); await ffmpeg.deleteFile('frames.sha256');
        }
      }
      const paletteStatus = await ffmpeg.exec(buildPaletteArgs(candidate, job.settings.fps, 'frame%05d.png', 'palette.png', framePlan), 90_000);
      check(); if (paletteStatus !== 0) throw new TaskError('encodingFailed');
      const status = await ffmpeg.exec(buildEncodeArgs(candidate, job.settings.fps, 'frame%05d.png', 'output.gif', 'palette.png', framePlan), 90_000);
      check(); if (status !== 0) throw new TaskError('encodingFailed');
      const result = await ffmpeg.readFile('output.gif');
      if (!(result instanceof Uint8Array)) throw new TaskError('invalidOutput');
      bestBytes = Math.min(bestBytes, result.byteLength);
      if (result.length <= job.settings.maxBytes) {
        await update(job, { stage: 'validating', progress: 0.95 });
        const metadata = inspectGif(result, { maxBytes: job.settings.maxBytes, maxSide: job.settings.maxSide, duration: staticImage ? 0 : clipDuration, fps: candidate.fps, frames: framePlan?.indices.length });
        check();
        await saveResult(job.id, new Blob([result.slice().buffer as ArrayBuffer], { type: 'image/gif' }));
        check();
        await update(job, { stage: 'completed', progress: 1, result: { ...metadata, filename: makeFilename(job) } });
        return;
      }
      await ffmpeg.deleteFile('output.gif');
    }
    await update(job, { detail: String(bestBytes) }); throw new TaskError('budgetUnreachable');
  } catch (error) {
    const code = abort.signal.aborted ? 'cancelled' : errorCode(error);
    await deleteResult(job.id);
    await update(job, { stage: code === 'cancelled' ? 'cancelled' : 'failed', error: code });
  } finally {
    if (playerStarted) await player({ type: 'restore' }).catch(() => {});
    state.image?.close(); state.ffmpeg.terminate(); current = undefined;
    const removedIds = await pruneHistory();
    for (const id of removedIds) {
      const url = resultUrls.get(id); if (url) URL.revokeObjectURL(url); resultUrls.delete(id);
    }
    // v0.1.4: history eviction must also remove visible cards; otherwise they offer downloads
    // for blobs that were already deleted from storage.
    if (removedIds.length) await chrome.runtime.sendMessage({ type: 'jobs-removed', ids: removedIds }).catch(() => {});
  }
}
async function pump() {
  if (pumping) return; pumping = true;
  try { while (queue.length) await processJob(queue.shift()!); }
  finally { pumping = false; }
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'offscreen' || sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
  const handle = async () => {
    await recovered;
    switch (message.type) {
      case 'list': return (await getJobs()).sort((a, b) => b.createdAt - a.createdAt);
      case 'enqueue': {
        // v0.1.4: simultaneous panels previously checked capacity before async writes, allowing
        // each to admit a full batch. Serialize admission and commit a whole batch atomically.
        const request = admission.then(async () => {
          if (queue.length + (current ? 1 : 0) + message.jobs.length > POLICY.maxJobs) throw new TaskError('playerBusy');
          await saveJobs(message.jobs);
          queue.push(...message.jobs);
          void pump(); return message.jobs.map((job: Job) => job.id);
        });
        admission = request.catch(() => {});
        return request;
      }
      case 'cancel': {
        const queued = queue.findIndex(j => j.id === message.id);
        if (queued >= 0) { const [job] = queue.splice(queued, 1); await update(job, { stage: 'cancelled', error: 'cancelled' }); }
        const active = current;
        if (active && active.job.id === message.id && !isTerminal(active.job.stage)) { active.abort.abort(); active.ffmpeg?.terminate(); active.image?.close(); }
        return null;
      }
      case 'delete': {
        const job = await getJob(message.id); if (job && !isTerminal(job.stage)) throw new TaskError('playerBusy');
        const url = resultUrls.get(message.id); if (url) URL.revokeObjectURL(url); resultUrls.delete(message.id);
        await removeJob(message.id); return null;
      }
      case 'inspect-image': {
        const worker = new ImageClient();
        try { return await worker.request('open', { blob: await fetchImage(message.source, new AbortController().signal) }); }
        finally { worker.close(); }
      }
      case 'result-url': {
        if (!resultUrls.has(message.id)) {
          const blob = await getResult(message.id); if (!blob) throw new TaskError('invalidOutput');
          resultUrls.set(message.id, URL.createObjectURL(blob));
        }
        return resultUrls.get(message.id);
      }
      default: throw new TaskError('interrupted');
    }
  };
  void handle().then(data => sendResponse({ ok: true, data } satisfies Reply), error => sendResponse({ ok: false, error: errorCode(error) } satisfies Reply));
  return true;
});
