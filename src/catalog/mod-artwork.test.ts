import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from './bundled'
import { BUNDLED_MOD_LIBRARY, bundledModEditableSource } from './mod-library'
import { catalogArtwork } from './sprites'
import { previewImport } from '../interchange/import'
import { composeModLayers } from '../domain/mod-layers'
import { MOD_PROJECT_FIELD } from '../domain/mod-library'
import { GAME_RECORD_FIELD } from '../domain/game-record-facts'
import { bundledModSearchCatalogs } from './mod-search'
import type { CatalogEntity, EntityId } from '../domain/types'

const freelancer = DEFAULT_CATALOG.entities['mod:moonlight-project:class:26']!
const moonlight = BUNDLED_MOD_LIBRARY.find(mod => mod.key === 'moonlight-project')!
async function importedMoonlight() {
  const source = await bundledModEditableSource(moonlight)
  return (await previewImport(new TextEncoder().encode(source.text), source.filename)).proposed.catalogs[0]!
}

describe('source-scoped mod artwork', () => {
  it('preserves exact digest and texture bindings while a bundled source is only a search preview', async () => {
    const preview = bundledModSearchCatalogs().find(catalog => catalog.id === moonlight.id)!
    const entity = Object.values(preview.entities).find(entity => entity.name === 'Freelancer')!
    const incoming = await importedMoonlight()
    const full = Object.values(incoming.entities).find(entity => entity.name === 'Freelancer')!
    expect(catalogArtwork(preview.id, entity)).toEqual(catalogArtwork(incoming.id, full))
    expect(catalogArtwork(preview.id, entity)?.source).toBe('mod')
  })

  it('binds bundled classes to the declared custom actor sheets', () => {
    const art = catalogArtwork(DEFAULT_CATALOG.id, freelancer)
    expect(art?.source).toBe('mod')
    if (art?.source !== 'mod') throw new Error('Expected Moonlight artwork')
    expect(art.url).toMatch(/mod-artwork-atlases\/[a-f0-9]{64}\.png/)
    expect(art.provenance).toBe('mod-export')
    expect(art.binding.sources[0]?.locator).toBe('Actor/MP_Ai_Overworld')
    expect(art.asset).toMatchObject({ width: 32, height: 15 })
  })

  it('uses the same exact artwork for a saved source import and a composed vanilla replacement', async () => {
    const incoming = await importedMoonlight()
    const entity = Object.values(incoming.entities).find(entity => entity.name === 'Freelancer')!
    const imported = catalogArtwork(incoming.id, entity)
    expect(imported?.url).toBe(catalogArtwork(DEFAULT_CATALOG.id, freelancer)?.url)
    const composed = composeModLayers({ baseline: { catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId }, layers: [{ catalogId: incoming.id, catalogRevisionId: incoming.revisionId, enabled: true }], links: [{ modelKey: 'crystal-edit:Jobs:26', targetEntityId: 'base:job:0' as EntityId }] }, [DEFAULT_CATALOG, incoming])
    const replacement = composed.entities['base:job:0']!
    expect(catalogArtwork(DEFAULT_CATALOG.id, replacement)?.url).toBe(imported?.url)
    expect(catalogArtwork(DEFAULT_CATALOG.id, replacement)?.asset.file).not.toBe(catalogArtwork(DEFAULT_CATALOG.id, DEFAULT_CATALOG.entities['base:job:0']!)?.asset.file)
  })

  it('rejects a changed source digest, project, kind, or texture reference and does not inherit replaced vanilla art', async () => {
    const incoming = await importedMoonlight()
    const entity = Object.values(incoming.entities).find(entity => entity.name === 'Freelancer')!
    const source = entity.fields[GAME_RECORD_FIELD]
    if (source?.state !== 'known') throw new Error('Expected source record')
    const variants: CatalogEntity[] = [
      { ...entity, kind: 'item' },
      { ...entity, fields: { ...entity.fields, [MOD_PROJECT_FIELD]: { state: 'known', value: 'crystal-edit:another-project' } } },
      { ...entity, fields: { ...entity.fields, [GAME_RECORD_FIELD]: { ...source, sources: [{ sourceId: `source:sha256:${'0'.repeat(64)}` }] } } },
      { ...entity, fields: { ...entity.fields, [GAME_RECORD_FIELD]: { ...source, value: { ...(source.value as object), ActorTexturePathF: 'Actor/Another' } } } },
    ]
    for (const variant of variants) {
      expect(catalogArtwork(incoming.id, variant)).toBeUndefined()
      expect(catalogArtwork(DEFAULT_CATALOG.id, { ...variant, id: 'base:job:0' as EntityId })).toBeUndefined()
    }
    expect(catalogArtwork('synthetic-foreign', { id: freelancer.id, kind: freelancer.kind })).toBeUndefined()
  })

  it('keeps exact custom skill icons ahead of generic skill glyphs and gaps unbound', async () => {
    const incoming = await importedMoonlight()
    const ability = Object.values(incoming.entities).find(entity => entity.kind === 'ability' && catalogArtwork(incoming.id, entity)?.source === 'mod')!
    expect(catalogArtwork(incoming.id, ability)?.source).toBe('mod')
    const gap = { ...freelancer, fields: { ...freelancer.fields, [GAME_RECORD_FIELD]: { state: 'known' as const, value: { ID: 26, ActorTexturePathM: null, ActorTexturePathF: null } } } }
    expect(catalogArtwork(DEFAULT_CATALOG.id, gap)).toBeUndefined()
  })
})
