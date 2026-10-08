import { describe, expect, it } from 'vitest'
import { SYNTHETIC_MOD_SNAPSHOT } from './mod.test-helpers'
import { buildBundledModEntities, bundledModEntityId } from '../domain/bundled-mods'
import { NATIVE_GAME_DATA } from './native-game'
import { definitionSourceRecord } from '../domain/mechanics-facts'
import { exportedTree } from '../domain/crystal-edit'
import { classTreeSkill } from './class-learn-tree'
import { DEFAULT_CATALOG } from './bundled'

describe('synthetic mod definition evidence', () => {
  const entities = buildBundledModEntities(SYNTHETIC_MOD_SNAPSHOT, NATIVE_GAME_DATA.enums)
  const catalog = { ...DEFAULT_CATALOG, entities }
  it('projects exact versioned records and preserves their source values', () => {
    for (const [family, records] of Object.entries(SYNTHETIC_MOD_SNAPSHOT.families)) for (const record of records) {
      const entity = entities[bundledModEntityId(SYNTHETIC_MOD_SNAPSHOT.key, family, Number(record.ID))]!
      expect(definitionSourceRecord(entity)).toEqual(record)
      expect(entity.sources).toContainEqual(expect.objectContaining({ locator: expect.stringContaining(`model ID ${record.ID}`), snapshot: expect.stringContaining(SYNTHETIC_MOD_SNAPSHOT.source.sha256) }))
    }
    const blade = entities[bundledModEntityId(SYNTHETIC_MOD_SNAPSHOT.key, 'Equipment', 9000)]!
    expect(blade.fields['Equipment type']).toMatchObject({ state: 'known', value: 'Sword' })
    expect(blade.fields['Stat modifiers']).toMatchObject({ state: 'known', value: [expect.objectContaining({ Tag: 40, Value1: 7 })] })
  })
  it('keeps exported learning, innate costs and exact tree references attached to their own revision', () => {
    const innate = entities[bundledModEntityId(SYNTHETIC_MOD_SNAPSHOT.key, 'Passives', 9000)]!
    expect(innate.kind).toBe('innate')
    expect(innate.ppCost).toMatchObject({ state: 'known', value: 2 })
    const job = entities[bundledModEntityId(SYNTHETIC_MOD_SNAPSHOT.key, 'Jobs', 26)]!
    for (const node of exportedTree(job).filter(node => node.nodeType === 2 || node.nodeType === 3)) expect(classTreeSkill(job, node, catalog).definition).toBeDefined()
    expect(classTreeSkill(job, { row: 0, column: 0, nodeType: 2, dataId: 99999, prerequisites: [] }, catalog).definition).toBeUndefined()
  })
})
