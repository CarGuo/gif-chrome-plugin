import { parse } from 'mpd-parser';
import { chooseVideoSize } from './media-resource';
import { TaskError } from './model';

interface ByteRange { offset: number; length: number }
interface DashSegment { resolvedUri: string; duration: number; byterange?: ByteRange; map?: { resolvedUri: string; byterange?: ByteRange }; discontinuity?: boolean }
interface DashPlaylist { attributes: { RESOLUTION: { width: number; height: number }; CODECS?: string }; endList: boolean; contentProtection?: unknown;
  segments: DashSegment[]; sidx?: { resolvedUri: string }; resolvedUri: string }
export interface DashManifest { playlists: DashPlaylist[] }

export function dashDownloadPlan(text: string, url: string, maxSide: number): { kind: 'file' | 'hls'; url: string; playlist?: string } {
  const manifest = parse(text, { manifestUri: url });
  const selected = chooseVideoSize(manifest.playlists, item => item.attributes.RESOLUTION, maxSide);
  if (!selected) throw new TaskError('unsupportedVideo');
  if (selected.contentProtection) throw new TaskError('protectedMedia');
  if (!selected.endList) throw new TaskError('invalidSegment');
  // SegmentBase describes byte ranges of one complete ISO-BMFF file; download that file.
  if (selected.sidx && !selected.segments.length) return { kind: 'file', url: selected.sidx.resolvedUri };
  if (!selected.segments.length || selected.segments.length > 10000) throw new TaskError('downloadFailed');
  const absolute = (value: string) => {
    const target = new URL(value, url);
    if (!['http:', 'https:'].includes(target.protocol)) throw new TaskError('downloadFailed');
    return target.href;
  };
  // v0.1.7: video.js handles MPD inheritance, templates, timelines and periods. Feed its
  // resolved segment plan to the same HLS demux/remux path instead of writing another demuxer.
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...selected.segments.map(segment => segment.duration)))}`];
  let previousMap = '';
  for (const segment of selected.segments) {
    if (!(segment.duration > 0) || !Number.isFinite(segment.duration)) throw new TaskError('downloadFailed');
    if (segment.discontinuity) lines.push('#EXT-X-DISCONTINUITY');
    if (segment.map) {
      const { byterange } = segment.map;
      const map = `#EXT-X-MAP:URI="${absolute(segment.map.resolvedUri)}"${byterange ? `,BYTERANGE="${byterange.length}@${byterange.offset}"` : ''}`;
      if (map !== previousMap) lines.push(map);
      previousMap = map;
    }
    lines.push(`#EXTINF:${segment.duration},`);
    if (segment.byterange) lines.push(`#EXT-X-BYTERANGE:${segment.byterange.length}@${segment.byterange.offset}`);
    lines.push(absolute(segment.resolvedUri));
  }
  lines.push('#EXT-X-ENDLIST');
  return { kind: 'hls', url, playlist: lines.join('\n') };
}
