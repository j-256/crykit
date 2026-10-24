import 'fake-indexeddb/auto'
import { afterEach, expect, it } from 'vitest'
import { installProfile, invalidateProfile } from '../account/profile'
import { AccountDatabase } from './account-database'
import { accountLocalId } from '../workspace/account-cache'
import { openAccountRepository } from '../workspace/account-repository'
import { confirmModFolder, previewModFolder } from '../workspace/folder-import'

let database: AccountDatabase | undefined
afterEach(async () => { invalidateProfile(); await database?.delete(); database = undefined })

it('cancelledOrFailedFolderDoesNotBecomeUsable', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const repository = await openAccountRepository(token)
  const before = await repository.readWorkspace()
  const file = new File([JSON.stringify({ ID: 'cancelled', Title: 'Cancelled mod', EditorVersion: 34, Items: [{ ID: 1, Name: 'Synthetic item' }] })], 'mod.json', { type: 'application/json' })
  const preview = await previewModFolder([{ relativePath: 'mods\\mod.json', file }])
  expect((await repository.readWorkspace()).planner.sources).toEqual(before.planner.sources)
  await expect(confirmModFolder(repository, preview, { projects: [{ projectId: 'wrong', sourceId: preview.projects[0]!.sourceId, relativePath: preview.projects[0]!.relativePath, choices: { inReference: false, futureDefault: false } }], assets: [] })).rejects.toThrow()
  await expect(confirmModFolder(repository, preview, { projects: [{ projectId: 'cancelled', sourceId: preview.projects[0]!.sourceId, relativePath: preview.projects[0]!.relativePath, choices: { inReference: false, futureDefault: false } }], assets: [{ relativePath: 'art.png', projectId: 'cancelled', sourceId: preview.projects[0]!.sourceId }] })).rejects.toThrow('associated')
  expect((await repository.readWorkspace()).planner.sources).toEqual(before.planner.sources)
  const receipts = await confirmModFolder(repository, preview, { projects: [{ projectId: 'cancelled', sourceId: preview.projects[0]!.sourceId, relativePath: preview.projects[0]!.relativePath, choices: { inReference: false, futureDefault: false } }], assets: [] })
  expect(receipts).toHaveLength(1)
  expect(receipts[0]?.filename).toBe('mods\\mod.json')
  expect((await repository.readWorkspace()).planner.sources).toHaveLength(1)
})
