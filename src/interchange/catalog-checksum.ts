import type { CatalogSnapshot } from '../domain/types'

export function catalogContentForChecksum(catalog: Omit<CatalogSnapshot, 'checksum'>): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)]))
    return value
  }
  return JSON.stringify(canonical(catalog))
}
