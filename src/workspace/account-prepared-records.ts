import { OpaqueIdSchema, RevisionDescriptorSchema } from '../account/protocol'
import { assertActiveProfile, type ProfileToken } from '../account/profile'
import type { AccountDatabase, CipherRecord, CipherRef } from '../persistence/account-database'
import { WorkspaceError } from './repository'

function integrity(message: string): WorkspaceError { return new WorkspaceError('LOCAL_INTEGRITY_FAILED', message) }
const copyRecord = (record: CipherRecord): CipherRecord => ({ revisionId: record.revisionId, payloadId: record.payloadId, descriptor: RevisionDescriptorSchema.parse(record.descriptor) })
// Parse before comparison so equivalent stored records do not differ merely by object key insertion order
const exactRecord = (left: CipherRecord, right: CipherRecord) => JSON.stringify(copyRecord(left)) === JSON.stringify(copyRecord(right))
const markReserved = Symbol('markReserved')
const registerCompleted = Symbol('registerCompleted')
const trackStage = Symbol('trackStage')

export interface AccountStageLease {
  check(): void
  write(index: number, bytes: Uint8Array): Promise<void>
  setSource(iterator: AsyncIterator<Uint8Array> | undefined): void
}

interface AccountReadLease {
  check(): void
  setCancel(cancel: () => Promise<unknown>): void
  finish(): void
}

class PreparationOwner {
  readonly #records = new Map<string, CipherRecord>()
  readonly #reserved = new Set<string>()
  readonly #stages = new Set<Promise<unknown>>()
  readonly #readers = new Set<AccountReadLease>()
  readonly #readerDone = new Map<AccountReadLease, Promise<void>>()
  readonly #readerResolve = new Map<AccountReadLease, () => void>()
  private closed = false
  private readersClosed = false
  private abandoned = false
  private transferred = false
  private cleanup?: Promise<void>

  constructor(readonly database: AccountDatabase, readonly token: ProfileToken) { this.check() }

  check(): void {
    assertActiveProfile(this.token)
    if (this.database.accountId !== this.token.accountId) throw integrity('Prepared ciphertext belongs to another workspace.')
    if (this.closed || this.transferred) throw integrity('This preparation has closed.')
  }

  beginRead(): AccountReadLease {
    this.check()
    if (this.readersClosed) throw integrity('Prepared readers have been released.')
    let cancelled: (() => Promise<unknown>) | undefined
    const lease: AccountReadLease = {
      check: () => { this.check(); if (this.readersClosed) throw integrity('Prepared readers have been released.') },
      setCancel: cancel => { cancelled = cancel },
      finish: () => { this.#readers.delete(lease); this.#readerResolve.get(lease)?.(); this.#readerResolve.delete(lease); this.#readerDone.delete(lease) },
    }
    // Release waits for the read's finally block, including decryption and plaintext-buffer cleanup
    let resolve!: () => void
    const done = new Promise<void>(next => { resolve = next })
    this.#readers.add(lease); this.#readerDone.set(lease, done); this.#readerResolve.set(lease, resolve)
    readCancels.set(lease, () => cancelled?.() ?? Promise.resolve())
    return lease
  }

  async releaseReaders(): Promise<void> {
    this.readersClosed = true
    const live = [...this.#readers]
    await Promise.all(live.map(async lease => { try { await readCancels.get(lease)?.() } catch { /* The reader's own operation reports its failure */ } }))
    await Promise.all(live.map(lease => this.#readerDone.get(lease)))
  }

  async adopt(child: PreparationOwner): Promise<void> {
    this.check()
    child.check()
    if (child === this || child.database !== this.database || child.token.accountId !== this.token.accountId || child.token.generation !== this.token.generation || child.#stages.size || child.#readers.size || child.cleanup) throw integrity('The child preparation is busy or belongs to another workspace.')
    for (const [id, record] of child.#records) if (this.#records.has(id) || [...this.#records.values()].some(value => value.payloadId === record.payloadId)) throw integrity('Prepared record identity was reused.')
    for (const id of child.#reserved) if (this.#reserved.has(id)) throw integrity('Prepared payload identity was reused.')
    for (const id of child.#reserved) this.#reserved.add(id)
    for (const [id, record] of child.#records) this.#records.set(id, record)
    child.transferred = true; child.closed = true; child.readersClosed = true
    child.#reserved.clear(); child.#records.clear()
  }

  async abandon(primaryError?: unknown): Promise<void> {
    if (this.transferred || this.abandoned) return
    if (this.cleanup) return this.cleanup
    this.closed = true
    this.cleanup = (async () => {
      const stages = [...this.#stages]
      for (const source of stageSources.values()) if (source.owner === this) {
        try { void source.iterator.return?.().catch(() => {}) } catch { /* The stage lease still settles before cleanup */ }
      }
      await Promise.allSettled(stages)
      await this.releaseReaders()
      // Cleanup takes the same two stores as first-write and pull allocation, so an installed exact
      // descriptor cannot be removed while a concurrent activation acquires its reference
      for (const payloadId of this.#reserved) {
        await this.database.transaction('rw', this.database.stagedCipherChunks, this.database.encryptedRevisions, async () => {
          const installed = await this.database.encryptedRevisions.where('payloadId').equals(payloadId).toArray()
          if (installed.length) return
          await this.database.stagedCipherChunks.where('payloadId').equals(payloadId).delete()
        })
        this.#reserved.delete(payloadId)
      }
      this.abandoned = true
      this.#records.clear()
    })()
    try { await this.cleanup } catch (cleanupError) {
      this.cleanup = undefined
      if (primaryError !== undefined) throw new AggregateError([primaryError, cleanupError], 'Staging and cleanup failed', { cause: primaryError })
      throw cleanupError
    }
  }

  prepared(ref: CipherRef): CipherRecord | undefined {
    this.check()
    if (this.readersClosed) throw integrity('Prepared readers have been released.')
    const record = this.#records.get(ref.revisionId)
    if (record && record.descriptor.documentId !== ref.documentId) throw integrity('Prepared revision identity is ambiguous.')
    // Adoption and installed equality depend on the completed registry's original descriptor graph
    return record && copyRecord(record)
  }

  [markReserved](payloadId: string): void { this.#reserved.add(payloadId) }
  [registerCompleted](lease: StageLease, record: CipherRecord): void {
    this.check()
    if (!lease.reserved || lease.payloadId !== record.payloadId || this.#records.has(record.revisionId) || [...this.#records.values()].some(value => value.payloadId === record.payloadId)) throw integrity('Prepared record identity was reused.')
    const descriptor = RevisionDescriptorSchema.parse(record.descriptor)
    if (descriptor.accountId !== this.token.accountId || descriptor.revisionId !== record.revisionId) throw integrity('Prepared descriptor identity is invalid.')
    this.#records.set(record.revisionId, { revisionId: record.revisionId, payloadId: record.payloadId, descriptor })
  }
  [trackStage](job: Promise<unknown>): void { this.#stages.add(job); void job.finally(() => this.#stages.delete(job)).catch(() => {}) }
}

const readCancels = new WeakMap<AccountReadLease, () => Promise<unknown>>()
const stageSources = new Map<StageLease, { owner: PreparationOwner; iterator: AsyncIterator<Uint8Array> }>()

class StageLease implements AccountStageLease {
  reserved = false
  nextIndex = 0
  constructor(readonly database: AccountDatabase, readonly token: ProfileToken, readonly payloadId: string, readonly owner?: PreparationOwner) { OpaqueIdSchema.parse(payloadId); this.check() }
  check(): void { assertActiveProfile(this.token); this.owner?.check() }
  setSource(iterator: AsyncIterator<Uint8Array> | undefined): void {
    if (iterator && this.owner) stageSources.set(this, { owner: this.owner, iterator })
    else stageSources.delete(this)
  }
  async write(index: number, bytes: Uint8Array): Promise<void> {
    this.check()
    if (index !== this.nextIndex) throw integrity('Encrypted chunk order is invalid.')
    if (!this.reserved) {
      // A generated ID is only a candidate until this transaction atomically excludes all orphan
      // chunks and installed descriptors, then adds chunk zero; losers never own cleanup rights
      await this.database.transaction('rw', this.database.stagedCipherChunks, this.database.encryptedRevisions, async () => {
        this.check()
        if (await this.database.stagedCipherChunks.where('payloadId').equals(this.payloadId).count()
          || await this.database.encryptedRevisions.where('payloadId').equals(this.payloadId).count()) throw integrity('Encrypted payload identity was reused.')
        await this.database.stagedCipherChunks.add({ payloadId: this.payloadId, index, bytes })
        this.check()
      })
      this.reserved = true
      this.owner?.[markReserved](this.payloadId)
    } else {
      await this.database.stagedCipherChunks.add({ payloadId: this.payloadId, index, bytes })
    }
    this.nextIndex++
    this.check()
  }
}

export type AccountPreparationOwner = PreparationOwner
export function createAccountPreparationOwner(database: AccountDatabase, token: ProfileToken): AccountPreparationOwner { return new PreparationOwner(database, token) }

export function runAccountStage(database: AccountDatabase, token: ProfileToken, payloadId: string, owner: AccountPreparationOwner | undefined, produce: (lease: AccountStageLease) => Promise<CipherRecord>): Promise<CipherRecord> {
  if (owner && (owner.database !== database || owner.token.accountId !== token.accountId || owner.token.generation !== token.generation)) throw integrity('Prepared ciphertext belongs to another workspace.')
  const lease = new StageLease(database, token, payloadId, owner)
  const job = (async () => {
    try {
      const record = await produce(lease)
      owner?.[registerCompleted](lease, record)
      return record
    } finally { lease.setSource(undefined) }
  })()
  owner?.[trackStage](job)
  return job
}

export async function resolveAccountRecord(database: AccountDatabase, token: ProfileToken, ref: CipherRef, owner?: AccountPreparationOwner): Promise<CipherRecord> {
  if (owner && (owner.database !== database || owner.token.accountId !== token.accountId || owner.token.generation !== token.generation)) throw integrity('Prepared ciphertext belongs to another workspace.')
  const prepared = owner?.prepared(ref)
  const installed = await database.encryptedRevisions.get(ref.revisionId)
  owner?.check()
  const record = installed ?? prepared
  if (installed && prepared && !exactRecord(installed, prepared)) throw integrity('Installed revision conflicts with prepared ciphertext.')
  if (!record || record.revisionId !== ref.revisionId || record.descriptor.revisionId !== ref.revisionId || record.descriptor.documentId !== ref.documentId || record.descriptor.accountId !== token.accountId) throw integrity('The encrypted revision is missing or belongs to another workspace.')
  OpaqueIdSchema.parse(record.payloadId)
  return copyRecord(record)
}

export function beginPreparedRead(owner?: AccountPreparationOwner): AccountReadLease | undefined { return owner?.beginRead() }
