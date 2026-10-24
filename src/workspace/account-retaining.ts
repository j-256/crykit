import { resolveAccountRecord, type AccountPreparationOwner } from './account-prepared-records'
import type { AccountWorkspaceGraphReader } from './account-graph-reader'
import { z } from 'zod'
import { assertActiveProfile, type ProfileToken } from '../account/profile'
import { maxDependencies } from '../account/protocol'
import type { AccountDatabase, CipherRecord, CipherRef } from '../persistence/account-database'
import { CipherRefSchema, cipherRef, openAccountJson, stageAccountJson } from './account-cache'
import { buildIndexPages, INDEX_PAGE_BYTES, INDEX_PAGE_ENTRIES } from './directory'

const schema = z.object({ version: z.literal(1), kind: z.literal('local-retaining-edges'), privateKey: z.string(), entries: z.array(CipherRefSchema), children: z.array(CipherRefSchema) }).strict().refine(page => page.entries.length + page.children.length <= INDEX_PAGE_ENTRIES)
export function sameCipherRefs(left: readonly CipherRef[], right: readonly CipherRef[]): boolean {
  const keys = (refs: readonly CipherRef[]) => refs.map(ref => JSON.stringify([ref.documentId, ref.revisionId])).sort()
  return JSON.stringify(keys(left)) === JSON.stringify(keys(right))
}
export async function stageAccountRetainingEdges(database: AccountDatabase, token: ProfileToken, privateKey: string, refs: readonly CipherRef[], records: CipherRecord[], owner?: AccountPreparationOwner): Promise<{ dependencies: readonly CipherRef[]; retainingIndex?: CipherRef }> {
  if (refs.length <= maxDependencies) return { dependencies: refs }
  const envelope = (page: { version: 1; entries: readonly CipherRef[]; children: readonly CipherRef[] }) => ({ ...page, kind: 'local-retaining-edges' as const, privateKey })
  const retainingIndex = await buildIndexPages(refs, async page => {
    const record = await stageAccountJson(database, token, schema.parse(envelope(page)), [...page.entries, ...page.children], undefined, owner)
    records.push(record); return cipherRef(record)
  }, page => new TextEncoder().encode(JSON.stringify(envelope(page))).length)
  return { dependencies: [retainingIndex], retainingIndex }
}
export async function readAccountRetainingEdges(database: AccountDatabase, token: ProfileToken, privateKey: string, index: CipherRef, owner?: AccountPreparationOwner, reader?: AccountWorkspaceGraphReader): Promise<readonly CipherRef[]> {
  const pages = new Set<string>(), values = new Set<string>(), refs: CipherRef[] = []
  async function visit(ref: CipherRef, depth = 0): Promise<void> {
    reader?.depth(depth)
    assertActiveProfile(token)
    const id = JSON.stringify(ref)
    if (pages.has(id)) throw new Error('Cyclic or duplicate retaining page')
    pages.add(id)
    const page = reader ? await reader.json(ref, schema) : await openAccountJson(database, token, ref, schema, owner)
    if (page.privateKey !== privateKey || new TextEncoder().encode(JSON.stringify(page)).length > INDEX_PAGE_BYTES) throw new Error('Foreign or oversized retaining page')
    const record = reader ? await reader.record(ref) : await resolveAccountRecord(database, token, ref, owner)
    if (!record || !sameCipherRefs(record.descriptor.dependencies, [...page.entries, ...page.children])) throw new Error('Retaining page descriptor mismatch')
    reader?.reserve([...page.entries, ...page.children])
    if (page.children.length) reader?.depth(depth + 1)
    for (const entry of page.entries) {
      const key = JSON.stringify(entry)
      if (values.has(key)) throw new Error('Duplicate retained revision')
      values.add(key); refs.push(entry)
    }
    for (const child of page.children) await visit(child, depth + 1)
  }
  await visit(index)
  assertActiveProfile(token)
  return refs
}
