import { assertActiveProfile, currentProfileToken } from '../../src/account/profile'
import { activateLocalAccountCommit, AccountDatabase } from '../../src/persistence/account-database'
import { accountLocalId } from '../../src/workspace/account-cache'
import { prepareAccountWorkspace } from '../../src/workspace/account-graph'
import { writeDeviceSelection } from '../../src/workspace/device-selection'
import { editorClosureFixture } from '../../src/workspace/test-helpers'

// Only explicit synthetic qualification loads this module, so ordinary Merge fixtures do not warm it
export async function seedSelectedNativeAccount() {
  const token = currentProfileToken()!, database = new AccountDatabase(token.accountId)
  try {
    if (await database.profileMeta.get('active')) throw new Error('Native startup qualification requires fresh storage')
    const fixture = await editorClosureFixture()
    const state = { ...fixture.state, editorDocuments: [fixture.file] }
    const prepared = await prepareAccountWorkspace(database, token, state)
    await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: prepared.head, records: prepared.records })
    // Normal remembered startup must encounter this genuine selected native root itself
    // The fixture admission mount rewrites selection to guest and would bypass that public contract
    await writeDeviceSelection({ key: 'selected', version: 1, kind: 'account', accountId: token.accountId }, () => assertActiveProfile(token))
    return { originals: fixture.blobs.map(body => body.ref) }
  } finally { database.close() }
}

export async function seedQualificationChoices(repository: import('../../src/workspace/repository').WorkspaceRepository, baseline: 'default' | 'retained') {
  const { createPersonalDefinition, createPlaythrough, addGameSetupRevision } = await import('../../src/domain/local-data')
  const { upsertProgress } = await import('../../src/domain/characters')
  const { prepareModComposition, composeModCatalog, expandModCatalogs } = await import('../../src/domain/mod-layers')
  const { DEFAULT_CATALOG } = await import('../../src/catalog/bundled')
  const { SYNTHETIC_RETAINED_CATALOG } = await import('../../src/domain/retained-catalog.test-helpers')
  if (baseline !== 'default' && baseline !== 'retained') throw new Error('Qualification requires an explicit bundled or synthetic retained baseline')
  const catalog = baseline === 'default' ? DEFAULT_CATALOG : SYNTHETIC_RETAINED_CATALOG
  const before = await repository.readWorkspace()
  const imported = before.planner.catalogs.find(catalog => catalog.schemaVersion === 'crystal-edit-json-1')
  if (!imported) throw new Error('Qualification requires the actual imported source')
  let localData = createPersonalDefinition(before.planner.localData, { id: 'subject' as never, kind: 'class', name: 'Class' })
  localData = createPlaythrough(localData, { id: 'play' as never, label: 'Run' })
  localData = upsertProgress(localData, { id: 'local' as never, subject: { kind: 'personal', definitionId: 'subject' as never }, displayName: 'Class', unlocked: { state: 'unknown', reason: 'Check later' } })
  const composition = prepareModComposition({ baseline: { catalogId: catalog.id, catalogRevisionId: catalog.revisionId }, layers: [{ catalogId: imported.id, catalogRevisionId: imported.revisionId, enabled: true }], links: [] }, before.planner.catalogs)
  localData = addGameSetupRevision(localData, { label: 'Synthetic retained qualification setup', modComposition: composition, activate: false })
  const setup = Object.values(localData.gameSetups).find(setup => setup.label === 'Synthetic retained qualification setup')!
  const catalogs = expandModCatalogs([...before.planner.catalogs, composeModCatalog(setup, before.planner.catalogs)!])
  await repository.commitWorkspace({ ...before, planner: { ...before.planner, localData, catalogs } }, before.planner.localData.revision)
}

export async function qualificationEvidence(repository: import('../../src/workspace/repository').WorkspaceRepository) {
  const { captureWorkspaceSnapshot, openHistoricalSnapshot, disposeWorkspaceSnapshot } = await import('../../src/workspace/snapshot')
  const { capturedBackupEvidence } = await import('../../src/interchange/workspace-backup-evidence')
  const { hashBlob, blobIdentity } = await import('../../src/workspace/blobs')
  const { inspectWorkspaceClosure, archiveTypedReferences, publicationDocuments } = await import('../../src/workspace/closure')
  const { splitWorkspace } = await import('../../src/workspace/documents')
  const snapshot = await captureWorkspaceSnapshot(repository)
  try {
    const evidence = capturedBackupEvidence(snapshot), state = snapshot.state
    const historicalMembers: { id: string; format: 'legacy-v1' | 'compact-v2'; nativeRefs: readonly import('../../src/workspace/documents').WorkspaceBlobRef[]; catalogRefs: readonly import('../../src/workspace/documents').WorkspaceBlobRef[] }[] = []
    if (snapshot.version !== 1) for (const member of snapshot.historicalEvidence?.snapshots ?? []) {
      const historical = await openHistoricalSnapshot(snapshot, member.id)
      try {
        historicalMembers.push({ id: member.id, format: historical.version === 3 ? 'compact-v2' : 'legacy-v1', nativeRefs: historical.state.blobs.map(body => body.ref), catalogRefs: historical.version === 3 ? historical.catalogBodies : [] })
      } finally { await disposeWorkspaceSnapshot(historical) }
    }
    const requiredRefs = splitWorkspace(state).filter(document => document.kind !== 'retained-content' || (document.value as { kind: string }).kind !== 'pending-content').flatMap(document => archiveTypedReferences(document.kind, document.value))
    const requiredClosureBodies = new Set<string>()
    const inspect = async (closure: import('../../src/workspace/documents').WorkspaceConflictClosure) => {
      const result = await inspectWorkspaceClosure(state, closure)
      for (const ref of result.refs) requiredClosureBodies.add(ref)
      return result.value
    }
    const conflicts = await Promise.all(state.conflicts.map(async conflict => {
      if (conflict.commonAncestor.kind === 'present') await inspect(conflict.commonAncestor.closure)
      if (conflict.disposition.kind === 'resolved') await inspect(conflict.disposition.result)
      return { key: conflict.unit.privateKey, disposition: conflict.disposition, branches: await Promise.all(conflict.branches.map(branch => inspect(branch.closure))) }
    }))
    for (const retained of state.retainedContent) if (retained.kind === 'file-history') await inspect(retained.content)
    const published = new Set((await publicationDocuments(state)).filter(document => document.kind === 'blob').map(document => (JSON.parse(document.key) as string[])[1]))
    // A publication projection alone cannot justify missing originals
    // Preserve admitted member subsets separately: a current pending wrapper can also be an immutable historical original
    // Only target wrappers without any current or inherited required role may stay local
    const bodyRoles = {
      historicalMembers,
      currentNativeRefs: state.blobs.map(body => body.ref),
      publishableNativeRefs: state.blobs.filter(body => published.has(blobIdentity(body.ref))).map(body => body.ref),
      requiredRefs: [...requiredRefs, ...state.blobs.filter(body => requiredClosureBodies.has(blobIdentity(body.ref))).map(body => body.ref), ...evidence.catalogBodies?.map(body => body.ref) ?? []],
      pendingTargets: state.retainedContent.flatMap(retained => retained.kind === 'pending-content' ? [{ kind: retained.kind, unit: retained.unit, root: retained.target.root, index: retained.target.index }] : []),
    }
    return {
      bodyRoles,
      members: snapshot.version === 1 ? [] : snapshot.historicalEvidence?.snapshots,
      metadata: await Promise.all([...evidence.historical].map(async ([id, body]) => ({ id, digest: await hashBlob(body) }))),
      bodies: await Promise.all([...evidence.blobs, ...evidence.catalogBodies ?? []].map(async body => ({ ref: body.ref, digest: await hashBlob(body.content) }))),
      catalogs: state.planner.catalogs.map(catalog => ({ id: catalog.id, revisionId: catalog.revisionId, checksum: catalog.checksum })),
      setups: Object.values(state.planner.localData.gameSetups).filter(setup => setup.label === 'Synthetic retained qualification setup'),
      progress: Object.values(state.planner.localData.playthroughs).flatMap(play => Object.values(play.progress)),
      sources: state.planner.sources, editors: state.editorDocuments, saves: state.saveDocuments, assets: state.assets,
      conflicts,
    }
  } finally { await disposeWorkspaceSnapshot(snapshot) }
}

// Decode authenticated discovery state without running discovery or adopting its projection
export async function qualificationScan() {
  const { z } = await import('zod')
  const { readSyncState } = await import('../../src/account/sync/outbox')
  const { readRemoteHeads } = await import('../../src/account/sync/pull')
  const { CipherRefSchema } = await import('../../src/workspace/account-cache')
  const token = currentProfileToken()!, database = new AccountDatabase(token.accountId)
  try {
    const scan = await readSyncState(database, token, 'scan', z.object({ version: z.literal(1), kind: z.literal('remote-scan'), base: CipherRefSchema.nullable(), watermark: z.number().int().nonnegative(), publicationEpoch: z.number().int().nonnegative(), heads: CipherRefSchema, complete: z.boolean() }))
    if (!scan) throw new Error('Qualification requires authenticated discovery')
    const { heads, ...state } = scan.value
    return { row: scan.row, state, heads: [...await readRemoteHeads(database, token, heads)].sort(([a], [b]) => a.localeCompare(b)) }
  } finally { database.close() }
}

// This negative fixture is not a compact-to-legacy export: only its synthetic container is v1
// The published Progress record and every native body association remain untouched
export async function qualifyOldPublishedProgress(repository: import('../../src/workspace/repository').WorkspaceRepository) {
  const { captureWorkspaceSnapshot, validateWorkspaceSnapshot, disposeWorkspaceSnapshot } = await import('../../src/workspace/snapshot')
  const { hashBlob } = await import('../../src/workspace/blobs')
  const captured = await captureWorkspaceSnapshot(repository)
  try {
    const conflict = captured.state.conflicts.find(value => value.progressIdentity?.version === 2)
    if (!conflict || conflict.progressIdentity?.version !== 2) throw new Error('Qualification requires an actual published compact Progress comparison')
    const synthetic = Object.freeze({ version: 1 as const, dataGeneration: captured.dataGeneration, snapshotId: 'synthetic-old-progress-reader-container', capturedAt: captured.capturedAt, revisionVector: {}, state: Object.freeze({ ...captured.state, conflicts: Object.freeze([conflict]) }) })
    await validateWorkspaceSnapshot(synthetic)
    const bodyDigests = async () => Promise.all(synthetic.state.blobs.map(async body => ({ ref: body.ref, digest: await hashBlob(body.content) })))
    const before = await bodyDigests()
    for (const body of before) if (body.ref.sha256 !== body.digest) throw new Error('Published qualification body differs from its full ref')
    // Immutable export f is the original complete snapshot validator in the retained binary
    // The separate supported control proves the failure is not a v1 envelope or body incompatibility
    const path = '/__accounts-proof/assets/snapshot-DPL1MswI.js'
    const old = await import(/* @vite-ignore */ path)
    if (typeof old.f !== 'function') throw new Error('Missing immutable old snapshot validator')
    await old.f({ ...synthetic, state: { ...synthetic.state, conflicts: [] } })
    let oldAccepted = false, issues: { code: string; path: (string | number)[] }[] = []
    try { await old.f(synthetic); oldAccepted = true }
    catch (error) {
      const value = error as { name?: string; issues?: { code: string; path: (string | number)[] }[] }
      if (value.name !== 'ZodError' || !Array.isArray(value.issues)) throw error
      issues = value.issues.map(({ code, path }) => ({ code, path }))
    }
    const after = await bodyDigests()
    return { candidateAccepted: true, compatibleControlAccepted: true, oldAccepted, issues, conflictId: conflict.id, identity: conflict.progressIdentity, bodies: before, bodyAssociationsPreserved: JSON.stringify(before) === JSON.stringify(after) }
  } finally { await disposeWorkspaceSnapshot(captured) }
}
