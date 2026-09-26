import { describe, expect, it } from 'vitest'
import { imageDimensions } from './image-dimensions'

describe('image dimensions before decoding', () => {
  it('reads PNG dimensions including oversized headers without allocating pixels', () => {
    const bytes = new Uint8Array(24)
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82])
    const view = new DataView(bytes.buffer)
    view.setUint32(16, 1280); view.setUint32(20, 720)
    expect(imageDimensions(bytes)).toEqual({ width: 1280, height: 720 })
    view.setUint32(16, 1000000)
    expect(imageDimensions(bytes).width).toBe(1000000)
  })
  it('reads JPEG frame dimensions after metadata and rejects truncated segments', () => {
    const bytes = Uint8Array.from([255, 216, 255, 224, 0, 4, 0, 0, 255, 192, 0, 8, 8, 2, 208, 5, 0, 1])
    expect(imageDimensions(bytes)).toEqual({ width: 1280, height: 720 })
    expect(() => imageDimensions(bytes.slice(0, 14))).toThrow()
    expect(() => imageDimensions(Uint8Array.from([255, 216, 255, 224, 0, 0]))).toThrow()
    expect(() => imageDimensions(new TextEncoder().encode('<svg/>'))).toThrow()
  })
})
