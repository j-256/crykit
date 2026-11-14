import { createAccountPreparationOwner, type AccountPreparationOwner } from '../workspace/account-prepared-records'
import type { AccountDatabase, AccountFence, AccountIntentRecord, CipherRecord, CipherRef, EncryptedSyncState } from './account-database'
import { assertActiveProfile, profileSignal, type ProfileToken } from '../account/profile'
import { SyncError } from '../account/sync/client'
import { cipherRef, stageAccountJson } from '../workspace/account-cache'

export const ACCOUNT_RECEIPT_PREFIX = 'signin-receipt:'

export interface AccountActivationAttachment { readonly kind: 'encrypted-activation-attachment' }
export interface AccountSyncAttachmentValue { readonly id: string; readonly expected: EncryptedSyncState | undefined; readonly value: unknown; readonly dependencies?: readonly CipherRef[] }
export interface AccountBranchRetirement { readonly proof: object; readonly authority: EncryptedSyncState; readonly publication?: EncryptedSyncState; readonly intents: readonly AccountIntentRecord[] }
interface Attachment {
  readonly database: AccountDatabase; readonly token: ProfileToken
  readonly expected: AccountFence | undefined; readonly head: CipherRef
  readonly values: readonly { readonly expected?: EncryptedSyncState; readonly row: EncryptedSyncState; readonly record: CipherRecord }[]
  readonly owners: readonly AccountPreparationOwner[]
  readonly retirement?: AccountBranchRetirement
}
const attachments = new WeakMap<AccountActivationAttachment, Attachment>()
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const conflict = () => new SyncError('LOCAL_REVISION_CONFLICT')

// These encrypted values are prepared before activation; callers cannot inject writes or await network inside IDB
export async function prepareAccountSyncAttachment(database: AccountDatabase, token: ProfileToken, target: { readonly expected: AccountFence | undefined; readonly head: CipherRef }, values: readonly AccountSyncAttachmentValue[], retirement?: AccountBranchRetirement): Promise<AccountActivationAttachment> {
  assertActiveProfile(token)
  if (database.accountId !== token.accountId || new Set(values.map(value => value.id)).size !== values.length
    || values.some(value => !value.id.startsWith(ACCOUNT_RECEIPT_PREFIX) && !value.id.startsWith('reviewed-preparation:') && !['reviewed-replacement', 'remote', 'projection'].includes(value.id))) throw new SyncError('LOCAL_INTEGRITY_FAILED')
  if (retirement) await (await import('../workspace/reviewed-replacement')).assertReviewedBranch(database, token, retirement.proof)
  const captured = structuredClone({ expected: target.expected, head: target.head, values, retirement })
  const prepared = []
  const owner = createAccountPreparationOwner(database, token)
  try {
    for (const value of captured.values) {
      if (value.expected && value.expected.id !== value.id) throw new SyncError('LOCAL_INTEGRITY_FAILED')
      const record = await stageAccountJson(database, token, value.value, [captured.head, ...(value.dependencies ?? [])], undefined, owner)
      prepared.push({ expected: value.expected, row: { id: value.id, ref: cipherRef(record) }, record })
    }
    if (captured.retirement) {
      const old = captured.retirement
      const { stagePublicationPages } = await import('../account/sync/publication')
      const intents = await stagePublicationPages(database, token, 'local-retired-reviewed-intents', old.intents, intent => [intent.ref, ...(intent.publicationBase ? [intent.publicationBase] : [])])
      const id = `retired-reviewed-branch:${old.authority.ref.revisionId}`
      const record = await stageAccountJson(database, token, { version: 1, kind: 'retired-reviewed-branch', fence: captured.expected, authority: old.authority.ref, publication: old.publication?.ref, intents }, [captured.expected!.head, old.authority.ref, intents, ...(old.publication ? [old.publication.ref] : [])], undefined, owner)
      prepared.push({ expected: undefined, row: { id, ref: cipherRef(record) }, record })
    }
    const handle: AccountActivationAttachment = Object.freeze({ kind: 'encrypted-activation-attachment' })
    attachments.set(handle, { database, token, expected: captured.expected, head: captured.head, values: prepared, retirement: captured.retirement, owners: [owner] })
    return handle
  } catch (error) { await owner.abandon(error); throw error }
}

export function prepareAccountReceiptAttachment(database: AccountDatabase, token: ProfileToken, target: { readonly expected: AccountFence | undefined; readonly head: CipherRef }, value: AccountSyncAttachmentValue): Promise<AccountActivationAttachment> {
  if (!value.id.startsWith(ACCOUNT_RECEIPT_PREFIX)) throw new SyncError('LOCAL_INTEGRITY_FAILED')
  return prepareAccountSyncAttachment(database, token, target, [value])
}

export function combineAccountActivationAttachments(...handles: readonly AccountActivationAttachment[]): AccountActivationAttachment {
  const first = attachments.get(handles[0])
  if (!first) throw new SyncError('LOCAL_INTEGRITY_FAILED')
  const owners = new Set<AccountPreparationOwner>()
  const values: Attachment['values'][number][] = []
  let retirement: AccountBranchRetirement | undefined
  for (const handle of handles) {
    const value = attachments.get(handle)
    if (!value || value.database !== first.database || value.token !== first.token || !same(value.expected, first.expected) || !same(value.head, first.head) || retirement && value.retirement) throw new SyncError('LOCAL_INTEGRITY_FAILED')
    for (const owner of value.owners) owners.add(owner)
    values.push(...value.values); retirement ??= value.retirement
  }
  if (new Set(values.map(value => value.row.id)).size !== values.length) throw new SyncError('LOCAL_INTEGRITY_FAILED')
  const handle: AccountActivationAttachment = Object.freeze({ kind: 'encrypted-activation-attachment' })
  attachments.set(handle, { ...first, values, retirement, owners: [...owners] })
  return handle
}

export function accountAttachmentCheck(database: AccountDatabase, token: ProfileToken, target: { readonly expected: AccountFence | undefined; readonly head: CipherRef }, handle?: AccountActivationAttachment) {
  if (!handle) return undefined
  const value = attachments.get(handle)
  if (!value || value.database !== database || value.token !== token || !same(value.expected, target.expected) || !same(value.head, target.head)) throw new SyncError('LOCAL_INTEGRITY_FAILED')
  for (const owner of value.owners) owner.check()
  return {
    async recheckAndRetireInTransaction() {
      assertActiveProfile(token)
      if (!same(await database.profileMeta.get('active'), value.expected)) throw conflict()
      for (const entry of value.values) if (!same(await database.syncState.get(entry.row.id), entry.expected)) throw conflict()
      if (value.retirement) {
        const old = value.retirement
        if (!same(await database.syncState.get('reviewed-replacement'), old.authority)
          || !same(await database.syncState.get('publication'), old.publication)
          || !same(await database.outbox.toArray(), old.intents)) throw conflict()
        // Exact whole-branch comparison includes edits added after rejection; none can silently disappear
        await database.outbox.bulkDelete(old.intents.map(intent => intent.id))
        if (old.publication) {
          await database.syncState.put({ id: `rejected:${old.publication.ref.revisionId}`, ref: old.publication.ref })
          await database.syncState.delete('publication')
        }
      }
    },
    async installInTransaction() {
      for (const entry of value.values) {
        const { record } = entry
        for (const chunk of record.descriptor.chunks) if ((await database.stagedCipherChunks.get([record.payloadId, chunk.index]))?.bytes.length !== chunk.cipherBytes) throw new SyncError('LOCAL_INTEGRITY_FAILED')
        for (const ref of record.descriptor.dependencies) {
          const dependency = await database.encryptedRevisions.get(ref.revisionId)
          if (!dependency || dependency.descriptor.documentId !== ref.documentId || dependency.descriptor.accountId !== token.accountId) throw new SyncError('LOCAL_INTEGRITY_FAILED')
        }
        await database.encryptedRevisions.add(record)
        await database.syncState.put(entry.row)
        if (entry.row.id === 'reviewed-replacement') await database.syncState.delete('scan')
      }
      assertActiveProfile(token)
    },
  }
}

export async function commitAccountReceipt(database: AccountDatabase, token: ProfileToken, handle: AccountActivationAttachment): Promise<void> {
  const value = attachments.get(handle)
  if (!value?.expected || value.retirement || value.values.some(entry => !entry.row.id.startsWith(ACCOUNT_RECEIPT_PREFIX)) || !same(value.head, value.expected.head)) throw new SyncError('LOCAL_INTEGRITY_FAILED')
  const check = accountAttachmentCheck(database, token, value, handle)!
  const signal = profileSignal(token)
  let pending: import('dexie').Transaction | undefined
  const abort = () => pending?.abort()
  signal.addEventListener('abort', abort, { once: true })
  try {
    await database.transaction('rw', database.tables, async transaction => {
      pending = transaction
      await check.recheckAndRetireInTransaction()
      await check.installInTransaction()
    })
  } finally { signal.removeEventListener('abort', abort) }
}

export async function releaseAccountActivationAttachment(handle: AccountActivationAttachment): Promise<void> {
  const value = attachments.get(handle)
  attachments.delete(handle)
  if (value) await Promise.all(value.owners.map(owner => owner.abandon()))
}
