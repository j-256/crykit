import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import App from '../../src/App'
import { decodeCrystalSave, encodeCrystalSave } from '../../src/interchange/crystal-save'
import { editSave } from '../../src/domain/save-editor'
import { SAVE_EDITOR_CATALOG } from '../../src/catalog/save-editor'
import { WorkspaceProvider, useWorkspace } from '../../src/ui/WorkspaceProvider'
import { currentProfileToken, profileAccess, withAccountKey } from '../../src/account/profile'
import { listCachedProfiles, readDeviceProfile } from '../../src/account/device-store'
import { previewImport } from '../../src/interchange/import'
import { createPersonalDefinition, createCharacter, createScenario } from '../../src/domain'
import { createPlaythroughWithSetup } from '../../src/domain/game-setups'
import { AccountDatabase, activateLocalAccountCommit } from '../../src/persistence/account-database'
import { prepareAccountWorkspace } from '../../src/workspace/account-graph'
import { memoryBlob } from '../../src/workspace/blobs'
import { disposeWorkspaceSnapshot } from '../../src/workspace/snapshot'
import { sha256 } from '../../src/interchange/util'
import { accountLocalId } from '../../src/workspace/account-cache'
import { createBlankLocalData } from '../../src/domain/local-data'
import '../../src/styles.css'

// Local-only observability drives the actual App/provider and recovery boundary, never production assets
type PublicSharingFixture = { readonly effect: string; readonly filename: string; readonly artwork: string; readonly source: string; readonly allocation: string; readonly note: string }
async function teamFixtureData(publicSharing?: PublicSharingFixture) {
  const { addTestBuild, addTestDefinition, addTestTeam, createTestLocalData, HAND_SLOT, personalRef, TEST_GAME_SETUP_REVISION_ID, TEST_NOW } = await import('../../src/domain/test-helpers')
  const { addGameSetupRevision } = await import('../../src/domain/local-data')
  let data = addTestDefinition(addTestDefinition(createTestLocalData(), 'Synthetic class', { kind: 'class' }), 'Synthetic sword')
  data = addTestBuild(data, 'Synthetic source', '', { [HAND_SLOT]: { ref: personalRef('Synthetic sword') } }, { primaryClass: personalRef('Synthetic class') })
  data = addTestTeam(data).localData
  data = addGameSetupRevision(data, { ...data.gameSetups[TEST_GAME_SETUP_REVISION_ID]!, id: 'other-team-setup' as never, label: 'Other shared rules', ppLimit: { state: 'known', value: 9 }, activate: false })
  const { saveBuildRevision } = await import('../../src/domain/builds')
  data = saveBuildRevision(data, { buildId: 'Synthetic source' as never, id: 'other-source-revision' as never, gameSetupRevisionId: 'other-team-setup' as never, content: data.buildRevisions['Synthetic source-revision']!.content })
  data = { ...data, teams: { mixed: { id: 'mixed' as never, kind: 'legacy-mixed', title: 'Legacy mixed Team', slots: ['Synthetic source-revision' as never, null, 'other-source-revision' as never, null], revision: 4, createdAt: TEST_NOW, updatedAt: TEST_NOW }, legacy: { id: 'legacy' as never, kind: 'legacy-mixed', title: 'Legacy empty Team', slots: [null, null, null, null], revision: 0, createdAt: TEST_NOW, updatedAt: TEST_NOW } }, modSetup: { version: 1, state: 'skipped' } }
  if (publicSharing) {
    const { saveSharedTeam } = await import('../../src/domain/team-checkpoints')
    const definition = data.personalDefinitions['Synthetic sword']!
    const revision = data.buildRevisions['Synthetic source-revision']!
    data = { ...data, personalDefinitions: { ...data.personalDefinitions, [definition.id]: { ...definition, rawDescription: publicSharing.effect, fields: { secret: { state: 'known', value: { filename: publicSharing.filename, artworkId: publicSharing.artwork, sourceArchive: publicSharing.source } } } } }, buildRevisions: { ...data.buildRevisions, [revision.id]: { ...revision, content: { ...revision.content, equipment: { hand: { ref: personalRef(definition.id), allocationId: publicSharing.allocation }, 'second-hand': { ref: personalRef(definition.id), allocationId: publicSharing.allocation } }, rotationNotes: publicSharing.note, contextAssumptions: [] } } } }
    data = saveSharedTeam(data, { id: 'public-team' as never, title: 'Portable Team', gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID, slots: [revision.id, null, revision.id, null] })
  }
  return data
}

// Bootstrap proofs touch only synthetic account storage before the planner is mounted
// Keeping them outside WorkspaceProof preserves the native-root migration boundary
const accountBootstrapProof = {
  async accountStorage() {
    const token = currentProfileToken()!
    const database = new AccountDatabase(token.accountId)
    try {
      const { openAccountJson } = await import('../../src/workspace/account-cache')
      const { AccountWorkspaceRootV1Schema, AccountWorkspaceRootV2Schema } = await import('../../src/workspace/account-graph')
      const { LocalWorkspaceRootV3Schema } = await import('../../src/workspace/local-root')
      const { assertActiveProfile } = await import('../../src/account/profile')
      const before = await database.profileMeta.get('active')
      if (!before) throw new Error('Missing selected account root')
      const root = await openAccountJson(database, token, before.head, LocalWorkspaceRootV3Schema.or(AccountWorkspaceRootV1Schema).or(AccountWorkspaceRootV2Schema))
      const pending = await database.outbox.toArray()
      if (JSON.stringify(await database.profileMeta.get('active')) !== JSON.stringify(before)) throw new Error('Account changed during storage observation')
      assertActiveProfile(token)
      return { rootVersion: root.version, fence: before, pending }
    } finally { database.close() }
  },
  async seedSaveConflictFixture() {
    const { editorClosureFixture } = await import('../../src/workspace/test-helpers')
    const { openAccountRepository } = await import('../../src/workspace/account-repository')
    const { createSaveRepository } = await import('../../src/workspace/save-repository')
    const { createSaveEditorFixture } = await import('../../src/domain/save-editor.fixture')
    const fixture = await editorClosureFixture(), token = currentProfileToken()!, database = new AccountDatabase(token.accountId)
    try {
      if (await database.profileMeta.get('active')) throw new Error('Save conflict fixture requires fresh account storage')
      const prepared = await prepareAccountWorkspace(database, token, { ...fixture.state, retainedContent: [], blobs: [] })
      await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: prepared.head, records: prepared.records })
      await createSaveRepository(await openAccountRepository(token)).importFile('binary-conflict.sav', encodeCrystalSave(createSaveEditorFixture()))
    } finally { database.close() }
  },
  async seedConflictFixture() {
    const { editorClosureFixture } = await import('../../src/workspace/test-helpers')
    const fixture = await editorClosureFixture()
    const token = currentProfileToken()!, database = new AccountDatabase(token.accountId)
    try {
      if (await database.profileMeta.get('active')) throw new Error('Conflict fixture requires fresh account storage')
      const prepared = await prepareAccountWorkspace(database, token, { ...fixture.state, editorDocuments: [fixture.file], retainedContent: [], blobs: fixture.blobs.filter(blob => blob.ref.encoding === 'utf16le') })
      await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: prepared.head, records: prepared.records })
    } finally { database.close() }
  },
  async seedSelectionFixture() {
    let data = createBlankLocalData()
    for (const label of ['First local journey', 'Second local journey']) {
      data = createPlaythroughWithSetup(data, { label, catalogLock: {} })
      const playthroughId = data.selectedPlaythroughId!
      for (let index = 0; index < 4; index++) data = createCharacter(data, { playthroughId, name: `${label} member ${index}` })
      const memberIds = Object.keys(data.playthroughs[playthroughId].characters) as import('../../src/domain/types').CharacterId[]
      for (const label of ['First local scenario', 'Second local scenario']) data = createScenario(data, { playthroughId, label, memberIds, gameSetupRevisionId: data.playthroughs[playthroughId].currentGameSetupRevisionId! })
    }
    // Synthetic baseline construction precedes the first account open; it creates no fictional authored command history
    const localData = { ...data, revision: 0, changes: [], updatedAt: data.createdAt, modSetup: { version: 1 as const, state: 'skipped' as const } }
    const token = currentProfileToken()!, database = new AccountDatabase(token.accountId)
    try {
      if (await database.profileMeta.get('active')) throw new Error('Selection fixture requires fresh account storage')
      const prepared = await prepareAccountWorkspace(database, token, { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], blobs: [], libraryDefaults: { version: 1, layers: [] } })
      await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: prepared.head, records: prepared.records })
      return localData
    } finally { database.close() }
  },
  async seedTeamFixture(account = true, publicSharing?: PublicSharingFixture) {
    if (!account) throw new Error('Guest fixture requires the mounted workspace proof')
    const data = await teamFixtureData(publicSharing)
    const token = currentProfileToken()!, database = new AccountDatabase(token.accountId)
    try {
      if (await database.profileMeta.get('active')) throw new Error('Team fixture requires fresh account storage')
      const localData = { ...data, revision: 0, changes: [] }
      const prepared = await prepareAccountWorkspace(database, token, { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], blobs: [], libraryDefaults: { version: 1, layers: [] } })
      await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: prepared.head, records: prepared.records })
    } finally { database.close() }
  },
}
Object.assign(window, { accountBootstrapProof })

let releaseQueued: (() => void) | undefined
let queuedResult: Promise<string> | undefined
let capturedEditorAuthority: (() => { sameProfile: boolean; repositoryCurrent: boolean; viewRetired: boolean }) | undefined
function WorkspaceProof() {
  const workspace = useWorkspace()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    Object.assign(window, { workspaceProof: {
      ...accountBootstrapProof,
      saveDiagnostics: () => ({ canTransfer: workspace.saveSession.controller.canTransfer(), hydration: !!workspace.saveSession.hydration, recovery: workspace.saveSession.recovery?.outcome.status, focus: workspace.saveSession.controller.snapshot().focus, fields: workspace.saveSession.controller.snapshot().input?.fields, dirty: workspace.saveSession.controller.snapshot().dirty, phase: workspace.saveSession.phase, pending: workspace.fileCommandPending(), current: workspace.isCurrent(), kind: workspace.repository.kind }),
      saveContent: async () => {
        const state = await workspace.repository.readWorkspace()
        const { readSaveContent, saveExportStatus } = await import('../../src/workspace/save-repository')
        return Promise.all(state.saveDocuments.map(async file => { const content = await readSaveContent(state, file); return { file, original: Array.from(content.originalBytes), working: Array.from(content.workingBytes), exportStatus: await saveExportStatus(state, file) } }))
      },
      editorContent: async () => {
        const state = await workspace.repository.readWorkspace(), file = state.editorDocuments[0]
        if (!file) return undefined
        const content = await (await import('../../src/workspace/editor-document')).readEditorContent(state, file)
        return { original: Array.from(content.originalBytes), appliedText: content.lastAppliedText, unfinishedText: content.unfinishedText, fieldState: file.unfinished.fieldState, editedPath: file.unfinished.editedPath, validation: file.unfinished.validation, revision: file.revision }
      },
      artworkContent: async () => {
        const state = await workspace.repository.readWorkspace()
        const { blobIdentity, readBlob } = await import('../../src/workspace/blobs')
        return Promise.all(state.assets.filter(asset => asset.sourceKey.startsWith('private-mod-artwork-v1:')).map(async asset => {
          const body = state.blobs.find(value => blobIdentity(value.ref) === blobIdentity(asset.original))
          if (!body) throw new Error('Missing private artwork original')
          return { id: asset.id, bytes: Array.from(await readBlob(body.content, asset.original.byteLength)) }
        }))
      },
      captureEditorAuthority: () => {
        const token = currentProfileToken(), view = workspace.editorSession.transferView!
        capturedEditorAuthority = () => {
          let viewRetired = false
          try { workspace.editorSession.controller.assertView(view) } catch { viewRetired = true }
          return { sameProfile: currentProfileToken() === token, repositoryCurrent: workspace.isCurrent(), viewRetired }
        }
      },
      inspectCapturedEditorAuthority: () => capturedEditorAuthority?.(),
      editorDiagnostics: () => ({ canTransfer: workspace.editorSession.controller.canTransfer(), phase: workspace.editorSession.phase, pending: workspace.fileCommandPending(), dirty: workspace.editorSession.controller.snapshot().dirty, revision: workspace.editorSession.controller.snapshot().revision, hydration: !!workspace.editorSession.hydration, current: workspace.isCurrent(), kind: workspace.repository.kind }),
      // Sample the captured repository after durable UI acknowledgement without exporting an archive
      savedPlanner: async () => (await workspace.repository.load()).localData,
      async readBackupPlanner(file: File) {
        const { readWorkspaceBackup } = await import('../../src/interchange/workspace-backup')
        const snapshot = await readWorkspaceBackup(memoryBlob(new Uint8Array(await file.arrayBuffer())).open())
        // Full archive validation precedes this small projection; reading never activates an imported workspace
        // Release the native encrypted staging before returning assertions to the driver
        try { return snapshot.state.planner.localData }
        finally { await disposeWorkspaceSnapshot(snapshot) }
      },
      async inspect() {
        const token = currentProfileToken()
        const response = await fetch('/api/v1/account')
        const principal = response.ok ? await response.json() : undefined
        const loaded = await workspace.repository.load()
        const backup = await workspace.repository.previewImport(await workspace.repository.exportPlannerBackup(), 'proof.zip')
        return { playthroughs: Object.values(loaded.localData.playthroughs).map(value => ({ label: value.label, characters: Object.keys(value.characters).length, inventory: Object.keys(value.inventory).length, progress: Object.keys(value.progress).length, scenarios: Object.keys(value.scenarios).length })), kind: workspace.repository.kind, token, principal: principal?.accountId, access: token ? profileAccess(token) : undefined, digest: token ? await withAccountKey(token, async key => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(key)))).join(',')) : undefined, titles: Object.values(loaded.localData.builds).map(build => build.title), backupTitles: Object.values(backup.proposed.localData.builds).map(build => build.title), definitions: Object.values(loaded.localData.personalDefinitions).map(value => value.name), backupDefinitions: Object.values(backup.proposed.localData.personalDefinitions).map(value => value.name) }
      },
      localDefinitions: async () => Object.values((await workspace.repository.load()).localData.personalDefinitions).map(value => value.name),
      async probeGuestRestoreCollisions(bytes: number[]) {
        if (workspace.repository.kind !== 'guest') throw new Error('Guest restore proof requires the selected local workspace')
        const { guestRepositoryBindings } = await import('../../src/workspace/guest-repository')
        const { readWorkspaceBackup } = await import('../../src/interchange/workspace-backup')
        const { previewGuestWorkspaceRestore, beginGuestWorkspaceRestore, stageGuestWorkspaceRestore, releaseGuestWorkspaceRestorePreview } = await import('../../src/workspace/restore')
        const binding = await guestRepositoryBindings(workspace.repository)
        const snapshot = await readWorkspaceBackup(memoryBlob(new Uint8Array(bytes)).open())
        let preview: Awaited<ReturnType<typeof previewGuestWorkspaceRestore>> | undefined
        try {
          preview = await previewGuestWorkspaceRestore(binding, snapshot)
          const cases = [
            { kind: 'planner', occupancy: 'same', version: 60 },
            { kind: 'inspector', occupancy: 'older', version: 1 },
            { kind: 'files', occupancy: 'future', version: 30 },
          ] as const
          const probes = []
          for (const probe of cases) {
            const selectedBefore = (await binding.coordinator.active.get('active'))?.manifest
            const journal = await beginGuestWorkspaceRestore(preview)
            const name = journal.target[probe.kind], marker = crypto.randomUUID()
            const occupied = await new Promise<IDBDatabase>((resolve, reject) => {
              const request = indexedDB.open(name, probe.version)
              request.onupgradeneeded = () => request.result.createObjectStore('sentinel')
              request.onsuccess = () => resolve(request.result)
              request.onerror = () => reject(request.error)
            })
            await new Promise<void>((resolve, reject) => {
              const transaction = occupied.transaction('sentinel', 'readwrite')
              transaction.objectStore('sentinel').put(marker, 'proof')
              transaction.oncomplete = () => resolve()
              transaction.onabort = () => reject(transaction.error)
            })
            occupied.close()
            let denied = false, error = ''
            try { await stageGuestWorkspaceRestore(preview, journal.id) }
            catch (reason) { denied = true; error = String(reason) }
            const retained = await new Promise<IDBDatabase>((resolve, reject) => {
              const request = indexedDB.open(name)
              request.onsuccess = () => resolve(request.result)
              request.onerror = () => reject(request.error)
            })
            try {
              const retainedMarker = await new Promise<unknown>((resolve, reject) => {
                const request = retained.transaction('sentinel').objectStore('sentinel').get('proof')
                request.onsuccess = () => resolve(request.result)
                request.onerror = () => reject(request.error)
              })
              probes.push({ ...probe, denied, error, selectedBefore, selectedAfter: (await binding.coordinator.active.get('active'))?.manifest,
                marker, retainedMarker, retainedVersion: retained.version, stores: Array.from(retained.objectStoreNames) })
            } finally { retained.close() }
          }
          return probes
        } finally {
          if (preview) await releaseGuestWorkspaceRestorePreview(preview)
          await disposeWorkspaceSnapshot(snapshot)
        }
      },
      teamState: async () => (await workspace.repository.load()).localData,
      publicSharingState: async () => {
        const state = await workspace.repository.readWorkspace()
        return { localData: state.planner.localData, catalogPins: state.planner.catalogs.map(value => [value.id, value.revisionId]), sources: state.planner.sources.map(value => value.digest), defaults: state.libraryDefaults, assets: state.assets }
      },
      publishPublicFixture: async (snapshot: import('../../src/interchange/public-share-schema').PublicSnapshot) => {
        const { publishSnapshot } = await import('../../src/account/shares-client')
        return publishSnapshot(currentProfileToken()!, { mutationId: accountLocalId(), snapshot, includeAttribution: false })
      },
      buildInputState: () => ({ dirty: workspace.buildInputSession.controller.snapshot().dirty, scope: workspace.buildInputSession.scope, pending: workspace.buildInputSession.phase, values: workspace.buildInputSession.view ? workspace.buildInputSession.controller.recoveryInput(workspace.buildInputSession.view) : undefined }),
      async seedTeamFixture(account = false, publicSharing?: PublicSharingFixture) {
        if (account) return accountBootstrapProof.seedTeamFixture(true, publicSharing)
        const data = await teamFixtureData(publicSharing)
        const before = await workspace.repository.load()
        const { updateLocalData } = await import('../../src/domain/core')
        const { TEST_NOW } = await import('../../src/domain/test-helpers')
        const next = updateLocalData(before.localData, { gameSetups: data.gameSetups, builds: data.builds, buildRevisions: data.buildRevisions, personalDefinitions: data.personalDefinitions, playthroughs: data.playthroughs, selectedPlaythroughId: data.selectedPlaythroughId, planningGameSetupRevisionId: data.planningGameSetupRevisionId, teams: data.teams, teamRevisions: data.teamRevisions, modSetup: data.modSetup }, 'synthetic.team.seed', ['teams'], TEST_NOW)
        return workspace.repository.save(next, before.revision)
      },
      async selectionSnapshot() {
        const { localData } = await workspace.repository.load()
        return { selectedPlaythroughId: localData.selectedPlaythroughId, planningGameSetupRevisionId: localData.planningGameSetupRevisionId, scenarios: Object.fromEntries(Object.entries(localData.playthroughs).map(([id, value]) => [id, value.activeScenarioId])), definitions: Object.values(localData.personalDefinitions).map(value => value.name), characters: Object.values(localData.playthroughs).flatMap(value => Object.values(value.characters).map(value => value.name)) }
      },
      flushSync: workspace.flushSync,
      async editSaveConflict(currency: number) {
        const { createSaveRepository, readSaveContent } = await import('../../src/workspace/save-repository')
        const state = await workspace.repository.readWorkspace(), file = state.saveDocuments[0]
        const content = await readSaveContent(state, file), save = decodeCrystalSave(content.workingBytes)
        await createSaveRepository(workspace.repository, { intent: 'saveApply' }).saveWorking(file.id, encodeCrystalSave(editSave(save, SAVE_EDITOR_CATALOG, { type: 'currency', value: currency }, new Date('2026-01-02T03:04:05.000Z'))), { version: 99, inertConflictChoice: currency }, file.revision)
      },
      async saveConflictSnapshot() {
        const { inspectWorkspaceClosure } = await import('../../src/workspace/closure')
        const { readSaveContent } = await import('../../src/workspace/save-repository')
        const state = await workspace.repository.readWorkspace()
        const inspect = async (file: import('../../src/workspace/documents').SaveWorkspaceDocument) => {
          const content = await readSaveContent(state, file)
          return { file, original: Array.from(content.originalBytes), working: Array.from(content.workingBytes) }
        }
        return { files: await Promise.all(state.saveDocuments.map(inspect)), conflicts: await Promise.all(state.conflicts.map(async conflict => ({ id: conflict.id, disposition: conflict.disposition.kind, versions: await Promise.all(conflict.branches.map(async branch => ({ role: branch.role, ...await inspect((await inspectWorkspaceClosure(state, branch.closure)).value as import('../../src/workspace/documents').SaveWorkspaceDocument) }))) }))) }
      },
      armSaveStrictRecovery() {
        const view = workspace.saveSession.transferView!, controller = workspace.saveSession.controller
        window.addEventListener('crykit-guest-activated', () => controller.present(view, 'query', 'later recovery input'), { once: true })
      },
      async editConflictFile(filename: string, unrelated = false, draftCodeUnit = 0xd800) {
        const before = await workspace.repository.readWorkspace()
        const file = before.editorDocuments.find(value => value.id === 'editor-1')!
        const bytes = new Uint8Array([draftCodeUnit & 255, draftCodeUnit >> 8])
        const ref = { documentId: accountLocalId(), revisionId: accountLocalId(), byteLength: bytes.length, sha256: await sha256(bytes), encoding: 'utf16le' as const }
        return workspace.repository.commitWorkspace({ ...before, blobs: [...before.blobs, { ref, content: memoryBlob(bytes) }], editorDocuments: [{ ...file, revision: file.revision + 1, filename, unfinished: { ...file.unfinished, text: ref } }, ...(unrelated ? [{ ...file, id: 'independent-file', filename: 'Unrelated saved file.json' }] : before.editorDocuments.filter(value => value.id !== file.id))] }, before.planner.localData.revision)
      },
      async saveUnrelatedConflictFile() {
        const before = await workspace.repository.readWorkspace()
        return workspace.repository.commitWorkspace({ ...before, editorDocuments: before.editorDocuments.map(file => file.id === 'independent-file' ? { ...file, revision: file.revision + 1, filename: 'Additional unrelated progress.json' } : file) }, before.planner.localData.revision)
      },
      async conflictSnapshot() {
        const { inspectWorkspaceClosure } = await import('../../src/workspace/closure')
        const { readBlob, blobIdentity } = await import('../../src/workspace/blobs')
        const state = await workspace.repository.readWorkspace()
        return { files: state.editorDocuments.map(value => value.filename), conflicts: await Promise.all(state.conflicts.map(async conflict => ({ id: conflict.id, disposition: conflict.disposition.kind, versions: await Promise.all(conflict.branches.map(async branch => {
          const inspected = await inspectWorkspaceClosure(state, branch.closure)
          const file = inspected.value as import('../../src/workspace/documents').EditorWorkspaceDocument
          return { role: branch.role, filename: file.filename, validation: file.unfinished.validation, draftBytes: Array.from(await readBlob(state.blobs.find(blob => blobIdentity(blob.ref) === blobIdentity(file.unfinished.text))!.content, file.unfinished.text.byteLength)) }
        })) }))) }
      },
      async chooseSelectors(index: number) {
        const before = await workspace.repository.load(), data = before.localData
        const selected = Object.values(data.playthroughs).find(value => value.label === (index === 0 ? 'First local journey' : 'Second local journey'))!
        const playthroughs = Object.fromEntries(Object.entries(data.playthroughs).map(([id, value]) => [id, { ...value, activeScenarioId: Object.values(value.scenarios).find(value => value.label === (index === 0 ? 'First local scenario' : 'Second local scenario'))!.id }]))
        return workspace.repository.save({ ...data, selectedPlaythroughId: selected.id, planningGameSetupRevisionId: selected.currentGameSetupRevisionId, playthroughs }, before.revision)
      },
      cached: listCachedProfiles,
      pending: async (accountId: string) => (await readDeviceProfile(accountId))?.pendingRevocations,
      async saveDefinition(name: string) {
        const before = await workspace.repository.load()
        const saved = await workspace.repository.save(createPersonalDefinition(before.localData, { name, kind: 'item' }), before.revision)
        // The restart oracle needs the exact saved planner; unused catalogs must not enter the browser protocol and trace
        return { localData: saved.localData }
      },
      async queueDefinition(name: string) {
        const captured = workspace.repository
        const before = await captured.load()
        const wait = new Promise<void>(resolve => { releaseQueued = resolve })
        queuedResult = wait.then(() => captured.save(createPersonalDefinition(before.localData, { name, kind: 'item' }), before.revision)).then(() => 'saved', error => error.code ?? error.message)
      },
      releaseQueued: async () => { releaseQueued?.(); return queuedResult },
      previewBackup: async (bytes: number[]) => previewImport(new Uint8Array(bytes), 'recovery.zip'),
      crash: () => setFailed(true),
    } })
    return () => { delete (window as unknown as { workspaceProof?: unknown }).workspaceProof }
  }, [workspace])
  if (failed) throw new Error('Synthetic render failure')
  return <App/>
}
createRoot(document.getElementById('root')!, { onCaughtError: () => {} }).render(<WorkspaceProvider><WorkspaceProof/></WorkspaceProvider>)
