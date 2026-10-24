import { WORKSPACE_BACKUP_LIMITS } from './workspace-backup-schema'
import type { JsonValue } from '../domain/types'

const TEXT_SLICE = 8192
// V1 exports retain their original packing so accepted archives round-trip byte for byte
const LEGACY_PAGE_BYTES = 64 * 1024
const forbidden = new Set(['__proto__', 'constructor', 'prototype'])
type Token = readonly ['object' | 'array' | 'end' | 'string' | 'string-end'] | readonly ['key' | 'text' | 'text-value', string] | readonly ['value', null | boolean | number]

function utf8Length(text: string): number {
  let bytes = 0
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code < 0x80) bytes++
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index++ }
    else bytes += 3
  }
  return bytes
}

// Token pages bound codec scratch space even when a saved string or catalog exceeds one frame
// Strings split by UTF-16 code units and JSON escaping preserves lone surrogates exactly
export function* encodeBackupJson(value: unknown, pageBytes = LEGACY_PAGE_BYTES, options?: { readonly packByBytes: boolean }): Generator<Uint8Array> {
  if (!Number.isSafeInteger(pageBytes) || pageBytes <= 0 || pageBytes > WORKSPACE_BACKUP_LIMITS.payload) throw new Error('Invalid backup metadata page target')
  // Legacy exports retain their conservative code-unit packing and historical identities
  // New captures can fill the same bounded format by measuring UTF-8 without allocating each token twice
  const pageLimit = options?.packByBytes ? pageBytes : Math.floor(pageBytes / 3)
  function* walk(initial: unknown): Generator<Token> {
    type Frame = { readonly kind: 'array'; readonly value: readonly unknown[]; readonly depth: number; index: number }
      | { readonly kind: 'object'; readonly value: Record<string, unknown>; readonly keys: readonly string[]; readonly depth: number; index: number }
    const stack: Frame[] = []
    let value = initial, depth = 0
    // One frame per open container avoids a generator allocation and delegation at every metadata node
    // Preserve traversal, getter timing and string slicing because exact token pages define historical identities
    for (;;) {
      if (depth > WORKSPACE_BACKUP_LIMITS.depth) throw new Error('Backup metadata is too deeply nested')
      if (typeof value === 'string') {
        if (value.length <= TEXT_SLICE) yield ['text-value', value]
        else {
          yield ['string']
          for (let offset = 0; offset < value.length; offset += TEXT_SLICE) yield ['text', value.slice(offset, offset + TEXT_SLICE)]
          yield ['string-end']
        }
      } else if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) yield ['value', value]
      else if (Array.isArray(value)) { yield ['array']; stack.push({ kind: 'array', value, depth, index: 0 }) }
      else if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        yield ['object']; stack.push({ kind: 'object', value: value as Record<string, unknown>, keys: Object.keys(value), depth, index: 0 })
      } else throw new Error('Unsupported backup metadata value')
      for (;;) {
        const parent = stack.at(-1)
        if (!parent) return
        if (parent.kind === 'array' && parent.index < parent.value.length) {
          value = parent.value[parent.index++]; depth = parent.depth + 1
          break
        }
        if (parent.kind === 'object' && parent.index < parent.keys.length) {
          const key = parent.keys[parent.index++]!
          if (forbidden.has(key)) throw new Error('Unsafe backup metadata key')
          yield ['key', key]
          value = parent.value[key]; depth = parent.depth + 1
          break
        }
        stack.pop(); yield ['end']
      }
    }
  }
  let page = '['
  let pageLength = 1
  const encoder = new TextEncoder()
  for (const token of walk(value)) {
    const text = JSON.stringify(token)
    if (text.length > WORKSPACE_BACKUP_LIMITS.payload / 3 && encoder.encode(text).length > WORKSPACE_BACKUP_LIMITS.payload - 2) throw new Error('Backup metadata token exceeds frame bound')
    const textLength = options?.packByBytes ? utf8Length(text) : text.length
    if (page.length > 1 && pageLength + textLength + 2 > pageLimit) { yield encoder.encode(page + ']'); page = '['; pageLength = 1 }
    pageLength += (page.length > 1 ? 1 : 0) + textLength
    page += (page.length > 1 ? ',' : '') + text
  }
  yield encoder.encode(page + ']')
}
export class BackupJsonReader {
  private readonly stack: { value: JsonValue[] | Record<string, JsonValue>; key?: string }[] = []
  private text: string[] | undefined
  private root: JsonValue | undefined
  private assigned = false
  private nodes = 0
  private assign(value: JsonValue) {
    if (this.stack.length > WORKSPACE_BACKUP_LIMITS.depth) throw new Error('Backup metadata is too deeply nested')
    // Each node consumes input bytes, so this budget derives from the archive limit rather than a new content cap
    if (++this.nodes > WORKSPACE_BACKUP_LIMITS.bytes) throw new Error('Backup metadata node limit exceeded')
    const parent = this.stack.at(-1)
    if (!parent) { if (this.assigned) throw new Error('Duplicate backup metadata root'); this.root = value; this.assigned = true }
    else if (Array.isArray(parent.value)) parent.value.push(value)
    else { if (parent.key === undefined) throw new Error('Missing backup metadata key'); parent.value[parent.key] = value; parent.key = undefined }
  }
  consume(bytes: Uint8Array) {
    const tokens: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!Array.isArray(tokens) || !tokens.length) throw new Error('Invalid backup token page')
    for (const token of tokens) {
      if (!Array.isArray(token) || typeof token[0] !== 'string') throw new Error('Invalid backup token')
      const [kind, value] = token
      if (token.length !== (['key', 'text', 'text-value', 'value'].includes(kind) ? 2 : 1)) throw new Error('Invalid backup token arity')
      if (this.text && !['text', 'string-end'].includes(kind)) throw new Error('Interrupted backup string')
      if (kind === 'text-value') { if (typeof value !== 'string') throw new Error('Invalid backup text value'); this.assign(value) }
      else if (kind === 'string') { if (this.text) throw new Error('Nested backup string'); this.text = [] }
      else if (kind === 'text') { if (!this.text || typeof value !== 'string') throw new Error('Invalid backup string fragment'); this.text.push(value) }
      else if (kind === 'string-end') { if (!this.text) throw new Error('Missing backup string start'); this.assign(this.text.join('')); this.text = undefined }
      else if (kind === 'key') {
        const parent = this.stack.at(-1)
        if (!parent || Array.isArray(parent.value) || parent.key !== undefined || typeof value !== 'string' || forbidden.has(value) || Object.hasOwn(parent.value, value)) throw new Error('Duplicate or invalid backup key')
        parent.key = value
      } else if (kind === 'value') {
        if (!(value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value))) throw new Error('Invalid backup primitive')
        this.assign(value)
      } else if (kind === 'array' || kind === 'object') {
        if (this.stack.length > WORKSPACE_BACKUP_LIMITS.depth) throw new Error('Backup metadata is too deeply nested')
        const value = kind === 'array' ? [] : Object.create(null)
        this.assign(value); this.stack.push({ value })
      } else if (kind === 'end') {
        const parent = this.stack.pop()
        if (!parent || parent.key !== undefined) throw new Error('Invalid backup container end')
      } else throw new Error('Unknown backup token')
    }
  }
  finish(): JsonValue { if (!this.assigned || this.stack.length || this.text) throw new Error('Incomplete backup metadata'); return this.root! }
}
