export const MIN_NATIVE_INTEGER = -2_147_483_648
export const MAX_NATIVE_INTEGER = 2_147_483_647

export function nativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_NATIVE_INTEGER && value <= MAX_NATIVE_INTEGER
}
