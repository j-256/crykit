import 'fake-indexeddb/auto'
import { afterEach, expect, it } from 'vitest'
import { AccountDatabase } from '../../persistence/account-database'
import { installProfile, invalidateProfile } from '../profile'
import { accountLocalId, cipherRef, openAccountJson } from '../../workspace/account-cache'
import { seedNativePublicationWorkspace } from '../../persistence/native-publication.test-helpers'
import { openAccountWorkspace } from '../../workspace/account-graph'
import { stagePublicationRecord, PublicationRecordSchema } from './publication'

let database: AccountDatabase | undefined
afterEach(async () => { invalidateProfile(); await database?.delete() })
it('publicationEnvelopePreservesExactMappedCiphertextAndCapturedAuthoritativeParent', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  await seedNativePublicationWorkspace(database, token)
  const fence = (await database.profileMeta.get('active'))!
  const workspace = await openAccountWorkspace(database, token, fence.head)
  const entry = workspace.entries.find(value => value.kind === 'library-defaults')!
  const body = (await database.encryptedRevisions.get(entry.ref.revisionId))!
  const bytes = (await database.stagedCipherChunks.get([body.payloadId, 0]))!.bytes
  const first = await stagePublicationRecord(database, token, entry, accountLocalId())
  const second = await stagePublicationRecord(database, token, entry, accountLocalId(), cipherRef(first))
  const envelope = await openAccountJson(database, token, cipherRef(second), PublicationRecordSchema)
  expect(envelope.body).toEqual(entry.ref)
  expect(envelope.digest).toBe(entry.digest)
  expect(second.descriptor.documentId).toBe(entry.ref.documentId)
  expect(second.descriptor.parents).toEqual([first.revisionId])
  expect(second.descriptor.dependencies).toEqual([entry.ref])
  expect((await database.stagedCipherChunks.get([body.payloadId, 0]))!.bytes).toEqual(bytes)
  expect((await openAccountWorkspace(database, token, (await database.profileMeta.get('active'))!.head)).state).toEqual(workspace.state)
})

it('borrows an exact live archive for readback while different, forged and expired archives retain admission', async () => {
  const evidence = await import('../../workspace/account-evidence-snapshots')
  const { prepareAccountWorkspaceWithEvidence } = await import('../../workspace/account-graph')
  const { editorClosureFixture } = await import('../../workspace/test-helpers')
  const { inheritWorkspaceSnapshot } = await import('../../interchange/workspace-backup')
  const { disposeWorkspaceSnapshot } = await import('../../workspace/snapshot')
  const { preparePublicationAttempt } = await import('./publication')
  const { openRemoteProjection } = await import('./projection')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const fixture = await editorClosureFixture()
  const snapshot = await inheritWorkspaceSnapshot({ version: 1, snapshotId: 'readback-original', capturedAt: fixture.file.updatedAt, revisionVector: {}, state: fixture.state }, [])
  const owner = evidence.createAccountInheritedEvidencePreparation(database, token), other = evidence.createAccountInheritedEvidencePreparation(database, token)
  try {
    const archive = await owner.prepare({ additions: [snapshot] }), different = await other.prepare({})
    const native = await prepareAccountWorkspaceWithEvidence(database, token, fixture.state, archive)
    await database.encryptedRevisions.bulkAdd([...native.records, ...different.records])
    const attempt = await preparePublicationAttempt(database, token, native.opened, null, new Map(), 0)
    const heads = new Map(attempt.final.heads.map(ref => [ref.documentId, ref.revisionId]))
    const projected = await openRemoteProjection(database, token, heads, native.head, 0, archive.handle)
    expect(projected!.inheritedEvidence).toEqual(archive.root)
    await expect(openRemoteProjection(database, token, heads, native.head, 0, { ...archive.handle })).rejects.toThrow(/registered/)
    expect((await openRemoteProjection(database, token, heads, native.head, 0, different.handle))!.inheritedEvidence).toEqual(archive.root)
    await owner.abandon()
    await expect(openRemoteProjection(database, token, heads, native.head, 0, archive.handle)).rejects.toThrow()
    const record = await database.encryptedRevisions.get(archive.root.revisionId)
    const chunk = (await database.stagedCipherChunks.get([record!.payloadId, 0]))!
    chunk.bytes[0] ^= 1
    await database.stagedCipherChunks.put(chunk)
    await expect(openRemoteProjection(database, token, heads, native.head, 0, different.handle)).rejects.toThrow()
    await expect(openRemoteProjection(database, token, heads, native.head, 0)).rejects.toThrow()
  } finally { await owner.abandon(); await other.abandon(); await disposeWorkspaceSnapshot(snapshot) }
})
it('ordinaryEditsKeepControlAndCapturedEnvelopeParentsAcrossNewLineageAttempts', async () => {
  const { prepareAccountWorkspace } = await import('../../workspace/account-graph')
  const { preparePublicationAttempt } = await import('./publication')
  const { openRemoteProjection } = await import('./projection')
  const { mappedChanges } = await import('../../workspace/account-intents')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  await seedNativePublicationWorkspace(database, token)
  const local = await openAccountWorkspace(database, token, (await database.profileMeta.get('active'))!.head)
  const initial = await preparePublicationAttempt(database, token, local, null, new Map(), 0)
  const heads = new Map(initial.final.heads.map(ref => [ref.documentId, ref.revisionId]))
  const remote = (await openRemoteProjection(database, token, heads, local.head, 0))!
  const catalog = local.state.planner.catalogs[0]
  const prepared = await prepareAccountWorkspace(database, token, { ...local.state, libraryDefaults: { version: 1, layers: [{ catalogId: catalog.id, catalogRevisionId: catalog.revisionId, enabled: true }] } }, local)
  await database.encryptedRevisions.bulkAdd(prepared.records)
  const parents = new Map([...remote.units.values()].map(unit => [unit.body.ref.revisionId, unit.ref]))
  const captured = { lineageId: remote.lineageId, parents }
  const changes = mappedChanges(local, prepared.opened)
  const ordinary = await preparePublicationAttempt(database, token, prepared.opened, remote, heads, 1, changes, 'additive', captured)
  const autosave = ordinary.bindings.find(value => value.body.revisionId === prepared.entries.find(entry => entry.kind === 'library-defaults')!.ref.revisionId)!
  expect((await database.encryptedRevisions.get(autosave.publication.revisionId))!.descriptor.protected).toBe(false)
  expect((await database.encryptedRevisions.get(autosave.body.revisionId))!.descriptor.protected).toBe(true)
  expect(initial.registrations.flatMap(command => command.revisions).every(value => value.protected)).toBe(true)
  expect(ordinary.final).not.toHaveProperty('expectedPublicationEpoch')
  expect(ordinary.final.heads).toContainEqual(remote.control)
  expect(ordinary.final.expected).toContainEqual(remote.control)
  const binding = ordinary.bindings.find(value => value.body.revisionId === prepared.entries.find(entry => entry.kind === 'library-defaults')!.ref.revisionId)!
  expect((await database.encryptedRevisions.get(binding.publication.revisionId))!.descriptor.parents).toEqual([remote.units.get('["library-defaults"]')!.ref.revisionId])
  const replacement = await preparePublicationAttempt(database, token, local, remote, heads, 1, [], 'replace')
  const replacedHeads = new Map([...heads, ...replacement.final.heads.map(ref => [ref.documentId, ref.revisionId] as const)])
  const nextLineage = (await openRemoteProjection(database, token, replacedHeads, local.head, 0))!
  await expect(preparePublicationAttempt(database, token, prepared.opened, nextLineage, replacedHeads, 2, changes, 'additive', captured)).rejects.toThrow('HEAD_CONFLICT')
  expect(prepared.entries.find(entry => entry.kind === 'library-defaults')!.ref).toEqual(binding.body)
})

it('stagesLargeAdditiveClosureWithinWireBoundsAndReplacesRemoteOnlyUnitsAtTheirExistingDocuments', async () => {
  const { createBlankLocalData } = await import('../../domain/local-data')
  const { createPersonalDefinition } = await import('../../domain')
  const { prepareAccountWorkspace } = await import('../../workspace/account-graph')
  const { activateLocalAccountCommit } = await import('../../persistence/account-database')
  const { mappedChanges } = await import('../../workspace/account-intents')
  const { preparePublicationAttempt, PublicationControlSchema, RecoveryPageSchema, stagePublicationControl } = await import('./publication')
  const { openRemoteProjection, readPublicationPages, assertProjectionSuccessor } = await import('./projection')
  const { maxChangedHeads, maxCommitJsonBytes } = await import('../protocol')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const localData = createBlankLocalData()
  const state: import('../../workspace/documents').WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], blobs: [], libraryDefaults: { version: 1, layers: [] } }
  const base = await prepareAccountWorkspace(database, token, state)
  await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: base.head, records: base.records })
  const initial = await preparePublicationAttempt(database, token, base.opened, null, new Map(), 0)
  const heads = new Map(initial.final.heads.map(ref => [ref.documentId, ref.revisionId]))
  const remote = (await openRemoteProjection(database, token, heads, base.head, 0))!
  let next = localData
  for (let index = 0; index < 17; index++) next = createPersonalDefinition(next, { kind: 'item', name: `Additive item ${index}` })
  const target = await prepareAccountWorkspace(database, token, { ...state, planner: { ...state.planner, localData: next } }, base.opened)
  await database.encryptedRevisions.bulkAdd(target.records)
  const targetIdentity = JSON.stringify(target.entries)
  const additive = await preparePublicationAttempt(database, token, target.opened, remote, heads, 1, mappedChanges(base.opened, target.opened), 'additive', { lineageId: remote.lineageId, parents: new Map([...remote.units.values()].map(unit => [unit.body.ref.revisionId, unit.ref])) })
  expect(additive.bulk).toBe(true)
  expect(additive.final.expectedPublicationEpoch).toBe(1)
  expect(additive.final.heads).toHaveLength(1)
  expect(additive.registrations.length).toBeGreaterThan(1)
  for (const command of additive.registrations) { expect(command.heads).toEqual([]); expect(command.revisions.length).toBeLessThanOrEqual(maxChangedHeads); expect(new TextEncoder().encode(JSON.stringify(command)).length).toBeLessThanOrEqual(maxCommitJsonBytes) }
  // A complete staged closure has no authority until its final control head is accepted
  expect((await openRemoteProjection(database, token, heads, base.head, 0))!.workspace.state.planner.localData.personalDefinitions).toEqual({})
  const acceptedHeads = new Map([...heads, ...additive.final.heads.map(ref => [ref.documentId, ref.revisionId] as const)])
  const accepted = (await openRemoteProjection(database, token, acceptedHeads, base.head, next.revision))!
  expect(accepted.workspace.state.planner.localData.personalDefinitions).toEqual(next.personalDefinitions)
  const replace = await preparePublicationAttempt(database, token, base.opened, accepted, acceptedHeads, 2, [], 'replace')
  expect(replace.final.expectedPublicationEpoch).toBe(2)
  const replacement = (await openRemoteProjection(database, token, new Map([...acceptedHeads, ...replace.final.heads.map(ref => [ref.documentId, ref.revisionId] as const)]), base.head, next.revision))!
  expect(replacement.workspace.state.planner.localData.personalDefinitions).toEqual({})
  await assertProjectionSuccessor(database, token, replacement, accepted)
  for (const old of accepted.units.values()) if (old.body.kind === 'personal-definition') {
    const removed = replacement.units.get(old.key)!
    expect(removed.body.kind).toBe('tombstone')
    expect(removed.body.ref.documentId).toBe(old.body.ref.documentId)
    expect((await database.encryptedRevisions.get(removed.body.ref.revisionId))!.descriptor.parents).toEqual([old.body.ref.revisionId])
  }
  const control = await openAccountJson(database, token, replacement.control, PublicationControlSchema)
  const selected = [...replacement.units.values()].find(unit => unit.body.kind === 'library-defaults')!
  const orphan = await stagePublicationRecord(database, token, selected.body, replacement.lineageId)
  const invalidControl = await stagePublicationControl(database, token, replacement.lineageId, replacement.baseline.map(entry => entry.kind === 'mutable' && entry.key === selected.key ? { ...entry, seed: cipherRef(orphan) } : entry), accepted.control, control.recovery)
  const orphanProjection = (await openRemoteProjection(database, token, new Map([...acceptedHeads, [invalidControl.documentId, invalidControl.revisionId]]), base.head, next.revision))!
  await expect(assertProjectionSuccessor(database, token, orphanProjection, accepted)).rejects.toThrow('INTEGRITY_FAILED')
  const recovery = await readPublicationPages(database, token, control.recovery!, RecoveryPageSchema, entry => [entry.ref])
  for (const ref of [accepted.control, ...[...accepted.units.values()].map(unit => unit.ref), ...[...accepted.directories.values()].map(unit => unit.ref)]) expect(recovery).toContainEqual({ key: ref.documentId, ref })
  expect(JSON.stringify(target.entries)).toBe(targetIdentity)
})

it('resolutionUsesTwoActualSameDocumentEnvelopeParentsWithoutRewritingBodies', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  await seedNativePublicationWorkspace(database, token)
  const workspace = await openAccountWorkspace(database, token, (await database.profileMeta.get('active'))!.head)
  const entry = workspace.entries.find(value => value.kind === 'library-defaults')!
  const lineage = accountLocalId()
  const base = await stagePublicationRecord(database, token, entry, lineage)
  const local = await stagePublicationRecord(database, token, entry, lineage, cipherRef(base))
  const remote = await stagePublicationRecord(database, token, entry, lineage, cipherRef(base))
  const resolution = await stagePublicationRecord(database, token, entry, lineage, [cipherRef(local), cipherRef(remote)])
  expect(resolution.descriptor.documentId).toBe(entry.ref.documentId)
  expect(resolution.descriptor.parents).toEqual([local.revisionId, remote.revisionId])
  expect((await openAccountJson(database, token, cipherRef(resolution), PublicationRecordSchema)).body).toEqual(entry.ref)
  await expect(stagePublicationRecord(database, token, entry, lineage, [cipherRef(local), { documentId: accountLocalId(), revisionId: remote.revisionId }])).rejects.toThrow()
  await expect(stagePublicationRecord(database, token, entry, lineage, [cipherRef(local), cipherRef(local)])).rejects.toThrow()
})

it('explicitResolutionRejectsChangedIntermediateBodiesAndMissingOrUnrelatedAncestry', async () => {
  const { assertUnchangedPublicationContinuation } = await import('./conflict-authority')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  await seedNativePublicationWorkspace(database, token)
  const workspace = await openAccountWorkspace(database, token, (await database.profileMeta.get('active'))!.head)
  const entry = workspace.entries.find(value => value.kind === 'library-defaults')!
  const lineage = accountLocalId()
  const base = await stagePublicationRecord(database, token, entry, lineage)
  const unchanged = await stagePublicationRecord(database, token, entry, accountLocalId(), cipherRef(base))
  await expect(assertUnchangedPublicationContinuation(database, token, cipherRef(unchanged), cipherRef(base))).resolves.toBeUndefined()
  const changed = await stagePublicationRecord(database, token, { ...entry, digest: '0'.repeat(64) }, lineage, cipherRef(base))
  const reverted = await stagePublicationRecord(database, token, entry, lineage, cipherRef(changed))
  await expect(assertUnchangedPublicationContinuation(database, token, cipherRef(reverted), cipherRef(base))).rejects.toThrow('STALE_CONFLICT_CHOICE')
  const unrelated = await stagePublicationRecord(database, token, entry, lineage)
  await expect(assertUnchangedPublicationContinuation(database, token, cipherRef(unrelated), cipherRef(base))).rejects.toThrow('STALE_CONFLICT_CHOICE')
  await database.encryptedRevisions.delete(unchanged.revisionId)
  await expect(assertUnchangedPublicationContinuation(database, token, cipherRef(unchanged), cipherRef(base))).rejects.toThrow('STALE_CONFLICT_CHOICE')
})

it('personalLineageInfrastructureRetainsOriginalImmutableBodiesUnderStableAnchorParents', async () => {
  const { createBlankLocalData, createPersonalDefinition, revisePersonalDefinition } = await import('../../domain/local-data')
  const { stagePersonalLineage, readPersonalLineage, PublicationLineageSchema } = await import('./lineage-publication')
  const { personalLineageChains } = await import('./lineage')
  const { prepareAccountWorkspace } = await import('../../workspace/account-graph')
  const { stagePublicationJson } = await import('./publication')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const localData = createPersonalDefinition(createBlankLocalData(), { kind: 'item', name: 'Root' })
  const root = Object.values(localData.personalDefinitions)[0]
  const fixture = await (await import('../../workspace/test-helpers')).editorClosureFixture()
  const state = { ...fixture.state, retainedContent: [], blobs: [], planner: { ...fixture.state.planner, localData, lineage: { rootLocalDataId: localData.id } } }
  const base = await prepareAccountWorkspace(database, token, state)
  await database.encryptedRevisions.bulkAdd(base.records)
  const { preparePublicationAttempt } = await import('./publication')
  const { openRemoteProjection } = await import('./projection')
  const legacyAttempt = await preparePublicationAttempt(database, token, base.opened, null, new Map(), 0, undefined, 'additive', undefined, { installLineages: false })
  const legacyHeads = new Map(legacyAttempt.final.heads.map(ref => [ref.documentId, ref.revisionId]))
  const legacy = (await openRemoteProjection(database, token, legacyHeads, base.head, 0))!
  expect(legacy.lineages.size).toBe(0)
  const installation = await preparePublicationAttempt(database, token, legacy.workspace, legacy, legacyHeads, 7, [], 'additive', undefined, { installLineages: true })
  expect(installation.final.expectedPublicationEpoch).toBe(7)
  expect(installation.final.expected).toContainEqual(legacy.control)
  const installedHeads = new Map([...legacyHeads, ...installation.final.heads.map(ref => [ref.documentId, ref.revisionId] as const)])
  const installed = (await openRemoteProjection(database, token, installedHeads, base.head, 0))!
  expect(installed.lineages.size).toBe(1)
  expect(installed.workspace.state.planner.localData.personalDefinitions).toEqual(localData.personalDefinitions)
  expect(installed.workspace.entries.find(entry => entry.kind === 'personal-definition')!.ref).toEqual(base.entries.find(entry => entry.kind === 'personal-definition')!.ref)
  const key = [...personalLineageChains(localData).keys()][0], lineage = accountLocalId()
  const anchor = await stagePersonalLineage(database, token, base.opened, key, lineage)
  expect(await readPersonalLineage(database, token, anchor.ref, base.opened.readCaptured)).toEqual(anchor)
  const nextData = revisePersonalDefinition(localData, { sourceRef: { kind: 'personal', definitionId: root.id }, name: 'Successor' }).localData
  const next = await prepareAccountWorkspace(database, token, { ...state, planner: { ...state.planner, localData: nextData } }, base.opened)
  await database.encryptedRevisions.bulkAdd(next.records)
  const successor = await stagePersonalLineage(database, token, next.opened, key, lineage, anchor.ref)
  expect(successor.ref.documentId).toBe(anchor.ref.documentId)
  expect((await database.encryptedRevisions.get(successor.ref.revisionId))!.descriptor.parents).toEqual([anchor.ref.revisionId])
  expect(successor.entries[0]).toEqual(anchor.entries[0])
  expect(await readPersonalLineage(database, token, successor.ref, next.opened.readCaptured)).toEqual(successor)
  const body = PublicationLineageSchema.parse({ ...successor.value, privateKey: '["personal-lineage","foreign"]' })
  const malformed = await stagePublicationJson(database, token, body, [body.chain])
  await expect(readPersonalLineage(database, token, cipherRef(malformed), next.opened.readCaptured)).rejects.toThrow('INTEGRITY_FAILED')
})

it('discovers only locally decrypted ordinary envelopes and preserves protected seeds and bodies', async () => {
  const { scanCleanupCandidates } = await import('../cleanup')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  await seedNativePublicationWorkspace(database, token)
  const workspace = await openAccountWorkspace(database, token, (await database.profileMeta.get('active'))!.head)
  const entry = workspace.entries.find(value => value.kind === 'library-defaults')!
  const seed = await stagePublicationRecord(database, token, entry, accountLocalId())
  const candidate = await stagePublicationRecord(database, token, entry, accountLocalId(), cipherRef(seed), undefined, true)
  const found = await scanCleanupCandidates(token)
  expect(found.candidates.map(value => value.ref)).toEqual([cipherRef(candidate)])
  await database.stagedCipherChunks.where('payloadId').equals(candidate.payloadId).delete()
  expect((await scanCleanupCandidates(token)).unavailable).toBe(true)
  invalidateProfile()
  await expect(scanCleanupCandidates(token)).rejects.toThrow()
})
