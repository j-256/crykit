import { describe, expect, it } from 'vitest'
import { createBlankLocalData } from '../domain/local-data'
import { historicalCatalogKeys } from '../domain/corrections'
import { exportedTree, growthRatings } from '../domain/crystal-edit'
import { NativeCatalogSnapshotSchema } from '../interchange/native-schema'
import { catalogContentForChecksum, verifyReviewedCatalogChecksums } from '../interchange/correction-promotion'
import { sha256 } from '../interchange/util'
import { BUNDLED_CATALOG, BUNDLED_CATALOGS, DEFAULT_CATALOG, REVIEWED_CATALOG_BUNDLE } from './bundled'
import { CERTAINTY_CATALOG_REVISION_ID } from './certainty-catalog'
import { projectSourceSemantics } from './source-semantics'
import { CONFIRMED_SKILL_MAPS, suggestSkillTreeMap, SWITCH_MOD_PACKS_MAP_SET } from './skill-maps'

describe('bundled catalog assembly', () => {
  it('ships one baseline with canonical identities and no development revision or alias metadata', async () => {
    expect(BUNDLED_CATALOGS).toEqual([BUNDLED_CATALOG])
    expect(DEFAULT_CATALOG).toBe(BUNDLED_CATALOGS[0])
    expect(historicalCatalogKeys(BUNDLED_CATALOGS)).toEqual(new Set())
    expect(Object.keys(DEFAULT_CATALOG.entities).every(id => /^(base|mod):/.test(id))).toBe(true)
    expect(DEFAULT_CATALOG.legacy).not.toHaveProperty('previousRevisionId')
    expect(DEFAULT_CATALOG.legacy).not.toHaveProperty('entityIdAliases')
    for (const entity of Object.values(DEFAULT_CATALOG.entities)) expect(entity.legacy ?? {}).not.toHaveProperty('previousEntityIds')
    await expect(verifyReviewedCatalogChecksums(REVIEWED_CATALOG_BUNDLE)).resolves.toBeUndefined()
  })

  it('combines source facts in an immutable, checksum-verified baseline', async () => {
    expect(DEFAULT_CATALOG.revisionId).toBe(CERTAINTY_CATALOG_REVISION_ID)
    expect(Object.isFrozen(DEFAULT_CATALOG)).toBe(true)
    expect(NativeCatalogSnapshotSchema.parse(DEFAULT_CATALOG)).toEqual(DEFAULT_CATALOG)
    const warrior = DEFAULT_CATALOG.entities['base:class:warrior']!
    expect(growthRatings(warrior)).toMatchObject({ HP: 80, STR: 80, MND: 10 })
    expect(exportedTree(warrior).find(node => node.row === 0 && node.column === 1)).toMatchObject({ nodeType: 2, dataId: 28 })
    const { checksum, ...content } = DEFAULT_CATALOG
    expect(checksum).toBe(`builtin:sha256:${await sha256(new TextEncoder().encode(catalogContentForChecksum(content)))}`)
  })

  it('retains contradictory guide descriptions as competing claims', () => {
    const entity = DEFAULT_CATALOG.entities['base:mechanic:ability:KillsUser']!
    expect(entity.fields.Description).toMatchObject({ state: 'conflicting', claims: [{ value: "The user is instantly KO'd when the ability resolves" }, { value: "The user's HP is reduced to 1 when the ability resolves" }] })
    expect(entity.sources[0]?.locator).not.toEqual(entity.sources[1]?.locator)
  })

  it('projects equivalent source phrasing without rewriting bundled evidence', () => {
    const adjudicator = DEFAULT_CATALOG.entities['base:item:adjudicator']!
    expect(adjudicator.fields.Location?.state).toBe('conflicting')
    expect(projectSourceSemantics(adjudicator).fields.Location).toMatchObject({ state: 'known', value: 'Drop: Anubis in the Ancient Labyrinth' })
    const assassinSeal = DEFAULT_CATALOG.entities['base:item:assassin-seal']!
    expect(projectSourceSemantics(assassinSeal).fields.Location?.state).toBe('conflicting')
  })

  it('resolves confirmed Switch skill mappings against the baseline', () => {
    for (const map of CONFIRMED_SKILL_MAPS) {
      expect(DEFAULT_CATALOG.entities[map.classRef.entityId]?.kind).toBe('class')
      for (const mapping of map.mappings) {
        expect(mapping.ref.kind).toBe('catalog')
        if (mapping.ref.kind === 'catalog') expect(DEFAULT_CATALOG.entities[mapping.ref.entityId]?.kind).toBe(mapping.kind)
      }
    }
    const map = CONFIRMED_SKILL_MAPS[0]!
    const result = suggestSkillTreeMap(createBlankLocalData(), BUNDLED_CATALOGS, map.classRef, map.squares.map(square => ({ ...square, state: 'unknown' })), SWITCH_MOD_PACKS_MAP_SET)
    expect(result.confirmedMap).toBe(map)
    expect(result.mappings).toEqual(map.mappings)
    expect(result.mappings.some(mapping => mapping.kind === 'innate')).toBe(true)
  })
})
