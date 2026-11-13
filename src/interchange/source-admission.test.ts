import { SOURCE_REVISION_RECEIPTS } from '../catalog/source-revisions'
import { expect, it, vi } from 'vitest'
import { CURRENT_CATALOG } from '../catalog/bundled'
import { createBlankLocalData, addGameSetupRevision } from '../domain/local-data'
import { validateNativeLocalDataGraph } from './native'
import { previewCrystalEdit } from './crystal-edit'
import { composeModCatalog } from '../domain/mod-layers'
import { prepareModCatalogs } from '../persistence/local-data'

vi.mock('../catalog/source-revisions', async importOriginal => {
  const actual = await importOriginal<typeof import('../catalog/source-revisions')>()
  return { ...actual, SOURCE_REVISION_RECEIPTS: [...actual.SOURCE_REVISION_RECEIPTS] }
})

it('rejects forged complete source bodies and prelaunch identities at native admission', () => {
  const local = createBlankLocalData()
  expect(() => validateNativeLocalDataGraph(local, [CURRENT_CATALOG])).not.toThrow()
  expect(() => validateNativeLocalDataGraph(local, [{ ...CURRENT_CATALOG, entities: {} }])).toThrow(/source payload/i)
  expect(() => validateNativeLocalDataGraph(local, [{ ...CURRENT_CATALOG, id: 'crystal-project-public-starter' as typeof CURRENT_CATALOG.id }])).toThrow(/source payload/i)
  const oldPin = addGameSetupRevision(local, { label: 'Prelaunch pin', catalogLock: { 'crystal-project-public-starter': 'catalog-v1' as typeof CURRENT_CATALOG.revisionId } })
  expect(() => validateNativeLocalDataGraph(oldPin, [])).toThrow(/missing catalog revision/i)
})

it('retains the complete composition receipt and requires exact changed-record contributors', async () => {
  const source = (await previewCrystalEdit(new TextEncoder().encode(JSON.stringify({ ID: 'Synthetic saved source', EditorVersion: 34, Equipment: [{ ID: 3, Name: 'Changed synthetic record' }] })), 'synthetic.json')).proposed.catalogs[0]!
  const sources = [CURRENT_CATALOG, source]
  const local = addGameSetupRevision(createBlankLocalData(), { label: 'Synthetic saved composition', modComposition: { baseline: { catalogId: CURRENT_CATALOG.id, catalogRevisionId: CURRENT_CATALOG.revisionId }, layers: [{ catalogId: source.id, catalogRevisionId: source.revisionId, enabled: true }], links: [] } })
  const expected = composeModCatalog(local.gameSetups[local.planningGameSetupRevisionId!]!, sources)!
  const prepared = await prepareModCatalogs(local, sources)
  expect(prepared.at(-1)!.checksum).toBe(expected.checksum)
  expect(() => validateNativeLocalDataGraph(local, prepared)).not.toThrow()
  const changed = Object.values(expected.entities)[0]!
  const { origins: _origins, ...missingOrigins } = changed
  expect(() => validateNativeLocalDataGraph(local, [...sources, { ...expected, entities: { [changed.id]: missingOrigins } }])).toThrow(/pinned source layers/i)
  expect(() => validateNativeLocalDataGraph(local, [...sources, { ...expected, checksum: 'composition:sha256:' + '0'.repeat(64) }])).toThrow(/pinned source layers/i)
})

it('retains the requested source identity when an exact bundled payload supplies an imported pin', async () => {
  const source = (await previewCrystalEdit(new TextEncoder().encode('{"ID":"Synthetic distributed source","EditorVersion":34,"Items":[]}'), 'synthetic.json')).proposed.catalogs[0]!
  const bundled = { ...source, id: 'crystal-project/mod/synthetic-distribution' as never, revisionId: 'v1' as never, payloadSource: { catalogId: source.id, catalogRevisionId: source.revisionId } }
  const registry = SOURCE_REVISION_RECEIPTS as Array<typeof SOURCE_REVISION_RECEIPTS[number]>
  registry.push({ id: bundled.id, revisionId: bundled.revisionId, checksum: bundled.checksum, payloadSource: bundled.payloadSource })
  try {
    const local = addGameSetupRevision(createBlankLocalData(), { label: 'Synthetic distribution', modComposition: { baseline: { catalogId: CURRENT_CATALOG.id, catalogRevisionId: CURRENT_CATALOG.revisionId }, layers: [{ catalogId: source.id, catalogRevisionId: source.revisionId, enabled: true }], links: [] } })
    const prepared = await prepareModCatalogs(local, [CURRENT_CATALOG, bundled])
    expect(prepared.find(value => value.id === source.id && value.revisionId === source.revisionId)).toEqual(source)
    expect(() => validateNativeLocalDataGraph(local, prepared)).not.toThrow()
  } finally { registry.pop() }
})

it('does not use a display receipt to excuse a missing private source body', async () => {
  const source = (await previewCrystalEdit(new TextEncoder().encode('{"ID":"Synthetic missing private body","EditorVersion":34,"Items":[]}'), 'synthetic.json')).proposed.catalogs[0]!
  const local = addGameSetupRevision(createBlankLocalData(), { label: 'Saved source', modComposition: { baseline: { catalogId: CURRENT_CATALOG.id, catalogRevisionId: CURRENT_CATALOG.revisionId }, layers: [{ catalogId: source.id, catalogRevisionId: source.revisionId, enabled: true }], links: [] } })
  const setupId = local.planningGameSetupRevisionId!
  const receipt = { catalogId: source.id, catalogRevisionId: source.revisionId, checksum: source.checksum, title: 'Display name', contentFingerprint: (source.legacy as Record<string, string>).contentFingerprint }
  const data = { ...local, gameSetups: { ...local.gameSetups, [setupId]: { ...local.gameSetups[setupId]!, modSourceReceipts: [receipt] } } }
  const complete = await prepareModCatalogs(data, [CURRENT_CATALOG, source])
  expect(() => validateNativeLocalDataGraph(data, complete)).not.toThrow()
  expect(() => validateNativeLocalDataGraph(data, complete.filter(value => value.id !== source.id))).toThrow(/unavailable catalog revision/)
})
