import { describe, expect, it } from 'vitest'
import { createBlankProfile } from '../domain/profile'
import { CRYSTAL_EDIT_FIELDS, exportedTree, growthRatings } from '../domain/crystal-edit'
import { NativeCatalogSnapshotSchema } from '../interchange/native-schema'
import { catalogContentForChecksum, verifyReviewedCatalogChecksums } from '../interchange/correction-promotion'
import { sha256 } from '../interchange/util'
import { BUNDLED_CATALOGS, DEFAULT_CATALOG, REVIEWED_CATALOG_BUNDLE } from './bundled'
import { BUNDLED_CATALOG_CHECKSUM, BUNDLED_CATALOG_REVISION_ID } from './bundled-catalog'
import { projectSourceSemantics } from './source-semantics'
import { STARTER_CATALOG } from './starter'
import { CONFIRMED_SKILL_MAPS, suggestSkillTreeMap, SWITCH_MOD_PACKS_MAP_SET } from './skill-maps'

describe('bundled catalog assembly', () => {
  it('retains the original source snapshot and verifies every promoted checksum', async () => {
    expect(BUNDLED_CATALOGS).toContainEqual(STARTER_CATALOG)
    expect(BUNDLED_CATALOGS).toContainEqual(DEFAULT_CATALOG)
    await expect(verifyReviewedCatalogChecksums(REVIEWED_CATALOG_BUNDLE)).resolves.toBeUndefined()
  })

  it('combines source facts in an immutable revision while keeping prior snapshots', async () => {
    expect(DEFAULT_CATALOG.revisionId).toBe(BUNDLED_CATALOG_REVISION_ID)
    expect(DEFAULT_CATALOG.revisionId).not.toBe(STARTER_CATALOG.revisionId)
    expect(NativeCatalogSnapshotSchema.safeParse(DEFAULT_CATALOG).success).toBe(true)
    const warrior = DEFAULT_CATALOG.entities['base:class:warrior']!
    expect(growthRatings(warrior)).toMatchObject({ HP: 80, STR: 80, MND: 10 })
    expect(warrior.fields.Weapons).toEqual(STARTER_CATALOG.entities[warrior.id]!.fields.Weapons)
    expect(STARTER_CATALOG.entities[warrior.id]!.fields[CRYSTAL_EDIT_FIELDS.ratings]).toBeUndefined()
    expect(BUNDLED_CATALOGS).toContain(STARTER_CATALOG)
    expect(exportedTree(warrior).find(node => node.row === 0 && node.column === 1)).toMatchObject({ nodeType: 2, dataId: 28 })
    const { checksum: _checksum, ...content } = DEFAULT_CATALOG
    expect(BUNDLED_CATALOG_CHECKSUM).toBe(`builtin:sha256:${await sha256(new TextEncoder().encode(catalogContentForChecksum(content)))}`)
  })

  it('retains contradictory guide descriptions as competing claims', () => {
    const entity = DEFAULT_CATALOG.entities['guide:mechanic:ability:KillsUser']!
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

  it('keeps confirmed Switch mappings available in the assembled revision', () => {
    const map = CONFIRMED_SKILL_MAPS[0]!
    const result = suggestSkillTreeMap(createBlankProfile(), BUNDLED_CATALOGS, { ...map.classRef, catalogRevisionId: DEFAULT_CATALOG.revisionId }, map.squares.map(square => ({ ...square, state: 'unknown' })), SWITCH_MOD_PACKS_MAP_SET)
    expect(result.confirmedMap).toBe(map)
    expect(result.mappings).toEqual(map.mappings)
    expect(result.mappings.some(mapping => mapping.kind === 'innate')).toBe(true)
  })
})
