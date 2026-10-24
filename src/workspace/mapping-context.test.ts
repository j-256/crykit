import { expect, it } from 'vitest'
import { editorClosureFixture } from './test-helpers'
import { accountLocalId } from './account-cache'
import { archiveMappingEvidence } from './mapping-closure'
import { inspectWorkspaceClosure } from './closure'
import { blobIdentity, hashBlob, memoryBlob } from './blobs'
import { directoryShard, DIRECTORY_SHARDS } from './directory'
import type { OriginalPublication } from './conflict-authority'
import type { PublicationBaselineEntry } from '../account/sync/publication'

it.each(['valid', 'old-raw', 'false-absence', 'wrong-shard', 'wrong-lineage', 'wrong-selection', 'missing-page', 'duplicate-frame', 'cyclic-page', 'foreign-frame', 'control-digest', 'duplicate-baseline', 'foreign-control-ref'] as const)('independentlyRehashedMappingSourceFrames %s', async mutation => {
  const fixture = await editorClosureFixture(), ref = () => ({ documentId: accountLocalId(), revisionId: accountLocalId() })
  const key = '["editor","editor-1"]', shard = await directoryShard(key), lineageId = accountLocalId()
  const directoryRef = ref(), directoryIndex = ref(), controlRef = ref(), baselineRef = ref()
  const baseline: PublicationBaselineEntry[] = Array.from({ length: DIRECTORY_SHARDS }, (_, index) => ({ kind: 'directory', shard: index, seed: index === shard ? directoryRef : ref(), replacedHead: null }))
  if (mutation === 'false-absence') baseline.push({ kind: 'mutable', key, seed: ref(), replacedHead: null })
  if (mutation === 'duplicate-baseline') baseline.push(baseline[0])
  const source = (value: unknown) => memoryBlob(new TextEncoder().encode(JSON.stringify(value)))
  const directory = source({ version: 1, kind: 'publication-directory', lineageId, shard: mutation === 'wrong-shard' ? (shard + 1) % DIRECTORY_SHARDS : shard, index: directoryIndex })
  const control = source({ version: 1, kind: 'workspace-control', lineageId: mutation === 'wrong-lineage' ? accountLocalId() : lineageId, baseline: baselineRef })
  const publication: OriginalPublication = { version: 1, ref: directoryRef, body: directoryIndex, privateKey: key, valueKind: 'directory-mapping-unit', lineageId, digest: await hashBlob(directory), parents: [], mapping: { shard, index: directoryIndex, ...(mutation === 'old-raw' ? {} : { context: { kind: 'control-baseline' as const, control: { ref: mutation === 'foreign-control-ref' ? ref() : controlRef, digest: mutation === 'control-digest' ? '0'.repeat(64) : await hashBlob(control), parents: [] }, directoryPhysicalHead: mutation === 'wrong-selection' ? accountLocalId() : null } }) } }
  const frames = [{ source: directoryRef, content: directory }, { source: directoryIndex, content: source({ version: 1, kind: 'publication-directory-page', entries: [], children: [] }) }, ...(mutation === 'old-raw' ? [] : [{ source: controlRef, content: control }, { source: baselineRef, content: source({ version: 1, kind: 'publication-baseline-page', entries: baseline, children: mutation === 'cyclic-page' ? [baselineRef] : [] }) }])]
  if (mutation === 'missing-page') frames.pop()
  if (mutation === 'duplicate-frame') frames.push(frames[0])
  if (mutation === 'foreign-frame') frames.push({ source: ref(), content: source({ inert: true }) })
  const blobs = new Map<string, typeof fixture.blobs[number]>()
  const closure = await archiveMappingEvidence(publication, frames, undefined, blobs)
  const state = { ...fixture.state, retainedContent: [], blobs: [...blobs.values()] }
  const result = inspectWorkspaceClosure(state, closure)
  if (mutation === 'valid' || mutation === 'old-raw') {
    const inspected = await result
    expect(inspected.value).toEqual({ allocation: 'absent' })
    // Sibling seed identities are inert metadata, never recursively archived semantic bodies
    for (const entry of baseline.filter(entry => entry.seed.documentId !== directoryRef.documentId)) expect(inspected.refs.has(blobIdentity(entry.seed))).toBe(false)
  } else await expect(result).rejects.toThrow()
})
