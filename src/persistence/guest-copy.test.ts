import 'fake-indexeddb/auto'
import type { ModSourceReceipt } from '../domain/types'
import { preparePublicationAttempt } from '../account/sync/publication'
import { openRemoteProjection } from '../account/sync/projection'
import { prepareCopiedConflictPublication } from '../workspace/copied-conflicts'
import { inspectWorkspaceClosure } from '../workspace/closure'
import * as activation from './account-database'
import { openAccountWorkspace, prepareAccountWorkspace } from '../workspace/account-graph'
import { blobIdentity, readBlob } from '../workspace/blobs'
import { createSampleLocalData } from '../domain/sample-data'
import { createBlankLocalData } from '../domain/local-data'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { afterEach, expect, it, vi } from 'vitest'
import { AccountDatabase } from './account-database'
import { installProfile, invalidateProfile } from '../account/profile'
import { accountLocalId, openAccountJson } from '../workspace/account-cache'
import { MappedWorkspaceIntentSchema } from '../workspace/account-intents'
import { createGuestCopyService } from '../workspace/guest-copy'
import { editorClosureFixture } from '../workspace/test-helpers'
import { ownWorkspaceSnapshot } from '../workspace/snapshot'

const databases: AccountDatabase[] = []
afterEach(async () => { invalidateProfile(); for (const database of databases.splice(0)) await database.delete() })
async function setup() {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const database = new AccountDatabase(token.accountId); databases.push(database)
  const fixture = await editorClosureFixture()
  const state = { ...fixture.state, editorDocuments: [fixture.file] }
  const capture = async () => ownWorkspaceSnapshot({ version: 1, snapshotId: 'synthetic-copy', capturedAt: '2026-10-13', revisionVector: {}, state }, { async check() {}, async dispose() {} })
  return { token, database, state, capture }
}
// Native journal recovery keeps its original persisted codec; fresh managed targets have separate startup coverage
async function nativeCopySetup() {
  const value = await setup(), localData = createBlankLocalData()
  const initial = await prepareAccountWorkspace(value.database, value.token, {
    planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], sources: [], evidence: [], history: [] },
    editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], blobs: [], libraryDefaults: { version: 1, layers: [] },
  })
  await activation.activateLocalAccountCommit(value.database, value.token, { version: 1, id: accountLocalId(), expected: undefined, head: initial.head, records: initial.records })
  return value
}
it('signInNeverUploadsGuestData', async () => {
  const { database, capture, token } = await setup()
  const service = createGuestCopyService(capture)
  expect(await database.outbox.count()).toBe(0)
  const preview = await service.previewGuestCopy(token)
  expect(preview.selectedKeys).toEqual([])
  expect(await database.outbox.count()).toBe(0)
  await service.dispose()
})
it('copyResumeKeepsGuestAndStableMappings', async () => {
  const { token, database, state, capture } = await nativeCopySetup()
  const before = JSON.stringify({ ...state, blobs: state.blobs.map(blob => blob.ref) })
  const service = createGuestCopyService(capture)
  const preview = await service.previewGuestCopy(token, ['["editor","editor-1"]'])
  const first = await service.commitGuestCopy(token, preview)
  const retry = await service.commitGuestCopy(token, preview)
  expect(retry).toEqual(first)
  expect(first.mappings.filter(value => value.key === '["editor","editor-1"]')).toHaveLength(1)
  expect(await database.outbox.count()).toBe(1)
  expect(JSON.stringify({ ...state, blobs: state.blobs.map(blob => blob.ref) })).toBe(before)
  await service.dispose()
})
it('switchDuringCopyCannotRebindJob', async () => {
  const { token, capture, database } = await setup()
  const service = createGuestCopyService(capture)
  const preview = await service.previewGuestCopy(token, ['["editor","editor-1"]'])
  const other = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const second = new AccountDatabase(other.accountId); databases.push(second)
  await expect(service.commitGuestCopy(other, preview)).rejects.toThrow()
  expect(await second.profileMeta.count()).toBe(0)
  expect(await database.outbox.count()).toBe(0)
  await service.dispose()
})

it('resumesTheEncryptedStagedGroupAfterActivationFailureWithoutGuestRecapture', async () => {
  const { token, database, capture } = await nativeCopySetup()
  const service = createGuestCopyService(capture)
  const preview = await service.previewGuestCopy(token, ['["editor","editor-1"]'])
  const original = activation.activateLocalAccountCommit
  const fail = vi.spyOn(activation, 'activateLocalAccountCommit').mockRejectedValueOnce(new Error('Injected activation failure'))
  await expect(service.commitGuestCopy(token, preview)).rejects.toThrow('Injected activation failure')
  fail.mockRestore()
  expect(activation.activateLocalAccountCommit).toBe(original)
  expect(await database.outbox.count()).toBe(0)
  const staged = await database.syncState.get('guest-copy:pending')
  expect(staged).toBeDefined()
  const records = (await database.encryptedRevisions.toArray()).map(record => record.revisionId)
  await service.dispose()
  const reopened = createGuestCopyService(async () => { throw new Error('Guest recapture is forbidden during resume') })
  const resumed = await reopened.previewGuestCopy(token)
  expect(resumed.copyId).toBe(preview.copyId)
  expect(resumed.resumable).toBe(true)
  const receipt = await reopened.commitGuestCopy(token, resumed)
  expect(receipt.copyId).toBe(preview.copyId)
  expect((await database.encryptedRevisions.toArray()).map(record => record.revisionId)).toEqual(records)
  expect(await database.outbox.count()).toBe(1)
  const fence = (await database.profileMeta.get('active'))!
  const state = (await openAccountWorkspace(database, token, fence.head)).state
  expect(state.editorDocuments[0].unfinished.validation).toBe('invalid')
  expect(state.retainedContent[0].kind).toBe('pending-content')
  await reopened.dispose()
})
it('copiesUnsupportedSavesAndExactInertBytesWithUnavailableSourceReceipts', async () => {
  const { token, database, capture, state } = await nativeCopySetup()
  const save = { version: 1 as const, id: 'unsupported-save', revision: 0, filename: 'opaque.dat', original: state.blobs[0].ref, working: state.blobs[0].ref, pendingForm: { version: 999, text: 'inert private saved form' }, requirements: [{ catalogId: 'crystal-edit:missing' as ModSourceReceipt['catalogId'], catalogRevisionId: `sha256:${'a'.repeat(64)}:rules-v1:library-v1` as ModSourceReceipt['catalogRevisionId'], checksum: `sha256:${'a'.repeat(64)}`, title: 'Unavailable original' }], coverage: { status: 'unsupported' as const, diagnostics: ['Unknown version'] }, createdAt: '2026-10-13', updatedAt: '2026-10-13', exportedRevision: null }
  const snapshot = await capture()
  const service = createGuestCopyService(async () => ownWorkspaceSnapshot({ ...snapshot, state: { ...state, saveDocuments: [save] } }, { async check() {}, async dispose() {} }))
  const preview = await service.previewGuestCopy(token, ['["save","unsupported-save"]'])
  await service.commitGuestCopy(token, preview)
  const copied = (await openAccountWorkspace(database, token, (await database.profileMeta.get('active'))!.head)).state
  expect(copied.saveDocuments).toEqual([save])
  expect(copied.editorDocuments).toEqual([])
  expect(copied.retainedContent).toEqual([])
  expect(await readBlob(copied.blobs.find(blob => blobIdentity(blob.ref) === blobIdentity(save.original))!.content, save.original.byteLength)).toEqual(new Uint8Array([0, 216]))
  await service.dispose()
})
it('sampleProvenanceSurvivesRenamingAndRequiresExplicitInclusion', async () => {
  const { token, capture, state } = await setup()
  const original = createSampleLocalData(DEFAULT_CATALOG)
  const builds = Object.fromEntries(Object.entries(original.builds).map(([id, build]) => [id, { ...build, title: 'Edited sample' }]))
  const sample = { ...state, planner: { ...state.planner, localData: { ...original, builds }, lineage: { rootLocalDataId: original.id }, catalogs: [DEFAULT_CATALOG] } }
  const source = await capture()
  const service = createGuestCopyService(async () => ownWorkspaceSnapshot({ ...source, state: sample }, { async check() {}, async dispose() {} }))
  const preview = await service.previewGuestCopy(token)
  expect(preview.selectedKeys).toEqual([])
  expect(preview.records.filter(record => record.label === 'Edited sample').every(record => record.sample)).toBe(true)
  expect(preview.records.find(record => record.kind === 'playthrough')?.sample).toBe(true)
  await service.dispose()
})
it('selectionCancellationAndChangedGuestCaptureLeaveAccountAndGuestUntouched', async () => {
  const { token, database, capture } = await setup()
  const source = await capture()
  let current = true
  const service = createGuestCopyService(async () => ownWorkspaceSnapshot(source, { async check() { if (!current) throw new Error('Guest changed') }, async dispose() {} }))
  const preview = await service.previewGuestCopy(token, ['["editor","editor-1"]'])
  const before = await database.profileMeta.get('active')
  current = false
  await expect(service.commitGuestCopy(token, preview)).rejects.toThrow('Guest changed')
  expect(await database.profileMeta.get('active')).toEqual(before)
  expect(await database.outbox.count()).toBe(0)
  await service.dispose()
})

it('copiesAnIdentityCollisionAsPendingComparisonWithoutReplacingAccountContent', async () => {
  const { token, database, capture, state } = await setup()
  const base = await prepareAccountWorkspace(database, token, { ...state, editorDocuments: [{ ...state.editorDocuments[0], filename: 'Account original.json' }] })
  await activation.activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: base.head, records: base.records })
  const service = createGuestCopyService(capture)
  const preview = await service.previewGuestCopy(token, ['["editor","editor-1"]'])
  expect(preview.conflicts).toContain('["editor","editor-1"]')
  const receipt = await service.commitGuestCopy(token, preview)
  const target = await openAccountWorkspace(database, token, (await database.profileMeta.get('active'))!.head)
  expect(target.state.editorDocuments[0].filename).toBe('Account original.json')
  const row = (await database.outbox.toArray())[0]
  const intent = await openAccountJson(database, token, row.ref, MappedWorkspaceIntentSchema)
  expect(intent.copiedConflicts).toBeDefined()
  expect(receipt.copyId).toBe(preview.copyId)
  await service.dispose()
})

it('publishesCopiedEditorComparisonWithActualDestinationParentsAndUnchangedOriginals', async () => {
  const { token, database, capture, state } = await setup()
  const base = await prepareAccountWorkspace(database, token, { ...state, editorDocuments: [{ ...state.editorDocuments[0], filename: 'Account original.json' }] })
  await activation.activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: base.head, records: base.records })
  const initial = await preparePublicationAttempt(database, token, base.opened, null, new Map(), 0)
  const heads = new Map(initial.final.heads.map(ref => [ref.documentId, ref.revisionId]))
  const remote = (await openRemoteProjection(database, token, heads, base.head, 0))!
  const service = createGuestCopyService(capture)
  await service.commitGuestCopy(token, await service.previewGuestCopy(token, ['["editor","editor-1"]']))
  const intent = await openAccountJson(database, token, (await database.outbox.toArray())[0].ref, MappedWorkspaceIntentSchema)
  const target = await openAccountWorkspace(database, token, intent.target)
  const prepared = await prepareCopiedConflictPublication(database, token, intent, target, remote)
  const conflict = prepared.target.state.conflicts[0]
  const authority = prepared.authorities.get(JSON.stringify(['conflict', conflict.id]))!
  expect(authority.branches[0].publication.parents).toEqual([remote.units.get('["editor","editor-1"]')!.ref.revisionId])
  expect(authority.branches[0].publication.ref.documentId).toBe(remote.units.get('["editor","editor-1"]')!.ref.documentId)
  expect(prepared.target.state.editorDocuments[0].filename).toBe('Account original.json')
  const parents = new Map([...remote.units.values()].map(unit => [unit.body.ref.revisionId, unit.ref]))
  const publication = await preparePublicationAttempt(database, token, prepared.target, remote, heads, 1, prepared.changes, 'additive', { lineageId: remote.lineageId, parents }, { authorities: prepared.authorities })
  const later = new Map([...heads, ...publication.final.heads.map(ref => [ref.documentId, ref.revisionId] as const)])
  const opened = (await openRemoteProjection(database, token, later, prepared.target.head, 1))!
  expect(opened.workspace.state.conflicts).toHaveLength(1)
  const values = await Promise.all(opened.workspace.state.conflicts[0].branches.map(branch => inspectWorkspaceClosure(opened.workspace.state, branch.closure)))
  expect(values.map(value => (value.value as { filename: string }).filename)).toEqual(['before.json', 'Account original.json'])
  expect(state.editorDocuments[0].filename).toBe('before.json')
  await service.dispose()
})

it('cancelsAtTheFinalActivationFenceWithoutLosingTheSavedResumableGroup', async () => {
  const { token, database, capture } = await nativeCopySetup()
  const service = createGuestCopyService(capture)
  const preview = await service.previewGuestCopy(token, ['["editor","editor-1"]'])
  const before = await database.profileMeta.get('active')
  const activate = activation.activateLocalAccountCommit
  const spy = vi.spyOn(activation, 'activateLocalAccountCommit').mockImplementationOnce(async (...args) => {
    await service.dispose()
    return activate(...args)
  })
  await expect(service.commitGuestCopy(token, preview)).rejects.toThrow('Local copy was cancelled')
  spy.mockRestore()
  expect(await database.profileMeta.get('active')).toEqual(before)
  expect(await database.outbox.count()).toBe(0)
  expect(await database.syncState.get('guest-copy:pending')).toBeDefined()
  const reopened = createGuestCopyService(capture)
  await reopened.commitGuestCopy(token, await reopened.previewGuestCopy(token))
  expect(await database.outbox.count()).toBe(1)
  await reopened.dispose()
})

it('registersCopiedPersonalSuccessorAgainstTheActualDestinationAnchor', async () => {
  const { createPersonalDefinition, revisePersonalDefinition } = await import('../domain/local-data')
  const { personalLineageChains } = await import('../account/sync/lineage')
  const { token, database, state, capture } = await setup()
  const root = createPersonalDefinition(state.planner.localData, { id: 'root' as import('../domain/types').PersonalDefinitionId, kind: 'item', name: 'Root' })
  const mine = revisePersonalDefinition(root, { sourceRef: { kind: 'personal', definitionId: 'root' as import('../domain/types').PersonalDefinitionId }, name: 'Guest successor' }).localData
  const accepted = revisePersonalDefinition(root, { sourceRef: { kind: 'personal', definitionId: 'root' as import('../domain/types').PersonalDefinitionId }, name: 'Account successor' }).localData
  const account = { ...state, planner: { ...state.planner, localData: accepted } }
  const base = await prepareAccountWorkspace(database, token, account)
  await activation.activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: base.head, records: base.records })
  const initial = await preparePublicationAttempt(database, token, base.opened, null, new Map(), 0)
  const heads = new Map(initial.final.heads.map(ref => [ref.documentId, ref.revisionId]))
  const remote = (await openRemoteProjection(database, token, heads, base.head, 0))!
  const snapshot = await capture()
  const service = createGuestCopyService(async () => ownWorkspaceSnapshot({ ...snapshot, state: { ...state, planner: { ...state.planner, localData: mine } } }, { async check() {}, async dispose() {} }))
  const selected = Object.values(mine.personalDefinitions).find(value => value.name === 'Guest successor')!
  const preview = await service.previewGuestCopy(token, [JSON.stringify(['personal-definition', selected.id])])
  const key = [...personalLineageChains(mine).keys()][0]
  expect(preview.conflicts).toContain(key)
  await service.commitGuestCopy(token, preview)
  const intent = await openAccountJson(database, token, (await database.outbox.toArray())[0].ref, MappedWorkspaceIntentSchema)
  const target = await openAccountWorkspace(database, token, intent.target)
  expect(target.state.planner.localData.personalDefinitions).toEqual(accepted.personalDefinitions)
  const prepared = await prepareCopiedConflictPublication(database, token, intent, target, remote)
  const conflict = prepared.target.state.conflicts[0]
  const authority = prepared.authorities.get(JSON.stringify(['conflict', conflict.id]))!
  expect(authority.branches[0].publication.parents).toEqual([remote.lineages.get(key)!.ref.revisionId])
  expect(authority.branches[0].publication.ref.documentId).toBe(remote.lineages.get(key)!.ref.documentId)
  const branches = await Promise.all(conflict.branches.map(branch => inspectWorkspaceClosure(prepared.target.state, branch.closure)))
  expect(branches.map(branch => (branch.value as { name: string }).name)).toEqual(['Guest successor', 'Account successor'])
  await service.dispose()
})

it.each(['compatible', 'absent', 'occupied'] as const)('copiesAnImportedEditorComparisonWithoutTheSourceAccountKey: %s', async destination => {
  const { createWorkspaceConflict } = await import('../workspace/conflicts')
  const source = await setup()
  const ancestor = await prepareAccountWorkspace(source.database, source.token, source.state)
  const pending = await prepareAccountWorkspace(source.database, source.token, { ...source.state, editorDocuments: [{ ...source.state.editorDocuments[0], filename: 'Imported pending.json' }] }, ancestor.opened)
  const accepted = await prepareAccountWorkspace(source.database, source.token, { ...source.state, editorDocuments: [{ ...source.state.editorDocuments[0], filename: 'Imported accepted.json' }] }, ancestor.opened)
  const captured = await createWorkspaceConflict({ base: ancestor.opened, local: pending.opened, remote: accepted.opened, privateKey: '["editor","editor-1"]' })
  const portable = { ...accepted.opened.state, conflicts: [captured.conflict], blobs: captured.blobs }
  const target = await setup()
  const base = await prepareAccountWorkspace(target.database, target.token, { ...accepted.opened.state, editorDocuments: destination === 'absent' ? [] : destination === 'occupied' ? [{ ...source.state.editorDocuments[0], filename: 'Existing destination.json' }] : accepted.opened.state.editorDocuments })
  await activation.activateLocalAccountCommit(target.database, target.token, { version: 1, id: accountLocalId(), expected: undefined, head: base.head, records: base.records })
  const initial = await preparePublicationAttempt(target.database, target.token, base.opened, null, new Map(), 0)
  const heads = new Map(initial.final.heads.map(ref => [ref.documentId, ref.revisionId]))
  let remote = (await openRemoteProjection(target.database, target.token, heads, base.head, 0))!
  const service = createGuestCopyService(async () => ownWorkspaceSnapshot({ version: 1, snapshotId: 'foreign-original', capturedAt: '2026-10-13', revisionVector: {}, state: portable }, { async check() {}, async dispose() {} }))
  const preview = await service.previewGuestCopy(target.token, [JSON.stringify(['conflict', captured.conflict.id])])
  expect(preview.problems).toEqual([])
  await service.commitGuestCopy(target.token, preview)
  const intent = await openAccountJson(target.database, target.token, (await target.database.outbox.toArray())[0].ref, MappedWorkspaceIntentSchema)
  const copied = await openAccountWorkspace(target.database, target.token, intent.target)
  if (destination === 'compatible') {
    const { readCopiedConflicts, stageCopiedConflictRegistrations } = await import('../workspace/copied-conflicts')
    const [registration] = await readCopiedConflicts(target.database, target.token, intent)
    const before = await target.database.profileMeta.get('active')
    for (const altered of [
      { ...registration, sourceDigest: '0'.repeat(64) },
      { ...registration, privateKey: '["editor","foreign"]' },
      { ...registration, original: { ...registration.original!, accepted: registration.source } },
    ]) {
      const invalid = await stageCopiedConflictRegistrations(target.database, target.token, intent.operationId, [altered])
      await target.database.encryptedRevisions.bulkAdd(invalid.records)
      await expect(readCopiedConflicts(target.database, target.token, { ...intent, copiedConflicts: invalid.root })).rejects.toThrow()
    }
    expect(await target.database.profileMeta.get('active')).toEqual(before)
  }
  expect(copied.state.conflicts).toEqual([])
  let result = await prepareCopiedConflictPublication(target.database, target.token, intent, copied, remote)
  if (destination === 'absent') {
    expect(copied.state.editorDocuments[0].filename).toBe('Imported accepted.json')
    expect(result.target.state.conflicts).toEqual([])
    const publication = await preparePublicationAttempt(target.database, target.token, result.target, remote, heads, 1, result.changes, 'additive', { lineageId: remote.lineageId, parents: new Map([...remote.units.values()].map(unit => [unit.body.ref.revisionId, unit.ref])) })
    for (const ref of publication.final.heads) heads.set(ref.documentId, ref.revisionId)
    remote = (await openRemoteProjection(target.database, target.token, heads, copied.head, 1))!
    result = await prepareCopiedConflictPublication(target.database, target.token, intent, copied, remote)
  }
  if (destination === 'occupied') expect(copied.state.editorDocuments[0].filename).toBe('Existing destination.json')
  const originals = await service.inspectCopiedComparisons(target.token)
  expect(originals[0].versions.map(value => (value.value as { filename: string }).filename)).toEqual(['Imported pending.json', 'Imported accepted.json'])
  expect(result.target.state.conflicts).toHaveLength(1)
  const conflict = result.target.state.conflicts[0]
  expect(conflict.id).not.toBe(captured.conflict.id)
  const branches = await Promise.all(conflict.branches.map(branch => inspectWorkspaceClosure(result.target.state, branch.closure)))
  expect(branches.map(branch => (branch.value as { filename: string }).filename)).toEqual(destination === 'occupied' ? ['Imported accepted.json', 'Existing destination.json'] : ['Imported pending.json', 'Imported accepted.json'])
  expect(result.authorities.get(JSON.stringify(['conflict', conflict.id]))!.branches[0].publication.parents).toEqual([remote.units.get('["editor","editor-1"]')!.ref.revisionId])
  await service.dispose()
})

it.each(['lineage', 'mapping', 'delete', 'accepted-delete', 'accepted-delete-absent'] as const)('reconstructsTheOriginalSemanticUnit: %s', async kind => {
  const { createWorkspaceConflict } = await import('../workspace/conflicts')
  const source = await setup()
  let portable: import('../workspace/documents').WorkspaceState
  let key = '["editor","editor-1"]'
  const { directoryShard } = await import('../workspace/directory')
  const sameShardId = async (prefix: string) => {
    for (let index = 0; ; index++) if (await directoryShard(JSON.stringify(['editor', `${prefix}-${index}`])) === await directoryShard(key)) return `${prefix}-${index}` as typeof source.state.editorDocuments[number]['id']
  }
  let sourceSibling: string | undefined, destinationSibling: string | undefined
  if (kind === 'lineage') {
    const { createPersonalDefinition, revisePersonalDefinition } = await import('../domain/local-data')
    const { personalLineageChains } = await import('../account/sync/lineage')
    const { archivePersonalLineage } = await import('../workspace/lineage-closure')
    const root = createPersonalDefinition(source.state.planner.localData, { id: 'root' as import('../domain/types').PersonalDefinitionId, kind: 'item', name: 'Root' })
    const base = await prepareAccountWorkspace(source.database, source.token, { ...source.state, planner: { ...source.state.planner, localData: root } })
    const branch = async (name: string) => prepareAccountWorkspace(source.database, source.token, { ...source.state, planner: { ...source.state.planner, localData: revisePersonalDefinition(root, { sourceRef: { kind: 'personal', definitionId: 'root' as import('../domain/types').PersonalDefinitionId }, name }).localData } }, base.opened)
    const pending = await branch('Pending successor'), accepted = await branch('Accepted successor')
    key = [...personalLineageChains(root).keys()][0]
    const blobs = new Map(source.state.blobs.map(blob => [blobIdentity(blob.ref), blob]))
    const conflict: import('../workspace/documents').WorkspaceConflict = { version: 1, id: accountLocalId(), unit: { kind: 'record', privateKey: key }, commonAncestor: { kind: 'present', closure: await archivePersonalLineage(base.opened, key, blobs) }, branches: [{ role: 'local-pending', closure: await archivePersonalLineage(pending.opened, key, blobs) }, { role: 'accepted-cloud', closure: await archivePersonalLineage(accepted.opened, key, blobs) }], disposition: { kind: 'unresolved' } }
    portable = { ...accepted.opened.state, conflicts: [conflict], blobs: [...blobs.values()] }
  } else if (kind === 'mapping') {
    const { createMappingConflict } = await import('../account/sync/mapping-convergence')
    sourceSibling = await sameShardId('source-sibling')
    const sibling = { ...source.state.editorDocuments[0], id: sourceSibling as typeof source.state.editorDocuments[number]['id'], filename: 'Unselected source sibling.json' }
    const base = await prepareAccountWorkspace(source.database, source.token, { ...source.state, editorDocuments: [sibling] })
    await source.database.encryptedRevisions.bulkAdd(base.records)
    const published = await preparePublicationAttempt(source.database, source.token, base.opened, null, new Map(), 0)
    const heads = new Map(published.final.heads.map(ref => [ref.documentId, ref.revisionId]))
    const initial = (await openRemoteProjection(source.database, source.token, heads, base.head, 0))!
    const pending = await prepareAccountWorkspace(source.database, source.token, { ...source.state, editorDocuments: [{ ...source.state.editorDocuments[0], filename: 'Pending mapping.json' }] })
    const accepted = await prepareAccountWorkspace(source.database, source.token, { ...source.state, editorDocuments: [...source.state.editorDocuments, sibling] }, base.opened)
    await source.database.encryptedRevisions.bulkAdd([...pending.records, ...accepted.records])
    const { mappedChanges } = await import('../workspace/account-intents')
    const publishedAccepted = await preparePublicationAttempt(source.database, source.token, accepted.opened, initial, heads, 1, mappedChanges(initial.workspace, accepted.opened), 'additive', { lineageId: initial.lineageId, parents: new Map([...initial.units.values()].map(unit => [unit.body.ref.revisionId, unit.ref])) })
    for (const ref of publishedAccepted.final.heads) heads.set(ref.documentId, ref.revisionId)
    const remote = (await openRemoteProjection(source.database, source.token, heads, accepted.head, 1))!
    const captured = await createMappingConflict(source.database, source.token, initial, pending.opened, remote, pending.entries.find(entry => entry.key === key)!, remote.workspace.state)
    portable = captured.state
  } else {
    const base = await prepareAccountWorkspace(source.database, source.token, source.state)
    const deleted = await prepareAccountWorkspace(source.database, source.token, { ...source.state, editorDocuments: [] }, base.opened)
    const edited = await prepareAccountWorkspace(source.database, source.token, { ...source.state, editorDocuments: [{ ...source.state.editorDocuments[0], filename: 'Accepted edit.json' }] }, base.opened)
    const acceptedDeleted = kind.startsWith('accepted-delete')
    const pending = acceptedDeleted ? edited : deleted, accepted = acceptedDeleted ? deleted : edited
    const captured = await createWorkspaceConflict({ base: base.opened, local: pending.opened, remote: accepted.opened, privateKey: key })
    portable = { ...accepted.opened.state, conflicts: [captured.conflict], blobs: captured.blobs }
  }
  const { memoryBlob } = await import('../workspace/blobs')
  portable = { ...portable, blobs: await Promise.all(portable.blobs.map(async blob => ({ ref: blob.ref, content: memoryBlob(await readBlob(blob.content, blob.ref.byteLength)) }))) }
  const target = await setup()
  destinationSibling = kind === 'mapping' ? await sameShardId('destination-sibling') : undefined
  const destination = { ...portable, conflicts: [], editorDocuments: kind === 'mapping' ? [source.state.editorDocuments[0], { ...source.state.editorDocuments[0], id: destinationSibling as typeof source.state.editorDocuments[number]['id'], filename: 'Independent destination.json' }] : portable.editorDocuments }
  const prior = kind === 'accepted-delete' ? await prepareAccountWorkspace(target.database, target.token, target.state) : undefined
  if (prior) await target.database.encryptedRevisions.bulkAdd(prior.records)
  const base = await prepareAccountWorkspace(target.database, target.token, destination, prior?.opened)
  await activation.activateLocalAccountCommit(target.database, target.token, { version: 1, id: accountLocalId(), expected: undefined, head: base.head, records: base.records })
  const published = await preparePublicationAttempt(target.database, target.token, prior?.opened ?? base.opened, null, new Map(), 0)
  const heads = new Map(published.final.heads.map(ref => [ref.documentId, ref.revisionId]))
  let remote = (await openRemoteProjection(target.database, target.token, heads, base.head, 0))!
  if (prior) {
    const { mappedChanges } = await import('../workspace/account-intents')
    const deletion = await preparePublicationAttempt(target.database, target.token, base.opened, remote, heads, 1, mappedChanges(prior.opened, base.opened), 'additive', { lineageId: remote.lineageId, parents: new Map([...remote.units.values()].map(unit => [unit.body.ref.revisionId, unit.ref])) })
    for (const ref of deletion.final.heads) heads.set(ref.documentId, ref.revisionId)
    remote = (await openRemoteProjection(target.database, target.token, heads, base.head, 1))!
    expect(remote.units.get(key)!.body.kind).toBe('tombstone')
  }
  const service = createGuestCopyService(async () => ownWorkspaceSnapshot({ version: 1, snapshotId: 'semantic-source', capturedAt: '2026-10-13', revisionVector: {}, state: portable }, { async check() {}, async dispose() {} }))
  const preview = await service.previewGuestCopy(target.token, [JSON.stringify(['conflict', portable.conflicts[0].id])])
  expect(preview.problems).toEqual([])
  await service.commitGuestCopy(target.token, preview)
  const intent = await openAccountJson(target.database, target.token, (await target.database.outbox.toArray())[0].ref, MappedWorkspaceIntentSchema)
  const copied = await openAccountWorkspace(target.database, target.token, intent.target)
  let result = await prepareCopiedConflictPublication(target.database, target.token, intent, copied, remote)
  if (kind === 'accepted-delete-absent') {
    expect(result.target.state.conflicts).toEqual([])
    expect(result.initialTombstones?.has(key)).toBe(true)
    const ordinary = await preparePublicationAttempt(target.database, target.token, result.target, remote, heads, 1, result.changes)
    const ordinaryHeads = new Map(heads)
    for (const ref of ordinary.final.heads) ordinaryHeads.set(ref.documentId, ref.revisionId)
    expect((await openRemoteProjection(target.database, target.token, ordinaryHeads, result.target.head, 1))!.units.has(key)).toBe(false)
    const options = { initialTombstones: result.initialTombstones }
    const other = result.target.entries.find(entry => entry.kind === 'library-defaults')!
    await expect(preparePublicationAttempt(target.database, target.token, result.target, remote, heads, 1, result.changes, 'additive', undefined, { initialTombstones: new Map([[other.key, other.ref]]) })).rejects.toThrow()
    await expect(preparePublicationAttempt(target.database, target.token, result.target, remote, heads, 1, result.changes, 'additive', undefined, { initialTombstones: new Map([['wrong-key', result.initialTombstones!.get(key)!]]) })).rejects.toThrow()
    const established = await preparePublicationAttempt(target.database, target.token, result.target, remote, heads, 1, result.changes, 'additive', undefined, options)
    for (const ref of established.final.heads) heads.set(ref.documentId, ref.revisionId)
    remote = (await openRemoteProjection(target.database, target.token, heads, result.target.head, 1))!
    expect(remote.units.get(key)!.body.kind).toBe('tombstone')
    expect((await target.database.encryptedRevisions.get(remote.units.get(key)!.ref.revisionId))!.descriptor.parents).toEqual([])
    await expect(preparePublicationAttempt(target.database, target.token, result.target, remote, heads, 2, result.changes, 'additive', undefined, options)).rejects.toThrow()
    result = await prepareCopiedConflictPublication(target.database, target.token, intent, result.target, remote)
  }
  const conflict = result.target.state.conflicts[0]
  expect(conflict.unit.kind).toBe(kind === 'mapping' ? 'directory-mapping' : 'record')
  const branches = await Promise.all(conflict.branches.map(branch => inspectWorkspaceClosure(result.target.state, branch.closure)))
  expect(branches[0].publication!.parents).toEqual([branches[1].publication!.ref.revisionId])
  if (kind === 'lineage') {
    expect(branches.map(branch => (branch.value as { name: string }).name)).toEqual(['Pending successor', 'Accepted successor'])
    expect(branches[0].publication!.lineage).toBeDefined()
  } else if (kind === 'mapping') {
    expect((branches[0].value as { filename: string }).filename).toBe('Pending mapping.json')
    expect(branches[0].publication!.mapping!.context).toBeUndefined()
    expect(branches[1].publication!.mapping!.context).toBeDefined()
    const { readPublicationPages } = await import('../account/sync/projection')
    const { DirectoryPageSchema } = await import('../account/sync/publication')
    const memberships = await readPublicationPages(target.database, target.token, branches[0].publication!.mapping!.index, DirectoryPageSchema, () => [])
    expect(memberships.some(value => value.key === JSON.stringify(['editor', sourceSibling]))).toBe(false)
    expect(memberships.some(value => value.key === JSON.stringify(['editor', destinationSibling]))).toBe(true)
    expect(result.target.state.editorDocuments.some(value => value.filename === 'Independent destination.json')).toBe(true)
  } else expect(branches[kind.startsWith('accepted-delete') ? 1 : 0].root.kind).toBe('tombstone')
  const publication = await preparePublicationAttempt(target.database, target.token, result.target, remote, heads, 1, result.changes, 'additive', { lineageId: remote.lineageId, parents: new Map([...remote.units.values()].map(unit => [unit.body.ref.revisionId, unit.ref])) }, { authorities: result.authorities })
  for (const ref of publication.final.heads) heads.set(ref.documentId, ref.revisionId)
  const reopened = (await openRemoteProjection(target.database, target.token, heads, result.target.head, 1))!
  expect(reopened.workspace.state.conflicts[0].id).toBe(conflict.id)
  await service.dispose()
})

it('copiesAChangedBuildWithExactPinsWithoutActivatingItsUnselectedPlaythrough', async () => {
  const { addTestBuild, createTestLocalData, personalRef } = await import('../domain/test-helpers')
  const { createPersonalDefinition } = await import('../domain/local-data')
  const { token, database, state, capture } = await setup()
  const withDefinition = createPersonalDefinition(createTestLocalData(), { id: personalRef('pinned-item').definitionId, kind: 'item', name: 'Pinned unknown item' })
  const incoming = addTestBuild(withDefinition, 'chosen-build', '', { hand: { ref: personalRef('pinned-item') } })
  const build = Object.values(incoming.builds)[0]
  const account = { ...state, planner: { ...state.planner, localData: { ...incoming, playthroughs: {}, selectedPlaythroughId: undefined, builds: { [build.id]: { ...build, title: 'Account Build' } } }, lineage: { rootLocalDataId: incoming.id } } }
  const base = await prepareAccountWorkspace(database, token, account)
  await activation.activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: base.head, records: base.records })
  const published = await preparePublicationAttempt(database, token, base.opened, null, new Map(), 0)
  const remote = (await openRemoteProjection(database, token, new Map(published.final.heads.map(ref => [ref.documentId, ref.revisionId])), base.head, 0))!
  const snapshot = await capture()
  const service = createGuestCopyService(async () => ownWorkspaceSnapshot({ ...snapshot, state: { ...state, planner: { ...state.planner, localData: incoming, lineage: { rootLocalDataId: incoming.id } } } }, { async check() {}, async dispose() {} }))
  const preview = await service.previewGuestCopy(token, [JSON.stringify(['build', build.id])])
  expect(preview.problems).toEqual([])
  expect(preview.closure.some(record => record.kind === 'playthrough')).toBe(false)
  expect(preview.closure.some(record => record.kind === 'personal-definition')).toBe(true)
  await service.commitGuestCopy(token, preview)
  const intent = await openAccountJson(database, token, (await database.outbox.toArray())[0].ref, MappedWorkspaceIntentSchema)
  const target = await openAccountWorkspace(database, token, intent.target)
  expect(target.state.planner.localData.builds[build.id].title).toBe('Account Build')
  expect(target.state.planner.localData.selectedPlaythroughId).toBeUndefined()
  expect(target.state.planner.localData.playthroughs).toEqual({})
  const result = await prepareCopiedConflictPublication(database, token, intent, target, remote)
  const comparison = result.target.state.conflicts.find(value => value.unit.privateKey === JSON.stringify(['build', build.id]))!
  const pending = await inspectWorkspaceClosure(result.target.state, comparison.branches[0].closure)
  expect(pending.value).toEqual(build)
  const checkpoint = pending.documents.get(JSON.stringify(['build-checkpoint', build.latestRevisionId]))!.value
  expect(checkpoint).toEqual(incoming.buildRevisions[build.latestRevisionId!])
  expect(pending.documents.get('["personal-definition","pinned-item"]')!.value).toEqual(incoming.personalDefinitions['pinned-item'])
  await service.dispose()
})

it('restoresAPendingBackupWithoutItsOperationJournalAndExplicitlyPreviewsTheRetainedOriginal', async () => {
  const { createWorkspaceConflict } = await import('../workspace/conflicts')
  const { captureAccountSnapshot } = await import('../workspace/account-snapshot')
  const { exportWorkspaceBackup, readWorkspaceBackup } = await import('../interchange/workspace-backup')
  const { disposeWorkspaceSnapshot } = await import('../workspace/snapshot')
  const restore = await import('../workspace/account-restore')
  const source = await nativeCopySetup()
  const base = await prepareAccountWorkspace(source.database, source.token, source.state)
  const pending = await prepareAccountWorkspace(source.database, source.token, { ...source.state, editorDocuments: [{ ...source.state.editorDocuments[0], filename: 'Portable pending.json' }] }, base.opened)
  const accepted = await prepareAccountWorkspace(source.database, source.token, { ...source.state, editorDocuments: [{ ...source.state.editorDocuments[0], filename: 'Portable accepted.json' }] }, base.opened)
  const captured = await createWorkspaceConflict({ base: base.opened, local: pending.opened, remote: accepted.opened, privateKey: '["editor","editor-1"]' })
  const originals = { ...accepted.opened.state, conflicts: [captured.conflict], blobs: captured.blobs }
  const service = createGuestCopyService(async () => ownWorkspaceSnapshot({ version: 1, snapshotId: 'pending-originals', capturedAt: '2026-10-13', revisionVector: {}, state: originals }, { async check() {}, async dispose() {} }))
  const preview = await service.previewGuestCopy(source.token, [JSON.stringify(['conflict', captured.conflict.id])])
  await service.commitGuestCopy(source.token, preview)
  const fence = (await source.database.profileMeta.get('active'))!
  const snapshot = await captureAccountSnapshot(await openAccountWorkspace(source.database, source.token, fence.head), fence, async () => {}, { database: source.database, token: source.token })
  const backup = await readWorkspaceBackup(exportWorkspaceBackup(snapshot))
  await disposeWorkspaceSnapshot(snapshot); await service.dispose()
  const destination = await setup()
  const blank = await prepareAccountWorkspace(destination.database, destination.token, destination.state)
  await activation.activateLocalAccountCommit(destination.database, destination.token, { version: 1, id: accountLocalId(), expected: undefined, head: blank.head, records: blank.records })
  const restorePreview = await restore.previewAccountWorkspaceRestore(destination.database, destination.token, backup)
  const stage = await restore.stageAccountWorkspaceRestore(restorePreview)
  try { await restore.activateAccountWorkspaceRestore(stage) }
  finally { restore.releaseAccountWorkspaceRestorePreview(restorePreview); await restore.releaseAccountWorkspaceRestoreStage(stage); await disposeWorkspaceSnapshot(backup) }
  expect(await destination.database.migrationJournal.get(preview.copyId)).toBeUndefined()
  const reader = createGuestCopyService(async () => { throw new Error('Historical preview must not capture guest work') })
  const views = await reader.inspectCopiedComparisons(destination.token)
  const original = views.find(value => value.originalId === captured.conflict.id)!
  expect(original.historical).toBe(true)
  expect(original.versions.map(value => (value.value as { filename: string }).filename)).toEqual(['Portable pending.json', 'Portable accepted.json'])
  const fresh = await reader.previewRetainedComparison(destination.token, original.id)
  expect(fresh.copyId).not.toBe(preview.copyId)
  expect(fresh.selectedKeys).toEqual([JSON.stringify(['conflict', captured.conflict.id])])
  expect(fresh.problems).toEqual([])
  await reader.commitGuestCopy(destination.token, fresh)
  const receipt = await destination.database.migrationJournal.get(fresh.copyId)
  expect((await openAccountJson(destination.database, destination.token, receipt!.intent!, MappedWorkspaceIntentSchema)).copiedConflicts).toBeDefined()
  await reader.dispose()
})

it('retainsAClosedSourcePredecessorGroupWithoutClaimingDestinationSupersession', async () => {
  const { createWorkspaceConflict } = await import('../workspace/conflicts')
  const { stagePublicationRecord } = await import('../account/sync/publication')
  const { readOriginalPublication } = await import('../account/sync/conflict-authority')
  const { cipherRef } = await import('../workspace/account-cache')
  const { archiveWorkspaceUnit } = await import('../workspace/pending-content')
  const { validateWorkspaceClosure } = await import('../workspace/closure')
  const source = await setup(), key = '["editor","editor-1"]'
  const base = await prepareAccountWorkspace(source.database, source.token, source.state)
  const pending = await prepareAccountWorkspace(source.database, source.token, { ...source.state, editorDocuments: [{ ...source.state.editorDocuments[0], filename: 'Pending.json' }] }, base.opened)
  const accepted = await prepareAccountWorkspace(source.database, source.token, { ...source.state, editorDocuments: [{ ...source.state.editorDocuments[0], filename: 'Accepted.json' }] }, base.opened)
  await source.database.encryptedRevisions.bulkAdd([...base.records, ...pending.records, ...accepted.records])
  const publish = async (workspace: typeof base, parent?: import('./account-database').CipherRef) => cipherRef(await stagePublicationRecord(source.database, source.token, workspace.entries.find(value => value.key === key)!, base.opened.lineageId, parent))
  const ancestor = await readOriginalPublication(source.database, source.token, await publish(base))
  const mine = await readOriginalPublication(source.database, source.token, await publish(pending, ancestor.ref))
  const theirs = await readOriginalPublication(source.database, source.token, await publish(accepted, ancestor.ref))
  const authority: import('../workspace/conflict-authority').ConflictAuthority = { version: 1, unit: { kind: 'record', privateKey: key }, lineageId: base.opened.lineageId, commonAncestor: { kind: 'present', publication: ancestor }, branches: [{ role: 'local-pending', publication: mine }, { role: 'accepted-cloud', publication: theirs }] }
  const captured = await createWorkspaceConflict({ base: base.opened, local: pending.opened, remote: accepted.opened, privateKey: key, authority })
  const group = await prepareAccountWorkspace(source.database, source.token, { ...accepted.opened.state, conflicts: [captured.conflict], blobs: captured.blobs }, accepted.opened)
  await source.database.encryptedRevisions.bulkAdd(group.records)
  const prior = await readOriginalPublication(source.database, source.token, cipherRef(await stagePublicationRecord(source.database, source.token, group.entries.find(value => value.key === JSON.stringify(['conflict', captured.conflict.id]))!, base.opened.lineageId, undefined, authority)))
  const newer = await readOriginalPublication(source.database, source.token, await publish(accepted, theirs.ref))
  const id = accountLocalId(), blobs = new Map(captured.blobs.map(blob => [blobIdentity(blob.ref), blob]))
  const tip = { ...captured.conflict, id, branches: [{ role: 'local-pending' as const, closure: await archiveWorkspaceUnit(pending.opened, key, blobs, mine, { kind: 'conflict-successor', conflictId: id, priorId: captured.conflict.id, prior, unit: captured.conflict.unit }) }, { role: 'accepted-cloud' as const, closure: await archiveWorkspaceUnit(accepted.opened, key, blobs, newer) }] as const }
  const portable = { ...accepted.opened.state, conflicts: [captured.conflict, tip], blobs: [...blobs.values()] }
  await validateWorkspaceClosure(portable)
  const target = await setup()
  const current = await prepareAccountWorkspace(target.database, target.token, { ...accepted.opened.state, blobs: source.state.blobs })
  await activation.activateLocalAccountCommit(target.database, target.token, { version: 1, id: accountLocalId(), expected: undefined, head: current.head, records: current.records })
  const service = createGuestCopyService(async () => ownWorkspaceSnapshot({ version: 1, snapshotId: 'closed-source-group', capturedAt: '2026-10-13', revisionVector: {}, state: portable }, { async check() {}, async dispose() {} }))
  const preview = await service.previewGuestCopy(target.token, [JSON.stringify(['conflict', id])])
  expect(preview.closure.some(value => value.key === JSON.stringify(['conflict', captured.conflict.id]))).toBe(true)
  await service.commitGuestCopy(target.token, preview)
  const { readCopiedConflicts } = await import('../workspace/copied-conflicts')
  const intent = await openAccountJson(target.database, target.token, (await target.database.outbox.toArray())[0].ref, MappedWorkspaceIntentSchema)
  const entries = await readCopiedConflicts(target.database, target.token, intent)
  expect(entries).toHaveLength(1)
  expect(entries[0].original!.conflictId).toBe(id)
  const saved = await openAccountWorkspace(target.database, target.token, entries[0].original!.source)
  expect(new Set(saved.state.conflicts.map(value => value.id))).toEqual(new Set([captured.conflict.id, id]))
  await validateWorkspaceClosure(saved.state)
  await service.dispose()
})

it.each(['live', 'archived-only', 'different-live'] as const)('doesNotActivateAnUncheckedSampleBuildThroughAnImportedComparison: %s', async location => {
  const { addTestBuild, createTestLocalData } = await import('../domain/test-helpers')
  const { createWorkspaceConflict } = await import('../workspace/conflicts')
  const source = await setup()
  const data = addTestBuild(createTestLocalData(), 'sample-build', '', {})
  const build = Object.values(data.builds)[0]
  const state = { ...source.state, planner: { ...source.state.planner, localData: { ...data, builds: { [build.id]: { ...build, tags: ['sample'] } } }, lineage: { rootLocalDataId: data.id } } }
  const base = await prepareAccountWorkspace(source.database, source.token, state)
  const pending = await prepareAccountWorkspace(source.database, source.token, { ...state, planner: { ...state.planner, localData: { ...state.planner.localData, builds: { [build.id]: { ...state.planner.localData.builds[build.id], title: 'Edited sample' } } } } }, base.opened)
  const captured = await createWorkspaceConflict({ base: base.opened, local: pending.opened, remote: base.opened, privateKey: JSON.stringify(['build', build.id]) })
  const portable = { ...(location === 'archived-only' ? source.state : location === 'different-live' ? pending.opened.state : state), conflicts: [captured.conflict], blobs: captured.blobs }
  const target = await nativeCopySetup()
  const service = createGuestCopyService(async () => ownWorkspaceSnapshot({ version: 1, snapshotId: 'sample-comparison', capturedAt: '2026-10-13', revisionVector: {}, state: portable }, { async check() {}, async dispose() {} }))
  const key = JSON.stringify(['conflict', captured.conflict.id]), sample = JSON.stringify(['build', build.id])
  const blocked = await service.previewGuestCopy(target.token, [key])
  expect(blocked.problems.some(problem => problem.includes('Explicitly select the required sample'))).toBe(true)
  await expect(service.commitGuestCopy(target.token, blocked)).rejects.toThrow()
  expect(await target.database.outbox.count()).toBe(0)
  const consent = blocked.records.find(record => record.key.startsWith('["conflict-sample"'))?.key ?? sample
  if (location === 'different-live') expect((await service.previewGuestCopy(target.token, [key, sample])).problems.some(problem => problem.includes('Explicitly select the required sample'))).toBe(true)
  const selected = await service.previewGuestCopy(target.token, [key, consent])
  expect(selected.problems).toEqual([])
  await service.commitGuestCopy(target.token, selected)
  const active = await openAccountWorkspace(target.database, target.token, (await target.database.profileMeta.get('active'))!.head)
  expect(active.state.planner.localData.builds[build.id]).toEqual(state.planner.localData.builds[build.id])
  await service.dispose()
})

it('requiresSelectedCompleteOwnerForAnImportedChildComparison', async () => {
  const { createTestLocalData, addTestCharacter, TEST_PLAYTHROUGH_ID } = await import('../domain/test-helpers')
  const { createWorkspaceConflict } = await import('../workspace/conflicts')
  const source = await nativeCopySetup()
  const data = addTestCharacter(createTestLocalData(), 'child')
  const state = { ...source.state, planner: { ...source.state.planner, localData: data, lineage: { rootLocalDataId: data.id } } }
  const base = await prepareAccountWorkspace(source.database, source.token, state)
  const branch = async (name: string) => {
    const owner = data.playthroughs[TEST_PLAYTHROUGH_ID]
    return prepareAccountWorkspace(source.database, source.token, { ...state, planner: { ...state.planner, localData: { ...data, playthroughs: { ...data.playthroughs, [TEST_PLAYTHROUGH_ID]: { ...owner, characters: { ...owner.characters, child: { ...owner.characters.child, name } } } } } } }, base.opened)
  }
  const pending = await branch('Pending child'), accepted = await branch('Accepted child')
  const key = JSON.stringify(['character', TEST_PLAYTHROUGH_ID, 'child'])
  const captured = await createWorkspaceConflict({ base: base.opened, local: pending.opened, remote: accepted.opened, privateKey: key })
  const portable = { ...accepted.opened.state, conflicts: [captured.conflict], blobs: captured.blobs }
  const original = await inspectWorkspaceClosure(portable, captured.conflict.branches[0].closure)
  expect([...original.documents.values()].some(document => document.kind === 'inventory')).toBe(false)
  const conflictKey = JSON.stringify(['conflict', captured.conflict.id])
  const service = createGuestCopyService(async () => ownWorkspaceSnapshot({ version: 1, snapshotId: 'child-source', capturedAt: '2026-10-13', revisionVector: {}, state: portable }, { async check() {}, async dispose() {} }))
  await expect(service.previewGuestCopy(source.token, [conflictKey])).rejects.toThrow('complete owning Playthrough')
  const preview = await service.previewGuestCopy(source.token, [conflictKey, JSON.stringify(['playthrough', TEST_PLAYTHROUGH_ID])])
  expect(preview.problems).toEqual([])
  expect(preview.closure.some(document => document.kind === 'inventory')).toBe(true)
  await service.commitGuestCopy(source.token, preview)
  const intent = await openAccountJson(source.database, source.token, (await source.database.outbox.toArray())[0].ref, MappedWorkspaceIntentSchema)
  const { readCopiedConflicts } = await import('../workspace/copied-conflicts')
  const registration = (await readCopiedConflicts(source.database, source.token, intent))[0]
  const projected = await openAccountWorkspace(source.database, source.token, registration.source)
  expect(projected.state.planner.localData.playthroughs[TEST_PLAYTHROUGH_ID].characters.child.name).toBe('Pending child')
  expect(projected.state.planner.localData.playthroughs[TEST_PLAYTHROUGH_ID].inventory).toEqual(data.playthroughs[TEST_PLAYTHROUGH_ID].inventory)
  await service.dispose()
})

it('preservesAnAdvancedStagedCopyAsDownloadableHistoryAndStartsAFreshOperation', async () => {
  const { exportWorkspaceBackup, readWorkspaceBackup } = await import('../interchange/workspace-backup')
  const { disposeWorkspaceSnapshot } = await import('../workspace/snapshot')
  const { token, database, capture, state } = await nativeCopySetup()
  const service = createGuestCopyService(capture)
  const preview = await service.previewGuestCopy(token, ['["editor","editor-1"]'])
  const fail = vi.spyOn(activation, 'activateLocalAccountCommit').mockRejectedValueOnce(new Error('Injected activation failure'))
  await expect(service.commitGuestCopy(token, preview)).rejects.toThrow('Injected activation failure')
  fail.mockRestore()
  const saved = (await database.syncState.get(`guest-copy:${preview.copyId}`))!
  const ciphertext = await database.encryptedRevisions.toArray()
  const chunks = await database.stagedCipherChunks.toArray()
  await service.dispose()
  const expected = (await database.profileMeta.get('active'))!
  const previous = await openAccountWorkspace(database, token, expected.head)
  const addition = { ...state.editorDocuments[0], id: 'account-addition', filename: 'Account addition.json' }
  const advanced = await prepareAccountWorkspace(database, token, { ...state, editorDocuments: [addition] }, previous)
  await activation.activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected, head: advanced.head, records: advanced.records })
  const reopened = createGuestCopyService(capture)
  const stale = await reopened.previewGuestCopy(token)
  expect(stale.copyId).toBe(preview.copyId)
  expect(stale.problems.join(' ')).toContain('account changed')
  await expect(reopened.commitGuestCopy(token, stale)).rejects.toThrow()
  expect(await reopened.keepSavedCopyAndRepreview(token, stale)).toEqual({ activated: false })
  expect(await database.syncState.get('guest-copy:pending')).toBeUndefined()
  expect(await database.syncState.get(saved.id)).toEqual(saved)
  await expect(reopened.commitGuestCopy(token, stale)).rejects.toThrow('Reopen')
  expect(await reopened.listSavedGuestCopies(token)).toEqual([expect.objectContaining({ copyId: preview.copyId, activated: false, pending: false })])
  await reopened.withSavedGuestCopy(token, preview.copyId, async snapshot => {
    const restored = await readWorkspaceBackup(exportWorkspaceBackup(snapshot))
    try {
      expect(restored.state.editorDocuments.map(value => value.id)).toEqual(['editor-1'])
      expect(restored.state.editorDocuments[0].unfinished.validation).toBe('invalid')
      const original = state.blobs[0], copied = restored.state.blobs.find(blob => blobIdentity(blob.ref) === blobIdentity(original.ref))!
      expect(await readBlob(copied.content, copied.ref.byteLength)).toEqual(await readBlob(original.content, original.ref.byteLength))
      expect(restored.version).toBe(2)
    } finally { await disposeWorkspaceSnapshot(restored) }
  })
  const fresh = await reopened.previewGuestCopy(token, ['["editor","editor-1"]'])
  expect(fresh.copyId).not.toBe(preview.copyId)
  const receipt = await reopened.commitGuestCopy(token, fresh)
  expect(receipt.mappings.filter(value => value.key === '["editor","editor-1"]')).toHaveLength(1)
  const active = await openAccountWorkspace(database, token, (await database.profileMeta.get('active'))!.head)
  expect(active.state.editorDocuments.map(value => value.id).sort()).toEqual(['account-addition', 'editor-1'])
  expect(active.state.editorDocuments.find(value => value.id === 'account-addition')).toEqual(addition)
  expect(await database.migrationJournal.get(preview.copyId)).toBeUndefined()
  expect(await database.outbox.count()).toBe(1)
  for (const record of ciphertext) expect(await database.encryptedRevisions.get(record.revisionId)).toEqual(record)
  for (const chunk of chunks) expect(await database.stagedCipherChunks.get([chunk.payloadId, chunk.index])).toEqual(chunk)
  expect(await database.syncState.get(saved.id)).toEqual(saved)
  await reopened.dispose()
})
it('recognizesAnActivatedSavedCopyBeforeRetiringItsLostAcknowledgmentPointer', async () => {
  const { token, database, capture } = await nativeCopySetup()
  const service = createGuestCopyService(capture)
  const preview = await service.previewGuestCopy(token, ['["editor","editor-1"]'])
  await service.commitGuestCopy(token, preview)
  const row = (await database.syncState.get(`guest-copy:${preview.copyId}`))!
  await database.syncState.put({ id: 'guest-copy:pending', ref: row.ref })
  await service.dispose()
  const reopened = createGuestCopyService(capture)
  const saved = await reopened.previewGuestCopy(token)
  expect(saved.problems).toEqual([])
  const receipt = (await database.migrationJournal.get(preview.copyId))!
  await database.migrationJournal.put({ ...receipt, head: receipt.intent! })
  await expect(reopened.previewGuestCopy(token)).rejects.toThrow('receipt does not match')
  await expect(reopened.keepSavedCopyAndRepreview(token, saved)).rejects.toThrow('receipt does not match')
  expect(await database.syncState.get('guest-copy:pending')).toBeDefined()
  await database.migrationJournal.put(receipt)
  expect(await reopened.keepSavedCopyAndRepreview(token, saved)).toEqual({ activated: true })
  expect(await database.outbox.count()).toBe(1)
  expect(await reopened.listSavedGuestCopies(token)).toEqual([expect.objectContaining({ copyId: preview.copyId, activated: true, pending: false })])
  await reopened.dispose()
})

it('fencesSavedCopyRecoveryAndDownloadWhenItsProfileIsRetired', async () => {
  const { token, database, capture } = await nativeCopySetup()
  const service = createGuestCopyService(capture)
  const preview = await service.previewGuestCopy(token, ['["editor","editor-1"]'])
  const fail = vi.spyOn(activation, 'activateLocalAccountCommit').mockRejectedValueOnce(new Error('Injected activation failure'))
  await expect(service.commitGuestCopy(token, preview)).rejects.toThrow('Injected activation failure')
  fail.mockRestore()
  const saved = await service.previewGuestCopy(token)
  await expect(service.withSavedGuestCopy(token, preview.copyId, async () => { invalidateProfile() })).rejects.toThrow()
  await expect(service.keepSavedCopyAndRepreview(token, saved)).rejects.toThrow()
  await expect(service.listSavedGuestCopies(token)).rejects.toThrow()
  expect(await database.syncState.get('guest-copy:pending')).toBeDefined()
  expect(await database.outbox.count()).toBe(0)
  await service.dispose()
})
