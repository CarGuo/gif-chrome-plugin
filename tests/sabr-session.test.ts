import { describe, expect, it } from 'vitest';
import { BinaryReader, BinaryWriter, WireType } from '@bufbuild/protobuf/wire';
import { VideoPlaybackAbrRequest } from 'googlevideo/protos';
import { bindSabrSession } from '../src/shared/sabr-session';
const block = (id: number, bytes: Uint8Array) => new BinaryWriter().tag(id, WireType.LengthDelimited).bytes(bytes).finish();
const join = (...values: Uint8Array[]) => { const writer = new BinaryWriter(); values.forEach(value => writer.raw(value)); return writer.finish(); };
function part(bytes: Uint8Array, key: number) {
 const reader = new BinaryReader(bytes);
 while (reader.pos < reader.len) { const [id, type] = reader.tag(); if (type === WireType.LengthDelimited) { const data = reader.bytes(); if (id === key) return data; } else reader.skip(type, id); }
 throw Error('Missing field');
}
describe('SABR playback-session identity', () => {
 it('preserves browser identity fields that the upstream generated decoder does not know', () => {
  const client = new BinaryWriter().tag(16, WireType.Varint).uint32(1).tag(2047, WireType.LengthDelimited).string('future-client-field').finish();
  const observed = block(19, join(block(1, client), block(2, new Uint8Array([7,8])), block(3, new Uint8Array([99]))));
  const roundTrip = VideoPlaybackAbrRequest.encode(VideoPlaybackAbrRequest.decode(observed)).finish();
  expect(part(part(roundTrip,19),1)).not.toEqual(client); // Reproduces the schema loss.
  const outgoing = join(block(17, new Uint8Array([8,134,1])), block(19, join(block(1,new Uint8Array([128,1,1])),block(2,new Uint8Array([1])),block(3,new Uint8Array([42])))));
  const result = bindSabrSession(outgoing, observed), context = part(result,19);
  expect(part(context,1)).toEqual(client);
  expect(part(context,2)).toEqual(new Uint8Array([7,8]));
  expect(part(context,3)).toEqual(new Uint8Array([42])); // Download's own cookie, never the player's.
  expect(part(result,17)).toEqual(part(outgoing,17)); // Selected download format is unchanged.
 });
 it('requires an observed player identity, and retains newly refreshed token bytes', () => {
  const request = block(19,block(1,new Uint8Array([128,1,1])));
  expect(()=>bindSabrSession(request,new Uint8Array())).toThrow('mediaDiscoveryRequired');
  for(const token of [new Uint8Array([1]),new Uint8Array([2,3,4])]) {
   const observed=block(19,join(block(1,new Uint8Array([128,1,1])),block(2,token)));
   expect(part(part(bindSabrSession(request,observed),19),2)).toEqual(token);
  }
 });
});
