import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { attachResources, chosenResource, youtubeId, chooseVideoSize } from '../src/shared/media-resource';
import { dashDownloadPlan } from '../src/shared/manifest';
import { acquisition } from '../src/shared/acquisition';
import type { MediaSource } from '../src/shared/model';
const source = { id:'v1', url:'blob:https://page.test/one', pageUrl:'https://page.test/', kind:'video', blobKind:'mse' } as MediaSource;
describe('v0.1.7 page media identity and transports', () => {
 it('binds declared sources to the selected DOM video and requires a choice for unrelated candidates', () => {
  const page = { resources:['https://cdn.test/ad.m3u8','https://cdn.test/main.mpd'], videos:[{id:'v1',url:source.url,poster:'',declared:[]}] };
  const found = attachResources(source, page);
  expect(chosenResource(found)).toBeUndefined(); expect(acquisition(found)).toBe('unresolved');
  expect(chosenResource({...found,resource:found.resources![1]})).toEqual({kind:'dash',url:page.resources[1]});
  expect(() => chosenResource({...found,resource:{kind:'hls',url:'https://other.test/a.m3u8'}})).toThrow('sourceChanged');
  expect(attachResources(source,{...page,videos:[{...page.videos[0],id:'another'}]})).toEqual(source);
  expect(chosenResource(attachResources(source,{...page,videos:[{...page.videos[0],declared:['https://selected.test/main.m3u8']}]}))?.url).toBe('https://selected.test/main.m3u8');
 });
 it('distinguishes file blobs, MSE, HLS, DASH and YouTube without a page capture fallback', () => {
  expect(acquisition({...source,blobKind:'file'})).toBe('blob');
  expect(acquisition(source)).toBe('unresolved');
  expect(acquisition({...source,url:'https://cdn.test/a.m3u8?token=x'})).toBe('hls');
  expect(acquisition({...source,url:'https://cdn.test/a.mpd'})).toBe('dash');
  expect(acquisition({...source,pageUrl:'https://www.youtube.com/watch?v=abc'})).toBe('youtube');
  expect(youtubeId('https://youtube.com.evil.test/watch?v=abc')).toBeUndefined();
  expect(youtubeId('https://www.youtube-nocookie.com/embed/abc')).toBe('abc');
 });
 it('does not attach the only observed manifest to every player in a multi-video frame', () => {
  const selected = { id:'v1', url:source.url, poster:'', declared:[] };
  const snapshot = { resources:['https://cdn.test/ad.m3u8'], videos:[selected,{...selected,id:'v2',url:'blob:https://page.test/two'}] };
  const found = attachResources(source,snapshot);
  expect(found.resourceSelectionRequired).toBe(true);
  expect(chosenResource(found)).toBeUndefined();
  expect(acquisition(found)).toBe('unresolved');
  expect(chosenResource({...found,resource:found.resources![0]})?.url).toBe(snapshot.resources[0]);
  expect(chosenResource(attachResources(source,{...snapshot,videos:[selected]}))?.url).toBe(snapshot.resources[0]);
 });
 it('chooses the largest representation within the size ceiling, including portrait video', () => {
  const items=[{width:1920,height:1080},{width:640,height:360},{width:854,height:480}];
  expect(chooseVideoSize(items,x=>x,800)).toEqual(items[1]);
  expect(chooseVideoSize(items,x=>x,4000)).toEqual(items[0]);
  expect(chooseVideoSize(items,x=>x,854)).toEqual(items[2]);
  expect(chooseVideoSize(items,x=>x,320)).toEqual(items[1]);
  expect(chooseVideoSize([{width:180,height:320},{width:360,height:640}],x=>x,600)).toEqual({width:180,height:320});
  expect(chooseVideoSize([{width:0,height:0},{width:NaN,height:320}],x=>x,800)).toBeUndefined();
 });
 it('uses the MPD parser to resolve initialization, SegmentTimeline and relative media URLs', () => {
  const xml=readFileSync('tests/fixtures/dash/index.mpd','utf8');
  const plan=dashDownloadPlan(xml,'https://cdn.test/path/index.mpd',800);
  expect(plan.kind).toBe('hls'); expect(plan.playlist).toContain('#EXT-X-ENDLIST');
  expect(plan.playlist).toContain('https://cdn.test/path/init-stream0.m4s');
  expect(plan.playlist).toContain('https://cdn.test/path/chunk-stream0-00003.m4s');
  expect(plan.playlist?.match(/#EXTINF:/g)).toHaveLength(3);
 });
 it('does not turn a live MPD into a falsely complete download', () => {
  const xml=readFileSync('tests/fixtures/dash/index.mpd','utf8').replace('type="static"','type="dynamic"');
  expect(()=>dashDownloadPlan(xml,'https://cdn.test/index.mpd',800)).toThrow();
 });
});
