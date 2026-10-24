import 'fake-indexeddb/auto'
import '../workspace/guest-managed-monitor.test-helpers'
import { expect, it, vi } from 'vitest'
import { CryKitDatabase } from './database'
import { AccountDatabase } from './account-database'
import { installProfile, invalidateProfile } from '../account/profile'
import { createGuestRepository, guestRepositoryBindings } from '../workspace/guest-repository'
import { openAccountRepository } from '../workspace/account-repository'
import { createSaveRepository } from '../workspace/save-repository'
import { newOwnedFileCommand, resolveOwnedFileReceipt, verifyOwnedFileReceipt, type OwnedFileOutcome } from '../workspace/owned-file-command'

// Named row and fresh native-reader lifetime checks keep their actual legacy storage subject
vi.mock('../workspace/guest-managed-startup', async importOriginal => {
  const actual = await importOriginal<typeof import('../workspace/guest-managed-startup')>()
  const { openGuestBindings } = await import('../workspace/guest-workspace')
  return { ...actual, prepareGuestStartup: async (original: CryKitDatabase) => original.name.startsWith('native-save-verification-') ? { kind: 'legacy-recovery', binding: await openGuestBindings(original) } : actual.prepareGuestStartup(original) }
})

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
it('guest saved verification rejects a complete result mismatch', async () => {
  const guest = new CryKitDatabase(`native-save-verification-mismatch-${crypto.randomUUID()}`)
  try {
    let outcome: OwnedFileOutcome | undefined
    const row = await createSaveRepository(createGuestRepository(guest), { onOutcome: value => { outcome = value } }).importFile('future.sav', new Uint8Array([11, 29, 37]))
    const binding = await guestRepositoryBindings(createGuestRepository(guest))
    await binding.files.documents.put({ key: JSON.stringify(['saveDocuments', row.id]), value: { ...row, filename: 'altered.sav' } })
    await expect(verifyOwnedFileReceipt(outcome!.receipt!)).rejects.toThrow(/result|match/)
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
it('guest verification rejects a changed profile epoch and closes only fresh readers', async () => {
  const database = new CryKitDatabase(`native-save-verification-epoch-${crypto.randomUUID()}`)
  try {
    let outcome: OwnedFileOutcome | undefined
    await createSaveRepository(createGuestRepository(database), { onOutcome: value => { outcome = value } }).importFile('epoch.sav', new Uint8Array([17, 19]))
    const close = vi.spyOn(CryKitDatabase.prototype, 'close')
    await verifyOwnedFileReceipt(outcome!.receipt!)
    expect(close).toHaveBeenCalled()
    expect(close.mock.contexts.every(reader => reader instanceof CryKitDatabase && reader !== database && !reader.isOpen())).toBe(true)
    expect(database.isOpen()).toBe(true)
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
