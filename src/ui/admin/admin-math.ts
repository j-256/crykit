export type ByteUnit = 'Bytes' | 'KiB' | 'MiB' | 'GiB'
export const byteUnits: readonly ByteUnit[] = ['Bytes', 'KiB', 'MiB', 'GiB']
const shifts: Record<ByteUnit, number> = {
  Bytes: 0,
  KiB: 10,
  MiB: 20,
  GiB: 30,
}
const MAX_INPUT_LENGTH = 64

export type ParsedBytes =
  | { bytes: number; error: null; roundedFrom?: string }
  | { bytes: null; error: 'format' | 'unsafe'; roundedFrom?: never }

export function parseUnitBytesDetailed(input: string, unit: ByteUnit): ParsedBytes {
  const text = input.trim()
  if (text.length > MAX_INPUT_LENGTH || !/^(?:(?:0|[1-9]\d*)(?:\.\d*)?|\.\d+)$/.test(text))
    return { bytes: null, error: 'format' }
  const [whole, fraction = ''] = text.split('.')
  const numerator = BigInt(whole || '0') * 10n ** BigInt(fraction.length) + BigInt(fraction || '0')
  const scaled = numerator * (1n << BigInt(shifts[unit]))
  const divisor = 10n ** BigInt(fraction.length)
  const remainder = scaled % divisor
  // Integer ceiling keeps decimal conversion exact and rejects a rounded result beyond safe storage
  const bytes = scaled / divisor + (remainder > 0n ? 1n : 0n)
  if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) return { bytes: null, error: 'unsafe' }
  if (remainder === 0n) return { bytes: Number(bytes), error: null }
  const digits = remainder.toString().padStart(fraction.length, '0').replace(/0+$/, '')
  return { bytes: Number(bytes), error: null, roundedFrom: `${scaled / divisor}.${digits}` }
}

export function parseUnitBytes(input: string, unit: ByteUnit): number | null {
  return parseUnitBytesDetailed(input, unit).bytes
}

export function exactUnitValue(bytes: number, unit: ByteUnit): string {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return ''
  const shift = shifts[unit]
  if (!shift) return String(bytes)
  // Binary units have exact terminating decimals; floating point display would lose bytes
  const scaled = (BigInt(bytes) * 5n ** BigInt(shift)).toString().padStart(shift + 1, '0')
  return `${scaled.slice(0, -shift)}.${scaled.slice(-shift)}`.replace(/\.?0+$/, '')
}

export function capacity(used: number | null | undefined, limit: number | null | undefined) {
  const known =
    used != null &&
    limit != null &&
    Number.isFinite(used) &&
    Number.isFinite(limit) &&
    used >= 0 &&
    limit >= 0
  const percent = known && limit! > 0 ? (used! / limit!) * 100 : null
  return {
    percent,
    barPercent:
      percent === null ? (known && limit === 0 && used! > 0 ? 100 : 0) : Math.min(100, percent),
    over: known && used! > limit!,
  }
}

type StorageCounters = {
  payload_bytes: number
  reserved_metadata: number
  metadata_bytes: number
}

export function accountedBytes(parts: StorageCounters | null | undefined): number | null {
  if (!parts) return null
  // These are disjoint application counters; provider storage overhead is not measured here
  const total = parts.payload_bytes + parts.reserved_metadata + parts.metadata_bytes
  return Number.isSafeInteger(total) ? total : null
}

export function storageDistribution(
  parts: StorageCounters | null | undefined,
): [number, number, number] | null {
  const total = accountedBytes(parts)
  if (
    !parts ||
    total === null ||
    total <= 0 ||
    ![parts.payload_bytes, parts.reserved_metadata, parts.metadata_bytes].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    )
  )
    return null
  // Divide only disjoint counters by their own total; project capacity is a different denominator
  return [parts.payload_bytes, parts.reserved_metadata, parts.metadata_bytes].map(
    (value) => (value / total) * 100,
  ) as [number, number, number]
}
