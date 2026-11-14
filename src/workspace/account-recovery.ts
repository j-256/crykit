import { z } from 'zod'
import type { Table, Transaction } from 'dexie'
import { assertActiveProfile, profileSignal, type ProfileToken } from '../account/profile'
import { MAX_RECOVERY_BYTES, MAX_RECOVERY_POINTS, RECOVERY_CONTROL_BYTES, RECOVERY_REVISION_CONTROL_BYTES, type RecoveryPoint } from '../account/recovery-protocol'
import { CommitRequestSchema, OpaqueIdSchema, RevisionDescriptorSchema, type CommitRequest, type RevisionDescriptor } from '../account/protocol'
import { SyncClient, SyncError } from '../account/sync/client'
import { AccountDatabase } from '../persistence/account-database'
import { exportWorkspaceBackup, readWorkspaceBackup } from '../interchange/workspace-backup'
import { capturedBackupEvidence, equalMetadataStreams, historicalMetadataIdentity, inheritWorkspaceSnapshot, metadataSource } from '../interchange/workspace-backup-evidence'
import { blobIdentity } from './blobs'
import { cipherRef, openAccountJson, stageAccountJson } from './account-cache'
import { createAccountPreparationOwner } from './account-prepared-records'
import { openAccountSource, openRemoteAccountSource, stageAccountSource } from './account-streams'
import { assertOwnedWorkspaceSnapshot, assertWorkspaceSnapshotCurrent, backupMetadataDigest, disposeWorkspaceSnapshot, projectWorkspaceSnapshotV1, snapshotMetadata, type WorkspaceSnapshot } from './snapshot'

const RecordSchema = z.strictObject({ revisionId: OpaqueIdSchema, payloadId: OpaqueIdSchema, descriptor: RevisionDescriptorSchema })
const PredecessorSchema = z.strictObject({ operationId: OpaqueIdSchema, mutationId: OpaqueIdSchema, revisions: z.array(RevisionDescriptorSchema).readonly() })
const BoundCoverageSchema = z.strictObject({ version: z.literal(1), predecessor: PredecessorSchema, successor: RevisionDescriptorSchema, metadataDigest: z.string() })
// Version 1 always means an exact bound mutation; only this variant admits no publication identity
const UnboundCoverageSchema = z.strictObject({
  version: z.literal(2),
  predecessor: z.strictObject({ kind: z.literal('sealed-unbound'), operationId: OpaqueIdSchema, revisions: z.array(RevisionDescriptorSchema).readonly() }),
  successor: RevisionDescriptorSchema, metadataDigest: z.string(),
})
const CoverageSchema = z.union([BoundCoverageSchema, UnboundCoverageSchema])
const BindingSchema = z.strictObject({ version: z.literal(1), publication: CommitRequestSchema })
const JournalSchema = z.strictObject({ version: z.literal(1), kind: z.literal('account-recovery'), operationId: OpaqueIdSchema, sourceIdentity: z.string(), archive: RecordSchema, coverage: CoverageSchema.optional() })
type Journal = z.infer<typeof JournalSchema>
const PAYLOAD_PREFIX = 'recovery-payload:'
const archivePointerId = (id: string) => `${PAYLOAD_PREFIX}${OpaqueIdSchema.parse(id)}`
const journalId = (id: string) => `recovery:${OpaqueIdSchema.parse(id)}`
const exact = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const integrity = () => new SyncError('LOCAL_INTEGRITY_FAILED')
// The server includes seed/marker liability in admission in addition to the ciphertext
const CHUNK_CONTROL_BYTES = 64
function admittedBytes(descriptor: RevisionDescriptor) {
  return descriptor.chunks.reduce((sum, chunk) => sum + chunk.cipherBytes + CHUNK_CONTROL_BYTES, 0)
    + new TextEncoder().encode(JSON.stringify(descriptor)).length + RECOVERY_CONTROL_BYTES + RECOVERY_REVISION_CONTROL_BYTES
}

// Validate containment independently of the producer, against the authenticated archive readback
// Matching labels or visible records cannot prove that an original's history/conflicts survived
async function validateCoverage(successor: WorkspaceSnapshot, predecessor: WorkspaceSnapshot, inherited = true): Promise<string> {
  const original = capturedBackupEvidence(predecessor), next = capturedBackupEvidence(successor)
  const current = predecessor.version === 1 ? original.current : metadataSource(snapshotMetadata(projectWorkspaceSnapshotV1(predecessor)))
  const identity = inherited ? await historicalMetadataIdentity(current) : undefined
  if (!inherited && await backupMetadataDigest(snapshotMetadata(projectWorkspaceSnapshotV1(successor))) !== await backupMetadataDigest(snapshotMetadata(projectWorkspaceSnapshotV1(predecessor)))) throw integrity()
  for (const [id, metadata] of [...(inherited ? [[identity!.id, current] as const] : []), ...original.historical]) {
    const inherited = next.historical.get(id)
    if (!inherited || !await equalMetadataStreams(metadata, inherited)) throw integrity()
  }
  const bodies = new Map(next.blobs.map(body => [blobIdentity(body.ref), body]))
  for (const body of original.blobs) {
    const inherited = bodies.get(blobIdentity(body.ref))
    if (!inherited || !exact(inherited.ref, body.ref) || !await equalMetadataStreams(inherited.content, body.content)) throw integrity()
  }
  return backupMetadataDigest(snapshotMetadata(predecessor))
}

export function createAccountRecoveryService(token: ProfileToken) {
  assertActiveProfile(token)
  const signal = profileSignal(token), client = new SyncClient(token, signal)
  // Connections are call-scoped; returned snapshots own separate encrypted backup staging
  const useDatabase = async <T>(action: (database: AccountDatabase) => Promise<T>): Promise<T> => {
    assertActiveProfile(token)
    const database = new AccountDatabase(token.accountId)
    try { const result = await action(database); assertActiveProfile(token); return result } finally { database.close() }
  }
  const write = async <T>(database: AccountDatabase, tables: readonly Table[], action: () => Promise<T>): Promise<T> => {
    let pending: Transaction | undefined
    const abort = () => pending?.abort()
    signal.addEventListener('abort', abort, { once: true })
    try {
      return await database.transaction('rw', tables, async transaction => {
        pending = transaction; assertActiveProfile(token)
        const result = await action()
        assertActiveProfile(token); return result
      })
    } finally { signal.removeEventListener('abort', abort) }
  }
  const readJournal = async (database: AccountDatabase, operationId: string) => {
    const row = await database.syncState.get(journalId(operationId))
    assertActiveProfile(token)
    if (!row) return undefined
    const value = await openAccountJson(database, token, row.ref, JournalSchema)
    if (value.operationId !== operationId || value.archive.descriptor.accountId !== token.accountId) throw integrity()
    return { row, value }
  }
  const points = async () => { assertActiveProfile(token); return (await client.listRecoveries()).points }
  const find = async (id: string) => (await points()).find(point => point.operationId === OpaqueIdSchema.parse(id))
  const checkPoint = (point: RecoveryPoint, journal: Journal) => {
    if (point.operationId !== journal.operationId || !exact(point.revisions, [journal.archive.descriptor])) throw integrity()
  }
  const discardArchive = async (database: AccountDatabase, journal: Journal) => {
    // The metadata journal survives cleanup, so a concurrent/later retry never recaptures or
    // regenerates the original. This ciphertext has no permanent history or publication owner
    await write(database, [database.encryptedRevisions, database.stagedCipherChunks, database.syncState], async () => {
      assertActiveProfile(token)
      const installed = await database.encryptedRevisions.get(journal.archive.revisionId)
      if (installed && !exact(RecordSchema.parse(installed), journal.archive)) throw integrity()
      await database.syncState.delete(archivePointerId(journal.operationId))
      await database.encryptedRevisions.delete(journal.archive.revisionId)
      await database.stagedCipherChunks.where('payloadId').equals(journal.archive.payloadId).delete()
      assertActiveProfile(token)
    })
  }
  const cleanArchive = async (database: AccountDatabase, journal: Journal, point: RecoveryPoint) => {
    checkPoint(point, journal)
    if (!point.sealed) throw integrity()
    await discardArchive(database, journal)
  }
  const reconcilePoint = (point: RecoveryPoint) => useDatabase(async database => {
    const stored = await readJournal(database, point.operationId)
    if (stored && point.sealed) await cleanArchive(database, stored.value, point)
  })
  const liveArchives = (database: AccountDatabase) => database.syncState.where('id').startsWith(PAYLOAD_PREFIX).toArray()
  const list = async () => {
    const result = await points()
    await useDatabase(async database => {
      for (const row of await liveArchives(database)) {
        const operationId = OpaqueIdSchema.parse(row.id.slice(PAYLOAD_PREFIX.length)), stored = await readJournal(database, operationId)
        if (!stored || !exact(row.ref, cipherRef(stored.value.archive))) throw integrity()
        const point = result.find(point => point.operationId === operationId)
        if (point) { if (point.sealed) await cleanArchive(database, stored.value, point); continue }
        const status = await client.recoveryOperationStatus(operationId)
        // Never-reserved and in-flight work stay protected. Terminal ownership is permanent
        // and account-scoped, so it remains proof even if this caller missed sealing/completion
        if (status.status === 'retired') await discardArchive(database, stored.value)
      }
    })
    return result
  }
  const assertLocalAdmission = async (database: AccountDatabase, candidateBytes: number) => {
    const rows = await liveArchives(database)
    const records = await database.encryptedRevisions.bulkGet(rows.map(row => row.ref.revisionId))
    let bytes = candidateBytes
    for (const [index, record] of records.entries()) {
      if (!record || !exact(cipherRef(record), rows[index].ref) || record.descriptor.accountId !== token.accountId) throw integrity()
      bytes += admittedBytes(RevisionDescriptorSchema.parse(record.descriptor))
    }
    // This per-device transport bound is separate from server-wide admission. Only live retry
    // archives count; sealed/terminal metadata journals never pin another archive slot or bytes
    // Preparation ownership before installation is in memory, so an abrupt process death can
    // leave uninstalled orphan chunks outside this bound in the shared staging infrastructure
    if (rows.length >= MAX_RECOVERY_POINTS || bytes > MAX_RECOVERY_BYTES) throw new SyncError('QUOTA_EXCEEDED')
  }
  const reserve = (journal: Journal) => client.reserveRecovery({ version: 1, operationId: journal.operationId, revisions: [journal.archive.descriptor], reservedBytes: journal.archive.descriptor.chunks.reduce((sum, chunk) => sum + chunk.cipherBytes, 0) })
  const resumeIn = async (database: AccountDatabase, operationId: string): Promise<RecoveryPoint> => {
    const stored = await readJournal(database, operationId)
    const prior = await find(operationId)
    if (!stored) {
      if (prior?.sealed) return prior
      throw integrity()
    }
    const journal = stored.value
    if (prior) checkPoint(prior, journal)
    if (prior?.sealed) { await cleanArchive(database, journal, prior); return prior }
    let reserved: RecoveryPoint
    try { reserved = await reserve(journal) }
    catch (error) {
      // With a validated same-account descriptor, exact reserve replay returns NOT_FOUND only
      // for permanent terminal ownership. A missing listing alone never grants deletion authority
      if (error instanceof SyncError && error.remoteResponse && error.code === 'NOT_FOUND') await discardArchive(database, journal)
      throw error
    }
    checkPoint(reserved, journal)
    if (reserved.sealed) { await cleanArchive(database, journal, reserved); return reserved }
    const descriptor = journal.archive.descriptor
    await client.startUpload({ version: 1, uploadId: descriptor.uploadId, documentId: descriptor.documentId, revisionId: descriptor.revisionId, metadataBytes: new TextEncoder().encode(JSON.stringify(descriptor)).length, chunks: descriptor.chunks })
    for (const chunk of descriptor.chunks) {
      const bytes = await database.stagedCipherChunks.get([journal.archive.payloadId, chunk.index])
      assertActiveProfile(token)
      if (!bytes) {
        // Another caller may have sealed and released the same installed archive while we
        // awaited transport. Only exact server ownership can explain absent local ciphertext
        const sealed = await find(operationId)
        if (!sealed?.sealed) throw integrity()
        await cleanArchive(database, journal, sealed); return sealed
      }
      await client.putChunk(descriptor.uploadId, chunk.index, bytes.bytes)
    }
    await client.finishUpload(descriptor.uploadId)
    const sealed = await client.sealRecovery(operationId)
    await cleanArchive(database, journal, sealed)
    return sealed
  }
  const prepare = (operationId: string, snapshot: WorkspaceSnapshot, predecessor?: RecoveryPoint, predecessorSnapshot?: WorkspaceSnapshot) => useDatabase(async database => {
    OpaqueIdSchema.parse(operationId)
    await assertOwnedWorkspaceSnapshot(snapshot)
    const sourceIdentity = await backupMetadataDigest(snapshotMetadata(snapshot))
    const prior = await readJournal(database, operationId)
    if (prior) {
      if (prior.value.sourceIdentity !== sourceIdentity || prior.value.coverage?.predecessor.operationId !== predecessor?.operationId) throw new SyncError('IDEMPOTENCY_MISMATCH')
      return resumeIn(database, operationId)
    }
    const remote = (await list()).find(point => point.operationId === operationId)
    if (remote) throw new SyncError('IDEMPOTENCY_MISMATCH')
    // Raw body frames are never compressed, so their union alone can prove an impossible
    // reservation before copying or reading a large source. Metadata is bounded by counting below
    const rawBodies = new Map([snapshot, ...(predecessorSnapshot ? [predecessorSnapshot] : [])].flatMap(value => capturedBackupEvidence(value).blobs.map(blob => [blobIdentity(blob.ref), blob.ref] as const)))
    const rawBytes = [...rawBodies.values()].reduce((sum, ref) => sum + ref.byteLength, 0)
    if (rawBytes > MAX_RECOVERY_BYTES - RECOVERY_CONTROL_BYTES) throw new SyncError('QUOTA_EXCEEDED')
    await database.transaction('r', [database.syncState, database.encryptedRevisions], () => assertLocalAdmission(database, rawBytes + RECOVERY_CONTROL_BYTES))
    const owner = createAccountPreparationOwner(database, token)
    // Freeze all categories into self-contained encrypted staging once; both archive passes
    // share this owner and keep checking the original capture fence until durable installation
    const stable = await inheritWorkspaceSnapshot(snapshot, predecessorSnapshot ? [predecessorSnapshot] : [], { signal })
    const check = async () => { assertActiveProfile(token); await assertWorkspaceSnapshotCurrent(snapshot); await assertWorkspaceSnapshotCurrent(stable) }
    try {
      let byteLength = 0
      for await (const bytes of exportWorkspaceBackup(stable)) {
        await check(); byteLength += bytes.length
        if (byteLength > MAX_RECOVERY_BYTES - RECOVERY_CONTROL_BYTES) throw new SyncError('QUOTA_EXCEEDED')
      }
      const archive = await stageAccountSource(database, token, { byteLength, async *open() { for await (const bytes of exportWorkspaceBackup(stable)) { await check(); yield bytes } await check() } }, [], undefined, undefined, owner)
      if (admittedBytes(archive.descriptor) > MAX_RECOVERY_BYTES) throw new SyncError('QUOTA_EXCEEDED')
      // Read the produced ciphertext through the normal backup validator before granting coverage
      // This catches a producer that omits an original even if its output is otherwise a valid backup
      const authenticated = await readWorkspaceBackup((await openAccountSource(database, token, cipherRef(archive), owner)).open(), { signal })
      let coverage: Journal['coverage']
      try {
        await validateCoverage(authenticated, snapshot, false)
        if (predecessor && predecessorSnapshot) {
          if (!predecessor.sealed || predecessor.acceptedAt !== null) throw integrity()
          const identity = { operationId: predecessor.operationId, revisions: predecessor.revisions }
          const validated = { successor: RevisionDescriptorSchema.parse(archive.descriptor), metadataDigest: await validateCoverage(authenticated, predecessorSnapshot) }
          coverage = predecessor.mutationId === null
            ? { version: 2, predecessor: { kind: 'sealed-unbound', ...identity }, ...validated }
            : { version: 1, predecessor: { ...identity, mutationId: predecessor.mutationId }, ...validated }
        }
      } finally { await disposeWorkspaceSnapshot(authenticated) }
      const value: Journal = { version: 1, kind: 'account-recovery', operationId, sourceIdentity, archive, ...(coverage ? { coverage } : {}) }
      const encrypted = await stageAccountJson(database, token, value, [], undefined, owner)
      await check()
      const won = await write(database, [database.syncState, database.encryptedRevisions], async () => {
        assertActiveProfile(token)
        if (await database.syncState.get(journalId(operationId))) return false
        await assertLocalAdmission(database, admittedBytes(archive.descriptor))
        await database.encryptedRevisions.bulkAdd([archive, encrypted])
        await database.syncState.bulkAdd([{ id: journalId(operationId), ref: cipherRef(encrypted) }, { id: archivePointerId(operationId), ref: cipherRef(archive) }])
        assertActiveProfile(token)
        return true
      })
      if (!won) {
        const winner = await readJournal(database, operationId)
        if (winner?.value.sourceIdentity !== sourceIdentity || winner.value.coverage?.predecessor.operationId !== predecessor?.operationId) throw new SyncError('IDEMPOTENCY_MISMATCH')
      }
    } finally { try { await owner.abandon() } finally { await disposeWorkspaceSnapshot(stable) } }
    return resumeIn(database, operationId)
  })
  const capturePoint = async (point: RecoveryPoint): Promise<WorkspaceSnapshot> => {
    if (!point.sealed || point.revisions.length !== 1) throw integrity()
    await reconcilePoint(point)
    const descriptor = point.revisions[0]
    const source = openRemoteAccountSource(token, descriptor, index => client.recoveryChunk(point.operationId, descriptor.revisionId, index))
    return readWorkspaceBackup(source.open(), { signal })
  }
  const capture = async (operationId: string): Promise<WorkspaceSnapshot> => {
    const point = await find(operationId)
    if (!point) throw integrity()
    return capturePoint(point)
  }
  const prepareSuccessor = async (operationId: string, snapshot: WorkspaceSnapshot, predecessorPointId: string): Promise<RecoveryPoint> => {
    if (OpaqueIdSchema.parse(operationId) === OpaqueIdSchema.parse(predecessorPointId)) throw integrity()
    // A completed local receipt is enough for exact retry even after predecessor retirement
    const existing = await useDatabase(database => readJournal(database, operationId))
    if (existing) {
      await assertOwnedWorkspaceSnapshot(snapshot)
      if (existing.value.coverage?.predecessor.operationId !== predecessorPointId || existing.value.sourceIdentity !== await backupMetadataDigest(snapshotMetadata(snapshot))) throw new SyncError('IDEMPOTENCY_MISMATCH')
      return useDatabase(database => resumeIn(database, operationId))
    }
    const predecessor = await find(predecessorPointId)
    if (!predecessor?.sealed || predecessor.acceptedAt !== null) throw integrity()
    const original = await capturePoint(predecessor)
    try { return await prepare(operationId, snapshot, predecessor, original) } finally { await disposeWorkspaceSnapshot(original) }
  }
  const bind = async (operationId: string, input: CommitRequest): Promise<RecoveryPoint> => {
    const publication = CommitRequestSchema.parse(input)
    if (publication.recoveryOperationId !== OpaqueIdSchema.parse(operationId) || publication.expectedPublicationEpoch === undefined) throw integrity()
    const point = await find(operationId)
    if (!point?.sealed) throw integrity()
    await reconcilePoint(point)
    // Persist proof only after this exact request has been acknowledged by the server
    const bound = await client.bindRecoveryPublication({ version: 1, operationId, publication })
    await useDatabase(async database => {
      const id = `recovery-binding:${operationId}`
      const read = async () => {
        const row = await database.syncState.get(id)
        return row && openAccountJson(database, token, row.ref, BindingSchema)
      }
      const prior = await read()
      if (prior) { if (!exact(prior.publication, publication)) throw new SyncError('IDEMPOTENCY_MISMATCH'); return }
      const owner = createAccountPreparationOwner(database, token)
      try {
        const record = await stageAccountJson(database, token, { version: 1, publication }, [], undefined, owner)
        await write(database, [database.encryptedRevisions, database.syncState], async () => {
          assertActiveProfile(token)
          if (await database.syncState.get(id)) return
          await database.encryptedRevisions.add(record)
          await database.syncState.add({ id, ref: cipherRef(record) })
          assertActiveProfile(token)
        })
        if (!exact((await read())?.publication, publication)) throw new SyncError('IDEMPOTENCY_MISMATCH')
      } finally { await owner.abandon() }
    })
    return bound
  }
  const supersede = (successorPointId: string) => useDatabase(async database => {
    const stored = await readJournal(database, successorPointId), coverage = stored?.value.coverage
    const bindingRow = await database.syncState.get(`recovery-binding:${OpaqueIdSchema.parse(successorPointId)}`)
    if (!stored || !coverage || !bindingRow || !exact(coverage.successor, stored.value.archive.descriptor)) throw integrity()
    const { publication } = await openAccountJson(database, token, bindingRow.ref, BindingSchema)
    const successor = await find(successorPointId)
    if (!successor?.sealed || successor.mutationId !== publication.mutationId || publication.recoveryOperationId !== successorPointId) throw integrity()
    checkPoint(successor, stored.value)
    const predecessor = await find(coverage.predecessor.operationId)
    // Absence can mean a lost supersession acknowledgment; the server's permanent terminal
    // link must replay exactly. A changed or accepted predecessor never passes this client check
    if (predecessor && (!predecessor.sealed || predecessor.mutationId !== (coverage.version === 1 ? coverage.predecessor.mutationId : null) || predecessor.acceptedAt !== null || !exact(predecessor.revisions, coverage.predecessor.revisions))) throw integrity()
    const link = { operationId: coverage.predecessor.operationId, successorOperationId: successorPointId, successorMutationId: publication.mutationId }
    return client.supersedeRecoveryPublication(coverage.version === 1
      ? { version: 1, ...link, mutationId: coverage.predecessor.mutationId }
      : { version: 2, ...link, predecessor: { kind: 'sealed-unbound' } })
  })
  const cancelPreparation = (operationId: string) => useDatabase(async database => {
    const stored = await readJournal(database, operationId)
    const point = await find(operationId)
    if (point?.sealed) return { version: 1 as const, state: 'blocked' as const }
    if (point && stored) checkPoint(point, stored.value)
    // The server also writes a terminal marker for a never-admitted operation, so a delayed
    // reserve cannot resurrect it and cancellation does not need archive or point capacity
    const result = await client.cancelRecoveryPreparation(operationId)
    if (result.state !== 'blocked' && stored) await discardArchive(database, stored.value)
    return result
  })
  const complete = async (operationId: string, mutationId: string) => {
    const point = await find(operationId)
    if (!point?.sealed || point.mutationId !== OpaqueIdSchema.parse(mutationId)) throw integrity()
    const completed = await client.completeRecovery(operationId)
    if (completed.mutationId !== mutationId) throw integrity()
    await reconcilePoint(completed)
    return completed
  }
  return { prepare: (operationId: string, snapshot: WorkspaceSnapshot) => prepare(operationId, snapshot), prepareSuccessor, bind, supersede, cancelPreparation, complete, resume: (operationId: string) => useDatabase(database => resumeIn(database, operationId)), list, capture }
}
