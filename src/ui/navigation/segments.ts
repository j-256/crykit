import { MAX_ID_LENGTH } from '../../domain'

export const COLLECTION_ID_RESERVED_SEGMENTS = new Set(['new', 'search', 'pick', 'definitions', 'corrections', 'correct'])

export const ENTITY_ID_RESERVED_SEGMENTS = new Set([...COLLECTION_ID_RESERVED_SEGMENTS, 'edit', 'field'])

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/

export const MAX_ROUTE_LENGTH = 16_384

export const DEFAULT_PICKER_LIMIT = 100

export function boundedOpaque(value: unknown, maxLength = MAX_ID_LENGTH): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !CONTROL_CHARACTER.test(value) ? value : undefined
}

export function decodeSegment(value: string): string | undefined {
  try {
    return boundedOpaque(decodeURIComponent(value))
  } catch {
    return undefined
  }
}

export function encodeSegment(value: string): string {
  const bounded = boundedOpaque(value)
  if (!bounded) throw new Error('Route identifier is invalid')
  return encodeURIComponent(bounded)
}

export function encodeIdentitySegment(value: string, reserved: ReadonlySet<string>): string {
  const encoded = encodeSegment(value)
  if (!reserved.has(value)) return encoded
  // Escape action words before parsing so a record ID cannot become an editor or overlay command
  const firstByte = value.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()
  return `%${firstByte}${encodeURIComponent(value.slice(1))}`
}

export function overlayStartsAt(segments: readonly string[], index: number): boolean {
  const segment = segments[index]
  return segment === undefined || segment === 'search' || segment === 'pick' || segment === 'definitions' || segment === 'corrections' || segment === 'correct'
}
