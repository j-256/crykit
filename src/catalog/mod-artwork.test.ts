import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from './bundled'
import { SYNTHETIC_MOD_SNAPSHOT, SYNTHETIC_BUNDLED_MOD } from './mod.test-helpers'
import { createModArtworkResolver, type ModArtworkManifest } from './mod-artwork'
import { catalogArtwork } from './sprites'
import { previewImport } from '../interchange/import'
import { composeModLayers } from '../domain/mod-layers'
import { MOD_PROJECT_FIELD } from '../domain/mod-library'
import { GAME_RECORD_FIELD } from '../domain/game-record-facts'
import { modSearchCatalog } from '../domain/mod-search'
import type { CatalogEntity, EntityId } from '../domain/types'

const ARTWORK_DIGEST = 'b'.repeat(64)
const ATLAS_DIGEST = 'c'.repeat(64)
const ROOT = { ID: SYNTHETIC_MOD_SNAPSHOT.source.projectId, Title: SYNTHETIC_MOD_SNAPSHOT.source.title, Version: '2.2', EditorVersion: 34, Jobs: [{ ...SYNTHETIC_MOD_SNAPSHOT.families.Jobs![0], ActorTexturePathM: 'Actor/Synthetic', ActorTexturePathF: 'Actor/Synthetic' }], Abilities: [{ ID: 565, Name: 'Synthetic Icon', TexturePath: 'Icon/Synthetic', TextureIndex: 0 }] }

function resolver(digest: string) {
  const region = { x: 0, y: 0, width: 32, height: 15 }
  const manifest: ModArtworkManifest = {
    assets: { [ARTWORK_DIGEST]: { file: `${ARTWORK_DIGEST}.png`, sha256: ARTWORK_DIGEST, width: 32, height: 15, license: 'Synthetic fixture', contentBounds: region, atlas: ATLAS_DIGEST, region } },
    atlases: { [ATLAS_DIGEST]: { file: `${ATLAS_DIGEST}.png`, width: 32, height: 15 } },
    projects: { [digest]: { projectId: ROOT.ID, title: ROOT.Title, version: '2.2', entities: {
      'Jobs:26': { kind: 'class', asset: ARTWORK_DIGEST, reference: ['Actor/Synthetic', 'Actor/Synthetic'], sourceTextures: [{ texturePath: 'Actor/Synthetic', origin: 'mod-export' }] },
      'Abilities:565': { kind: 'ability', asset: ARTWORK_DIGEST, reference: ['Icon/Synthetic', 0], sourceTextures: [{ texturePath: 'Icon/Synthetic', origin: 'mod-export' }] },
    } } },
  }
  return createModArtworkResolver(manifest, { [`../assets/mod-artwork-atlases/${ATLAS_DIGEST}.png`]: '/synthetic-atlas.png' }, [{ ...SYNTHETIC_BUNDLED_MOD, sourceDigest: `sha256:${digest}` }])
}

async function imported() {
  return (await previewImport(new TextEncoder().encode(JSON.stringify(ROOT)), 'synthetic.json')).proposed.catalogs[0]!
}

describe('source-scoped mod artwork with synthetic assets', () => {
  it('preserves exact digest and texture bindings in full imports and search previews', async () => {
    const full = await imported()
    const preview = modSearchCatalog(full)
    const resolve = resolver(full.checksum.replace(/^sha256:/, ''))
    const job = Object.values(full.entities).find(entity => entity.kind === 'class')!
    const art = resolve(job)
    expect(art).toEqual(resolve(preview.entities[job.id]!))
    expect(art).toMatchObject({ source: 'mod', url: '/synthetic-atlas.png', provenance: 'mod-export', asset: { width: 32, height: 15 }, binding: { sources: [expect.objectContaining({ locator: 'Actor/Synthetic' })] } })
  })

  it('keeps imported artwork on a composed replacement and does not inherit native art', async () => {
    const full = await imported()
    const resolve = resolver(full.checksum.replace(/^sha256:/, ''))
    const job = Object.values(full.entities).find(entity => entity.kind === 'class')!
    const composed = composeModLayers({ baseline: { catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId }, layers: [{ catalogId: full.id, catalogRevisionId: full.revisionId, enabled: true }], links: [{ modelKey: 'crystal-edit:Jobs:26', targetEntityId: 'base:job:0' as EntityId }] }, [DEFAULT_CATALOG, full])
    const replacement = composed.entities['base:job:0']!
    expect(resolve(replacement)).toEqual(resolve(job))
    expect(catalogArtwork(DEFAULT_CATALOG.id, replacement)).toBeUndefined()
  })

  it('rejects changed source digest, project, kind and texture references', async () => {
    const full = await imported()
    const resolve = resolver(full.checksum.replace(/^sha256:/, ''))
    const job = Object.values(full.entities).find(entity => entity.kind === 'class')!
    const source = job.fields[GAME_RECORD_FIELD]
    if (source?.state !== 'known') throw new Error('Expected synthetic source record')
    const variants: CatalogEntity[] = [
      { ...job, kind: 'item' },
      { ...job, fields: { ...job.fields, [MOD_PROJECT_FIELD]: { state: 'known', value: 'crystal-edit:another-project' } } },
      { ...job, fields: { ...job.fields, [GAME_RECORD_FIELD]: { ...source, sources: [{ sourceId: `source:sha256:${'0'.repeat(64)}` }] } } },
      { ...job, fields: { ...job.fields, [GAME_RECORD_FIELD]: { ...source, value: { ...(source.value as object), ActorTexturePathF: 'Actor/Another' } } } },
    ]
    for (const variant of variants) {
      expect(resolve(variant)).toBeUndefined()
      expect(catalogArtwork(DEFAULT_CATALOG.id, { ...variant, id: 'base:job:0' as EntityId })).toBeUndefined()
    }
  })

  it('binds exact skill icons and leaves absent texture references unbound', async () => {
    const full = await imported()
    const resolve = resolver(full.checksum.replace(/^sha256:/, ''))
    const ability = Object.values(full.entities).find(entity => entity.kind === 'ability')!
    expect(resolve(ability)?.source).toBe('mod')
    const job = Object.values(full.entities).find(entity => entity.kind === 'class')!
    expect(resolve({ ...job, fields: { ...job.fields, [GAME_RECORD_FIELD]: { state: 'known', value: { ID: 26, ActorTexturePathM: null, ActorTexturePathF: null } } } })).toBeUndefined()
  })
})
