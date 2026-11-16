import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { admitLocalRoot, type LocalRecordRef, type AdmittedLocalSnapshot } from '../../src/workspace/local-root'
import { memoryBlob } from '../../src/workspace/blobs'
import { decodeWorkspaceDocument } from '../../src/workspace/document-codec'
import { exactStarterValue } from './signin-matched-starter-core'

export const MAX_STARTER_GRAPH_RECORDS = 256
export const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
export const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
export interface StarterRecord extends LocalRecordRef { operationId: string; ready: boolean; byteLength: number; chunks: number; sha256: string; dependencies: LocalRecordRef[] }
export interface StarterGraph {
  manifest: { version: number; id: string; revision: number; root: LocalRecordRef; recoveryId?: string }
  records: StarterRecord[]
  chunks: { revisionId: string; index: number; bytes: number[] }[]
  operations: unknown[]
  extraCounts: Record<string, number>
}
export interface StarterReference {
  manifest: StarterGraph['manifest']; root: AdmittedLocalSnapshot['root']; entries: AdmittedLocalSnapshot['entries']; destinationChanges: AdmittedLocalSnapshot['destinationChanges']
  state: Omit<AdmittedLocalSnapshot['state'], 'blobs'>; bodyRefs: unknown[]
  rows: Record<string, { rows: unknown[] }>
}
const identity = (ref: LocalRecordRef) => JSON.stringify([ref.documentId, ref.revisionId])
function authenticatedGraph(graph: StarterGraph) {
  const records = new Map<string, StarterRecord>(), bodies = new Map<string, Uint8Array>()
  assert(graph.records.length > 0 && graph.records.length <= MAX_STARTER_GRAPH_RECORDS, 'Unexpected starter graph size')
  for (const row of graph.records) {
    assert(!records.has(identity(row)) && row.ready && row.operationId, 'Duplicate or uninstalled starter record')
    const chunks = graph.chunks.filter(chunk => chunk.revisionId === row.revisionId).sort((a, b) => a.index - b.index)
    assert.equal(chunks.length, row.chunks, 'Missing starter chunk')
    chunks.forEach((chunk, index) => assert(chunk.index === index && chunk.bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255), 'Invalid starter chunk association'))
    const bytes = Buffer.concat(chunks.map(chunk => Buffer.from(chunk.bytes)))
    assert.equal(bytes.length, row.byteLength, 'Starter byte length changed'); assert.equal(digest(bytes), row.sha256, 'Starter bytes changed')
    records.set(identity(row), row); bodies.set(identity(row), bytes)
  }
  assert.equal(graph.chunks.length, graph.records.reduce((count, row) => count + row.chunks, 0), 'Foreign starter chunks')
  const reached = new Set<string>()
  const walk = (ref: LocalRecordRef) => {
    const key = identity(ref), row = records.get(key)
    assert(row, 'Missing starter reference')
    if (reached.has(key)) return
    reached.add(key); row.dependencies.forEach(walk)
  }
  walk(graph.manifest.root)
  return { records, bodies, reached, read: async (ref: LocalRecordRef) => {
    const bytes = bodies.get(identity(ref)); assert(bytes, 'Missing starter body')
    // Native readers may clear delivered chunks; Node Buffer.slice would alias the retained observation
    return memoryBlob(Uint8Array.from(bytes))
  } }
}
export async function admitStarterGraph(graph: StarterGraph) {
  const physical = authenticatedGraph(graph)
  const admitted = await admitLocalRoot({ read: physical.read, async stage() { throw new Error('Read-only starter oracle') } }, graph.manifest.root, { check() {}, async assertCurrent() {} })
  return { ...physical, admitted }
}
// Only fresh storage locators may vary; frozen document keys, ordered roles and bytes must not
function roles(root: StarterReference['root'], entries: StarterReference['entries'], records: StarterRecord[], head: LocalRecordRef) {
  const result = new Map<string, string>([[identity(head), 'root']])
  const add = (ref: LocalRecordRef, role: string) => { assert(!result.has(identity(ref)), 'Aliased starter graph role'); result.set(identity(ref), role) }
  for (const field of ['contentIndex', 'allocationIndex', 'bookkeepingIndex', 'operativeChanges', 'destinationChanges', 'historyIndex', 'inheritedEvidence'] as const) add(root[field], field)
  entries.forEach(entry => add(entry.ref, `document:${entry.key}`))
  // Fresh preparation retains an empty journal index as a dependency even with no journal field
  const extra = records.find(row => identity(row) === identity(head))!.dependencies.filter(ref => !result.has(identity(ref)))
  assert.equal(extra.length, 1, 'Initial empty journal index must retain its distinct dependency')
  add(extra[0], 'emptyJournalIndex')
  assert.equal(result.size, records.length, 'Unclassified starter record')
  return result
}
function normalize(value: unknown, mapping: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map(item => normalize(item, mapping))
  if (!value || typeof value !== 'object') return value
  const row = value as Record<string, unknown>, keys = Object.keys(row)
  if (keys.length === 2 && keys.includes('documentId') && keys.includes('revisionId')) { const role = mapping.get(identity(row as unknown as LocalRecordRef)); assert(role, 'Foreign starter ref association'); return { storageRole: role } }
  if (keys.length === 2 && keys.includes('key') && keys.includes('documentId')) {
    const matches = [...mapping.keys()].map(key => JSON.parse(key)).filter(ref => ref[0] === row.documentId)
    assert.equal(matches.length, 1, 'Unknown allocated starter document')
    return { key: row.key, storageRole: mapping.get(JSON.stringify(matches[0])) }
  }
  return Object.fromEntries(keys.map(key => [key, normalize(row[key], mapping)]))
}
export async function proveStarterInitialization(graph: StarterGraph, reference: StarterReference) {
  const actual = await admitStarterGraph(graph), { admitted } = actual
  assert(exactStarterValue({ ...admitted.state, blobs: admitted.state.blobs.map(body => body.ref) }, { ...reference.state, blobs: reference.bodyRefs }), 'Complete pre-edit source changed')
  assert(exactStarterValue(admitted.destinationChanges, reference.destinationChanges), 'Operative destination changes changed')
  assert.equal(graph.manifest.version, 3); assert.equal(graph.manifest.revision, 0); assert.equal(graph.manifest.recoveryId, undefined)
  assert.equal(actual.reached.size, graph.records.length, 'Unreachable initial records')
  assert(Object.values(graph.extraCounts).every(count => count === 0), 'Unexpected initial recovery or migration data')
  assert.deepEqual(graph.operations, [{ version: 1, id: graph.manifest.id, kind: 'managed-local-commit', target: graph.manifest }])
  assert(graph.records.every(row => row.operationId === graph.manifest.id), 'Foreign initial operation')
  const expectedRecords = reference.rows.managedRecords.rows as StarterRecord[]
  const expectedRoles = roles(reference.root, reference.entries, expectedRecords, reference.manifest.root), actualRoles = roles(admitted.root, admitted.entries, graph.records, graph.manifest.root)
  const root = (value: StarterReference['root']) => { const { lineageId: _freshStorageIdentity, ...rest } = value; return rest }
  assert.deepEqual(normalize(root(admitted.root), actualRoles), normalize(root(reference.root), expectedRoles))
  assert.deepEqual(normalize(admitted.entries, actualRoles), normalize(reference.entries, expectedRoles))
  const expectedPages: Record<string, unknown> = {
    contentIndex: { version: 1, entries: reference.entries, children: [] },
    allocationIndex: { version: 1, entries: reference.entries.map(entry => ({ key: entry.key, documentId: entry.ref.documentId })), children: [] },
    bookkeepingIndex: { version: 1, entries: Object.entries(reference.state.planner.localData.playthroughs).map(([id, value]) => ({ id, revision: value.revision, updatedAt: value.updatedAt })), children: [] },
    ...Object.fromEntries(['operativeChanges', 'destinationChanges', 'historyIndex', 'emptyJournalIndex'].map(role => [role, { version: 1, entries: [], children: [] }])),
    inheritedEvidence: { version: 1, kind: 'local-inherited-evidence', roots: [] },
  }
  const shape = []
  for (const expected of expectedRecords) {
    const role = expectedRoles.get(identity(expected))!, key = [...actualRoles].find(([, value]) => value === role)![0], row = actual.records.get(key)!
    assert.equal(row.byteLength, expected.byteLength, 'Initial physical record length changed'); assert.equal(row.chunks, expected.chunks)
    const dependencies = normalize(row.dependencies, actualRoles)
    assert.deepEqual(dependencies, normalize(expected.dependencies, expectedRoles), 'Initial dependency roles changed')
    if (role.startsWith('document:')) assert.equal(row.sha256, expected.sha256, 'Initial native document bytes changed')
    else if (role !== 'root') assert.deepEqual(normalize(JSON.parse(new TextDecoder().decode(actual.bodies.get(key)!)), actualRoles), normalize(expectedPages[role], expectedRoles), 'Initial index contents changed')
    shape.push({ role, byteLength: row.byteLength, chunks: row.chunks, dependencies })
  }
  return { admitted, sourceStateSha256: digest(canonical({ ...reference.state, blobs: reference.bodyRefs })), operativeSha256: digest(canonical(admitted.destinationChanges)), topologySha256: digest(canonical(shape.sort((a, b) => a.role.localeCompare(b.role)))), recordCount: graph.records.length }
}
export async function proveOrdinaryStarterEdit(before: StarterGraph, after: StarterGraph, reference: StarterReference) {
  const initial = await proveStarterInitialization(before, reference), next = await admitStarterGraph(after)
  assert.equal(after.manifest.version, 3); assert.equal(after.manifest.revision, 1); assert.equal(after.manifest.recoveryId, undefined)
  const history = next.admitted.state.planner.history
  assert.equal(history.length, 1, 'Expected exactly one genuine Progress save')
  assert.deepEqual(history[0].before, initial.admitted.state.planner.localData)
  assert.deepEqual(history[0].after, next.admitted.state.planner.localData)
  assert.equal(next.admitted.root.lineageId, initial.admitted.root.lineageId)
  const page = JSON.parse(new TextDecoder().decode(next.bodies.get(identity(next.admitted.root.historyIndex))!))
  assert.deepEqual(page.children, []); assert.equal(page.entries.length, 1); assert.equal(page.entries[0].id, history[0].id)
  const frame = await decodeWorkspaceDocument(await next.read(page.entries[0].ref))
  const transition = frame.value as unknown as { kind: string; before: Record<string, unknown>; after: Record<string, unknown> }
  assert.equal(frame.kind, 'history'); assert.equal(transition.kind, 'local-history-transition', 'History was restaged instead of saved against its predecessor')
  for (const [endpoint, root] of [[transition.before, initial.admitted.root], [transition.after, next.admitted.root]] as const) {
    for (const field of ['contentIndex', 'bookkeepingIndex', 'operativeChanges', 'localRevision', 'localUpdatedAt', 'selections'] as const) assert(exactStarterValue(endpoint[field], root[field]), 'History endpoint changed')
  }
  assert(next.admitted.destinationChanges.length > 0, 'Ordinary edit lacks operative changes')
  return { history, destinationChanges: next.admitted.destinationChanges, transition, root: next.admitted.root, manifest: after.manifest, transitionCount: 1 }
}
