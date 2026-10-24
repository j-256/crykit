import { z } from 'zod'
import type { CipherRef } from '../persistence/account-database'
import { WORKSPACE_BACKUP_LIMITS } from '../interchange/workspace-backup-schema'
import { blobIdentity } from './blobs'
import { buildIndexPages, INDEX_PAGE_BYTES, INDEX_PAGE_ENTRIES, type IndexPage } from './directory'

const refSchema = z.strictObject({ documentId: z.string().min(1), revisionId: z.string().min(1) })
const pageSchema = z.strictObject({ version: z.literal(1), entries: z.array(z.unknown()), children: z.array(refSchema) })
const utf8 = new TextEncoder()
export interface LocalIndex<T> { readonly root: CipherRef; readonly entries: readonly T[] }
const pages = new WeakMap<object, ReadonlyMap<string, CipherRef>>()

// Page reuse is exact encoded metadata reuse, not admission of a selected workspace
// Callers still guard the captured head and the actual referenced records at activation
export async function prepareLocalIndex<T>(entries: readonly T[], write: (page: IndexPage<T>) => Promise<CipherRef>, previous?: LocalIndex<T>): Promise<LocalIndex<T>> {
  const before = previous && pages.get(previous), next = new Map<string, CipherRef>()
  const root = await buildIndexPages(entries, async page => {
    const encoded = JSON.stringify(page)
    const ref = before?.get(encoded) ?? await write(page)
    next.set(encoded, ref)
    return ref
  })
  const result = Object.freeze({ root, entries: Object.freeze([...entries]) })
  pages.set(result, next)
  return result
}

export async function readLocalIndex<T>(root: CipherRef, read: (ref: CipherRef) => Promise<unknown>, parse: (entry: unknown) => T = value => value as T): Promise<LocalIndex<T>> {
  const entries: T[] = [], seen = new Set<string>(), captured = new Map<string, CipherRef>()
  async function visit(ref: CipherRef, depth: number): Promise<void> {
    const identity = blobIdentity(ref)
    if (seen.has(identity)) throw new Error('Repeated or cyclic local index page')
    if (depth > WORKSPACE_BACKUP_LIMITS.depth || seen.size >= WORKSPACE_BACKUP_LIMITS.frames) throw new Error('Local index resource limit')
    seen.add(identity)
    const page = pageSchema.parse(await read(ref))
    const encoded = JSON.stringify(page)
    if (page.entries.length + page.children.length > INDEX_PAGE_ENTRIES || utf8.encode(encoded).byteLength > INDEX_PAGE_BYTES) throw new Error('Local index page exceeds bound')
    captured.set(encoded, ref)
    for (const entry of page.entries) entries.push(parse(entry))
    for (const child of page.children) await visit(child, depth + 1)
  }
  await visit(refSchema.parse(root), 0)
  const result = Object.freeze({ root, entries: Object.freeze(entries) })
  pages.set(result, captured)
  return result
}

export function admittedLocalIndexRefs(index: LocalIndex<unknown>): readonly CipherRef[] {
  const captured = pages.get(index)
  if (!captured) throw new Error('Unadmitted local index')
  return [...captured.values()]
}
