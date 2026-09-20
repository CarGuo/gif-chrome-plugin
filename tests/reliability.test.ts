import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerClient } from '../src/worker-client';
import { migrateJob } from '../src/shared/history';
import { parseDownloadSelection } from '../src/shared/download-selection';
import { makeFilename } from '../src/shared/filename';
import { POLICY, type Job } from '../src/shared/model';

const job: Job = { id: 'legacy', source: { id: 'media', documentKey: 'doc', tabId: 1, frameId: 0, kind: 'gif', url: 'https://media.test/a.gif',
  pageUrl: 'https://page.test/', title: 'Legacy name', width: 32, height: 32, duration: 1, currentTime: 0 },
  settings: { maxBytes: 4_000_000, maxSide: 800, fps: 10, speed: 1, dropFrames: 'none' }, segment: { id: 'clip', start: 0, end: 1 },
  stage: 'completed', progress: 1, createdAt: 1000, updatedAt: 1000, result: { width: 32, height: 32, bytes: 100, frames: 10, duration: 1, filename: 'old name.gif' } };

describe('v0.1.11 history validation without invented defaults', () => {
  it('migrates legacy additive fields and filename without mutating stored data', () => {
    const legacy = { ...job, settings: { maxBytes: 4_000_000, maxSide: 800, fps: 12 } };
    const migrated = migrateJob(legacy);
    expect(migrated.settings).toEqual({ ...legacy.settings, speed: 1, dropFrames: 'none' });
    expect(migrated.result?.filename).toBe(makeFilename(job));
    expect(legacy.result!.filename).toBe('old name.gif');
    expect('speed' in legacy.settings).toBe(false);
  });
  it.each([null, { ...job, settings: { ...job.settings, fps: 0 } }, { ...job, source: null },
    { ...job, source: { ...job.source, mediaPageUrl: 'javascript:alert(1)' } }, { ...job, createdAt: 1e30 },
    { ...job, segment: null }, { ...job, result: { bytes: 4 } }, { ...job, error: 5 }])('rejects a damaged record explicitly: %j', value => {
    expect(() => migrateJob(value)).toThrow('invalidHistory');
  });
  it('preserves cleared-file state and manual settings', () => {
    expect(migrateJob({ ...job, result: { ...job.result, clearedAt: 2000 } }).result?.clearedAt).toBe(2000);
    expect(migrateJob(job).settings).toEqual(job.settings);
  });
});

describe('v0.1.11 batch structure versus item errors', () => {
  it.each([undefined, {}, [], Array.from({ length: 31 }, (_, i) => ({ id: String(i) })), [null], [{ id: '' }], [{ id: 1 }], [{ id: 'same' }, { id: 'same' }]])('rejects an ambiguous/invalid envelope: %j', items => {
    expect(() => parseDownloadSelection(items)).toThrow('invalidSettings');
  });
  it('leaves title validation to individual downloads while copying the immutable list', () => {
    const items = [{ id: 'one', title: '' }, { id: 'two', title: 'Valid' }];
    const selected = parseDownloadSelection(items); items[1].id = 'changed';
    expect(selected).toEqual([{ id: 'one', title: '' }, { id: 'two', title: 'Valid' }]);
  });
});

class TestWorker {
  onmessage: ((event: any) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  sent: any[] = [];
  postMessage = vi.fn((data: any) => { this.sent.push(data); });
  terminate = vi.fn();
}
afterEach(() => vi.useRealTimers());
describe('v0.1.11 worker inactivity and ownership', () => {
  it('terminates a stalled worker, rejects every pending request, and ignores late output', async () => {
    vi.useFakeTimers(); const worker = new TestWorker(), client = new WorkerClient(worker as unknown as Worker);
    const results = [client.request('frame').catch(error => error.code), client.request('prepare').catch(error => error.code)];
    const late = worker.onmessage!;
    await vi.advanceTimersByTimeAsync(POLICY.seekTimeoutMs);
    expect(await Promise.all(results)).toEqual(['workerTimeout', 'workerTimeout']);
    expect(worker.terminate).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
    late({ data: { id: worker.sent[0].id, ok: true, data: 'late frame' } });
    await expect(client.request('frame')).rejects.toThrow('workerTimeout');
  });
  it('allows a genuinely active operation to outlive its idle deadline, not an unrelated heartbeat', async () => {
    vi.useFakeTimers(); const worker = new TestWorker(), client = new WorkerClient(worker as unknown as Worker);
    const result = client.request('frame').catch(error => error.code);
    await vi.advanceTimersByTimeAsync(14000);
    worker.onmessage!({ data: { id: worker.sent[0].id, activity: true } });
    await vi.advanceTimersByTimeAsync(14000); expect(worker.terminate).not.toHaveBeenCalled();
    worker.onmessage!({ data: { id: 'unrelated', activity: true } });
    await vi.advanceTimersByTimeAsync(1000); expect(await result).toBe('workerTimeout');
  });
  it('gives metadata opening a larger budget and cancels it immediately on close', async () => {
    vi.useFakeTimers(); const worker = new TestWorker(), client = new WorkerClient(worker as unknown as Worker);
    const result = client.request('open').catch(error => error.code);
    await vi.advanceTimersByTimeAsync(POLICY.seekTimeoutMs + 1); expect(worker.terminate).not.toHaveBeenCalled();
    client.close(); expect(await result).toBe('cancelled'); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['error', 'messageerror', 'clone'] as const)('releases requests and timers on %s', async kind => {
    vi.useFakeTimers(); const worker = new TestWorker(), client = new WorkerClient(worker as unknown as Worker);
    if (kind === 'clone') worker.postMessage.mockImplementation(() => { throw new DOMException('', 'DataCloneError'); });
    const result = client.request('frame').catch(error => error.code);
    if (kind === 'error') worker.onerror!(); if (kind === 'messageerror') worker.onmessageerror!();
    expect(await result).toBe('encodingFailed'); expect(vi.getTimerCount()).toBe(0); expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
  it('releases a completed request timer without killing its reusable worker', async () => {
    vi.useFakeTimers(); const worker = new TestWorker(), client = new WorkerClient(worker as unknown as Worker);
    const result = client.request('frame'); worker.onmessage!({ data: { id: worker.sent[0].id, ok: true, data: 'frame' } });
    expect(await result).toBe('frame'); expect(vi.getTimerCount()).toBe(0); expect(worker.terminate).not.toHaveBeenCalled(); client.close();
  });
});
