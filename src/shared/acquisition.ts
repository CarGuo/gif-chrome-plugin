import { httpOrigin, POLICY, TaskError, type MediaSource } from './model';
import { chooseVideoSize, chosenResource, youtubeId } from './media-resource';

const X_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']);
export const X_MEDIA_ORIGINS = ['https://cdn.syndication.twimg.com/*', 'https://video.twimg.com/*'];

export function xPostId(value: string): string | undefined {
  try {
    const url = new URL(value);
    return X_HOSTS.has(url.hostname) ? /^\/(?:[^/]+\/status|i\/web\/status|statuses)\/(\d+)(?:\/|$)/.exec(url.pathname)?.[1] : undefined;
  } catch { return undefined; }
}

export function acquisition(source: MediaSource): 'download' | 'x' | 'youtube' | 'hls' | 'dash' | 'blob' | 'unresolved' {
  // v0.1.7: all video paths acquire bytes. A manifest is a download transport, not a reason
  // to switch to seeking the page player. Provider adapters are peers of generic transports.
  if (source.kind === 'video' && !source.resource && youtubeId(source.pageUrl)) return 'youtube';
  if (source.kind === 'video' && !source.resource && !/^https?:|^data:/.test(source.url) && xPostId(source.mediaPageUrl ?? source.pageUrl)) return 'x';
  const resource = chosenResource(source);
  if (resource) return resource.kind === 'file' ? 'download' : resource.kind;
  if (source.kind === 'video' && xPostId(source.mediaPageUrl ?? source.pageUrl)) return 'x';
  if (source.url.startsWith('blob:') && source.blobKind !== 'mse' && !source.resources?.length) return 'blob';
  return 'unresolved';
}

export function mediaOrigins(sources: MediaSource[]): string[] {
  return [...new Set(sources.flatMap(source => {
    const mode = acquisition(source);
    if (mode === 'x') return X_MEDIA_ORIGINS;
    if (mode === 'youtube') return ['https://*.googlevideo.com/*'];
    // Manifest segments/keys can live on other CDNs. Ask in the Generate gesture, before any
    // asynchronous playlist read; each request is still checked against the granted origins.
    if (mode === 'hls' || mode === 'dash') return ['http://*/*', 'https://*/*'];
    const url = chosenResource(source)?.url ?? source.url;
    return mode === 'download' && !url.startsWith('data:') ? [httpOrigin(url)] : [];
  }))];
}

export function xMetadataUrl(source: MediaSource): string {
  const id = xPostId(source.mediaPageUrl ?? source.pageUrl);
  if (!id) throw new TaskError('sourceNotReady');
  // v0.1.6: use the public embed API's token algorithm (also documented by yt-dlp).
  // No account credentials, private GraphQL endpoint IDs, or post-specific URLs are embedded.
  const token = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
  return `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${token}`;
}

function posterKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    // The image CDN serves the same asset as /name.jpg or /name?format=jpg&name=small.
    return url.hostname === 'pbs.twimg.com' ? url.pathname.replace(/\.(?:jpe?g|png|webp)$/i, '') : undefined;
  } catch { return; }
}

export function xVideoUrl(source: MediaSource, data: unknown, maxSide: number = POLICY.maxSide): string {
  const tweet = data as { id_str?: string; mediaDetails?: unknown[]; quoted_tweet?: { mediaDetails?: unknown[] } } | null;
  if (!tweet?.id_str) throw new TaskError('downloadFailed');
  if (tweet.id_str !== xPostId(source.mediaPageUrl ?? source.pageUrl)) throw new TaskError('sourceChanged');
  const poster = posterKey(source.poster);
  if (!poster) throw new TaskError('sourceNotReady');
  const details = [...(tweet.mediaDetails ?? []), ...(tweet.quoted_tweet?.mediaDetails ?? [])] as {
    media_url_https?: string; video_info?: { duration_millis?: number; variants?: { url: string; bitrate?: number; content_type: string }[] };
  }[];
  // v0.1.6: match the selected player's poster, never the first video in a post/feed/quote.
  const matches = details.filter(detail => posterKey(detail.media_url_https) === poster && detail.video_info);
  if (matches.length !== 1) throw new TaskError('sourceChanged');
  const info = matches[0].video_info!;
  // v0.1.8: post + poster identify the media; a presentation duration is not an identity.
  const variants = (info.variants ?? []).filter(variant => {
    try { const url = new URL(variant.url); return variant.content_type === 'video/mp4' && url.protocol === 'https:' && url.hostname === 'video.twimg.com' && !url.username && !url.password; }
    catch { return false; }
  }).sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
  if (!variants.length) throw new TaskError('downloadFailed');
  // X encodes representation dimensions in the URL, as parsed by yt-dlp's Twitter extractor.
  // Do not substitute the original upload/player dimensions for an individual representation.
  const selected = chooseVideoSize(variants, variant => {
    const size = /\/(\d+)x(\d+)\//.exec(new URL(variant.url).pathname);
    return { width: Number(size?.[1]), height: Number(size?.[2]) };
  }, maxSide);
  if (!selected) throw new TaskError('unsupportedVideo');
  return selected.url;
}
