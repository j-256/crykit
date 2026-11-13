import 'fake-indexeddb/auto'
import '../workspace/guest-managed-monitor.test-helpers'
import { expect, it, vi } from 'vitest'
import { CryKitDatabase } from './database'
import { seedBlankManagedGuest, managedGuestBinding, corruptManagedRecord } from '../workspace/managed-guest.test-helpers'
import { privateRecordKey } from '../workspace/documents'
import { AccountDatabase } from './account-database'
import { installProfile, invalidateProfile } from '../account/profile'
import { createGuestRepository } from '../workspace/guest-repository'
import { openAccountRepository } from '../workspace/account-repository'
import { createSaveRepository } from '../workspace/save-repository'
import { newOwnedFileCommand, resolveOwnedFileReceipt, verifyOwnedFileReceipt, type OwnedFileOutcome } from '../workspace/owned-file-command'

it.each(['guest', 'account'] as const)('verifies a real saved %s result after strict input changes without granting continuation', async kind => {
  const guest = new CryKitDatabase(`save-verification-${crypto.randomUUID()}`)
  const token = kind === 'account' ? installProfile(btoa(crypto.randomUUID().slice(0, 16)).replace(/=/g, ''), crypto.getRandomValues(new Uint8Array(32))) : undefined
  const account = token ? new AccountDatabase(token.accountId) : undefined
  try {
    const repository = token ? await openAccountRepository(token) : createGuestRepository(guest)
    let current = true, outcome: OwnedFileOutcome | undefined
    const command = newOwnedFileCommand('saveImport', () => { if (!current) throw new Error('Strict input changed') })
    await createSaveRepository(repository, { begin: () => command, onOutcome: value => { outcome = value } }).importFile('future.sav', new Uint8Array([11, 29, 37]))
    expect(outcome!.status).toBe('saved'); current = false
    await expect(resolveOwnedFileReceipt(outcome!.receipt!)).rejects.toThrow('Strict input changed')
    expect(await verifyOwnedFileReceipt(outcome!.receipt!)).toBeUndefined()
    await expect(verifyOwnedFileReceipt({ ...outcome!.receipt! })).rejects.toThrow('Unknown')
    // Verification cannot make the rejected strict input eligible for ordinary continuation
    await expect(resolveOwnedFileReceipt(outcome!.receipt!)).rejects.toThrow('Strict input changed')
    const next = token ? await openAccountRepository(token) : createGuestRepository(guest)
    await createSaveRepository(next).importFile('second.sav', new Uint8Array([41, 43]))
    await expect(verifyOwnedFileReceipt(outcome!.receipt!)).rejects.toThrow(/selected|changed/)
    if (token) { invalidateProfile(); await expect(verifyOwnedFileReceipt(outcome!.receipt!)).rejects.toThrow('PROFILE_CHANGED') }
  } finally { if (token) invalidateProfile(); await account?.delete(); await guest.delete() }
})
it('guest saved verification rejects altered durable result bytes', async () => {
  const guest = new CryKitDatabase(`native-save-verification-mismatch-${crypto.randomUUID()}`)
  try {
    await seedBlankManagedGuest(guest)
    let outcome: OwnedFileOutcome | undefined
    const row = await createSaveRepository(createGuestRepository(guest), { onOutcome: value => { outcome = value } }).importFile('future.sav', new Uint8Array([11, 29, 37]))
    const restore = await corruptManagedRecord(createGuestRepository(guest), privateRecordKey('save', row.id))
    try { await expect(verifyOwnedFileReceipt(outcome!.receipt!)).rejects.toThrow() } finally { await restore() }
    await expect(verifyOwnedFileReceipt(outcome!.receipt!)).resolves.toBeUndefined()
  } finally { await guest.delete() }
})
it('saved account verification rejects corrupted ciphertext and releases its native readers', async () => {
  const token = installProfile(btoa(crypto.randomUUID().slice(0, 16)).replace(/=/g, ''), crypto.getRandomValues(new Uint8Array(32)))
  const database = new AccountDatabase(token.accountId)
  try {
    let outcome: OwnedFileOutcome | undefined
    const readers = new Set<IDBTransaction>()
    let verificationReads = 0, observing = false
    const transaction = IDBDatabase.prototype.transaction
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...args: Parameters<typeof transaction>) {
      const result = transaction.apply(this, args)
      if (observing && this.name === database.name && result.mode === 'readonly') {
        verificationReads++
        readers.add(result)
        result.addEventListener('complete', () => readers.delete(result))
        result.addEventListener('abort', () => readers.delete(result))
      }
      return result
    })
    await createSaveRepository(await openAccountRepository(token), { onOutcome: value => { outcome = value } }).importFile('future.sav', new Uint8Array([11, 29]))
    const active = (await database.profileMeta.get('active'))!, record = (await database.encryptedRevisions.get(active.head.revisionId))!
    const chunk = (await database.stagedCipherChunks.get([record.payloadId, 0]))!
    observing = true
    const corrupted = chunk.bytes.slice(); corrupted[0] ^= 1
    await database.stagedCipherChunks.put({ ...chunk, bytes: corrupted })
    await expect(verifyOwnedFileReceipt(outcome!.receipt!)).rejects.toThrow()
    expect(verificationReads).toBeGreaterThan(0)
    await vi.waitFor(() => expect(readers.size).toBe(0))
    expect(database.isOpen()).toBe(true)
    await database.stagedCipherChunks.put(chunk)
    await expect(verifyOwnedFileReceipt(outcome!.receipt!)).resolves.toBeUndefined()
  } finally { vi.restoreAllMocks(); invalidateProfile(); await database.delete() }
})
it('guest verification rejects a changed profile epoch without opening native planner storage', async () => {
  const database = new CryKitDatabase(`save-verification-epoch-${crypto.randomUUID()}`)
  try {
    await seedBlankManagedGuest(database)
    const repository = createGuestRepository(database)
    let outcome: OwnedFileOutcome | undefined
    await createSaveRepository(repository, { onOutcome: value => { outcome = value } }).importFile('epoch.sav', new Uint8Array([17, 19]))
    const binding = await managedGuestBinding(repository)
    const open = vi.spyOn(CryKitDatabase.prototype, 'open')
    await verifyOwnedFileReceipt(outcome!.receipt!)
    expect(open).not.toHaveBeenCalled()
    expect(binding.coordinator.isOpen()).toBe(true)
    invalidateProfile()
    await expect(verifyOwnedFileReceipt(outcome!.receipt!)).rejects.toThrow('PROFILE_CHANGED')
  } finally { vi.restoreAllMocks(); await database.delete() }
})
it('fresh account recovery reads never initialize an absent selected head', async () => {
  const { readAccountSaveRecovery } = await import('../workspace/account-repository')
  const token = installProfile(btoa(crypto.randomUUID().slice(0, 16)).replace(/=/g, ''), crypto.getRandomValues(new Uint8Array(32)))
  const database = new AccountDatabase(token.accountId)
  try {
    const file = await createSaveRepository(await openAccountRepository(token)).importFile('missing-head.sav', new Uint8Array([3, 5]))
    await database.profileMeta.delete('active')
    const records = await database.encryptedRevisions.count(), chunks = await database.stagedCipherChunks.count()
    await expect(readAccountSaveRecovery(token, file)).rejects.toThrow()
    expect(await database.profileMeta.get('active')).toBeUndefined()
    expect(await database.encryptedRevisions.count()).toBe(records)
    expect(await database.stagedCipherChunks.count()).toBe(chunks)
  } finally { vi.restoreAllMocks(); invalidateProfile(); await database.delete() }
})
