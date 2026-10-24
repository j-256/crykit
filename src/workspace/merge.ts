import { z } from 'zod'
import type { JsonValue } from '../domain/types'
import { isBlobSource, type WorkspaceDocument } from './documents'
import { mergeDirectory } from './directory'

export type MergeResult = { readonly kind: 'merged'; readonly document: WorkspaceDocument } | { readonly kind: 'conflict' }
const directorySchema = z.strictObject({ version: z.literal(1), kind: z.literal('directory'), shard: z.number().int().min(0).max(63), entries: z.array(z.strictObject({ key: z.string(), documentId: z.string() })), children: z.tuple([]) })
function canonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as { readonly [key: string]: JsonValue })[key])}`).join(',')}}`
}
function comparable(document: WorkspaceDocument): string | undefined {
  if (isBlobSource(document.value)) return undefined
  let value = document.value
  if (document.kind === 'playthrough' && value && typeof value === 'object' && !Array.isArray(value)) {
    const metadata = (value as { readonly [key: string]: JsonValue }).metadata
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
      // Child commands advance these exact local counters without changing the semantic owner
      const { revision: _revision, updatedAt: _updatedAt, ...semantic } = metadata as { readonly [key: string]: JsonValue }
      value = { ...value, metadata: semantic }
    }
  }
  return canonical({ version: document.version, kind: document.kind, key: document.key, value })
}
export function mergeDocument(base: WorkspaceDocument, local: WorkspaceDocument, remote: WorkspaceDocument): MergeResult {
  if (base.key !== local.key || base.key !== remote.key) throw new Error('Three-way comparison requires one exact private unit')
  const before = comparable(base), left = comparable(local), right = comparable(remote)
  // Reading and authenticating streamed bytes belongs to captured-graph preparation, never a synchronous JSON comparison
  if (before === undefined || left === undefined || right === undefined) return { kind: 'conflict' }
  if (left === right || right === before) return { kind: 'merged', document: local }
  if (left === before) return { kind: 'merged', document: remote }
  if (base.kind === 'directory' && local.kind === 'directory' && remote.kind === 'directory') {
    const b = directorySchema.safeParse(base.value), l = directorySchema.safeParse(local.value), r = directorySchema.safeParse(remote.value)
    if (b.success && l.success && r.success && b.data.shard === l.data.shard && b.data.shard === r.data.shard) {
      try { return { kind: 'merged', document: { ...local, value: { ...l.data, entries: mergeDirectory(b.data.entries, l.data.entries, r.data.entries).map(entry => ({ key: entry.key, documentId: entry.documentId })) } } } }
      catch { return { kind: 'conflict' } }
    }
  }
  // Inventory events, immutable checkpoints, file drafts and lineage records never acquire a fieldwise merge policy
  return { kind: 'conflict' }
}
