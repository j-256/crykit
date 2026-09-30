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
    expect(artwork.binding.identity?.url).toContain('/CrystalProjectAPWorld/blob/')
    expect(artwork.binding.rendering.sourceTextures[0].texturePath).toBe('Equipment/Sword')
    expect(artwork.asset.rights).toContain('Copyrighted Crystal Project')
  })

  it('binds newly imported item icons and status effects by exact native identity', () => {
    const eye = catalogArtwork(builtin, { id: 'native:base:item:28' as EntityId, kind: 'item' })
    expect(eye?.source).toBe('native')
    if (eye?.source !== 'native') throw new Error('Expected Woke Quintar Eye artwork')
    expect(eye.binding.database).toEqual({ name: 'item', id: 28, recordName: 'Woke Quintar Eye' })
    expect(eye.binding.identity).toBeUndefined()
    expect(eye.binding.nativeRecord).toMatchObject({ database: 'item', databaseId: 28, mode: 'base' })
    expect(eye.binding.rendering.sourceTextures[0]).toMatchObject({ texturePath: 'Icon/ItemC', region: { x: 70, y: 70, width: 32, height: 32 } })
    expect(eye.nativeDefinitions).toEqual(expect.objectContaining({ platform: 'Windows', gameVersion: '1.6.9' }))
    expect(catalogArtwork(builtin, { id: 'native:base:status:0' as EntityId, kind: 'status' })?.source).toBe('native')
    expect(catalogArtwork('synthetic-import', { id: 'native:base:item:28' as EntityId, kind: 'item' })).toBeUndefined()
    expect(catalogArtwork(builtin, { id: 'native:base:item:28' as EntityId, kind: 'monster' })).toBeUndefined()
  })

  it('keeps same-name enemies and mode overrides bound to their recorded sprites', () => {
    const red = catalogArtwork(builtin, { id: 'native:base:monster:179' as EntityId, kind: 'monster' })
    const river = catalogArtwork(builtin, { id: 'native:base:monster:318' as EntityId, kind: 'monster' })
    const chaos = catalogArtwork(builtin, { id: 'native:Chaos:monster:179' as EntityId, kind: 'monster' })
    if (red?.source !== 'native' || river?.source !== 'native' || chaos?.source !== 'native') throw new Error('Expected exact native enemy artwork')
    expect(red.binding.database.recordName).toBe(river.binding.database.recordName)
    expect(red.asset.file).not.toBe(river.asset.file)
    expect(red.binding.rendering.sourceTextures[0].texturePath).toBe('Monster/Z52_QuintarWokeRed')
    expect(river.binding.rendering.sourceTextures[0].texturePath).toBe('Monster/Z52_QuintarWokeTeal')
    expect(chaos.binding.nativeRecord).toMatchObject({ database: 'monster', databaseId: 179, mode: 'Chaos' })
    expect(chaos.asset.file).toBe(red.asset.file)
    expect(catalogArtwork(builtin, { id: 'native:base:ability:0' as EntityId, kind: 'ability' })).toBeUndefined()
    expect(catalogArtwork(builtin, { id: 'native:base:monster:0' as EntityId, kind: 'monster' })).toBeUndefined()
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
