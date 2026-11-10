import { describe, expect, it } from 'vitest'
import { addGameSetupRevision, createBuild, saveBuildRevision, resolveDefinition } from '../domain'
import { asId } from '../domain/core'
import { buildContentForModSetup } from '../domain/build-mods'
import { buildReferenceName, modSourceReceipts } from '../domain/build-reference-names'
import { prepareModComposition } from '../domain/mod-layers'
import { analyzeBuildEquipment } from '../domain/build-mechanics'
import { modSourceMatch } from '../domain/mod-source-match'
import { createTestLocalData, TEST_NOW } from '../domain/test-helpers'
import type { BuildId, CatalogRef, EntityId, LocalData } from '../domain/types'
import { BUNDLED_CATALOGS, CURRENT_CATALOG } from '../catalog/bundled'
import { prepareModCatalogs } from '../persistence/local-data'
import { immutableCatalogSnapshot, validateNativeLocalDataGraph } from './native'
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

// Older saved workspaces retain their original parser and application baseline pins
function historical(data: LocalData): LocalData {
  return JSON.parse(JSON.stringify(data).replaceAll('library-v4', 'library-v2').replaceAll('catalog-v3', 'catalog-v1')) as LocalData
}
function selected(data: LocalData) {
  const revision = data.buildRevisions[data.builds['synthetic-build']!.latestRevisionId!]!
  return { revision, setup: data.gameSetups[revision.gameSetupRevisionId]! }
}

describe('modded Build source recovery', () => {
  it('shares selected display receipts and source identities without full records, descriptions, or unselected entries', async () => {
    const { data, prepared, revision } = await fixture()
    expect(buildReferenceName(revision.content, revision.content.primaryClass)).toBe('Synthetic Class')
    const snapshot = createPublicSnapshot({ planner: { localData: data, catalogs: prepared } }, { kind: 'build', revisionId: revision.id }, { includeNotes: false })
    const decoded = decodePublicSnapshot(encodePublicSnapshot(snapshot))
    expect(decoded.receipts).toEqual([expect.objectContaining({ name: 'Synthetic Class', origin: expect.objectContaining({ projectId: 'crystal-edit:synthetic-sharing', modelKey: 'crystal-edit:Jobs:24' }) })])
    expect(JSON.stringify(decoded)).not.toMatch(/Private original description|Unselected Synthetic Item|Crystal Edit source record|data:image|rawDescription/)
    expect(decoded.setup.layers[0]).toMatchObject({ title: 'Synthetic Sharing Mod', contentFingerprint: expect.stringMatching(/^json-content-v1:sha256:/) })
  })

  it('reopens declared missing sources without substituting definitions and rejects unrelated gaps', async () => {
    const { data, revision } = await fixture()
    const reopened = JSON.parse(JSON.stringify(data)) as LocalData
    const catalogs = await prepareModCatalogs(reopened, BUNDLED_CATALOGS)
    validateNativeLocalDataGraph(reopened, catalogs)
    expect(resolveDefinition(reopened, catalogs, revision.content.primaryClass!)).toBeUndefined()
    const noReceipts = { ...reopened, gameSetups: Object.fromEntries(Object.entries(reopened.gameSetups).map(([id, { modSourceReceipts: _receipts, ...setup }]) => [id, setup])) }
    await expect(prepareModCatalogs(noReceipts, BUNDLED_CATALOGS)).rejects.toThrow('unavailable catalog revision')
  })

  it('applies equivalent source content using local file pins and preserves the saved checkpoint', async () => {
    const { text, source, data, revision, setup } = await fixture()
    const reordered = JSON.stringify(JSON.parse(text), (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value, 2)
    const local = await admittedModCatalog(reordered, 'local.json')
    const original = JSON.stringify(data)
    expect(local.checksum).not.toBe(source.checksum)
    const recovered = prepareLocalBuildModRecovery(revision.content, setup, [...BUNDLED_CATALOGS, local])
    expect(recovered.error).toBeUndefined()
    expect(recovered.draft!.setup.modComposition!.layers[0]!.catalogRevisionId).toBe(local.revisionId)
    const preview = { ...data, gameSetups: { [recovered.draft!.setup.id]: recovered.draft!.setup } }
    const catalogs = await prepareModCatalogs(preview, [...BUNDLED_CATALOGS, local])
    expect(resolveDefinition(preview, catalogs, recovered.draft!.content.primaryClass!)?.name).toBe('Synthetic Class')
    expect(JSON.stringify(data)).toBe(original)
  })

  it('rejects changed source content instead of substituting a same-name project', async () => {
    const { text, data, revision, setup } = await fixture()
    const changed = await admittedModCatalog(text.replace('Synthetic Class', 'Changed Class'), 'changed.json')
    expect(modSourceMatch(setup.modSourceReceipts![0]!, changed)).toBeUndefined()
    const original = JSON.stringify(data)
    const recovered = prepareLocalBuildModRecovery(revision.content, setup, [...BUNDLED_CATALOGS, changed])
    expect(recovered.draft).toBeUndefined()
    expect(recovered.missingSources).toEqual(['Synthetic Sharing Mod'])
    expect(JSON.stringify(data)).toBe(original)
  })

  it('recovers an older interpretation and withdrawn baseline through exact selected model identities', async () => {
    const { data, source } = await fixture()
    const old = historical(data), { revision, setup } = selected(old)
    const original = JSON.stringify(old)
    const recovery = prepareLocalBuildModRecovery(revision.content, setup, [...BUNDLED_CATALOGS, source])
    expect(recovery.error).toBeUndefined()
    expect(recovery.changedInterpretation).toBe(true)
    expect(recovery.missingSources).toEqual([])
    const draft = recovery.draft!
    expect(draft.setup.id).not.toBe(setup.id)
    expect(draft.setup.modComposition!.baseline.catalogRevisionId).toBe(CURRENT_CATALOG.revisionId)
    expect(draft.setup.modComposition!.layers[0]!.catalogRevisionId).toBe(source.revisionId)
    const preview = { ...old, gameSetups: { [draft.setup.id]: draft.setup } }
    const catalogs = await prepareModCatalogs(preview, [...BUNDLED_CATALOGS, source])
    expect(resolveDefinition(preview, catalogs, draft.content.primaryClass!)?.name).toBe('Synthetic Class')
    expect(JSON.stringify(old)).toBe(original)
  })

  it('reports remaining uploads, unsupported baselines, and unresolved model identities without throwing', async () => {
    const { data, source } = await fixture()
    const old = historical(data), { revision, setup } = selected(old)
    expect(prepareLocalBuildModRecovery(revision.content, setup, BUNDLED_CATALOGS)).toEqual({ missingSources: ['Synthetic Sharing Mod'] })
    const unknown = JSON.parse(JSON.stringify(setup).replaceAll('catalog-v1', 'unreviewed-baseline')) as typeof setup
    expect(prepareLocalBuildModRecovery(revision.content, unknown, [...BUNDLED_CATALOGS, source]).error).toContain('no supported replacement')
    const broken = { ...revision.content, referenceNames: revision.content.referenceNames!.map(entry => ({ ...entry, modelKey: 'crystal-edit:Jobs:65535' })) }
    const failed = prepareLocalBuildModRecovery(broken, setup, [...BUNDLED_CATALOGS, source])
    expect(failed.draft).toBeUndefined()
    expect(failed.error).toContain('cannot resolve Synthetic Class')
  })

  it('uses exact native identity to recover an innate replacement linked through a reference alias', async () => {
    const { data, source } = await fixture('{"ID":"synthetic-sharing","Title":"Synthetic Sharing Mod","Jobs":[{"ID":24,"Name":"Synthetic Class"}],"Passives":[{"ID":20,"Name":"Synthetic learnable innate","PP":7,"IsInnate":true,"IsLearnable":true}]}')
    const old = historical(data), { revision, setup } = selected(old)
    const alias = asId<EntityId>('base:innate:ref-53')
    const linked = { ...setup, modComposition: { ...setup.modComposition!, links: [{ modelKey: 'crystal-edit:Passives:20', targetEntityId: alias }] } }
    const content = { ...revision.content, passives: [{ ref: { ...revision.content.primaryClass as CatalogRef, entityId: asId<EntityId>('base:passive:20') } }] }
    const original = JSON.stringify({ old, linked, content })
    const recovered = prepareLocalBuildModRecovery(content, linked, [...BUNDLED_CATALOGS, source]).draft!
    const preview = { ...old, gameSetups: { [recovered.setup.id]: recovered.setup } }
    const catalogs = await prepareModCatalogs(preview, [...BUNDLED_CATALOGS, source])
    const selection = recovered.content.passives[0]!.ref
    expect(selection).toMatchObject({ entityId: alias })
    expect(resolveDefinition(preview, catalogs, selection)?.name).toBe('Synthetic learnable innate')
    expect(analyzeBuildEquipment(recovered.content, setup.slots, ref => resolveDefinition(preview, catalogs, ref)).some(issue => issue.code === 'PASSIVE_NOT_LEARNABLE')).toBe(false)
    expect(JSON.stringify({ old, linked, content })).toBe(original)
    const separate = prepareLocalBuildModRecovery(content, { ...linked, modComposition: { ...linked.modComposition, links: [{ modelKey: 'crystal-edit:Passives:20', targetEntityId: null }] } }, [...BUNDLED_CATALOGS, source]).draft!
    expect(separate.content.passives[0]!.ref).toMatchObject({ entityId: 'base:passive:20' })
  })
})
