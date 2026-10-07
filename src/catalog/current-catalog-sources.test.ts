import { expect, it, vi } from 'vitest'
import { vanillaCatalog } from './vanilla-catalog'
import { NATIVE_GAME_DATA } from './native-game'
import { nativeIdentity, nativeRelationships, nativeSourceRecord } from '../domain/native-game'
import { exportedTree } from '../domain/crystal-edit'
import { LEARNABLE_INNATE_FIELD } from './switch'
import { NativeCatalogSnapshotSchema } from '../interchange/native-schema'
import { STARTER_SOURCE_URLS } from './data'

const SYNTHETIC_CHECKSUM = `builtin:sha256:${'0'.repeat(64)}`

vi.mock('./legacy-catalog-v1.json', () => { throw new Error('Current construction must not read the historical catalog') })
vi.mock('./certainty-catalog', () => { throw new Error('Current construction must not run the historical mixed assembler') })
vi.mock('./equipment-expansion.json', () => { throw new Error('Current construction must not read the Equipment Expansion projection') })
vi.mock('./learnable-innates.json', () => { throw new Error('Current construction must not read the dated innate projection') })
vi.mock('./moonlight-project-v2.2.json', () => { throw new Error('Current construction must not read the Moonlight projection') })

it('builds native records and reviewed relationships with historical inputs unavailable', () => {
  const catalog = vanillaCatalog(SYNTHETIC_CHECKSUM)
  const warrior = catalog.entities['base:job:0']!
  const source = NATIVE_GAME_DATA.databases.job as readonly { readonly ID: number }[]
  expect(nativeSourceRecord(warrior)).toEqual(source.find(job => job.ID === 0))
  expect(NativeCatalogSnapshotSchema.safeParse(catalog).success).toBe(true)
  for (const node of exportedTree(warrior).filter(node => node.nodeType === 2 || node.nodeType === 3)) expect(catalog.entities[`base:${node.nodeType === 2 ? 'ability' : 'passive'}:${node.dataId}`]).toBeDefined()
  expect(nativeRelationships(catalog, warrior)).toEqual(expect.arrayContaining([expect.objectContaining({ database: 'passive', targetId: 'base:passive:72' })]))
  for (const entity of Object.values(catalog.entities)) {
    expect(entity.fields[LEARNABLE_INNATE_FIELD]).toBeUndefined()
    expect(entity.sources.some(source => source.sourceId.startsWith('crystal-edit-export:'))).toBe(false)
    if (nativeIdentity(entity)?.database === 'passive' && typeof nativeSourceRecord(entity)?.PP === 'number') expect(entity.ppCost).toMatchObject({ state: 'known', value: nativeSourceRecord(entity)!.PP })
  }
})

it('retains attributed supplemental facts while source-backed mods stay in their own sources', () => {
  const catalog = vanillaCatalog(SYNTHETIC_CHECKSUM)
  const definitions = Object.values(catalog.entities)
  expect(definitions.some(entity => entity.name === 'Doge Shield')).toBe(false)
  const pack = definitions.find(entity => entity.name === 'Mod Pack 2: New Challenges')!
  expect(pack.sources).toContainEqual(expect.objectContaining({ sourceId: STARTER_SOURCE_URLS['nintendo-mod-pack-2'] }))
  expect(pack.fields.Contents).toMatchObject({ state: 'known', value: expect.arrayContaining(['Doge Shield']) })
  const mounts = definitions.find(entity => entity.name === 'Mounts')!
  expect(mounts.sources).toContainEqual(expect.objectContaining({ sourceId: 'https://crystal-project.fandom.com/wiki/Mounts?oldid=5937' }))
  const mechanic = catalog.entities['base:mechanic:ability:ref-385']!
  expect(mechanic.fields.Description).toMatchObject({ state: 'conflicting', claims: [{ value: "The user is instantly KO'd when the ability resolves" }, { value: "The user's HP is reduced to 1 when the ability resolves" }] })
  expect(Object.keys(catalog.entities).some(id => id.startsWith('mod:equipment-expansion:equipment:'))).toBe(false)
  expect(catalog.entities['mod:moonlight-project:class:25']).toBeUndefined()
})
