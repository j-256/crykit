import { z } from 'zod'
import { assertActiveProfile, type ProfileToken } from '../account/profile'
import { localProjectCapacityBytes } from '../account/protocol'
import type { AccountDatabase, CipherRecord, CipherRef, EncryptedSyncState } from '../persistence/account-database'
import { WORKSPACE_BACKUP_LIMITS } from '../interchange/workspace-backup-schema'
import { NATIVE_BACKUP_JSON_LIMITS, parseBoundedJson } from '../interchange/json'
import { resolveAccountRecord, type AccountPreparationOwner } from './account-prepared-records'
import { openAccountSource } from './account-streams'
import { INDEX_PAGE_BYTES } from './directory'
import { blobIdentity, readBlob } from './blobs'
import type { BlobSource } from './documents'

export interface AccountWorkspaceReadLimits { readonly records: number; readonly depth: number; readonly declaredBytes: number; readonly readBytes: number }
const defaultLimits: AccountWorkspaceReadLimits = { records: WORKSPACE_BACKUP_LIMITS.frames, depth: WORKSPACE_BACKUP_LIMITS.depth, declaredBytes: localProjectCapacityBytes, readBytes: localProjectCapacityBytes }
function checked(current: number, increment: number, limit: number): number {
  if (!Number.isSafeInteger(current) || current < 0 || !Number.isSafeInteger(increment) || increment < 0 || increment > limit - current) throw new Error('Workspace subtree resource limit')
  return current + increment
}

// This reader authenticates only workspace ciphertext, never C evidence or selected authority
export class AccountWorkspaceGraphReader {
  private readonly records = new Map<string, CipherRecord>()
  private readonly rows = new Map<string, EncryptedSyncState | undefined>()
  private readonly wrappers = new Set<string>()
  private closed = false
  private ready = false
  private readonly reserved = new Set<string>()
  private declaredBytes = 0
  private readBytes = 0
  private readonly limits: AccountWorkspaceReadLimits
  private readonly iterators = new Set<AsyncIterator<Uint8Array>>()
  constructor(readonly database: AccountDatabase, readonly token: ProfileToken, readonly owner?: AccountPreparationOwner, readonly strict = false, readonly signal?: AbortSignal, limits: Partial<AccountWorkspaceReadLimits> = {}) {
    this.limits = { ...defaultLimits, ...limits }
    for (const key of Object.keys(defaultLimits) as (keyof AccountWorkspaceReadLimits)[]) {
      if (!Number.isSafeInteger(this.limits[key]) || this.limits[key] < 0 || this.limits[key] > defaultLimits[key]) throw new Error('Invalid workspace subtree limit')
    }
  }

  // Reserve before growing traversal queues; a shared record consumes only one declared visit
  reserve(refs: readonly CipherRef[]): void {
    if (!this.strict) return
    for (const ref of refs) {
      const key = blobIdentity(ref)
      if (this.reserved.has(key)) continue
      checked(this.reserved.size, 1, this.limits.records)
      this.reserved.add(key)
    }
  }
  depth(value: number): void { if (this.strict) checked(0, value, this.limits.depth) }
  private potential(bytes: number): void { if (this.strict) checked(this.readBytes, bytes, this.limits.readBytes) }
  private consume(bytes: number): void { if (this.strict) this.readBytes = checked(this.readBytes, bytes, this.limits.readBytes) }
  seal(): void { this.check(); this.ready = true }
  async beforeRead(): Promise<void> { this.check(); if (this.ready) await this.recheck() }

  check(): void {
    if (this.closed) throw new Error('Workspace subtree reader was released')
    this.signal?.throwIfAborted()
    assertActiveProfile(this.token)
    this.owner?.check()
    if (this.database.accountId !== this.token.accountId) throw new Error('Foreign workspace subtree')
  }

  async record(ref: CipherRef): Promise<CipherRecord> {
    this.check()
    this.reserve([ref])
    const record = await resolveAccountRecord(this.database, this.token, ref, this.owner)
    this.check()
    const key = blobIdentity(ref), previous = this.records.get(key)
    if (previous && JSON.stringify(previous) !== JSON.stringify(record)) throw new Error('Workspace descriptor changed')
    if (this.strict) {
      if (!record.descriptor.protected) throw new Error('Workspace descriptor is not protected')
      if (!previous) this.declaredBytes = checked(this.declaredBytes, record.descriptor.plainBytes, this.limits.declaredBytes)
    }
    this.records.set(key, record)
    return record
  }

  private async *stream(ref: CipherRef, expected: CipherRecord): AsyncGenerator<Uint8Array> {
    this.check()
    this.potential(expected.descriptor.plainBytes)
    const source = await openAccountSource(this.database, this.token, ref, this.owner, expected)
    this.check()
    const iterator = source.open()[Symbol.asyncIterator]()
    this.iterators.add(iterator)
    try {
      while (true) {
        this.check()
        const next = await iterator.next()
        this.check()
        if (next.done) break
        this.consume(next.value.byteLength)
        yield next.value
      }
    } finally { this.iterators.delete(iterator); await iterator.return?.() }
  }

  async source(ref: CipherRef): Promise<BlobSource> {
    const expected = await this.record(ref), reader = this
    this.potential(expected.descriptor.plainBytes)
    return { byteLength: expected.descriptor.plainBytes, async *open() {
      await reader.beforeRead()
      yield* reader.stream(ref, expected)
    } }
  }

  async json<T>(ref: CipherRef, schema: z.ZodType<T>, wrapper = false, maxBytes = INDEX_PAGE_BYTES): Promise<T> {
    const source = await this.source(ref)
    if (source.byteLength > maxBytes) throw new Error('Workspace JSON exceeds format bound')
    const bytes = await readBlob(source, maxBytes)
    try {
      const value = schema.parse(parseBoundedJson(bytes, 'workspace index', NATIVE_BACKUP_JSON_LIMITS))
      if (wrapper) this.wrappers.add(blobIdentity(ref))
      return value
    } finally { bytes.fill(0) }
  }

  async observeRow(id: string): Promise<EncryptedSyncState | undefined> {
    this.check()
    const row = await this.database.syncState.get(id)
    this.check()
    if (this.rows.has(id) && JSON.stringify(this.rows.get(id)) !== JSON.stringify(row)) throw new Error('Workspace source association changed')
    this.rows.set(id, structuredClone(row))
    return row
  }

  // Copies support a consumer's private comparison after owner transfer, never read authority
  recordObservations(): readonly CipherRecord[] { this.check(); return structuredClone([...this.records.values()]) }

  observations(): readonly { readonly id: string; readonly row: EncryptedSyncState | undefined }[] {
    this.check()
    return [...this.rows].map(([id, row]) => ({ id, row: structuredClone(row) }))
  }

  async recheck(): Promise<void> {
    this.check()
    for (const [id, row] of this.rows) if (JSON.stringify(await this.database.syncState.get(id)) !== JSON.stringify(row)) throw new Error('Workspace source association changed')
    for (const record of this.records.values()) await this.record({ documentId: record.descriptor.documentId, revisionId: record.revisionId })
    // Authenticate wrapper bytes again; an unchanged row is not proof of unchanged ciphertext
    for (const key of this.wrappers) {
      const record = this.records.get(key)!
      for await (const _bytes of this.stream({ documentId: record.descriptor.documentId, revisionId: record.revisionId }, record)) { /* Authenticate through finality */ }
    }
    for (const [id, row] of this.rows) if (JSON.stringify(await this.database.syncState.get(id)) !== JSON.stringify(row)) throw new Error('Workspace source association changed')
    this.check()
  }

  async dispose(): Promise<void> {
    this.closed = true
    // Revocation settles only this reader's streams; the shared allocation owner remains usable
    const settled = await Promise.allSettled([...this.iterators].map(async iterator => { await iterator.return?.() }))
    const failures = settled.filter((value): value is PromiseRejectedResult => value.status === 'rejected').map(value => value.reason)
    if (failures.length) throw new AggregateError(failures, 'Workspace subtree reader cleanup failed')
  }
}
