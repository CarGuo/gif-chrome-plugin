import { downloadBlob } from './shared/download';
import { TaskError, errorCode, POLICY, type MediaSource, type Reply } from './shared/model';
import { contextTarget } from './shared/context-target';
import { mediaTitle } from './shared/media-title';

declare global { interface Window { __gifToolkitLoaded?: boolean } }
if (!window.__gifToolkitLoaded) {
  window.__gifToolkitLoaded = true;
  const documentKey = crypto.randomUUID();
  const ids = new WeakMap<Element, { id: string; signature: string }>();
  const elements = new Map<string, HTMLVideoElement | HTMLImageElement>();
  let rightTarget: Element | undefined;
  const reads = new Map<string, AbortController>();

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
    const id = ids.get(el)!.id;
    media.dataset.gifToolkitId = id;
    return id;
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
        mediaPageUrl: (el.closest('article')?.querySelector('a:has(time)') as HTMLAnchorElement | null)?.href,
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

  function selectedVideo(message: Record<string, any>) {
    if (message.documentKey !== documentKey) throw new TaskError('sourceChanged');
    const video = elements.get(message.sourceId);
    if (!(video instanceof HTMLVideoElement) || !video.isConnected) throw new TaskError('sourceGone');
    if (message.expectedUrl !== (video.currentSrc || video.src) || message.expectedPageUrl !== location.href || (message.expectedPoster && message.expectedPoster !== video.poster)) throw new TaskError('sourceChanged');
    if (video.mediaKeys) throw new TaskError('protectedMedia');
    if (message.type === 'inspect' && (!video.videoWidth || !video.videoHeight || video.readyState < 2)) throw new TaskError('sourceNotReady');
    if (message.type === 'inspect' && !Number.isFinite(video.duration)) throw new TaskError('invalidSegment');
    return video;
  }
  async function handle(message: Record<string, any>) {
    if (message.type === 'scan') return scan(message.focus);
    if (message.type === 'cancel-read') { reads.get(message.token)?.abort(); return null; }
    const video = selectedVideo(message);
    if (message.type === 'inspect') return { width: video.videoWidth, height: video.videoHeight, duration: video.duration };
    if (message.type === 'read-blob' || message.type === 'read-sabr') {
      // v0.1.7: file blobs belong to the page origin. Fetch their bytes here, but never
      // seek/capture the player. MSE blobs are transport handles, not downloadable files.
      const sabr = message.type === 'read-sabr';
      const url = sabr ? new URL(message.url) : new URL(video.currentSrc);
      if (sabr) {
        if (!/(^|\.)(youtube\.com|youtube-nocookie\.com)$/.test(location.hostname) || url.protocol !== 'https:' || !url.hostname.endsWith('.googlevideo.com') || url.pathname !== '/videoplayback' || url.searchParams.get('sabr') !== '1' || !(message.body instanceof Uint8Array) || message.body.length > 65536) throw new TaskError('permissionRequired');
      } else if (url.protocol !== 'blob:') throw new TaskError('sourceChanged');
      const abort = new AbortController(); reads.set(message.token, abort);
      try {
        // SABR requests belong to the page's playback origin. Only asynchronous network IO
        // happens here; protocol decoding and video work remain in the dedicated Worker.
        const blob = await downloadBlob(url.href, abort.signal, undefined, POLICY.inputBytes, async () => true,
          sabr ? { method: 'POST', body: message.body, credentials: 'omit', headers: { 'Content-Type': 'application/x-protobuf', Accept: 'application/vnd.yt-ump' } } : undefined);
        selectedVideo(message); return blob;
      } finally { reads.delete(message.token); }
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
