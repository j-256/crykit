import 'fake-indexeddb/auto'
import { afterEach, expect, it } from 'vitest'
import { AccountDatabase } from './account-database'
import { installProfile, invalidateProfile } from '../account/profile'
import { accountLocalId } from '../workspace/account-cache'
import { prepareAccountWorkspace } from '../workspace/account-graph'
import { createPersonalDefinition, revisePersonalDefinition } from '../domain/local-data'
import { createTestLocalData } from '../domain/test-helpers'
import { editorClosureFixture } from '../workspace/test-helpers'
import { personalLineageChains } from '../account/sync/lineage'
import { stagePersonalLineage } from '../account/sync/lineage-publication'
import { readOriginalPublication } from '../account/sync/conflict-authority'
import { inspectWorkspaceClosure } from '../workspace/closure'
import { archivePersonalLineage } from '../workspace/lineage-closure'
import type { PersonalDefinitionId } from '../domain/types'
let database: AccountDatabase | undefined
afterEach(async () => { invalidateProfile(); await database?.delete() })
it('lineageArchiveIndependentlyBindsCanonicalRootSelectedChainAndActualAnchor', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const fixture = await editorClosureFixture()
  const initial = createPersonalDefinition(createTestLocalData(), { id: 'root' as PersonalDefinitionId, kind: 'item', name: 'Root' })
  const data = revisePersonalDefinition(initial, { sourceRef: { kind: 'personal', definitionId: 'root' as PersonalDefinitionId }, name: 'Selected successor' }).localData
  const state = { ...fixture.state, retainedContent: [], blobs: [], planner: { ...fixture.state.planner, localData: data, lineage: { rootLocalDataId: data.id } } }
  const prepared = await prepareAccountWorkspace(database, token, state)
  await database.encryptedRevisions.bulkAdd(prepared.records)
  const key = [...personalLineageChains(data).keys()][0]
  const anchor = await stagePersonalLineage(database, token, prepared.opened, key, accountLocalId())
  const publication = await readOriginalPublication(database, token, anchor.ref)
  const blobs = new Map()
  const closure = await archivePersonalLineage(prepared.opened, key, blobs, publication)
  const inspected = await inspectWorkspaceClosure({ ...state, blobs: [...blobs.values()] }, closure)
  expect(inspected.lineage?.privateKey).toBe(key)
  expect(inspected.publication).toEqual(publication)
  const { PersonalLineageRelationSchema } = await import('../workspace/lineage-closure')
  expect(PersonalLineageRelationSchema.safeParse({ ...inspected.lineage, supersedes: { kind: 'conflict-successor', conflictId: 'new', priorId: 'old', prior: publication, unit: { kind: 'record', privateKey: key } } }).success).toBe(true)
  expect(inspected.documents.get(JSON.stringify(['personal-definition', 'root']))!.value).toEqual(initial.personalDefinitions.root)
  await expect(archivePersonalLineage(prepared.opened, key, blobs, { ...publication, privateKey: 'wrong-root' })).rejects.toThrow()
  await expect(archivePersonalLineage(prepared.opened, key, blobs, { ...publication, body: { ...publication.body, revisionId: accountLocalId() } })).rejects.toThrow()
  const priorId = 'prior', priorDocument = accountLocalId()
  const prior = { version: 1 as const, ref: { documentId: priorDocument, revisionId: accountLocalId() }, body: { documentId: priorDocument, revisionId: accountLocalId() }, lineageId: publication.lineageId, privateKey: JSON.stringify(['conflict', priorId]), valueKind: 'conflict', digest: '0'.repeat(64), parents: [] }
  const supersedes = { kind: 'conflict-successor' as const, conflictId: 'next', priorId, prior, unit: { kind: 'record' as const, privateKey: key } }
  const relation = { ...inspected.lineage!, supersedes }
  const { validatePersonalLineage } = await import('../workspace/lineage-closure')
  await validatePersonalLineage(relation, inspected)
  for (const changed of [
    { ...relation, supersedes: { ...supersedes, conflictId: priorId } },
    { ...relation, supersedes: { ...supersedes, unit: { kind: 'record' as const, privateKey: 'foreign' } } },
    { ...relation, supersedes: { ...supersedes, prior: { ...prior, privateKey: 'foreign' } } },
    { ...relation, rootRef: { kind: 'personal' as const, definitionId: 'foreign' as PersonalDefinitionId } },
    { ...relation, selected: { ...relation.selected, revisionId: 'foreign' } },
    { ...relation, publication: undefined },
  ]) await expect(validatePersonalLineage(changed, inspected)).rejects.toThrow()
  const { captureOriginalLineage } = await import('../account/sync/captured-unit')
  const captured = await captureOriginalLineage(database, token, prepared.opened, publication)
  expect(captured.state.planner.localData.personalDefinitions).toEqual(data.personalDefinitions)
  await expect(captureOriginalLineage(database, token, prepared.opened, { ...publication, digest: '0'.repeat(64) })).rejects.toThrow('INTEGRITY_FAILED')
})
it('personalLineageChoiceCannotRebindASeparateBuildsExactDefinitionPin', async () => {
  const { addTestBuild, HAND_SLOT } = await import('../domain/test-helpers')
  const { selectCapturedBranch } = await import('../account/sync/branch-selection')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const fixture = await editorClosureFixture()
  const base = createPersonalDefinition(createTestLocalData(), { id: 'root' as PersonalDefinitionId, kind: 'item', name: 'Root' })
  const branch = async (name: string, pinned: boolean) => {
    const revised = revisePersonalDefinition(base, { sourceRef: { kind: 'personal', definitionId: 'root' as PersonalDefinitionId }, name })
    const latest = Object.values(revised.localData.personalDefinitions).find(value => value.name === name)!
    const data = pinned ? addTestBuild(revised.localData, 'pinned', 'Pinned', { [HAND_SLOT]: { ref: { kind: 'personal', definitionId: latest.id } } }) : revised.localData
    const prepared = await prepareAccountWorkspace(database!, token, { ...fixture.state, retainedContent: [], blobs: [], planner: { ...fixture.state.planner, localData: data, lineage: { rootLocalDataId: data.id } } })
    await database!.encryptedRevisions.bulkAdd(prepared.records)
    return prepared.opened
  }
  const local = await branch('Pinned accepted definition', true), pending = await branch('Pending definition', false)
  const key = [...personalLineageChains(pending.state.planner.localData).keys()][0]
  const anchor = await stagePersonalLineage(database, token, pending, key, accountLocalId())
  const publication = await readOriginalPublication(database, token, anchor.ref)
  await expect(selectCapturedBranch(local, pending, publication)).rejects.toThrow('CONFLICT_DEPENDENCY_IN_USE')
})
it.each(['legacy', 'standalone', 'catalog', 'stale'] as const)('actualPersonalLineageConflictUsesStableAnchorAndThirdDeviceResolution %s', async scenario => {
  const { conflictService } = await import('./sync-conflict-fixture')
  const { preparePublicationAttempt } = await import('../account/sync/publication')
  const { readRemoteState, readRemoteHeads } = await import('../account/sync/pull')
  const { openRemoteProjection } = await import('../account/sync/projection')
  const { resolveConflict } = await import('../workspace/conflicts')
  const { savedCatalogVersion } = await import('../domain/legacy-definition.test-helpers')
  const { testCatalogRef } = await import('../domain/catalog.test-helpers')
  const { readBlob, blobIdentity } = await import('../workspace/blobs')
  const service = await conflictService()
  try {
    const fixture = await editorClosureFixture(), catalogRef = testCatalogRef('item')
    const catalog: import('../domain/types').CatalogSnapshot = { id: catalogRef.catalogId, revisionId: catalogRef.catalogRevisionId, schemaVersion: 'synthetic', checksum: 'synthetic-checksum', importedAt: '2026-01-01T00:00:00Z' as import('../domain/types').Timestamp, applicability: { state: 'known', value: 'synthetic', sources: [] }, rights: { state: 'known', value: 'synthetic', sources: [] }, entities: { item: { id: catalogRef.entityId, kind: 'item', name: 'Catalog root', aliases: [], fields: {}, sources: [] } }, claims: [] }
    const data = scenario === 'catalog' ? fixture.state.planner.localData : createPersonalDefinition(fixture.state.planner.localData, { id: 'root' as PersonalDefinitionId, kind: 'item', name: 'Root' })
    const initial = { ...fixture.state, retainedContent: [], blobs: [], planner: { ...fixture.state.planner, localData: data, catalogs: scenario === 'catalog' ? [catalog] : [], lineage: { rootLocalDataId: data.id } } }
    let a = await service.device(0, initial)
    if (scenario === 'legacy') {
      const base = await a.native()
      const attempt = await preparePublicationAttempt(a.db, a.token, base, null, new Map(), 0, undefined, 'additive', undefined, { installLineages: false })
      for (const command of [...attempt.registrations, attempt.final]) await a.publish(command)
      const count = service.commits.length
      expect((await a.settle()).state).toBe('synced')
      expect(service.commits.slice(count).some(command => command.heads.length && command.expectedPublicationEpoch !== undefined && command.expected.some(head => attempt.final.heads.some(prior => prior.documentId === head.documentId && prior.revisionId === head.revisionId)))).toBe(true)
    } else expect((await a.settle()).state).toBe('synced')
    let b = await service.device(1); expect((await b.settle()).state).toBe('synced')
    const change = (state: import('../workspace/documents').WorkspaceState, name: string) => ({ ...state, planner: { ...state.planner, localData: (scenario === 'catalog' ? savedCatalogVersion(state.planner.localData, state.planner.catalogs, { sourceRef: catalogRef, name }) : revisePersonalDefinition(state.planner.localData, { sourceRef: { kind: 'personal', definitionId: 'root' as PersonalDefinitionId }, name })).localData } })
    const b0 = await (await b.open()).readWorkspace()
    await (await b.open()).commitWorkspace(change(b0, 'Pending successor'), b0.planner.localData.revision)
    if (scenario === 'catalog') {
      const { runSyncIteration } = await import('../account/sync/outbox')
      await b.native()
      expect((await runSyncIteration(b.token, new AbortController().signal)).moreWork).toBe(true)
      expect(await b.db.syncState.get('publication')).toBeDefined()
    }
    a = await service.device(0)
    const a0 = await (await a.open()).readWorkspace()
    await (await a.open()).commitWorkspace(change(a0, 'Accepted successor'), a0.planner.localData.revision)
    expect((await a.settle()).state).toBe('synced')
    b = await service.device(1); expect((await b.settle()).state).toBe('conflict')
    let third = await service.device(2); expect((await third.settle()).state).toBe('conflict')
    let state = await (await third.open()).readWorkspace(), conflict = state.conflicts[0]
    expect(state.conflicts).toHaveLength(1)
    expect(conflict.commonAncestor.kind).toBe(scenario === 'catalog' ? 'absent' : 'present')
    const originals = []
    for (const [index, branch] of conflict.branches.entries()) {
      const closed = await inspectWorkspaceClosure(state, branch.closure)
      expect(closed.lineage?.privateKey).toBe(conflict.unit.privateKey)
      expect((closed.value as { name: string }).name).toBe(index ? 'Accepted successor' : 'Pending successor')
      originals.push(...await Promise.all(state.blobs.filter(blob => closed.refs.has(blobIdentity(blob.ref))).map(async blob => ({ ref: blob.ref, bytes: await readBlob(blob.content, blob.ref.byteLength) }))))
    }
    if (scenario === 'stale') {
      const old = structuredClone(conflict)
      a = await service.device(0); expect((await a.settle()).state).toBe('conflict')
      const acceptedState = await (await a.open()).readWorkspace()
      const selected = Object.values(acceptedState.planner.localData.personalDefinitions).find(value => value.name === 'Accepted successor')!
      const changed = revisePersonalDefinition(acceptedState.planner.localData, { sourceRef: { kind: 'personal', definitionId: selected.id }, name: 'Changed accepted successor' }).localData
      await (await a.open()).commitWorkspace({ ...acceptedState, planner: { ...acceptedState.planner, localData: changed } }, acceptedState.planner.localData.revision)
      expect((await a.settle()).state).toBe('conflict')
      const refreshedDevice = await service.device(2); third = refreshedDevice; expect((await refreshedDevice.settle()).state).toBe('conflict')
      state = await (await refreshedDevice.open()).readWorkspace()
      await expect(resolveConflict(refreshedDevice.token, old.id, 'this', state.planner.localData.revision)).rejects.toThrow('STALE_CONFLICT_CHOICE')
      expect((await refreshedDevice.settle()).state).toBe('conflict')
      state = await (await refreshedDevice.open()).readWorkspace()
      expect(state.conflicts.find(value => value.id === old.id)).toEqual(old)
      conflict = state.conflicts.find(value => value.id !== old.id)!
      expect(conflict).toBeDefined()
      const pending = await inspectWorkspaceClosure(state, conflict.branches[0].closure)
      expect(pending.supersedes?.priorId).toBe(old.id)
      expect((pending.value as { name: string }).name).toBe('Pending successor')
      expect(((await inspectWorkspaceClosure(state, conflict.branches[1].closure)).value as { name: string }).name).toBe('Changed accepted successor')
      await expect((await import('../workspace/closure')).validateWorkspaceClosure({ ...state, conflicts: [conflict] })).rejects.toThrow('Missing or contradictory conflict predecessor')
      const { publishedSupersededConflicts } = await import('../account/sync/conflict-status')
      expect(await publishedSupersededConflicts(third.token, state)).toEqual(new Set([old.id]))
      const { accountMappingRootKey } = await import('../workspace/account-mapping-origin')
      const associationKey = accountMappingRootKey((await third.db.profileMeta.get('active'))!.head)
      const association = (await third.db.syncState.get(associationKey))!
      expect(association).toBeDefined()
      const pendingBeforeHint = await third.db.outbox.toArray()
      await third.db.syncState.delete(associationKey)
      try {
        expect(await publishedSupersededConflicts(third.token, state)).toEqual(new Set())
        expect(await third.db.syncState.get(associationKey)).toBeUndefined()
        expect(await third.db.outbox.toArray()).toEqual(pendingBeforeHint)
      } finally { await third.db.syncState.put(association) }
      expect(await publishedSupersededConflicts(third.token, { ...state, conflicts: [old] })).toEqual(new Set())
      const independent = await service.device(1); expect((await independent.settle()).state).toBe('conflict')
      const closedState = await (await independent.open()).readWorkspace()
      expect(closedState.conflicts.find(value => value.id === old.id)).toEqual(old)
      expect(await publishedSupersededConflicts(independent.token, closedState)).toEqual(new Set([old.id]))
      expect(((await inspectWorkspaceClosure(closedState, conflict.branches[0].closure)).value as { name: string }).name).toBe('Pending successor')
      third = await service.device(2)
      state = await (await third.open()).readWorkspace()
    }
    const snapshot = (await readRemoteState(third.db, third.token))!.value
    const projection = (await openRemoteProjection(third.db, third.token, await readRemoteHeads(third.db, third.token, snapshot.heads), (await third.native()).head, state.planner.localData.revision))!
    const authority = projection.units.get(JSON.stringify(['conflict', conflict.id]))!.conflictAuthority!
    const [loser, accepted] = authority.branches.map(branch => branch.publication.ref)
    expect(loser.documentId).toBe(accepted.documentId)
    if (scenario === 'catalog') {
      const original = authority.branches[0].publication.lineage!.reallocatedFrom!
      expect(original.documentId).not.toBe(loser.documentId)
      expect((await third.db.encryptedRevisions.get(loser.revisionId))!.descriptor.dependencies).toContainEqual(original)
    }
    expect(service.commits.some(command => !command.heads.length && command.revisions.some(revision => revision.revisionId === loser.revisionId))).toBe(true)
    expect(service.commits.some(command => command.heads.some(head => head.revisionId === loser.revisionId))).toBe(false)
    await expect(resolveConflict(third.token, conflict.id, 'both', state.planner.localData.revision)).rejects.toThrow('CONFLICT_COPY_UNAVAILABLE')
    await resolveConflict(third.token, conflict.id, 'this', state.planner.localData.revision)
    expect((await third.settle()).state).toBe('synced')
    const resolved = await (await third.open()).readWorkspace()
    expect(Object.values(resolved.planner.localData.personalDefinitions).some(value => value.name === 'Pending successor')).toBe(true)
    expect(Object.values(resolved.planner.localData.personalDefinitions).some(value => value.name === 'Accepted successor')).toBe(false)
    const resolvedEnvelope = service.commits.flatMap(command => command.revisions).find(revision => revision.documentId === loser.documentId && revision.parents.includes(loser.revisionId) && revision.parents.length === 2)!
    expect(resolvedEnvelope.parents).toEqual([loser.revisionId, projection.lineages.get(conflict.unit.privateKey)!.ref.revisionId])
    for (const original of originals) expect(await readBlob(resolved.blobs.find(blob => blobIdentity(blob.ref) === blobIdentity(original.ref))!.content, original.ref.byteLength)).toEqual(original.bytes)
    a = await service.device(0); expect((await a.settle()).state).toBe('synced')
    expect((await (await a.open()).readWorkspace()).conflicts.find(value => value.id === conflict.id)!.disposition.kind).toBe('resolved')
  } finally { await service.dispose() }
}, 150_000)
