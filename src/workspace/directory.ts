import type { AccountKey } from '../account/crypto/types'
import { OpaqueIdSchema } from '../account/protocol'
import { WorkspaceError } from './repository'
import type { CipherRef } from '../persistence/account-database'

export const DIRECTORY_SHARDS = 64
export const INDEX_PAGE_ENTRIES = 128
export const INDEX_PAGE_BYTES = 256 * 1024
export interface DirectoryAllocation { readonly key: string; readonly documentId: string }
export type BaselineEntry = { readonly kind: 'mutable'; readonly key: string; readonly seed: CipherRef; readonly replacedHead: string | null } | { readonly kind: 'immutable'; readonly key: string; readonly seed: CipherRef }
export interface WorkspaceControl { readonly version: 1; readonly kind: 'workspace-control'; readonly lineageId: string; readonly baseline: CipherRef; readonly recovery?: CipherRef }
export interface IndexPage<Entry> { readonly version: 1; readonly entries: readonly Entry[]; readonly children: readonly CipherRef[] }
export interface ObservedWorkspaceRevision extends CipherRef { readonly key: string; readonly lineageId: string; readonly parents: readonly string[] }
const utf8 = new TextEncoder()
export async function directoryShard(key: string): Promise<number> { return new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(key)))[0] % DIRECTORY_SHARDS }
async function privateId(key: AccountKey, accountId: string, purpose: string, input: string): Promise<string> {
  OpaqueIdSchema.parse(accountId)
  if (key.byteLength !== 32) throw new Error('Invalid account key length')
  const material = await crypto.subtle.importKey('raw', new Uint8Array(key), 'HKDF', false, ['deriveKey'])
  const hmac = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: utf8.encode(accountId), info: utf8.encode(purpose) }, material, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign'])
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', hmac, utf8.encode(input))).subarray(0, 16)
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function directoryDocumentId(key: AccountKey, accountId: string, shard: number): Promise<string> {
  if (!Number.isInteger(shard) || shard < 0 || shard >= DIRECTORY_SHARDS) throw new Error('Invalid directory shard')
  return privateId(key, accountId, 'crykit/directory-id/v1', `directory:${shard}`)
}
export function workspaceControlDocumentId(key: AccountKey, accountId: string): Promise<string> { return privateId(key, accountId, 'crykit/workspace-root-id/v1', 'workspace:root') }
export function mergeDirectory(base: readonly DirectoryAllocation[], left: readonly DirectoryAllocation[], right: readonly DirectoryAllocation[]): readonly DirectoryAllocation[] {
  const index = (entries: readonly DirectoryAllocation[]) => {
    const result = new Map<string, string>()
    for (const entry of entries) {
      if (result.has(entry.key)) throw new Error('Duplicate directory mapping')
      result.set(entry.key, entry.documentId)
    }
    return result
  }
  const b = index(base), l = index(left), r = index(right)
  const result: DirectoryAllocation[] = []
  for (const key of new Set([...b.keys(), ...l.keys(), ...r.keys()])) {
    const before = b.get(key), a = l.get(key), c = r.get(key)
    if (a !== c && a !== before && c !== before) throw new WorkspaceError('LOCAL_REVISION_CONFLICT', 'Competing directory mapping allocations require resolution.')
    const documentId = a === before ? c : a
    if (before && documentId !== before) throw new WorkspaceError('LOCAL_INTEGRITY_FAILED', 'Established directory mappings cannot be removed or reassigned; retain a tombstone.')
    if (documentId) result.push({ key, documentId })
  }
  if (new Set(result.map(value => value.documentId)).size !== result.length) throw new Error('Directory allocations share a document identity')
  return result.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
}

export function allocateDirectory(existing: readonly DirectoryAllocation[], keys: readonly string[], allocate: () => string): readonly DirectoryAllocation[] {
  const result = mergeDirectory(existing, existing, existing).slice()
  const known = new Set(result.map(value => value.key)), documentIds = new Set(result.map(value => value.documentId))
  for (const key of keys) if (!known.has(key)) {
    const documentId = allocate()
    if (documentIds.has(documentId)) throw new Error('Duplicate directory allocation identity')
    result.push({ key, documentId }); known.add(key); documentIds.add(documentId)
  }
  return result
}

export function selectBaselineRevision(entry: BaselineEntry, head: ObservedWorkspaceRevision | undefined, lineageId: string, ancestry: ReadonlyMap<string, ObservedWorkspaceRevision>): CipherRef {
  if (entry.kind === 'immutable') return entry.seed
  if (head && (head.documentId !== entry.seed.documentId || head.key !== entry.key)) throw new Error('Foreign baseline head')
  // The exact physical head at capture is the only fallback; a missing or old-lineage surprise is corruption
  if ((head?.revisionId ?? null) === entry.replacedHead) return entry.seed
  if (!head || head.lineageId !== lineageId) throw new Error('Unexpected baseline head or lineage')
  const pending = [{ revision: head, exit: false }], active = new Set<string>(), visited = new Set<string>()
  let descended = false
  while (pending.length) {
    const { revision: current, exit } = pending.pop()!
    if (exit) { active.delete(current.revisionId); visited.add(current.revisionId); continue }
    if (current.documentId !== entry.seed.documentId || current.key !== entry.key) throw new Error('Foreign baseline ancestry')
    if (active.has(current.revisionId)) throw new Error('Cyclic baseline ancestry')
    if (visited.has(current.revisionId)) continue
    if (current.revisionId === entry.seed.revisionId) { descended = true; continue }
    active.add(current.revisionId); pending.push({ revision: current, exit: true })
    for (const parent of current.parents) {
      if (parent === entry.seed.revisionId) { descended = true; continue }
      const revision = ancestry.get(parent)
      if (!revision || revision.revisionId !== parent) throw new Error('Missing baseline ancestry')
      pending.push({ revision, exit: false })
    }
  }
  if (descended) return { documentId: head.documentId, revisionId: head.revisionId }
  throw new Error('Head does not descend from baseline seed')
}

const emptyIndexPageBytes = utf8.encode(JSON.stringify({ version: 1, entries: [], children: [] })).byteLength
const indexPageBytes = (page: IndexPage<unknown>) => utf8.encode(JSON.stringify(page)).byteLength
const hasKeyedJson = (value: unknown): boolean => !!value && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function'
// Array context preserves JSON's null representation for undefined and non-finite entries
const indexValueBytes = (value: unknown) => utf8.encode(JSON.stringify([value])).byteLength - 2

export async function buildIndexPages<Entry>(entries: readonly Entry[], write: (page: IndexPage<Entry>) => Promise<CipherRef>, size?: (page: IndexPage<Entry>) => number): Promise<CipherRef> {
  // Default JSON pages add exact UTF8 element bytes and comma bytes instead of encoding every prefix
  // Custom envelope/dependency sizing and key-sensitive toJSON values keep their original complete-page checks
  async function layer(values: readonly Entry[] | readonly CipherRef[], children: boolean): Promise<CipherRef[]> {
    const result: CipherRef[] = []
    let page: IndexPage<Entry> = { version: 1, entries: [], children: [] }
    let bytes = emptyIndexPageBytes, keyedJson = false
    for (const value of values) {
      const next: IndexPage<Entry> = children ? { ...page, children: [...page.children, value as CipherRef] } : { ...page, entries: [...page.entries, value as Entry] }
      const count = page.entries.length + page.children.length
      const nextKeyedJson: boolean = keyedJson || hasKeyedJson(value)
      const nextBytes = count === INDEX_PAGE_ENTRIES ? 0 : size ? size(next) : nextKeyedJson ? indexPageBytes(next) : bytes + indexValueBytes(value) + (count ? 1 : 0)
      if (count === INDEX_PAGE_ENTRIES || nextBytes > INDEX_PAGE_BYTES) {
        if (!count) throw new Error('An index entry exceeds the page bound')
        result.push(await write(page))
        page = children ? { version: 1, entries: [], children: [value as CipherRef] } : { version: 1, entries: [value as Entry], children: [] }
        keyedJson = hasKeyedJson(value)
        bytes = size ? size(page) : keyedJson ? indexPageBytes(page) : emptyIndexPageBytes + indexValueBytes(value)
        if (bytes > INDEX_PAGE_BYTES) throw new Error('An index entry exceeds the page bound')
      } else { page = next; bytes = nextBytes; keyedJson = nextKeyedJson }
    }
    if (page.entries.length || page.children.length || !values.length) result.push(await write(page))
    return result
  }
  let refs = await layer(entries, false)
  while (refs.length > 1) refs = await layer(refs, true)
  return refs[0]
}
