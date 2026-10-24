import { AccountDatabase, type CipherRef } from '../persistence/account-database'
import { openAccountJson } from '../workspace/account-cache'
import { PublicationRecordSchema, ordinaryAutosaveKinds } from './sync/publication'
import { assertActiveProfile, profileSignal, type ProfileToken } from './profile'
import { SyncClient } from './sync/client'
import type { CleanupPreview } from './storage-protocol'

const LOCAL_SCAN_PAGE = 128
export interface CleanupCandidate { readonly ref: CipherRef; readonly category: string }
export interface CleanupCandidates { readonly candidates: readonly CleanupCandidate[]; readonly cursor?: string; readonly unavailable: boolean }
export async function scanCleanupCandidates(token: ProfileToken, after?: string): Promise<CleanupCandidates> {
  assertActiveProfile(token)
  const database = new AccountDatabase(token.accountId)
  try {
    const rows = await (after ? database.encryptedRevisions.where('revisionId').above(after) : database.encryptedRevisions.orderBy('revisionId')).limit(LOCAL_SCAN_PAGE).toArray()
    const candidates: CleanupCandidate[] = []
    let unavailable = false
    for (const row of rows) {
      assertActiveProfile(token)
      if (row.descriptor.protected || row.descriptor.parents.length !== 1) continue
      try {
        const ref = { documentId: row.descriptor.documentId, revisionId: row.revisionId }
        const value = await openAccountJson(database, token, ref, PublicationRecordSchema)
        if (!ordinaryAutosaveKinds.has(value.valueKind) || value.conflictAuthority || value.body.documentId !== ref.documentId) continue
        const body = await database.encryptedRevisions.get(value.body.revisionId)
        if (!body?.descriptor.protected || body.descriptor.documentId !== value.body.documentId || !row.descriptor.dependencies.some(dependency => dependency.documentId === value.body.documentId && dependency.revisionId === value.body.revisionId)) { unavailable = true; continue }
        // The category stays in this captured decrypted view, never in transport or browser preferences
        candidates.push({ ref, category: value.valueKind })
      } catch { assertActiveProfile(token); unavailable = true }
    }
    assertActiveProfile(token)
    return { candidates, ...(rows.length === LOCAL_SCAN_PAGE ? { cursor: rows.at(-1)!.revisionId } : {}), unavailable }
  } finally { database.close() }
}
export async function previewAccountCleanup(token: ProfileToken, candidate: CleanupCandidate): Promise<CleanupPreview> {
  assertActiveProfile(token)
  const client = new SyncClient(token, profileSignal(token))
  return client.previewCleanup(candidate.ref)
}
export function executeAccountCleanup(token: ProfileToken, preview: CleanupPreview) {
  assertActiveProfile(token)
  return new SyncClient(token, profileSignal(token)).cleanup({ version: 1, ref: preview.ref, generation: preview.generation, publicationEpoch: preview.publicationEpoch })
}
