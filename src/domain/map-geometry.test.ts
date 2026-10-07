import { describe, expect, it } from 'vitest'
import { decodeMapGeometry, encodeMapGeometry, MAP_FACE, type MapGeometryMetadata } from './map-geometry'
import { isoGeometryBoundsVisible, isoProject, isoVisibleGeometry, isoVisibleGeometryTiles, type IsoCamera } from '../mod-inspector/isometric'

const bounds = { x: -32, z: 0, width: 32, height: 32 }
const metadata: MapGeometryMetadata = { bounds, file: 'synthetic.bin', size: 1, sha256: '', minY: 90, maxY: 108 }
const runs = new Uint8Array([0, 90, 0, 9, MAP_FACE.xPos, 4, 0, 100, 0, 49, MAP_FACE.all, 8])

describe('native volume tiles', () => {
  it('retains walls, trunks and vertical gaps without expanding a column from its top', () => {
    const tile = decodeMapGeometry(encodeMapGeometry(runs, bounds, 0), metadata, 0)
    expect(tile.cells).toEqual(runs)
    const camera: IsoCamera = { coord: { X: -32, Y: 100, Z: 0 }, rotation: 0, zoom: 1 }
    expect(isoVisibleGeometry([tile], camera)).toEqual([
      { coord: { X: -32, Y: 90, Z: 0 }, voxelId: 9, faces: MAP_FACE.xPos, height: 4 },
      { coord: { X: -32, Y: 100, Z: 0 }, voxelId: 49, faces: MAP_FACE.top | MAP_FACE.xPos | MAP_FACE.zPos, height: 8 },
    ])
    expect(isoVisibleGeometry([tile], { ...camera, rotation: 2 }).some(cell => cell.voxelId === 9)).toBe(false)
  })
  it('refuses mismatched layer, bounds, expansion, masks, overlapping runs and false height ranges', () => {
    const encoded = encodeMapGeometry(runs, bounds, 0)
    expect(() => decodeMapGeometry(encoded, metadata, 1)).toThrow('identity')
    expect(() => decodeMapGeometry(encoded, { ...metadata, bounds: { ...bounds, x: 0 } }, 0)).toThrow('identity')
    expect(() => decodeMapGeometry(encoded, { ...metadata, minY: 80 }, 0)).toThrow('height range')
    const oversized = encoded.slice()
    new DataView(oversized.buffer).setUint32(oversized.length - 4, 0xffffffff, true)
    expect(() => decodeMapGeometry(oversized, metadata, 0)).toThrow('expansion')
    for (const bad of [new Uint8Array([32, 90, 0, 9, 1, 1]), new Uint8Array([0, 90, 0, 255, 1, 1]), new Uint8Array([0, 90, 0, 9, 32, 1]), new Uint8Array([0, 250, 0, 9, 1, 8]), new Uint8Array([0, 90, 0, 9, 1, 12, 0, 100, 0, 49, 1, 8])]) expect(() => decodeMapGeometry(encodeMapGeometry(bad, bounds, 0), metadata, 0)).toThrow()
  })
  it('culls prisms exactly like exhaustive corners across rotations, heights and zoom', () => {
    for (const rotation of [0, 1, 2, 3, 4, 5, 6, 7] as const) for (const elevation of [0, 20, 34, 45, 56, 65, 90]) for (const zoom of [.5, 1, 2]) for (const height of [1, 8, 120]) for (let x = -80; x < 80; x += 7) {
      const camera: IsoCamera = { coord: { X: 0, Y: 99, Z: 0 }, rotation, zoom, elevation }
      const prism = { x, z: 20, width: 16, height: 32 }
      const corners = [prism.x, prism.x + prism.width].flatMap(X => [80, 80 + height].flatMap(Y => [prism.z, prism.z + prism.height].map(Z => isoProject({ X, Y, Z }, camera))))
      const expected = Math.max(...corners.map(p => p.x)) >= 0 && Math.min(...corners.map(p => p.x)) <= 960 && Math.max(...corners.map(p => p.y)) >= 0 && Math.min(...corners.map(p => p.y)) <= 600
      expect(isoGeometryBoundsVisible(prism, 80, 80 + height, camera)).toBe(expected)
    }
    const camera: IsoCamera = { coord: { X: -32, Y: 100, Z: 0 }, rotation: 0, zoom: 1 }
    expect(isoVisibleGeometryTiles([metadata, { ...metadata, bounds: { ...bounds, x: 1000 } }], camera)).toEqual([metadata])
  })
})
