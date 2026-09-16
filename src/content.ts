import { fitDimensions, POLICY, TaskError, errorCode, type MediaSource, type Reply } from './shared/model';
import { contextTarget } from './shared/context-target';
import { mediaTitle } from './shared/media-title';

declare global { interface Window { __gifToolkitLoaded?: boolean } }
if (!window.__gifToolkitLoaded) {
  window.__gifToolkitLoaded = true;
  const documentKey = crypto.randomUUID();
  const ids = new WeakMap<Element, { id: string; signature: string }>();
  const elements = new Map<string, HTMLVideoElement | HTMLImageElement>();
  let rightTarget: Element | undefined;
  let session: { token: string; video: HTMLVideoElement; source: string; page: string; time: number; paused: boolean; rate: number; muted: boolean; hold: () => void; timer?: ReturnType<typeof setTimeout> } | undefined;

  function mediaElements(root: Document | ShadowRoot): (HTMLVideoElement | HTMLImageElement)[] {
    const media = [...root.querySelectorAll<HTMLVideoElement | HTMLImageElement>('video,img')];
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) media.push(...mediaElements(el.shadowRoot));
    return media;
  }
  function kindOf(el: HTMLVideoElement | HTMLImageElement) {
    if (el instanceof HTMLVideoElement) return 'video' as const;
    const url = el.currentSrc || el.src;
    // URL is only a discovery hint. The worker verifies bytes and animation before processing.
    if (/\.gif(?:[?#]|$)|[?&](?:format|fm)=gif(?:&|$)|^data:image\/gif/i.test(url)) return 'gif' as const;
    if (/\.webp(?:[?#]|$)|[?&](?:format|fm)=webp(?:&|$)|^data:image\/webp/i.test(url)) return 'webp' as const;
    return null;
  }
  function identify(el: Element) {
    const media = el as HTMLVideoElement | HTMLImageElement;
    const signature = `${location.href}\n${media.currentSrc || media.src}\n${media instanceof HTMLVideoElement ? media.poster : ''}`;
    const previous = ids.get(el);
    if (previous?.signature !== signature) {
      if (previous) elements.delete(previous.id);
      ids.set(el, { id: crypto.randomUUID(), signature });
    }
    return ids.get(el)!.id;
  }
  function scan(focus?: { useContext?: boolean; srcUrl?: string; mediaType?: string }): MediaSource[] {
    const result: MediaSource[] = [];
    const current = mediaElements(document);
    for (const [id, el] of elements) if (!el.isConnected) elements.delete(id);
    for (const el of current) {
      const nativeImage = focus?.mediaType === 'image' && (el.currentSrc || el.src) === focus.srcUrl;
      const kind = kindOf(el) ?? ((focus?.useContext && el === rightTarget || nativeImage) ? 'image' : null);
      if (!kind) continue;
      const id = identify(el); elements.set(id, el);
      const isVideo = el instanceof HTMLVideoElement;
      const duration = isVideo && Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null;
      const title = mediaTitle(el, result.length);
      result.push({ id, documentKey, tabId: -1, frameId: -1, kind,
        url: el.currentSrc || el.src, pageUrl: location.href, title: title.slice(0, 200),
        width: isVideo ? el.videoWidth : el.naturalWidth, height: isVideo ? el.videoHeight : el.naturalHeight,
        duration, currentTime: isVideo ? el.currentTime : 0,
        poster: isVideo ? el.poster || undefined : (el.currentSrc || el.src), selected: !!focus?.useContext && rightTarget === el });
    }
    return result;
  }
  window.addEventListener('contextmenu', event => {
    rightTarget = contextTarget(event);
    // v0.1.1: X/YouTube cancel the native menu in page handlers. Intercept propagation early,
    // without preventDefault(), so Chrome can display the extension command. Alt keeps the site menu.
    // Restrict interception to video / recognized animation; ordinary page interaction is unchanged.
    if (!event.altKey && rightTarget && (rightTarget instanceof HTMLVideoElement || kindOf(rightTarget as HTMLImageElement))) {
      event.stopImmediatePropagation();
    }
  }, true);

  async function restore(token: string) {
    if (!session || session.token !== token) return;
    const state = session; session = undefined; clearTimeout(state.timer);
    state.video.removeEventListener('play', state.hold, true);
    if (!state.video.isConnected || state.source !== state.video.currentSrc || state.page !== location.href) return;
    state.video.currentTime = state.time; state.video.playbackRate = state.rate; state.video.muted = state.muted;
    if (!state.paused) await state.video.play().catch(() => {});
  }
  function check(token: string) {
    if (!session || session.token !== token) throw new TaskError('cancelled');
    if (!session.video.isConnected) throw new TaskError('sourceGone');
    if (session.source !== session.video.currentSrc || session.page !== location.href) throw new TaskError('sourceChanged');
    clearTimeout(session.timer);
    // v0.1: lease prevents a terminated extension task from leaving the user's player paused indefinitely.
    session.timer = setTimeout(() => void restore(token).catch(() => {}), POLICY.seekTimeoutMs * 2);
    return session.video;
  }
  async function seek(video: HTMLVideoElement, time: number) {
    if (video.readyState >= 2 && Math.abs(video.currentTime - time) < 0.002) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new TaskError('seekFailed')), POLICY.seekTimeoutMs);
      let callback = 0;
      const finish = (error?: Error) => {
        clearTimeout(timer); video.removeEventListener('error', fail); video.removeEventListener('seeked', onSeeked);
        if (callback) video.cancelVideoFrameCallback(callback);
        error ? reject(error) : resolve();
      };
      const fail = () => finish(new TaskError('seekFailed'));
      const onSeeked = () => {
        video.pause();
        if (video.readyState >= 2 && Math.abs(video.currentTime - time) < 0.1) finish();
      };
      // The seeked event denotes a decoded seek result even in a paused / background player.
      video.addEventListener('seeked', onSeeked); video.addEventListener('error', fail, { once: true });
      callback = video.requestVideoFrameCallback((_now, metadata) => {
        if (Math.abs(metadata.mediaTime - time) < 0.15 && !video.seeking) finish();
      });
      try { video.currentTime = time; } catch { fail(); }
    });
  }
  async function handle(message: Record<string, any>) {
    if (message.type === 'scan') return scan(message.focus);
    if (message.type === 'restore') { await restore(message.token); return null; }
    if (message.documentKey !== documentKey) throw new TaskError('sourceChanged');
    if (message.type === 'begin') {
      if (session) throw new TaskError('playerBusy');
      const video = elements.get(message.sourceId);
      if (!(video instanceof HTMLVideoElement) || !video.isConnected) throw new TaskError('sourceGone');
      // v0.1: SPA players can reuse a DOM node for a different video after the user selected a clip.
      if (message.expectedUrl !== video.currentSrc || message.expectedPageUrl !== location.href || (message.expectedPoster && message.expectedPoster !== video.poster)) throw new TaskError('sourceChanged');
      if (video.mediaKeys) throw new TaskError('protectedMedia');
      if (!video.videoWidth || !video.videoHeight || video.readyState < 2) throw new TaskError('sourceNotReady');
      if (!Number.isFinite(video.duration)) throw new TaskError('invalidSegment');
      // v0.1: custom players may resume automatically after a seek. A capture session owns playback
      // until release, otherwise asynchronous PNG encoding can sample the next, unintended frame.
      const hold = () => video.pause();
      session = { token: message.token, video, source: video.currentSrc, page: location.href,
        time: video.currentTime, paused: video.paused, muted: video.muted, rate: video.playbackRate, hold };
      video.addEventListener('play', hold, true); video.muted = true; video.pause(); check(message.token);
      return { width: video.videoWidth, height: video.videoHeight, duration: video.duration };
    }
    if (message.type === 'frame') {
      const video = check(message.token);
      if (!Number.isFinite(message.time) || message.time < 0 || message.time >= video.duration) throw new TaskError('invalidSegment');
      await seek(video, message.time); check(message.token); video.pause();
      const dims = fitDimensions(video.videoWidth, video.videoHeight, message.maxSide);
      // Only DOM-dependent pixel extraction is performed here. PNG compression is browser asynchronous work;
      // GIF quantization/encoding never runs on the page's UI thread.
      const canvas = new OffscreenCanvas(dims.width, dims.height);
      const context = canvas.getContext('2d')!;
      try {
        context.drawImage(video, 0, 0, dims.width, dims.height);
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        return { blob, ...dims };
      } catch (error) {
        if (error instanceof DOMException && error.name === 'SecurityError') throw new TaskError('crossOriginPixels');
        throw error;
      }
    }
    throw new TaskError('sourceGone');
  }
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || message?.target !== 'content') return;
    void handle(message).then(data => sendResponse({ ok: true, data } satisfies Reply),
      error => sendResponse({ ok: false, error: errorCode(error) } satisfies Reply));
    return true;
  });
}
