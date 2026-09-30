import { describe, expect, it } from 'vitest'
import type { EntityId } from '../domain/types'
import { catalogArtwork, wikiSprite } from './sprites'

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
    expect(artwork.provenance).toBe('community-wiki')
  })

  it('resolves the exact built-in definition to a local asset and pinned attribution', () => {
    const sprite = wikiSprite(builtin, entity)
    expect(sprite?.url).toMatch(/wiki-sprites\/[^/]+\.gif/)
    expect(sprite?.url).not.toMatch(/^https?:/)
    expect(sprite?.asset.descriptionUrl).toMatch(/File%3AShort-sword-icon\.gif\?oldid=\d+$/)
    expect(sprite?.asset.license).toContain('Fairuse')
    expect(sprite?.binding.sources[0].url).toContain('?oldid=')
    expect(sprite?.provenance).toBe('community-wiki')
  })

  it('resolves exact Equipment Expansion cells from custom and base-game sheets', () => {
    const custom = catalogArtwork(builtin, { id: 'equipment-expansion:item:triton-s-cloak' as EntityId, kind: 'item' })
    expect(custom?.source).toBe('mod')
    if (custom?.source !== 'mod') throw new Error('Expected exact mod artwork')
    expect(custom?.url).toMatch(/mod-sprites\/[a-f0-9]{64}\.png/)
    expect(custom?.asset).toMatchObject({ width: 34, height: 34 })
    expect(custom?.asset.descriptionUrl).toBeUndefined()
    expect(custom?.binding.sources[0]).toMatchObject({ locator: 'Equipment/zrghr-2-32x32, cell 43' })
    expect(custom?.provenance).toBe('mod-export')
    const base = catalogArtwork(builtin, { id: 'equipment-expansion:item:heavy-edge' as EntityId, kind: 'item' })
    expect(base?.source).toBe('mod')
    if (base?.source !== 'mod') throw new Error('Expected reused base-game mod artwork')
    expect(base?.url).toMatch(/mod-sprites\/[a-f0-9]{64}\.png/)
    expect(base?.asset).toMatchObject({ width: 34, height: 34 })
    expect(base?.binding.sources[0]).toMatchObject({ locator: 'Content/Textures/Equipment.dat > Sword2H, cell 6' })
    expect(base?.provenance).toBe('base-game-archive')
  })

  it('does not attach artwork to foreign catalogs, different kinds, or unknown identities', () => {
    expect(catalogArtwork('synthetic-import', entity)).toBeUndefined()
    expect(catalogArtwork(builtin, { ...entity, kind: 'ability' })).toBeUndefined()
    expect(catalogArtwork(builtin, { ...entity, id: 'synthetic:item:short-sword' as EntityId })).toBeUndefined()
    const mod = { id: 'equipment-expansion:item:heavy-edge' as EntityId, kind: 'item' as const }
    expect(catalogArtwork('synthetic-import', mod)).toBeUndefined()
    expect(catalogArtwork(builtin, { ...mod, kind: 'ability' })).toBeUndefined()
    expect(wikiSprite(builtin, mod)).toBeUndefined()
  })
})
