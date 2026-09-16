import { defaultSegment, httpOrigin, type MediaSource, type Segment } from './model';

type ImageMetadata = { width: number; height: number; duration: number | null; frames: number; kind: MediaSource['kind'] };
export function withImageMetadata(source: MediaSource, meta: ImageMetadata): MediaSource {
  return { ...source, width: meta.width, height: meta.height, duration: meta.duration, frameCount: meta.frames, kind: meta.kind };
}
export function sameSource(left: MediaSource, right: MediaSource): boolean {
  return left.id === right.id && left.documentKey === right.documentKey && left.url === right.url && left.pageUrl === right.pageUrl;
}
export function retainImageMetadata(next: MediaSource[], previous: MediaSource[]): MediaSource[] {
  // v0.1.4: DOM rescans cannot read animation timing. Retain decoded metadata only for the
  // exact same source, so refreshing the list never turns an edited range back into the full clip.
  return next.map(source => {
    if (source.kind === 'video') return source;
    const old = previous.find(value => sameSource(value, source) && value.frameCount);
    return old ? withImageMetadata(source, { ...old, frames: old.frameCount! }) : source;
  });
}
export function initializeClips(clips: Segment[] | undefined, source: MediaSource): Segment[] {
  return clips?.map(clip => clip.end === 0 ? defaultSegment(source) : clip) ?? [defaultSegment(source)];
}
export function imageOrigins(sources: MediaSource[]): string[] {
  return [...new Set(sources.filter(s => s.kind !== 'video' && !s.url.startsWith('data:')).map(s => httpOrigin(s.url)))];
}
