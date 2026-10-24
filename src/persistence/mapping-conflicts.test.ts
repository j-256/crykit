import { expect, it, vi } from 'vitest'
import { appendFileSync } from 'node:fs'
import { conflictService } from './sync-conflict-fixture'
import { inspectWorkspaceClosure } from '../workspace/closure'
import { resolveConflict } from '../workspace/conflicts'
import { readRemoteState, readRemoteHeads } from '../account/sync/pull'
import { openRemoteProjection } from '../account/sync/projection'
import { blobIdentity, readBlob } from '../workspace/blobs'
import { directoryShard } from '../workspace/directory'
import { editorClosureFixture } from '../workspace/test-helpers'
it.each(['inspection', 'resolution'] as const)('actualDifferentAllocationsBecomeAClosedMappingConflictInsteadOfBlockingTheWorkspace %s', async scenario => {
  if (process.env.CRYKIT_SYNC_PROOF_TIMINGS) {
    const mappingAdvance = await import('../account/sync/mapping-advance')
    const originalAdvance = mappingAdvance.assertResolvedMappingAdvance
    let boundaryCalls = 0
    vi.spyOn(mappingAdvance, 'assertResolvedMappingAdvance').mockImplementation(async (...args) => {
      const call = ++boundaryCalls, started = Date.now()
      try { return await originalAdvance(...args) }
      finally { if (process.env.CRYKIT_SYNC_PROOF_TIMINGS) appendFileSync(process.env.CRYKIT_SYNC_PROOF_TIMINGS, `${JSON.stringify({ phase: 'mapping-boundary', call, elapsedMs: Date.now() - started, document: args[2].units.get(args[3].key)?.ref.documentId })}\n`) }
    })
    const projectionModule = await import('../account/sync/projection')
    const originalProjection = projectionModule.openRemoteProjection
    let projectionCalls = 0, activeProjection = 0
    const reads = new Map<number, { calls: number; elapsedMs: number; refs: Map<string, number> }>()
    const evidenceModule = await import('../workspace/account-evidence')
    const originalReader = evidenceModule.capturedRecordReader
    vi.spyOn(evidenceModule, 'capturedRecordReader').mockImplementation((...args) => {
      const read = originalReader(...args), owner = activeProjection
      return async ref => {
        const started = Date.now()
        try { return await read(ref) }
        finally {
          if (owner && activeProjection === owner) {
            const stats = reads.get(owner) ?? { calls: 0, elapsedMs: 0, refs: new Map() }
            stats.calls++; stats.elapsedMs += Date.now() - started
            const key = JSON.stringify(ref); stats.refs.set(key, (stats.refs.get(key) ?? 0) + 1); reads.set(owner, stats)
          }
        }
      }
    })
    vi.spyOn(projectionModule, 'openRemoteProjection').mockImplementation(async (...args) => {
      const call = ++projectionCalls, started = Date.now(), previous = activeProjection
      activeProjection = call
      try { return await originalProjection(...args) }
      finally { activeProjection = previous; const stats = reads.get(call); if (process.env.CRYKIT_SYNC_PROOF_TIMINGS) appendFileSync(process.env.CRYKIT_SYNC_PROOF_TIMINGS, `${JSON.stringify({ phase: 'projection', call, elapsedMs: Date.now() - started, heads: args[2].size, reads: stats && { calls: stats.calls, elapsedMs: stats.elapsedMs, distinct: stats.refs.size, maxRepeated: Math.max(...stats.refs.values()) } })}\n`) }
    })
    const closureModule = await import('../workspace/closure')
    const originalInspect = closureModule.inspectWorkspaceClosure, originalRetention = closureModule.validatedWorkspaceRetentionEdges
    vi.spyOn(closureModule, 'inspectWorkspaceClosure').mockImplementation(async (...args) => {
      const started = Date.now()
      try { return await originalInspect(...args) }
      finally { if (process.env.CRYKIT_SYNC_PROOF_TIMINGS) appendFileSync(process.env.CRYKIT_SYNC_PROOF_TIMINGS, `${JSON.stringify({ phase: 'independent-closure', elapsedMs: Date.now() - started, projectionCall: projectionCalls, closure: args[1] })}\n`) }
    })
    vi.spyOn(closureModule, 'validatedWorkspaceRetentionEdges').mockImplementation(async (...args) => {
      const started = Date.now()
      try { return await originalRetention(...args) }
      finally { if (process.env.CRYKIT_SYNC_PROOF_TIMINGS) appendFileSync(process.env.CRYKIT_SYNC_PROOF_TIMINGS, `${JSON.stringify({ phase: 'retention-pass', elapsedMs: Date.now() - started, projectionCall: projectionCalls })}\n`) }
    })
  }
  const service = await conflictService()
  try {
    const fixture = await editorClosureFixture()
    const key = JSON.stringify(['editor', fixture.file.id]), shardNumber = await directoryShard(key)
    const sameShardId = async (prefix: string) => {
      for (let index = 0; ; index++) if (await directoryShard(JSON.stringify(['editor', `${prefix}-${index}`])) === shardNumber) return `${prefix}-${index}` as typeof fixture.file.id
    }
    const baselineBytes = await fixture.add(new Uint8Array([1, 2]), 'baseline-bytes', 'utf16le')
    const baselineFile = { ...fixture.file, id: await sameShardId('baseline'), filename: 'Unrelated baseline.json', original: baselineBytes, lastApplied: baselineBytes, unfinished: { ...fixture.file.unfinished, text: baselineBytes } }
    const initial = { ...fixture.state, editorDocuments: [baselineFile], retainedContent: [], blobs: fixture.blobs.filter(blob => blob.ref.documentId === 'baseline-bytes') }
    let a = await service.device(0, initial); expect((await a.settle()).state).toBe('synced')
    let b = await service.device(1); expect((await b.settle()).state).toBe('synced')
    const add = async (device: typeof a, filename: string) => {
      const state = await (await device.open()).readWorkspace()
      await (await device.open()).commitWorkspace({ ...state, blobs: [...state.blobs, ...fixture.blobs.filter(blob => blob.ref.documentId === 'text')], editorDocuments: [...state.editorDocuments, { ...fixture.file, filename }] }, state.planner.localData.revision)
    }
    await add(b, 'Pending allocation.json')
    a = await service.device(0); await add(a, 'Accepted allocation.json'); expect((await a.settle()).state).toBe('synced')
    b = await service.device(1); expect((await b.settle()).state).toBe('conflict')
    expect((await (await b.open()).readWorkspace()).conflicts[0].unit.kind).toBe('directory-mapping')
    const pending = await (await b.open()).readWorkspace()
    await (await b.open()).commitWorkspace({ ...pending, editorDocuments: [...pending.editorDocuments, { ...fixture.file, id: await sameShardId('later'), filename: 'Unrelated later.json' }] }, pending.planner.localData.revision)
    expect((await b.settle()).state).toBe('conflict')
    const third = await service.device(2); expect((await third.settle()).state).toBe('conflict')
    const state = await (await third.open()).readWorkspace(), conflict = state.conflicts[0]
    const originals = []
    for (const [index, branch] of conflict.branches.entries()) {
      const closed = await inspectWorkspaceClosure(state, branch.closure)
      expect(closed.mapping?.privateKey).toBe(conflict.unit.privateKey)
      expect((closed.value as { filename: string }).filename).toBe(index ? 'Accepted allocation.json' : 'Pending allocation.json')
      originals.push(...await Promise.all(state.blobs.filter(blob => closed.refs.has(blobIdentity(blob.ref))).map(async blob => ({ ref: blob.ref, bytes: await readBlob(blob.content, blob.ref.byteLength) }))))
    }
    const snapshot = (await readRemoteState(third.db, third.token))!.value
    const projection = (await openRemoteProjection(third.db, third.token, await readRemoteHeads(third.db, third.token, snapshot.heads), (await third.native()).head, state.planner.localData.revision))!
    const authority = projection.units.get(JSON.stringify(['conflict', conflict.id]))!.conflictAuthority!
    const loser = authority.branches[0].publication.ref, shard = await directoryShard(conflict.unit.privateKey)
    expect(service.commits.some(command => !command.heads.length && command.revisions.some(revision => revision.revisionId === loser.revisionId))).toBe(true)
    expect(service.commits.some(command => command.heads.some(head => head.revisionId === loser.revisionId))).toBe(false)
    expect(projection.directories.get(shard)!.allocations.some(entry => entry.key === conflict.unit.privateKey)).toBe(false)
    if (scenario === 'inspection') return
    const { assertUnchangedMappingContinuation } = await import('../account/sync/mapping-continuation')
    const { stagePublicationDirectory } = await import('../account/sync/publication')
    const { accountLocalId } = await import('../workspace/account-cache')
    const captured = authority.branches[1].publication, directory = projection.directories.get(shard)!
    await expect(assertUnchangedMappingContinuation(third.db, third.token, { ...projection, control: { ...projection.control, revisionId: accountLocalId() } }, captured)).rejects.toThrow('STALE_CONFLICT_CHOICE')
    const wrong = await stagePublicationDirectory(third.db, third.token, projection.lineageId, shard, [{ key, documentId: accountLocalId() }], directory.ref)
    const reverted = await stagePublicationDirectory(third.db, third.token, projection.lineageId, shard, [{ key, documentId: captured.mapping!.record!.ref.documentId }], wrong)
    await expect(assertUnchangedMappingContinuation(third.db, third.token, { ...projection, directories: new Map([...projection.directories, [shard, { ...directory, ref: reverted }]]) }, captured)).rejects.toThrow('STALE_CONFLICT_CHOICE')
    const foreign = await stagePublicationDirectory(third.db, third.token, accountLocalId(), shard, [], directory.ref)
    await expect(assertUnchangedMappingContinuation(third.db, third.token, { ...projection, directories: new Map([...projection.directories, [shard, { ...directory, ref: foreign }]]) }, captured)).rejects.toThrow('STALE_CONFLICT_CHOICE')
    await resolveConflict(third.token, conflict.id, 'this', state.planner.localData.revision)
    expect((await third.settle()).state).toBe('synced')
    const resolved = await (await third.open()).readWorkspace()
    expect(resolved.editorDocuments.map(file => file.filename).sort()).toEqual(['Pending allocation.json', 'Unrelated baseline.json', 'Unrelated later.json'])
    const envelope = service.commits.flatMap(command => command.revisions).find(revision => revision.documentId === loser.documentId && revision.parents.includes(loser.revisionId) && revision.parents.length === 2)!
    expect(envelope.parents).toEqual([loser.revisionId, projection.directories.get(shard)!.ref.revisionId])
    for (const original of originals) expect(await readBlob(resolved.blobs.find(blob => blobIdentity(blob.ref) === blobIdentity(original.ref))!.content, original.ref.byteLength)).toEqual(original.bytes)
    const readProjection = async () => {
      const value = (await readRemoteState(third.db, third.token))!.value
      return (await openRemoteProjection(third.db, third.token, await readRemoteHeads(third.db, third.token, value.heads), (await third.native()).head, (await (await third.open()).readWorkspace()).planner.localData.revision))!
    }
    const mapped = await readProjection(), chosen = authority.branches[0].publication.mapping!.record!
    const selectedEnvelope = (await import('../account/sync/conflict-authority')).readOriginalPublication
    const selected = await selectedEnvelope(third.db, third.token, mapped.units.get(key)!.ref)
    expect(selected.parents).toEqual([chosen.ref.revisionId])
    expect(selected.ref.documentId).toBe(chosen.ref.documentId)
    expect(selected.body).not.toEqual(chosen.body)
    expect(selected.digest).toBe(chosen.digest)
    expect(resolved.conflicts[0].disposition).toEqual({ kind: 'resolved', choice: 'this', result: conflict.branches[0].closure })
    const { assertResolvedMappingAdvance } = await import('../account/sync/mapping-advance')
    const previous = { key, publication: projection.units.get(key)!.ref }
    await assertResolvedMappingAdvance(third.db, third.token, mapped, previous)
    const activationBeforeNegatives = await third.db.profileMeta.get('active')
    for (const changed of [
      { ...mapped, units: new Map([...mapped.units].filter(([unit]) => unit !== JSON.stringify(['conflict', conflict.id]))) },
      { ...mapped, control: { ...mapped.control, revisionId: accountLocalId() } },
      ...[
        { ...resolved.conflicts[0], disposition: { kind: 'unresolved' as const } },
        { ...resolved.conflicts[0], unit: { ...conflict.unit, kind: 'directory-mapping' as const, shard: (shard + 1) % 64 } },
        { ...resolved.conflicts[0], disposition: { kind: 'resolved' as const, choice: 'other' as const, result: conflict.branches[1].closure } },
        { ...resolved.conflicts[0], disposition: { kind: 'resolved' as const, choice: 'this' as const, result: conflict.branches[1].closure } },
      ].map(value => ({ ...mapped, workspace: { ...mapped.workspace, state: { ...mapped.workspace.state, conflicts: [value] } } })),
    ]) await expect(assertResolvedMappingAdvance(third.db, third.token, changed, previous)).rejects.toThrow()
    expect(await third.db.profileMeta.get('active')).toEqual(activationBeforeNegatives)
    const wrongResult = { ...resolved, conflicts: [{ ...resolved.conflicts[0], disposition: { kind: 'resolved' as const, choice: 'this' as const, result: conflict.branches[1].closure } }] }
    await expect((await import('../workspace/closure')).validateWorkspaceClosure(wrongResult)).rejects.toThrow('Mapping result must retain the exact selected original closure')
    const later = await (await third.open()).readWorkspace()
    await (await third.open()).commitWorkspace({ ...later, editorDocuments: later.editorDocuments.map(file => file.id === fixture.file.id ? { ...file, filename: 'Later ordinary edit.json' } : file) }, later.planner.localData.revision)
    expect((await third.settle()).state).toBe('synced')
    await assertResolvedMappingAdvance(third.db, third.token, await readProjection(), previous)
    a = await service.device(0); expect((await a.settle()).state).toBe('synced')
    expect((await (await a.open()).readWorkspace()).editorDocuments.find(file => file.id === fixture.file.id)!.filename).toBe('Later ordinary edit.json')
    expect((await (await a.open()).readWorkspace()).conflicts[0].disposition.kind).toBe('resolved')
  } finally { vi.restoreAllMocks(); await service.dispose() }
}, 150_000)
