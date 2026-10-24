import type { AccountDatabase, CipherRef } from '../../persistence/account-database'
import type { ProfileToken } from '../profile'
import type { OriginalPublication } from '../../workspace/conflict-authority'
import type { OpenAccountWorkspace } from '../../workspace/account-graph'
import { capturedRecordReader } from '../../workspace/account-evidence'
import { archiveTypedReferences } from '../../workspace/closure'
import { blobIdentity, hashBlob } from '../../workspace/blobs'
import { isBlobSource } from '../../workspace/documents'
import { stageAccountSource } from '../../workspace/account-streams'
import { cipherRef } from '../../workspace/account-cache'
import { selectCapturedBranch } from './branch-selection'
import { SyncError } from './client'

export async function assertEditorTransportBinding(database: AccountDatabase, token: ProfileToken, original: OriginalPublication, body: CipherRef): Promise<void> {
  const read = capturedRecordReader(database, token, new Map())
  const source = await read(original.body), target = await read(body)
  if (original.valueKind !== 'editor' || original.sourceBookkeeping || source.document.kind !== 'editor' || target.document.kind !== 'editor' || source.document.key !== original.privateKey || target.document.key !== original.privateKey || source.digest !== original.digest || target.digest !== original.digest || body.documentId !== original.body.documentId) throw new SyncError('CONFLICT_DEPENDENCY_IN_USE')
  const descriptor = await database.encryptedRevisions.get(body.revisionId)
  if (!descriptor || (body.revisionId !== original.body.revisionId && JSON.stringify(descriptor.descriptor.parents) !== JSON.stringify([original.body.revisionId]))) throw new SyncError('INTEGRITY_FAILED')
  const refs = archiveTypedReferences('editor', source.document.value)
  if (JSON.stringify(refs) !== JSON.stringify(archiveTypedReferences('editor', target.document.value)) || source.dependencies.length !== target.dependencies.length) throw new SyncError('CONFLICT_DEPENDENCY_IN_USE')
  const expected = new Map(refs.map(ref => [JSON.stringify(['blob', blobIdentity(ref)]), ref]))
  for (let index = 0; index < source.dependencies.length; index++) {
    const before = await read(source.dependencies[index]), after = await read(target.dependencies[index])
    const native = expected.get(before.document.key)
    if (!native || before.document.kind !== 'blob' || after.document.kind !== 'blob' || before.document.key !== after.document.key || before.digest !== after.digest || before.dependencies.length || after.dependencies.length || before.retainingIndex || after.retainingIndex || !isBlobSource(before.document.value) || !isBlobSource(after.document.value) || before.document.value.byteLength !== native.byteLength || after.document.value.byteLength !== native.byteLength || await hashBlob(before.document.value) !== native.sha256 || await hashBlob(after.document.value) !== native.sha256) throw new SyncError('CONFLICT_DEPENDENCY_IN_USE')
    // Actual leaf descriptors must be empty too; an indirection cannot disguise retained-container edges
    for (const leaf of [before, after]) {
      const row = await database.encryptedRevisions.get(leaf.ref.revisionId)
      if (!row || row.descriptor.dependencies.length) throw new SyncError('CONFLICT_DEPENDENCY_IN_USE')
    }
    expected.delete(before.document.key)
  }
  if (expected.size) throw new SyncError('CONFLICT_DEPENDENCY_IN_USE')
}

export async function selectMappingBranch(database: AccountDatabase, token: ProfileToken, local: OpenAccountWorkspace, remote: OpenAccountWorkspace, original: OriginalPublication): Promise<OpenAccountWorkspace> {
  const selected = await selectCapturedBranch(local, remote, original)
  const source = await selected.readCaptured(original.body)
  const dependencies: CipherRef[] = []
  for (const ref of source.dependencies) {
    const child = await selected.readCaptured(ref), active = selected.entries.find(entry => entry.key === child.document.key)
    if (!active) throw new SyncError('CONFLICT_DEPENDENCY_IN_USE')
    dependencies.push(active.ref)
  }
  if (JSON.stringify(dependencies) === JSON.stringify(source.dependencies)) return selected
  if (original.valueKind !== 'editor' || original.sourceBookkeeping) throw new SyncError('CONFLICT_DEPENDENCY_IN_USE')
  // Copy the exact framed source under a fresh transport revision; frozen native refs and original evidence never change
  const record = await stageAccountSource(database, token, source.source, dependencies, original.body, original.body.documentId)
  await database.encryptedRevisions.add(record)
  const ref = cipherRef(record)
  await assertEditorTransportBinding(database, token, original, ref)
  return { ...selected, entries: selected.entries.map(entry => entry.key === original.privateKey ? { ...entry, ref } : entry), readCaptured: capturedRecordReader(database, token, new Map()) }
}
