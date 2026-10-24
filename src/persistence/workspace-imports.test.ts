import 'fake-indexeddb/auto'
import '../workspace/guest-managed-monitor.test-helpers'
import { openManagedNativeWorkspace } from './managed-sync.test-helpers'
import { expect, it } from 'vitest'
import { CryKitDatabase, setDatabaseForTests } from './database'
import { AccountDatabase } from './account-database'
import { installProfile, invalidateProfile } from '../account/profile'
import { accountLocalId } from '../workspace/account-cache'
import { openAccountRepository } from '../workspace/account-repository'
import { createGuestRepository } from '../workspace/guest-repository'
import { previewCrystalEdit } from '../interchange/crystal-edit'
import { readBlob, blobIdentity } from '../workspace/blobs'
import { inspectWorkspaceClosure } from '../workspace/closure'

for (const mode of ['guest', 'account'] as const) it(`${mode} reference import preserves exact inert originals and rolls back a conflicting immutable source`, async () => {
  const guest = new CryKitDatabase(`workspace-import-${crypto.randomUUID()}`)
  setDatabaseForTests(guest)
  const token = mode === 'account' ? installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))) : undefined
  const database = token ? new AccountDatabase(token.accountId) : undefined
  try {
    let repository = token ? await openAccountRepository(token) : createGuestRepository()
    const before = await repository.readWorkspace()
    const bytes = new TextEncoder().encode('\ufeff{\r\n"ID":"synthetic-exact","password":"inert","Equipment":[{"ID":10000,"Name":"Synthetic imported item"}]}')
    const preview = await previewCrystalEdit(bytes, 'exact.json')
    await repository.commitImport(preview, { mode: 'add-reference', expectedRevision: before.planner.localData.revision })
    repository = token ? await openAccountRepository(token) : createGuestRepository()
    const loaded = await repository.readWorkspace()
    expect(loaded.planner.localData.builds).toEqual(before.planner.localData.builds)
    const source = loaded.planner.sources.find(source => source.digest === preview.sourceDigest)!
    const blob = loaded.blobs.find(blob => blobIdentity(blob.ref) === blobIdentity(source.original))!
    expect(await readBlob(blob.content, bytes.length)).toEqual(bytes)
    expect(loaded.planner.catalogs.some(catalog => catalog.id === preview.proposed.catalogs[0].id)).toBe(true)
    if (token) {
      const mapped = await openManagedNativeWorkspace(database!, token)
      const pending = mapped.state.retainedContent.filter(content => content.kind === 'pending-content')
      expect(pending.length).toBeGreaterThan(0)
      const catalog = pending.find(content => content.unit.privateKey.includes('catalog'))!
      const original = mapped.state.planner.sources.find(value => value.id === source.id)!.original
      expect((await inspectWorkspaceClosure(mapped.state, catalog.target)).refs.has(blobIdentity(original))).toBe(true)
      expect(await readBlob(mapped.state.blobs.find(value => blobIdentity(value.ref) === blobIdentity(original))!.content, bytes.length)).toEqual(bytes)
    }
    const invalid = { ...preview, proposed: { ...preview.proposed, sources: preview.proposed.sources.map(source => ({ ...source, digest: '0'.repeat(64) })) } }
    await expect(repository.commitImport(invalid, { mode: 'add-reference', expectedRevision: loaded.planner.localData.revision })).rejects.toThrow('conflict')
    expect((await repository.readWorkspace()).planner.localData).toEqual(loaded.planner.localData)
    expect(await repository.readSources()).toEqual(preview.proposed.sources)
    const corrupt = { ...preview, proposed: { ...preview.proposed, sources: preview.proposed.sources.map(source => ({ ...source, bytes: new Uint8Array(source.bytes.length) })) } }
    await expect(repository.commitImport(corrupt, { mode: 'add-reference', expectedRevision: loaded.planner.localData.revision })).rejects.toThrow()
    expect((await repository.readWorkspace()).planner.localData).toEqual(loaded.planner.localData)
  } finally { invalidateProfile(); setDatabaseForTests(undefined); await guest.delete(); await database?.delete() }
})

for (const mode of ['guest', 'account'] as const) it(`${mode} native replacement preserves complete retained history`, async () => {
  const { createPersonalDefinition } = await import('../domain')
  const guest = new CryKitDatabase(`workspace-native-${crypto.randomUUID()}`)
  setDatabaseForTests(guest)
  const token = mode === 'account' ? installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))) : undefined
  const database = token ? new AccountDatabase(token.accountId) : undefined
  try {
    let repository = token ? await openAccountRepository(token) : createGuestRepository()
    const original = await repository.readWorkspace()
    await repository.save(createPersonalDefinition(original.planner.localData, { name: 'Native retained original', kind: 'item' }), original.planner.localData.revision)
    const exported = await repository.exportPlannerBackup()
    const preview = await repository.previewImport(exported, 'native.zip')
    expect(preview.errors).toEqual([])
    let current = await repository.load()
    await repository.save(createPersonalDefinition(current.localData, { name: 'Replaced draft', kind: 'item' }), current.revision)
    current = await repository.load()
    const roundtrip = await repository.readWorkspace()
    for (const field of ['catalogs', 'evidence', 'history'] as const) for (const incoming of preview.proposed[field]) { const existing = roundtrip.planner[field].find(value => value.id === incoming.id && (!('revisionId' in incoming) || 'revisionId' in value && value.revisionId === incoming.revisionId)); if (existing) expect(existing, `Roundtrip ${field}:${incoming.id}`).toEqual(incoming) }
    await repository.commitImport(preview, { mode: 'replace', expectedRevision: current.revision })
    repository = token ? await openAccountRepository(token) : createGuestRepository()
    const replaced = await repository.readWorkspace()
    expect(replaced.planner.localData.personalDefinitions).toEqual(preview.proposed.localData.personalDefinitions)
    expect(replaced.planner.localData.id).toBe(original.planner.localData.id)
    for (const entry of preview.proposed.history) expect(replaced.planner.history).toContainEqual(entry)
  } finally { invalidateProfile(); setDatabaseForTests(undefined); await guest.delete(); await database?.delete() }
})

for (const mode of ['guest', 'account'] as const) it(`${mode} mod setup retains exact source bytes`, async () => {
  const guest = new CryKitDatabase(`workspace-mod-setup-${crypto.randomUUID()}`)
  setDatabaseForTests(guest)
  const token = mode === 'account' ? installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))) : undefined
  const database = token ? new AccountDatabase(token.accountId) : undefined
  try {
    let repository = token ? await openAccountRepository(token) : createGuestRepository()
    if (token) {
      const { addGameSetupRevision } = await import('../domain/local-data')
      const { CURRENT_CATALOG } = await import('../catalog/bundled')
      const { createAccountLocalStore } = await import('../workspace/account-local-store')
      const { admitLocalRoot, prepareLocalWorkspace } = await import('../workspace/local-root')
      const { activateLocalAccountCommit } = await import('./account-database')
      const blank = await repository.readWorkspace()
      const localData = addGameSetupRevision(blank.planner.localData, { label: 'Chosen starting setup', catalogLock: { [CURRENT_CATALOG.id]: CURRENT_CATALOG.revisionId }, expectedRevision: blank.planner.localData.revision })
      // Bootstrap the starting fixture without adding an unrelated pending setup-creation operation
      const store = createAccountLocalStore(database!, token), operationId = accountLocalId(), fence = (await database!.profileMeta.get('active'))!
      try {
        const previous = await admitLocalRoot(store.adapter, fence.head, store.lifetime)
        const prepared = await prepareLocalWorkspace(store.adapter, operationId, { ...blank, planner: { ...blank.planner, localData } }, store.lifetime, previous)
        await activateLocalAccountCommit(database!, token, await store.prepareActivation(operationId, prepared, fence, previous))
        store.committed(operationId)
      } finally { await store.dispose() }
      repository = await openAccountRepository(token)
    }
    const initial = await repository.readWorkspace()
    const bytes = new TextEncoder().encode('\ufeff{\r\n"ID":"mod-setup-exact","Equipment":[{"ID":10000,"Name":"Setup imported item"}]}')
    const mod = await previewCrystalEdit(bytes, 'setup.json')
    await repository.commitModSetup([mod], initial.planner.localData.revision)
    repository = token ? await openAccountRepository(token) : createGuestRepository()
    const configured = await repository.readWorkspace()
    expect(configured.planner.localData.modSetup).toEqual({ version: 1, state: 'completed' })
    const source = configured.planner.sources.find(source => source.digest === mod.sourceDigest)!
    const body = configured.blobs.find(blob => blobIdentity(blob.ref) === blobIdentity(source.original))!
    expect(await readBlob(body.content, bytes.length)).toEqual(bytes)
    expect(configured.planner.localData.personalDefinitions).toEqual(initial.planner.localData.personalDefinitions)

  } finally { invalidateProfile(); setDatabaseForTests(undefined); await guest.delete(); await database?.delete() }
})

for (const mode of ['guest', 'account'] as const) it(`${mode} invalid mod setup preserves the active workspace`, async () => {
  const guest = new CryKitDatabase(`workspace-mod-reject-${crypto.randomUUID()}`)
  setDatabaseForTests(guest)
  const token = mode === 'account' ? installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))) : undefined
  const database = token ? new AccountDatabase(token.accountId) : undefined
  try {
    const repository = token ? await openAccountRepository(token) : createGuestRepository()
    const before = await repository.load()
    const mod = await previewCrystalEdit(new TextEncoder().encode('{"ID":"invalid-skip","Equipment":[]}'), 'skip.json')
    await expect(repository.commitModSetup([mod], before.revision, true)).rejects.toThrow('Skipping')
    expect((await repository.load()).localData).toEqual(before.localData)
  } finally { invalidateProfile(); setDatabaseForTests(undefined); await guest.delete(); await database?.delete() }
})
