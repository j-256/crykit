import 'fake-indexeddb/auto'
import { afterEach, expect, it } from 'vitest'
import { AccountDatabase } from './account-database'
import { installProfile, invalidateProfile } from '../account/profile'
import { accountLocalId, cipherRef } from '../workspace/account-cache'
import { prepareAccountWorkspace } from '../workspace/account-graph'
import { editorClosureFixture } from '../workspace/test-helpers'
import { stagePublicationRecord } from '../account/sync/publication'
import { readOriginalPublication } from '../account/sync/conflict-authority'
import { selectMappingBranch, assertEditorTransportBinding } from '../account/sync/mapping-selection'
import { stageAccountSource } from '../workspace/account-streams'
import { workspaceDocumentSource } from '../workspace/document-codec'
let database: AccountDatabase | undefined
afterEach(async () => { invalidateProfile(); await database?.delete() })
it('mappingEditorRebindingPreservesFrozenBytesAndRejectsNonEquivalentOrNonLeafSources', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const fixture = await editorClosureFixture()
  const create = async (filename: string) => {
    const prepared = await prepareAccountWorkspace(database!, token, { ...fixture.state, editorDocuments: [{ ...fixture.file, filename }], retainedContent: [], blobs: fixture.blobs.filter(blob => blob.ref.encoding === 'utf16le') })
    await database!.encryptedRevisions.bulkAdd(prepared.records)
    return prepared.opened
  }
  const pending = await create('Pending.json'), accepted = await create('Accepted.json')
  const key = JSON.stringify(['editor', fixture.file.id]), entry = pending.entries.find(entry => entry.key === key)!
  const envelope = await stagePublicationRecord(database, token, entry, accountLocalId())
  const original = await readOriginalPublication(database, token, cipherRef(envelope))
  const frozen = await database.encryptedRevisions.get(entry.ref.revisionId)
  const selected = await selectMappingBranch(database, token, accepted, pending, original)
  const body = selected.entries.find(entry => entry.key === key)!.ref
  expect(body).not.toEqual(original.body)
  expect(body.documentId).toBe(original.body.documentId)
  await assertEditorTransportBinding(database, token, original, body)
  expect(await database.encryptedRevisions.get(entry.ref.revisionId)).toEqual(frozen)
  for (const wrong of [{ ...original, privateKey: 'wrong' }, { ...original, valueKind: 'save' }, { ...original, digest: '0'.repeat(64) }, { ...original, sourceBookkeeping: {} as NonNullable<typeof original.sourceBookkeeping> }]) await expect(assertEditorTransportBinding(database, token, wrong, body)).rejects.toThrow()
  const captured = await selected.readCaptured(body)
  const altered = await stageAccountSource(database, token, workspaceDocumentSource({ ...captured.document, value: { ...fixture.file, original: { ...fixture.file.original, encoding: 'bytes' } } as unknown as import('../workspace/documents').WorkspaceDocument['value'] }), captured.dependencies, original.body, original.body.documentId)
  await database.encryptedRevisions.add(altered)
  await expect(assertEditorTransportBinding(database, token, original, cipherRef(altered))).rejects.toThrow()
  const leaf = await database.encryptedRevisions.get(captured.dependencies[0].revisionId)
  await database.encryptedRevisions.put({ ...leaf!, descriptor: { ...leaf!.descriptor, dependencies: [captured.dependencies[0]] } })
  await expect(assertEditorTransportBinding(database, token, original, body)).rejects.toThrow()
})
