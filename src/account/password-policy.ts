export const minimumPasswordCodePoints = 15
export const maximumPasswordBytes = 1024
export function validatePassword(value: string): { valid: boolean; reason?: 'too-short' | 'too-long' | 'invalid-unicode' } {
  // TextEncoder replaces unpaired surrogates, so validate before measuring or passing to WASM
  const points = Array.from(value)
  if (points.some(point => { const code = point.codePointAt(0)!; return code >= 0xd800 && code <= 0xdfff })) return { valid: false, reason: 'invalid-unicode' }
  if (new TextEncoder().encode(value).length > maximumPasswordBytes) return { valid: false, reason: 'too-long' }
  if (points.length < minimumPasswordCodePoints) return { valid: false, reason: 'too-short' }
  return { valid: true }
}
