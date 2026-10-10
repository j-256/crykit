import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from './bundled'
import { vanillaCatalog, VANILLA_CATALOG_REVISION_ID } from './vanilla-catalog'
import { SYNTHETIC_MOD_SNAPSHOT } from './mod.test-helpers'
import { bundledModEntityId, bundledModIdentity, buildBundledModEntities } from '../domain/bundled-mods'
import { exportedTree } from '../domain/crystal-edit'
import { nativeEntityId, nativeIdentity, nativeRelationships, nativeSourceRecord } from '../domain/native-game'
import { skillWeaponRule } from '../domain/skill-weapons'
import { definitionWithMechanics } from '../domain/mechanics-facts'
import { classTreeSkill } from './class-learn-tree'
import { NATIVE_GAME_DATA } from './native-game'
import { NativeCatalogSnapshotSchema } from '../interchange/native-schema'
import { catalogContentForChecksum } from '../interchange/catalog-checksum'
import { sha256 } from '../interchange/util'
import { SUGGESTED_BUILD_SLOTS } from '../domain/build-planning'
import { baseGameEntityId, catalogEntity } from '../domain/entity-identities'

describe('source-backed catalog certainty', () => {
  const sourceCatalog = vanillaCatalog(DEFAULT_CATALOG.checksum)
  it('uses canonical identities directly and rejects obsolete IDs', () => {
    expect(Object.keys(DEFAULT_CATALOG.entities).every(id => /^(base|mod):/.test(id))).toBe(true)
    expect(catalogEntity(DEFAULT_CATALOG, 'base:item:196')?.id).toBe('base:item:196')
    expect(catalogEntity(DEFAULT_CATALOG, 'mod:equipment-expansion:equipment:592')).toBeUndefined()
    expect(catalogEntity(DEFAULT_CATALOG, nativeEntityId('monster', 2))?.id).toBe(baseGameEntityId('monster', 2))
    expect(catalogEntity(DEFAULT_CATALOG, 'mod:moonlight-project:class:26')).toBeUndefined()
    for (const id of ['wiki:item:treasure-finder', 'switch:class:freelancer', 'native:base:monster:2', 'base:item:quintar-berries', 'mod:equipment-expansion:item:heavy-edge']) expect(catalogEntity(DEFAULT_CATALOG, id)).toBeUndefined()
    expect(catalogEntity(DEFAULT_CATALOG, 'wiki:item:nonexistent')).toBeUndefined()
    for (const id of ['__proto__', 'constructor', 'toString']) expect(catalogEntity(DEFAULT_CATALOG, id)).toBeUndefined()
    expect(baseGameEntityId('ability', 34, 'Vanilla')).not.toBe(baseGameEntityId('ability', 34))
  })
  it('assembles source snapshots without mutating them and validates the baseline checksum', async () => {
    const before = JSON.stringify(sourceCatalog)
    expect(vanillaCatalog(DEFAULT_CATALOG.checksum)).toEqual(DEFAULT_CATALOG)
    expect(JSON.stringify(sourceCatalog)).toBe(before)
    expect(DEFAULT_CATALOG.revisionId).toBe(VANILLA_CATALOG_REVISION_ID)
    expect(NativeCatalogSnapshotSchema.parse(JSON.parse(JSON.stringify(DEFAULT_CATALOG)))).toEqual(DEFAULT_CATALOG)
    const { checksum, ...content } = DEFAULT_CATALOG
    expect(checksum).toBe(`builtin:sha256:${await sha256(new TextEncoder().encode(catalogContentForChecksum(content)))}`)
  })

  it('resolves an imported synthetic technique from its versioned export, with its exact numeric identity', () => {
    const id = bundledModEntityId('synthetic-library', 'Abilities', 565)
    const skill = buildBundledModEntities(SYNTHETIC_MOD_SNAPSHOT, NATIVE_GAME_DATA.enums)[id]!
    expect(skill.name).toBe('Synthetic Technique')
    expect(bundledModIdentity(skill)).toMatchObject({ key: 'synthetic-library', family: 'Abilities', modelId: 565, version: '2.2' })
    expect(skill.fields).toMatchObject({ Class: { state: 'known', value: ['Synthetic Class'] }, 'Source mod': { state: 'known', value: 'Synthetic Library' }, Cost: { state: 'known', value: 'None' }, 'Learning cost': { state: 'known', value: 4 }, Description: { state: 'known', value: expect.stringContaining('Synthetic action') }, 'Ability modifiers': { state: 'known', value: [] } })
    expect(Object.values(skill.fields).some(value => value.state === 'unknown')).toBe(false)
    expect(skillWeaponRule(skill)).toMatchObject({ state: 'known', value: { kind: 'nonWeaponAction' } })
  })

  const syntheticCatalog = { ...DEFAULT_CATALOG, entities: buildBundledModEntities(SYNTHETIC_MOD_SNAPSHOT, NATIVE_GAME_DATA.enums) }
  it('links every synthetic tree to its own numeric definitions without guessing absent external records', () => {
    for (const job of Object.values(syntheticCatalog.entities).filter(entity => bundledModIdentity(entity)?.family === 'Jobs')) {
      for (const node of exportedTree(job).filter(node => node.nodeType === 2 || node.nodeType === 3)) {
        const skill = classTreeSkill(job, node, syntheticCatalog)
        expect(skill.definition, `${job.name} ${node.dataId}`).toBeDefined()
        expect(skill.jp).toBeGreaterThanOrEqual(0)
      }
    }
    const job = syntheticCatalog.entities[bundledModEntityId('synthetic-library', 'Jobs', 26)]!
    expect(classTreeSkill(job, { row: 0, column: 0, nodeType: 2, dataId: 99999, prerequisites: [] }, syntheticCatalog).definition).toBeUndefined()
  })

  it('joins exact base-tree identities, keeps native relationships, and exposes no duplicate numeric skill', () => {
    const taunt = DEFAULT_CATALOG.entities['base:ability:28']!
    expect(nativeIdentity(taunt)).toEqual({ database: 'ability', databaseId: 28, mode: 'base' })
    expect(nativeSourceRecord(taunt)?.MPCost).toBe(0)
    expect(DEFAULT_CATALOG.entities[nativeEntityId('ability', 28)]).toBe(taunt)
    expect(catalogEntity(DEFAULT_CATALOG, 'base:warrior:ability:taunt')).toBeUndefined()
    const warrior = DEFAULT_CATALOG.entities['base:job:0']!
    expect(nativeRelationships(DEFAULT_CATALOG, warrior)).toEqual(expect.arrayContaining([expect.objectContaining({ targetId: taunt.id, databaseId: 28 })]))
    expect(classTreeSkill(warrior, exportedTree(warrior).find(node => node.dataId === 28 && node.nodeType === 2)!, DEFAULT_CATALOG).definition?.id).toBe(taunt.id)
  })

  it('keeps null as documented source absence and lets equipment slots follow the chosen setup', () => {
    const tonic = DEFAULT_CATALOG.entities['base:item:18']!
    expect(tonic.fields['Increase Max Capacity By']).toMatchObject({ state: 'known', value: null })
    const sword = DEFAULT_CATALOG.entities['base:equipment:0']!
    expect(sword.fields.Cost).toBeUndefined()
    expect(sword.fields['Cost (copper)']).toMatchObject({ state: 'known', value: nativeSourceRecord(sword)?.Cost })
    expect(sword.slotKinds).toBeUndefined()
    expect(definitionWithMechanics(sword, SUGGESTED_BUILD_SLOTS).slotKinds).toMatchObject({ state: 'known', value: ['plan-main-hand', 'plan-off-hand'] })
  })

  it('separates identical numeric IDs and names from different synthetic projects', () => {
    const other = buildBundledModEntities({ ...SYNTHETIC_MOD_SNAPSHOT, key: 'synthetic-mod', requiredMod: 'Synthetic mod' }, NATIVE_GAME_DATA.enums)
    expect(other[bundledModEntityId('synthetic-mod', 'Abilities', 565)]?.name).toBe('Synthetic Technique')
    expect(other[bundledModEntityId('synthetic-library', 'Abilities', 565)]).toBeUndefined()
  })
})
