import { describe, expect, it } from 'vitest'
import { MAP_FACE } from '../domain/map-geometry'
import { isoFaces, isoPointOnPlane, isoProject, isoVisibleFaces, type IsoCamera } from './isometric'
import { brushPlaneCell, pickConstructionPlane, pickVoxelFace, voxelBrushStamp, voxelCellKey, voxelPlatformStamp, voxelStrokeLine } from './voxel-brush'

const coord = { X: -12, Y: 99, Z: -4 }
const cell = { coord, height: 8, faces: MAP_FACE.all, id: 4000 }

describe('voxel face brushing across camera orbits', () => {
  it('picks the correct neighboring cell on every visible face, yaw and elevation', () => {
    for (const rotation of [0, 1, 2, 3, 4, 5, 6, 7] as const) for (const elevation of [0, 20, 34, 45, 56, 65, 90]) for (const zoom of [.5, 1, 2]) {
      const camera: IsoCamera = { coord, rotation, elevation, zoom }
      for (const face of isoFaces(coord, 8, camera)) {
        const center = { X: face.points.reduce((sum, p) => sum + p.X, 0) / 4, Y: face.points.reduce((sum, p) => sum + p.Y, 0) / 4, Z: face.points.reduce((sum, p) => sum + p.Z, 0) / 4 }
        const pick = pickVoxelFace(isoProject(center, camera), [cell], camera)!
        expect(pick.id).toBe(4000)
        expect(pick.axis).toBe(face.axis)
        expect(pick.adjacent[face.axis]).toBe(face.axis === 'Y' ? 107 : coord[face.axis] + face.direction)
        const free = (['X', 'Y', 'Z'] as const).find(axis => axis !== face.axis)!
        const target = { ...center, [free]: center[free] + 3 }
        const next = brushPlaneCell(isoProject(target, camera), camera, pick)!
        expect(next[face.axis]).toBe(pick.adjacent[face.axis])
        expect(next[free]).toBe(Math.floor(target[free]))
      }
      expect(pickVoxelFace({ x: 0, y: 0 }, [cell], camera)).toBeUndefined()
    }
  })
  it('targets empty-space construction cells at an explicit height across oblique views', () => {
    for (const rotation of [0, 1, 2, 3, 4, 5, 6, 7] as const) for (const elevation of [20, 34, 45, 56, 65]) for (const zoom of [.5, 1, 2]) {
      const camera: IsoCamera = { coord, rotation, elevation, zoom }
      const point = isoProject({ X: -11.75, Y: 140, Z: -5.25 }, camera)
      const pick = pickConstructionPlane(point, camera, 140)!
      expect(pick).toEqual({ coord: { X: -12, Y: 140, Z: -6 }, adjacent: { X: -12, Y: 140, Z: -6 }, axis: 'Y', plane: 140 })
      expect(brushPlaneCell(isoProject({ X: -7.75, Y: 140, Z: -1.25 }, camera), camera, pick)).toEqual({ X: -8, Y: 140, Z: -2 })
    }
    for (const height of [NaN, Infinity, .5, 2147483648, -2147483649]) expect(pickConstructionPlane({ x: 480, y: 300 }, { coord, rotation: 0, zoom: 1 }, height)).toBeUndefined()
    expect(pickConstructionPlane({ x: 480, y: 300 }, { coord, rotation: 0, zoom: 1, elevation: 0 }, 140)).toBeUndefined()
  })
  it('chooses the front face of stacked blocks and refuses singular edge-on planes', () => {
    const camera: IsoCamera = { coord, rotation: 0, zoom: 1 }
    const low = { coord, height: 1, faces: MAP_FACE.all, id: 4000 }
    const high = { ...low, coord: { ...coord, Y: 100 }, id: 4001 }
    const pick = pickVoxelFace(isoProject({ ...coord, X: -11.5, Y: 101, Z: -3.5 }, camera), [low, high], camera)
    expect(pick).toMatchObject({ id: 4001, adjacent: { X: -12, Y: 101, Z: -4 } })
    expect(isoVisibleFaces({ ...camera, elevation: 90 })).toBe(MAP_FACE.top)
    expect(isoVisibleFaces({ ...camera, elevation: 0 }) & MAP_FACE.top).toBe(0)
    expect(isoPointOnPlane({ x: 480, y: 300 }, { ...camera, elevation: 0 }, 'Y', 99)).toBeUndefined()
    expect(isoPointOnPlane({ x: 480, y: 300 }, { ...camera, elevation: 90 }, 'X', -12)).toBeUndefined()
  })
  it('connects sparse pointer samples with bounded integer cells, including negative axes', () => {
    const line = voxelStrokeLine(coord, { X: -8, Y: 99, Z: -4 })
    expect(line.map(cell => cell.X)).toEqual([-12, -11, -10, -9, -8])
    expect(voxelStrokeLine(coord, coord)).toEqual([coord])
    expect(() => voxelStrokeLine(coord, { ...coord, X: 1000 })).toThrow('too long')
    for (const axis of ['X', 'Y', 'Z'] as const) {
      const stamp = voxelBrushStamp(coord, axis, 2)
      expect(stamp).toHaveLength(4)
      expect(new Set(stamp.map(cell => cell[axis]))).toEqual(new Set([coord[axis]]))
      for (const free of (['X', 'Y', 'Z'] as const).filter(value => value !== axis)) expect(new Set(stamp.map(cell => cell[free]))).toEqual(new Set([coord[free], coord[free] + 1]))
    }
  })
  it('keeps rectangular platforms horizontal and rejects invalid dimensions or coordinate overflow', () => {
    expect(voxelPlatformStamp(coord, 2, 3).map(voxelCellKey)).toEqual(['-12,99,-4', '-12,99,-3', '-12,99,-2', '-11,99,-4', '-11,99,-3', '-11,99,-2'])
    for (const [width, depth] of [[0, 2], [2, NaN], [9, 2], [2, 1.5]]) expect(() => voxelPlatformStamp(coord, width!, depth!)).toThrow('width and depth')
    expect(() => voxelPlatformStamp({ ...coord, X: 2147483647 }, 2, 1)).toThrow('coordinate range')
    expect(() => voxelPlatformStamp({ ...coord, Z: 2147483647 }, 1, 2)).toThrow('coordinate range')
  })
})
