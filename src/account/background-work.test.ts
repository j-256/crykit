import 'fake-indexeddb/auto'
import { AccountDatabase } from '../persistence/account-database'
import { stageAccountJson, cipherRef, readAccountRecordBytes } from '../workspace/account-cache'
import { afterEach, expect, it } from 'vitest'
import { installProfile, invalidateProfile } from './profile'
import { accountLocalId } from '../workspace/account-cache'
import { acquireAccountForeground, accountWorkCheckpoint, installAccountWorkCheckpoint, observeAccountForeground, withAccountForeground, waitForAccountForeground } from './background-work'

afterEach(() => invalidateProfile())
it('keeps nested foreground work pending through completion and clears its captured profile on failure', async () => {
  const token = installProfile(accountLocalId(), new Uint8Array(32)), states: boolean[] = []
  const stop = observeAccountForeground(token, value => states.push(value))
  await expect(withAccountForeground(token, async () => {
    await withAccountForeground({ ...token }, async () => {})
    throw new Error('failed command')
  })).rejects.toThrow('failed command')
  expect(states).toEqual([false, true, false])
  stop()
  invalidateProfile()
  await expect(withAccountForeground(token, async () => {})).rejects.toMatchObject({ code: 'PROFILE_CHANGED' })
})
it('checks the captured profile again after a suspended background work unit', async () => {
  const token = installProfile(accountLocalId(), new Uint8Array(32))
  let resume!: () => void
  installAccountWorkCheckpoint(token, () => new Promise<void>(resolve => { resume = resolve }))
  const pending = accountWorkCheckpoint(token)
  invalidateProfile(); resume()
  await expect(pending).rejects.toMatchObject({ code: 'PROFILE_CHANGED' })
})

it('captures JSON and dependency refs before yielding a background crypto unit', async () => {
  const token = installProfile(accountLocalId(), new Uint8Array(32)), database = new AccountDatabase(token.accountId)
  let resume!: () => void
  const gate = new Promise<void>(resolve => { resume = resolve })
  installAccountWorkCheckpoint(token, () => gate)
  const value = { secret: 'original private input' }, dependency = { documentId: accountLocalId(), revisionId: accountLocalId() }, expected = { ...dependency }
  try {
    const pending = stageAccountJson(database, token, value, [dependency])
    value.secret = 'late mutation'; dependency.revisionId = accountLocalId(); resume()
    const record = await pending
    const bytes = await readAccountRecordBytes(database, token, cipherRef(record), record)
    try { expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({ secret: 'original private input' }) } finally { bytes.fill(0) }
    expect(record.descriptor.dependencies).toEqual([expected])
  } finally { database.close() }
})

it('holds main-thread publication behind foreground completion and rejects a cancelled wait', async () => {
  const token = installProfile(accountLocalId(), new Uint8Array(32))
  let release!: () => void, settled = false
  const foreground = withAccountForeground(token, () => new Promise<void>(resolve => { release = resolve }))
  const waiting = waitForAccountForeground(token).then(() => { settled = true })
  await Promise.resolve(); expect(settled).toBe(false)
  const controller = new AbortController(), cancelled = waitForAccountForeground(token, controller.signal)
  controller.abort(); await expect(cancelled).rejects.toThrow(/cancelled/)
  release(); await foreground; await waiting; expect(settled).toBe(true)
})

it('holds an explicit foreground lease across nested commands and releases it only once', async () => {
  const token = installProfile(accountLocalId(), new Uint8Array(32)), states: boolean[] = []
  observeAccountForeground({ ...token }, pending => states.push(pending))
  const release = acquireAccountForeground(token)
  expect(states).toEqual([false, true])
  let resumed = false
  const waiting = waitForAccountForeground({ ...token }).then(() => { resumed = true })
  await expect(withAccountForeground({ ...token }, async () => 'saved')).resolves.toBe('saved')
  await expect(withAccountForeground(token, async () => { throw new Error('save failed') })).rejects.toThrow('save failed')
  expect(resumed).toBe(false)
  expect(states).toEqual([false, true])
  release()
  release()
  await waiting
  expect(states).toEqual([false, true, false])
  const releaseNext = acquireAccountForeground(token)
  expect(states).toEqual([false, true, false, true])
  releaseNext()
  expect(states).toEqual([false, true, false, true, false])
})

it('cancels a retired profile waiter without affecting the successor foreground count', async () => {
  const accountId = accountLocalId(), initial = installProfile(accountId, new Uint8Array(32)), initialStates: boolean[] = []
  observeAccountForeground(initial, pending => initialStates.push(pending))
  const releaseInitial = acquireAccountForeground(initial)
  const retired = expect(waitForAccountForeground(initial)).rejects.toThrow('Captured account preparation was cancelled')
  invalidateProfile()
  await retired

  const successor = installProfile(accountId, new Uint8Array(32)), successorStates: boolean[] = []
  observeAccountForeground(successor, pending => successorStates.push(pending))
  const releaseSuccessor = acquireAccountForeground({ ...successor })
  let resumed = false
  const waiting = waitForAccountForeground(successor).then(() => { resumed = true })
  releaseInitial()
  await Promise.resolve()
  expect(resumed).toBe(false)
  expect(initialStates).toEqual([false, true])
  expect(successorStates).toEqual([false, true])
  releaseSuccessor()
  await waiting
  expect(successorStates).toEqual([false, true, false])
})
