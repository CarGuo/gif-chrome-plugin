import { POLICY, TaskError, type MediaSource } from './model';

// v0.1.12: a picked file is a source in its own right. It has no tab, frame, origin
// or page URL, so those fields are filled with neutral extension-owned values rather
// than fake web addresses. This is the single constructor for every local source.
export const LOCAL_PAGE_URL = 'https://localhost/';

export function isLocalSource(source: MediaSource): boolean {
  return source.local === true;
}

export function createLocalSource(file: File, metadata: { width: number; height: number; duration: number }): MediaSource {
  if (!file.size || file.size > POLICY.inputBytes) throw new TaskError('inputTooLarge');
  if (![metadata.width, metadata.height, metadata.duration].every(v => Number.isFinite(v) && v > 0)) throw new TaskError('unsupportedVideo');
  const id = crypto.randomUUID();
  return {
    id,
    documentKey: `local:${id}`,
    tabId: -1,
    frameId: 0,
    kind: 'video',
    url: `local-file:${id}`,
    pageUrl: LOCAL_PAGE_URL,
    title: file.name.replace(/\.[^.]+$/, '') || file.name,
    width: metadata.width,
    height: metadata.height,
    duration: metadata.duration,
    currentTime: 0,
    local: true,
  };
}
