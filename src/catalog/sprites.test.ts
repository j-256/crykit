import { describe, expect, it } from 'vitest'
import type { EntityId } from '../domain/types'
import { catalogArtwork } from './sprites'

describe('bundled artwork identity', () => {
  const entity = { id: 'base:item:short-sword' as EntityId, kind: 'item' as const }
  const builtin = 'crystal-project-public-starter'

  it('prefers exact native artwork with database, texture, and identity provenance', () => {
    const artwork = catalogArtwork(builtin, entity)
    expect(artwork?.source).toBe('native')
    if (artwork?.source !== 'native') throw new Error('Expected native artwork')
    expect(artwork.url).toMatch(/game-assets\/[^/]+\.png/)
    expect(artwork.url).not.toMatch(/^https?:/)
    expect(artwork.binding.database).toMatchObject({ name: 'equipment', id: 0, recordName: 'Short Sword' })
    expect(artwork.binding.identity.url).toContain('/CrystalProjectAPWorld/blob/')
    expect(artwork.binding.rendering.sourceTextures[0].texturePath).toBe('Equipment/Sword')
    expect(artwork.asset.rights).toContain('Copyrighted Crystal Project')
  })

  it('falls back to pinned wiki artwork when no exact native binding exists', () => {
    const artwork = catalogArtwork(builtin, { id: 'wiki:item:captain-s-hat' as EntityId, kind: 'item' })
    expect(artwork?.source).toBe('wiki')
    if (artwork?.source !== 'wiki') throw new Error('Expected wiki artwork')
    expect(artwork.url).toMatch(/wiki-sprites\/[^/]+\.gif/)
    expect(artwork.asset.descriptionUrl).toContain('?oldid=')
  })

  it('does not attach artwork to foreign catalogs, different kinds, or unknown identities', () => {
    expect(catalogArtwork('synthetic-import', entity)).toBeUndefined()
    expect(catalogArtwork(builtin, { ...entity, kind: 'ability' })).toBeUndefined()
    expect(catalogArtwork(builtin, { ...entity, id: 'synthetic:item:short-sword' as EntityId })).toBeUndefined()
  })
})
