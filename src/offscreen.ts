import { FFmpeg } from '@ffmpeg/ffmpeg';
import { buildEncodeArgs, buildFrameHashArgs, buildPaletteArgs, inspectGif, type Candidate } from './shared/encoding';
import { planDroppedFrames, readFrameHashes, type FramePlan } from './shared/frame-plan';
import { estimateSize, lastResortFps, nextDimensions, nextLossy, predictedDimensions, probeIndices } from './shared/fit';
import { chosenResource } from './shared/media-resource';
import type { YoutubeSession } from './shared/page-media';
import { acquisition } from './shared/acquisition';
import { downloadSource } from './shared/download';
import { errorCode, fitDimensions, isTerminal, outputDuration, sampleCount, sampleTime, POLICY, rpc, TaskError, validateSegment, validateWorkload, type DropFrames, type Job, type Reply } from './shared/model';
import { makeFilename } from './shared/filename';
import { clearStoredItems, deleteResult, getCacheSummary, getHistory, getJob, getJobs, getResult, pruneHistory, removeJob, saveJob, saveJobs, saveResult } from './shared/storage';
import { optimizeGif, WorkerClient } from './worker-client';

const queue: Job[] = [];
let current: { job: Job; abort: AbortController; ffmpeg: FFmpeg; image?: WorkerClient; video?: WorkerClient; download?: WorkerClient } | undefined;
let pumping = false;
let admission: Promise<unknown> = Promise.resolve();
// v0.1.9: each browser download owns its URL until completion. Clearing the backing
// cache must not invalidate a file already handed to Chrome's download manager.
const resultUrls = new Set<string>();
const imageClient = () => new WorkerClient(new Worker(new URL('./image-worker.ts', import.meta.url), { type: 'module' }));
const videoClient = () => new WorkerClient(new Worker(new URL('./video-worker.ts', import.meta.url), { type: 'module' }));

async function update(job: Job, patch: Partial<Job>) {
  Object.assign(job, patch, { updatedAt: Date.now() });
  await saveJob(job);
  await chrome.runtime.sendMessage({ type: 'job-updated', job }).catch(() => {});
}
const recovered = (async () => {
  for (const job of await getJobs()) if (!isTerminal(job.stage)) await update(job, { stage: 'failed', error: 'interrupted' });
})();

async function processJob(job: Job) {
  const started = performance.now();
  const abort = new AbortController();
  const state = { job, abort, ffmpeg: new FFmpeg(), image: undefined as WorkerClient | undefined, video: undefined as WorkerClient | undefined, download: undefined as WorkerClient | undefined };
  current = state;
  const metrics: NonNullable<Job['metrics']> = { downloadMs: 0, probeMs: 0, captureMs: 0, encodeMs: 0, optimizeMs: 0, totalMs: 0, encodes: 0, optimizations: 0, attempts: [], executions: [] };
  let readingBlob = false;
  const check = () => { if (abort.signal.aborted) throw new TaskError('cancelled'); };
  const player = <T>(command: object) => rpc<T>({ target: 'background', type: 'player', jobId: job.id, command });
  const ffmpeg = state.ffmpeg;
  try {
    await update(job, { stage: 'loading', progress: 0.01, error: undefined, metrics });
    let width: number, height: number, duration: number | null, staticImage = false;
    if (job.source.kind === 'video') await player({ type: 'inspect' });
    const time = performance.now();
    await update(job, { stage: 'downloading', progress: 0.02 });
    const progress = async (loaded: number, total: number) => {
      check(); metrics.downloadMs = performance.now() - time; metrics.downloadedBytes = loaded;
      await update(job, { progress: total > 0 ? Math.min(0.15, 0.02 + 0.13 * loaded / total) : 0.02 });
    };
    const mode = acquisition(job.source);
    let blob: Blob;
    try {
      if (job.source.kind !== 'video' || mode === 'x') blob = await downloadSource(job.source, abort.signal, progress, job.settings.maxSide);
      else if (mode === 'blob') {
        readingBlob = true; blob = await player<Blob>({ type: 'read-blob' }); readingBlob = false;
      } else {
        if (mode === 'unresolved') throw new TaskError(job.source.resources?.length ? 'ambiguousMedia' : 'mediaDiscoveryRequired');
        state.download = new WorkerClient(new Worker(new URL('./download-worker.ts', import.meta.url), { type: 'module' }), async (type, data) => {
          check();
          if (type === 'authorize') return rpc<boolean>({ target: 'background', type: 'media-permission', url: data.url });
          if (type === 'progress') return progress(data.loaded, data.total);
          if (type === 'youtube-session') return rpc<YoutubeSession>({ target: 'background', type: 'resolve-youtube', jobId: job.id });
          if (type === 'youtube-fetch') {
            readingBlob = true;
            try { return await player<Blob>({ type: 'read-sabr', url: data.url, body: data.body }); }
            finally { readingBlob = false; }
          }
          throw new TaskError('downloadFailed');
        });
        if (mode === 'youtube') {
          const session = await rpc<YoutubeSession>({ target: 'background', type: 'resolve-youtube', jobId: job.id });
          blob = await state.download.request('youtube', { session, maxSide: job.settings.maxSide }, POLICY.networkTimeoutMs * 2);
        } else blob = await state.download.request('download', { resource: chosenResource(job.source), maxSide: job.settings.maxSide }, POLICY.networkTimeoutMs * 2);
      }
    } finally { metrics.downloadMs = performance.now() - time; state.download?.close(); state.download = undefined; }
    check();
    const client = job.source.kind === 'video' ? (state.video = videoClient()) : (state.image = imageClient());
    const meta = await client.request<{ width: number; height: number; duration: number | null; frames?: number }>('open', { blob });
    metrics.downloadedBytes = blob.size; if (job.source.kind === 'video') metrics.downloadedDuration = meta.duration ?? undefined;
    ({ width, height, duration } = meta); staticImage = meta.frames === 1;
    // v0.1.8: the downloaded representation owns processing metadata. Full-source
    // intent resolves to its end; manual timestamps remain unchanged and strictly checked.
    const segment = validateSegment(job.segment, duration, job.settings.fps, job.settings.speed); check();
    await update(job, { source: { ...job.source, width, height, duration }, segment });
    const clipDuration = outputDuration(job.segment, job.settings.speed);
    const count = staticImage ? 1 : sampleCount(job.segment, job.settings.fps, job.settings.speed);
    const base = fitDimensions(width, height, job.settings.maxSide);
    validateWorkload(base.width, base.height, count);
    await ffmpeg.load({ coreURL: chrome.runtime.getURL('ffmpeg/ffmpeg-core.js'), wasmURL: chrome.runtime.getURL('ffmpeg/ffmpeg-core.wasm') }); check();

    const files = new Set<string>();
    async function clearFrames() {
      for (const file of files) await ffmpeg.deleteFile(file);
      files.clear();
    }
    async function capture(indices: number[], maxSide: number, prefix: string, probe = false) {
      const times = indices.map(i => sampleTime(job.segment, i, job.settings.fps, job.settings.speed));
      if (state.video) await state.video.request('prepare', { times, maxSide });
      let bytes = 0, lastUpdate = 0;
      for (let i = 0; i < indices.length; i++) {
        check();
        const frame = state.video
          ? await state.video.request<{ blob: Blob; width: number; height: number }>('frame')
          : await state.image!.request<{ blob: Blob; width: number; height: number }>('frame', { time: times[i], maxSide });
        check();
        if (!(frame.blob instanceof Blob)) throw new TaskError('invalidOutput');
        bytes += frame.blob.size;
        if (bytes > POLICY.frameBytes) throw new TaskError('inputTooLarge');
        const name = `${prefix}${String(i).padStart(5, '0')}.png`;
        await ffmpeg.writeFile(name, new Uint8Array(await frame.blob.arrayBuffer())); files.add(name);
        // v0.1.6: bound persistence/message frequency independently of the number of frames.
        if (!probe && (performance.now() - lastUpdate >= 250 || i === indices.length - 1)) {
          lastUpdate = performance.now(); await update(job, { stage: 'capturing', progress: 0.25 + 0.3 * (i + 1) / indices.length });
        }
      }
      if (!probe) metrics.capturedBytes = bytes;
    }
    let progressWrites = Promise.resolve();
    let progressFailure: { error: unknown } | undefined;
    let lastProgress = 0;
    const onProgress = ({ progress }: { progress: number }) => {
      if (job.stage !== 'encoding' || performance.now() - lastProgress < 250) return;
      lastProgress = performance.now();
      const value = Math.max(job.progress, Math.min(0.87, 0.58 + 0.29 * Math.max(0, progress)));
      // v0.1.11: observe rejection immediately; preserve it for the operation to fail
      // with its real storage error instead of silently poisoning/unhandling the chain.
      progressWrites = progressWrites.then(() => { if (!progressFailure) return update(job, { progress: value }); })
        .catch(error => { progressFailure = { error }; });
    };
    ffmpeg.on('progress', onProgress);
    async function exec(args: string[]) {
      const began = performance.now();
      const code = await ffmpeg.exec(args, 90_000);
      const done = performance.now();
      await progressWrites; if (progressFailure) throw progressFailure.error; check();
      metrics.executions.push({ operation: args.at(-1)!, ms: done - began, progressWaitMs: performance.now() - done });
      if (code !== 0) throw new TaskError('encodingFailed');
    }
    async function encode(candidate: Candidate, prefix: string, timeline: number, mode: DropFrames = 'none', probe = false) {
      const time = performance.now();
      let plan: FramePlan;
      if (mode !== 'none' && !staticImage) {
        await exec(buildFrameHashArgs(candidate, job.settings.fps, `${prefix}%05d.png`, 'frames.sha256'));
        const hashes = await ffmpeg.readFile('frames.sha256', 'utf8');
        if (typeof hashes !== 'string') throw new TaskError('invalidOutput');
        plan = planDroppedFrames(readFrameHashes(hashes), mode, timeline);
        await ffmpeg.deleteFile('frames.sha256');
      } else {
        const n = staticImage ? 1 : Math.max(1, Math.ceil(timeline * candidate.fps - 1e-7));
        plan = { indices: Array.from({ length: n }, (_, i) => i), finalDelay: Math.max(1, Math.round(timeline * 100) - Math.round((n - 1) * 100 / candidate.fps)) };
      }
      const selection = mode === 'none' || staticImage ? undefined : plan;
      await exec(buildPaletteArgs(candidate, job.settings.fps, `${prefix}%05d.png`, 'palette.png', selection));
      await exec(buildEncodeArgs(candidate, job.settings.fps, `${prefix}%05d.png`, 'output.gif', 'palette.png', selection, plan.finalDelay));
      const bytes = await ffmpeg.readFile('output.gif');
      await ffmpeg.deleteFile('output.gif'); await ffmpeg.deleteFile('palette.png');
      if (!(bytes instanceof Uint8Array)) throw new TaskError('invalidOutput');
      if (!probe) { metrics.encodeMs += performance.now() - time; metrics.encodes++; }
      return { bytes, plan };
    }
    async function optimize(bytes: Uint8Array, probe = false) {
      let best = bytes, lossy = 0;
      const time = performance.now();
      if (!probe) await update(job, { stage: 'optimizing', progress: Math.max(job.progress, 0.88) });
      for (let i = 0; i < (probe ? 1 : POLICY.optimizeAttempts); i++) {
        check();
        // Every attempt starts from the clean encoded GIF: no accumulated lossy degradation.
        const result = await optimizeGif(bytes, probe ? POLICY.lossyStep : lossy, abort.signal);
        check();
        if (!probe) metrics.optimizations++;
        if (result.length < best.length) best = result;
        if (probe || best.length <= job.settings.maxBytes) break;
        const next = nextLossy(best.length, job.settings.maxBytes, lossy);
        if (next === undefined) break;
        lossy = i === POLICY.optimizeAttempts - 2 ? POLICY.maxLossy : next;
      }
      if (!probe) metrics.optimizeMs += performance.now() - time;
      return best;
    }

    await update(job, { stage: 'estimating', progress: 0.17 });
    const probeStarted = performance.now();
    const indices = probeIndices(count);
    const probeSize = fitDimensions(width, height, Math.min(job.settings.maxSide, POLICY.probeSide));
    await capture(indices, Math.max(probeSize.width, probeSize.height), 'probe', true);
    const probe = await encode({ ...probeSize, fps: job.settings.fps, colors: 256 }, 'probe', indices.length / job.settings.fps, 'none', true);
    const measured = await optimize(probe.bytes, true);
    const estimate = estimateSize({ bytes: measured.length, ...probeSize, frames: indices.length }, base.width, base.height, count);
    metrics.estimatedBytes = estimate;
    await clearFrames();
    metrics.probeMs = performance.now() - probeStarted;
    let candidate: Candidate = { ...predictedDimensions(width, height, estimate, job.settings), fps: job.settings.fps, colors: 256 };
    metrics.captureWidth = candidate.width; metrics.captureHeight = candidate.height;
    const captureStarted = performance.now();
    await update(job, { stage: 'capturing', progress: 0.25 });
    await capture(Array.from({ length: count }, (_, i) => i), Math.max(candidate.width, candidate.height), 'frame');
    metrics.captureMs = performance.now() - captureStarted;
    state.image?.close(); state.image = undefined; state.video?.close(); state.video = undefined;

    let attempt = 0;
    async function render(mode: DropFrames = 'none', temporal = false) {
      check();
      await update(job, { stage: mode === 'none' && !temporal ? 'encoding' : 'dropping', progress: Math.max(job.progress, 0.58), attempt: ++attempt });
      const encoded = await encode(candidate, 'frame', clipDuration, mode);
      const bytes = await optimize(encoded.bytes);
      metrics.attempts.push({ width: candidate.width, height: candidate.height, fps: candidate.fps, rawBytes: encoded.bytes.length, bytes: bytes.length, dropFrames: mode });
      return { bytes, plan: encoded.plan };
    }
    let result: Awaited<ReturnType<typeof render>> | undefined;
    // v0.1.6: resize using the sped-up duration/pixel estimate, optimize at unchanged fps,
    // then correct the size estimate from real bytes. Never reduce fps during the spatial phase.
    for (let spatial = 0; spatial < POLICY.resizeAttempts; spatial++) {
      result = await render();
      if (result.bytes.length <= job.settings.maxBytes) break;
      const next = nextDimensions(candidate, result.bytes.length, job.settings, { ...candidate, width, height });
      if (!next || spatial === POLICY.resizeAttempts - 1) break;
      candidate = next;
    }
    const minimumSide = Math.min(POLICY.minimumSide, Math.max(base.width, base.height));
    if (result!.bytes.length > job.settings.maxBytes && Math.max(candidate.width, candidate.height) > minimumSide) {
      // Only visit the quality floor when measured adaptive attempts still fail. A slightly
      // oversized third attempt must not force every clip all the way down to 240 px.
      candidate = { ...candidate, ...fitDimensions(width, height, minimumSide) };
      result = await render();
    }
    // An explicit user drop mode is honored as a finishing operation, including when already
    // under budget. Automatic frame reduction is allowed only after resize and optimization.
    if (job.settings.dropFrames !== 'none' && !staticImage) result = await render(job.settings.dropFrames);
    for (let temporal = 0; result!.bytes.length > job.settings.maxBytes && temporal < 2 && !staticImage; temporal++) {
      const next = lastResortFps(candidate, result!.bytes.length, job.settings);
      if (!next) break;
      candidate = temporal === 1 ? { ...next, fps: Math.min(POLICY.minimumFps, job.settings.fps) } : next;
      result = await render(job.settings.dropFrames, true);
    }
    if (result!.bytes.length > job.settings.maxBytes) {
      await update(job, { detail: String(result!.bytes.length) }); throw new TaskError('budgetUnreachable');
    }
    await update(job, { stage: 'validating', progress: 0.95 });
    const metadata = inspectGif(result!.bytes, { maxBytes: job.settings.maxBytes, maxSide: job.settings.maxSide,
      duration: staticImage ? 0 : clipDuration, fps: candidate.fps, frames: result!.plan.indices.length });
    check();
    await saveResult(job.id, new Blob([result!.bytes.slice().buffer as ArrayBuffer], { type: 'image/gif' }));
    check(); metrics.totalMs = performance.now() - started;
    await update(job, { stage: 'completed', progress: 1, metrics, result: { ...metadata, filename: makeFilename(job) } });
  } catch (error) {
    const code = abort.signal.aborted ? 'cancelled' : errorCode(error);
    await deleteResult(job.id); metrics.totalMs = performance.now() - started;
    await update(job, { stage: code === 'cancelled' ? 'cancelled' : 'failed', error: code, metrics });
  } finally {
    if (readingBlob) await player({ type: 'cancel-read' }).catch(() => {});
    state.image?.close(); state.video?.close(); state.download?.close(); ffmpeg.terminate(); current = undefined;
    const removedIds = await pruneHistory();
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
      case 'history': {
        const history = await getHistory(); history.jobs.sort((a, b) => b.createdAt - a.createdAt); return history;
      }
      case 'cache-summary': return getCacheSummary();
      case 'clear-cache':
      case 'clear-history': {
        const mode = message.type === 'clear-cache' ? 'cache' : 'history';
        const cleared = await clearStoredItems(message.ids, mode, [...queue.map(job => job.id), ...(current ? [current.job.id] : [])]);
        await chrome.runtime.sendMessage({ type: mode === 'cache' ? 'cache-cleared' : 'jobs-removed', ids: cleared.ids }).catch(() => {});
        return cleared;
      }
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
        if (active && active.job.id === message.id && !isTerminal(active.job.stage)) { active.abort.abort(); active.ffmpeg?.terminate(); active.image?.close(); active.video?.close(); active.download?.close(); await rpc({ target: 'background', type: 'player', jobId: active.job.id, command: { type: 'cancel-read' } }).catch(() => {}); }
        return null;
      }
      case 'delete': {
        if (queue.some(job => job.id === message.id) || current?.job.id === message.id) throw new TaskError('playerBusy');
        const removed = await removeJob(message.id);
        await chrome.runtime.sendMessage({ type: 'jobs-removed', ids: removed.ids }).catch(() => {});
        return null;
      }
      case 'inspect-image': {
        const worker = imageClient();
        try { return await worker.request('open', { blob: await downloadSource(message.source, new AbortController().signal) }); }
        finally { worker.close(); }
      }
      case 'result-url': {
        const blob = await getResult(message.id); if (!blob) throw new TaskError('resultUnavailable');
        const url = URL.createObjectURL(blob); resultUrls.add(url);
        return url;
      }
      case 'release-result-url':
        if (resultUrls.delete(message.url)) URL.revokeObjectURL(message.url);
        return null;
      default: throw new TaskError('interrupted');
    }
  };
  void handle().then(data => sendResponse({ ok: true, data } satisfies Reply), error => sendResponse({ ok: false, error: errorCode(error) } satisfies Reply));
  return true;
});
