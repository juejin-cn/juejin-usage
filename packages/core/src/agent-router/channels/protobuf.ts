import { gunzipSync } from 'node:zlib';
import { ChannelError } from './http.js';
export function varint(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) throw new ChannelError(502);
  const bytes: number[] = []; do { const low = value % 128; value = Math.floor(value / 128); bytes.push(low + (value ? 128 : 0)); } while (value); return Buffer.from(bytes);
}
export const message = (...fields: Buffer[]) => Buffer.concat(fields);
export function field(id: number, value: string | Buffer | number): Buffer {
  if (typeof value === 'number') return message(varint(id * 8), varint(value));
  const bytes = typeof value === 'string' ? Buffer.from(value) : value; return message(varint(id * 8 + 2), varint(bytes.length), bytes);
}
export function parseProto(data: Buffer): Map<number, Array<Buffer | number>> {
  const result = new Map<number, Array<Buffer | number>>(); let p = 0;
  const integer = () => { let n = 0; let mult = 1; for (let i = 0; i < 10; i++) { if (p >= data.length) throw new ChannelError(502); const b = data[p++]; n += (b & 127) * mult; if (b < 128) { if (!Number.isSafeInteger(n)) throw new ChannelError(502); return n; } mult *= 128; } throw new ChannelError(502); };
  while (p < data.length) {
    const tag = integer(); const id = Math.floor(tag / 8); let value: Buffer | number;
    if (!id) throw new ChannelError(502);
    if (tag % 8 === 0) value = integer();
    else {
      const size = tag % 8 === 2 ? integer() : tag % 8 === 1 ? 8 : tag % 8 === 5 ? 4 : -1;
      if (size < 0 || p + size > data.length) throw new ChannelError(502); value = data.subarray(p, p + size); p += size;
    }
    const values = result.get(id) || []; values.push(value); result.set(id, values);
  }
  return result;
}
export const binary = (p: ReturnType<typeof parseProto>, n: number): Buffer => { const value = p.get(n)?.[0]; return Buffer.isBuffer(value) ? value : Buffer.alloc(0); };
export const string = (p: ReturnType<typeof parseProto>, n: number) => binary(p, n).toString();
export const number = (p: ReturnType<typeof parseProto>, n: number): number => { const value = p.get(n)?.[0]; return typeof value === 'number' ? value : 0; };
export function encodeValue(value: any): Buffer {
  if (value === null || value === undefined) return field(1, 0);
  if (typeof value === 'string') return field(3, value);
  if (typeof value === 'boolean') return field(4, Number(value));
  if (typeof value === 'number') { const b = Buffer.alloc(8); b.writeDoubleLE(value); return message(varint(17), b); }
  if (Array.isArray(value)) return field(6, message(...value.map(v => field(1, encodeValue(v)))));
  return field(5, message(...Object.entries(value).map(([k, v]) => field(1, message(field(1, k), field(2, encodeValue(v)))))));
}
export function decodeValue(data: Buffer, depth = 0): any {
  if (depth > 64) throw new ChannelError(502); const p = parseProto(data);
  if (p.has(1)) return null; if (p.has(2)) return binary(p, 2).readDoubleLE(); if (p.has(3)) return string(p, 3); if (p.has(4)) return !!number(p, 4);
  if (p.has(6)) return (parseProto(binary(p, 6)).get(1) || []).map(b => decodeValue(b as Buffer, depth + 1));
  const result = Object.create(null);
  for (const b of parseProto(binary(p, 5)).get(1) || []) { const pair = parseProto(b as Buffer); result[string(pair, 1)] = decodeValue(binary(pair, 2), depth + 1); } return result;
}
export function connectFrame(data: Buffer): Buffer { const head = Buffer.alloc(5); head.writeUInt32BE(data.length, 1); return message(head, data); }
export async function* connectFrames(stream: AsyncIterable<Uint8Array>): AsyncGenerator<{ end: boolean; data: Buffer }> {
  let bytes = Buffer.alloc(0);
  for await (const part of stream) {
    bytes = Buffer.concat([bytes, part]);
    while (bytes.length >= 5) {
      const size = bytes.readUInt32BE(1); if (size > 8 * 1024 * 1024) throw new ChannelError(502);
      if (bytes.length < 5 + size) break; const flag = bytes[0]; const raw = bytes.subarray(5, 5 + size); bytes = bytes.subarray(5 + size);
      if (flag & ~3) throw new ChannelError(502);
      yield { end: !!(flag & 2), data: flag & 1 ? gunzipSync(raw, { maxOutputLength: 8 * 1024 * 1024 }) : raw };
    }
  }
  if (bytes.length) throw new ChannelError(502, 'SUBSCRIPTION_TRUNCATED_STREAM');
}
