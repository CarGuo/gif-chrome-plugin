// v0.1.7: inspect the selected page's media transport before starting conversion. These
// functions run in MAIN because isolated content scripts cannot see the player's MSE state.
// Only media request metadata is observed; ordinary response bodies and headers are untouched.
export interface PageMediaSnapshot {
  videos: { id: string; url: string; poster: string; declared: string[]; blobKind?: 'file' | 'mse'; youtube?: YoutubeSession }[];
  resources: string[];
}
export interface YoutubeSession {
  videoId: string; formats: Record<string, unknown>[]; url?: string; request?: number[];
  config?: string; duration: number;
}

export function installPageObserver() {
  const page = window as typeof window & { __gifToolkitMedia?: any };
  if (page.__gifToolkitMedia) return;
  const state = page.__gifToolkitMedia = { page: location.href, resources: [] as string[], blobs: new Map(), sabr: undefined as any };
  const reset = () => {
    if (state.page !== location.href) { state.page = location.href; state.resources = []; state.sabr = undefined; }
  };
  const record = (url: string) => {
    reset();
    try { url = new URL(url, location.href).href; } catch { return; }
    if (!/^https?:/.test(url) || !/\.(?:m3u8|mpd)(?:[?#]|$)/i.test(url)) return;
    if (!state.resources.includes(url)) state.resources.push(url);
    if (state.resources.length > 128) state.resources.shift();
  };
  const observeRequest = (url: string, body: unknown) => {
    reset(); record(url);
    try {
      const target = new URL(url, location.href);
      if (!target.hostname.endsWith('.googlevideo.com') || target.pathname !== '/videoplayback' || target.searchParams.get('sabr') !== '1') return;
      const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : ArrayBuffer.isView(body) ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength) : undefined;
      if (!bytes?.length || bytes.length > 65536) return;
      const videoId = new URL(location.href).searchParams.get('v') ?? /^\/(?:shorts|embed)\/([^/]+)/.exec(location.pathname)?.[1];
      state.sabr = { url: target.href, request: Array.from(bytes), videoId };
    } catch { /* Non-media requests are not part of discovery. */ }
  };
  const originalCreate = URL.createObjectURL;
  URL.createObjectURL = function (object) {
    const url = originalCreate.call(this, object);
    state.blobs.set(url, object instanceof Blob ? 'file' : 'mse');
    return url;
  };
  const originalRevoke = URL.revokeObjectURL;
  URL.revokeObjectURL = function (url) { state.blobs.delete(url); return originalRevoke.call(this, url); };
  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = input instanceof Request ? input.url : String(input);
    if (init?.body) observeRequest(url, init.body);
    else if (input instanceof Request && input.method === 'POST' && url.includes('.googlevideo.com/')) {
      void input.clone().arrayBuffer().then(body => observeRequest(url, body)).catch(() => {});
    }
    record(url);
    return originalFetch.call(this, input, init);
  };
  const requests = new WeakMap<XMLHttpRequest, string>();
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: any[]) {
    requests.set(this, String(url)); record(String(url));
    return Reflect.apply(originalOpen, this, [method, url, ...rest]);
  };
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body) { observeRequest(requests.get(this) ?? '', body); return originalSend.call(this, body); };
  for (const entry of performance.getEntriesByType('resource')) record(entry.name);
  new PerformanceObserver(list => { for (const entry of list.getEntries()) record(entry.name); }).observe({ type: 'resource', buffered: true });
}

export function readPageMedia(): PageMediaSnapshot {
  const state = (window as typeof window & { __gifToolkitMedia?: any }).__gifToolkitMedia;
  function videos(root: Document | ShadowRoot): HTMLVideoElement[] {
    return [...root.querySelectorAll('video'), ...[...root.querySelectorAll('*')].flatMap(el => el.shadowRoot ? videos(el.shadowRoot) : [])];
  }
  return {
    resources: state?.page === location.href ? [...state.resources] : [],
    videos: videos(document).map(video => {
      const result: PageMediaSnapshot['videos'][number] = { id: video.dataset.gifToolkitId ?? '', url: video.currentSrc || video.src,
        poster: video.poster, declared: [...video.querySelectorAll('source')].map(source => source.src), blobKind: state?.blobs.get(video.currentSrc) };
      // v0.1.7: Vimeo embeds declare their HLS master even when playback uses its JSON DASH transport.
      if (location.hostname === 'player.vimeo.com' && videos(document).length === 1) {
        const config = (window as any).playerConfig;
        if (String(config?.video?.id) === /^\/video\/(\d+)/.exec(location.pathname)?.[1]) {
          const hls = config.request?.files?.hls;
          const cdn = hls?.cdns?.[hls.default_cdn];
          if (cdn?.avc_url || cdn?.url) result.declared.push(cdn.avc_url || cdn.url);
        }
      }
      if (/(^|\.)(youtube\.com|youtube-nocookie\.com)$/.test(location.hostname)) {
        const player = video.closest('#movie_player') as Element & { getPlayerResponse?: () => any } | null;
        const data = player?.getPlayerResponse?.();
        if (data?.videoDetails?.videoId && data.streamingData) {
          const observed = state?.page === location.href && state.sabr?.videoId === data.videoDetails.videoId ? state.sabr : undefined;
          result.youtube = { videoId: data.videoDetails.videoId, duration: video.duration,
            formats: data.streamingData.adaptiveFormats ?? [],
            config: data.playerConfig?.mediaCommonConfig?.mediaUstreamerRequestConfig?.videoPlaybackUstreamerConfig,
            url: observed?.url, request: observed?.request };
          if (data.streamingData.hlsManifestUrl) result.declared.push(data.streamingData.hlsManifestUrl);
          if (data.streamingData.dashManifestUrl) result.declared.push(data.streamingData.dashManifestUrl);
        }
      }
      return result;
    }),
  };
}
