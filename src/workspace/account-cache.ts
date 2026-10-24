import { accountWorkCheckpoint } from '../account/background-work'
import { z } from 'zod'
import { encryptRevision, decryptRevision } from '../account/crypto/revisions'
import { withAccountKey, assertActiveProfile, type ProfileToken } from '../account/profile'
import { OpaqueIdSchema, RevisionDescriptorSchema, opaqueIdBytes } from '../account/protocol'
import { AccountDatabase, type CipherChunk, type CipherRecord, type CipherRef } from '../persistence/account-database'
import { NativeCatalogSnapshotSchema, NativeEvidenceSchema, NativeHistorySchema, NativeLineageSchema, NativeLocalDataSchema, NativeSourceManifestSchema } from '../interchange/native-schema'
import { NATIVE_BACKUP_JSON_LIMITS, parseBoundedJson } from '../interchange/json'
import { NATIVE_BACKUP_ARCHIVE_LIMITS } from '../interchange/zip'
import { WorkspaceError } from './repository'
import { beginPreparedRead, resolveAccountRecord, runAccountStage, type AccountPreparationOwner } from './account-prepared-records'

export const CipherRefSchema = z.object({ documentId: OpaqueIdSchema, revisionId: OpaqueIdSchema }).strict()
export const AccountSourceSchema = NativeSourceManifestSchema.omit({ path: true, size: true }).extend({ original: CipherRefSchema }).strict()
export const AccountProjectionSchema = z.object({
  version: z.literal(1), kind: z.literal('local-planner-cache'), localData: NativeLocalDataSchema,
  lineage: NativeLineageSchema, catalogs: z.array(NativeCatalogSnapshotSchema),
  bundledCatalogs: z.array(z.object({ id: z.string(), revisionId: z.string(), checksum: z.string() }).strict()),
  evidence: z.array(NativeEvidenceSchema), sources: z.array(AccountSourceSchema), history: CipherRefSchema.optional(),
}).strict()
export type AccountProjection = z.infer<typeof AccountProjectionSchema>
export const AccountHistorySchema = z.object({ version: z.literal(1), kind: z.literal('local-planner-history'), entry: NativeHistorySchema, previous: CipherRefSchema.optional() }).strict()
export const AccountIntentSchema = z.object({ version: z.literal(1), kind: z.literal('unmapped-planner-intent'), operationId: OpaqueIdSchema, operation: z.enum(['save', 'undo']), mode: z.literal('additive'), base: CipherRefSchema, target: CipherRefSchema, localRevision: z.number().int().nonnegative() }).strict()
export type AccountLocalIntent = z.infer<typeof AccountIntentSchema>

export function accountLocalId(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(opaqueIdBytes)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function cipherRef(record: CipherRecord): CipherRef { return { documentId: record.descriptor.documentId, revisionId: record.revisionId } }

export async function readAccountCipherChunk(database: AccountDatabase, token: ProfileToken, payloadId: string, index: number): Promise<CipherChunk | undefined> {
  assertActiveProfile(token)
  // An implicit get resolves before its native transaction completes, so synchronous decoding
  // in its continuation can keep the mapper's reader blocking a foreground write
  // Finish this bounded native read before crypto, consumer work or a scheduler pause
  const chunk = await database.transaction('r', database.stagedCipherChunks, () => database.stagedCipherChunks.get([payloadId, index]))
  assertActiveProfile(token)
  await accountWorkCheckpoint(token)
  return chunk
}

export function stageAccountBytes(database: AccountDatabase, token: ProfileToken, bytes: Uint8Array, dependencies: readonly CipherRef[], previous?: CipherRef, owner?: AccountPreparationOwner): Promise<CipherRecord> {
  assertActiveProfile(token)
  const payloadId = accountLocalId()
  return runAccountStage(database, token, payloadId, owner, async lease => {
    const result = await withAccountKey(token, key => encryptRevision(key, {
      format: 1, accountId: token.accountId, documentId: previous?.documentId ?? accountLocalId(), revisionId: accountLocalId(),
      parents: previous ? [previous.revisionId] : [], dependencies, protected: true, plainBytes: bytes.byteLength,
    }, accountLocalId(), (async function* () { yield bytes })(), {
      id: payloadId,
      write: async (index, ciphertext) => { await accountWorkCheckpoint(token); return lease.write(index, ciphertext) },
    }))
    return { revisionId: result.descriptor.revisionId, payloadId, descriptor: result.descriptor }
  })
}
export async function stageAccountJson(database: AccountDatabase, token: ProfileToken, value: unknown, dependencies: readonly CipherRef[], previous?: CipherRef, owner?: AccountPreparationOwner): Promise<CipherRecord> {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  const capturedDependencies = dependencies.map(ref => ({ ...ref })), capturedPrevious = previous && { ...previous }
  try {
    await accountWorkCheckpoint(token)
    // This cache is a bounded legacy planner projection, never a whole-account/source container
    if (bytes.byteLength > NATIVE_BACKUP_ARCHIVE_LIMITS.maxEntryUncompressedBytes) throw new WorkspaceError('LOCAL_MATERIALIZATION_LIMIT', 'This planner projection exceeds the local legacy format limit.')
    return await stageAccountBytes(database, token, bytes, capturedDependencies, capturedPrevious, owner)
  } finally { bytes.fill(0) }
}
export async function readAccountBytes(database: AccountDatabase, token: ProfileToken, ref: CipherRef, limit = NATIVE_BACKUP_ARCHIVE_LIMITS.maxEntryUncompressedBytes, owner?: AccountPreparationOwner): Promise<Uint8Array> {
  assertActiveProfile(token)
  const lease = beginPreparedRead(owner)
  try {
    const record = await resolveAccountRecord(database, token, ref, owner)
    return await decryptAccountRecordBytes(database, token, ref, record, limit, lease)
  } finally { lease?.finish() }
}

// A captured structural record may be authenticated before installation; callers must separately
// establish that the record is the operation's proposed input, not trust its `opened` claim
export async function readAccountRecordBytes(database: AccountDatabase, token: ProfileToken, ref: CipherRef, record: CipherRecord, limit = NATIVE_BACKUP_ARCHIVE_LIMITS.maxEntryUncompressedBytes): Promise<Uint8Array> {
  return decryptAccountRecordBytes(database, token, ref, record, limit)
}

async function decryptAccountRecordBytes(database: AccountDatabase, token: ProfileToken, ref: CipherRef, record: CipherRecord, limit: number, lease?: ReturnType<typeof beginPreparedRead>): Promise<Uint8Array> {
  lease?.check()
  // Parsing copies the proposed descriptor before any await, so a caller cannot retarget the
  // account or full ref while the independent authentication pass reads ciphertext
  const descriptor = RevisionDescriptorSchema.parse(record.descriptor), payloadId = OpaqueIdSchema.parse(record.payloadId)
  if (descriptor.documentId !== ref.documentId || descriptor.accountId !== token.accountId || database.accountId !== token.accountId) throw new WorkspaceError('LOCAL_INTEGRITY_FAILED', 'The encrypted revision is missing or belongs to another workspace.')
  if (record.revisionId !== ref.revisionId || descriptor.revisionId !== ref.revisionId) throw new WorkspaceError('LOCAL_INTEGRITY_FAILED', 'The encrypted revision identity is invalid.')
  if (descriptor.plainBytes > limit) throw new WorkspaceError('LOCAL_MATERIALIZATION_LIMIT', 'This source exceeds the legacy materialization limit. Use a complete account backup when available.')
  const bytes = new Uint8Array(descriptor.plainBytes)
  let offset = 0
  async function* chunks() {
    for (const chunk of descriptor.chunks) {
      assertActiveProfile(token)
      lease?.check()
      await accountWorkCheckpoint(token)
      const stored = await readAccountCipherChunk(database, token, payloadId, chunk.index)
      lease?.check()
      if (!stored) throw new WorkspaceError('LOCAL_INTEGRITY_FAILED', 'Encrypted source chunks are missing.')
      yield stored.bytes
    }
  }
  try {
    await withAccountKey(token, key => decryptRevision(key, descriptor, chunks(), {
      write: async part => { lease?.check(); bytes.set(part, offset); offset += part.length }, commit: async () => { assertActiveProfile(token); lease?.check() }, abort: async () => { bytes.fill(0) },
    }))
    return bytes
  } catch (error) { bytes.fill(0); throw error }
}
export async function openAccountJson<T>(database: AccountDatabase, token: ProfileToken, ref: CipherRef, schema: z.ZodType<T>, owner?: AccountPreparationOwner): Promise<T> {
  const bytes = await readAccountBytes(database, token, ref, NATIVE_BACKUP_ARCHIVE_LIMITS.maxEntryUncompressedBytes, owner)
  try { return schema.parse(parseBoundedJson(bytes, 'encrypted local record', NATIVE_BACKUP_JSON_LIMITS)) }
  finally { bytes.fill(0) }
}
