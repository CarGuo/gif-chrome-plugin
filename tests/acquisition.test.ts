import { describe, expect, it } from 'vitest';
import { acquisition, mediaOrigins, xMetadataUrl, xPostId, xVideoUrl } from '../src/shared/acquisition';
import type { MediaSource } from '../src/shared/model';

const source = { kind: 'video', url: 'blob:https://x.com/player', pageUrl: 'https://x.com/user/status/123', poster: 'https://pbs.twimg.com/ext_tw_video_thumb/456/pu/img/a.jpg?name=small', duration: 12 } as MediaSource;
const media = (id = '456') => ({ media_url_https: `https://pbs.twimg.com/ext_tw_video_thumb/${id}/pu/img/a.jpg`, video_info: { duration_millis: 12000, variants: [
  { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/playlist.m3u8' },
  { content_type: 'video/mp4', url: 'https://video.twimg.com/vid/432x270/small.mp4', bitrate: 256000 },
  { content_type: 'video/mp4', url: 'https://video.twimg.com/vid/576x360/medium.mp4', bitrate: 832000 },
  { content_type: 'video/mp4', url: 'https://video.twimg.com/vid/1152x720/large.mp4', bitrate: 2176000 },
] } });
describe('download acquisition and X source identity', () => {
  it('chooses a supported download path before processing, with no retry into page capture', () => {
    expect(acquisition(source)).toBe('x');
    expect(acquisition({ ...source, resources: [{kind:'hls',url:'https://cdn.test/ad.m3u8'}] })).toBe('x');
    expect(acquisition({ ...source, url: 'https://cdn.test/video.mp4' })).toBe('download');
    expect(acquisition({ ...source, pageUrl: 'https://player.test/', blobKind: 'mse' })).toBe('unresolved');
    expect(acquisition({ ...source, url: 'https://cdn.test/playlist.m3u8' })).toBe('hls');
  });
  it('requests only the selected source and resolver origins, including video hosts', () => {
    expect(mediaOrigins([source, source, { ...source, url: 'https://cdn.test/a.mp4' }, { ...source, kind: 'gif', url: 'data:image/gif;base64,R0lG' }]))
      .toEqual(['https://cdn.syndication.twimg.com/*', 'https://video.twimg.com/*', 'https://cdn.test/*']);
    expect(xMetadataUrl(source)).toContain('tweet-result?id=123&token=');
  });
  it('binds a feed player to its containing post and rejects unrelated domains', () => {
    expect(xPostId('https://x.com/i/web/status/123/video/1')).toBe('123');
    expect(xPostId('https://x.com.evil.test/user/status/123')).toBeUndefined();
    expect(xMetadataUrl({ ...source, pageUrl: 'https://x.com/home', mediaPageUrl: source.pageUrl })).toContain('id=123');
  });
  it('matches poster identity among multiple or quoted videos before selecting a size-capped MP4', () => {
    expect(xVideoUrl(source, { id_str: '123', mediaDetails: [media('other'), media()] })).toBe('https://video.twimg.com/vid/576x360/medium.mp4');
    expect(xVideoUrl({ ...source, poster: source.poster!.replace('.jpg?name=small', '?format=jpg&name=small') }, { id_str: '123', mediaDetails: [media()] })).toBe('https://video.twimg.com/vid/576x360/medium.mp4');
    expect(xVideoUrl(source, { id_str: '123', mediaDetails: [media('other')], quoted_tweet: { mediaDetails: [media()] } })).toBe('https://video.twimg.com/vid/576x360/medium.mp4');
    expect(() => xVideoUrl(source, { id_str: '124', mediaDetails: [media()] })).toThrow('sourceChanged');
    expect(() => xVideoUrl(source, { id_str: '123', mediaDetails: [media('other')] })).toThrow('sourceChanged');
    expect(() => xVideoUrl(source, { id_str: '123', mediaDetails: [media(), media()] })).toThrow('sourceChanged');
    expect(xVideoUrl({ ...source, duration: 12.8 }, { id_str: '123', mediaDetails: [media()] })).toBe('https://video.twimg.com/vid/576x360/medium.mp4');
  });
  it('uses the requested ceiling instead of bitrate or webpage dimensions', () => {
    const data = { id_str: '123', mediaDetails: [media()] };
    expect(xVideoUrl({ ...source, width: 1920, height: 1080 }, data, 800)).toContain('/576x360/');
    expect(xVideoUrl(source, data, 480)).toContain('/432x270/');
    expect(xVideoUrl(source, data, 576)).toContain('/576x360/');
    const unknown = media(); unknown.video_info.variants = [{ content_type: 'video/mp4', url: 'https://video.twimg.com/unknown.mp4', bitrate: 999999 }];
    expect(() => xVideoUrl(source, { id_str: '123', mediaDetails: [unknown] })).toThrow('unsupportedVideo');
  });
  it('rejects media variants outside the granted host instead of following arbitrary API data', () => {
    const item = media();
    item.video_info.variants = [{ content_type: 'video/mp4', url: 'https://evil.test/video.mp4', bitrate: 999999 }];
    expect(() => xVideoUrl(source, { id_str: '123', mediaDetails: [item] })).toThrow('downloadFailed');
  });
});
