import { describe, expect, it } from 'vitest'
import { BUNDLED_CATALOGS, DEFAULT_CATALOG } from './bundled'
import { TRAVEL_UNLOCK_GROUPS } from './travel-unlocks'
import { catalogArtwork } from './sprites'
import { catalogContentForChecksum } from '../interchange/correction-promotion'
import { sha256 } from '../interchange/util'

describe('travel unlock roster and source definitions', () => {
  it('provides distinct item references with acquisition evidence for every group', () => {
    const seen = new Set<string>()
    for (const group of TRAVEL_UNLOCK_GROUPS) for (const entityId of group.entityIds) {
      expect(seen.has(entityId), entityId).toBe(false)
      seen.add(entityId)
      const entity = DEFAULT_CATALOG.entities[entityId]!
      expect(entity?.kind, entityId).toBe('item')
      expect(entity.sources.some(source => source.sourceId.includes('crystal-project.fandom.com') && source.snapshot?.startsWith('revision ')), entityId).toBe(true)
      expect(entity.fields.Description?.state, entityId).toBe('known')
      expect(entity.fields.Description && 'value' in entity.fields.Description ? entity.fields.Description.value : undefined, entityId).toBeTruthy()
      const artwork = catalogArtwork(DEFAULT_CATALOG.id, entity)
      expect(artwork?.source, entityId).toBe('native')
      expect(artwork?.url, entityId).toBeTruthy()
      if (artwork?.source === 'native') {
        expect(artwork.binding.name, entityId).toBe(entity.name)
        expect(artwork.binding.database.recordName, entityId).toBe(entity.name)
      }
    }
    expect([...seen].some(id => id.includes('shard'))).toBe(false)
    expect(DEFAULT_CATALOG.entities['wiki:item:salmon-cello']?.fields.Location).toMatchObject({ state: 'known', value: 'Finish first in the Salmon Run.' })
    expect(DEFAULT_CATALOG.entities['wiki:item:old-world-stone']?.sources[0]?.sourceId).toBe('https://crystal-project.fandom.com/wiki/Tools?oldid=7601')
  })

  it('preserves the previous bundled revision and its content checksum', async () => {
    const previous = BUNDLED_CATALOGS.find(catalog => catalog.revisionId === 'bundled-v1')!
    expect(previous).toBeDefined()
    expect(previous.entities['wiki:item:ibek-bell']).toBeUndefined()
    const { checksum, ...content } = previous
    expect(checksum).toBe(`builtin:sha256:${await sha256(new TextEncoder().encode(catalogContentForChecksum(content)))}`)
  })
})
