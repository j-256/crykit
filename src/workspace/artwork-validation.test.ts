import { afterEach, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { maxDecodedPixels, maxImageBytes, maxImageDimension, validateArtwork } from './artwork-validation'

afterEach(() => vi.unstubAllGlobals())

async function decoder(file: File) {
  const info = await sharp(Buffer.from(await file.arrayBuffer())).metadata()
  return { width: info.width!, height: info.height!, close: () => {} }
}

it('checksSignaturesDecodeAndExactPixelBounds', async () => {
  expect(maxImageBytes).toBe(16 * 1024 * 1024)
  expect(maxImageDimension).toBe(8192)
  expect(maxDecodedPixels).toBe(16_777_216)
  vi.stubGlobal('createImageBitmap', decoder)
  const png = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#aabbcc' } }).png().toBuffer()
  const valid = await validateArtwork(new File([png], 'icon.png', { type: 'image/png' }))
  expect(valid.bytes).toEqual(new Uint8Array(png))
  expect(valid.width).toBe(32)
  await expect(validateArtwork(new File(['<svg/>'], 'icon.png', { type: 'image/png' }))).rejects.toThrow('signature')
  await expect(validateArtwork(new File([png], 'icon.jpg', { type: 'image/jpeg' }))).rejects.toThrow('disagree')
  await expect(validateArtwork(new File([png.subarray(0, 24)], 'icon.png', { type: 'image/png' }))).rejects.toThrow()
  const oversized = Uint8Array.from(png)
  new DataView(oversized.buffer).setUint32(16, 8192)
  new DataView(oversized.buffer).setUint32(20, 8192)
  await expect(validateArtwork(new File([oversized], 'large.png', { type: 'image/png' }))).rejects.toThrow('bounds')
  await expect(validateArtwork(new File([new Uint8Array(maxImageBytes + 1)], 'large.png', { type: 'image/png' }))).rejects.toThrow('16 MiB')
})
