import 'fake-indexeddb/auto'
import { afterEach, expect, it } from 'vitest'
import { installProfile, invalidateProfile } from '../account/profile'
import { previewCrystalEdit } from '../interchange/crystal-edit'
import { AccountDatabase } from './account-database'
import { openAccountRepository } from '../workspace/account-repository'
import { importLibrarySource, readLibrarySource } from '../workspace/mod-repository'
import { accountLocalId } from '../workspace/account-cache'
import { createBuild, saveBuildRevision } from '../domain/builds'
import { addGameSetupRevision } from '../domain/local-data'
import type { BuildId, GameSetupRevisionId } from '../domain/types'
import { jsonRecord } from '../domain/crystal-edit'

const encode = (text: string) => new TextEncoder().encode(text)
const project = (extra = '') => `{"ID":"synthetic-owned","Title":"Owned mod","Version":"1","EditorVersion":34,"Items":[{"ID":9,"Name":"Item"${extra}}]}`
let database: AccountDatabase | undefined
afterEach(async () => { invalidateProfile(); await database?.delete(); database = undefined })

it('sameBytesAreIdempotentAndChangedBytesPreserveNewOriginal', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const repository = await openAccountRepository(token)
  const first = await importLibrarySource(repository, await previewCrystalEdit(encode(project()), 'first.json'), { inReference: false, futureDefault: false })
  const second = await importLibrarySource(repository, await previewCrystalEdit(encode(project()), 'renamed.json'), { inReference: false, futureDefault: false })
  expect(second.sourceArchiveId).toBe(first.sourceArchiveId)
  expect(second.filename).toBe('first.json')
  expect(second.importedAt).toBe(first.importedAt)
  const opened = await readLibrarySource(repository, { catalogId: first.catalogId, catalogRevisionId: first.catalogRevisionId })
  expect(opened.filename).toBe('first.json')
  expect(opened.bytes).toEqual(encode(project()))
  const reformatted = await importLibrarySource(repository, await previewCrystalEdit(encode(JSON.stringify(JSON.parse(project()), null, 2)), 'formatted.json'), { inReference: false, futureDefault: false })
  expect(reformatted.originalDigest).not.toBe(first.originalDigest)
  expect(reformatted.semanticFingerprint).toBe(first.semanticFingerprint)
  const changed = await importLibrarySource(repository, await previewCrystalEdit(encode(project(',"Price":1')), 'changed.json'), { inReference: false, futureDefault: false })
  expect(changed.originalDigest).not.toBe(first.originalDigest)
  expect(changed.semanticFingerprint).not.toBe(first.semanticFingerprint)
  expect((await repository.readWorkspace()).planner.sources.map(source => source.digest)).toContain(first.originalDigest)
  expect((await repository.readWorkspace()).planner.sources.map(source => source.digest)).toContain(changed.originalDigest)
})

it('explicitActionsCommitTogetherWithoutChangingOldBuilds', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const repository = await openAccountRepository(token)
  const preview = await previewCrystalEdit(encode(project()), 'owned.json')
  const before = await repository.readWorkspace()
  await expect(importLibrarySource(repository, preview, { inReference: true, futureDefault: true, enableTarget: { kind: 'team', id: 'missing', expectedRevision: 0 } })).rejects.toThrow()
  expect((await repository.readWorkspace()).planner.sources).toEqual(before.planner.sources)
  const result = await importLibrarySource(repository, preview, { inReference: true, futureDefault: true })
  const after = await repository.readWorkspace()
  expect(after.libraryDefaults.layers).toEqual([{ catalogId: result.catalogId, catalogRevisionId: result.catalogRevisionId, enabled: true }])
  expect(after.planner.localData.referenceLibrary?.excludedMods).not.toContain(result.catalogId)
  expect(after.planner.sources).toHaveLength(1)
  expect(await database.outbox.count()).toBeGreaterThan(0)
})

it('rejects a falsified semantic fingerprint before any encrypted record is installed', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const repository = await openAccountRepository(token)
  const preview = await previewCrystalEdit(encode(project()), 'owned.json')
  const catalog = preview.proposed.catalogs[0]!
  const changed = { ...preview, proposed: { ...preview.proposed, catalogs: [{ ...catalog, legacy: { ...(jsonRecord(catalog.legacy) ? catalog.legacy : {}), contentFingerprint: `json-content-v1:sha256:${'0'.repeat(64)}` } }] } }
  await expect(importLibrarySource(repository, changed, { inReference: false, futureDefault: false })).rejects.toThrow('fingerprint')
  expect((await repository.readWorkspace()).planner.sources).toEqual([])
  expect(await database.outbox.count()).toBe(0)
})

it('saves an explicitly targeted Build checkpoint without rewriting its original', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const repository = await openAccountRepository(token)
  const initial = await repository.load()
  let data = addGameSetupRevision(initial.localData, { label: 'Original setup' })
  const setup = Object.values(data.gameSetups)[0]!
  const buildId = 'synthetic-build' as BuildId
  data = createBuild(data, { id: buildId, gameSetupId: setup.gameSetupId, title: 'Synthetic Build' })
  data = saveBuildRevision(data, { buildId, gameSetupRevisionId: setup.id as GameSetupRevisionId, content: { primaryClass: null, secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [] } })
  await repository.save(data, initial.revision)
  const original = (await repository.load()).localData
  const originalCheckpoint = original.buildRevisions[original.builds[buildId]!.latestRevisionId!]!
  const preview = await previewCrystalEdit(encode(project()), 'owned.json')
  const result = await importLibrarySource(repository, preview, { inReference: false, futureDefault: false, enableTarget: { kind: 'build', id: buildId, expectedRevision: original.builds[buildId]!.revision } })
  const after = (await repository.load()).localData
  expect(after.buildRevisions[originalCheckpoint.id]).toEqual(originalCheckpoint)
  expect(after.builds[buildId]!.latestRevisionId).toBe(result.checkpointId)
  expect(after.gameSetups[after.buildRevisions[result.checkpointId!]!.gameSetupRevisionId]!.modComposition?.layers).toContainEqual({ catalogId: result.catalogId, catalogRevisionId: result.catalogRevisionId, enabled: true })
}, 60_000)
