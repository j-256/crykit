import { accountWorkCheckpoint } from '../account/background-work'
import { encryptRevision, decryptRevision } from '../account/crypto/revisions'
import { assertActiveProfile, profileSignal, withAccountKey, type ProfileToken } from '../account/profile'
import { OpaqueIdSchema, RevisionDescriptorSchema } from '../account/protocol'
import type { AccountDatabase, CipherChunk, CipherRecord, CipherRef } from '../persistence/account-database'
import { accountLocalId, readAccountCipherChunk } from './account-cache'
import type { BlobSource } from './file-types'
import { WorkspaceError } from './repository'
import { beginPreparedRead, resolveAccountRecord, runAccountStage, type AccountPreparationOwner } from './account-prepared-records'

export function stageAccountSource(database: AccountDatabase, token: ProfileToken, source: BlobSource, dependencies: readonly CipherRef[], previous?: CipherRef | readonly CipherRef[], allocatedDocumentId?: string, owner?: AccountPreparationOwner, protection: 'protected' | 'ordinary-autosave-envelope' = 'protected'): Promise<CipherRecord> {
  assertActiveProfile(token)
  const parents: readonly CipherRef[] = previous ? Array.isArray(previous) ? previous : [previous as CipherRef] : []
  const documentId = allocatedDocumentId ?? parents[0]?.documentId ?? accountLocalId()
  // Both conflict parents must belong to this exact allocated document; body refs are not publication authority
  if (parents.length > 2 || new Set(parents.map(ref => ref.revisionId)).size !== parents.length || parents.some(ref => ref.documentId !== documentId)) throw new WorkspaceError('LOCAL_INTEGRITY_FAILED', 'Invalid revision parents')
  const payloadId = accountLocalId()
  return runAccountStage(database, token, payloadId, owner, async lease => {
    async function* captured() {
      lease.check()
      const iterator = source.open()[Symbol.asyncIterator]()
      lease.setSource(iterator)
      let complete = false
      try {
        while (true) {
          lease.check()
          await accountWorkCheckpoint(token)
          const next = await iterator.next()
          lease.check()
          if (next.done) { complete = true; break }
          yield next.value
        }
      } finally {
        lease.setSource(undefined)
        if (!complete) await iterator.return?.()
      }
    }
    const result = await withAccountKey(token, key => encryptRevision(key, { format: 1, accountId: token.accountId, documentId, revisionId: accountLocalId(), parents: parents.map(ref => ref.revisionId), dependencies, protected: protection === 'protected', plainBytes: source.byteLength }, accountLocalId(), captured(), {
      id: payloadId,
      write: async (index, bytes) => { await accountWorkCheckpoint(token); return lease.write(index, bytes) },
    }))
    lease.check()
    return { revisionId: result.descriptor.revisionId, payloadId, descriptor: result.descriptor }
  })
}

export async function openAccountSource(database: AccountDatabase, token: ProfileToken, ref: CipherRef, owner?: AccountPreparationOwner, expectedRecord?: CipherRecord, observe?: (record: CipherRecord, chunks: readonly CipherChunk[]) => void): Promise<BlobSource> {
  // A captured record constrains normal resolution without granting authority to its payload
  // Copy before awaiting so callers cannot retarget the identity while resolution is pending
  const expected = expectedRecord && { revisionId: OpaqueIdSchema.parse(expectedRecord.revisionId), payloadId: OpaqueIdSchema.parse(expectedRecord.payloadId), descriptor: RevisionDescriptorSchema.parse(expectedRecord.descriptor) }
  assertActiveProfile(token)
  const record = await resolveAccountRecord(database, token, ref, owner)
  assertActiveProfile(token)
  if (expected && JSON.stringify(expected) !== JSON.stringify(record)) throw new WorkspaceError('LOCAL_INTEGRITY_FAILED', 'Account source descriptor changed')
  return accountCipherSource(token, record, index => readAccountCipherChunk(database, token, record.payloadId, index), owner, observe)
}

// Private preparation can read its own ciphertext before activation; this grants no durable authority
// The stream retains the same profile, authentication, cancellation and plaintext cleanup checks
export function openPreparedAccountSource(token: ProfileToken, record: CipherRecord, chunks: readonly CipherChunk[], owner: AccountPreparationOwner): BlobSource {
  assertActiveProfile(token)
  const captured = { ...record, descriptor: RevisionDescriptorSchema.parse(record.descriptor) }
  if (captured.descriptor.accountId !== token.accountId || captured.revisionId !== captured.descriptor.revisionId) throw new WorkspaceError('LOCAL_INTEGRITY_FAILED', 'Wrong prepared source identity')
  return accountCipherSource(token, captured, async index => chunks[index], owner)
}

function accountCipherSource(token: ProfileToken, record: CipherRecord, readChunk: (index: number) => Promise<CipherChunk | undefined>, owner?: AccountPreparationOwner, observe?: (record: CipherRecord, chunks: readonly CipherChunk[]) => void): BlobSource {
  const descriptor = RevisionDescriptorSchema.parse(record.descriptor)
  return {
    byteLength: descriptor.plainBytes,
    open() {
      const signal = profileSignal(token)
      const lease = beginPreparedRead(owner)
      const outstanding = new Set<Uint8Array>()
      let cancelTransport: () => Promise<void> = async () => {}
      let onAbort: () => void = () => {}
      const iterator = (async function* () {
        try {
          assertActiveProfile(token)
          const stream = new TransformStream<Uint8Array, Uint8Array>()
          const writer = stream.writable.getWriter(), reader = stream.readable.getReader()
          cancelTransport = async () => {
            for (const bytes of outstanding) bytes.fill(0)
            await Promise.allSettled([reader.cancel(), writer.abort(new WorkspaceError('LOCAL_INTEGRITY_FAILED', 'Prepared source read was released.'))])
          }
          const observed: CipherChunk[] = []
          async function* chunks() {
            for (const chunk of descriptor.chunks) {
              assertActiveProfile(token)
              lease?.check()
              await accountWorkCheckpoint(token)
              const stored = await readChunk(chunk.index)
              assertActiveProfile(token)
              lease?.check()
              if (!stored || stored.payloadId !== record.payloadId || stored.index !== chunk.index) throw new WorkspaceError('LOCAL_INTEGRITY_FAILED', 'Encrypted source chunks are missing.')
              if (observe) observed.push(stored)
              yield stored.bytes
            }
          }
          // Backpressure bounds copied plaintext to the delivered and pending chunks; cancellation unblocks decryption
          const job = withAccountKey(token, key => decryptRevision(key, descriptor, chunks(), {
            write: async bytes => { assertActiveProfile(token); lease?.check(); const copy = bytes.slice(); outstanding.add(copy); try { await writer.write(copy) } catch (error) { copy.fill(0); outstanding.delete(copy); throw error } },
            commit: async () => { assertActiveProfile(token); lease?.check(); await writer.close() },
            abort: async () => { for (const bytes of outstanding) bytes.fill(0); await writer.abort(new WorkspaceError('LOCAL_INTEGRITY_FAILED', 'Encrypted source read failed.')) },
          }))
          const settled = job.then(() => undefined, error => error as unknown)
          let current: Uint8Array | undefined
          try {
            while (true) {
              assertActiveProfile(token)
              lease?.check()
              const next = await reader.read()
              current = next.done ? undefined : next.value
              assertActiveProfile(token)
              lease?.check()
              if (next.done) break
              yield current!
              current!.fill(0); outstanding.delete(current!); current = undefined
            }
            const error = await settled
            if (error) throw error
            // Only fully authenticated reads contribute observations to a later atomic commit
            observe?.(record, observed)
          } finally {
            current?.fill(0)
            for (const bytes of outstanding) bytes.fill(0)
            await reader.cancel().catch(() => {})
            await settled
            reader.releaseLock(); writer.releaseLock()
          }
        } finally { signal.removeEventListener('abort', onAbort); lease?.finish() }
      })()
      let cancellation: Promise<void> | undefined
      const cancel = () => {
        // A generator paused at yield cannot clear its own delivered buffer until it is resumed
        for (const bytes of outstanding) bytes.fill(0)
        return cancellation ??= (async () => {
          try { await cancelTransport(); await iterator.return?.() }
          finally { signal.removeEventListener('abort', onAbort); lease?.finish() }
        })()
      }
      onAbort = () => { void cancel().catch(() => {}) }
      signal.addEventListener('abort', onAbort, { once: true })
      lease?.setCancel(cancel)
      return iterator
    },
  }
}
