import { expect, it, vi } from 'vitest'
import { vanillaCatalog } from './vanilla-catalog'
import { NATIVE_GAME_DATA } from './native-game'
import { nativeIdentity, nativeRelationships, nativeSourceRecord } from '../domain/native-game'
import { exportedTree } from '../domain/crystal-edit'
import { NativeCatalogSnapshotSchema } from '../interchange/native-schema'
import { CURRENT_CATALOG } from './bundled'

const SYNTHETIC_CHECKSUM = `builtin:sha256:${'0'.repeat(64)}`

vi.mock('./mod-library-metadata', async () => {
  const { SYNTHETIC_BUNDLED_MOD } = await import('./mod.test-helpers')
  return { BUNDLED_MOD_LIBRARY: [SYNTHETIC_BUNDLED_MOD], STARTER_MOD_PROJECT_IDS: [] }
})

it('keeps native records and reviewed relationships unchanged with a populated source library', () => {
  const catalog = vanillaCatalog(SYNTHETIC_CHECKSUM)
  expect({ ...catalog, checksum: CURRENT_CATALOG.checksum }).toEqual(CURRENT_CATALOG)
  const warrior = catalog.entities['base:job:0']!
  const source = NATIVE_GAME_DATA.databases.job as readonly { readonly ID: number }[]
  expect(nativeSourceRecord(warrior)).toEqual(source.find(job => job.ID === 0))
  expect(NativeCatalogSnapshotSchema.safeParse(catalog).success).toBe(true)
  for (const node of exportedTree(warrior).filter(node => node.nodeType === 2 || node.nodeType === 3)) expect(catalog.entities[`base:${node.nodeType === 2 ? 'ability' : 'passive'}:${node.dataId}`]).toBeDefined()
  expect(nativeRelationships(catalog, warrior)).toEqual(expect.arrayContaining([expect.objectContaining({ database: 'passive', targetId: 'base:passive:72' })]))
  for (const entity of Object.values(catalog.entities)) {
    expect(entity.fields['Learnable through Learnable Innate Skill']).toBeUndefined()
    expect(entity.sources.some(source => source.sourceId.startsWith('crystal-edit-export:'))).toBe(false)
    if (nativeIdentity(entity)?.database === 'passive' && typeof nativeSourceRecord(entity)?.PP === 'number') expect(entity.ppCost).toMatchObject({ state: 'known', value: nativeSourceRecord(entity)!.PP })
  }
})
