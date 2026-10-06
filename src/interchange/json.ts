import type { JsonValue } from '../domain/types'
import { AppDataError } from './errors'
import { decodeUtf8 } from './xml'

// Imported objects later cross ordinary object merges, so null-prototype parsing alone is not sufficient
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const MAX_JSON_DEPTH = 64
const MAX_JSON_NODES = 2_000_000
export const NATIVE_BACKUP_JSON_LIMITS = Object.freeze({ maxNodes: 4_000_000 })

export function parseBoundedJson(bytes: Uint8Array, label: string, limits: { readonly maxNodes: number } = { maxNodes: MAX_JSON_NODES }): JsonValue {
  let value: unknown
  try {
    const source = decodeUtf8(bytes, label).replace(/^\uFEFF/, '')
    value = JSON.parse(source) as unknown
  } catch (error) {
    throw new AppDataError('invalid-json', `${label} is not valid JSON`, {
      recoverable: true,
      cause: error,
    })
  }
  let nodes = 0
  const visit = (candidate: unknown, depth: number): JsonValue => {
    nodes += 1
    if (nodes > limits.maxNodes || depth > MAX_JSON_DEPTH) {
      throw new AppDataError('invalid-json', `${label} exceeds safe JSON complexity limits`, {
        recoverable: true,
      })
    }
    if (candidate === null || typeof candidate === 'boolean' || typeof candidate === 'string') return candidate
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) {
        throw new AppDataError('invalid-json', `${label} contains a non-finite number`, { recoverable: true })
      }
      return candidate
    }
    if (Array.isArray(candidate)) return candidate.map((entry) => visit(entry, depth + 1))
    if (typeof candidate !== 'object') {
      throw new AppDataError('invalid-json', `${label} contains an unsupported value`, { recoverable: true })
    }
    const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
    for (const [key, entry] of Object.entries(candidate)) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new AppDataError('invalid-json', `${label} contains an unsafe object key`, {
          recoverable: true,
          details: { key },
        })
      }
      result[key] = visit(entry, depth + 1)
    }
    return result
  }
  return visit(value, 0)
}

export function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
