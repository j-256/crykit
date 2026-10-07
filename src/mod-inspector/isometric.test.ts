import { describe, expect, it } from 'vitest'
import { decodeMapSurface, encodeMapSurface, mapSurfaceCell } from '../domain/map-surface'
import { parseDocument } from './document'
import { addVoxelPlatform, inspectMapProject, MAP_EDITOR_LIMITS, newMapProject } from './map-editor'
import { ISO, ISO_CLIP, isoCameraDepth, isoCellVisible, isoDragCoord, isoFaces, isoGeometryBoundsVisible, isoGroundDelta, isoProjection, isoProject, isoSurfaceIndex, isoTerrainBounds, isoViewportFootprint, isoVisibleSurface, placementPreview, type IsoCamera, type IsoRotation } from './isometric'

const bounds = { x: -2, z: 4, width: 2, height: 2 }
const cells = new Uint8Array([9, 100, 0, 9, 100, 0, 255, 0, 0, 5, 98, 4])
const surface = decodeMapSurface(encodeMapSurface(cells, bounds, 0), bounds, 0)
const origin = { X: -12, Y: 99, Z: 4 }
const camera: IsoCamera = { coord: origin, rotation: 0, zoom: 1 }

describe('isometric placement and native surface preview', () => {
  it('matches exhaustive projected coverage when tile heights vary and empty tiles surround the viewport', () => {
    const fixtureBounds = { x: -96, z: -64, width: 160, height: 128 }
    const tuples = new Uint8Array(fixtureBounds.width * fixtureBounds.height * 3)
    const all: { X: number; Y: number; Z: number }[] = []
    for (let z = 0; z < fixtureBounds.height; z++) for (let x = 0; x < fixtureBounds.width; x++) {
      const offset = (z * fixtureBounds.width + x) * 3
      tuples[offset] = z < 32 ? 255 : 9
      tuples[offset + 1] = x < 64 ? 120 : 60
      if (tuples[offset] !== 255) all.push({ X: fixtureBounds.x + x, Y: tuples[offset + 1]! - 1, Z: fixtureBounds.z + z })
    }
    const fixture = { bounds: fixtureBounds, cells: tuples, layer: 0 }
    const index = isoSurfaceIndex(fixture)
    const identity = (point: { X: number; Y: number; Z: number }) => `${point.X},${point.Y},${point.Z}`
    for (const rotation of [0, 1, 2, 3, 4, 5, 6, 7] as const) for (const zoom of [.5, 1, 2]) {
      const view = { ...camera, rotation, zoom }
      const expected = new Set(all.filter(coord => isoCellVisible(coord, view)).map(identity))
      const actual = new Set(isoVisibleSurface(fixture, index, view).map(cell => identity(cell.coord)))
      expect(actual).toEqual(expected)
    }
    expect(isoVisibleSurface(fixture, index, { ...camera, coord: { X: 1000, Y: 0, Z: 1000 } })).toEqual([])
  })
  it('covers the screen at every rotation and zoom, including elevated cells beyond the camera footprint', () => {
    const mapBounds = { x: -500, z: -500, width: 1000, height: 1000 }
    for (const rotation of [0, 1, 2, 3, 4, 5, 6, 7] as const) for (const zoom of [.5, 1, 2]) {
      const view = { ...camera, rotation, zoom }
      const expectedCorners = [[0, 0], [ISO.viewWidth, 0], [ISO.viewWidth, ISO.viewHeight], [0, ISO.viewHeight]]
      isoViewportFootprint(view).forEach((point, index) => {
        const projected = isoProject(point, view)
        expect(projected.x).toBeCloseTo(expectedCorners[index]![0]!)
        expect(projected.y).toBeCloseTo(expectedCorners[index]![1]!)
      })
      const candidates = isoTerrainBounds(view, { min: 10, max: 180 }, mapBounds)
      for (const Y of [10, 99, 179]) for (let X = -110; X < 110; X += 3) for (let Z = -110; Z < 110; Z += 3) if (isoCellVisible({ X, Y, Z }, view)) {
        expect(X).toBeGreaterThanOrEqual(candidates.x)
        expect(X).toBeLessThan(candidates.x + candidates.width)
        expect(Z).toBeGreaterThanOrEqual(candidates.z)
        expect(Z).toBeLessThan(candidates.z + candidates.height)
      }
    }
    expect(isoCellVisible({ X: origin.X + 30, Y: 99, Z: origin.Z }, { ...camera, zoom: .5 })).toBe(true)
    expect(isoCellVisible({ X: origin.X + 30, Y: 99, Z: origin.Z }, camera)).toBe(false)
    expect(isoTerrainBounds(camera, { min: 99, max: 100 }, bounds)).toEqual(bounds)
    expect(isoSurfaceIndex(surface).height).toEqual({ min: 97, max: 100 })
    expect(isoSurfaceIndex({ bounds: { x: 0, z: 0, width: 1, height: 1 }, layer: 0, cells: new Uint8Array([255, 255, 0]) }).height).toEqual({ min: 0, max: 0 })
  })
  it('inverts horizontal projection at every rotation and zoom without changing height', () => {
    for (const rotation of [0, 1, 2, 3, 4, 5, 6, 7] as const) for (const elevation of [20, 34, 45, 56, 65]) for (const zoom of [.5, 1, 2]) {
      const view = { ...camera, rotation: rotation as IsoRotation, zoom, elevation }
      const start = isoProject(origin, view)
      const target = isoProject({ X: origin.X + 3, Y: origin.Y, Z: origin.Z - 2 }, view)
      const delta = { x: target.x - start.x, y: target.y - start.y }
      expect(isoGroundDelta(delta, view)).toEqual({ X: 3, Z: -2 })
      expect(isoDragCoord(origin, delta, view, 'ground')).toEqual({ X: -9, Y: 99, Z: 2 })
      expect(isoDragCoord(origin, { x: 500, y: isoProjection(view).yY * 3 }, view, 'height')).toEqual({ X: -12, Y: 102, Z: 4 })
    }
    expect(() => isoDragCoord({ ...origin, Y: MAP_EDITOR_LIMITS.intMax }, { x: 0, y: -ISO.height }, camera, 'height')).toThrow('range')
  })
  it('clips terrain behind the virtual camera and trims tall faces at its depth limits', () => {
    for (const rotation of [0, 1, 2, 3, 4, 5, 6, 7] as const) for (const elevation of [20, 45, 56, 65]) {
      const view: IsoCamera = { ...camera, rotation, elevation, clipDepth: true }
      const p = isoProjection(view)
      const length = Math.hypot(p.viewX, p.viewY, p.viewZ)
      const onRay = (distance: number) => ({ X: origin.X + p.viewX / length * distance, Y: origin.Y + p.viewY / length * distance, Z: origin.Z + p.viewZ / length * distance })
      for (const distance of [30, -100]) {
        const behind = onRay(distance)
        expect(isoProject(behind, view).x).toBeCloseTo(480)
        expect(isoProject(behind, view).y).toBeCloseTo(300)
        expect(isoGeometryBoundsVisible({ x: behind.X, z: behind.Z, width: 1, height: 1 }, behind.Y, behind.Y + 1, view)).toBe(false)
        expect(isoFaces(behind, 1, view)).toEqual([])
      }
      const faces = isoFaces({ ...origin, Y: 90 }, 100, view)
      expect(faces.length).toBeGreaterThan(0)
      for (const point of faces.flatMap(face => face.points)) {
        expect(isoCameraDepth(point, view)).toBeLessThanOrEqual(ISO_CLIP.distance - ISO_CLIP.near + 1e-7)
        expect(isoCameraDepth(point, view)).toBeGreaterThanOrEqual(ISO_CLIP.distance - ISO_CLIP.far - 1e-7)
      }
    }
  })
  it('round-trips native tuples, keeps empty and underwater cells distinct, and refuses expansion or mismatched identity', () => {
    expect(surface.cells).toEqual(cells)
    expect(mapSurfaceCell(surface, -2, 4)).toEqual({ voxelId: 9, height: 100, underwater: false })
    expect(mapSurfaceCell(surface, -2, 5)).toBeUndefined()
    expect(mapSurfaceCell(surface, -1, 5)?.underwater).toBe(true)
    expect(mapSurfaceCell(surface, -3, 4)).toBeUndefined()
    expect(mapSurfaceCell(surface, -1.5, 4)).toBeUndefined()
    const encoded = JSON.parse(encodeMapSurface(cells, bounds, 0))
    for (const change of [ { layer: 1 }, { bounds: { ...bounds, x: 0 } }, { runs: [5, 9, 100, 0] }, { runs: [3, 9, 100, 0] }, { runs: [4, 9, 256, 0] }, { runs: [4, 9, 100, '0'] } ]) expect(() => decodeMapSurface(JSON.stringify({ ...encoded, ...change }), bounds, 0)).toThrow()
  })
  it('distinguishes authored support and overlap from mapped alignment and unknown native clearance', () => {
    const blank = newMapProject('synthetic-isometric', '2026-01-01T00:00:00.000Z')
    const block = addVoxelPlatform(blank, { coord: { X: -2, Y: 100, Z: 4 }, width: 1, depth: 1, biomeId: 1, voxelId: 9, knownVoxelIds: [9], lastNativeEntityId: 3824 })
    const placements = inspectMapProject(parseDocument(block)).placements
    expect(placementPreview({ X: -2, Y: 100, Z: 4 }, placements, undefined, surface)).toContain('Overlaps')
    expect(placementPreview({ X: -2, Y: 101, Z: 4 }, placements, undefined, surface)).toContain('stationary authored block')
    expect(placementPreview({ X: -2, Y: 100, Z: 4 }, placements, 3825, surface)).toContain('Aligned')
    expect(placementPreview({ X: -2, Y: 99, Z: 4 }, [], undefined, surface)).toContain('clearance unknown')
    expect(placementPreview({ X: -2, Y: 103, Z: 4 }, [], undefined, surface)).toContain('support unknown')
    expect(placementPreview({ X: -1, Y: 98, Z: 5 }, [], undefined, surface)).toContain('Underwater')
    expect(placementPreview({ X: -2, Y: 98, Z: 5 }, [], undefined, surface)).toContain('unknown here')
    const conditional = inspectMapProject(parseDocument(block.replace('"ConditionType":0', '"ConditionType":5'))).placements
    const scripted = inspectMapProject(parseDocument(block.replace('"Pages":[]', '"Pages":[{}]'))).placements
    expect(scripted[0]?.staticVoxel).toBe(false)
    expect(conditional[0]?.staticVoxel).toBe(false)
    expect(placementPreview({ X: -2, Y: 101, Z: 4 }, conditional, undefined, surface)).toContain('support unknown')
  })
})
