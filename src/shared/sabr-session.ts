import { BinaryReader, BinaryWriter, WireType } from '@bufbuild/protobuf/wire';
import { TaskError } from './model';

interface Field { id: number; bytes: Uint8Array; value?: Uint8Array }
function fields(bytes: Uint8Array): Field[] {
  const reader = new BinaryReader(bytes), result: Field[] = [];
  while (reader.pos < reader.len) {
    const start = reader.pos, [id, type] = reader.tag();
    const value = type === WireType.LengthDelimited ? reader.bytes() : undefined;
    if (value === undefined) reader.skip(type, id);
    result.push({ id, bytes: bytes.subarray(start, reader.pos), value });
  }
  return result;
}
const join = (values: Field[]) => { const writer = new BinaryWriter(); for (const field of values) writer.raw(field.bytes); return writer.finish(); };
function message(id: number, bytes: Uint8Array): Field { return { id, value: bytes, bytes: new BinaryWriter().tag(id, WireType.LengthDelimited).bytes(bytes).finish() }; }

// v0.1.7: generated SABR decoders discard unknown protobuf fields. Current browser
// ClientInfo contains fields absent from googlevideo's schema; decoding/re-encoding
// the session identity changes the request. Preserve its wire bytes, including additions.
// Field numbers come from VideoPlaybackAbrRequest/StreamerContext in googlevideo's schema.
export function bindSabrSession(request: Uint8Array, observed: Uint8Array): Uint8Array {
  const outgoing = fields(request), current = fields(observed);
  const context = outgoing.find(field => field.id === 19)?.value;
  const identity = current.find(field => field.id === 19)?.value;
  if (!context || !identity) throw new TaskError('mediaDiscoveryRequired');
  // ClientInfo and PoToken belong to the active player. Cookie and segment/context state
  // belong to this separate download and remain owned by the SABR state machine.
  const identityFields = fields(identity).filter(field => field.id === 1 || field.id === 2);
  if (!identityFields.some(field => field.id === 1)) throw new TaskError('mediaDiscoveryRequired');
  const merged = join([...fields(context).filter(field => field.id !== 1 && field.id !== 2), ...identityFields]);
  return join([...outgoing.filter(field => field.id !== 19), message(19, merged)]);
}
