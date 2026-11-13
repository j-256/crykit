import { expect, it } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { LAUNCH_DATA_GENERATION } from '../domain/data-generation'
import { buildBehavior, saveBuildBehavior } from '../domain/build-behavior'
import { selectBuildModRevision, buildContentForModSetup } from '../domain/build-mods'
import { withBuildReferenceNames } from '../domain/build-reference-names'
import { createBuild, saveBuildRevision } from '../domain/builds'
import { composeModCatalog, expandModCatalogs } from '../domain/mod-layers'
import { sourceCompositionDigest } from '../domain/source-composition'
import { createTestLocalData } from '../domain/test-helpers'
import { previewCrystalEdit } from './crystal-edit'
import { createPublicSnapshot, decodePublicSnapshot, encodePublicSnapshot } from './public-share'
import { PUBLIC_SHARE_ROUTE_PREFIX, validatePublicSnapshot } from './public-share-schema'

const blank = () => ({ version: 6, dataGeneration: LAUNCH_DATA_GENERATION, kind: 'build', title: 'Synthetic share', setup: { catalogLock: {}, baseline: null, layers: [], mode: { state: 'unknown' }, ppCostsNonNegative: { state: 'unknown' }, slots: [] }, slots: [{ primaryClass: null, secondaryClass: null, equipment: [], equipmentGroups: [], passives: [] }], receipts: [] })

it('requires the launch generation and rejects every retired public payload', () => {
  const snapshot = validatePublicSnapshot(blank())
  expect(PUBLIC_SHARE_ROUTE_PREFIX).toBe('#/share/v6/')
  expect(decodePublicSnapshot(encodePublicSnapshot(snapshot))).toEqual(snapshot)
  for (const version of [0, 1, 2, 3, 4, 5]) expect(() => validatePublicSnapshot({ ...snapshot, version })).toThrow()
  for (const dataGeneration of [undefined, 'prelaunch']) expect(() => validatePublicSnapshot({ ...snapshot, dataGeneration })).toThrow()
})

it('accepts only canonical source pins and source-specific revisions', () => {
  for (const [catalogId, catalogRevisionId] of [['crystal-project/vanilla', 'v1'], ['crystal-project/guide/synthetic', 'v2'], ['crystal-project/mod/synthetic', 'v3'], [`crystal-project/imported/ce1-${'a'.repeat(64)}`, `j1-${'b'.repeat(64)}-p1`]]) {
    expect(() => validatePublicSnapshot({ ...blank(), setup: { ...blank().setup, baseline: { catalogId, catalogRevisionId } } })).not.toThrow()
  }
  for (const [catalogId, catalogRevisionId] of [['/private/source.json', 'v1'], ['crystal-project/vanilla', 'latest'], ['crystal-project/vanilla', `composition-v2:sha256:${'a'.repeat(64)}`], ['crystal-project/guide/source.json', 'v1'], [`crystal-project/imported/ce1-${'a'.repeat(64)}`, 'v1']]) {
    expect(() => validatePublicSnapshot({ ...blank(), setup: { ...blank().setup, baseline: { catalogId, catalogRevisionId } } })).toThrow()
  }
})

it('publishes separate contributors and a complete composition digest without private choices or bodies', async () => {
  const source = async (ID: string, IsLocalization: boolean) => (await previewCrystalEdit(new TextEncoder().encode(JSON.stringify({ ID, Title: ID, EditorVersion: 34, IsLocalization, Equipment: [{ ID: 3, Name: ID, EquipmentType: 0, StatMods: [] }] })), 'PRIVATE_FILENAME.json')).proposed.catalogs[0]!
  const mechanical = await source('Mechanical source', false), text = await source('Localized source', true)
  const catalogs = [DEFAULT_CATALOG, mechanical, text], initial = createTestLocalData(), original = Object.values(initial.gameSetups)[0]!
  const behavior = catalogs.slice(1).reduce((value, catalog) => selectBuildModRevision(value, catalog, catalogs), buildBehavior(original))
  const saved = saveBuildBehavior(initial, behavior), effective = composeModCatalog(saved.setup, catalogs)!
  const all = expandModCatalogs([...catalogs, effective])
  const ref = { kind: 'catalog' as const, catalogId: effective.id, catalogRevisionId: effective.revisionId, entityId: 'base:equipment:3' as never }
  const content = withBuildReferenceNames(buildContentForModSetup({ primaryClass: null, secondaryClass: null, equipment: { hand: { ref } }, passives: [], contextAssumptions: [] }, saved.setup, all), all)
  let localData = createBuild(saved.localData, { id: 'PRIVATE_BUILD' as never, gameSetupId: saved.setup.gameSetupId, title: 'Synthetic share' })
  localData = saveBuildRevision(localData, { id: 'PRIVATE_CHECKPOINT' as never, buildId: 'PRIVATE_BUILD' as never, gameSetupRevisionId: saved.setup.id, content })
  const snapshot = createPublicSnapshot({ planner: { localData, catalogs: all } }, { kind: 'build', revisionId: 'PRIVATE_CHECKPOINT' as never }, { includeNotes: false })
  expect(snapshot.setup.catalogLock?.[DEFAULT_CATALOG.id]).toBe(`composition-v2:sha256:${sourceCompositionDigest(saved.setup.modComposition!, catalogs)}`)
  expect(snapshot.receipts[0]).toMatchObject({ name: 'Localized source', origins: { mechanical: { catalogId: mechanical.id, catalogRevisionId: mechanical.revisionId }, text: { catalogId: text.id, catalogRevisionId: text.revisionId } } })
  expect((content as import('../domain/types').BuildRevisionContent).referenceNames?.[0]).toHaveProperty('origins')
  for (const field of ['PRIVATE_', 'identityMappings', 'crystalEditIdentities', 'rawDescription', 'StatMods', 'gameRules', 'targetEntityId']) expect(JSON.stringify(snapshot)).not.toContain(field)
})
