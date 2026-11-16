import type { GuestEvidenceRows } from './guest-evidence'
import type { WorkspaceBlobRef } from './file-types'

interface Locator { readonly version: 1; readonly key: string }
export interface StoredEvidenceMember {
  readonly id: string; readonly format?: 'legacy-v1' | 'compact-v2'
  readonly metadata: Locator; readonly blobSubset: Locator; readonly catalogSubset?: Locator
}
interface StoredBody { readonly source: WorkspaceBlobRef; readonly content: Locator }
interface Page { readonly kind: string; readonly entries: readonly unknown[]; readonly children: readonly Locator[] }
interface Root { readonly version: 1 | 2; readonly kind: string; readonly members: Locator; readonly blobs: Locator; readonly catalogBodies?: Locator; readonly pages: Locator }
interface Extension { readonly inheritedEvidence: Locator; readonly plannerEvidence: Locator }
interface Row { readonly table: string; readonly key: IDBValidKey; readonly encoded?: string }
export interface EvidenceRowWriter { put(table: string, row: unknown): Promise<unknown> }
const identity = (table: string, key: IDBValidKey) => JSON.stringify([table, key])
const binary = (table: string) => table === 'evidenceSegments' || table === 'evidenceChunks'
function immutableGraphValue<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) immutableGraphValue(child); Object.freeze(value) }
  return value
}

// This records locator provenance, not admission or encrypted storage authority
// Only the strict evidence reader can attach the completed graph to its private captured handle
// Binary rows retain their keys and lazy reader, never a second plaintext payload cache
export function captureStoredEvidenceGraph(input: GuestEvidenceRows) {
  const records = new Map<string, Row>()
  const rows: GuestEvidenceRows = {
    tables: input.tables, keys: table => input.keys(table),
    async get(table, key) {
      const row = await input.get(table, key)
      if (row !== undefined) records.set(identity(table, key), { table, key: immutableGraphValue(structuredClone(key)), ...(!binary(table) ? { encoded: JSON.stringify(row) } : {}) })
      return row
    },
  }
  return { rows, complete: () => new StoredEvidenceGraph(input, new Map(records)) }
}

// Construction is internal plumbing; possession alone grants no reuse capability
// The caller must obtain this graph from a successful private read registration
export class StoredEvidenceGraph {
  readonly extension: Extension
  readonly root: Root
  readonly members: readonly StoredEvidenceMember[]
  private readonly chunks = new Map<string, Row[]>()
  constructor(private readonly input: GuestEvidenceRows, private readonly records: ReadonlyMap<string, Row>) {
    this.extension = immutableGraphValue(this.json<{ value: Extension }>('documents', 'workspaceExtensions').value)
    this.root = immutableGraphValue(this.json<{ value: Root }>('evidenceRoots', this.extension.inheritedEvidence.key).value)
    this.members = immutableGraphValue(this.pageEntries<StoredEvidenceMember>(this.root.members))
    for (const row of records.values()) if (row.table === 'evidenceChunks' && Array.isArray(row.key)) {
      const key = String(row.key[0]), chunks = this.chunks.get(key) ?? []
      chunks.push(row); this.chunks.set(key, chunks)
    }
    for (const chunks of this.chunks.values()) chunks.sort((a, b) => Number((a.key as IDBValidKey[])[1]) - Number((b.key as IDBValidKey[])[1]))
  }
  private json<T>(table: string, key: IDBValidKey): T {
    const row = this.records.get(identity(table, key))
    if (row?.encoded === undefined) throw new Error('Missing admitted evidence graph row')
    return JSON.parse(row.encoded) as T
  }
  pageEntries<T>(root: Locator): readonly T[] {
    const result: T[] = [], pending = [root], seen = new Set<string>()
    while (pending.length) {
      const ref = pending.pop()!
      if (seen.has(ref.key)) throw new Error('Repeated admitted evidence graph page')
      seen.add(ref.key)
      const page = this.json<{ value: Page }>('evidencePages', ref.key).value
      result.push(...page.entries as readonly T[]); pending.push(...[...page.children].reverse())
    }
    return result
  }
  private children(row: Row): readonly { table: string; key: IDBValidKey }[] {
    const refs = (table: string, values: readonly Locator[]) => values.map(ref => ({ table, key: ref.key }))
    if (row.table === 'evidenceRoots') {
      const root = this.json<{ value: Root }>(row.table, row.key).value
      return refs('evidencePages', root.kind === 'evidence-metadata-stream' ? [root.pages] : [root.members, root.blobs, ...(root.catalogBodies ? [root.catalogBodies] : [])])
    }
    if (row.table === 'evidencePages') {
      const page = this.json<{ value: Page }>(row.table, row.key).value
      const children = [...refs('evidencePages', page.children)]
      if (page.kind === 'evidence-metadata-page') children.push(...refs('evidenceSegments', (page.entries as readonly { content: Locator }[]).map(entry => entry.content)))
      else if (page.kind === 'evidence-member-page' || page.kind === 'evidence-catalog-member-page') for (const entry of page.entries as readonly StoredEvidenceMember[]) {
        children.push(...refs('evidenceRoots', [entry.metadata]), ...refs('evidencePages', [entry.blobSubset, ...(entry.catalogSubset ? [entry.catalogSubset] : [])]))
      }
      else if (page.kind === 'evidence-blob-page' || page.kind === 'evidence-catalog-body-page') children.push(...refs('evidenceBlobs', (page.entries as readonly StoredBody[]).map(entry => entry.content)))
      // Member subset edges name bodies in the independent registry and do not own their rows
      return children
    }
    if (row.table === 'plannerEvidence') return refs('evidenceRoots', [this.json<{ stream: Locator }>(row.table, row.key).stream])
    if (row.table === 'evidenceBlobs') return (this.chunks.get(String(row.key)) ?? []).map(part => ({ table: part.table, key: part.key }))
    return []
  }
  async emit(writer: EvidenceRowWriter, table: string, key: IDBValidKey, emitted: Set<string>, check: () => Promise<void>): Promise<void> {
    const id = identity(table, key)
    if (emitted.has(id)) return
    const row = this.records.get(id)
    if (!row) throw new Error('Missing admitted evidence graph row')
    await check()
    const current = await this.input.get(table, row.key)
    if (current === undefined || row.encoded !== undefined && JSON.stringify(current) !== row.encoded) throw new Error('Admitted evidence graph row changed')
    await check()
    for (const child of this.children(row)) await this.emit(writer, child.table, child.key, emitted, check)
    await writer.put(table, current)
    emitted.add(id)
    await check()
  }
}
