import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadBlob, downloadSource } from '../src/shared/download';
import type { MediaSource } from '../src/shared/model';

const permission = vi.fn();
beforeEach(() => {
  permission.mockReset(); permission.mockResolvedValue({ ok: true, data: true });
  vi.stubGlobal('chrome', { runtime: { sendMessage: permission } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('v0.1.6 bounded, cancellable media downloads', () => {
  it('downloads only the selected X representation under the requested ceiling', async () => {
    const source = { kind: 'video', url: 'blob:https://x.com/player', pageUrl: 'https://x.com/user/status/123', poster: 'https://pbs.twimg.com/ext_tw_video_thumb/456/a.jpg', duration: 12.08 } as MediaSource;
    const urls = [432, 576, 1152].map(width => `https://video.twimg.com/vid/${width}x${width * 5 / 8}/video.mp4`);
    const metadata = { id_str: '123', mediaDetails: [{ media_url_https: source.poster, video_info: { duration_millis: 12000,
      variants: urls.map((url, i) => ({ url, content_type: 'video/mp4', bitrate: (i + 1) * 100000 })) } }] };
    const fetch = vi.fn(async (url: string) => url.startsWith('https://cdn.syndication.twimg.com/') ? Response.json(metadata)
      : url === urls[1] ? new Response(new Uint8Array([1, 2, 3])) : new Response(null, { status: 500 }));
    vi.stubGlobal('fetch', fetch);
    expect((await downloadSource(source, new AbortController().signal, undefined, 800)).size).toBe(3);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([expect.stringContaining('tweet-result?id=123&token='), urls[1]]);
  });
  it('requires host permission before the first media request', async () => {
    permission.mockResolvedValue({ ok: true, data: false });
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(downloadBlob('https://media.test/a.mp4', new AbortController().signal)).rejects.toThrow('permissionRequired');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('checks the advertised size without reading an oversized response', async () => {
    const cancelled = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ cancel: cancelled }), { headers: { 'content-length': '100' } })));
    await expect(downloadBlob('https://media.test/a.mp4', new AbortController().signal, undefined, 4)).rejects.toThrow('inputTooLarge');
    expect(cancelled).toHaveBeenCalled();
  });
  it('enforces the byte bound while streaming even without content-length', async () => {
    const cancelled = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(5)); }, cancel: cancelled }))));
    await expect(downloadBlob('https://media.test/a.mp4', new AbortController().signal, undefined, 4)).rejects.toThrow('inputTooLarge');
    expect(cancelled).toHaveBeenCalled();
  });
  it('returns the complete input with its content type and final byte progress', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'video/mp4' } })));
    const progress = vi.fn(async () => {});
    const blob = await downloadBlob('https://media.test/a.mp4', new AbortController().signal, progress);
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(blob.type).toBe('video/mp4');
    expect(progress).toHaveBeenLastCalledWith(3, 3);
  });
  it('distinguishes cancellation from a network failure and never returns partial media', async () => {
    const abort = new AbortController(); abort.abort();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('aborted', 'AbortError'); }));
    await expect(downloadBlob('https://media.test/a.mp4', abort.signal)).rejects.toThrow('cancelled');
    await expect(downloadBlob('https://media.test/a.mp4', new AbortController().signal)).rejects.toThrow('downloadFailed');
  });
  it('allows a progressing video transfer to exceed 30 seconds but aborts a stalled connection', async () => {
    vi.useFakeTimers();
    let sent = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => new Response(new ReadableStream({
      async pull(controller) {
        await new Promise(resolve => setTimeout(resolve, 20_000));
        controller.enqueue(new Uint8Array([++sent]));
        if (sent === 3) controller.close();
      },
      start(controller) { init.signal.addEventListener('abort', () => controller.error(new DOMException('timeout', 'AbortError'))); },
    }))));
    const progressing = downloadBlob('https://media.test/a.mp4', new AbortController().signal);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await progressing).size).toBe(3);
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')));
    })));
    const stalled = expect(downloadBlob('https://media.test/a.mp4', new AbortController().signal)).rejects.toThrow('downloadFailed');
    await vi.advanceTimersByTimeAsync(30_000); await stalled;
  });
});
