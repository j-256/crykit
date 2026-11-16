import { z } from 'zod'
import { assertActiveProfile, type ProfileToken } from '../account/profile'
import { maxDocumentBytes, OpaqueIdSchema } from '../account/protocol'
import type { AccountDatabase, AccountFence, CipherRef } from '../persistence/account-database'
import { guestPlannerValuesEqual as same } from '../persistence/guest-planner-equality'
import { attachBackupBodies, capturedBackupEvidence, historicalMetadataIdentity, readBackupMetadata, type SnapshotMetadataV1 } from '../interchange/workspace-backup-evidence'
import { parseBoundedJson } from '../interchange/json'
import { GuestCopyJournalSchema, SAVED_COPY_PREFIX } from './guest-copy-journal'
import { CipherRefSchema } from './account-cache'
import { memoryBlob, readBlob, blobIdentity, hashBlob } from './blobs'
import { WorkspaceConflictSchema } from './file-schemas'
import { SigninProgressMappingSchema, signinProgressCorrespondence } from './signin-progress'
import { applicableCopiedComparisons } from './copied-branch'
import { admitLocalRoot, admittedLocalReferences, type LocalStoreAdapter, type AdmittedLocalSnapshot } from './local-root'
import { readLocalEvidence } from './local-evidence'
import { guestEvidenceSources } from './guest-evidence'
import { assertOwnedWorkspaceSnapshot, ownWorkspaceSnapshot, snapshotMetadata, type WorkspaceSnapshot } from './snapshot'
import { sameCipherRefs } from './account-retaining'
import { IncrementalWorkspaceIntentSchema, readIncrementalMappedRoot, type IncrementalWorkspaceIntent } from './account-mapping-origin'
import { openAccountWorkspace, type OpenAccountWorkspace } from './account-graph'
import { assertAccountInheritedEvidenceOwner, accountInheritedSources, type AccountInheritedEvidence } from './account-evidence-snapshots'

declare const __CRYKIT_MANAGED_COMPARISON_QUALIFICATION__: boolean
// Only the explicit synthetic browser build defines this rollout capability as true
// Old-client transport qualification is required before a production writer can be enabled
export function managedComparisonWritesEnabled(): boolean {
  return typeof __CRYKIT_MANAGED_COMPARISON_QUALIFICATION__ !== 'undefined' && __CRYKIT_MANAGED_COMPARISON_QUALIFICATION__
}
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const ManagedCopyComparisonsSchema = z.strictObject({
  version: z.literal(1), kind: z.literal('managed-copy-comparisons'), operationId: OpaqueIdSchema, mode: z.literal('additive'),
  source: CipherRefSchema, sourceEvidence: CipherRefSchema, sourceIdentity: digest, sourceDigest: digest,
  destination: z.strictObject({ key: z.literal('active'), headRevision: z.number().int().nonnegative().safe(), head: CipherRefSchema }), destinationEvidence: CipherRefSchema,
  keys: z.array(z.string().min(1)), progressMappings: z.array(SigninProgressMappingSchema), originals: z.array(WorkspaceConflictSchema),
}).superRefine((value, context) => {
  if (new Set(value.keys).size !== value.keys.length || new Set(value.originals.map(original => original.id)).size !== value.originals.length
    || new Set(value.progressMappings.map(mapping => mapping.sourceKey)).size !== value.progressMappings.length
    || new Set(value.progressMappings.map(mapping => mapping.destinationKey)).size !== value.progressMappings.length)
    context.addIssue({ code: 'custom', message: 'Duplicate comparison association' })
})
export type ManagedCopyComparisons = z.infer<typeof ManagedCopyComparisonsSchema>
const dependencies = (value: ManagedCopyComparisons) => [...new Map([value.source, value.sourceEvidence, value.destination.head, value.destinationEvidence].map(ref => [blobIdentity(ref), ref])).values()]

export async function stageManagedCopyComparisons(adapter: LocalStoreAdapter, operationId: string, selected: WorkspaceSnapshot, source: AdmittedLocalSnapshot, destination: AdmittedLocalSnapshot, fence: AccountFence, keys: readonly string[], progressMappings: ManagedCopyComparisons['progressMappings']): Promise<CipherRef> {
  await assertOwnedWorkspaceSnapshot(selected)
  const identity = await historicalMetadataIdentity(capturedBackupEvidence(selected).current)
  const value = ManagedCopyComparisonsSchema.parse({ version: 1, kind: 'managed-copy-comparisons', operationId, mode: 'additive', source: source.head, sourceEvidence: source.root.inheritedEvidence, sourceIdentity: identity.id, sourceDigest: identity.metadataStreamDigest, destination: fence, destinationEvidence: destination.root.inheritedEvidence, keys, progressMappings, originals: await applicableCopiedComparisons(selected.state) })
  return adapter.stage(operationId, memoryBlob(new TextEncoder().encode(JSON.stringify(value))), dependencies(value))
}

// The sidecar is inert until its exact local intent, source archive and captured destination agree
// Use the caller's adapter so every authenticated ciphertext observation joins the activation CAS
export async function readManagedCopyComparisons(database: AccountDatabase, token: ProfileToken, adapter: LocalStoreAdapter, intent: Extract<IncrementalWorkspaceIntent, { version: 2 }>, before: AdmittedLocalSnapshot, check: () => Promise<void>, intentRef: CipherRef) {
  await check()
  admittedLocalReferences(before, adapter)
  const intentBytes = await readBlob(await adapter.read(intentRef), maxDocumentBytes)
  try { if (!same(IncrementalWorkspaceIntentSchema.parse(parseBoundedJson(intentBytes, 'managed comparison intent')), intent)) throw new Error('Managed comparison intent changed') }
  finally { intentBytes.fill(0) }
  const intentRecord = await database.encryptedRevisions.get(intentRef.revisionId)
  if (!intentRecord || !sameCipherRefs(intentRecord.descriptor.dependencies, [intent.before, intent.after, intent.copiedComparisons, ...(intent.publicationBase ? [intent.publicationBase] : [])])) throw new Error('Managed comparison intent dependencies changed')
  const bytes = await readBlob(await adapter.read(intent.copiedComparisons), maxDocumentBytes)
  let value: ManagedCopyComparisons
  try { value = ManagedCopyComparisonsSchema.parse(parseBoundedJson(bytes, 'managed copy comparisons')) }
  finally { bytes.fill(0) }
  const record = await database.encryptedRevisions.get(intent.copiedComparisons.revisionId)
  if (!record || record.descriptor.accountId !== token.accountId || record.descriptor.documentId !== intent.copiedComparisons.documentId
    || !sameCipherRefs(record.descriptor.dependencies, dependencies(value)) || value.operationId !== intent.operationId || value.mode !== intent.mode
    || !same(value.destination.head, intent.before) || value.destination.headRevision + 1 !== intent.sequence
    || !same(before.head, value.destination.head) || !same(before.root.inheritedEvidence, value.destinationEvidence)) throw new Error('Managed comparison intent association changed')
  const saved = await database.syncState.get(`${SAVED_COPY_PREFIX}${intent.operationId}`)
  if (!saved) throw new Error('Managed comparison saved copy is missing')
  const journalBytes = await readBlob(await adapter.read(saved.ref), maxDocumentBytes)
  let journal: z.infer<typeof GuestCopyJournalSchema>
  try { journal = GuestCopyJournalSchema.parse(parseBoundedJson(journalBytes, 'managed comparison journal')) }
  finally { journalBytes.fill(0) }
  if (journal.version !== 2 || journal.preview.accountId !== token.accountId || journal.preview.copyId !== intent.operationId
    || !same(journal.intent, intentRef) || !same(journal.expected, value.destination) || !same(journal.target, intent.after)
    || !same(journal.preview.conflicts.filter(key => JSON.parse(key)[0] !== 'conflict'), value.keys)
    || !same(journal.preview.signin?.progressMappings ?? [], value.progressMappings)) throw new Error('Managed comparison saved copy changed')
  const journalRecord = await database.encryptedRevisions.get(saved.ref.revisionId)
  if (!journalRecord || !sameCipherRefs(journalRecord.descriptor.dependencies, [journal.expected.head, journal.target, journal.intent])) throw new Error('Managed comparison journal dependencies changed')
  const source = await admitLocalRoot(adapter, value.source, { check: () => assertActiveProfile(token), assertCurrent: check })
  if (!same(source.root.inheritedEvidence, value.sourceEvidence)) throw new Error('Managed comparison source evidence changed')
  const evidence = await readLocalEvidence(adapter, value.sourceEvidence, check)
  if (!evidence) throw new Error('Managed comparison originals are missing')
  const sources = guestEvidenceSources(evidence), member = sources.members.find(item => item.id === value.sourceIdentity)
  if (!member || (await historicalMetadataIdentity(member.metadata)).metadataStreamDigest !== value.sourceDigest) throw new Error('Managed comparison original identity changed')
  const original = ownWorkspaceSnapshot(attachBackupBodies(await readBackupMetadata(member.metadata) as SnapshotMetadataV1, new Map(sources.bodies.map(body => [blobIdentity(body.ref), body]))), { check: async () => { await evidence.check(); await check() }, dispose: async () => {} })
  const metadata = (state: WorkspaceSnapshot['state']) => snapshotMetadata({ ...original, state }).state
  if (!same(metadata(original.state), metadata(source.state)) || !same(await applicableCopiedComparisons(original.state), value.originals)) throw new Error('Managed comparison source differs from its original')
  const correspondence = signinProgressCorrespondence(source.state, before.state)
  if (value.progressMappings.some(mapping => !correspondence.mappings.some(expected => same(expected, mapping)))) throw new Error('Managed comparison Progress association changed')
  for (const body of source.state.blobs) if (await hashBlob(body.content) !== body.ref.sha256) throw new Error('Managed comparison source body changed')
  await evidence.check(); await check()
  const freeze = (input: unknown): void => { if (input && typeof input === 'object' && !Object.isFrozen(input)) { for (const child of Object.values(input)) freeze(child); Object.freeze(input) } }
  freeze(value)
  const admitted = Object.freeze({ value, source, original })
  admissions.set(admitted, { database, token, check })
  return admitted
}

const admissions = new WeakMap<object, { database: AccountDatabase; token: ProfileToken; check: () => Promise<void> }>()

export interface ManagedComparisonMappingProof { readonly kind: 'managed-comparison-mapping' }
interface MappingBinding { readonly database: AccountDatabase; readonly token: ProfileToken; readonly source: OpenAccountWorkspace; readonly destination: OpenAccountWorkspace; readonly evidence: AccountInheritedEvidence; readonly value: ManagedCopyComparisons }
const mappings = new WeakMap<ManagedComparisonMappingProof, MappingBinding>()
// A materialized source has new transport identities. Mint a separate authority only after
// exact original metadata and bytes have been associated; direct-copy object identity stays strict
export async function proveManagedComparisonMapping(database: AccountDatabase, token: ProfileToken, admitted: Awaited<ReturnType<typeof readManagedCopyComparisons>>, source: OpenAccountWorkspace, destination: OpenAccountWorkspace, evidence: AccountInheritedEvidence): Promise<ManagedComparisonMappingProof> {
  const admission = admissions.get(admitted)
  if (!admission || admission.database !== database || admission.token !== token) throw new Error('Foreign managed comparison admission')
  await admission.check()
  await assertOwnedWorkspaceSnapshot(admitted.original)
  await assertAccountInheritedEvidenceOwner(evidence, database, token)
  const destinationHead = await readIncrementalMappedRoot(database, token, admitted.value.destination)
  if (!destinationHead || !same(destinationHead, destination.head)) throw new Error('Managed comparison native destination changed')
  // Producer-shaped values do not authenticate a native graph or its entry identities
  // Reopen installed bytes after local activation, then bind only those admitted views
  const nativeSource = await openAccountWorkspace(database, token, source.head, evidence)
  const nativeDestination = await openAccountWorkspace(database, token, destinationHead)
  if (!same(nativeSource.entries, source.entries) || !same(nativeDestination.entries, destination.entries)
    || !same(snapshotMetadata({ ...admitted.original, state: nativeSource.state }).state, snapshotMetadata({ ...admitted.original, state: source.state }).state)) throw new Error('Managed comparison native materialization changed')
  source = nativeSource
  destination = nativeDestination
  if (!same(source.inheritedEvidence, evidence.root)) throw new Error('Managed comparison native evidence changed')
  const actual = snapshotMetadata({ ...admitted.original, state: source.state }).state
  if (!same(actual, snapshotMetadata(admitted.original).state)) throw new Error('Managed comparison materialization differs from its original')
  const sources = await accountInheritedSources(evidence), member = sources.members.find(value => value.id === admitted.value.sourceIdentity)
  if (!member || (await historicalMetadataIdentity(member.metadata)).metadataStreamDigest !== admitted.value.sourceDigest) throw new Error('Managed comparison native originals changed')
  for (const body of source.state.blobs) if (await hashBlob(body.content) !== body.ref.sha256) throw new Error('Managed comparison materialized body changed')
  const proof: ManagedComparisonMappingProof = Object.freeze({ kind: 'managed-comparison-mapping' })
  mappings.set(proof, { database, token, source, destination, evidence, value: admitted.value })
  return proof
}
export async function managedComparisonMappingBinding(proof: ManagedComparisonMappingProof, database: AccountDatabase, token: ProfileToken) {
  const binding = mappings.get(proof)
  if (!binding || binding.database !== database || binding.token !== token) throw new Error('Foreign managed comparison proof')
  await assertAccountInheritedEvidenceOwner(binding.evidence, database, token)
  return binding
}
