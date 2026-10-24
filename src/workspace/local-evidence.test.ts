import { expect, it } from 'vitest'
import { editorClosureFixture } from './test-helpers'
import { ownWorkspaceSnapshot } from './snapshot'
import { guestEvidenceFromFrozenCurrent, compareGuestEvidence, guestEvidenceSources, mergeGuestEvidence, emptyPlannerEvidence } from './guest-evidence'
import { prepareLocalEvidence, readLocalEvidence } from './local-evidence'
import { memoryBlob, readBlob, blobIdentity } from './blobs'
import type { LocalStoreAdapter } from './local-root'

it('retains exact native evidence metadata and invalid original bytes through managed storage', async () => {
  const fixture = await editorClosureFixture()
  const snapshot = ownWorkspaceSnapshot({ version: 1, snapshotId: crypto.randomUUID(), capturedAt: new Date().toISOString(), revisionVector: {}, state: fixture.state }, { check: async () => {}, dispose: async () => {} })
  const original = await guestEvidenceFromFrozenCurrent(snapshot)
  const evidence = await mergeGuestEvidence(original, original, emptyPlannerEvidence())
  const rows = new Map<string, Uint8Array>()
  const adapter: LocalStoreAdapter = {
    async stage(_operation, source) { const ref = { documentId: crypto.randomUUID(), revisionId: crypto.randomUUID() }; rows.set(blobIdentity(ref), await readBlob(source, 512 * 1024 * 1024)); return ref },
    async read(ref) { const bytes = rows.get(blobIdentity(ref)); if (!bytes) throw new Error('Missing synthetic record'); return memoryBlob(bytes) },
  }
  const root = await prepareLocalEvidence(adapter, 'evidence', evidence)
  const reopened = await readLocalEvidence(adapter, root, async () => {})
  expect(reopened).toBeDefined()
  await compareGuestEvidence(evidence, reopened!)
  const originals = guestEvidenceSources(evidence).bodies, actual = guestEvidenceSources(reopened!).bodies
  expect(actual.map(body => body.ref)).toEqual(originals.map(body => body.ref))
  for (let index = 0; index < originals.length; index++) expect(await readBlob(actual[index].content, 512 * 1024 * 1024)).toEqual(await readBlob(originals[index].content, 512 * 1024 * 1024))
  const stored = [...rows].find(([, bytes]) => bytes.length === 2 && bytes[0] === 0 && bytes[1] === 216)!
  rows.set(stored[0], new Uint8Array([0, 217]))
  await expect(readLocalEvidence(adapter, root, async () => {})).rejects.toThrow()
})
