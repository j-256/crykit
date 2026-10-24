import type { AccountDatabase } from '../../persistence/account-database'
import type { ProfileToken } from '../profile'
import type { OpenAccountWorkspace } from '../../workspace/account-graph'
import type { WorkspaceState } from '../../workspace/documents'
import type { OriginalPublication } from '../../workspace/conflict-authority'
import { archiveMappingEvidence } from '../../workspace/mapping-closure'
import { archiveWorkspaceUnit } from '../../workspace/pending-content'
import { openAccountSource } from '../../workspace/account-streams'
import { openAccountJson } from '../../workspace/account-cache'
import { DirectorySchema, DirectoryPageSchema, PublicationControlSchema, BaselinePageSchema } from './publication'
import { captureOriginalUnit } from './captured-unit'
import { blobIdentity } from '../../workspace/blobs'
export async function archiveDirectoryMapping(database: AccountDatabase, token: ProfileToken, workspace: OpenAccountWorkspace, publication: OriginalPublication, blobs: Map<string, WorkspaceState['blobs'][number]>) {
  if (!publication.mapping) throw new Error('Missing mapping authority')
  const value = await openAccountJson(database, token, publication.ref, DirectorySchema)
  const frames = [{ source: publication.ref, content: await openAccountSource(database, token, publication.ref) }], seen = new Set<string>()
  const page = async (ref: typeof publication.ref) => {
    if (seen.has(blobIdentity(ref))) throw new Error('Duplicate mapping page')
    seen.add(blobIdentity(ref))
    frames.push({ source: ref, content: await openAccountSource(database, token, ref) })
    const value = await openAccountJson(database, token, ref, DirectoryPageSchema)
    for (const child of value.children) await page(child)
  }
  await page(value.index)
  const context = publication.mapping.context
  if (context) {
    frames.push({ source: context.control.ref, content: await openAccountSource(database, token, context.control.ref) })
    const control = await openAccountJson(database, token, context.control.ref, PublicationControlSchema)
    const baseline = async (ref: typeof publication.ref): Promise<void> => {
      if (seen.has(blobIdentity(ref))) throw new Error('Duplicate mapping baseline page')
      seen.add(blobIdentity(ref))
      frames.push({ source: ref, content: await openAccountSource(database, token, ref) })
      for (const child of (await openAccountJson(database, token, ref, BaselinePageSchema)).children) await baseline(child)
    }
    // Sibling seed/recovery refs stay inside inert raw metadata; never traverse their semantic bodies
    await baseline(control.baseline)
  }
  const record = publication.mapping.record
  const content = record ? await archiveWorkspaceUnit(await captureOriginalUnit(workspace, record), record.privateKey, blobs, record) : undefined
  return archiveMappingEvidence(publication, frames, content, blobs)
}
