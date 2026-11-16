import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { AccountDatabase, activateLocalAccountCommit } from '../persistence/account-database'
import { installProfile, invalidateProfile } from '../account/profile'
import { LAUNCH_DATA_GENERATION } from '../domain/data-generation'
import { accountLocalId } from './account-cache'
import { prepareAccountWorkspace } from './account-graph'
import { createGuestCopyService } from './guest-copy'
import { ownWorkspaceSnapshot } from './snapshot'
import { now, progress } from './signin-merge.test-helpers'

it('keeps review and native conflict preparation inert under exact reserved ownership', async () => {
  const token = installProfile(accountLocalId(), new Uint8Array(32)), database = new AccountDatabase(token.accountId)
  const service = createGuestCopyService(async () => ownWorkspaceSnapshot({ dataGeneration: LAUNCH_DATA_GENERATION, version: 1, snapshotId: 'source', capturedAt: now, revisionVector: {}, state: progress('local', false) }, { async check() {}, async dispose() {} }))
  let stage: Awaited<ReturnType<typeof service.stageReadonlySigninMerge>> | undefined
  try {
    const initial = await prepareAccountWorkspace(database, token, progress('account'))
    await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: initial.head, records: initial.records })
    const before = await Promise.all(database.tables.map(async table => [table.name, await table.toArray()]))
    const preview = await service.previewReadonlySigninMerge(database, token)
    expect(await Promise.all(database.tables.map(async table => [table.name, await table.toArray()]))).toEqual(before)
    const reservation = { operationId: accountLocalId(), check() {} }
    stage = await service.stageReadonlySigninMerge(database, token, preview, reservation)
    expect(stage.journal.version).toBe(1)
    expect(stage.journal.target).toEqual(stage.target)
    expect(await database.encryptedRevisions.toArray()).toEqual(before.find(([name]) => name === 'encryptedRevisions')![1])
    expect(await database.syncState.toArray()).toEqual(before.find(([name]) => name === 'syncState')![1])
    expect(await database.profileMeta.toArray()).toEqual(before.find(([name]) => name === 'profileMeta')![1])
    expect(stage.records.length).toBeGreaterThan(0)
    expect(new Set((await database.preparationPayloads.toArray()).map(row => row.payloadId))).toEqual(new Set(stage.records.map(record => record.payloadId)))
    await stage.check()
  } finally { await stage?.dispose(); await service.dispose(); await database.delete(); invalidateProfile() }
})

it('refuses a missing worker source without creating or upgrading a guest database', async () => {
  const { createSigninMergePreparation } = await import('./signin-merge-preparation')
  const { default: Dexie } = await import('dexie')
  const token = installProfile(accountLocalId(), new Uint8Array(32)), database = new AccountDatabase(token.accountId), name = `missing-merge-${crypto.randomUUID()}`
  const ref = { documentId: accountLocalId(), revisionId: accountLocalId() }
  try {
    await expect(createSigninMergePreparation(database, token, accountLocalId(), { databaseName: name, manifest: { version: 3, id: 'missing', revision: 0, root: ref } }, { selected: { key: 'active', headRevision: 1, head: ref }, projection: { id: 'projection', ref }, epoch: 1, heads: [ref] }, () => {})).rejects.toThrow()
    expect(await Dexie.exists(name)).toBe(false)
  } finally { await database.delete(); invalidateProfile() }
})
