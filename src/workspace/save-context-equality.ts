import type { JsonValue } from '../domain/types'
import { jsonEqual } from '../persistence/local-data'

function sameOrderedContext(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === right) return true
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null || Array.isArray(left) !== Array.isArray(right)) return false
  const keys = Object.keys(left), other = Object.keys(right)
  return keys.length === other.length && keys.every((key, index) => key === other[index] && sameOrderedContext((left as Record<string, JsonValue>)[key], (right as Record<string, JsonValue>)[key]))
}

// Contexts come from JSON construction or SavePendingSchema admission, so arrays are dense and objects contain only JSON values
// Equal ordered trees avoid repeatedly serializing all definition bindings during input renders
// Reordered keys retain canonical comparison, including distinct Unicode keys that collate equally
export function saveContextsEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  return sameOrderedContext(left, right) || jsonEqual(left, right)
}
