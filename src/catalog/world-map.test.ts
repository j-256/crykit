import 'fake-indexeddb/auto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { composeWorldMap } from '../domain/world-map'
import { previewCrystalEdit } from '../interchange/crystal-edit'
import { catalogSnapshotKey } from '../interchange/identity'
import { CryKitDatabase, setDatabaseForTests } from '../persistence/database'
import { BUNDLED_MOD_LIBRARY } from './mod-library'
import { CURRENT_CATALOG, DEFAULT_CATALOG } from './bundled'
import { BUNDLED_MOD_SEARCH_CATALOGS } from './mod-search'
import { loadMapModLayer, loadWorldMap, validateWorldMapSource, worldMapImage, worldMapTargetRef } from './world-map'
import manifestSource from './world-map.json'

beforeAll(() => { vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(manifestSource)))) })
afterAll(() => { vi.unstubAllGlobals() })

describe('bundled native world map and original mod source joining', () => {
  it('loads each native atlas layer and rejects a changed executable or native definition snapshot', async () => {
    const manifest = await loadWorldMap()
    expect(manifest.layers.map(layer => layer.id)).toEqual([0, 1, 4, 5, 6, 7, 8, 9])
    expect(manifest.layers.every(layer => worldMapImage(layer) === worldMapImage(layer.id) && worldMapImage(layer).length > 0)).toBe(true)
    expect(() => validateWorldMapSource({ ...manifest, source: { ...manifest.source, gameExecutableSha256: '0'.repeat(64) } })).toThrow('does not match')
    expect(() => validateWorldMapSource({ ...manifest, source: { ...manifest.source, nativeContentDigest: '0'.repeat(64) } })).toThrow('does not match')
    expect(() => validateWorldMapSource({ ...manifest, layers: [{ id: 0, label: 'Damaged', image: '../private.png' }] })).toThrow('does not match')
  })

  it('joins Equipment Expansion originals into native placements, preserving empty replacement and N/A coordinates', async () => {
    const bundled = BUNDLED_MOD_LIBRARY.find(mod => mod.key === 'equipment-expansion')!
    const layer = await loadMapModLayer({ catalogId: bundled.id, catalogRevisionId: bundled.sourceDigest as never }, [DEFAULT_CATALOG])
    const result = composeWorldMap(await loadWorldMap(), [layer])
    expect(layer.entities.length).toBeGreaterThan(0)
    const added = result.markers.filter(marker => marker.sourceId === bundled.id && marker.change === 'added')
    expect(added.some(marker => marker.kind === 'chest')).toBe(true)
    expect(added.some(marker => marker.kind === 'boss')).toBe(true)
    expect(added.filter(marker => marker.region === null).every(marker => marker.biomeId === 0 && marker.layer === null)).toBe(true)
    expect(result.markers.filter(marker => marker.entityId === 87)).toHaveLength(1)
    expect(result.markers.find(marker => marker.entityId === 87)).toMatchObject({ change: 'modified', name: 'Empty chest', targets: [] })
    expect(result.markers.every(marker => marker.targets.every(target => target.sourceId !== 'unresolved'))).toBe(true)
    const backbreaker = result.markers.find(marker => marker.kind === 'chest' && marker.name === 'Backbreaker')!
    expect(backbreaker).toBeDefined()
    const ref = worldMapTargetRef(backbreaker.targets[0]!, [DEFAULT_CATALOG])
    expect(ref).toBeDefined()
    expect(DEFAULT_CATALOG.entities[ref!.entityId]?.name).toBe('Backbreaker')
    const preview = BUNDLED_MOD_SEARCH_CATALOGS.find(catalog => catalog.id === bundled.id)!
    const unloaded = worldMapTargetRef(backbreaker.targets[0]!, [CURRENT_CATALOG])
    expect(unloaded).toMatchObject({ catalogId: preview.id, catalogRevisionId: preview.revisionId })
    expect(preview.entities[unloaded!.entityId]?.name).toBe('Backbreaker')
    const changed = { ...preview, revisionId: 'synthetic-updated' as typeof preview.revisionId, checksum: 'sha256:different' }
    expect(worldMapTargetRef(backbreaker.targets[0]!, [CURRENT_CATALOG, changed])).toEqual(unloaded)
    expect(worldMapTargetRef({ ...backbreaker.targets[0]!, sourceRevisionId: 'sha256:unknown' }, [DEFAULT_CATALOG])).toBeUndefined()
  })

  it('reports an unavailable pinned source without substituting another project version', async () => {
    const bundled = BUNDLED_MOD_LIBRARY.find(mod => mod.key === 'equipment-expansion')!
    const result = await loadMapModLayer({ catalogId: bundled.id, catalogRevisionId: 'sha256:unavailable' as never }, [DEFAULT_CATALOG])
    expect(result.entities).toEqual([])
    expect(result.warnings.join(' ')).toContain('exact mod revision is unavailable')
  })

  it('reads imported originals at the selected revision and recovers after damaged source bytes are repaired', async () => {
    const database = new CryKitDatabase(`world-map-${crypto.randomUUID()}`)
    setDatabaseForTests(database)
    try {
      const projectId = `synthetic-map-${crypto.randomUUID()}`
      const source = (name: string) => new TextEncoder().encode(JSON.stringify({ ID: projectId, Title: 'Synthetic map mod', EditorVersion: 34, Equipment: [{ ID: 900, Name: name }], Entities: [{ ID: 5000, Coord: { X: 1, Y: 100, Z: 1 }, BiomeID: 1, EntityType: 5, TreasureData: { LootType: 2, LootValue: 900 } }] }))
      const older = await previewCrystalEdit(source('Older blade'), 'older.json')
      const newer = await previewCrystalEdit(source('Newer blade'), 'newer.json')
      for (const preview of [older, newer]) {
        const snapshot = preview.proposed.catalogs[0]!
        await database.catalogs.put({ key: catalogSnapshotKey(snapshot.id, snapshot.revisionId), id: snapshot.id, revisionId: snapshot.revisionId, checksum: snapshot.checksum, snapshot })
        await database.sources.put(preview.proposed.sources[0]!)
      }
      const oldCatalog = older.proposed.catalogs[0]!
      const newCatalog = newer.proposed.catalogs[0]!
      const oldPin = { catalogId: oldCatalog.id, catalogRevisionId: oldCatalog.revisionId }
      const newPin = { catalogId: newCatalog.id, catalogRevisionId: newCatalog.revisionId }
      const catalogs = [oldCatalog, newCatalog]
      const original = older.proposed.sources[0]!
      await database.sources.put({ ...original, bytes: new TextEncoder().encode('{}') })
      expect((await loadMapModLayer(oldPin, catalogs)).warnings.join(' ')).toContain('missing or damaged')
      await database.sources.put(original)
      const [oldLayer, newLayer] = await Promise.all([loadMapModLayer(oldPin, catalogs), loadMapModLayer(newPin, catalogs)])
      const manifest = await loadWorldMap()
      expect(composeWorldMap(manifest, [oldLayer]).markers.find(marker => marker.id === `${oldCatalog.id}:entity:5000`)?.name).toBe('Older blade')
      expect(composeWorldMap(manifest, [newLayer]).markers.find(marker => marker.id === `${newCatalog.id}:entity:5000`)?.name).toBe('Newer blade')
      expect(worldMapTargetRef(oldLayer.definitions[0]!, catalogs)?.catalogRevisionId).toBe(oldCatalog.revisionId)
    } finally {
      setDatabaseForTests(undefined)
      await database.delete()
    }
  })

  it('retries a rejected manifest load after its source becomes usable', async () => {
    vi.resetModules()
    const { loadWorldMap: retryLoad } = await import('./world-map')
    const fetchSource = vi.fn().mockResolvedValueOnce(new Response('Unavailable', { status: 503 })).mockResolvedValueOnce(new Response(JSON.stringify(manifestSource)))
    vi.stubGlobal('fetch', fetchSource)
    await expect(retryLoad()).rejects.toThrow('HTTP 503')
    expect((await retryLoad()).source.gameExecutableSha256).toBe(manifestSource.source.gameExecutableSha256)
    expect(fetchSource).toHaveBeenCalledTimes(2)
    expect(fetchSource.mock.calls[0]?.[0]).toBe(fetchSource.mock.calls[1]?.[0])
  })

  it('rejects malformed marker coordinates and lets a valid bundled source load on retry', async () => {
    vi.resetModules()
    const { loadWorldMap: retryLoad } = await import('./world-map')
    const malformed = { ...manifestSource, markers: [{ ...manifestSource.markers[0], x: 'unresolved' }] }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(malformed))).mockResolvedValueOnce(new Response(JSON.stringify(manifestSource))))
    await expect(retryLoad()).rejects.toThrow('malformed')
    expect((await retryLoad()).markers.length).toBeGreaterThan(0)
  })
})
