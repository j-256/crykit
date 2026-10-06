import { MAX_INT32, CRYSTAL_SAVE_LIMITS } from './format.ts'
import { CrystalSaveError } from './error.ts'
import { type BsonDocument, type BsonValue } from './types.ts'

const MIN_DOCUMENT_BYTES = 5

const MIN_INT32 = -0x80000000

const MAX_INT64 = (1n << 63n) - 1n

const MIN_INT64 = -(1n << 63n)

const MAX_UINT64 = (1n << 64n) - 1n

const utf8 = new TextEncoder()

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function assertInteger(value: number, min = MIN_INT32, max = MAX_INT32): void {
  if (!Number.isInteger(value) || value < min || value > max) throw new CrystalSaveError('Save contains an out-of-range integer')
}

export class Reader {
  readonly bytes: Uint8Array
  readonly view: DataView
  position = 0
  // One reader shares the complexity budget across party and member documents
  nodes = 0

  constructor(bytes: Uint8Array) {
    this.bytes = bytes
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  fail(message: string): never { throw new CrystalSaveError(message, this.position) }

  require(length: number, end = this.bytes.length): void {
    if (!Number.isSafeInteger(length) || length < 0 || this.position + length > end || end > this.bytes.length) this.fail('Truncated or invalid save section')
  }

  take(length: number, end = this.bytes.length): Uint8Array {
    this.require(length, end)
    const value = this.bytes.slice(this.position, this.position + length)
    this.position += length
    return value
  }

  byte(end = this.bytes.length): number { this.require(1, end); return this.bytes[this.position++] }

  int32(end = this.bytes.length): number {
    this.require(4, end)
    const value = this.view.getInt32(this.position, true)
    this.position += 4
    return value
  }

  int64(unsigned = false, end = this.bytes.length): bigint {
    this.require(8, end)
    const value = unsigned ? this.view.getBigUint64(this.position, true) : this.view.getBigInt64(this.position, true)
    this.position += 8
    return value
  }

  boolean(end = this.bytes.length): boolean {
    const value = this.byte(end)
    if (value !== 0 && value !== 1) this.fail('Invalid boolean encoding')
    return value === 1
  }

  count(limit: number, label: string, minimumBytes = 0): number {
    const value = this.int32()
    if (value < 0 || value > limit || value * minimumBytes > this.bytes.length - this.position) this.fail(`Invalid ${label} count`)
    return value
  }

  text(length: number, end = this.bytes.length): string {
    if (length > CRYSTAL_SAVE_LIMITS.maxStringBytes) this.fail('Save string exceeds the size limit')
    const bytes = this.take(length, end)
    try { return strictUtf8.decode(bytes) } catch { return this.fail('Invalid UTF-8 in save string') }
  }

  string(): string {
    let length = 0
    for (let index = 0; index < 5; index++) {
      const next = this.byte()
      if (index === 4 && next > 7) this.fail('Invalid string length prefix')
      length += (next & 0x7f) * 2 ** (index * 7)
      if ((next & 0x80) === 0) {
        if (index > 0 && next === 0) this.fail('Noncanonical string length prefix')
        return this.text(length)
      }
    }
    return this.fail('Invalid string length prefix')
  }

  cstring(end: number): string {
    const start = this.position
    while (this.position < end && this.bytes[this.position] !== 0) {
      if (this.position - start >= CRYSTAL_SAVE_LIMITS.maxStringBytes) this.fail('Save string exceeds the size limit')
      this.position++
    }
    if (this.position === end) this.fail('Unterminated BSON key')
    const length = this.position - start
    this.position = start
    const value = this.text(length, end)
    this.byte(end)
    return value
  }

  bsonString(end: number): string {
    const length = this.int32(end)
    if (length < 1) this.fail('Invalid BSON string length')
    const value = this.text(length - 1, end)
    if (this.byte(end) !== 0) this.fail('Unterminated BSON string')
    return value
  }

  document(depth = 0, outerEnd = this.bytes.length, array = false): BsonDocument | Extract<BsonValue, { type: 'array' }> {
    if (depth > CRYSTAL_SAVE_LIMITS.maxDepth || ++this.nodes > CRYSTAL_SAVE_LIMITS.maxNodes) this.fail('Save BSON exceeds the complexity limit')
    const start = this.position
    const length = this.int32(outerEnd)
    if (length < MIN_DOCUMENT_BYTES || length > CRYSTAL_SAVE_LIMITS.maxDocumentBytes || start + length > outerEnd) this.fail('Invalid BSON document length')
    const end = start + length
    // Keep prototype-shaped keys inert and retain source order separately from JS key ordering
    const value: Record<string, BsonValue> = Object.create(null)
    const keys: string[] = []
    const values: BsonValue[] = []
    while (this.position < end - 1) {
      const type = this.byte(end - 1)
      if (type === 0) this.fail('Unexpected BSON document terminator')
      const key = this.cstring(end - 1)
      if (Object.hasOwn(value, key)) this.fail('Duplicate BSON document key')
      if (array && key !== String(values.length)) this.fail('Invalid BSON array index')
      const child = this.value(type, depth + 1, end - 1)
      value[key] = child
      keys.push(key)
      if (array) values.push(child)
    }
    if (this.position !== end - 1 || this.byte(end) !== 0) this.fail('Invalid BSON document terminator')
    return array ? { type: 'array', value: values } : { type: 'document', value, keys }
  }

  value(type: number, depth: number, end: number): BsonValue {
    if (++this.nodes > CRYSTAL_SAVE_LIMITS.maxNodes || depth > CRYSTAL_SAVE_LIMITS.maxDepth) this.fail('Save BSON exceeds the complexity limit')
    const start = this.position
    switch (type) {
      case 1: {
        const raw = this.take(8, end)
        return { type: 'double', value: new DataView(raw.buffer).getFloat64(0, true), raw }
      }
      case 2: return { type: 'string', value: this.bsonString(end) }
      case 3: return this.document(depth, end)
      case 4: return this.document(depth, end, true)
      case 8: return { type: 'boolean', value: this.boolean(end) }
      case 9: return { type: 'datetime', value: this.int64(false, end) }
      case 10: return { type: 'null' }
      case 16: return { type: 'int32', value: this.int32(end) }
      case 18: return { type: 'int64', value: this.int64(false, end) }
      case 5: {
        const length = this.int32(end)
        const subtype = this.byte(end)
        this.require(length, end)
        if (subtype === 2) {
          if (length < 4 || this.int32(end) !== length - 4) this.fail('Invalid BSON binary length')
          this.take(length - 4, end)
        } else this.take(length, end)
        break
      }
      case 6: case 127: case 255: break
      case 7: this.take(12, end); break
      case 11: this.cstring(end); this.cstring(end); break
      case 12: this.bsonString(end); this.take(12, end); break
      case 13: case 14: this.bsonString(end); break
      case 15: {
        const length = this.int32(end)
        if (length < 14 || start + length > end) this.fail('Invalid BSON code scope length')
        this.bsonString(start + length)
        this.document(depth, start + length)
        if (this.position !== start + length) this.fail('Invalid BSON code scope boundary')
        break
      }
      case 17: this.take(8, end); break
      case 19: this.take(16, end); break
      default: return this.fail(`Unsupported BSON type ${type}`)
    }
    // Framing is checked above, but unsupported payloads, including BSON code, stay inert bytes
    return { type: 'opaque', bsonType: type, value: this.bytes.slice(start, this.position) }
  }
}

export class Writer {
  private bytes = new Uint8Array(1024)
  position = 0
  nodes = 0

  private ensure(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || this.position + length > CRYSTAL_SAVE_LIMITS.maxFileBytes) throw new CrystalSaveError('Save exceeds the file size limit')
    if (this.position + length <= this.bytes.length) return
    const next = new Uint8Array(Math.min(CRYSTAL_SAVE_LIMITS.maxFileBytes, Math.max(this.bytes.length * 2, this.position + length)))
    next.set(this.bytes)
    this.bytes = next
  }

  byte(value: number): void { assertInteger(value, 0, 255); this.ensure(1); this.bytes[this.position++] = value }
  boolean(value: boolean): void {
    if (typeof value !== 'boolean') throw new CrystalSaveError('Save contains an invalid boolean')
    this.byte(value ? 1 : 0)
  }
  append(value: Uint8Array): void { this.ensure(value.length); this.bytes.set(value, this.position); this.position += value.length }
  int32(value: number): void { assertInteger(value); this.ensure(4); new DataView(this.bytes.buffer).setInt32(this.position, value, true); this.position += 4 }
  int64(value: bigint, unsigned = false): void {
    if (typeof value !== 'bigint' || value < (unsigned ? 0n : MIN_INT64) || value > (unsigned ? MAX_UINT64 : MAX_INT64)) throw new CrystalSaveError('Save contains an out-of-range 64-bit integer')
    this.ensure(8)
    const view = new DataView(this.bytes.buffer)
    if (unsigned) view.setBigUint64(this.position, value, true)
    else view.setBigInt64(this.position, value, true)
    this.position += 8
  }

  private text(value: string): Uint8Array {
    if (typeof value !== 'string' || value.length > CRYSTAL_SAVE_LIMITS.maxStringBytes) throw new CrystalSaveError('Save string exceeds the size limit')
    const bytes = utf8.encode(value)
    if (bytes.length > CRYSTAL_SAVE_LIMITS.maxStringBytes) throw new CrystalSaveError('Save string exceeds the size limit')
    if (strictUtf8.decode(bytes) !== value) throw new CrystalSaveError('Save string contains invalid Unicode')
    return bytes
  }

  string(value: string): void {
    const bytes = this.text(value)
    let length = bytes.length
    while (length >= 128) { this.byte((length % 128) | 128); length = Math.floor(length / 128) }
    this.byte(length)
    this.append(bytes)
  }

  private cstring(value: string): void {
    if (value.includes('\0')) throw new CrystalSaveError('BSON key contains a null character')
    this.append(this.text(value))
    this.byte(0)
  }

  document(document: BsonDocument | Extract<BsonValue, { type: 'array' }>, depth = 0): void {
    if (depth > CRYSTAL_SAVE_LIMITS.maxDepth || ++this.nodes > CRYSTAL_SAVE_LIMITS.maxNodes) throw new CrystalSaveError('Save BSON exceeds the complexity limit')
    const start = this.position
    this.int32(0)
    // Preserve surviving source keys in order, then append new keys without duplicating them
    const keys = document.type === 'array' ? document.value.map((_, index) => String(index)) : [...new Set([...(document.keys ?? []).filter(key => Object.hasOwn(document.value, key)), ...Object.keys(document.value)])]
    for (const key of keys) {
      const value = document.type === 'array' ? document.value[Number(key)] : document.value[key]
      if (!value || ++this.nodes > CRYSTAL_SAVE_LIMITS.maxNodes) throw new CrystalSaveError('Save BSON exceeds the complexity limit')
      const type = value.type === 'opaque' ? value.bsonType : { double: 1, string: 2, document: 3, array: 4, boolean: 8, datetime: 9, null: 10, int32: 16, int64: 18 }[value.type]
      this.byte(type)
      this.cstring(key)
      this.value(value, depth + 1)
    }
    this.byte(0)
    if (this.position - start > CRYSTAL_SAVE_LIMITS.maxDocumentBytes) throw new CrystalSaveError('BSON document exceeds the size limit')
    new DataView(this.bytes.buffer).setInt32(start, this.position - start, true)
  }

  private value(value: BsonValue, depth: number): void {
    if (depth > CRYSTAL_SAVE_LIMITS.maxDepth) throw new CrystalSaveError('Save BSON exceeds the complexity limit')
    switch (value.type) {
      case 'document': case 'array': this.document(value, depth); break
      case 'int32': this.int32(value.value); break
      case 'int64': case 'datetime': this.int64(value.value); break
      case 'boolean': this.boolean(value.value); break
      case 'string': {
        const bytes = this.text(value.value)
        this.int32(bytes.length + 1)
        this.append(bytes)
        this.byte(0)
        break
      }
      case 'double': {
        if (typeof value.value !== 'number') throw new CrystalSaveError('Save contains an invalid floating-point value')
        // Object.is retains signed zero and NaN payload bytes unless the numeric value changed
        if (value.raw?.length === 8 && Object.is(new DataView(value.raw.buffer, value.raw.byteOffset, 8).getFloat64(0, true), value.value)) this.append(value.raw)
        else {
          this.ensure(8)
          new DataView(this.bytes.buffer).setFloat64(this.position, value.value, true)
          this.position += 8
        }
        break
      }
      case 'opaque': this.append(value.value); break
      case 'null': break
    }
  }

  finish(): Uint8Array { return this.bytes.slice(0, this.position) }
}
