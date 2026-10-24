import { AccountMappingOriginSchema, accountMappingRootKey, IncrementalWorkspaceIntentSchema, IncrementalMappingRowSchema as rowSchema, IncrementalMappingReceiptSchema as receiptSchema } from './account-mapping-origin'
import { z } from 'zod'
import type { Table, Transaction } from 'dexie'
import { assertActiveProfile, profileSignal, type ProfileToken } from '../account/profile'
import { OpaqueIdSchema } from '../account/protocol'
import type { AccountDatabase, AccountFence, AccountIntentRecord, CipherRecord, CipherRef } from '../persistence/account-database'
import { accountLocalId, cipherRef, CipherRefSchema, openAccountJson, stageAccountJson } from './account-cache'
import { createAccountLocalStore } from './account-local-store'
import { admitLocalRoot, admittedLocalReferences, localJournalCoveredByHistory, type AdmittedLocalSnapshot } from './local-root'
import { openAccountWorkspace, prepareAccountWorkspace, prepareAccountWorkspaceWithEvidence, prepareAccountWorkspaceWithExistingEvidence, type OpenAccountWorkspace, type PreparedAccountWorkspace, prepareAccountHistoryReuse, type AccountHistoryReuse } from './account-graph'
import { mappedChanges, stageMappedWorkspaceIntent } from './account-intents'
import { retainPendingUnits } from './pending-content'
import { guestPlannerValuesEqual } from '../persistence/guest-planner-equality'
import { readLocalEvidence } from './local-evidence'
import { inspectWorkspaceClosures } from './closure'
import { sameCipherRefs } from './account-retaining'
import { blobIdentity } from './blobs'
import type { WorkspaceState, WorkspaceConflictClosure } from './documents'
import { createAccountInheritedEvidencePreparation, openAccountInheritedEvidence, type AccountInheritedEvidence } from './account-evidence-snapshots'

export const IncrementalMappingTicketSchema = z.strictObject({ version: z.literal(1), operationId: OpaqueIdSchema, receipt: CipherRefSchema })
export type IncrementalMappingTicket = z.infer<typeof IncrementalMappingTicketSchema>
const operationKey = (id: string) => `incremental-mapping:${id}`
const rootKey = accountMappingRootKey
const same = guestPlannerValuesEqual
const WRITE_BATCH_RECORDS = 16

// Revocation aborts even the native commit gap after the last awaited request
async function mappingTransaction<T>(database: AccountDatabase, token: ProfileToken, tables: readonly Table[], operation: () => Promise<T>): Promise<T> {
  const signal = profileSignal(token)
  let pending: Transaction | undefined
  const abort = () => pending?.abort()
  signal.addEventListener('abort', abort, { once: true })
  try { return await database.transaction('rw', [...tables], async transaction => { pending = transaction; assertActiveProfile(token); const result = await operation(); assertActiveProfile(token); return result }) }
  finally { signal.removeEventListener('abort', abort) }
}

// Immutable staging is deliberately bounded and never changes foreground selection or grants outbox authority
// Interrupted unreferenced ciphertext stays inert; only a fully authenticated receipt can finish mapping
async function installRecords(database: AccountDatabase, token: ProfileToken, records: readonly CipherRecord[], checkpoint: () => Promise<void>) {
  for (let offset = 0; offset < records.length; offset += WRITE_BATCH_RECORDS) {
    await checkpoint()
    const batch = records.slice(offset, offset + WRITE_BATCH_RECORDS)
    await mappingTransaction(database, token, [database.encryptedRevisions, database.stagedCipherChunks], async () => {
      assertActiveProfile(token)
      for (const record of batch) {
        if (record.descriptor.accountId !== token.accountId || record.revisionId !== record.descriptor.revisionId) throw new Error('Foreign mapping record')
        if (await database.encryptedRevisions.get(record.revisionId)) throw new Error('Mapping record identity was reused')
        for (const chunk of record.descriptor.chunks) if ((await database.stagedCipherChunks.get([record.payloadId, chunk.index]))?.bytes.length !== chunk.cipherBytes) throw new Error('Incomplete mapping ciphertext')
        await database.encryptedRevisions.add(record)
      }
      assertActiveProfile(token)
    })
  }
}

const evidenceAssociationSchema = z.strictObject({ version: z.literal(1), kind: z.literal('incremental-evidence-association'), accountId: OpaqueIdSchema, localEvidence: CipherRefSchema, evidence: CipherRefSchema })
const evidenceKey = (ref: CipherRef) => `incremental-evidence:${ref.revisionId}`

// The association binds exact encrypted local and native archives; callers still authenticate consumed payloads
export async function readIncrementalAccountEvidence(database: AccountDatabase, token: ProfileToken, localEvidence: CipherRef): Promise<CipherRef | undefined> {
  assertActiveProfile(token)
  const existing = await database.syncState.get(evidenceKey(localEvidence))
  if (!existing) return undefined
  const value = await openAccountJson(database, token, existing.ref, evidenceAssociationSchema)
  const record = await database.encryptedRevisions.get(existing.ref.revisionId)
  if (value.accountId !== token.accountId || !same(value.localEvidence, localEvidence) || !record || !sameCipherRefs(record.descriptor.dependencies, [value.localEvidence, value.evidence])) throw new Error('Managed historical association changed')
  assertActiveProfile(token)
  return value.evidence
}

// A retained reader transfers cleanup to the enclosing mapper; ordinary callers release it before returning
export async function ensureIncrementalAccountEvidence(database: AccountDatabase, token: ProfileToken, store: ReturnType<typeof createAccountLocalStore>, local: AdmittedLocalSnapshot, checkpoint: () => Promise<void> = async () => {}, retain?: (handle: AccountInheritedEvidence, dispose: () => Promise<void>) => void): Promise<CipherRef | undefined> {
  admittedLocalReferences(local, store.adapter)
  const check = async () => { assertActiveProfile(token); await checkpoint(); assertActiveProfile(token) }
  const inherited = await readLocalEvidence(store.adapter, local.root.inheritedEvidence, check)
  if (!inherited) return undefined
  const key = evidenceKey(local.root.inheritedEvidence), mapped = await readIncrementalAccountEvidence(database, token, local.root.inheritedEvidence)
  if (mapped) {
    const evidence = await openAccountInheritedEvidence(database, token, mapped)
    let retained = false
    try {
      // Both complete sources authenticate their stored frames before set identity is compared
      // The digest alone cannot stand in for the exact encrypted account/sidecar association
      if (evidence.setDigest !== inherited.setDigest) throw new Error('Managed historical association differs')
      await evidence.check(); await inherited.check(); await check()
      if (retain) { retain(evidence, () => evidence.dispose()); retained = true }
      return mapped
    } finally { if (!retained) await evidence.dispose() }
  }
  const owner = createAccountInheritedEvidencePreparation(database, token)
  let retained = false
  try {
    const prepared = await owner.prepare({ sourceEvidence: inherited })
    if (prepared.handle.setDigest !== inherited.setDigest) throw new Error('Managed historical preparation differs')
    await installRecords(database, token, prepared.records, check)
    const value = evidenceAssociationSchema.parse({ version: 1, kind: 'incremental-evidence-association', accountId: token.accountId, localEvidence: local.root.inheritedEvidence, evidence: prepared.root })
    const record = await stageAccountJson(database, token, value, [value.localEvidence, value.evidence])
    await installRecords(database, token, [record], check)
    await prepared.handle.check(); await inherited.check(); await check()
    await mappingTransaction(database, token, [database.syncState], async () => {
      if (await database.syncState.get(key)) throw new Error('Managed historical association was already selected')
      await database.syncState.add({ id: key, ref: cipherRef(record) })
    })
    if (retain) { retain(prepared.handle, () => owner.abandon()); retained = true }
    return prepared.root
  } finally { if (!retained) await owner.abandon() }
}

async function prepareNativeLocal(database: AccountDatabase, token: ProfileToken, store: ReturnType<typeof createAccountLocalStore>, local: AdmittedLocalSnapshot, previous: OpenAccountWorkspace | undefined, state: WorkspaceState, check: () => Promise<void>, cleanup: (() => Promise<void>)[], historyReuse?: AccountHistoryReuse): Promise<PreparedAccountWorkspace> {
  // This native view is publication-only; the selected managed root remains Undo/backup authority
  // Covered frames remain in semantic history, avoiding a second encrypted checkpoint copy with
  // fresh wire dependencies on every projection; unmatched legacy journals retain the full codec
  // Keep the operative change channel: retained semantic changes can have independent device clocks
  if (state.planner === local.state.planner && state.planner.journal && localJournalCoveredByHistory(local, store.adapter)) {
    state = { ...state, planner: { ...state.planner, journal: { ...state.planner.journal, checkpoints: [] } } }
  }
  let verified: AccountInheritedEvidence | undefined
  // The existing mapping cleanup scope owns this reader until its receipt is staged
  // Reuse producer validation only within that scope; another realm must reopen durable ciphertext
  const inherited = await ensureIncrementalAccountEvidence(database, token, store, local, check, (handle, dispose) => { verified = handle; cleanup.push(dispose) })
  const previousEvidence = previous?.inheritedEvidence
  let native: PreparedAccountWorkspace
  if (!inherited || same(previousEvidence, inherited)) native = await prepareAccountWorkspace(database, token, state, previous, undefined, historyReuse)
  else if (!previousEvidence) native = await prepareAccountWorkspaceWithExistingEvidence(database, token, state, verified ?? inherited, previous, undefined, historyReuse)
  else {
    const { accountEvidenceContains, prepareAccountEvidenceUnion } = await import('./account-evidence-union')
    if (await accountEvidenceContains(database, token, previousEvidence, inherited)) native = await prepareAccountWorkspace(database, token, state, previous, undefined, historyReuse)
    else if (await accountEvidenceContains(database, token, inherited, previousEvidence)) native = await prepareAccountWorkspaceWithExistingEvidence(database, token, state, verified ?? inherited, previous, undefined, historyReuse)
    else {
      const union = await prepareAccountEvidenceUnion(database, token, previousEvidence, inherited)
      cleanup.push(() => union.dispose())
      native = await prepareAccountWorkspaceWithEvidence(database, token, state, union.prepared, previous, undefined, historyReuse)
    }
  }
  return verified && same(native.opened.inheritedEvidence, verified.root) ? { ...native, validatedEvidence: verified } : native
}

async function readReceipt(database: AccountDatabase, token: ProfileToken, ticket: IncrementalMappingTicket) {
  ticket = IncrementalMappingTicketSchema.parse(ticket)
  const pointer = await database.syncState.get(operationKey(ticket.operationId))
  if (!pointer || !same(pointer.ref, ticket.receipt)) throw new Error('Mapping receipt identity changed')
  const receipt = await openAccountJson(database, token, pointer.ref, receiptSchema)
  if (receipt.accountId !== token.accountId || receipt.intent.operationId !== ticket.operationId || receipt.original.id !== ticket.operationId
    || !same(receipt.intent.publicationBase, receipt.original.publicationBase)) throw new Error('Foreign mapping receipt')
  return { pointer, receipt }
}

export async function prepareIncrementalMapping(database: AccountDatabase, token: ProfileToken, input: AccountIntentRecord, checkpoint: () => Promise<void> = async () => {}) : Promise<IncrementalMappingTicket> {
  assertActiveProfile(token)
  if (database.accountId !== token.accountId) throw new Error('Foreign mapping account')
  const original = rowSchema.parse(structuredClone(input)), key = operationKey(original.id)
  const check = async () => { assertActiveProfile(token); await checkpoint(); assertActiveProfile(token) }
  const existing = await database.syncState.get(key)
  if (existing) {
    const ticket = { version: 1 as const, operationId: original.id, receipt: existing.ref }
    const { receipt } = await readReceipt(database, token, ticket)
    if (!same(receipt.original, original)) throw new Error('Mapping input changed')
    return ticket
  }
  if (!same(await database.outbox.get(original.id), original)) throw new Error('Mapping outbox changed')
  const intent = await openAccountJson(database, token, original.ref, IncrementalWorkspaceIntentSchema)
  const journal = await database.migrationJournal.get(original.id)
  if (intent.operationId !== original.id || intent.sequence !== journal?.headRevision || !same(journal.head, intent.after)
    || !same(journal.intent, original.ref) || !same(intent.publicationBase, original.publicationBase)) throw new Error('Mapping intent admission changed')
  const predecessor = await database.syncState.get(rootKey(intent.before))
  let base: OpenAccountWorkspace | undefined
  if (predecessor) {
    const value = await openAccountJson(database, token, predecessor.ref, z.union([receiptSchema, AccountMappingOriginSchema]))
    if (value.accountId !== token.accountId) throw new Error('Foreign mapping predecessor')
    let mapped: CipherRef | undefined
    if (value.kind === 'incremental-mapping-origin') {
      if (same(value.localRoot, intent.before) && value.headRevision === intent.sequence - 1) mapped = value.mappedRoot
    } else if (same(value.intent.after, intent.before)) {
      if (value.intent.sequence === intent.sequence - 1) mapped = value.target
    } else if (same(value.intent.before, intent.before)) mapped = value.base
    if (!mapped) throw new Error('Mapping predecessor changed')
    base = await openAccountWorkspace(database, token, mapped)
  } else {
    // A pending earlier command cannot be independently remapped as a new baseline
    // Its receipt remains addressable even after accepted publication removes the old outbox row
    const prior = (await database.migrationJournal.toArray()).find(value => same(value.head, intent.before))
    if (!prior || prior.intent) throw new Error('The mapping predecessor is not ready')
  }
  const store = createAccountLocalStore(database, token)
  const cleanup: (() => Promise<void>)[] = []
  const materialize = (local: AdmittedLocalSnapshot, previous?: OpenAccountWorkspace, state: WorkspaceState = local.state, historyReuse?: AccountHistoryReuse) => prepareNativeLocal(database, token, store, local, previous, state, check, cleanup, historyReuse)
  try {
    const before = await admitLocalRoot(store.adapter, intent.before, { check: () => assertActiveProfile(token), assertCurrent: check })
    const after = await admitLocalRoot(store.adapter, intent.after, { check: () => assertActiveProfile(token), assertCurrent: check })
    if (!base) {
      const prepared = await materialize(before)
      await installRecords(database, token, prepared.records, check)
      base = prepared.opened
    }
    // Earlier mapped pending closures are operational retention, absent from the foreground local root
    // Carry their exact declared bodies forward so the next semantic diff does not invent deletions of them
    const pending = new Map(after.state.retainedContent.map(value => [value.id, value]))
    const bodies = new Map(after.state.blobs.map(body => [blobIdentity(body.ref), body]))
    const carriedClosures: WorkspaceConflictClosure[] = []
    for (const value of base.state.retainedContent) if (value.kind === 'pending-content') {
      if (pending.has(value.id) && !same(pending.get(value.id), value)) throw new Error('Pending mapping identity changed')
      pending.set(value.id, value)
      carriedClosures.push(...(value.base.kind === 'present' ? [value.base.closure] : []), value.target)
    }
    for (const inspected of await inspectWorkspaceClosures(base.state, carriedClosures)) {
      for (const id of inspected.refs) {
        const body = base.state.blobs.find(body => blobIdentity(body.ref) === id)!
        if (bodies.has(id) && !same(bodies.get(id)!.ref, body.ref)) throw new Error('Pending mapping body identity changed')
        bodies.set(id, bodies.get(id) ?? body)
      }
    }
    const historyReuse = predecessor ? await prepareAccountHistoryReuse(database, token, before, after, store.adapter, base, intent.sequence - 1) : undefined
    const semantic = await materialize(after, base, { ...after.state, retainedContent: [...pending.values()], blobs: [...bodies.values()] }, historyReuse)
    await installRecords(database, token, semantic.records, check)
    // These intermediate views are owned outputs of the existing native producer, not stored-read authority
    // The final current graph is independently reopened before a receipt; its archive can reuse live validation in this scope
    const opened = semantic.opened
    const changes = mappedChanges(base, opened), portableGroupId = accountLocalId()
    const retained = await retainPendingUnits(opened.state, base, opened, portableGroupId, changes)
    const target = await prepareAccountWorkspace(database, token, retained, opened)
    await installRecords(database, token, target.records, check)
    await openAccountWorkspace(database, token, target.head, same(semantic.validatedEvidence?.root, target.opened.inheritedEvidence) ? semantic.validatedEvidence : undefined)
    const mapped = await stageMappedWorkspaceIntent(database, token, { version: 1, kind: 'mapped-workspace-intent', operationId: original.id, portableGroupId, operation: intent.operation, mode: intent.mode, original: { base: intent.before, target: intent.after }, base: base.head, target: target.head, localRevision: intent.sequence, changes, ...(intent.conflictResolution ? { conflictResolution: intent.conflictResolution } : {}) })
    await installRecords(database, token, mapped.records, check)
    const receipt = receiptSchema.parse({ version: 1, kind: 'incremental-mapping-receipt', accountId: token.accountId, original, intent, base: base.head, target: target.head, mappedIntent: cipherRef(mapped.record), ...(predecessor ? { predecessor } : {}) })
    const record = await stageAccountJson(database, token, receipt, [original.ref, intent.before, intent.after, base.head, target.head, receipt.mappedIntent, ...(predecessor ? [predecessor.ref] : [])])
    await installRecords(database, token, [record], check)
    await check()
    await mappingTransaction(database, token, [database.syncState, database.outbox, database.migrationJournal], async () => {
      assertActiveProfile(token)
      if (await database.syncState.get(key) || !same(await database.outbox.get(original.id), original) || !same(await database.migrationJournal.get(original.id), journal)
        || !same(await database.syncState.get(rootKey(intent.before)), predecessor)) throw new Error('Mapping preparation changed')
      await database.syncState.add({ id: key, ref: cipherRef(record) })
      assertActiveProfile(token)
    })
    return { version: 1, operationId: original.id, receipt: cipherRef(record) }
  } finally { await store.dispose(); for (const dispose of cleanup.reverse()) await dispose() }
}

export async function activateIncrementalMapping(database: AccountDatabase, token: ProfileToken, input: IncrementalMappingTicket, checkpoint: () => Promise<void> = async () => {}): Promise<void> {
  assertActiveProfile(token)
  const ticket = IncrementalMappingTicketSchema.parse(structuredClone(input))
  const { pointer, receipt } = await readReceipt(database, token, ticket)
  const replacement: AccountIntentRecord = { ...receipt.original, ref: receipt.mappedIntent, status: 'mapped-local' }
  await checkpoint(); assertActiveProfile(token)
  await mappingTransaction(database, token, [database.syncState, database.outbox], async () => {
    assertActiveProfile(token)
    if (!same(await database.syncState.get(pointer.id), pointer)) throw new Error('Mapping receipt changed')
    const actual = await database.outbox.get(receipt.original.id)
    if (same(actual, replacement)) return
    if (!same(actual, receipt.original) || !same(await database.syncState.get(rootKey(receipt.intent.before)), receipt.predecessor)) throw new Error('Mapping activation changed')
    if (await database.syncState.get(rootKey(receipt.intent.after))) throw new Error('Mapping target identity was reused')
    // These exact immutable associations outlive outbox removal and preserve the next command's native base
    if (!receipt.predecessor) await database.syncState.add({ id: rootKey(receipt.intent.before), ref: pointer.ref })
    await database.syncState.add({ id: rootKey(receipt.intent.after), ref: pointer.ref })
    await database.outbox.put(replacement)
    assertActiveProfile(token)
  })
}

const baselineKey = (operationId: string) => `incremental-baseline:${operationId}`

export { readIncrementalMappedRoot } from './account-mapping-origin'

async function readBaseline(database: AccountDatabase, token: ProfileToken, input: IncrementalMappingTicket) {
  const ticket = IncrementalMappingTicketSchema.parse(input)
  const pointer = await database.syncState.get(baselineKey(ticket.operationId))
  if (!pointer || !same(pointer.ref, ticket.receipt)) throw new Error('Mapping baseline identity changed')
  const origin = await openAccountJson(database, token, pointer.ref, AccountMappingOriginSchema)
  if (origin.accountId !== token.accountId || origin.operationId !== ticket.operationId) throw new Error('Foreign mapping baseline')
  const journal = await database.migrationJournal.get(origin.operationId)
  if (!journal || journal.intent || journal.headRevision !== origin.headRevision || !same(journal.head, origin.localRoot)) throw new Error('Mapping baseline source changed')
  return { pointer, origin, journal }
}

export async function prepareIncrementalBaseline(database: AccountDatabase, token: ProfileToken, input: AccountFence, checkpoint: () => Promise<void> = async () => {}): Promise<IncrementalMappingTicket> {
  assertActiveProfile(token)
  const fence = structuredClone(input)
  // Only the committed no-command origin can establish an initial baseline; later saves map in sequence
  // This one-time lookup is outside ordinary saves and never substitutes the currently selected root
  const journal = (await database.migrationJournal.toArray()).find(row => same(row.head, fence.head) && row.headRevision === fence.headRevision)
  if (!journal || journal.intent) throw new Error('The mapping baseline is not an initial root')
  const existing = await database.syncState.get(baselineKey(journal.id))
  if (existing) {
    const ticket = { version: 1 as const, operationId: journal.id, receipt: existing.ref }
    await readBaseline(database, token, ticket)
    return ticket
  }
  const store = createAccountLocalStore(database, token), cleanup: (() => Promise<void>)[] = []
  const check = async () => { assertActiveProfile(token); await checkpoint(); assertActiveProfile(token) }
  try {
    const local = await admitLocalRoot(store.adapter, fence.head, { check: () => assertActiveProfile(token), assertCurrent: check })
    const prepared = await prepareNativeLocal(database, token, store, local, undefined, local.state, check, cleanup)
    await installRecords(database, token, prepared.records, check)
    await openAccountWorkspace(database, token, prepared.head, prepared.validatedEvidence)
    const origin = AccountMappingOriginSchema.parse({ version: 1, kind: 'incremental-mapping-origin', accountId: token.accountId, operationId: journal.id, localRoot: fence.head, mappedRoot: prepared.head, headRevision: fence.headRevision })
    const record = await stageAccountJson(database, token, origin, [origin.localRoot, origin.mappedRoot])
    await installRecords(database, token, [record], check)
    await mappingTransaction(database, token, [database.syncState, database.migrationJournal], async () => {
      if (!same(await database.migrationJournal.get(journal.id), journal) || await database.syncState.get(baselineKey(journal.id)) || await database.syncState.get(rootKey(fence.head))) throw new Error('Mapping baseline preparation changed')
      await database.syncState.add({ id: baselineKey(journal.id), ref: cipherRef(record) })
    })
    return { version: 1, operationId: journal.id, receipt: cipherRef(record) }
  } finally { await store.dispose(); for (const dispose of cleanup.reverse()) await dispose() }
}

export async function activateIncrementalBaseline(database: AccountDatabase, token: ProfileToken, input: IncrementalMappingTicket, checkpoint: () => Promise<void> = async () => {}, expected?: AccountFence): Promise<void> {
  expected = expected && structuredClone(expected)
  const { pointer, origin, journal } = await readBaseline(database, token, structuredClone(input))
  if (expected && (!same(expected.head, origin.localRoot) || expected.headRevision !== origin.headRevision)) throw new Error('Mapping baseline response changed')
  await checkpoint(); assertActiveProfile(token)
  await mappingTransaction(database, token, [database.syncState, database.migrationJournal], async () => {
    if (!same(await database.syncState.get(pointer.id), pointer) || !same(await database.migrationJournal.get(journal.id), journal)) throw new Error('Mapping baseline changed')
    const key = rootKey(origin.localRoot), selected = await database.syncState.get(key)
    if (selected && !same(selected.ref, pointer.ref)) throw new Error('Mapping baseline was already selected')
    if (!selected) await database.syncState.add({ id: key, ref: pointer.ref })
  })
}
