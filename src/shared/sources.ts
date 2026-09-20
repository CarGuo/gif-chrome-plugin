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
    if (source.kind === 'video') {
      const old = previous.find(value => sameSource(value, source));
      return old?.resource && source.resources?.some(item => item.url === old.resource!.url && item.kind === old.resource!.kind) ? { ...source, resource: old.resource } : source;
    }
    const old = previous.find(value => sameSource(value, source) && value.frameCount);
    return old ? withImageMetadata(source, { ...old, frames: old.frameCount! }) : source;
  });
}
export function initializeClips(clips: Segment[] | undefined, source: MediaSource): Segment[] {
  return clips?.map(clip => clip.end === 0 ? defaultSegment(source)
    : clip.endMode === 'source' && source.duration !== null ? { ...clip, end: source.duration } : clip) ?? [defaultSegment(source)];
}
export function imageOrigins(sources: MediaSource[]): string[] {
  return [...new Set(sources.filter(s => s.kind !== 'video' && !s.url.startsWith('data:')).map(s => httpOrigin(s.url)))];
}

// v0.1.10: several players can inherit the same page title. Disambiguate at the
// complete scan boundary (including frames), before names reach selection/jobs/files.
export function distinctSourceTitles(sources: MediaSource[], numbered: (title: string, index: number) => string): MediaSource[] {
  const key = (title: string) => title.normalize('NFC').trim();
  const counts = new Map<string, number>();
  for (const source of sources) counts.set(key(source.title), (counts.get(key(source.title)) ?? 0) + 1);
  const used = new Set(sources.map(source => key(source.title)));
  const indices = new Map<string, number>();
  return sources.map(source => {
    const titleKey = key(source.title);
    if (counts.get(titleKey) === 1) return source;
    let index = indices.get(titleKey) ?? 0, title: string;
    do { title = numbered(source.title, ++index).slice(0, 200); } while (used.has(key(title)));
    indices.set(titleKey, index); used.add(key(title));
    return { ...source, title };
  });
}
