import { describe, expect, it, vi } from 'vitest'
import { createSampleLocalData } from '../domain/sample-data'
import { BUNDLED_CATALOGS } from '../catalog/bundled'
import { assembleWorkspace, splitWorkspace, type WorkspaceState } from './documents'
import { memoryBlob, readBlob, verifiedBlob } from './blobs'
import { encodeWorkspaceDocument, decodeWorkspaceDocument } from './document-codec'

export function sampleWorkspace(): WorkspaceState {
  const localData = createSampleLocalData(BUNDLED_CATALOGS[0])
  return { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: BUNDLED_CATALOGS, evidence: [], sources: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], libraryDefaults: { version: 1, layers: [] }, conflicts: [], retainedContent: [], blobs: [] }
}

describe('independent private records', () => {
  it('roundTripsEveryPlannerRecordAndSourceClosure', () => {
    const original = sampleWorkspace()
    const documents = splitWorkspace(original)
    const roundTrip = assembleWorkspace(documents, 27)
    expect(roundTrip.planner.localData.buildRevisions).toEqual(original.planner.localData.buildRevisions)
    expect(roundTrip.planner.sources).toEqual(original.planner.sources)
    expect(roundTrip.planner.history).toEqual(original.planner.history)
    expect(roundTrip.planner.catalogs).toBe(BUNDLED_CATALOGS)
    expect(roundTrip.planner.localData.revision).toBe(27)
    expect(Object.keys(roundTrip.planner.localData.playthroughs)).toEqual(Object.keys(original.planner.localData.playthroughs))
    expect(documents.some(document => document.kind === 'character')).toBe(true)
    expect(documents.some(document => document.kind === 'inventory')).toBe(true)
  })
  it('doesNotSyncBrowserSelections', () => {
    const liveProjectionDocuments = splitWorkspace(sampleWorkspace()).filter(document => ['workspace-identity', 'playthrough', 'workspace-preferences'].includes(document.kind))
    const serialized = JSON.stringify(liveProjectionDocuments)
    expect(serialized).not.toContain('selectedPlaythroughId')
    expect(serialized).not.toContain('activeScenarioId')
    expect(serialized).not.toContain('planningGameSetupRevisionId')
  })
  it('rejects missing identity and duplicate private keys', () => {
    const documents = splitWorkspace(sampleWorkspace())
    expect(() => assembleWorkspace(documents.filter(document => document.kind !== 'workspace-identity'), 0)).toThrow()
    expect(() => assembleWorkspace([...documents, documents[0]], 0)).toThrow()
  })
  it.each(['reordered', 'copied'] as const)('preserves the exact %s catalog membership during assembly', mode => {
    const original = sampleWorkspace()
    const catalogs = mode === 'reordered' ? [...BUNDLED_CATALOGS].reverse() : structuredClone(BUNDLED_CATALOGS)
    const documents = splitWorkspace({ ...original, planner: { ...original.planner, catalogs } })
    const loaded = assembleWorkspace(documents, 0).planner.catalogs
    expect(loaded).not.toBe(BUNDLED_CATALOGS)
    expect(loaded).toEqual(catalogs)
    expect(loaded.every((catalog, index) => catalog === catalogs[index])).toBe(true)
  })
  it('rejects invalid catalog references even when a copied catalog claims the bundled identity', () => {
    const original = sampleWorkspace()
    assembleWorkspace(splitWorkspace(original), 0)
    const changed = { ...BUNDLED_CATALOGS[0], claims: [{ entityId: 'synthetic-missing' as never, field: 'name', value: { state: 'known' as const, value: 'Synthetic missing entity' }, sources: [] }] }
    const documents = splitWorkspace(original).map(document => document.kind === 'catalog' && Object.is(document.value, BUNDLED_CATALOGS[0]) ? { ...document, value: changed as never } : document)
    expect(() => assembleWorkspace(documents, 0)).toThrow('unknown entity')
  })
  it('preserves binary frames and rejects trailing or truncated bytes', async () => {
    const value = memoryBlob(new Uint8Array([0, 255, 128, 7]))
    const frame = await readBlob({ byteLength: 1_000_000, open: () => encodeWorkspaceDocument({ version: 1, kind: 'blob', key: 'blob/test', value }) }, 1_000_000, false)
    const decoded = await decodeWorkspaceDocument(memoryBlob(frame))
    expect(await readBlob(decoded.value as typeof value, 4)).toEqual(new Uint8Array([0, 255, 128, 7]))
    await expect(decodeWorkspaceDocument(memoryBlob(frame.slice(0, -1)))).rejects.toThrow()
    await expect(decodeWorkspaceDocument(memoryBlob(new Uint8Array([...frame, 0])))).rejects.toThrow()
  })
})

it('preserves exact historical selectors and source originals while excluding live selectors', async () => {
  const { sha256 } = await import('../interchange/util')
  const original = sampleWorkspace()
  const bytes = new Uint8Array([0, 255, 11, 0])
  const digest = await sha256(bytes)
  const ref = { documentId: 'source-body', revisionId: 'source-original', byteLength: bytes.length, sha256: digest, encoding: 'bytes' as const }
  const history = [{ id: 'history-1', localDataId: original.planner.localData.id, command: 'synthetic-history', previousRevision: 0, nextRevision: 1, before: original.planner.localData, after: { ...original.planner.localData, revision: 1 }, recordedAt: original.planner.localData.updatedAt }]
  const state: WorkspaceState = { ...original, planner: { ...original.planner, history, sources: [{ id: 'source-1', digest, filename: 'inert.json', mediaType: 'application/json', format: 'crystal-edit-json-1', importedAt: original.planner.localData.createdAt, original: ref }] }, blobs: [{ ref, content: memoryBlob(bytes) }] }
  const documents = splitWorkspace(state)
  const loaded = assembleWorkspace(documents, 90)
  expect(loaded.planner.history).toEqual(history)
  expect(loaded.planner.sources).toEqual(state.planner.sources)
  expect(await readBlob(loaded.blobs[0].content, 4)).toEqual(bytes)
  expect(loaded.planner.localData.selectedPlaythroughId).toBeUndefined()
  expect(loaded.planner.localData.planningGameSetupRevisionId).toBeUndefined()
  expect(JSON.stringify(documents.filter(document => document.kind !== 'history'))).not.toContain('selectedPlaythroughId')
})
it('rejects unsupported envelope versions, unknown fields and missing exact source refs', async () => {
  const { validateWorkspace } = await import('./validation')
  expect(() => validateWorkspace({ ...sampleWorkspace(), password: 'not-a-container-field' } as WorkspaceState)).toThrow()
  const documents = splitWorkspace(sampleWorkspace())
  expect(() => assembleWorkspace(documents.map((document, i) => i ? document : { ...document, version: 2 as 1 }), 0)).toThrow()
})
it('validates a large framed binary stream without materializing it and reopens identical bytes', async () => {
  const bodyBytes = 9 * 1024 * 1024
  let opens = 0
  const body = { byteLength: bodyBytes, async *open() { opens++; for (let i = 0; i < bodyBytes; i += 65536) yield new Uint8Array(65536).fill(47) } }
  const document = { version: 1 as const, kind: 'blob' as const, key: 'large', value: body }
  let frameLength = 0
  for await (const chunk of encodeWorkspaceDocument(document)) frameLength += chunk.length
  const source = { byteLength: frameLength, open: () => encodeWorkspaceDocument(document) }
  const decoded = await decodeWorkspaceDocument(source)
  expect(opens).toBe(2)
  const { hashBlob } = await import('./blobs')
  expect(await hashBlob(decoded.value as typeof body)).toBe(await hashBlob(body))
  expect(await hashBlob(decoded.value as typeof body)).toBe(await hashBlob(body))
})

it('decodes JSON during its complete frame scan without reopening the source', async () => {
  const value = { text: 'Exact \u2603 value', unknown: null, ordered: [3, 1] }
  const frame = await readBlob({ byteLength: 1_000_000, open: () => encodeWorkspaceDocument({ version: 1, kind: 'library-defaults', key: 'json-scan', value }) }, 1_000_000, false)
  let opens = 0
  const source = { byteLength: frame.length, async *open() { opens++; for (const byte of frame) yield new Uint8Array([byte]) } }
  expect((await decodeWorkspaceDocument(source)).value).toEqual(value)
  expect(opens).toBe(1)
})

it('does not expose JSON before complete frame and digest verification', async () => {
  const frame = await readBlob({ byteLength: 1_000_000, open: () => encodeWorkspaceDocument({ version: 1, kind: 'library-defaults', key: 'json-eof', value: { private: 'retained' } }) }, 1_000_000, false)
  const verified = vi.fn()
  await expect(decodeWorkspaceDocument(memoryBlob(frame.slice(0, -1)), verified)).rejects.toThrow()
  await expect(decodeWorkspaceDocument(memoryBlob(new Uint8Array([...frame, 0])), verified)).rejects.toThrow()
  await expect(decodeWorkspaceDocument(verifiedBlob(memoryBlob(frame), '0'.repeat(64)), verified)).rejects.toThrow(/digest mismatch/)
  expect(verified).not.toHaveBeenCalled()
  await decodeWorkspaceDocument(memoryBlob(frame), verified)
  expect(verified).toHaveBeenCalledExactlyOnceWith()
  // Complete frame bytes can still contain unsafe JSON; verification must not imply parsing or admission
  const unsafe = await readBlob({ byteLength: 1_000_000, open: () => encodeWorkspaceDocument({ version: 1, kind: 'library-defaults', key: 'json-unsafe', value: { constructor: 'inert' } }) }, 1_000_000, false)
  verified.mockClear()
  await expect(decodeWorkspaceDocument(memoryBlob(unsafe), verified)).rejects.toThrow(/unsafe object key/)
  expect(verified).toHaveBeenCalledExactlyOnceWith()
})

it('rejects operative selectors and identity mismatches in live remote records', () => {
  const records = splitWorkspace(sampleWorkspace())
  const identity = records.find(record => record.kind === 'workspace-identity')!
  const value = identity.value as unknown as { localData: object }
  expect(() => assembleWorkspace(records.map(record => record === identity ? { ...record, value: { ...value, localData: { ...value.localData, selectedPlaythroughId: 'remote-selection' } } as never } : record), 0)).toThrow()
  const build = records.find(record => record.kind === 'build')!
  expect(() => assembleWorkspace(records.map(record => record === build ? { ...record, key: JSON.stringify(['build', 'foreign-id']) } : record), 0)).toThrow()
  const catalog = records.find(record => record.kind === 'catalog')!
  expect(() => assembleWorkspace(records.map(record => record === catalog ? { ...record, key: JSON.stringify(['catalog', 'foreign-id', 'foreign-revision']) } : record), 0)).toThrow()
})

it('round trips populated observations, skills, goals, receipts and exact historical evidence', async () => {
  const { screenshotTestLocalData, TEST_CAPTURE } = await import('../domain/skill-trees.test-helpers')
  const { importSkillTrees } = await import('../domain/skill-trees')
  const { createGoal } = await import('../domain/goals')
  const { recordInventoryEvent } = await import('../domain/inventory')
  const { sha256 } = await import('../interchange/util')
  const bytes = new TextEncoder().encode('{"ID":"synthetic-observation","password":"inert"}')
  const digest = await sha256(bytes), sourceId = `source:sha256:${digest}`
  const original = sampleWorkspace()
  let localData = screenshotTestLocalData(original.planner.localData)
  localData = importSkillTrees(localData, original.planner.catalogs, [{ ...TEST_CAPTURE, sourceDigest: digest, gameSetupRevisionId: localData.planningGameSetupRevisionId }], localData.revision)
  localData = createGoal(localData, { title: 'Uncertain requirement', requirements: [{ id: 'requirement', kind: 'verify', state: { state: 'unknown', reason: 'No observation' } }] })
  const position = Object.values(localData.playthroughs[localData.selectedPlaythroughId!].inventory)[0]
  localData = recordInventoryEvent(localData, { ref: position.ref, kind: 'acquired', quantity: { state: 'unknown' }, sources: [{ sourceId }] })
  const { toggleQuintarStep } = await import('../domain/quintar-breeding')
  const { QUINTAR_BREEDING_STEP_IDS } = await import('../catalog/quintar-breeding')
  localData = toggleQuintarStep(localData, { playthroughId: localData.selectedPlaythroughId!, stepId: [...QUINTAR_BREEDING_STEP_IDS][0] as import('../catalog/quintar-breeding').QuintarBreedingStepId })
  localData = { ...localData, referenceLibrary: { version: 1, excludedMods: ['crystal-edit:unavailable-reference'] }, importReceipts: { receipt: { id: 'receipt' as never, importedAt: localData.updatedAt, sourceFormat: 'crystal-edit-json-1', sourceIdentity: `sha256:${digest}`, localDataRevision: 0 } } }
  const ref = { documentId: 'exact-screenshot', revisionId: 'original', sha256: digest, byteLength: bytes.length, encoding: 'bytes' as const }
  const state: WorkspaceState = { ...original, planner: { ...original.planner, localData, sources: [{ id: sourceId, digest, filename: 'synthetic-observation.json', mediaType: 'application/json', format: 'crystal-edit-json-1', importedAt: localData.createdAt, original: ref }], evidence: [{ id: 'evidence', sourceDigest: digest, group: 'personal', kind: 'observation', locator: '/synthetic', sources: [{ sourceId }], payload: { unknown: null, password: 'inert' }, private: true }], history: [{ id: 'original-history', localDataId: localData.id, command: 'original-command', previousRevision: 0, nextRevision: localData.revision, before: original.planner.localData, after: localData, recordedAt: localData.updatedAt }] }, blobs: [{ ref, content: memoryBlob(bytes) }] }
  const mapped = splitWorkspace(state), result = assembleWorkspace(mapped, localData.revision)
  const expected = { ...localData, selectedPlaythroughId: undefined, planningGameSetupRevisionId: undefined, playthroughs: Object.fromEntries(Object.entries(localData.playthroughs).map(([id, playthrough]) => [id, { ...playthrough, activeScenarioId: undefined }])) }
  expect(result.planner.localData).toEqual(expected)
  expect(result.planner.history).toEqual(state.planner.history)
  expect(result.planner.evidence).toEqual(state.planner.evidence)
  expect(result.planner.sources).toEqual(state.planner.sources)
  expect(mapped.filter(document => ['skill-layout', 'skill-capture', 'goal', 'inventory', 'character'].includes(document.kind)).length).toBeGreaterThan(5)
  expect(await readBlob(result.blobs[0].content, bytes.length)).toEqual(bytes)
})
