import 'fake-indexeddb/auto'
import { expect, it, vi } from 'vitest'
import * as scheduler from '../account/sync/scheduler'
import { writeFileSync } from 'node:fs'
import { AccountDatabase, activateLocalAccountCommit } from '../persistence/account-database'
import { installProfile, invalidateProfile } from '../account/profile'
import { accountLocalId, readAccountBytes } from './account-cache'
import { createAccountLocalStore } from './account-local-store'
import { prepareLocalWorkspace } from './local-root'
import { openAccountManagedRepository, IncrementalWorkspaceIntentSchema } from './account-managed-repository'
import { editorClosureFixture } from './test-helpers'
import { createPersonalDefinition } from '../domain'

it('saves and undoes encrypted planner changes with exact pending roots and restart history', async () => {
  let transactions = 0, writes = 0, recordsRead = 0, bytesRead = 0, recordsWritten = 0, bytesWritten = 0
  const transaction = IDBDatabase.prototype.transaction
  IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) { transactions++; if (args[1] === 'readwrite') writes++; return Reflect.apply(transaction, this, args) }
  const counters = () => ({ transactions, writes, recordsRead, bytesRead, recordsWritten, bytesWritten })
  const difference = (before: ReturnType<typeof counters>) => Object.fromEntries(Object.entries(counters()).map(([key, value]) => [key, value - before[key as keyof typeof before]])) as ReturnType<typeof counters>
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const database = new AccountDatabase(token.accountId), store = createAccountLocalStore(database, token)
  try {
    const fixture = await editorClosureFixture(), operation = accountLocalId()
    const prepared = await prepareLocalWorkspace(store.adapter, operation, fixture.state, store.lifetime)
    await activateLocalAccountCommit(database, token, await store.prepareActivation(operation, prepared, undefined)); store.committed(operation)
    const initialFence = (await database.profileMeta.get('active'))!
    const repository = await openAccountManagedRepository(database, token, initialFence)
    const stale = await openAccountManagedRepository(database, token, initialFence)
    const initial = await repository.load(), proposed = createPersonalDefinition(initial.localData, { name: 'Encrypted planner sentinel', kind: 'item' })
    database.encryptedRevisions.hook('reading', row => { if (row) recordsRead++; return row })
    database.stagedCipherChunks.hook('reading', row => { if (row) bytesRead += row.bytes.byteLength; return row })
    database.encryptedRevisions.hook('creating', (_key, row) => { recordsWritten++; bytesWritten += row.descriptor.chunks.reduce((sum, chunk) => sum + chunk.cipherBytes, 0) })
    const notices: string[] = [], stop = repository.subscribe(event => notices.push(event.reason))
    const saveBefore = counters(), saveStarted = performance.now()
    const saved = await repository.save(proposed, initial.revision)
    const saveWork = { ...difference(saveBefore), elapsedMs: performance.now() - saveStarted }
    expect(saved.localData.personalDefinitions).toEqual(proposed.personalDefinitions)
    const first = await repository.readWorkspace(), savedFence = (await database.profileMeta.get('active'))!
    expect(first.planner.history.at(-1)).toMatchObject({ before: initial.localData, after: saved.localData })
    await expect(repository.save(proposed, initial.revision)).rejects.toThrow(/changed/)
    await expect(stale.save(proposed, initial.revision)).rejects.toThrow(/changed/)
    expect(await database.profileMeta.get('active')).toEqual(savedFence)
    const undoBefore = counters(), undoStarted = performance.now()
    const undone = await repository.undo(saved.localData.revision)
    const undoWork = { ...difference(undoBefore), elapsedMs: performance.now() - undoStarted }
    expect([saveWork, undoWork].map(value => value.writes)).toEqual([1, 1])
    expect([saveWork, undoWork].map(value => value.bytesRead)).toEqual([0, 0])
    if (process.env.R16_RECEIPT_PATH) writeFileSync(process.env.R16_RECEIPT_PATH, JSON.stringify({ runtime: process.version, platform: process.platform, architecture: process.arch, saveWork, undoWork }, null, 2))
    const after = await repository.readWorkspace()
    expect(undone.localData.personalDefinitions).toEqual(initial.localData.personalDefinitions)
    expect(after.planner.history.slice(0, first.planner.history.length)).toEqual(first.planner.history)
    expect(after.planner.history.at(-1)).toMatchObject({ command: `undo:${first.planner.history.at(-1)!.command}`, before: saved.localData, after: undone.localData })
    expect(notices).toEqual(['save', 'undo']); stop()
    const target = (await database.profileMeta.get('active'))!, rows = await database.outbox.toArray()
    expect(rows.map(row => row.status)).toEqual(['unmapped-local', 'unmapped-local'])
    const intents = []
    for (const row of rows) {
      const bytes = await readAccountBytes(database, token, row.ref)
      try { intents.push(IncrementalWorkspaceIntentSchema.parse(JSON.parse(new TextDecoder().decode(bytes)))) }
      finally { bytes.fill(0) }
    }
    intents.sort((a, b) => a.sequence - b.sequence)
    expect(intents.map(value => value.before)).toEqual([initialFence.head, savedFence.head])
    expect(intents.map(value => value.after)).toEqual([savedFence.head, target.head])
    const reopened = await openAccountManagedRepository(database, token, target)
    expect((await reopened.readWorkspace()).planner).toEqual(after.planner)
    for (const chunk of await database.stagedCipherChunks.toArray()) expect(new TextDecoder().decode(chunk.bytes)).not.toContain('Encrypted planner sentinel')
    invalidateProfile()
    await expect(repository.save(undone.localData, undone.localData.revision)).rejects.toMatchObject({ code: 'PROFILE_CHANGED' })
  } finally { IDBDatabase.prototype.transaction = transaction; await store.dispose(); database.close(); invalidateProfile() }
}, 30_000)

it('authenticates remote hints without retargeting an old managed wrapper and requests sync after durable save', async () => {
  const channels: { read?: () => void }[] = []
  class Channel {
    read?: () => void
    constructor() { channels.push(this) }
    addEventListener(_type: string, read: () => void) { this.read = read }
    postMessage() { for (const channel of channels) if (channel !== this) channel.read?.() }
    close() { this.read = undefined }
  }
  vi.stubGlobal('BroadcastChannel', Channel)
  const requested = vi.spyOn(scheduler, 'requestSync')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const database = new AccountDatabase(token.accountId), store = createAccountLocalStore(database, token)
  try {
    const fixture = await editorClosureFixture(), operation = accountLocalId()
    const initial = await prepareLocalWorkspace(store.adapter, operation, fixture.state, store.lifetime)
    const fence = await activateLocalAccountCommit(database, token, await store.prepareActivation(operation, initial, undefined)); store.committed(operation)
    const first = await openAccountManagedRepository(database, token, fence), second = await openAccountManagedRepository(database, token, fence)
    const notices: unknown[] = [], stopFirst = first.subscribe(event => notices.push(event)), stopSecond = second.subscribe(() => {})
    const before = await second.load()
    const saved = await second.save(createPersonalDefinition(before.localData, { kind: 'item', name: 'Other tab content' }), before.revision)
    expect(requested).toHaveBeenCalledWith(token, 'quiet')
    await vi.waitFor(() => expect(notices).toContainEqual({ localDataId: saved.localData.id, revision: saved.localData.revision, reason: 'sync' }))
    await expect(first.load()).rejects.toThrow(/changed/)
    await expect(first.save(before.localData, before.revision)).rejects.toThrow(/changed/)
    expect((await second.load()).localData).toEqual(saved.localData)
    stopFirst(); stopSecond()
    invalidateProfile()
    for (const channel of channels) expect(channel.read).toBeUndefined()
  } finally { await store.dispose(); database.close(); invalidateProfile(); vi.restoreAllMocks(); vi.unstubAllGlobals() }
}, 30_000)
