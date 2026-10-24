import 'fake-indexeddb/auto'
import { buildBehavior, saveBuildBehavior } from '../domain/build-behavior'
import { selectBuildModRevision } from '../domain/build-mods'
import { createBuild, saveBuildRevision } from '../domain/builds'
import { addGameSetupRevision } from '../domain/local-data'
import type { BuildId } from '../domain/types'
import { GuestCoordinatorDatabase } from '../workspace/guest-coordinator'
import '../workspace/guest-managed-monitor.test-helpers'
import { afterEach, expect, it, vi } from 'vitest'
import { installProfile, invalidateProfile } from '../account/profile'
import { previewCrystalEdit } from '../interchange/crystal-edit'
import { AccountDatabase } from './account-database'
import { CryKitDatabase } from './database'
import { openAccountRepository } from '../workspace/account-repository'
import { createGuestRepository, guestRepositorySelection } from '../workspace/guest-repository'
import { importOwnedLibrarySource, readLibrarySource } from '../workspace/mod-repository'
import { accountLocalId } from '../workspace/account-cache'
import { BuildInputController } from '../workspace/build-input-controller'
import { resolveOwnedFileReceipt } from '../workspace/owned-file-command'

const databases: (AccountDatabase | CryKitDatabase)[] = []
afterEach(async () => { invalidateProfile(); vi.restoreAllMocks(); for (const db of databases.splice(0)) await db.delete() })
const bytes = new TextEncoder().encode('{"ID":"owned-picker","Title":"Picker source","Version":"1","EditorVersion":34,"Items":[{"ID":9,"Name":"Picker item"}]}\r\n')
async function setup(kind: 'guest' | 'account') {
  const controller = new BuildInputController(), view = controller.attach()
  controller.edit(view, 'title', 'Unsaved title'); controller.dirty(view, true)
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const db = kind === 'guest' ? new CryKitDatabase(`picker-${crypto.randomUUID()}`) : new AccountDatabase(token.accountId)
  databases.push(db)
  const repository = kind === 'guest' ? createGuestRepository(db as CryKitDatabase) : await openAccountRepository(token)
  if (kind === 'account') {
    const loaded = await repository.load()
    let data = addGameSetupRevision(loaded.localData, { label: 'Saved base setup' })
    const setup = Object.values(data.gameSetups)[0]!, buildId = 'owned-base-build' as BuildId
    data = createBuild(data, { id: buildId, gameSetupId: setup.gameSetupId, title: 'Saved base Build' })
    data = saveBuildRevision(data, { buildId, gameSetupRevisionId: setup.id, content: { primaryClass: null, secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [] } })
    await repository.save(data, loaded.revision)
  }
  const before = await repository.readWorkspace()
  const preview = await previewCrystalEdit(bytes, 'picker.json')
  return { db, token, controller, view, repository, before, preview, expected: { id: before.planner.localData.id, revision: before.planner.localData.revision } }
}
it.each(['guest', 'account'] as const)('%s owned import preserves saved checkpoints, defaults and Reference until explicit Save', async kind => {
  const { controller, view, repository, before, preview, expected } = await setup(kind)
  const command = controller.capture(view, () => {})
  const outcome = await importOwnedLibrarySource(repository, preview, command, expected)
  expect(outcome.status).toBe('saved')
  const completion = await resolveOwnedFileReceipt(outcome.receipt!)
  const after = completion.state
  expect(after.planner.localData.builds).toEqual(before.planner.localData.builds)
  expect(after.planner.localData.buildRevisions).toEqual(before.planner.localData.buildRevisions)
  expect(after.planner.localData.gameSetups).toEqual(before.planner.localData.gameSetups)
  expect(after.planner.localData.referenceLibrary?.excludedMods).toEqual([...(before.planner.localData.referenceLibrary?.excludedMods ?? []), preview.proposed.catalogs[0]!.id])
  expect(after.libraryDefaults).toEqual(before.libraryDefaults)
  for (const row of before.planner.history) expect(after.planner.history.find(saved => saved.id === row.id)).toEqual(row)
  const imported = after.planner.history.filter(row => !before.planner.history.some(old => old.id === row.id))
  expect(imported).toHaveLength(1)
  expect(imported[0]!.before.buildRevisions).toEqual(before.planner.localData.buildRevisions)
  expect(imported[0]!.after.buildRevisions).toEqual(before.planner.localData.buildRevisions)
  await expect(repository.load()).rejects.toThrow(/retired|closed/i)
  const catalog = preview.proposed.catalogs[0]!
  expect((await readLibrarySource(completion.repository, { catalogId: catalog.id, catalogRevisionId: catalog.revisionId })).bytes).toEqual(bytes)
  const transferred = controller.transfer(view)
  controller.hydrated(transferred)
  expect(controller.read(transferred, 'title', () => '')).toBe('Unsaved title')
  expect(controller.snapshot().dirty).toBe(true)
  // Cancelling volatile input cannot roll back the independently committed library source
  controller.release(transferred)
  expect((await completion.repository.readWorkspace()).planner.sources).toHaveLength(before.planner.sources.length + 1)
}, 60_000)
it.each(['guest', 'account'] as const)('%s changed form before activation rolls back and retains its exact input', async kind => {
  const { controller, view, repository, before, preview, expected } = await setup(kind)
  const command = controller.capture(view, () => {})
  const read = repository.readWorkspace
  vi.spyOn(repository, 'readWorkspace').mockImplementationOnce(async () => { const result = await read(); controller.edit(view, 'title', 'Later unsaved input'); return result })
  const outcome = await importOwnedLibrarySource(repository, preview, command, expected)
  expect(outcome.status).toBe('not-saved')
  expect((await repository.readWorkspace()).planner).toEqual(before.planner)
  expect(controller.read(view, 'title', () => '')).toBe('Later unsaved input')
}, 60_000)
it('a competing selected guest pointer rejects saved receipt continuation', async () => {
  const { db, controller, view, repository, preview, expected } = await setup('guest')
  const outcome = await importOwnedLibrarySource(repository, preview, controller.capture(view, () => {}), expected)
  expect(outcome.status).toBe('saved')
  const completion = await resolveOwnedFileReceipt(outcome.receipt!)
  const selected = await guestRepositorySelection(completion.repository)
  const coordinator = new GuestCoordinatorDatabase(`${db.name}-coordinator`)
  try { await coordinator.table('active').put({ key: 'active', manifest: { ...selected.manifest, id: crypto.randomUUID() } }) } finally { coordinator.close() }
  await expect(resolveOwnedFileReceipt(outcome.receipt!)).rejects.toThrow()
  expect(controller.read(view, 'title', () => '')).toBe('Unsaved title')
}, 60_000)
it('profile revocation prevents account receipt continuation', async () => {
  const { controller, view, repository, preview, expected } = await setup('account')
  const outcome = await importOwnedLibrarySource(repository, preview, controller.capture(view, () => {}), expected)
  expect(outcome.status).toBe('saved')
  invalidateProfile()
  await expect(resolveOwnedFileReceipt(outcome.receipt!)).rejects.toThrow()
}, 60_000)

it('reopens an account Build saved with its owned mod layer and no unavailable-source receipt', async () => {
  const { token, controller, view, repository, preview, expected } = await setup('account')
  const outcome = await importOwnedLibrarySource(repository, preview, controller.capture(view, () => {}), expected)
  const completion = await resolveOwnedFileReceipt(outcome.receipt!)
  const loaded = await completion.repository.load()
  const build = Object.values(loaded.localData.builds)[0]!
  const checkpoint = loaded.localData.buildRevisions[build.latestRevisionId!]!
  const original = loaded.localData.gameSetups[checkpoint.gameSetupRevisionId]!
  const behavior = selectBuildModRevision(buildBehavior(original), preview.proposed.catalogs[0]!, loaded.catalogs)
  expect(behavior.modSourceReceipts ?? []).toEqual([])
  const selected = saveBuildBehavior(loaded.localData, behavior)
  const data = saveBuildRevision(selected.localData, { buildId: build.id, parentRevisionId: checkpoint.id, gameSetupRevisionId: selected.setup.id, content: checkpoint.content, expectedRevision: selected.localData.revision })
  await completion.repository.save(data, loaded.revision)
  const reopened = await openAccountRepository(token)
  expect((await reopened.load()).localData.buildRevisions).toEqual(data.buildRevisions)
}, 60_000)
