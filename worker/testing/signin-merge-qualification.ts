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

export async function seedQualificationChoices(repository: import('../../src/workspace/repository').WorkspaceRepository, baseline: 'default' | 'guide') {
  const { createPersonalDefinition, createPlaythrough, addGameSetupRevision } = await import('../../src/domain/local-data')
  const { upsertProgress } = await import('../../src/domain/characters')
  const { prepareModComposition, composeModCatalog, expandModCatalogs } = await import('../../src/domain/mod-layers')
  const { DEFAULT_CATALOG, GUIDE_CATALOG } = await import('../../src/catalog/bundled')
  if (baseline !== 'default' && baseline !== 'guide') throw new Error('Qualification requires an explicit genuine bundled baseline')
  const catalog = baseline === 'default' ? DEFAULT_CATALOG : GUIDE_CATALOG
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
  const { captureWorkspaceSnapshot, disposeWorkspaceSnapshot } = await import('../../src/workspace/snapshot')
  const { capturedBackupEvidence } = await import('../../src/interchange/workspace-backup-evidence')
  const { hashBlob } = await import('../../src/workspace/blobs')
  const { inspectWorkspaceClosure } = await import('../../src/workspace/closure')
  const snapshot = await captureWorkspaceSnapshot(repository)
  try {
    const evidence = capturedBackupEvidence(snapshot), state = snapshot.state
    return {
      members: snapshot.version === 1 ? [] : snapshot.historicalEvidence?.snapshots,
      metadata: await Promise.all([...evidence.historical].map(async ([id, body]) => ({ id, digest: await hashBlob(body) }))),
      bodies: await Promise.all([...evidence.blobs, ...evidence.catalogBodies ?? []].map(async body => ({ ref: body.ref, digest: await hashBlob(body.content) }))),
      catalogs: state.planner.catalogs.map(catalog => ({ id: catalog.id, revisionId: catalog.revisionId, checksum: catalog.checksum })),
      setups: Object.values(state.planner.localData.gameSetups).filter(setup => setup.label === 'Synthetic retained qualification setup'),
      progress: Object.values(state.planner.localData.playthroughs).flatMap(play => Object.values(play.progress)),
      sources: state.planner.sources, editors: state.editorDocuments, saves: state.saveDocuments, assets: state.assets,
      conflicts: await Promise.all(state.conflicts.map(async conflict => ({ key: conflict.unit.privateKey, disposition: conflict.disposition, branches: await Promise.all(conflict.branches.map(async branch => (await inspectWorkspaceClosure(state, branch.closure)).value)) }))),
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
