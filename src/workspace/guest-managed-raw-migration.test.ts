import './guest-managed-monitor.test-helpers'
import Dexie from 'dexie'
import { expect, it, vi } from 'vitest'
import { CryKitDatabase } from '../persistence/database'
import { createBlankLocalData } from '../domain/local-data'
import { openGuestBindings } from './guest-workspace'
import { migrateGuestWorkspace } from './guest-managed-migration'
import { openGuestManagedRepository, managedGuestRecoveryNotices } from './guest-managed-repository'
import { createEditorRepository } from './editor-repository'

vi.mock('../catalog/bundled', async importOriginal => ({ ...await importOriginal<typeof import('../catalog/bundled')>(), BUNDLED_CATALOGS: [] }))

it('migrates exact pre-feature Inspector rows without adding stores or rewriting invalid drafts', async () => {
  const original = new CryKitDatabase(`synthetic-raw-migration-${crypto.randomUUID()}`)
  const localData = createBlankLocalData()
  await original.localDatas.put({ id: 'local-data-record', revision: localData.revision, updatedAt: localData.updatedAt, localData, lineage: { rootLocalDataId: localData.id } })
  const binding = await openGuestBindings(original)
  const inspector = new Dexie(binding.manifest.inspector)
  inspector.version(1).stores({ drafts: 'id, updatedAt' })
  const row = { schemaVersion: 1, id: 'raw-editor', filename: 'raw.json', referenceId: 'synthetic', createdAt: '2026-01-01', updatedAt: '2026-01-01', revision: 1, originalText: '\ufeff{\r\n"unknown":900719925474099312345\r\n}', draftText: '{"unfinished":' }
  await inspector.table('drafts').add(row)
  try {
    const target = await migrateGuestWorkspace(binding)
    const repository = await openGuestManagedRepository(binding.coordinator, target)
    const file = await createEditorRepository(repository).read(row.id)
    expect(file!.content.originalText).toBe(row.originalText)
    expect(file!.content.unfinishedText).toBe(row.draftText)
    expect(inspector.backendDB().version).toBe(10)
    expect([...inspector.backendDB().objectStoreNames]).toEqual(['drafts'])
    expect(await inspector.table('drafts').get(row.id)).toEqual(row)
    await inspector.table('drafts').put({ ...row, draftText: '{"later":' })
    expect((await managedGuestRecoveryNotices(repository))!.map(value => value.status)).toEqual(['diverged'])
    const active = await binding.coordinator.active.get('active')
    const loaded = await repository.load()
    await expect(repository.save(loaded.localData, loaded.revision)).rejects.toThrow('Retained local data needs a complete comparison before saving')
    expect(await binding.coordinator.active.get('active')).toEqual(active)
  } finally { inspector.close(); original.close(); binding.inspector.close(); binding.files.close(); binding.coordinator.close() }
}, 30_000)

it.each([1, 2, 3, 4, 5, 6, 7])('projects supported legacy planner layout %s without rewriting its root or Undo evidence', async version => {
  const name = `synthetic-raw-planner-${crypto.randomUUID()}`
  const original = new CryKitDatabase(name), raw = new Dexie(name)
  raw.version(version).stores(Object.fromEntries(original.tables.map(table => [table.name, [table.schema.primKey.src, ...table.schema.indexes.map(index => index.src)].join(',')])))
  const { createPersonalDefinition } = await import('../domain')
  const { changedLocalData, historyEntry } = await import('../persistence/local-data')
  const before = createBlankLocalData(), after = changedLocalData(before, createPersonalDefinition(before, { name: 'Retained unknown item', kind: 'item' }), 'save', before.updatedAt)
  const old = (data: typeof before) => {
    if (version === 7) return data
    const { teamRevisions: _teamRevisions, ...rest } = data
    const { teams: _teams, ...withoutTeams } = rest
    return { ...(version <= 2 ? withoutTeams : rest), schemaVersion: version === 1 ? '2.0.0' : version === 2 ? '2.1.0' : version <= 4 ? '2.2.0' : version === 5 ? '2.3.0' : '2.4.0' }
  }
  const checkpoint = { ...historyEntry(before, after, 'save', before.updatedAt), before: old(before), after: old(after) }
  const row = { id: 'local-data-record', revision: after.revision, updatedAt: after.updatedAt, localData: old(after), lineage: { rootLocalDataId: before.id } }
  await raw.table('localDatas').put(row); await raw.table('history').add(checkpoint)
  const binding = await openGuestBindings(original)
  try {
    const target = await migrateGuestWorkspace(binding)
    const repository = await openGuestManagedRepository(binding.coordinator, target)
    const loaded = await repository.load()
    expect(loaded.localData).toEqual(after)
    expect(loaded.canUndo).toBe(true)
    const retainedState = await repository.readWorkspace()
    expect(retainedState.planner.history).toEqual([{ ...checkpoint, before, after }])
    const undone = await repository.undo(loaded.revision)
    expect(undone.localData.personalDefinitions).toEqual(before.personalDefinitions)
    expect(raw.backendDB().version).toBe(version * 10)
    expect(await raw.table('localDatas').get(row.id)).toEqual(row)
    expect(await raw.table('history').get(checkpoint.id)).toEqual(checkpoint)
  } finally { raw.close(); original.close(); binding.inspector.close(); binding.files.close(); binding.coordinator.close() }
}, 30_000)

it('rejects an unsupported retained Inspector schema without upgrading or replacing any participant', async () => {
  const original = new CryKitDatabase(`synthetic-raw-unknown-${crypto.randomUUID()}`), localData = createBlankLocalData()
  const row = { id: 'local-data-record', revision: localData.revision, updatedAt: localData.updatedAt, localData, lineage: { rootLocalDataId: localData.id } }
  await original.localDatas.put(row)
  const binding = await openGuestBindings(original), raw = new Dexie(binding.manifest.inspector)
  raw.version(2).stores({ drafts: 'id, updatedAt', unknown: 'id' })
  await raw.table('unknown').put({ id: 'keep', value: ['unknown', null, 9007199254740991] })
  try {
    await expect(migrateGuestWorkspace(binding)).rejects.toThrow('The selected guest schema is unsupported')
    expect((await binding.coordinator.active.get('active'))!.manifest).toEqual(binding.manifest)
    expect(await original.localDatas.get(row.id)).toEqual(row)
    expect(raw.backendDB().version).toBe(20)
    expect([...raw.backendDB().objectStoreNames]).toEqual(['drafts', 'unknown'])
    expect(await raw.table('unknown').get('keep')).toEqual({ id: 'keep', value: ['unknown', null, 9007199254740991] })
    expect(await binding.coordinator.table('managedRecords').count()).toBe(0)
  } finally { raw.close(); original.close(); binding.inspector.close(); binding.files.close(); binding.coordinator.close() }
})

it('preserves chunked pre-feature Inspector text and rejects damaged chunks before publication', async () => {
  const original = new CryKitDatabase(`synthetic-raw-chunks-${crypto.randomUUID()}`), localData = createBlankLocalData()
  await original.localDatas.put({ id: 'local-data-record', revision: 0, updatedAt: localData.updatedAt, localData, lineage: { rootLocalDataId: localData.id } })
  const binding = await openGuestBindings(original), raw = new Dexie(binding.manifest.inspector)
  raw.version(2).stores({ drafts: 'id, updatedAt', chunks: '[draftId+kind+index], [draftId+kind], draftId' })
  const originalText = '\ufeff{"Unknown":900719925474099312345}\r\n', draftText = '{"Invalid":'
  const payload = (text: string) => {
    let checksum = 2_166_136_261
    for (let index = 0; index < text.length; index++) checksum = Math.imul(checksum ^ text.charCodeAt(index), 16_777_619)
    return { codeUnits: text.length, chunkCount: 1, checksums: [checksum >>> 0] }
  }
  const row = { schemaVersion: 1, layoutVersion: 2, id: 'chunked', filename: 'chunked.json', referenceId: 'synthetic', createdAt: '2026-01-01', updatedAt: '2026-01-01', revision: 2, originalPayload: payload(originalText), draftPayload: payload(draftText) }
  const chunks = [{ layoutVersion: 2, draftId: row.id, kind: 'original', revision: 1, index: 0, text: originalText }, { layoutVersion: 2, draftId: row.id, kind: 'draft', revision: 2, index: 0, text: draftText }]
  await raw.table('drafts').put(row); await raw.table('chunks').bulkPut(chunks)
  try {
    await raw.table('chunks').put({ ...chunks[1], text: '{"Changed":' })
    await expect(migrateGuestWorkspace(binding)).rejects.toThrow(/checksum/)
    expect((await binding.coordinator.active.get('active'))!.manifest).toEqual(binding.manifest)
    await raw.table('chunks').put(chunks[1])
    const target = await migrateGuestWorkspace(binding)
    const repository = await openGuestManagedRepository(binding.coordinator, target)
    const file = await createEditorRepository(repository).read(row.id)
    expect(file!.content.originalText).toBe(originalText)
    expect(file!.content.unfinishedText).toBe(draftText)
    expect(raw.backendDB().version).toBe(20)
    expect([...raw.backendDB().objectStoreNames]).toEqual(['chunks', 'drafts'])
    expect(await raw.table('drafts').get(row.id)).toEqual(row)
    expect(await raw.table('chunks').orderBy(':id').toArray()).toEqual([chunks[1], chunks[0]])
  } finally { raw.close(); original.close(); binding.inspector.close(); binding.files.close(); binding.coordinator.close() }
}, 30_000)
