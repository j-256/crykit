import { catalogEntity } from '../domain/entity-identities'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from './bundled'
import { TRAVEL_UNLOCK_GROUPS } from './travel-unlocks'
import { catalogArtwork } from './sprites'
import { nativeSourceRecord } from '../domain/native-game'

const WIKI_SOURCE_HOST = 'crystal-project.fandom.com'

describe('travel unlock roster and source definitions', () => {
  it('provides distinct item references with acquisition evidence for every group', () => {
    const seen = new Set<string>()
    for (const group of TRAVEL_UNLOCK_GROUPS) for (const entityId of group.entityIds) {
      expect(seen.has(entityId), entityId).toBe(false)
      seen.add(entityId)
      const entity = catalogEntity(DEFAULT_CATALOG, entityId)!
      expect(entity?.kind, entityId).toBe('item')
      expect(entity.sources.some(source => URL.canParse(source.sourceId) && new URL(source.sourceId).hostname === WIKI_SOURCE_HOST && source.snapshot?.startsWith('revision ')), entityId).toBe(true)
      expect(entity.fields.Description?.state, entityId).toBe('known')
      const native = nativeSourceRecord(entity)
      if (typeof native?.Description === 'string') expect(entity.fields.Description, entityId).toMatchObject({ state: 'known', value: native.Description })
      expect(entity.rawDescription, entityId).toBeTruthy()
      const artwork = catalogArtwork(DEFAULT_CATALOG.id, entity)
      expect(artwork?.source, entityId).toBe('native')
      expect(artwork?.url, entityId).toBeTruthy()
      if (artwork?.source === 'native') {
        expect(artwork.binding.database.recordName, entityId).toBe(entity.name)
      }
    }
    expect([...seen].some(id => id.includes('shard'))).toBe(false)
    expect(catalogEntity(DEFAULT_CATALOG, 'base:item:salmon-cello')?.fields.Location).toMatchObject({ state: 'known', value: 'Finish first in the Salmon Run.' })
    expect(catalogEntity(DEFAULT_CATALOG, 'base:item:old-world-stone')?.sources[0]?.sourceId).toBe('https://crystal-project.fandom.com/wiki/Tools?oldid=7601')
  })
})
