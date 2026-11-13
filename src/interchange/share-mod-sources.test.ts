import { analyzeBuildEquipment } from '../domain/build-mechanics'
import { describe, expect, it } from 'vitest'
import { addGameSetupRevision, createBuild, saveBuildRevision, resolveDefinition } from '../domain'
import { asId } from '../domain/core'
import { buildContentForModSetup } from '../domain/build-mods'
import { buildReferenceName, modSourceReceipts } from '../domain/build-reference-names'
import { prepareModComposition, modCatalogRevision } from '../domain/mod-layers'
import { modSourceMatch } from '../domain/mod-source-match'
import { createTestLocalData, TEST_NOW } from '../domain/test-helpers'
import type { BuildId, CatalogRef, EntityId } from '../domain/types'
import { BUNDLED_CATALOGS, CURRENT_CATALOG } from '../catalog/bundled'
import { prepareModCatalogs } from '../persistence/local-data'
import { immutableCatalogSnapshot } from './native'
import { previewCrystalEdit } from './crystal-edit'
import { createPublicSnapshot, decodePublicSnapshot, encodePublicSnapshot } from './public-share'
import { prepareLocalBuildModRecovery } from './share-mod-recovery'

async function admittedModCatalog(text: string, filename: string) {
  const preview = await previewCrystalEdit(new TextEncoder().encode(text), filename, TEST_NOW)
  // Repository loading admits immutable source snapshots before composition
  return immutableCatalogSnapshot(preview.proposed.catalogs[0]!)
}

async function fixture(text = '{"ID":"synthetic-sharing","Title":"Synthetic Sharing Mod","Jobs":[{"ID":24,"Name":"Synthetic Class","Description":"Private original description"}],"Equipment":[{"ID":10000,"Name":"Unselected Synthetic Item"}]}') {
  const source = await admittedModCatalog(text, 'mod.json')
  const catalogs = [...BUNDLED_CATALOGS, source]
  const composition = prepareModComposition({ version: 3, baseline: { catalogId: CURRENT_CATALOG.id, catalogRevisionId: CURRENT_CATALOG.revisionId }, layers: [{ catalogId: source.id, catalogRevisionId: source.revisionId, enabled: true }], links: [] }, catalogs)
  let data = addGameSetupRevision(createTestLocalData(), { label: 'Synthetic sharing', modComposition: composition, activate: true, now: TEST_NOW })
  const setup = data.gameSetups[data.planningGameSetupRevisionId!]!
  const buildId = asId<BuildId>('synthetic-build')
  data = createBuild(data, { id: buildId, title: 'Synthetic mod build', gameSetupId: setup.gameSetupId, now: TEST_NOW })
  const content = buildContentForModSetup({ primaryClass: { kind: 'catalog' as const, catalogId: source.id, catalogRevisionId: source.revisionId, entityId: Object.values(source.entities).find(entity => entity.kind === 'class')!.id }, secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [] }, setup, catalogs)
  data = saveBuildRevision(data, { buildId, gameSetupRevisionId: setup.id, content, now: TEST_NOW })
  data = { ...data, gameSetups: { ...data.gameSetups, [setup.id]: { ...setup, modSourceReceipts: modSourceReceipts(setup, catalogs) } } }
  const prepared = await prepareModCatalogs(data, catalogs)
  const revision = data.buildRevisions[data.builds[buildId]!.latestRevisionId!]!
  return { text, source, data, prepared, revision, setup: data.gameSetups[setup.id]! }
}

describe('modded Build source recovery', () => {
  it('shares selected receipts without private descriptions, indexes, or unselected entries', async () => {
    const { data, prepared, revision, source } = await fixture()
    expect(buildReferenceName(revision.content, revision.content.primaryClass)).toBe('Synthetic Class')
    const decoded = decodePublicSnapshot(encodePublicSnapshot(createPublicSnapshot({ planner: { localData: data, catalogs: prepared } }, { kind: 'build', revisionId: revision.id }, { includeNotes: false })))
    expect(decoded.receipts).toEqual([expect.objectContaining({ name: 'Synthetic Class', origin: expect.objectContaining({ projectId: source.id, modelKey: 'crystal-edit:Jobs:24' }) })])
    expect(JSON.stringify(decoded)).not.toMatch(/Private original description|Unselected Synthetic Item|Crystal Edit source record|data:image|rawDescription|crystalEditIdentities/)
    expect(decoded.setup.layers[0]).toMatchObject({ title: 'Synthetic Sharing Mod', contentFingerprint: expect.stringMatching(/^json-content-v1:sha256:/) })
  })

  it('requires complete source bodies even when saved private receipts remain', async () => {
    const { data } = await fixture(), before = JSON.stringify(data)
    await expect(prepareModCatalogs(data, BUNDLED_CATALOGS)).rejects.toThrow('unavailable catalog revision')
    expect(JSON.stringify(data)).toBe(before)
  })

  it('recovers formatting-equivalent sources without changing identity or interpretation', async () => {
    const { text, source, data, revision, setup } = await fixture()
    const reordered = JSON.stringify(JSON.parse(text), (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value, 2)
    const local = await admittedModCatalog(reordered, 'local.json'), before = JSON.stringify(data)
    expect(local).toEqual(source)
    const recovered = prepareLocalBuildModRecovery(revision.content, setup, [...BUNDLED_CATALOGS, local])
    expect(recovered.error).toBeUndefined()
    expect(recovered.changedInterpretation).toBe(false)
    expect(recovered.draft!.setup).toEqual(setup)
    const catalogs = await prepareModCatalogs(data, [...BUNDLED_CATALOGS, local])
    expect(resolveDefinition(data, catalogs, recovered.draft!.content.primaryClass!)?.name).toBe('Synthetic Class')
    expect(JSON.stringify(data)).toBe(before)
  })

  it('rejects different contents of the same declared project', async () => {
    const { text, data, revision, setup } = await fixture()
    const changed = await admittedModCatalog(text.replace('Synthetic Class', 'Changed Class'), 'changed.json')
    expect(modSourceMatch(setup.modSourceReceipts![0]!, changed)).toBeUndefined()
    const before = JSON.stringify(data), recovered = prepareLocalBuildModRecovery(revision.content, setup, [...BUNDLED_CATALOGS, changed])
    expect(recovered.draft).toBeUndefined()
    expect(recovered.missingSources).toEqual(['Synthetic Sharing Mod'])
    expect(JSON.stringify(data)).toBe(before)
  })

  it.each(['baseline', 'interpretation'] as const)('does not replace an unavailable %s with the packaged or parser default', async missing => {
    const { data, source, revision, setup } = await fixture()
    const composition = setup.modComposition!
    const changed = { ...setup, modComposition: { ...composition, ...(missing === 'baseline' ? { baseline: { ...composition.baseline, catalogRevisionId: 'v999' as never } } : { layers: composition.layers.map(layer => ({ ...layer, catalogRevisionId: layer.catalogRevisionId.replace(/-p1$/, '-p2') as never })) }) } }
    const before = structuredClone({ data, changed }), recovery = prepareLocalBuildModRecovery(revision.content, changed, [...BUNDLED_CATALOGS, source])
    expect(recovery.draft).toBeUndefined()
    expect(recovery.missingSources).toHaveLength(1)
    expect({ data, changed }).toEqual(before)
  })
})

it('preserves an exact native alias link and an explicit separate-definition choice during recovery', async () => {
  const { data, source, revision, setup } = await fixture('{"ID":"synthetic-sharing","Title":"Synthetic Sharing Mod","Jobs":[{"ID":24,"Name":"Synthetic Class"}],"Passives":[{"ID":20,"Name":"Synthetic learnable innate","PP":7,"IsInnate":true,"IsLearnable":true}]}')
  const alias = asId<EntityId>('base:innate:ref-53')
  const linked = { ...setup, modComposition: { ...setup.modComposition!, links: [{ modelKey: 'crystal-edit:Passives:20', targetEntityId: alias }] } }
  const ref: CatalogRef = { kind: 'catalog', catalogId: CURRENT_CATALOG.id, catalogRevisionId: modCatalogRevision(setup.id), entityId: alias }
  const content = { ...revision.content, passives: [{ ref }] }, before = structuredClone({ data, linked, content })
  const recovered = prepareLocalBuildModRecovery(content, linked, [...BUNDLED_CATALOGS, source]).draft!
  const preview = { ...data, gameSetups: { [recovered.setup.id]: recovered.setup } }, catalogs = await prepareModCatalogs(preview, [...BUNDLED_CATALOGS, source])
  expect(recovered.content.passives[0]!.ref).toEqual(ref)
  expect(resolveDefinition(preview, catalogs, ref)?.name).toBe('Synthetic learnable innate')
  expect(analyzeBuildEquipment(recovered.content, setup.slots, value => resolveDefinition(preview, catalogs, value)).some(issue => issue.code === 'PASSIVE_NOT_LEARNABLE')).toBe(false)
  const separate = { ...linked, modComposition: { ...linked.modComposition, links: [{ modelKey: 'crystal-edit:Passives:20', targetEntityId: null }] } }
  const native = { ...content, passives: [{ ref: { ...ref, entityId: asId<EntityId>('base:passive:20') } }] }
  expect(prepareLocalBuildModRecovery(native, separate, [...BUNDLED_CATALOGS, source]).draft!.content.passives).toEqual(native.passives)
  expect({ data, linked, content }).toEqual(before)
})
