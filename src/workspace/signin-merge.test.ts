import { now, workspace, progress } from './signin-merge.test-helpers'
import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import * as accountActivation from '../persistence/account-database'
import { createBlankLocalData, createPlaythrough } from '../domain/local-data'
import type { PlaythroughId } from '../domain/types'
import { LAUNCH_DATA_GENERATION } from '../domain/data-generation'
import { AccountDatabase, activateLocalAccountCommit } from '../persistence/account-database'
import { installProfile, invalidateProfile } from '../account/profile'
import { accountLocalId, openAccountJson } from './account-cache'
import { createGuestCopyService } from './guest-copy'
import { prepareAccountWorkspace, openAccountWorkspace } from './account-graph'
import { ownWorkspaceSnapshot } from './snapshot'
import { privateRecordKey, type WorkspaceState } from './documents'
import { editorClosureFixture } from './test-helpers'
import { MappedWorkspaceIntentSchema } from './account-intents'
import { readCopiedConflicts } from './copied-conflicts'

// Keep production membership intact while giving isolated writer contracts a bounded exact source
vi.mock('../catalog/bundled', async importOriginal => {
  const actual = await importOriginal<typeof import('../catalog/bundled')>()
  const { SYNTHETIC_PACKAGED_CATALOG } = await import('./catalog-writer.test-helpers')
  return { ...actual, BUNDLED_CATALOGS: Object.freeze([...actual.BUNDLED_CATALOGS, SYNTHETIC_PACKAGED_CATALOG]) }
})

const databases: AccountDatabase[] = []
afterEach(async () => { invalidateProfile(); for (const database of databases.splice(0)) await database.delete() })
async function setup(source: WorkspaceState, destination = workspace(createBlankLocalData({ now }))) {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  databases.push(database)
  const initial = await prepareAccountWorkspace(database, token, destination)
  await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: initial.head, records: initial.records })
  const service = createGuestCopyService(async () => ownWorkspaceSnapshot({ dataGeneration: LAUNCH_DATA_GENERATION, version: 1, snapshotId: 'signin', capturedAt: now, revisionVector: {}, state: source }, { async check() {}, async dispose() {} }))
  const active = async () => (await openAccountWorkspace(database, token, (await database.profileMeta.get('active'))!.head)).state
  return { token, database, service, active }
}
it('selects meaningful preferences explicitly without adding a blank manual-copy conflict', async () => {
  const source = workspace({ ...createBlankLocalData({ now }), modSetup: { version: 1, state: 'completed' } })
  const { token, service, active } = await setup(source)
  try {
    const manual = await service.previewGuestCopy(token)
    expect(manual.selectedKeys).toEqual([])
    expect(manual.conflicts).toEqual([])
    const preview = await service.previewSigninMerge(token)
    expect(preview.selectedKeys).toContain('["workspace-preferences"]')
    expect(preview.problems).toEqual([])
    await service.commitGuestCopy(token, preview)
    expect((await active()).planner.localData.modSetup).toEqual(source.planner.localData.modSetup)
  } finally { await service.dispose() }
})
it('retains orphan archived bodies even when no live owner exists', async () => {
  const { state } = await editorClosureFixture(), { token, service, active } = await setup(state)
  try {
    const preview = await service.previewSigninMerge(token)
    expect(preview.selectedKeys).toContain('["retained-content","pending-1"]')
    await service.commitGuestCopy(token, preview)
    expect((await active()).retainedContent).toEqual(state.retainedContent)
  } finally { await service.dispose() }
})
it('deduplicates proven equivalent Progress across IDs and bookkeeping without mutating originals', async () => {
  const source = progress('local'), destination = progress('account')
  Object.assign(source.planner.localData.playthroughs.play.progress.local, { revision: 3, updatedAt: '2026-11-15T00:00:00.000Z' })
  const original = JSON.stringify(source), { token, service, active } = await setup(source, destination)
  try {
    const preview = await service.previewSigninMerge(token)
    expect(preview.conflicts).not.toContain(privateRecordKey('progress', 'play', 'account'))
    const receipt = await service.commitGuestCopy(token, preview)
    expect(Object.keys((await active()).planner.localData.playthroughs.play.progress)).toEqual(['account'])
    expect(await service.commitGuestCopy(token, preview)).toEqual(receipt)
    expect(JSON.stringify(source)).toBe(original)
  } finally { await service.dispose() }
})
it('keeps account Progress active and records an explicit exact-source mapping for disagreement', async () => {
  const source = progress('local', false), destination = progress('account')
  const { token, database, service, active } = await setup(source, destination)
  try {
    const preview = await service.previewSigninMerge(token)
    expect(preview.conflicts).toContain(privateRecordKey('progress', 'play', 'account'))
    await service.commitGuestCopy(token, preview)
    expect((await active()).planner.localData.playthroughs.play.progress).toEqual(destination.planner.localData.playthroughs.play.progress)
    const intent = await openAccountJson(database, token, (await database.outbox.toArray())[0].ref, MappedWorkspaceIntentSchema)
    const entries = await readCopiedConflicts(database, token, intent)
    expect(entries.find(entry => entry.privateKey === '["progress","play","account"]')).toMatchObject({ progressMapping: { version: 1, sourceKey: '["progress","play","local"]' } })
  } finally { await service.dispose() }
})
it('ignores only Playthrough child-edit bookkeeping when proving equivalent Progress', async () => {
  const source = progress('local'), destination = progress('account')
  Object.assign(source.planner.localData.playthroughs.play, { revision: 9, updatedAt: '2026-11-15T00:00:00.000Z' })
  const { token, service, active } = await setup(source, destination)
  try {
    const preview = await service.previewSigninMerge(token)
    expect(preview.conflicts).toEqual([])
    await service.commitGuestCopy(token, preview)
    expect(Object.keys((await active()).planner.localData.playthroughs.play.progress)).toEqual(['account'])
  } finally { await service.dispose() }
})
it.each(['observedAt', 'sources', 'masterLocation'] as const)('does not deduplicate distinct observation provenance: %s', async field => {
  const source = progress('local'), destination = progress('account')
  Object.assign(source.planner.localData.playthroughs.play.progress.local, field === 'observedAt' ? { observedAt: now } : field === 'sources' ? { sources: [{ sourceId: 'personal-note', applicability: 'Observed elsewhere' }] } : { masterLocation: { state: 'unknown', reason: 'Check this cave' } })
  const { token, service } = await setup(source, destination)
  try { expect((await service.previewSigninMerge(token)).conflicts).toContain('["progress","play","account"]') }
  finally { await service.dispose() }
})
it('keeps ambiguous same-subject observation groups reviewable instead of choosing one', async () => {
  const source = progress('local'), destination = progress('account')
  Object.assign(destination.planner.localData.playthroughs.play.progress, { duplicate: { ...destination.planner.localData.playthroughs.play.progress.account, id: 'duplicate' } })
  const { token, service } = await setup(source, destination)
  try {
    const preview = await service.previewSigninMerge(token)
    expect(preview.problems.length).toBeGreaterThan(0)
    await expect(service.commitGuestCopy(token, preview)).rejects.toThrow('Resolve')
  } finally { await service.dispose() }
})

it('reopens an activated sign-in copy by durable ID without recapturing the local source', async () => {
  const { token, service } = await setup(progress('local'), progress('account'))
  const preview = await service.previewSigninMerge(token)
  const receipt = await service.commitGuestCopy(token, preview)
  await service.dispose()
  const reopened = createGuestCopyService(async () => { throw new Error('Must not recapture') })
  try {
    const saved = await reopened.previewSigninMerge(token, receipt.copyId)
    expect(saved.copyId).toBe(receipt.copyId)
    expect(saved.resumable).toBe(true)
    expect(await reopened.commitGuestCopy(token, saved)).toEqual(receipt)
  } finally { await reopened.dispose() }
})
it('keeps distinct same-label Playthroughs separate', async () => {
  const source = workspace(createPlaythrough(createBlankLocalData({ now }), { id: 'local' as PlaythroughId, label: 'Run', now }))
  const destination = workspace(createPlaythrough(createBlankLocalData({ now }), { id: 'account' as PlaythroughId, label: 'Run', now }))
  const { token, service, active } = await setup(source, destination)
  try {
    await service.commitGuestCopy(token, await service.previewSigninMerge(token))
    expect(Object.keys((await active()).planner.localData.playthroughs).sort()).toEqual(['account', 'local'])
  } finally { await service.dispose() }
})
it('retains account preferences on meaningful disagreement', async () => {
  const source = workspace({ ...createBlankLocalData({ now }), modSetup: { version: 1, state: 'completed' } })
  const destination = workspace({ ...createBlankLocalData({ now }), modSetup: { version: 1, state: 'skipped' } })
  const { token, service, active } = await setup(source, destination)
  try {
    const preview = await service.previewSigninMerge(token)
    expect(preview.conflicts).toContain('["workspace-preferences"]')
    await service.commitGuestCopy(token, preview)
    expect((await active()).planner.localData.modSetup).toEqual(destination.planner.localData.modSetup)
  } finally { await service.dispose() }
})
it('preserves distinct inventory observations without adding quantities', async () => {
  const { observeInventory } = await import('../domain/inventory')
  const item = { kind: 'personal' as const, definitionId: 'subject' as import('../domain/types').PersonalDefinitionId }
  const source = workspace(observeInventory(progress('local').planner.localData, { ref: item, possession: 'owned', quantity: { kind: 'exact', value: 2 }, now }))
  const destination = workspace(observeInventory(progress('account').planner.localData, { ref: item, possession: 'owned', quantity: { kind: 'exact', value: 3 }, now }))
  const { token, service, active } = await setup(source, destination)
  try {
    const preview = await service.previewSigninMerge(token)
    expect(preview.conflicts).toContain('["inventory","play"]')
    await service.commitGuestCopy(token, preview)
    expect((await active()).planner.localData.playthroughs.play.inventory).toEqual(destination.planner.localData.playthroughs.play.inventory)
  } finally { await service.dispose() }
})
it('keeps conflicting immutable subject definitions and dependent Progress out of active data', async () => {
  const source = progress('local'), destination = progress('account')
  Object.assign(source.planner.localData.personalDefinitions.subject, { name: 'Different source definition' })
  const { token, service, active } = await setup(source, destination)
  try {
    const preview = await service.previewSigninMerge(token)
    expect(preview.conflicts).toContain('["progress","play","account"]')
    await service.commitGuestCopy(token, preview)
    const state = await active()
    expect(state.planner.localData.personalDefinitions).toEqual(destination.planner.localData.personalDefinitions)
    expect(state.planner.localData.playthroughs.play.progress).toEqual(destination.planner.localData.playthroughs.play.progress)
  } finally { await service.dispose() }
})
it('does not collapse observations of different exact source revisions in one logical lineage', async () => {
  const { revisePersonalDefinition } = await import('../domain/local-data')
  const source = progress('local'), destination = progress('account')
  const revised = revisePersonalDefinition(source.planner.localData, { sourceRef: source.planner.localData.playthroughs.play.progress.local.subject, name: 'Revised class', now })
  const definition = Object.values(revised.localData.personalDefinitions).find(value => value.name === 'Revised class')!
  Object.assign(source.planner, { localData: revised.localData })
  Object.assign(source.planner.localData.playthroughs.play.progress.local, { subject: { kind: 'personal', definitionId: definition.id } })
  const { token, service } = await setup(source, destination)
  try { expect((await service.previewSigninMerge(token)).conflicts).toContain('["progress","play","account"]') }
  finally { await service.dispose() }
})
it('discloses required starter companions of an edited Team without changing manual defaults', async () => {
  const { createSampleLocalData } = await import('../domain/sample-data')
  const { DEFAULT_CATALOG } = await import('../catalog/bundled')
  const local = createSampleLocalData(DEFAULT_CATALOG, now), team = Object.values(local.teams)[0]
  Object.assign(team, { title: 'My edited Team' })
  const source = workspace(local)
  Object.assign(source.planner, { catalogs: [DEFAULT_CATALOG] })
  const { token, service } = await setup(source)
  try {
    expect((await service.previewGuestCopy(token)).selectedKeys).toEqual([])
    const preview = await service.previewSigninMerge(token)
    expect(preview.selectedKeys).toContain(privateRecordKey('team', team.id))
    expect(preview.problems).toEqual([])
    expect(preview.signin?.requiredCompanionKeys.length).toBeGreaterThan(0)
    expect(preview.closure.some(record => record.kind === 'build-checkpoint')).toBe(true)
  } finally { await service.dispose() }
})
it('adds independent Builds and files with exact bodies', async () => {
  const { createPlaythroughWithSetup } = await import('../domain/game-setups')
  const { createBuild } = await import('../domain/builds')
  const starter = createPlaythroughWithSetup(createBlankLocalData({ now }), { label: 'Run', catalogLock: {}, now })
  const local = createBuild(starter, { gameSetupId: Object.values(starter.gameSetups)[0].gameSetupId, title: 'Independent Build', now })
  const build = Object.values(local.builds).find(value => value.title === 'Independent Build')!
  const fixture = await editorClosureFixture()
  const source = { ...workspace(local), editorDocuments: [fixture.file], blobs: fixture.blobs }
  const { token, service, active } = await setup(source)
  try {
    const preview = await service.previewSigninMerge(token)
    expect(preview.problems).toEqual([])
    await service.commitGuestCopy(token, preview)
    const state = await active()
    expect(Object.keys(state.planner.localData.builds)).toEqual([build.id])
    expect(state.editorDocuments).toEqual([fixture.file])
    const { blobIdentity, readBlob } = await import('./blobs')
    const body = state.blobs.find(blob => blobIdentity(blob.ref) === blobIdentity(fixture.file.original))!
    expect(await readBlob(body.content, body.ref.byteLength)).toEqual(new Uint8Array([0, 216]))
  } finally { await service.dispose() }
})
it.each(['missing', ''])('fails closed for an unavailable saved copy without capturing a new source: %s', async copyId => {
  const { token, service } = await setup(progress('local'))
  try { await expect(service.previewSigninMerge(token, copyId)).rejects.toThrow('unavailable') }
  finally { await service.dispose() }
})
it('publishes a self-contained Progress identity association and rejects forged or missing evidence', async () => {
  const { preparePublicationAttempt } = await import('../account/sync/publication')
  const { openRemoteProjection } = await import('../account/sync/projection')
  const { prepareCopiedConflictPublication } = await import('./copied-conflicts')
  const { validateWorkspaceClosure } = await import('./closure')
  const { blobIdentity } = await import('./blobs')
  const source = progress('local', false), destination = progress('account')
  const { token, database, service } = await setup(source, destination)
  try {
    const base = await openAccountWorkspace(database, token, (await database.profileMeta.get('active'))!.head)
    const initial = await preparePublicationAttempt(database, token, base, null, new Map(), 0)
    const heads = new Map(initial.final.heads.map(ref => [ref.documentId, ref.revisionId]))
    const remote = (await openRemoteProjection(database, token, heads, base.head, 0))!
    await service.commitGuestCopy(token, await service.previewSigninMerge(token))
    const intent = await openAccountJson(database, token, (await database.outbox.toArray())[0].ref, MappedWorkspaceIntentSchema)
    const target = await openAccountWorkspace(database, token, intent.target)
    const prepared = await prepareCopiedConflictPublication(database, token, intent, target, remote)
    const state = prepared.target.state, conflict = state.conflicts[0]
    expect(conflict.progressIdentity).toMatchObject({ version: 1, sourceKey: '["progress","play","local"]', destinationKey: '["progress","play","account"]' })
    await expect(validateWorkspaceClosure(state)).resolves.toBeUndefined()
    const { inspectWorkspaceClosure } = await import('./closure')
    const { validateSigninProgressIdentity } = await import('./signin-progress-evidence')
    const pending = await inspectWorkspaceClosure(state, conflict.branches[0].closure)
    const accepted = await inspectWorkspaceClosure(state, conflict.branches[1].closure)
    const unrelated = new Map(accepted.documents), acceptedRecord = unrelated.get(conflict.unit.privateKey)!
    unrelated.set(conflict.unit.privateKey, { ...acceptedRecord, value: { ...(acceptedRecord.value as object), subject: { kind: 'personal', definitionId: 'unrelated-subject' } } as typeof acceptedRecord.value })
    await expect(validateSigninProgressIdentity(state, conflict, pending.documents, unrelated)).rejects.toThrow()
    for (const patch of [{ sourceKey: '["progress","play","missing"]' }, { sourceIdentity: 'f'.repeat(64) }, { sourceDigest: 'f'.repeat(64) }, { destinationKey: '["progress","other","account"]' }]) {
      await expect(validateWorkspaceClosure({ ...state, conflicts: [{ ...conflict, progressIdentity: { ...conflict.progressIdentity!, ...patch } }] })).rejects.toThrow()
    }
    const metadataKey = blobIdentity(conflict.progressIdentity!.sourceMetadata)
    const { historicalMetadataIdentity, readBackupMetadata, metadataSource } = await import('../interchange/workspace-backup-evidence')
    const originalMetadata = await readBackupMetadata(state.blobs.find(blob => blobIdentity(blob.ref) === metadataKey)!.content) as import('../interchange/workspace-backup-evidence').SnapshotMetadataV1
    const { encodeBackupJson } = await import('../interchange/workspace-backup-json')
    const { stageAccountSource, openAccountSource } = await import('./account-streams')
    const { cipherRef } = await import('./account-cache')
    const pages = [...encodeBackupJson(originalMetadata, 256)]
    const paged = { byteLength: pages.reduce((length, page) => length + page.length, 0), async *open() { yield* pages } }
    const identity = await historicalMetadataIdentity(paged)
    const encrypted = await stageAccountSource(database, token, paged, [])
    await database.encryptedRevisions.add(encrypted)
    const content = await openAccountSource(database, token, cipherRef(encrypted))
    expect(await historicalMetadataIdentity(content)).toEqual(identity)
    const ref = { ...conflict.progressIdentity!.sourceMetadata, documentId: `progress-original:${identity.id}`, revisionId: identity.metadataStreamDigest, byteLength: content.byteLength, sha256: identity.metadataStreamDigest }
    const transported = { ...conflict, progressIdentity: { ...conflict.progressIdentity!, sourceMetadata: ref, sourceIdentity: identity.id, sourceDigest: identity.metadataStreamDigest } }
    const transportedState = { ...state, conflicts: [transported], blobs: state.blobs.map(blob => blobIdentity(blob.ref) === metadataKey ? { ref, content } : blob) }
    await expect(validateSigninProgressIdentity(transportedState, transported, pending.documents, accepted.documents)).resolves.toBeUndefined()
    for (const kind of ['malformed', 'observation', 'dependency'] as const) {
      const raw = structuredClone(originalMetadata)
      if (kind === 'observation') Object.assign(raw.state.planner.localData.playthroughs.play.progress.local, { observedAt: now })
      if (kind === 'dependency') Object.assign(raw.state.planner.localData.personalDefinitions.subject, { name: 'Forged original' })
      const content = metadataSource(kind === 'malformed' ? {} : raw), digest = await historicalMetadataIdentity(content)
      const ref = { ...conflict.progressIdentity!.sourceMetadata, byteLength: content.byteLength, sha256: digest.metadataStreamDigest }
      const changed = { ...conflict, progressIdentity: { ...conflict.progressIdentity!, sourceMetadata: ref, sourceIdentity: digest.id, sourceDigest: digest.metadataStreamDigest } }
      await expect(validateWorkspaceClosure({ ...state, conflicts: [changed], blobs: state.blobs.map(blob => blobIdentity(blob.ref) === metadataKey ? { ref, content } : blob) })).rejects.toThrow()
    }
    await expect(validateWorkspaceClosure({ ...state, blobs: state.blobs.filter(blob => blobIdentity(blob.ref) !== metadataKey) })).rejects.toThrow()
    const imported = createGuestCopyService(async () => ownWorkspaceSnapshot({ dataGeneration: LAUNCH_DATA_GENERATION, version: 1, snapshotId: 'recopied-comparison', capturedAt: now, revisionVector: {}, state }, { async check() {}, async dispose() {} }))
    try {
      const preview = await imported.previewGuestCopy(token, [privateRecordKey('conflict', conflict.id), privateRecordKey('playthrough', 'play')])
      await imported.commitGuestCopy(token, preview)
      const { GuestCopyJournalSchema } = await import('./guest-copy-journal')
      const journal = await openAccountJson(database, token, (await database.syncState.get(`guest-copy:${preview.copyId}`))!.ref, GuestCopyJournalSchema)
      const copiedIntent = await openAccountJson(database, token, journal.intent, MappedWorkspaceIntentSchema)
      const copiedTarget = await openAccountWorkspace(database, token, copiedIntent.target)
      const reconstructed = await prepareCopiedConflictPublication(database, token, copiedIntent, copiedTarget, remote)
      expect(reconstructed.target.state.conflicts[0].progressIdentity).toEqual(conflict.progressIdentity)
      await expect(validateWorkspaceClosure(reconstructed.target.state)).resolves.toBeUndefined()
      const different = await prepareAccountWorkspace(database, token, progress('account', false))
      await database.encryptedRevisions.bulkAdd(different.records)
      const differentPublication = await preparePublicationAttempt(database, token, different.opened, null, new Map(), 0)
      const differentHeads = new Map(differentPublication.final.heads.map(ref => [ref.documentId, ref.revisionId]))
      const differentRemote = (await openRemoteProjection(database, token, differentHeads, different.head, 0))!
      const collision = await prepareCopiedConflictPublication(database, token, copiedIntent, copiedTarget, differentRemote)
      expect(collision.target.state.conflicts).toHaveLength(1)
      expect(collision.target.state.conflicts[0].progressIdentity).toBeUndefined()
      await expect(validateWorkspaceClosure(collision.target.state)).resolves.toBeUndefined()
    } finally { await imported.dispose() }
  } finally { await service.dispose() }
})
it('recopies compact Progress comparisons with exact source bindings and independent retained catalog bodies', async () => {
  vi.stubGlobal('__CRYKIT_COMPACT_CATALOG_QUALIFICATION__', true)
  const { SYNTHETIC_PACKAGED_CATALOG } = await import('./catalog-writer.test-helpers')
  const { preparePublicationAttempt } = await import('../account/sync/publication')
  const { openRemoteProjection } = await import('../account/sync/projection')
  const { prepareCopiedConflictPublication } = await import('./copied-conflicts')
  const { validateWorkspaceClosure, archiveTypedReferences } = await import('./closure')
  const { hashBlob, blobIdentity } = await import('./blobs')
  const { GuestCopyJournalSchema } = await import('./guest-copy-journal')
  const withCatalog = (state: WorkspaceState): WorkspaceState => ({ ...state, planner: { ...state.planner, catalogs: [SYNTHETIC_PACKAGED_CATALOG] }, libraryDefaults: { version: 1, layers: [{ catalogId: SYNTHETIC_PACKAGED_CATALOG.id, catalogRevisionId: SYNTHETIC_PACKAGED_CATALOG.revisionId, enabled: true }] } })
  const source = withCatalog(progress('local', false)), destination = withCatalog(progress('account'))
  const { token, database, service } = await setup(source, destination)
  try {
    const base = await openAccountWorkspace(database, token, (await database.profileMeta.get('active'))!.head)
    const publication = await preparePublicationAttempt(database, token, base, null, new Map(), 0)
    const remote = (await openRemoteProjection(database, token, new Map(publication.final.heads.map(ref => [ref.documentId, ref.revisionId])), base.head, 0))!
    await service.commitGuestCopy(token, await service.previewSigninMerge(token))
    const intent = await openAccountJson(database, token, (await database.outbox.toArray())[0].ref, MappedWorkspaceIntentSchema)
    const target = await openAccountWorkspace(database, token, intent.target)
    const state = (await prepareCopiedConflictPublication(database, token, intent, target, remote)).target.state
    const original = state.conflicts[0], identity = original.progressIdentity
    if (identity?.version !== 2) throw new Error('Expected compact Progress identity')
    expect(identity.catalogBodies.length).toBeGreaterThan(0)
    const imported = createGuestCopyService(async () => ownWorkspaceSnapshot({ dataGeneration: LAUNCH_DATA_GENERATION, version: 1, snapshotId: 'recopied-compact-comparison', capturedAt: now, revisionVector: {}, state }, { async check() {}, async dispose() {} }))
    try {
      const preview = await imported.previewGuestCopy(token, [privateRecordKey('conflict', original.id), privateRecordKey('playthrough', 'play')])
      await imported.commitGuestCopy(token, preview)
      const journal = await openAccountJson(database, token, (await database.syncState.get(`guest-copy:${preview.copyId}`))!.ref, GuestCopyJournalSchema)
      const copiedIntent = await openAccountJson(database, token, journal.intent, MappedWorkspaceIntentSchema)
      const copiedTarget = await openAccountWorkspace(database, token, copiedIntent.target)
      const recopied = (await prepareCopiedConflictPublication(database, token, copiedIntent, copiedTarget, remote)).target.state
      const comparison = recopied.conflicts[0], association = comparison.progressIdentity
      if (association?.version !== 2) throw new Error('Expected recopied compact Progress identity')
      expect({ ...association, catalogBodies: undefined }).toEqual({ ...identity, catalogBodies: undefined })
      expect(association.catalogBodies.map(binding => binding.source)).toEqual(identity.catalogBodies.map(binding => binding.source))
      for (const [index, binding] of association.catalogBodies.entries()) {
        expect(binding.retained).toEqual(identity.catalogBodies[index].retained)
        expect(recopied.blobs.filter(body => body.ref.sha256 === binding.source.sha256)).toHaveLength(1)
        const body = recopied.blobs.find(body => blobIdentity(body.ref) === blobIdentity(binding.retained))!
        expect(await hashBlob(body.content)).toBe(binding.source.sha256)
        expect(archiveTypedReferences('conflict', comparison)).toContainEqual(binding.retained)
      }
      await expect(validateWorkspaceClosure(recopied)).resolves.toBeUndefined()
    } finally { await imported.dispose() }
  } finally { await service.dispose(); vi.unstubAllGlobals() }
})
it('selects unavailable-definition receipts as meaningful preferences without requiring a live definition', async () => {
  const receipt = { ref: { kind: 'personal' as const, definitionId: 'missing' as import('../domain/types').PersonalDefinitionId }, kind: 'class' as const, name: 'Unavailable class' }
  const source = workspace({ ...createBlankLocalData({ now }), unavailableDefinitions: [receipt] })
  const { token, service, active } = await setup(source)
  try {
    const preview = await service.previewSigninMerge(token)
    expect(preview.selectedKeys).toContain('["workspace-preferences"]')
    await service.commitGuestCopy(token, preview)
    expect((await active()).planner.localData.unavailableDefinitions).toEqual([receipt])
    expect((await active()).planner.localData.personalDefinitions).toEqual({})
  } finally { await service.dispose() }
})

it.each(['manual', 'signin'] as const)('requires explicit operation identity before sign-in can resume a pending %s copy', async kind => {
  const fixture = await editorClosureFixture()
  const source = { ...fixture.state, editorDocuments: [fixture.file, { ...fixture.file, id: 'editor-2', filename: 'Second local file.json' }] }
  const { token, database, service, active } = await setup(source)
  const preview = kind === 'manual' ? await service.previewGuestCopy(token, ['["editor","editor-1"]']) : await service.previewSigninMerge(token)
  const failure = vi.spyOn(accountActivation, 'activateLocalAccountCommit').mockRejectedValueOnce(new Error('Interrupted activation'))
  try { await expect(service.commitGuestCopy(token, preview)).rejects.toThrow('Interrupted activation') }
  finally { failure.mockRestore(); await service.dispose() }
  const pending = await database.syncState.get('guest-copy:pending')
  const fence = await database.profileMeta.get('active')
  const revisions = await database.encryptedRevisions.count()
  expect(pending).toBeDefined()
  const changed = { ...source, editorDocuments: [...source.editorDocuments, { ...fixture.file, id: 'editor-3', filename: 'New local work.json' }] }
  let captures = 0
  const reopened = createGuestCopyService(async () => {
    captures++
    return ownWorkspaceSnapshot({ dataGeneration: LAUNCH_DATA_GENERATION, version: 1, snapshotId: 'changed-signin-source', capturedAt: now, revisionVector: { guest: 'changed' }, state: changed }, { async check() {}, async dispose() {} })
  })
  try {
    await expect(reopened.previewSigninMerge(token)).rejects.toThrow(/pending copy/i)
    expect(await database.syncState.get('guest-copy:pending')).toEqual(pending)
    expect(await database.profileMeta.get('active')).toEqual(fence)
    expect(await database.encryptedRevisions.count()).toBe(revisions)
    expect(captures).toBe(0)
    if (kind === 'manual') await expect(reopened.previewSigninMerge(token, preview.copyId)).rejects.toThrow('unsupported')
    const saved = kind === 'manual' ? await reopened.previewGuestCopy(token) : await reopened.previewSigninMerge(token, preview.copyId)
    expect(saved.copyId).toBe(preview.copyId)
    expect(saved.selectedKeys).toEqual(preview.selectedKeys)
    expect(saved.selectedKeys).not.toContain('["editor","editor-3"]')
    await reopened.commitGuestCopy(token, saved)
    expect((await active()).editorDocuments.map(file => file.id).sort()).toEqual(kind === 'manual' ? ['editor-1'] : ['editor-1', 'editor-2'])
    expect(captures).toBe(0)
  } finally { await reopened.dispose() }
})

it.each(['native', 'managed', 'managed-projection'] as const)('atomically attaches the sign-in choice to %s copy and verifies it on exact replay', async layout => {
  const { z } = await import('zod')
  const Dexie = (await import('dexie')).default
  const { initializeAccountWorkspace } = await import('./account-initialization')
  const destination = layout === 'managed-projection' ? progress('account') : workspace(createBlankLocalData({ now }))
  const { token, database, service } = await setup(progress('local', layout !== 'managed-projection'), destination)
  if (layout !== 'native') {
    await database.delete(); await database.open()
    const fence = await initializeAccountWorkspace(database, token, destination)
    const { prepareIncrementalBaseline, activateIncrementalBaseline } = await import('./account-local-mapping')
    await activateIncrementalBaseline(database, token, await prepareIncrementalBaseline(database, token, fence))
  }
  const before = await database.profileMeta.get('active')
  const preview = await service.previewSigninMerge(token)
  const decision = { id: 'signin-receipt:copy-test', expected: undefined, value: { version: 1, action: 'merge', copyId: preview.copyId } }
  const original = accountActivation.activateLocalAccountCommit
  const fail = vi.spyOn(accountActivation, 'activateLocalAccountCommit').mockImplementationOnce(async (db, owner, prepared, check, attachment) => {
    let checks = 0
    return original(db, owner, prepared, () => {
      check?.()
      if (++checks === 2) { expect(Dexie.currentTransaction?.active).toBe(true); throw new Error('in-transaction receipt interruption') }
    }, attachment)
  })
  try {
    await expect(service.commitGuestCopy(token, preview, decision)).rejects.toThrow('in-transaction receipt interruption')
    fail.mockRestore()
    expect(await database.profileMeta.get('active')).toEqual(before)
    expect(await database.migrationJournal.get(preview.copyId)).toBeUndefined()
    expect(await database.outbox.count()).toBe(0)
    expect(await database.syncState.get(decision.id)).toBeUndefined()
    const result = await service.commitGuestCopy(token, preview, decision)
    const row = await database.syncState.get(decision.id)
    expect(row).toBeDefined()
    expect(await openAccountJson(database, token, row!.ref, z.unknown())).toEqual(decision.value)
    expect(await service.commitGuestCopy(token, preview, decision)).toEqual(result)
    await expect(service.commitGuestCopy(token, preview, { ...decision, value: { ...decision.value, action: 'account' } })).rejects.toThrow('SIGNIN_RECEIPT_MISMATCH')
    await database.syncState.delete(decision.id)
    await expect(service.commitGuestCopy(token, preview, decision)).rejects.toThrow('SIGNIN_RECEIPT_MISMATCH')
    expect(await database.syncState.get(decision.id)).toBeUndefined()
    expect(await database.outbox.count()).toBe(1)
  } finally { fail.mockRestore(); await service.dispose() }
})

it.each(['native', 'managed'] as const)('prepares %s sign-in copy and receipt atomically before reload and confirmation', async layout => {
  const attachments = await import('../persistence/account-activation-attachments')
  const Dexie = (await import('dexie')).default
  const { token, database, service } = await setup(progress('local'))
  if (layout === 'managed') {
    await database.delete(); await database.open()
    const { initializeAccountWorkspace } = await import('./account-initialization')
    const { prepareIncrementalBaseline, activateIncrementalBaseline } = await import('./account-local-mapping')
    const fence = await initializeAccountWorkspace(database, token, workspace(createBlankLocalData({ now })))
    await activateIncrementalBaseline(database, token, await prepareIncrementalBaseline(database, token, fence))
  }
  const before = await database.profileMeta.get('active')
  const preview = await service.previewSigninMerge(token)
  const decision = { id: 'signin-receipt:prepared-test', expected: undefined, value: { status: 'preparing', copyId: preview.copyId } }
  const original = attachments.accountAttachmentCheck
  const fault = vi.spyOn(attachments, 'accountAttachmentCheck').mockImplementation((...args) => {
    const check = original(...args)
    return check && { ...check, async installInTransaction() { await check.installInTransaction(); expect(Dexie.currentTransaction?.active).toBe(true); throw new Error('prepared receipt interruption') } }
  })
  try {
    await expect(service.prepareSigninMerge(token, preview, decision)).rejects.toThrow('prepared receipt interruption')
    fault.mockRestore()
    expect(await database.syncState.get(decision.id)).toBeUndefined()
    expect(await database.syncState.get(`guest-copy:${preview.copyId}`)).toBeUndefined()
    expect(await database.syncState.get('guest-copy:pending')).toBeUndefined()
    expect(await database.profileMeta.get('active')).toEqual(before)
    if (layout === 'managed') {
      const managed = await import('./managed-guest-copy')
      const stage = managed.stageManagedGuestCopy
      const release = vi.spyOn(attachments, 'releaseAccountActivationAttachment')
      const cleanupFault = vi.spyOn(managed, 'stageManagedGuestCopy').mockImplementation(async (...args) => {
        const prepared = await stage(...args)
        return { ...prepared, async dispose() { await prepared.dispose(); throw new Error('managed cleanup interruption') } }
      })
      try {
        await expect(service.prepareSigninMerge(token, preview, decision)).rejects.toThrow('managed cleanup interruption')
        expect(release).toHaveBeenCalledOnce()
      } finally { cleanupFault.mockRestore(); release.mockRestore() }
    }
    await service.prepareSigninMerge(token, preview, decision)
    await expect(service.prepareSigninMerge(token, preview, { ...decision, value: { status: 'preparing', copyId: 'different-copy' } })).rejects.toThrow('SIGNIN_RECEIPT_MISMATCH')
    expect(await database.profileMeta.get('active')).toEqual(before)
    expect(await database.outbox.count()).toBe(0)
    await service.dispose()
    const resumed = createGuestCopyService(async () => { throw new Error('Must not recapture') })
    try {
      const saved = await resumed.previewSigninMerge(token, preview.copyId)
      const row = await database.syncState.get(decision.id)
      const completed = { ...decision, expected: row, value: { ...decision.value, status: 'complete' } }
      const receipt = await resumed.commitGuestCopy(token, saved, completed)
      expect(await resumed.commitGuestCopy(token, saved, completed)).toEqual(receipt)
      expect(await database.outbox.count()).toBe(1)
    } finally { await resumed.dispose() }
  } finally { fault.mockRestore(); await service.dispose() }
})
