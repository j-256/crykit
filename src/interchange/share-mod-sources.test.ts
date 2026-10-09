import { describe, expect, it } from 'vitest'
import { addGameSetupRevision, createBuild, saveBuildRevision, resolveDefinition } from '../domain'
import { asId, entityDefinitionKey } from '../domain/core'
import { buildModReferences } from '../domain/build-references'
import { buildContentForModSetup } from '../domain/build-mods'
import { buildReferenceName } from '../domain/build-reference-names'
import { prepareModComposition } from '../domain/mod-layers'
import { analyzeBuildEquipment } from '../domain/build-mechanics'
import { modSourceMatch } from '../domain/mod-source-match'
import { createTestLocalData, TEST_NOW } from '../domain/test-helpers'
import type { BuildId, EntityId } from '../domain/types'
import { BUNDLED_CATALOGS, CURRENT_CATALOG } from '../catalog/bundled'
import { prepareModCatalogs } from '../persistence/local-data'
import { validateNativeLocalDataGraph } from './native'
import { previewCrystalEdit } from './crystal-edit'
import { createSharePayload, decodeSharePayload, encodeSharePayload, saveSharedCopy, sharePreviewData, shareWithMatchingSources } from './share'
import { prepareSharedModRecovery } from './share-mod-recovery'

async function fixture(text = '{"ID":"synthetic-sharing","Title":"Synthetic Sharing Mod","Jobs":[{"ID":24,"Name":"Synthetic Class","Description":"Private original description"}],"Equipment":[{"ID":10000,"Name":"Unselected Synthetic Item"}]}') {
  const source = (await previewCrystalEdit(new TextEncoder().encode(text), 'mod.json', TEST_NOW)).proposed.catalogs[0]!
  const catalogs = [...BUNDLED_CATALOGS, source]
  const composition = prepareModComposition({ version: 3, baseline: { catalogId: CURRENT_CATALOG.id, catalogRevisionId: CURRENT_CATALOG.revisionId }, layers: [{ catalogId: source.id, catalogRevisionId: source.revisionId, enabled: true }], links: [] }, catalogs)
  let data = addGameSetupRevision(createTestLocalData(), { label: 'Synthetic sharing', modComposition: composition, activate: true, now: TEST_NOW })
  const setup = data.gameSetups[data.planningGameSetupRevisionId!]!
  const buildId = asId<BuildId>('synthetic-build')
  data = createBuild(data, { id: buildId, title: 'Synthetic mod build', gameSetupId: setup.gameSetupId, now: TEST_NOW })
  const content = buildContentForModSetup({ primaryClass: { kind: 'catalog' as const, catalogId: source.id, catalogRevisionId: source.revisionId, entityId: Object.values(source.entities).find(entity => entity.kind === 'class')!.id }, secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [] }, setup, catalogs)
  data = saveBuildRevision(data, { buildId, gameSetupRevisionId: setup.id, content, now: TEST_NOW })
  const prepared = await prepareModCatalogs(data, catalogs)
  const payload = createSharePayload(data, { kind: 'build', revisionId: data.builds[buildId]!.latestRevisionId! }, false, prepared)
  return { text, source, data, prepared, payload }
}

describe('portable modded Build snapshots', () => {
  it('shares selected display receipts and source identities without any full records, descriptions, or unselected entries', async () => {
    const { payload, data } = await fixture()
    const stored = Object.values(data.buildRevisions)[0]!
    expect(buildReferenceName(stored.content, stored.content.primaryClass)).toBe('Synthetic Class')
    const decoded = decodeSharePayload(encodeSharePayload(payload))
    const revision = Object.values(decoded.records.buildRevisions)[0]!
    expect(buildReferenceName(revision.content, revision.content.primaryClass)).toBe('Synthetic Class')
    expect(revision.content.referenceNames).toEqual([{ ref: revision.content.primaryClass, name: 'Synthetic Class', projectId: 'crystal-edit:synthetic-sharing', modelKey: 'crystal-edit:Jobs:24' }])
    expect(JSON.stringify(decoded)).not.toMatch(/Private original description|Unselected Synthetic Item|Crystal Edit source record|data:image|rawDescription/)
    expect(Object.values(decoded.records.gameSetups)[0]!.modSourceReceipts?.[0]).toMatchObject({ title: 'Synthetic Sharing Mod', contentFingerprint: expect.stringMatching(/^json-content-v1:sha256:/) })
  })

  it('opens and copies a declared missing source without substituting definitions, while rejecting unrelated gaps', async () => {
    const { payload } = await fixture()
    const preview = sharePreviewData(payload)
    validateNativeLocalDataGraph(preview, await prepareModCatalogs(preview, BUNDLED_CATALOGS))
    const copy = saveSharedCopy(createTestLocalData(), payload).localData
    validateNativeLocalDataGraph(copy, await prepareModCatalogs(copy, BUNDLED_CATALOGS))
    const noReceipts = { ...preview, gameSetups: Object.fromEntries(Object.entries(preview.gameSetups).map(([id, { modSourceReceipts: _receipts, ...setup }]) => [id, setup])) }
    await expect(prepareModCatalogs(noReceipts, BUNDLED_CATALOGS)).rejects.toThrow('unavailable catalog revision')
  })

  it('applies equivalent content using local file pins and preserves the original shared checkpoint', async () => {
    const { payload, text, source } = await fixture()
    const reordered = JSON.stringify(JSON.parse(text), (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value, 2)
    const local = (await previewCrystalEdit(new TextEncoder().encode(reordered), 'local.json', TEST_NOW)).proposed.catalogs[0]!
    const original = JSON.stringify(payload)
    expect(local.checksum).not.toBe(source.checksum)
    const matching = shareWithMatchingSources(payload, [...BUNDLED_CATALOGS, local])!
    expect(matching).toBeDefined()
    const preview = sharePreviewData(matching)
    const catalogs = await prepareModCatalogs(preview, [...BUNDLED_CATALOGS, local])
    validateNativeLocalDataGraph(preview, catalogs)
    const revision = Object.values(preview.buildRevisions)[0]!
    expect(resolveDefinition(preview, catalogs, revision.content.primaryClass!)?.name).toBe('Synthetic Class')
    expect(Object.values(preview.gameSetups)[0]!.modComposition!.layers[0]!.catalogRevisionId).toBe(local.revisionId)
    const copy = saveSharedCopy(createTestLocalData(), matching).localData
    validateNativeLocalDataGraph(copy, await prepareModCatalogs(copy, [...BUNDLED_CATALOGS, local]))
    expect(JSON.stringify(payload)).toBe(original)
  })

  it('rejects changed source content and keeps older parser revisions unresolved', async () => {
    const { payload, text, source } = await fixture()
    const changed = (await previewCrystalEdit(new TextEncoder().encode(text.replace('Synthetic Class', 'Changed Class')), 'changed.json', TEST_NOW)).proposed.catalogs[0]!
    const receipt = Object.values(payload.records.gameSetups)[0]!.modSourceReceipts![0]!
    expect(modSourceMatch(receipt, changed)).toBeUndefined()
    expect(shareWithMatchingSources(payload, [...BUNDLED_CATALOGS, changed])).toBeUndefined()
    const old = JSON.parse(JSON.stringify(payload).replaceAll('library-v4', 'library-v2'))
    expect(shareWithMatchingSources(old, [...BUNDLED_CATALOGS, source])).toBeUndefined()
  })

  it('recovers an older interpretation and withdrawn baseline through exact selected model identities', async () => {
    const { payload, source } = await fixture()
    const old = JSON.parse(JSON.stringify(payload).replaceAll('library-v4', 'library-v2').replaceAll('catalog-v3', 'catalog-v1'))
    const oldSetup = Object.values(old.records.gameSetups)[0] as typeof payload.records.gameSetups[string]
    const original = JSON.stringify(old)
    const recovery = prepareSharedModRecovery(old, [...BUNDLED_CATALOGS, source])
    expect(recovery.error).toBeUndefined()
    expect(recovery.changedInterpretation).toBe(true)
    expect(recovery.missingSources).toEqual([])
    const recovered = recovery.payload!
    const preview = sharePreviewData(recovered)
    const catalogs = await prepareModCatalogs(preview, [...BUNDLED_CATALOGS, source])
    validateNativeLocalDataGraph(preview, catalogs)
    const setup = Object.values(preview.gameSetups)[0]!
    expect(setup.id).not.toBe(oldSetup.id)
    expect(setup.modComposition!.baseline.catalogRevisionId).toBe(CURRENT_CATALOG.revisionId)
    expect(setup.modComposition!.layers[0]!.catalogRevisionId).toBe(source.revisionId)
    const revision = Object.values(preview.buildRevisions)[0]!
    expect(resolveDefinition(preview, catalogs, revision.content.primaryClass!)?.name).toBe('Synthetic Class')
    const copy = saveSharedCopy(createTestLocalData(), recovered).localData
    validateNativeLocalDataGraph(copy, await prepareModCatalogs(copy, [...BUNDLED_CATALOGS, source]))
    expect(JSON.stringify(old)).toBe(original)
  })

  it('reports remaining uploads, unsupported baselines, and unresolved model identities without throwing', async () => {
    const { payload, source } = await fixture()
    const old = JSON.parse(JSON.stringify(payload).replaceAll('library-v4', 'library-v2').replaceAll('catalog-v3', 'catalog-v1'))
    expect(prepareSharedModRecovery(old, BUNDLED_CATALOGS)).toEqual({ missingSources: ['Synthetic Sharing Mod'] })
    const unknown = JSON.parse(JSON.stringify(old).replaceAll('catalog-v1', 'unreviewed-baseline'))
    expect(prepareSharedModRecovery(unknown, [...BUNDLED_CATALOGS, source]).error).toContain('no supported replacement')
    const revision = Object.values(old.records.buildRevisions)[0] as typeof payload.records.buildRevisions[string]
    old.records.buildRevisions[revision.id].content.referenceNames[0].modelKey = 'crystal-edit:Jobs:65535'
    const failed = prepareSharedModRecovery(old, [...BUNDLED_CATALOGS, source])
    expect(failed.payload).toBeUndefined()
    expect(failed.error).toContain('cannot resolve Synthetic Class')
  })

  it('uses exact native identity to recover an innate replacement linked through a reference alias', async () => {
    const { payload, source } = await fixture('{"ID":"synthetic-sharing","Title":"Synthetic Sharing Mod","Jobs":[{"ID":24,"Name":"Synthetic Class"}],"Passives":[{"ID":20,"Name":"Synthetic learnable innate","PP":7,"IsInnate":true,"IsLearnable":true}]}')
    const old = JSON.parse(JSON.stringify(payload).replaceAll('library-v4', 'library-v2').replaceAll('catalog-v3', 'catalog-v1'))
    const setup = Object.values(old.records.gameSetups)[0] as typeof payload.records.gameSetups[string]
    const revision = Object.values(old.records.buildRevisions)[0] as typeof payload.records.buildRevisions[string]
    const alias = asId<EntityId>('base:innate:ref-53')
    old.records.gameSetups[setup.id].modComposition.links = [{ modelKey: 'crystal-edit:Passives:20', targetEntityId: alias }]
    old.records.buildRevisions[revision.id].content.passives = [{ ref: { ...revision.content.primaryClass, entityId: 'base:passive:20' } }]
    const original = JSON.stringify(old)
    const recovered = prepareSharedModRecovery(old, [...BUNDLED_CATALOGS, source]).payload!
    const preview = sharePreviewData(recovered)
    const catalogs = await prepareModCatalogs(preview, [...BUNDLED_CATALOGS, source])
    validateNativeLocalDataGraph(preview, catalogs)
    const recoveredRevision = Object.values(preview.buildRevisions)[0]!
    const selection = recoveredRevision.content.passives[0]!.ref
    expect(selection).toMatchObject({ entityId: alias })
    expect(resolveDefinition(preview, catalogs, selection)?.name).toBe('Synthetic learnable innate')
    expect(analyzeBuildEquipment(recoveredRevision.content, setup.slots, ref => resolveDefinition(preview, catalogs, ref)).some(issue => issue.code === 'PASSIVE_NOT_LEARNABLE')).toBe(false)
    expect(JSON.stringify(old)).toBe(original)
    old.records.gameSetups[setup.id].modComposition.links[0].targetEntityId = null
    const separate = prepareSharedModRecovery(old, [...BUNDLED_CATALOGS, source]).payload!
    expect(Object.values(separate.records.buildRevisions)[0]!.content.passives[0]!.ref).toMatchObject({ entityId: 'base:passive:20' })
  })

  it('does not let display receipts introduce unselected or duplicate definitions', async () => {
    const { payload } = await fixture()
    const revision = Object.values(payload.records.buildRevisions)[0]!
    const selected = new Set(buildModReferences(revision.content).map(entityDefinitionKey))
    expect(revision.content.referenceNames!.every(entry => selected.has(entityDefinitionKey(entry.ref)))).toBe(true)
    const bad = { ...revision, content: { ...revision.content, referenceNames: [{ ...revision.content.referenceNames![0]!, ref: { ...revision.content.referenceNames![0]!.ref, entityId: asId<EntityId>('unselected') } }] } }
    expect(() => encodeSharePayload({ ...payload, records: { ...payload.records, buildRevisions: { [bad.id]: bad } } })).toThrow('selected entry')
    const duplicate = { ...revision, content: { ...revision.content, referenceNames: [...revision.content.referenceNames!, ...revision.content.referenceNames!] } }
    expect(() => encodeSharePayload({ ...payload, records: { ...payload.records, buildRevisions: { [duplicate.id]: duplicate } } })).toThrow('selected entry')
  })
})
