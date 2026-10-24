import type { WorkspaceAsset } from './file-types'

export const maxImageBytes = 16 * 1024 * 1024
export const maxImageDimension = 8192
export const maxDecodedPixels = 16_777_216
export type ArtworkMediaType = WorkspaceAsset['mediaType']

function imageType(bytes: Uint8Array): ArtworkMediaType | undefined {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp'
  return undefined
}

function extensionMatches(name: string, mediaType: ArtworkMediaType): boolean {
  return mediaType === 'image/png' ? /\.png$/i.test(name) : mediaType === 'image/jpeg' ? /\.jpe?g$/i.test(name) : /\.webp$/i.test(name)
}

function declaredDimensions(bytes: Uint8Array, mediaType: ArtworkMediaType): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (mediaType === 'image/png') {
    if (bytes.length < 24 || String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR') throw new Error('PNG header is incomplete')
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }
  if (mediaType === 'image/webp') {
    if (bytes.length < 30) throw new Error('WebP header is incomplete')
    const chunk = String.fromCharCode(...bytes.slice(12, 16))
    if (chunk === 'VP8X') return { width: 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16), height: 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16) }
    if (chunk === 'VP8L' && bytes[20] === 0x2f) return { width: 1 + (bytes[21]! | (bytes[22]! & 0x3f) << 8), height: 1 + ((bytes[22]! >> 6) | (bytes[23]! << 2) | (bytes[24]! & 0x0f) << 10) }
    if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
    throw new Error('WebP dimensions are unavailable')
  }
  let offset = 2
  while (offset + 4 < bytes.length) {
    if (bytes[offset++] !== 0xff) break
    while (bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue
    if (offset + 2 > bytes.length) break
    const length = view.getUint16(offset)
    if (length < 2 || offset + length > bytes.length) break
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 7) break
      return { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) }
    }
    offset += length
  }
  throw new Error('JPEG dimensions are unavailable')
}

function assertBounds(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > maxImageDimension || height > maxImageDimension || width * height > maxDecodedPixels) throw new Error('Image dimensions exceed the supported bounds')
}

export async function validateArtwork(file: File): Promise<{ bytes: Uint8Array; mediaType: ArtworkMediaType; width: number; height: number }> {
  if (!file.size || file.size > maxImageBytes) throw new Error('Image exceeds the 16 MiB limit or is empty')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const mediaType = imageType(bytes)
  if (!mediaType || !extensionMatches(file.name, mediaType) || file.type && file.type !== mediaType) throw new Error('Image signature, extension, and type disagree')
  const declared = declaredDimensions(bytes, mediaType)
  // Bound declared pixels before invoking a decoder that may allocate the full image
  assertBounds(declared.width, declared.height)
  if (typeof createImageBitmap !== 'function') throw new Error('Image decoding is unavailable in this browser')
  const bitmap = await createImageBitmap(file)
  try {
    assertBounds(bitmap.width, bitmap.height)
    if (bitmap.width !== declared.width || bitmap.height !== declared.height) throw new Error('Decoded image dimensions disagree with its header')
    return { bytes, mediaType, width: bitmap.width, height: bitmap.height }
  } finally { bitmap.close() }
}
