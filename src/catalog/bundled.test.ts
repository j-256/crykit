import { describe, expect, it } from 'vitest'
import { createBlankLocalData } from '../domain/local-data'
import { exportedTree, growthRatings } from '../domain/crystal-edit'
import { NativeCatalogSnapshotSchema } from '../interchange/native-schema'
import { catalogContentForChecksum } from '../interchange/catalog-checksum'
import { sha256 } from '../interchange/util'
import { BUNDLED_CATALOGS, CURRENT_CATALOG, DEFAULT_CATALOG, PREVIOUS_CATALOG, preferredStarterCatalog } from './bundled'
import { VANILLA_CATALOG_REVISION_ID } from './vanilla-catalog'
import { projectSourceSemantics } from './source-semantics'
import { CONFIRMED_SKILL_MAPS, suggestSkillTreeMap, SWITCH_MOD_PACKS_MAP_SET } from './skill-maps'

describe('bundled catalog assembly', () => {
  it('prefers the current revision when historical catalogs are listed first', () => {
    expect(preferredStarterCatalog([PREVIOUS_CATALOG, CURRENT_CATALOG])).toBe(CURRENT_CATALOG)
    expect(preferredStarterCatalog([PREVIOUS_CATALOG])).toBe(PREVIOUS_CATALOG)
  })

  it('retains immutable baseline revisions with canonical identities and no development revision or alias metadata', async () => {
    expect(BUNDLED_CATALOGS).toEqual([CURRENT_CATALOG, PREVIOUS_CATALOG])
    expect(DEFAULT_CATALOG).toBe(CURRENT_CATALOG)
    expect(Object.keys(DEFAULT_CATALOG.entities).every(id => /^(base|mod):/.test(id))).toBe(true)
    expect(DEFAULT_CATALOG.legacy).not.toHaveProperty('previousRevisionId')
    expect(DEFAULT_CATALOG.legacy).not.toHaveProperty('entityIdAliases')
    for (const entity of Object.values(DEFAULT_CATALOG.entities)) expect(entity.legacy ?? {}).not.toHaveProperty('previousEntityIds')
  })

  it('combines source facts in an immutable, checksum-verified baseline', async () => {
    expect(DEFAULT_CATALOG.revisionId).toBe(VANILLA_CATALOG_REVISION_ID)
    expect(Object.isFrozen(DEFAULT_CATALOG)).toBe(true)
    expect(NativeCatalogSnapshotSchema.parse(DEFAULT_CATALOG)).toEqual(DEFAULT_CATALOG)
    const warrior = DEFAULT_CATALOG.entities['base:job:0']!
    expect(growthRatings(warrior)).toMatchObject({ HP: 80, STR: 80, MND: 10 })
    expect(exportedTree(warrior).find(node => node.row === 0 && node.column === 1)).toMatchObject({ nodeType: 2, dataId: 28 })
    const { checksum, ...content } = DEFAULT_CATALOG
    expect(checksum).toBe(`builtin:sha256:${await sha256(new TextEncoder().encode(catalogContentForChecksum(content)))}`)
  })

  it('retains contradictory guide descriptions as competing claims', () => {
    const entity = DEFAULT_CATALOG.entities['base:mechanic:ability:ref-385']!
    expect(entity.fields.Description).toMatchObject({ state: 'conflicting', claims: [{ value: "The user is instantly KO'd when the ability resolves" }, { value: "The user's HP is reduced to 1 when the ability resolves" }] })
    expect(entity.sources[0]?.locator).not.toEqual(entity.sources[1]?.locator)
  })

  it('projects equivalent source phrasing without rewriting bundled evidence', () => {
    const adjudicator = DEFAULT_CATALOG.entities['base:equipment:245']!
    expect(adjudicator.fields.Location?.state).toBe('conflicting')
    expect(projectSourceSemantics(adjudicator).fields.Location).toMatchObject({ state: 'known', value: 'Drop: Anubis in the Ancient Labyrinth' })
    const assassinSeal = DEFAULT_CATALOG.entities['base:equipment:582']!
    expect(projectSourceSemantics(assassinSeal).fields.Location?.state).toBe('conflicting')
  })

  it('preserves independently observed Switch maps without resolving them against a different revision', () => {
    for (const map of CONFIRMED_SKILL_MAPS) {
      expect(map.classRef.catalogRevisionId).toBe('catalog-v1')
      expect(map.mappings.every(mapping => mapping.ref.kind === 'catalog' && mapping.ref.entityId.length > 0)).toBe(true)
    }
    const map = CONFIRMED_SKILL_MAPS[0]!
    const unavailable = suggestSkillTreeMap(createBlankLocalData(), BUNDLED_CATALOGS, map.classRef, map.squares.map(square => ({ ...square, state: 'unknown' })), SWITCH_MOD_PACKS_MAP_SET)
    expect(unavailable.confirmedMap).toBeUndefined()
    expect(unavailable.mappings).toEqual([])
    const entities = { ...DEFAULT_CATALOG.entities }
    for (const mapping of map.mappings) if (mapping.ref.kind === 'catalog' && !entities[mapping.ref.entityId]) entities[mapping.ref.entityId] = { id: mapping.ref.entityId, kind: mapping.kind, name: 'Synthetic mapped skill', aliases: [], fields: {}, sources: [] }
    const imported = { ...DEFAULT_CATALOG, revisionId: map.classRef.catalogRevisionId, checksum: 'synthetic-imported-map', entities }
    const restored = suggestSkillTreeMap(createBlankLocalData(), [imported], map.classRef, map.squares.map(square => ({ ...square, state: 'unknown' })), SWITCH_MOD_PACKS_MAP_SET)
    expect(restored.confirmedMap).toBe(map)
    expect(restored.mappings).toEqual(map.mappings)
    expect(restored.mappings.some(mapping => mapping.kind === 'innate')).toBe(true)
  })
})
