import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { createBlankLocalData } from '../domain'
import { buildBehavior } from '../domain/build-behavior'
import { selectBuildModRevision } from '../domain/build-mods'
import { CLASS_FIELDS } from '../domain/crystal-edit'
import { nativeEntityId, nativeSourceRecord } from '../domain/native-game'
import { composeModCatalog, expandModCatalogs, modCatalogRevision, modModelEntity } from '../domain/mod-layers'
import { createTestLocalData, TEST_GAME_SETUP_REVISION_ID, TEST_NOW } from '../domain/test-helpers'
import type { BuildRevisionContent, CatalogRef, CatalogSnapshot, EntityId, EntityRef, GameSetupRevision, PersonalDefinition, PersonalDefinitionId } from '../domain/types'
import { previewCrystalEdit } from '../interchange/crystal-edit'
import { previewAbilityGroups } from './preview-ability-groups'

const localData = createBlankLocalData()
const nativeRef = (entityId: string, catalog = DEFAULT_CATALOG): CatalogRef => ({ kind: 'catalog', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: entityId as EntityId })
const hunter = nativeRef('base:job:7')
const wizard = nativeRef('base:job:3')
const snipe = nativeRef('base:ability:147')
const content = (primaryClass: EntityRef | null = hunter, secondaryClass: EntityRef | null = wizard): BuildRevisionContent => ({ primaryClass, secondaryClass, equipment: {}, passives: [], contextAssumptions: [] })
const names = (refs: readonly EntityRef[], catalogs: readonly CatalogSnapshot[] = [DEFAULT_CATALOG]) => refs.map(ref => ref.kind === 'catalog' ? catalogs.find(catalog => catalog.id === ref.catalogId && catalog.revisionId === ref.catalogRevisionId)?.entities[ref.entityId]?.name : undefined)
const imported = async (id: string, values: Record<string, unknown>) => (await previewCrystalEdit(new TextEncoder().encode(JSON.stringify({ ID: id, Title: id, EditorVersion: 34, ...values })), 'synthetic.json')).proposed.catalogs[0]!
function compose(sources: readonly CatalogSnapshot[]) {
  const setup = createTestLocalData().gameSetups[TEST_GAME_SETUP_REVISION_ID]!
  const catalogs = [DEFAULT_CATALOG, ...sources]
  const behavior = sources.reduce((value, source) => selectBuildModRevision(value, source, catalogs), buildBehavior(setup))
  const gameSetup: GameSetupRevision = { ...setup, ...behavior, catalogLock: { [DEFAULT_CATALOG.id]: modCatalogRevision(setup.id) } }
  const effective = composeModCatalog(gameSetup, catalogs)!
  return { gameSetup, catalogs: expandModCatalogs([...catalogs, effective]), effective }
}

describe('preview ability class groups', () => {
  it('uses native command membership for the selected primary and subclass', () => {
    const groups = previewAbilityGroups(content(), localData, [DEFAULT_CATALOG])
    expect(groups.map(group => group.label)).toEqual(['Class: Hunter', 'Subclass: Wizard'])
    expect(groups[0]!.refs).toContainEqual(snipe)
    expect(names(groups[0]!.refs)).not.toContain('Fire')
    expect(names(groups[1]!.refs)).toContain('Fire')
    expect(names(groups[1]!.refs)).not.toContain('Snipe')
    expect(groups[0]!.refs).toHaveLength((nativeSourceRecord(DEFAULT_CATALOG.entities[hunter.entityId]!)!.AbilityIDs as number[]).length)
  })

  it('does not repeat the same class or remove abilities from their first group', () => {
    const groups = previewAbilityGroups(content(hunter, hunter), localData, [DEFAULT_CATALOG])
    expect(groups.map(group => group.label)).toEqual(['Class: Hunter'])
    expect(groups[0]!.refs).toContainEqual(snipe)
    expect(previewAbilityGroups(content(null, wizard), localData, [DEFAULT_CATALOG]).map(group => group.label)).toEqual(['Subclass: Wizard'])
  })

  it('uses the native mode-specific command list while retaining ordinary base picker identities', () => {
    const beatsmith = nativeRef('base:job:9')
    const gameSetup = { ...createTestLocalData().gameSetups[TEST_GAME_SETUP_REVISION_ID]!, mode: { state: 'known' as const, value: 'Vanilla' } }
    const groups = previewAbilityGroups(content(beatsmith, null), localData, [DEFAULT_CATALOG], gameSetup)
    const variant = DEFAULT_CATALOG.entities[nativeEntityId('job', 9, 'Vanilla')]!
    const expected = nativeSourceRecord(variant)!.AbilityIDs as number[]
    expect(groups[0]!.refs.map(ref => ref.kind === 'catalog' ? Number(ref.entityId.split(':')[2]) : null)).toEqual(expected)
    expect(groups[0]!.refs).toContainEqual(nativeRef('base:ability:388'))
    expect(groups[0]!.refs.every(ref => ref.kind === 'catalog' && !ref.entityId.includes(':mode:'))).toBe(true)
  })

  it('uses effective mod membership and exact replacements without restoring removed native abilities', async () => {
    const source = await imported('synthetic-command', { Jobs: [{ ID: 7, Name: 'Mod Hunter', AbilityIDs: [147, 9000] }], Abilities: [{ ID: 147, Name: 'Mod Snipe' }, { ID: 9000, Name: 'Added Shot' }] })
    const setup = compose([source])
    const primary = nativeRef('base:job:7', setup.effective)
    const groups = previewAbilityGroups(content(primary, null), localData, setup.catalogs, setup.gameSetup)
    expect(groups.map(group => group.label)).toEqual(['Class: Mod Hunter'])
    expect(names(groups[0]!.refs, setup.catalogs)).toEqual(['Mod Snipe', 'Added Shot'])
    expect(groups[0]!.refs[0]).toEqual(nativeRef('base:ability:147', setup.effective))
    expect(groups[0]!.refs).toHaveLength(2)
  })

  it('keeps added ability collisions scoped to their effective project and deduplicates a shared native ability', async () => {
    const first = await imported('first-command', { Jobs: [{ ID: 9000, Name: 'First class', AbilityIDs: [9000, 147] }], Abilities: [{ ID: 9000, Name: 'First shot' }] })
    const second = await imported('second-command', { Jobs: [{ ID: 9000, Name: 'Second class', AbilityIDs: [9000, 147] }], Abilities: [{ ID: 9000, Name: 'Second shot' }] })
    const setup = compose([first, second])
    const firstClass = modModelEntity(setup.effective, 'crystal-edit:Jobs:9000')!
    const secondClass = modModelEntity(setup.effective, 'crystal-edit:Jobs:9001')!
    const groups = previewAbilityGroups(content(nativeRef(firstClass.id, setup.effective), nativeRef(secondClass.id, setup.effective)), localData, setup.catalogs, setup.gameSetup)
    expect(names(groups[0]!.refs, setup.catalogs)).toEqual(['First shot', 'Snipe'])
    expect(names(groups[1]!.refs, setup.catalogs)).toEqual(['Second shot'])
  })

  it('resolves class aliases to the same effective ability identities', async () => {
    const source = await imported('synthetic-alias', { Jobs: [{ ID: 9000, Name: 'Alias class', AbilityIDs: [147] }] })
    const setup = compose([source])
    const primary = nativeRef(modModelEntity(setup.effective, 'crystal-edit:Jobs:9000')!.id, setup.effective)
    const secondary = nativeRef('crystal-edit:Jobs:9000', setup.effective)
    const groups = previewAbilityGroups(content(primary, secondary), localData, setup.catalogs, setup.gameSetup)
    expect(groups).toHaveLength(1)
    expect(names(groups[0]!.refs, setup.catalogs)).toEqual(['Snipe'])
  })

  it('preserves explicit personal membership changes and unknown memberships', () => {
    const base = DEFAULT_CATALOG.entities[hunter.entityId]!
    const personal: PersonalDefinition = { id: 'personal-hunter' as PersonalDefinitionId, revision: 1, name: 'Personal Hunter', kind: 'class', baseRef: hunter, fields: { ...base.fields, [CLASS_FIELDS.abilities]: { state: 'known', value: [147] } }, aliases: [], sources: [], createdAt: TEST_NOW, updatedAt: TEST_NOW }
    const ref: EntityRef = { kind: 'personal', definitionId: personal.id }
    const data = { ...localData, personalDefinitions: { [personal.id]: personal } }
    const groups = previewAbilityGroups(content(ref, hunter), data, [DEFAULT_CATALOG])
    expect(groups[0]).toMatchObject({ label: 'Class: Personal Hunter', refs: [snipe] })
    expect(groups[1]!.refs).not.toContainEqual(snipe)
    const unknown = { ...data, personalDefinitions: { [personal.id]: { ...personal, fields: { ...personal.fields, [CLASS_FIELDS.abilities]: { state: 'unknown' as const } } } } }
    expect(previewAbilityGroups(content(ref, null), unknown, [DEFAULT_CATALOG])).toEqual([])
  })

  it('does not guess unresolved, unavailable mod, or malformed class memberships from names or trees', async () => {
    expect(previewAbilityGroups(content(nativeRef('missing-class'), null), localData, [DEFAULT_CATALOG])).toEqual([])
    const source = await imported('unconfirmed-command', { Jobs: [{ ID: 9000, Name: 'Hunter', AbilityIDs: [9000] }], Abilities: [{ ID: 9000, Name: 'Unconfirmed Shot' }] })
    const selected = nativeRef(modModelEntity(source, 'crystal-edit:Jobs:9000')!.id, source)
    expect(previewAbilityGroups(content(selected, null), localData, [DEFAULT_CATALOG, source])).toEqual([])
    const original = DEFAULT_CATALOG.entities[hunter.entityId]!
    for (const value of [{ state: 'unknown' as const }, { state: 'known' as const, value: [147, 'malformed'] }]) {
      const catalog = { ...DEFAULT_CATALOG, entities: { ...DEFAULT_CATALOG.entities, [original.id]: { ...original, fields: { ...original.fields, [CLASS_FIELDS.abilities]: value } } } }
      expect(previewAbilityGroups(content(hunter, null), localData, [catalog])).toEqual([])
    }
  })
})
