import { TaskError, type MediaSource } from './model';
import type { PageMediaSnapshot } from './page-media';

export interface MediaResource { kind: 'file' | 'hls' | 'dash'; url: string }

export function resourceType(url: string): MediaResource['kind'] {
  const path = new URL(url).pathname;
  return /\.m3u8$/i.test(path) ? 'hls' : /\.mpd$/i.test(path) ? 'dash' : 'file';
}

export function youtubeId(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!/(^|\.)(youtube\.com|youtube-nocookie\.com)$/.test(url.hostname)) return;
    return url.searchParams.get('v') ?? /^\/(?:shorts|embed)\/([\w-]+)/.exec(url.pathname)?.[1];
  } catch { return; }
}

export function attachResources(source: MediaSource, snapshot: PageMediaSnapshot): MediaSource {
  const video = snapshot.videos.find(video => video.id === source.id && video.url === source.url);
  if (!video) return source;
  const declared = video.declared.filter(url => /^https?:/.test(url));
  // v0.1.7: one observed manifest does not establish identity when a frame contains
  // several players. Only declared sources or an unambiguous single player can auto-select.
  const urls = video.blobKind === 'file' ? [] : [...new Set(declared.length ? declared : snapshot.resources)];
  return { ...source, blobKind: video.blobKind,
    resources: urls.map(url => ({ kind: resourceType(url), url })),
    resourceSelectionRequired: !declared.length && snapshot.videos.length !== 1 && urls.length > 0,
    youtubeVideoId: video.youtube?.videoId };
}

export function chosenResource(source: MediaSource): MediaResource | undefined {
  if (source.resource) {
    if (!source.resources?.some(item => item.kind === source.resource!.kind && item.url === source.resource!.url)) throw new TaskError('sourceChanged');
    return source.resource;
  }
  if (/^https?:|^data:/.test(source.url)) return { kind: resourceType(source.url), url: source.url };
  if (!source.resourceSelectionRequired && source.resources?.length === 1) return source.resources[0];
  return;
}

export function chooseVideoSize<T>(items: T[], dimensions: (item: T) => { width: number; height: number }, maxSide: number): T | undefined {
  const sorted = items.filter(item => {
    const { width, height } = dimensions(item);
    return [width, height].every(value => Number.isFinite(value) && value > 0);
  }).sort((a, b) => {
    const x = dimensions(a), y = dimensions(b);
    return Math.max(y.width, y.height) - Math.max(x.width, x.height);
  });
  // v0.1.8: maxSide is a ceiling, not a minimum resolution to download. Use the
  // largest representation within it. If none exists, only the smallest source can be resized.
  return sorted.find(item => { const size = dimensions(item); return Math.max(size.width, size.height) <= maxSide; }) ?? sorted.at(-1);
}
