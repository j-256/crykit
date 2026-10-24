import { BLOB_CHUNK_BYTES } from './blobs'

export const LEGACY_CAPTURE_CODEC_VERSION = 1
const TAG = Object.freeze({ undefined: 0, null: 1, false: 2, true: 3, number: 4, string: 5, reference: 6, object: 7, array: 8, buffer: 9, view: 10, date: 11, map: 12, set: 13, regexp: 14 })
const views = new Set(['DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array'])
const INITIAL_SCALAR_BLOCK_BYTES = 64
const MAX_SCALAR_BLOCK_BYTES = 4 * 1024

export function* encodeLegacyValue(value: unknown): Iterable<Uint8Array> {
  const identities = new Map<object, number>()
  // Encoded scalars may share backing storage; consumers must use each view's byte range
  let storage = new Uint8Array(INITIAL_SCALAR_BLOCK_BYTES), storageView = new DataView(storage.buffer)
  let used = 0, nextBlockBytes = INITIAL_SCALAR_BLOCK_BYTES * 2
  function reserve(length: number): number {
    if (used + length > storage.length) {
      // Yielded views may be retained across later writes or awaits, so never recycle a used block
      // Sharing disjoint ranges removes tiny allocations without changing version-one chunks or bytes
      storage = new Uint8Array(Math.max(length, nextBlockBytes)); storageView = new DataView(storage.buffer)
      nextBlockBytes = Math.min(nextBlockBytes * 2, MAX_SCALAR_BLOCK_BYTES); used = 0
    }
    const offset = used; used += length; return offset
  }
  function byte(value: number): Uint8Array { const offset = reserve(1); storage[offset] = value; return storage.subarray(offset, offset + 1) }
  function integer(value: number): Uint8Array {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new Error('Unsupported legacy length')
    const offset = reserve(4); storageView.setUint32(offset, value, true); return storage.subarray(offset, offset + 4)
  }
  function number(value: number): Uint8Array { const offset = reserve(8); storageView.setFloat64(offset, value, true); return storage.subarray(offset, offset + 8) }
  function* text(value: string): Iterable<Uint8Array> {
    yield integer(value.length)
    for (let at = 0; at < value.length; at += BLOB_CHUNK_BYTES / 2) {
      const end = Math.min(at + BLOB_CHUNK_BYTES / 2, value.length), length = (end - at) * 2, offset = reserve(length)
      for (let index = at; index < end; index++) storageView.setUint16(offset + (index - at) * 2, value.charCodeAt(index), true)
      yield storage.subarray(offset, offset + length)
    }
  }
  function* visit(value: unknown): Iterable<Uint8Array> {
    if (value === undefined) { yield byte(TAG.undefined); return }
    if (value === null) { yield byte(TAG.null); return }
    if (typeof value === 'boolean') { yield byte(value ? TAG.true : TAG.false); return }
    if (typeof value === 'number') { yield byte(TAG.number); yield number(value); return }
    if (typeof value === 'string') { yield byte(TAG.string); yield* text(value); return }
    if (typeof value !== 'object') throw new Error('Unsupported legacy value; original data remains recoverable')
    const prior = identities.get(value)
    if (prior !== undefined) { yield byte(TAG.reference); yield integer(prior); return }
    const id = identities.size; identities.set(value, id)
    let tag: number
    if (Array.isArray(value)) tag = TAG.array
    else if (value instanceof ArrayBuffer) tag = TAG.buffer
    else if (ArrayBuffer.isView(value) && views.has(value.constructor.name)) tag = TAG.view
    else if (value instanceof Date) tag = TAG.date
    else if (value instanceof Map) tag = TAG.map
    else if (value instanceof Set) tag = TAG.set
    else if (value instanceof RegExp) tag = TAG.regexp
    else if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) tag = TAG.object
    else throw new Error('Unsupported legacy object; original data remains recoverable')
    yield byte(tag); yield integer(id)
    if (Array.isArray(value)) {
      yield integer(value.length)
      // Own keys distinguish holes from undefined and retain enumerable custom array properties
      const keys = Object.keys(value)
      yield integer(keys.length)
      for (const key of keys) { yield* text(key); yield* visit((value as unknown as Record<string, unknown>)[key]) }
    } else if (value instanceof ArrayBuffer) {
      yield integer(value.byteLength)
      for (let offset = 0; offset < value.byteLength; offset += BLOB_CHUNK_BYTES) yield new Uint8Array(value, offset, Math.min(BLOB_CHUNK_BYTES, value.byteLength - offset))
    } else if (ArrayBuffer.isView(value)) {
      yield* text(value.constructor.name); yield integer(value.byteOffset); yield integer(value.byteLength); yield* visit(value.buffer)
    } else if (value instanceof Date) yield number(value.getTime())
    else if (value instanceof Map) { yield integer(value.size); for (const [key, entry] of value) { yield* visit(key); yield* visit(entry) } }
    else if (value instanceof Set) { yield integer(value.size); for (const entry of value) yield* visit(entry) }
    else if (value instanceof RegExp) { yield* text(value.source); yield* text(value.flags); yield number(value.lastIndex) }
    else {
      const keys = Object.keys(value)
      yield byte(Object.getPrototypeOf(value) === null ? 0 : 1); yield integer(keys.length)
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!
        if (!('value' in descriptor)) throw new Error('Unsupported legacy accessor')
        yield* text(key); yield* visit(descriptor.value)
      }
    }
  }
  yield byte(LEGACY_CAPTURE_CODEC_VERSION)
  yield* visit(value)
}

export function equalLegacyValue(left: unknown, right: unknown): boolean {
  const a = encodeLegacyValue(left)[Symbol.iterator](), b = encodeLegacyValue(right)[Symbol.iterator]()
  try {
    while (true) {
      const x = a.next(), y = b.next()
      if (x.done || y.done) return Boolean(x.done && y.done)
      if (x.value.length !== y.value.length || x.value.some((byte, index) => byte !== y.value[index])) return false
    }
  } finally { a.return?.(); b.return?.() }
}
