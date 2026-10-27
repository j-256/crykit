import { editCopiedCheckpoint } from './interchange/public-checkpoint-edit'
import { recordWorkspaceStartup, WORKSPACE_STARTUP_PHASE } from './diagnostics/workspace-startup'
import type { SaveCopiedCheckpoint } from './ui/PublicSharedView'
import { copyPublicSnapshot } from './interchange/public-share-enrichment'
import type { PublicSnapshot } from './interchange/public-share-schema'
import { HostedSharedView, PublicSharedView } from './ui/PublicSharedView'
import { saveTeamSlotAsBuild, teamSlots, checkpointBuildView } from './domain/team-checkpoints'
import { BuildInputProvider } from './ui/build-input-session'
import { downloadCapturedWorkspace } from './ui/download-stream'
import { readWorkspaceBackup } from './interchange/workspace-backup'
import { disposeWorkspaceSnapshot, type WorkspaceSnapshot } from './workspace/snapshot'
import { activateGuestWorkspaceRestore, beginGuestWorkspaceRestore, previewGuestWorkspaceRestore, releaseGuestWorkspaceRestorePreview, stageGuestWorkspaceRestore, type GuestRestorePreview } from './workspace/repository-guest-restore'
import { activateAccountWorkspaceRestore, previewAccountWorkspaceRestore, releaseAccountWorkspaceRestorePreview, releaseAccountWorkspaceRestoreStage, stageAccountWorkspaceRestore, type AccountRestorePreview } from './workspace/account-restore'
import { AccountDatabase } from './persistence/account-database'
import type { ProfileToken } from './account/profile'
import type { CompleteWorkspaceRestorePreview } from './ui/CompleteWorkspaceRestore'
import { AccountView } from './ui/account/AccountView'
import { buildContentForModSetup } from './domain/build-mods'
import { retainOutOfContextSelections } from './domain/retained-selections'
import { changesModDraftContext } from './ui/mod-workspace'
import { CRYSTAL_EDIT_FORMAT } from './interchange/crystal-edit'
import { modRevision, type BundledLibraryMod } from './domain/mod-library'
import { modCatalogTitle } from './domain/mod-layers'
import { applyLibraryDefaultsToNewSetup, assertLibraryProject } from './domain/mod-library-actions'
import type { BuildBehavior } from './domain/build-behavior'
import { importLibrarySource } from './workspace/mod-repository'
import { confirmModFolder, type FolderImportPreview, type FolderSelection } from './workspace/folder-import'
import { bundledModEditableSource } from './catalog/mod-library'
import { setModInReference } from './domain/reference-library'
import { adoptTeam, deleteTeam, recordBuildForCharacter, saveTeam, type SaveTeamInput } from './domain/teams'
import type { CatalogId, TeamId } from './domain/types'
import { TeamsView } from './ui/TeamsView'
import { SaveFailureAlert } from './ui/SaveFailureAlert'
import { saveTeamMember, type SaveTeamMemberInput } from './domain/team-member'
import { createPlaythroughWithSetup } from './domain/game-setups'
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  activateScenario,
  advanceClassSealProgress,
  setAcquisitionProgress,
  asId,
  captureCharacter,
  importSkillTrees,
  type ReviewedSkillTree,
  cloneBuild,
  coalesceDefinitionOverrides,
  createCharacter,
  revisePersonalDefinition,
  createId,
  createPersonalDefinition,
  createGameSetupRevision,
  createScenario,
  effectiveScenarioAssignments,
  entityDefinitionKey,
  createBuild,
  saveBuildBehavior,
  sameBuildBehavior,
  linkInventoryPosition,
  observeInventory,
  recordInventoryEvent,
  requirePlaythrough,
  selectedPlaythrough,
  replaceScenarioBuild,
  saveBuildRevision,
  setClassSealProgressBatch,
  toggleQuintarStep,
  toggleSummonProgress,
  selectPlaythrough,
  setPlaythroughGameSetup,
  updateBuild,
  updateGameSetupRevision,
  upsertCharacterClassProgress,
  upsertLearnedNode,
  upsertProgress,
  validateScenario,
  type BuildId,
  type BuildRevisionId,
  type CatalogIndex,
  type CatalogSnapshot,
  type CharacterId,
  type ClassSealProgressSelection,
  type EntityRef,
  type JsonValue,
  type Knowledge,
  type PersonalDefinitionId,
  type PlaythroughId,
  type LocalData,
  type ProgressRecordId,
  type ProgressStage,
  type GameSetupRevisionId,
  type ScenarioId,
  type SlotDefinition,
  type SlotId,
  type Timestamp,
  type ValidationReport,
} from './domain'
import type { DraftActions, DraftChangeHandler } from './ui/drafts'
import { BUNDLED_CATALOGS, CURRENT_CATALOG } from './catalog/bundled'
import { BUNDLED_MOD_LIBRARY } from './catalog/mod-library-metadata'
import { validateLocalDataForStorage } from './persistence'
import { useWorkspace } from './ui/WorkspaceProvider'
import { ConflictPanel } from './ui/account/ConflictPanel'
import type { ImportCommitMode, ImportPreview, LoadedLocalData } from './interchange/types'
import { BuildsView, type BuildDraft, type RevisionDraft, type ScenarioDraft } from './ui/BuildsView'
import { WorkspaceHeaderScope } from './ui/WorkspaceHeader'
import { useNavigationNotice } from './ui/useNavigationNotice'
import type { BuildDetailsPatch } from './ui/BuildDetailsControl'
import { SharedView } from './ui/SharedView'
import { saveSharedCopy, type SharePayload } from './interchange/share'
import { CharactersView, type CharacterDraft, type ClassProgressDraft, type LearnedNodeDraft, type SnapshotDraft } from './ui/CharactersView'
import { DataPanel } from './ui/DataPanel'
import type { GameSetupDraft, GameSetupSaveOptions } from './ui/GameSetupEditor'
import { InventoryView, type InventoryDraft, type InventoryEventDraft } from './ui/InventoryView'
import { ProgressView, type ProgressDraft } from './ui/ProgressView'
import { QuintarBreedingView } from './ui/QuintarBreedingView'
import { summonEntries } from './ui/SummonsView'
import type { SummonId } from './catalog/summons'
import type { QuintarBreedingStepId } from './catalog/quintar-breeding'
import { createEntityRouteNameResolver } from './ui/entity-route-names'
import { ReferenceView } from './ui/ReferenceView'
import { Shell } from './ui/Shell'
import { Button, InlineNotice, LoadingScreen } from './ui/components'
import { catalogLocksMatch, formatAppError } from './ui/model'
import { DefinitionProvider, type DefinitionEditorDraft } from './ui/definitions'
import { isReferenceResearchRoute, isRouteWithin, NavigationProvider, routeDestination, routeForDestination, routeWithoutOverlays, useNavigationController, type AppRoute, type NavigationController } from './ui/navigation'

const ModsView = lazy(() => import('./ui/ModsView').then(module => ({ default: module.ModsView })))
const ModCatalogReference = lazy(() => import('./ui/ModCatalogReference'))
const SaveEditorView = lazy(() => import('./ui/SaveEditorView').then(module => ({ default: module.SaveEditorWorkspaceView })))
const WorldMapView = lazy(() => import('./ui/WorldMapView'))

type SaveState = 'saved' | 'saving' | 'unsaved' | 'error'
const PAINT_WAIT_FALLBACK_MS = 250
const INTERACTIVE_PROGRESS_COMMIT = Object.freeze({ showSavingState: false, deferUntilPaint: true, validateOnCommitOnly: true })

function waitForNextPaint(): Promise<void> {
  return new Promise(resolve => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(fallback)
      cancelAnimationFrame(frame)
      resolve()
    }
    const fallback = window.setTimeout(finish, PAINT_WAIT_FALLBACK_MS)
    const frame = requestAnimationFrame(() => window.setTimeout(finish, 0))
  })
}

function currentTimestamp(date?: string): Timestamp | undefined {
  if (!date) return undefined
  return date as Timestamp
}

function nullableTimestamp(date?: string | null): Timestamp | null | undefined {
  return date === null ? null : currentTimestamp(date)
}

function addPersonalRef(localData: LocalData, name: string, kind: Parameters<typeof createPersonalDefinition>[1]['kind']) {
  const id = createId<PersonalDefinitionId>('definition')
  const next = createPersonalDefinition(localData, { id, name, kind, expectedRevision: localData.revision })
  return { localData: next, ref: { kind: 'personal', definitionId: id } as const }
}

function catalogIndex(catalogs: readonly CatalogSnapshot[]): CatalogIndex {
  const snapshots = Object.fromEntries(catalogs.map((catalog) => [JSON.stringify([catalog.id, catalog.revisionId]), catalog]))
  const entitiesByRef = Object.fromEntries(catalogs.flatMap((catalog) => Object.values(catalog.entities).map((entity) => [entityDefinitionKey({ kind: 'catalog', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: entity.id }), entity])))
  return { snapshots, entitiesByRef }
}

const ModSetupSelector = lazy(() => import('./ui/ModSetupSelector').then(module => ({ default: module.ModSetupSelector })))

async function* workspaceBackupFile(file: File): AsyncIterable<Uint8Array> {
  const reader = file.stream().getReader()
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) return
      yield next.value
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

type SelectedGuestRestore = { preview: GuestRestorePreview; snapshot: WorkspaceSnapshot }
type SelectedAccountRestore = { preview: AccountRestorePreview; snapshot: WorkspaceSnapshot; database: AccountDatabase; token: ProfileToken }
type SelectedRestore = SelectedGuestRestore | SelectedAccountRestore
async function disposeSelectedRestore(selected: SelectedRestore): Promise<void> {
  try {
    if (selected.preview.target === 'guest') await releaseGuestWorkspaceRestorePreview(selected.preview)
    else releaseAccountWorkspaceRestorePreview(selected.preview)
  } finally {
    try { await disposeWorkspaceSnapshot(selected.snapshot) }
    finally { if ('database' in selected) selected.database.close() }
  }
}

export default function App() {
  const workspace = useWorkspace()
  const { repository } = workspace
  const { load: loadLocalData, save: saveLocalDataWithStatus, undo: undoLocalDataWithStatus, previewImport, commitImport, commitModSetup, prepareModCatalogs, exportPlannerBackup: exportBackup, subscribe: subscribeLocalData } = repository
  const initialLanding = useRef(!window.location.hash || window.location.hash === '#/' )
  const [modSelectorOpen, setModSelectorOpen] = useState(false)
  const [loadedData, setLoadedData] = useState<LoadedLocalData>()
  const loadedDataRef = useRef<LoadedLocalData | undefined>(undefined)
  const commitQueueRef = useRef<Promise<void>>(Promise.resolve())
  const pendingCommitCountRef = useRef(0)
  const persistedRevisionRef = useRef(0)
  const dirtyRef = useRef(false)
  const formDirtyRef = useRef(false)
  const draftActionsRef = useRef<DraftActions | undefined>(undefined)
  const pendingNavigationRef = useRef<AppRoute | undefined>(undefined)
  const { noticeRef: navigationWarningRef, revealNotice: revealNavigationWarning } = useNavigationNotice()
  const buildDraftRouteRef = useRef<AppRoute>(undefined)
  const [loadingError, setLoadingError] = useState<string>()
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [pendingCommitCount, setPendingCommitCount] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [formDirty, setFormDirty] = useState(false)
  const [navigationWarning, setNavigationWarning] = useState<AppRoute>()
  const [resolvingDraft, setResolvingDraft] = useState(false)
  const [saveError, setSaveError] = useState<string>()
  const [importPreview, setImportPreview] = useState<ImportPreview>()
  const [importError, setImportError] = useState<string>()
  const [importBusy, setImportBusy] = useState(false)
  const workspaceRestoreRef = useRef<SelectedRestore | undefined>(undefined)
  const workspaceRestoreGeneration = useRef(0)
  const [externalUpdate, setExternalUpdate] = useState(false)
  const [routeCatalogs, setRouteCatalogs] = useState<readonly CatalogSnapshot[]>([])
  const resolveEntityName = useMemo(() => createEntityRouteNameResolver([...BUNDLED_CATALOGS, ...(loadedData?.catalogs ?? []), ...routeCatalogs]), [loadedData?.catalogs, routeCatalogs])
  const navigation = useNavigationController({
    resolveEntityName,
    shouldBlock: (from, to) => {
      if (!formDirtyRef.current) return false
      if (changesModDraftContext(from, to)) return true
      if (buildDraftRouteRef.current && !dirtyRef.current) return !isReferenceResearchRoute(to) && !isRouteWithin(to, buildDraftRouteRef.current)
      return !isRouteWithin(to, routeWithoutOverlays(from))
    },
    onBlocked: (to) => { pendingNavigationRef.current = to; setNavigationWarning({ ...to }); revealNavigationWarning() },
  })
  // Settings and overlay forms register independently from planner/editor draft flags
  useLayoutEffect(() => workspace.registerDraftPresence(owner => dirtyRef.current || (formDirtyRef.current && (!owner || draftActionsRef.current?.owner !== owner)) || pendingCommitCountRef.current > 0 || navigation.hasOpenDraft(owner)), [workspace.registerDraftPresence, navigation.hasOpenDraft])
  const destination = routeDestination(navigation.route)
  const accountOpen = navigation.route.page.page === 'settings' && navigation.route.page.section === 'account'
  const dataOpen = navigation.route.page.page === 'settings' && !accountOpen
  const searchOpen = navigation.route.overlays.some(overlay => overlay.kind === 'search')
  const wasSearchOpen = useRef(searchOpen)
  useEffect(() => {
    // Search recovery first owns dialog focus, then exposes the editor's pending choices on return
    if (wasSearchOpen.current && !searchOpen && navigationWarning) revealNavigationWarning()
    wasSearchOpen.current = searchOpen
  }, [navigationWarning, revealNavigationWarning, searchOpen])
  const openData = useCallback(() => {
    navigation.navigate({ page: { page: 'settings', section: 'data' }, overlays: [], query: {} })
  }, [navigation])
  const closeData = useCallback(() => { navigation.close() }, [navigation])

  useEffect(() => {
    let live = true
    recordWorkspaceStartup(WORKSPACE_STARTUP_PHASE.plannerLoading)
    void loadLocalData().then((loaded) => {
      if (!live) return
      recordWorkspaceStartup(WORKSPACE_STARTUP_PHASE.plannerLoaded)
      loadedDataRef.current = loaded
      persistedRevisionRef.current = loaded.localData.revision
      setLoadedData(loaded)
      if (initialLanding.current && BUNDLED_MOD_LIBRARY.length > 0 && loaded.localData.modSetup?.state === 'pending') setModSelectorOpen(true)
    }).catch((error: unknown) => { if (live) setLoadingError(formatAppError(error, 'Local records could not be opened.')) })
    return () => { live = false }
  }, [])

  const startupCommitted = useRef(false)
  useLayoutEffect(() => {
    // Repository admission precedes planner loading and React's DOM commit; it is not UI readiness
    // Only mark the initial view, without retaining data or instrumenting ordinary saves
    if (!loadedData || startupCommitted.current) return
    startupCommitted.current = true
    recordWorkspaceStartup(WORKSPACE_STARTUP_PHASE.plannerCommitted)
  }, [loadedData])

  const setFormDraftDirty = useCallback<DraftChangeHandler>((value, actions) => {
    formDirtyRef.current = value
    draftActionsRef.current = value ? actions : undefined
    setFormDirty(value)
    if (!value) { pendingNavigationRef.current = undefined; setNavigationWarning(undefined) }
  }, [])
  const setBuildDraftDirty: DraftChangeHandler = (value, actions) => {
    buildDraftRouteRef.current = value ? routeWithoutOverlays(navigation.route) : undefined
    setFormDraftDirty(value, actions)
  }
  const resolveDraftNavigation = useCallback(async (resolution: 'save' | 'discard') => {
    const actions = draftActionsRef.current
    const destination = pendingNavigationRef.current
    if (!actions || !destination) return
    setResolvingDraft(true)
    try {
      if (resolution === 'save') { workspace.captureEditorNavigation(destination, actions.owner); workspace.captureSaveNavigation(destination, actions.owner) }
      const resolved = resolution === 'save' ? await actions.save() : (await actions.discard()) !== false
      if (resolved && workspace.isCurrent()) navigation.navigate(destination)
    } finally { setResolvingDraft(false) }
  }, [navigation])

  useEffect(() => {
    const preventLoss = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current && !formDirtyRef.current && pendingCommitCountRef.current === 0) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', preventLoss)
    return () => window.removeEventListener('beforeunload', preventLoss)
  }, [])

  const localDataReady = loadedData !== undefined
  useEffect(() => {
    if (!localDataReady) return
    return subscribeLocalData((notification) => {
      const current = loadedDataRef.current
      // A first pull can adopt another planner ID at revision zero; source-only pulls can also keep the revision
      if (!current || (notification.reason !== 'sync' && (notification.localDataId !== current.localData.id || notification.revision <= current.localData.revision))) return
      setExternalUpdate(true)
    })
  // The repository replays its latest remote hint on subscribe; loading that hint must not resubscribe
  }, [localDataReady, subscribeLocalData])

  const commitLocalData = useCallback((transform: (localData: LocalData) => LocalData, options: { rollbackOnFailure?: boolean; showSavingState?: boolean; deferUntilPaint?: boolean; validateOnCommitOnly?: boolean } = {}) => {
    if (workspace.fileCommandPending() || !workspace.isCurrent()) return Promise.reject(new Error('Finish saving the open file before changing planner records.'))
    pendingCommitCountRef.current += 1
    // Tile queues suppress saving chrome, but cannot claim durability until every local intent settles
    setPendingCommitCount(pendingCommitCountRef.current)
    const run = async () => {
      if (options.deferUntilPaint) await waitForNextPaint()
      const current = loadedDataRef.current
      if (!current) throw new Error('The local planner data is not ready.')
      // A retained failed draft is a recovery boundary; applying another transform would obscure unsaved intent
      if (dirtyRef.current) throw new Error('A failed save has pending changes. Close this form, then use Retry save or export a recovery backup before editing again.')
      let optimistic: LoadedLocalData | undefined
      try {
        const nextLocalData = transform(current.localData)
        if (nextLocalData === current.localData) return
        // Progress and other planner-only saves keep the same setups, so reuse their expanded catalogs
        const catalogs = nextLocalData.gameSetups === current.localData.gameSetups
          ? current.catalogs
          : await prepareModCatalogs(nextLocalData, current.catalogs)
        // Immediate progress saves avoid a second full graph walk; persistence validates before writing
        if (!options.validateOnCommitOnly) validateLocalDataForStorage(nextLocalData, catalogs)
        optimistic = { ...current, catalogs, localData: nextLocalData, revision: nextLocalData.revision }
        loadedDataRef.current = optimistic
        setLoadedData(optimistic)
        dirtyRef.current = true
        setDirty(true)
        if (options.showSavingState !== false) setSaveState('saving')
        setSaveError(undefined)
        const write = await saveLocalDataWithStatus(nextLocalData, persistedRevisionRef.current)
        const saved = write.localData
        const committed = { ...optimistic, localData: saved, revision: saved.revision, canUndo: write.canUndo }
        loadedDataRef.current = committed
        persistedRevisionRef.current = saved.revision
        setLoadedData(committed)
        dirtyRef.current = false
        setDirty(false)
        setSaveState('saved')
      } catch (error) {
        const message = formatAppError(error, 'The change could not be saved.')
        setSaveError(message)
        if (optimistic && options.rollbackOnFailure) {
          loadedDataRef.current = current
          setLoadedData(current)
          dirtyRef.current = false
          setDirty(false)
        }
        setSaveState(optimistic && !options.rollbackOnFailure ? 'error' : 'saved')
        throw error
      }
    }
    // Read and transform the latest state when the serialized task runs, not when its click was rendered
    const queued = commitQueueRef.current.then(run, run)
    // Recover the queue tail while returning the original rejection to the action's failure UI
    commitQueueRef.current = queued.catch(() => undefined)
    const settle = () => {
      pendingCommitCountRef.current = Math.max(0, pendingCommitCountRef.current - 1)
      if (options.showSavingState !== false) workspace.flushSync()
      setPendingCommitCount(pendingCommitCountRef.current)
    }
    void queued.then(settle, settle)
    return queued
  }, [])

  const retrySave = useCallback(() => {
    if (workspace.fileCommandPending() || !workspace.isCurrent()) return Promise.reject(new Error('The captured planner is not ready for another save.'))
    const run = async () => {
      const current = loadedDataRef.current
      if (!current || !dirtyRef.current) return
      setSaveState('saving')
      setSaveError(undefined)
      try {
        const write = await saveLocalDataWithStatus(current.localData, persistedRevisionRef.current)
        const saved = write.localData
        const committed = { ...current, localData: saved, revision: saved.revision, canUndo: write.canUndo }
        loadedDataRef.current = committed
        persistedRevisionRef.current = saved.revision
        dirtyRef.current = false
        setLoadedData(committed)
        setDirty(false)
        setSaveState('saved')
      } catch (reason) {
        setSaveError(formatAppError(reason, 'The save retry failed.'))
        setSaveState('error')
        throw reason
      }
    }
    const queued = commitQueueRef.current.then(run, run)
    commitQueueRef.current = queued.catch(() => undefined)
    return queued
  }, [])

  const addInventory = useCallback(async (draft: InventoryDraft) => commitLocalData((localData) => {
    let next = localData
    let ref = draft.ref
    if (!ref) {
      const created = addPersonalRef(next, draft.name, 'item')
      next = created.localData
      ref = created.ref
    }
    return observeInventory(next, { ref, observedName: draft.name, possession: draft.possession, quantity: draft.quantity, favorite: draft.favorite, protectedQuantity: draft.protectedQuantity, wishlist: draft.wishlist, note: draft.note, observedAt: nullableTimestamp(draft.observedAt), expectedRevision: next.revision })
  }), [commitLocalData])

  const updateInventory = useCallback(async (positionId: string, draft: InventoryDraft) => commitLocalData((localData) => {
    const current = requirePlaythrough(localData).inventory[positionId]
    if (!current) throw new Error('This inventory entry no longer exists.')
    let next = localData
    let ref = draft.ref
    if (!ref) {
      const created = addPersonalRef(next, draft.name, 'item')
      next = created.localData
      ref = created.ref
    }
    if (entityDefinitionKey(current.ref) !== entityDefinitionKey(ref)) next = linkInventoryPosition(next, { positionId: current.id, ref, expectedRevision: next.revision })
    return observeInventory(next, { positionId: current.id, ref, observedName: draft.name, possession: draft.possession, quantity: draft.quantity, favorite: draft.favorite, protectedQuantity: draft.protectedQuantity, wishlist: draft.wishlist, note: draft.note ?? '', observedAt: nullableTimestamp(draft.observedAt), expectedRevision: next.revision })
  }), [commitLocalData])

  const addInventoryEvent = useCallback(async (draft: InventoryEventDraft) => commitLocalData((localData) => {
    const created = draft.ref ? { localData, ref: draft.ref } : addPersonalRef(localData, draft.name, 'item')
    return recordInventoryEvent(created.localData, { ref: created.ref, observedName: draft.name, kind: draft.kind, quantity: draft.quantity, observedAt: currentTimestamp(draft.observedAt), note: draft.note, expectedRevision: created.localData.revision })
  }), [commitLocalData])

  const addCharacter = useCallback(async (draft: CharacterDraft) => commitLocalData((localData) => createCharacter(localData, { name: draft.name, appearanceLabel: draft.appearanceLabel, expectedRevision: localData.revision })), [commitLocalData])

  const captureSnapshot = useCallback(async (characterId: CharacterId, draft: SnapshotDraft) => commitLocalData((localData) => captureCharacter(localData, { characterId, gameSetupRevisionId: draft.gameSetupRevisionId, level: draft.level, primaryClass: draft.primaryClass, secondaryClass: draft.secondaryClass, displayedStats: draft.displayedStats, equipment: draft.equipment, passives: draft.passives, calculation: draft.calculation, observedAt: currentTimestamp(draft.observedAt), note: draft.note, expectedRevision: localData.revision })), [commitLocalData])

  const upsertCharacterClass = useCallback(async (characterId: CharacterId, draft: ClassProgressDraft) => commitLocalData((localData) => upsertCharacterClassProgress(localData, { characterId, ...draft, expectedRevision: localData.revision })), [commitLocalData])

  const importCharacterScreenshots = useCallback(async (captures: readonly ReviewedSkillTree[], expectedRevision: number) => commitLocalData((localData) => importSkillTrees(localData, loadedDataRef.current?.catalogs ?? [], captures, expectedRevision)), [commitLocalData])

  const upsertCharacterLearning = useCallback(async (characterId: CharacterId, draft: LearnedNodeDraft) => commitLocalData((localData) => upsertLearnedNode(localData, { characterId, ...draft, expectedRevision: localData.revision })), [commitLocalData])

  const saveDefinition = useCallback(async (draft: DefinitionEditorDraft): Promise<EntityRef> => {
    const definitionId = createId<PersonalDefinitionId>('definition')
    await commitLocalData((localData) => {
      if (draft.baseRef) {
        return revisePersonalDefinition(localData, {
          id: definitionId,
          sourceRef: draft.baseRef,
          name: draft.name,
          aliases: draft.aliases,
          rawDescription: draft.rawDescription,
          fieldUpdates: draft.fieldUpdates,
          expectedRevision: localData.revision,
        }).localData
      }
      return createPersonalDefinition(localData, {
        id: definitionId,
        kind: draft.kind,
        name: draft.name,
        aliases: draft.aliases,
        rawDescription: draft.rawDescription ?? undefined,
        fields: Object.fromEntries(Object.entries(draft.fieldUpdates ?? {}).filter((entry): entry is [string, Knowledge<JsonValue>] => entry[1] !== null)),
        expectedRevision: localData.revision,
      })
    }, { rollbackOnFailure: true })
    return { kind: 'personal', definitionId }
  }, [commitLocalData])

  const promoteDefinitions = useCallback(async (sourceGameSetupRevisionId: GameSetupRevisionId, definitionRefs: readonly EntityRef[], label: string): Promise<void> => {
    const personalRefs = definitionRefs.filter((ref) => ref.kind === 'personal')
    if (personalRefs.length !== definitionRefs.length) throw new Error('Only personal definitions can be collected into a Game Setup revision')
    await commitLocalData((localData) => coalesceDefinitionOverrides(localData, {
      sourceGameSetupRevisionId,
      definitionRefs: personalRefs,
      label,
      activate: false,
      expectedRevision: localData.revision,
    }))
  }, [commitLocalData])

  const addProgress = useCallback(async (draft: ProgressDraft) => commitLocalData((localData) => {
    const created = draft.subject ? { localData, ref: draft.subject } : addPersonalRef(localData, draft.name, 'class')
    return upsertProgress(created.localData, { id: createId<ProgressRecordId>('progress'), subject: created.ref, displayName: draft.name, stage: draft.stage, unlocked: draft.unlocked, partyMastery: draft.partyMastery, collection: draft.collection, masterLocation: draft.masterLocation, observedAt: nullableTimestamp(draft.observedAt), expectedRevision: created.localData.revision })
  }), [commitLocalData])

  const advanceProgress = useCallback(async (subject: EntityRef, displayName: string) => commitLocalData((localData) => advanceClassSealProgress(localData, { subject, displayName, expectedRevision: localData.revision }), INTERACTIVE_PROGRESS_COMMIT), [commitLocalData])

  const setAcquiredProgress = useCallback(async (subject: EntityRef, displayName: string, acquired: boolean) => commitLocalData((localData) => setAcquisitionProgress(localData, { subject, displayName, acquired, expectedRevision: localData.revision }), INTERACTIVE_PROGRESS_COMMIT), [commitLocalData])

  const setProgressStage = useCallback(async (selections: readonly ClassSealProgressSelection[], stage: ProgressStage) => commitLocalData((localData) => setClassSealProgressBatch(localData, { selections, stage, expectedRevision: localData.revision }), INTERACTIVE_PROGRESS_COMMIT), [commitLocalData])

  const toggleQuintarProgress = useCallback(async (stepId: QuintarBreedingStepId) => {
    const playthroughId = loadedDataRef.current?.localData.selectedPlaythroughId
    if (!playthroughId) throw new Error('Select a playthrough before recording quintar progress.')
    await commitLocalData(localData => toggleQuintarStep(localData, { stepId, playthroughId, expectedRevision: localData.revision }), { rollbackOnFailure: true, showSavingState: false, validateOnCommitOnly: true })
  }, [commitLocalData])

  const toggleSummon = useCallback(async (summonId: SummonId) => {
    const data = loadedDataRef.current
    if (!data) throw new Error('Select a playthrough before recording summons.')
    const playthroughId = requirePlaythrough(data.localData).id
    const entry = summonEntries(data.localData, data.catalogs).find(entry => entry.summon.id === summonId)
    if (!entry) throw new Error('The summon reference is unavailable. Restore the bundled catalog and try again.')
    await commitLocalData(localData => toggleSummonProgress(localData, { summonId, subject: entry.subject, displayName: entry.summon.label, playthroughId, expectedRevision: localData.revision }), { ...INTERACTIVE_PROGRESS_COMMIT, rollbackOnFailure: true })
  }, [commitLocalData])

  const updateProgressRecord = useCallback(async (recordId: ProgressRecordId, draft: ProgressDraft) => commitLocalData((localData) => {
    const current = requirePlaythrough(localData).progress[recordId]
    if (!current) throw new Error('This progress record no longer exists.')
    return upsertProgress(localData, { id: current.id, subject: current.subject, displayName: draft.name, stage: draft.stage, unlocked: draft.unlocked, partyMastery: draft.partyMastery, collection: draft.collection, masterLocation: draft.masterLocation, observedAt: nullableTimestamp(draft.observedAt), expectedRevision: localData.revision })
  }), [commitLocalData])

  const addBuild = useCallback(async (draft: BuildDraft, revision: RevisionDraft) => {
    const buildId = draft.id
    const revisionId = draft.revisionId
    const { note, behavior, behaviorRevisionId, ...content } = revision
    await commitLocalData((current) => {
      if (current.buildRevisions[revisionId]?.buildId === buildId) return current
      const configured = saveBuildBehavior(current, behavior, undefined, behaviorRevisionId)
      const created = createBuild(configured.localData, { id: buildId, title: draft.title, tags: draft.tags, gameSetupId: configured.setup.gameSetupId, expectedRevision: configured.localData.revision })
      return saveBuildRevision(created, { buildId, id: revisionId, content: buildContentForModSetup(content, configured.setup, loadedDataRef.current!.catalogs, behavior), note, gameSetupRevisionId: configured.setup.id, expectedRevision: created.revision })
    })
    return { buildId, revisionId }
  }, [commitLocalData])

  const cloneExistingBuild = useCallback(async (buildId: string) => {
    const clonedId = createId<BuildId>('build')
    const clonedRevisionId = createId<BuildRevisionId>('buildRevision')
    await commitLocalData((localData) => cloneBuild(localData, { sourceBuildId: asId<BuildId>(buildId), id: clonedId, revisionId: clonedRevisionId, expectedRevision: localData.revision }))
    return clonedId
  }, [commitLocalData])

  const saveBuildDetails = useCallback(async (buildId: string, patch: BuildDetailsPatch) => {
    await commitLocalData((localData) => updateBuild(localData, { buildId: asId<BuildId>(buildId), ...patch, expectedRevision: localData.revision }), { rollbackOnFailure: true })
  }, [commitLocalData])

  const saveRevision = useCallback(async (buildId: string, draft: RevisionDraft, parentRevisionId?: string): Promise<BuildRevisionId> => {
    const revisionId = createId<BuildRevisionId>('buildRevision')
    await commitLocalData((current) => {
      const configured = saveBuildBehavior(current, draft.behavior, undefined, draft.behaviorRevisionId)
      const localData = configured.localData
      const build = localData.builds[buildId]
      if (!build) throw new Error('The selected Build no longer exists.')
      const gameSetupRevisionId = configured.setup.id
      return saveBuildRevision(localData, { buildId: asId<BuildId>(buildId), id: revisionId, parentRevisionId: parentRevisionId ? asId<BuildRevisionId>(parentRevisionId) : build.latestRevisionId, gameSetupRevisionId, content: retainOutOfContextSelections(localData, buildContentForModSetup({ primaryClass: draft.primaryClass, secondaryClass: draft.secondaryClass, equipment: draft.equipment, passives: draft.passives, rotationNotes: draft.rotationNotes, contextAssumptions: draft.contextAssumptions, calculation: draft.calculation, referenceNames: draft.referenceNames, retainedSelections: draft.retainedSelections }, configured.setup, loadedDataRef.current!.catalogs, draft.behavior), configured.setup, configured.setup.catalogLock), note: draft.note, expectedRevision: localData.revision })
    })
    return revisionId
  }, [commitLocalData])

  const saveCopiedCheckpoint = useCallback<SaveCopiedCheckpoint>(async (viewer, input) => {
    let checkpoint: Awaited<ReturnType<SaveCopiedCheckpoint>> | undefined
    await commitLocalData(current => {
      // The viewer supplies inert source evidence, never permission to adopt a newer planner
      if (current.id !== viewer.planner.localData.id || current.revision !== viewer.planner.localData.revision) throw new Error('The workspace changed. Reopen the copied checkpoint before saving.')
      const result = editCopiedCheckpoint({ ...viewer, planner: { ...viewer.planner, localData: current, catalogs: loadedDataRef.current!.catalogs } }, input)
      checkpoint = result.checkpoint
      return result.localData
    }, { rollbackOnFailure: true })
    if (!checkpoint) throw new Error('The checkpoint was not saved.')
    return checkpoint
  }, [commitLocalData])

  const addScenario = useCallback(async (draft: ScenarioDraft) => commitLocalData((localData) => {
    const playthrough = requirePlaythrough(localData)
    const revision = draft.buildRevisionId ? localData.buildRevisions[draft.buildRevisionId] : undefined
    if (draft.buildRevisionId && !revision) throw new Error('The requested build revision is unavailable.')
    const gameSetupRevisionId = revision?.gameSetupRevisionId ?? localData.planningGameSetupRevisionId
    if (!gameSetupRevisionId) throw new Error('Configure a Game Setup before creating a team scenario.')
    const memberIds = draft.memberIds.map(memberId => asId<CharacterId>(memberId))
    let baseline: Parameters<typeof createScenario>[1]['baseline'] = { kind: 'empty' }
    if (draft.baseline === 'recordedParty') {
      const recorded = Object.values(playthrough.scenarios).find((scenario) => scenario.kind === 'recordedCurrent')
      const gameSetup = localData.gameSetups[gameSetupRevisionId]
      const sameLock = recorded && gameSetup && catalogLocksMatch(recorded.catalogLock, revision?.catalogLock ?? gameSetup.catalogLock)
      const assignments = recorded ? effectiveScenarioAssignments(recorded) : {}
      if (!recorded || !sameBuildBehavior(localData.gameSetups[recorded.gameSetupRevisionId], gameSetup) || !sameLock || !Object.keys(assignments).length) throw new Error('The recorded party does not match this Game Setup and catalog version.')
      baseline = { kind: 'recordedParty', playthroughRevision: playthrough.revision, assignments }
    }
    const firstMemberId = memberIds[0]
    const assignments = revision && firstMemberId ? { [firstMemberId]: revision.id } : undefined
    return createScenario(localData, { label: draft.label, kind: draft.kind, memberIds, baseline, assignments, gameSetupRevisionId, catalogLock: revision?.catalogLock, inventoryPolicy: { enforceStock: draft.enforceStock, includeProtected: draft.includeProtected }, activate: true, expectedRevision: localData.revision })
  }), [commitLocalData])

  const assignScenario = useCallback(async (scenarioId: string, characterId: string, revisionId: string) => commitLocalData((localData) => replaceScenarioBuild(localData, { scenarioId: asId<ScenarioId>(scenarioId), characterId: asId<CharacterId>(characterId), buildRevisionId: revisionId ? asId<BuildRevisionId>(revisionId) : null, expectedRevision: localData.revision })), [commitLocalData])

  const recordBuildCurrent = useCallback(async (buildId: string, revisionId: string, characterId: string) => commitLocalData(localData => {
    if (localData.buildRevisions[revisionId]?.buildId !== buildId) throw new Error('The requested build checkpoint is unavailable.')
    return recordBuildForCharacter(localData, { buildRevisionId: asId<BuildRevisionId>(revisionId), characterId: asId<CharacterId>(characterId), expectedRevision: localData.revision })
  }, { rollbackOnFailure: true }), [commitLocalData])

  const savePlanningTeam = useCallback(async (input: SaveTeamInput) => {
    const id = input.id ?? createId<TeamId>('team')
    await commitLocalData(localData => saveTeam(localData, { ...input, id, expectedRevision: localData.revision }), { rollbackOnFailure: true })
    return id
  }, [commitLocalData])

  const deletePlanningTeam = useCallback(async (teamId: TeamId) => {
    await commitLocalData(localData => deleteTeam(localData, { teamId, expectedRevision: localData.revision }), { rollbackOnFailure: true })
  }, [commitLocalData])

  const savePlanningTeamMember = useCallback(async (input: Omit<SaveTeamMemberInput, 'revisionId' | 'expectedRevision'>) => {
    const revisionId = input.build?.revisionId ?? createId<BuildRevisionId>('buildRevision')
    let buildId: BuildId | undefined
    let savedRevisionId = revisionId
    await commitLocalData(localData => {
      const next = saveTeamMember(localData, { ...input, revisionId, expectedRevision: localData.revision }, loadedDataRef.current!.catalogs)
      const team = input.team.id ? next.teams[input.team.id] : Object.values(next.teams).find(team => !localData.teams[team.id])
      if (!team || team.kind !== 'shared') throw new Error('The Team checkpoint was not saved')
      savedRevisionId = teamSlots(next, team)[input.slotIndex]!
      buildId = checkpointBuildView(next, { kind: 'team-slot', teamRevisionId: team.latestRevisionId, slot: input.slotIndex as 0 | 1 | 2 | 3 })!.buildId
      return next
    }, { rollbackOnFailure: true })
    return { buildId: buildId!, revisionId: savedRevisionId }
  }, [commitLocalData])

  const savePlanningTeamSlotAsBuild = useCallback(async (teamRevisionId: import('./domain/types').TeamRevisionId, slot: 0 | 1 | 2 | 3, title: string) => {
    await commitLocalData(localData => saveTeamSlotAsBuild(localData, { teamRevisionId, slot, title, expectedRevision: localData.revision }), { rollbackOnFailure: true })
  }, [commitLocalData])

  const adoptPlanningTeam = useCallback(async (teamId: TeamId, characterIds: readonly CharacterId[]) => {
    await commitLocalData(localData => adoptTeam(localData, { teamId, characterIds, expectedRevision: localData.revision }), { rollbackOnFailure: true })
  }, [commitLocalData])

  const saveGameSetup = useCallback(async (draft: GameSetupDraft, options: GameSetupSaveOptions) => {
    const defaults = !draft.sourceGameSetupRevisionId && !draft.modComposition ? await repository.readWorkspace() : undefined
    return commitLocalData((localData) => {
      // Default pins and the saved setup must use the same workspace revision
      if (defaults && localData.revision !== defaults.planner.localData.revision) throw new Error('The workspace changed. Reopen Game Setup creation and try again')
      const slots: SlotDefinition[] = draft.slots.map((slot, index) => ({ id: slot.id ?? createId<SlotId>('slot'), label: slot.label, kind: 'equipment', order: index, equipmentRole: slot.equipmentRole, acceptedEntityKinds: slot.acceptedEntityKinds, provenance: slot.provenance, sources: slot.sources }))
      const sourceRevisionId = draft.sourceGameSetupRevisionId
      const source = sourceRevisionId ? localData.gameSetups[sourceRevisionId] : undefined
      const catalogLock = { [CURRENT_CATALOG.id]: CURRENT_CATALOG.revisionId, ...source?.catalogLock }
      const behavior: BuildBehavior = { label: draft.label, platform: draft.platform, gameVersion: draft.gameVersion, mode: draft.mode, difficulty: draft.difficulty, mods: draft.mods, disabledMods: draft.disabledMods, customMods: draft.customMods, ppLimit: draft.ppLimit, ppCostsNonNegative: draft.ppCostsNonNegative, slots, catalogLock, modComposition: draft.modComposition, definitionOverrides: draft.definitionOverrides }
      const configured = defaults ? applyLibraryDefaultsToNewSetup(behavior, defaults.libraryDefaults, defaults.planner.catalogs) : behavior
      const values = { ...configured, id: options.id, activate: false, expectedRevision: localData.revision }
      return sourceRevisionId ? updateGameSetupRevision(localData, { sourceRevisionId, ...values }) : createGameSetupRevision(localData, values)
    })
  }, [commitLocalData, repository])

  const installLoadedData = useCallback((loaded: LoadedLocalData, preserveFormDraft = false) => {
    loadedDataRef.current = loaded
    persistedRevisionRef.current = loaded.localData.revision
    dirtyRef.current = false
    if (!preserveFormDraft) {
      formDirtyRef.current = false
      buildDraftRouteRef.current = undefined
      setFormDirty(false)
    }
    setLoadedData(loaded)
    setDirty(false)
    setSaveState('saved')
    setSaveError(undefined)
    setExternalUpdate(false)
  }, [])

  const waitForSafeTransition = useCallback(async () => {
    await commitQueueRef.current
    if (dirtyRef.current || formDirtyRef.current || navigation.hasOpenDraft()) throw new Error('Save or discard edits and resolve failed saves before switching Playthrough, Game Setup, or party plan.')
  }, [navigation.hasOpenDraft])

  const createLocalPlaythrough = useCallback(async (label: string, setupId?: GameSetupRevisionId) => {
    await waitForSafeTransition()
    const defaults = setupId ? undefined : await repository.readWorkspace()
    await commitLocalData((localData) => {
      // Another queued change may replace the catalog list after the defaults read
      if (defaults && localData.revision !== defaults.planner.localData.revision) throw new Error('The workspace changed. Reopen Playthrough creation and try again')
      return createPlaythroughWithSetup(localData, { label, currentGameSetupRevisionId: setupId, catalogLock: { [CURRENT_CATALOG.id]: CURRENT_CATALOG.revisionId }, select: true, expectedRevision: localData.revision, ...(defaults ? { defaultMods: { defaults: defaults.libraryDefaults, catalogs: defaults.planner.catalogs } } : {}) })
    })
  }, [commitLocalData, repository, waitForSafeTransition])

  const selectLocalPlaythrough = useCallback(async (playthroughId: PlaythroughId) => {
    await waitForSafeTransition()
    await commitLocalData((localData) => selectPlaythrough(localData, { playthroughId, expectedRevision: localData.revision }))
  }, [commitLocalData, waitForSafeTransition])

  const selectContextPlaythrough = useCallback(async (playthroughId: PlaythroughId) => {
    if (loadedDataRef.current?.localData.selectedPlaythroughId === playthroughId) return
    await selectLocalPlaythrough(playthroughId)
    navigation.navigate(routeForDestination(destination), { replace: true })
  }, [destination, navigation, selectLocalPlaythrough])

  const selectGameSetup = useCallback(async (gameSetupRevisionId: GameSetupRevisionId) => {
    await waitForSafeTransition()
    await commitLocalData((localData) => setPlaythroughGameSetup(localData, { gameSetupRevisionId, expectedRevision: localData.revision }))
  }, [commitLocalData, waitForSafeTransition])

  const selectScenario = useCallback(async (scenarioId: ScenarioId | null) => {
    await waitForSafeTransition()
    await commitLocalData((localData) => activateScenario(localData, { scenarioId, expectedRevision: localData.revision }))
  }, [commitLocalData, waitForSafeTransition])

  const undoLatestChange = useCallback(async () => {
    await waitForSafeTransition()
    const current = loadedDataRef.current
    if (!current) throw new Error('The local planner data is not ready.')
    const write = await undoLocalDataWithStatus(persistedRevisionRef.current)
    installLoadedData({ ...current, localData: write.localData, revision: write.localData.revision, canUndo: write.canUndo })
  }, [installLoadedData, waitForSafeTransition])

  const handlePreview = useCallback(async (bytes: Uint8Array, filename: string) => {
    setImportBusy(true); setImportError(undefined)
    try {
      const preview = await previewImport(bytes, filename)
      setImportPreview(preview)
      navigation.navigate({ page: { page: 'settings', section: 'data', previewId: preview.id }, overlays: [], query: {} }, { replace: true })
    } catch (error) { setImportError(formatAppError(error, 'The selected file could not be previewed.')) } finally { setImportBusy(false) }
  }, [navigation])

  const handleImport = useCallback(async (preview: ImportPreview, mode: ImportCommitMode) => {
    setImportBusy(true); setImportError(undefined)
    let committed = false
    try {
      await waitForSafeTransition()
      const current = loadedDataRef.current
      if (!current) throw new Error('The local planner data is not ready.')
      const loaded = await commitImport(preview, { mode, targetLocalDataId: current.localData.id, expectedRevision: persistedRevisionRef.current })
      committed = true
      // Guest bulk publication retires the old writer; keep import busy until its exact successor is installed
      if (repository.kind === 'guest') await workspace.reopenGuest()
      installLoadedData(loaded); setImportPreview(undefined); closeData()
    } catch (error) { setImportError(committed ? `The import was saved. Reopen the selected workspace to continue. ${formatAppError(error, 'Reopening is pending.')}` : formatAppError(error, 'The import could not be committed.')) } finally { setImportBusy(false) }
  }, [closeData, installLoadedData, waitForSafeTransition, repository, workspace.reopenGuest])

  const saveModDraft = useCallback(async (text: string, filename: string, expectedCatalogId?: CatalogId, includeInReference = false, futureDefault = false, editorOwner?: symbol) => {
    setImportBusy(true)
    let committed = false
    try {
      const preview = await previewImport(new TextEncoder().encode(text), filename)
      const revision = preview.proposed.catalogs[0] && modRevision(preview.proposed.catalogs[0])
      if (preview.detectedFormat !== CRYSTAL_EDIT_FORMAT || !revision) throw new Error('This draft needs a valid Crystal Edit project ID and structure before saving to the mod library.')
      assertLibraryProject(revision.catalogId, expectedCatalogId)
      await waitForSafeTransition()
      const current = loadedDataRef.current
      if (!current) throw new Error('The local planner data is not ready.')
      const unchanged = current.catalogs.some(catalog => catalog.id === revision.catalogId && catalog.revisionId === revision.catalogRevisionId)
      const result = { title: revision.title, unchanged, warnings: preview.warnings.map(warning => warning.message) }
      if (editorOwner) {
        await workspace.importEditorSource(preview, { id: current.localData.id, revision: persistedRevisionRef.current }, editorOwner, result)
        return result
      }
      await importLibrarySource(repository, preview, { inReference: includeInReference, futureDefault })
      committed = true
      // Finish the captured successor admission before another library import can use the old catalogs
      if (repository.kind === 'guest') await workspace.reopenGuest(false, { saved: result, futureDefault })
      else installLoadedData(await repository.load())
      return { title: revision.title, unchanged, warnings: preview.warnings.map(warning => warning.message) }
    } catch (error) {
      if (committed) throw new Error(`The mod files were saved. Reopen the selected workspace to continue. ${formatAppError(error, 'Reopening is pending.')}`)
      throw error
    } finally { setImportBusy(false) }
  }, [installLoadedData, repository, waitForSafeTransition, workspace.reopenGuest, workspace.importEditorSource])

  const saveFolderSource = useCallback(async (preview: FolderImportPreview, selection: FolderSelection) => {
    setImportBusy(true)
    let committed = false
    try {
      await waitForSafeTransition()
      if (!loadedDataRef.current) throw new Error('The local planner data is not ready.')
      const receipts = await confirmModFolder(repository, preview, selection)
      committed = true
      // Folder contents share one publication and must finish the same successor handoff
      if (repository.kind === 'guest') await workspace.reopenGuest()
      else installLoadedData(await repository.load())
      return receipts
    } catch (error) {
      if (committed) throw new Error(`The mod files were saved. Reopen the selected workspace to continue. ${formatAppError(error, 'Reopening is pending.')}`)
      throw error
    } finally { setImportBusy(false) }
  }, [installLoadedData, repository, waitForSafeTransition, workspace.reopenGuest])

  const importSharedMod = useCallback(async (preview: ImportPreview, encoded: string) => {
    await waitForSafeTransition()
    const current = loadedDataRef.current
    if (!current) throw new Error('The local planner data is not ready.')
    const source = preview.proposed.catalogs[0]
    if (!source) throw new Error('The matching JSON has no mod source.')
    const loaded = await commitImport(preview, { mode: 'add-reference', targetLocalDataId: current.localData.id, expectedRevision: persistedRevisionRef.current })
    // Publication retires the guest view; carry only completed feedback through its admitted successor
    if (repository.kind === 'guest') await workspace.reopenGuest(false, { sharedSnapshot: encoded, source: { catalogId: source.id, catalogRevisionId: source.revisionId, title: modCatalogTitle(source) } })
    else installLoadedData(loaded)
  }, [installLoadedData, waitForSafeTransition, commitImport, repository.kind, workspace.reopenGuest])

  const importBuildMod = useCallback(async (preview: ImportPreview) => {
    await commitQueueRef.current
    if (dirtyRef.current || pendingCommitCountRef.current) throw new Error('Finish the pending planner save before importing mod JSON.')
    const current = loadedDataRef.current
    if (!current) throw new Error('The local planner data is not ready.')
    await workspace.importBuildSource(preview, { id: current.localData.id, revision: persistedRevisionRef.current })
  }, [workspace])

  const loadBuildModSource = useCallback(async (mod: BundledLibraryMod) => {
    setImportBusy(true)
    try {
      const source = await bundledModEditableSource(mod)
      const preview = await previewImport(new TextEncoder().encode(source.text), source.filename)
      const catalog = preview.proposed.catalogs[0]
      if (!catalog || catalog.id !== mod.id || !modRevision(catalog)) throw new Error('The bundled source does not match this mod project.')
      await commitQueueRef.current
      if (dirtyRef.current) throw new Error('Retry the failed local save before loading a mod source.')
      const current = loadedDataRef.current
      if (!current) throw new Error('The local planner data is not ready.')
      if (current.catalogs.some(saved => saved.id === catalog.id && saved.revisionId === catalog.revisionId)) return catalog
      const loaded = await commitImport(preview, { mode: 'add-reference', targetLocalDataId: current.localData.id, expectedRevision: persistedRevisionRef.current })
      installLoadedData(loaded, true)
      return catalog
    } finally { setImportBusy(false) }
  }, [installLoadedData])

  const applyModSetup = useCallback(async (ids: readonly CatalogId[]) => {
    await waitForSafeTransition()
    setImportBusy(true)
    try {
      const previews: ImportPreview[] = []
      for (const id of ids) {
        const mod = BUNDLED_MOD_LIBRARY.find(mod => mod.id === id)
        if (!mod) throw new Error('The selected mod is unavailable in this bundled library.')
        const source = await bundledModEditableSource(mod)
        previews.push(await previewImport(new TextEncoder().encode(source.text), source.filename))
      }
      await waitForSafeTransition()
      installLoadedData(await commitModSetup(previews, persistedRevisionRef.current))
    } finally { setImportBusy(false) }
  }, [installLoadedData, waitForSafeTransition])

  const skipModSetup = useCallback(async () => {
    await waitForSafeTransition()
    installLoadedData(await commitModSetup([], persistedRevisionRef.current, true))
  }, [installLoadedData, waitForSafeTransition])

  const setReferenceMembership = useCallback(async (modId: string, included: boolean) => {
    await waitForSafeTransition()
    await commitLocalData(data => setModInReference(data, modId, included, data.revision), { rollbackOnFailure: true })
  }, [commitLocalData, waitForSafeTransition])

  const savePublicShare = useCallback(async (snapshot: PublicSnapshot) => {
    await waitForSafeTransition()
    const result = await copyPublicSnapshot(repository, snapshot)
    if (!workspace.isCurrent()) throw new Error('The copy was saved in its original workspace. Reopen that workspace to view it.')
    // Repository notifications only offer external updates; install this owned commit before its destination opens
    installLoadedData(result.loaded)
    return result
  }, [repository, installLoadedData, waitForSafeTransition, workspace.isCurrent])

  const saveShare = useCallback(async (payload: SharePayload) => {
    await waitForSafeTransition()
    let result: { readonly buildId?: BuildId; readonly teamId?: TeamId } = {}
    await commitLocalData(localData => {
      const copy = saveSharedCopy(localData, payload)
      result = { buildId: copy.buildId, teamId: copy.teamId }
      return copy.localData
    }, { rollbackOnFailure: true })
    return result
  }, [commitLocalData, waitForSafeTransition])

  const validations = useMemo(() => {
    if (!loadedData || !selectedPlaythrough(loadedData.localData)) return {}
    const index = catalogIndex(loadedData.catalogs)
    return Object.fromEntries(Object.values(requirePlaythrough(loadedData.localData).scenarios).map((scenario) => {
      try { return [scenario.id, validateScenario(loadedData.localData, scenario.id, index)] } catch { return [scenario.id, undefined] }
    })) as Readonly<Record<string, ValidationReport | undefined>>
  }, [loadedData])

  const loadExternalUpdate = useCallback(async () => {
    await waitForSafeTransition()
    if (repository.kind === 'account') { await workspace.reopenAccount(); return }
    await workspace.reopenGuest(true)
  }, [waitForSafeTransition, repository, workspace.reopenAccount, workspace.reopenGuest])

  const exportCurrentLocalData = useCallback(async () => {
    await commitQueueRef.current
    const current = loadedDataRef.current
    if (!current) throw new Error('The local planner data is not ready.')
    return exportBackup(dirtyRef.current ? current.localData : undefined)
  }, [])

  const exportCompleteWorkspace = useCallback(async () => {
    await downloadCapturedWorkspace(repository, async () => {
      await commitQueueRef.current
      if (dirtyRef.current) throw new Error('The planner has a failed save. Retry it or use the planner recovery copy before creating a complete backup.')
      if (formDirtyRef.current) {
        const actions = draftActionsRef.current
        if (!actions || !await actions.save()) throw new Error('An open form could not be saved. Your input is still open; save or recover it before exporting.')
      }
      // Owned file saves can remount App; the old callback must never follow the successor implicitly
      if (!workspace.isCurrent()) throw new Error('Your file was saved in a reopened workspace. Choose Export backup again.')
      if (formDirtyRef.current || pendingCommitCountRef.current || navigation.hasOpenDraft() || workspace.fileCommandPending()) throw new Error('Finish the open form or pending file operation before creating a complete backup.')
    })
  }, [repository, workspace, navigation])

  const clearWorkspaceRestore = useCallback(async () => {
    workspaceRestoreGeneration.current++
    const pending = workspaceRestoreRef.current
    workspaceRestoreRef.current = undefined
    if (pending) await disposeSelectedRestore(pending)
  }, [])

  const previewWorkspaceRestore = useCallback(async (file: File): Promise<CompleteWorkspaceRestorePreview> => {
    const token = repository.kind === 'account' ? workspace.token : undefined
    if (repository.kind === 'account' && !token) throw new Error('Open your account workspace before restoring a backup.')
    await waitForSafeTransition()
    if (workspace.fileCommandPending() || !workspace.isCurrent()) throw new Error('Finish saving the open file before restoring a backup.')
    const generation = ++workspaceRestoreGeneration.current
    const prior = workspaceRestoreRef.current
    workspaceRestoreRef.current = undefined
    if (prior) await disposeSelectedRestore(prior)
    const snapshot = await readWorkspaceBackup(workspaceBackupFile(file))
    let selected: SelectedRestore | undefined
    let database: AccountDatabase | undefined
    try {
      if (generation !== workspaceRestoreGeneration.current || !workspace.isCurrent() || (token && workspace.token !== token)) throw new Error('The workspace changed while reading the backup. Choose it again.')
      if (repository.kind === 'account') {
        if (!token) throw new Error('Open your account workspace before restoring a backup.')
        database = new AccountDatabase(token.accountId)
        const preview = await previewAccountWorkspaceRestore(database, token, snapshot)
        selected = { preview, snapshot, database, token }
      } else {
        const preview = await previewGuestWorkspaceRestore(repository, snapshot)
        selected = { preview, snapshot }
      }
      if (generation !== workspaceRestoreGeneration.current || !workspace.isCurrent() || (token && workspace.token !== token)) throw new Error('The workspace changed while preparing restore. Choose the backup again.')
      workspaceRestoreRef.current = selected
      return selected.preview
    } catch (error) {
      if (selected) await disposeSelectedRestore(selected)
      else { try { await disposeWorkspaceSnapshot(snapshot) } finally { database?.close() } }
      throw error
    }
  }, [repository, waitForSafeTransition, workspace])

  const activateWorkspaceRestore = useCallback(async (preview: CompleteWorkspaceRestorePreview): Promise<void> => {
    const pending = workspaceRestoreRef.current
    if (!pending || pending.preview !== preview || repository.kind !== preview.target) throw new Error('Choose the complete backup again before restoring.')
    const assertMayActivate = () => {
      if (workspaceRestoreRef.current !== pending || !workspace.isCurrent() || dirtyRef.current || formDirtyRef.current
        || pendingCommitCountRef.current || navigation.hasOpenDraft() || workspace.fileCommandPending()
        || ('token' in pending && workspace.token !== pending.token)) throw new Error('The selected workspace or an open edit changed. Reopen and review saved data before retrying.')
    }
    let published = false
    try {
      await waitForSafeTransition(); assertMayActivate()
      if (preview.target === 'account') {
        if (!('token' in pending)) throw new Error('The selected account workspace changed. Choose the backup again.')
        const stage = await stageAccountWorkspaceRestore(preview)
        try {
          await waitForSafeTransition(); assertMayActivate()
          await activateAccountWorkspaceRestore(stage, assertMayActivate)
          // Once the pointer is active, cleanup failure must still retire this rendered workspace
          published = true
        } finally { await releaseAccountWorkspaceRestoreStage(stage) }
      } else {
        const journal = await beginGuestWorkspaceRestore(preview)
        assertMayActivate()
        await stageGuestWorkspaceRestore(preview, journal.id)
        await waitForSafeTransition(); assertMayActivate()
        await activateGuestWorkspaceRestore(preview, journal.id, assertMayActivate)
        published = true
      }
    } finally {
      try {
        // Release the input snapshot before navigation can interrupt cleanup
        if (workspaceRestoreRef.current === pending) {
          workspaceRestoreRef.current = undefined
          await disposeSelectedRestore(pending)
        }
      } finally {
        // Every open view must bind to the newly selected workspace before editing resumes
        if (published) window.location.reload()
      }
    }
  }, [navigation, repository, waitForSafeTransition, workspace])

  const definitionCatalogs = useMemo(() => {
    const catalogs = loadedData?.catalogs ?? []
    const page = navigation.route.page
    if (page.page !== 'reference' || page.view !== 'detail' || page.ref.kind !== 'catalog') return catalogs
    const ref = page.ref
    if (catalogs.some(catalog => catalog.id === ref.catalogId && catalog.revisionId === ref.catalogRevisionId)) return catalogs
    return [...catalogs, ...BUNDLED_CATALOGS.filter(catalog => catalog.id === ref.catalogId && catalog.revisionId === ref.catalogRevisionId)]
  }, [loadedData?.catalogs, navigation.route.page])

  if (loadingError) return <main className="error-screen panel"><div className="panel__body stack"><p className="eyebrow">Local planner data unavailable</p><h1>Your records could not be opened</h1><InlineNotice title="No data was cleared" tone="danger">{loadingError}</InlineNotice><Button icon="history" onClick={() => window.location.reload()}>Reload app</Button></div></main>
  if (!loadedData) return <LoadingScreen detail="Loading local records from this browser..."/>

  const refreshDevelopment = () => {
    if (!import.meta.env.DEV || dirtyRef.current || formDirtyRef.current || pendingCommitCountRef.current > 0 || saveError || importBusy || navigation.hasOpenDraft()) return
    window.location.reload()
  }
  const developmentRefreshBlocked = dirty || formDirty || pendingCommitCount > 0 || Boolean(saveError) || importBusy || navigation.hasOpenDraft()
  const localData = loadedData.localData
  const unresolvedPage = navigation.route.page.page === 'unresolved' ? navigation.route.page : undefined
  const sharedPage = navigation.route.page.page === 'share' ? navigation.route.page : undefined
  const hostedPage = navigation.route.page.page === 'hosted-share' ? navigation.route.page : undefined
  const content = hostedPage ? <HostedSharedView shareId={hostedPage.shareId} onSave={savePublicShare} key={hostedPage.shareId}/> : sharedPage ? sharedPage.version === 5 ? <PublicSharedView encoded={sharedPage.encoded} onSave={savePublicShare}/> : <SharedView catalogs={loadedData.catalogs} encoded={sharedPage.encoded} key={sharedPage.encoded} localData={localData} onSave={saveShare} onImport={importSharedMod}/> : unresolvedPage
    ? <section className="panel"><div className="panel__body stack"><p className="eyebrow">Page unavailable</p><h1>This link could not be opened</h1><InlineNotice title="No record was selected" tone="warning">This address is invalid or unrecognized.</InlineNotice><Button onClick={() => navigation.navigate(routeForDestination(unresolvedPage.recovery), { replace: true })}>Return to {unresolvedPage.recovery}</Button></div></section>
    : !selectedPlaythrough(localData) && ['inventory', 'characters', 'progress'].includes(destination) ? <InlineNotice title="Choose a Playthrough">Create or select a Playthrough to track characters, inventory, and progress.<Button onClick={() => navigation.navigate({ page: { page: 'settings', section: 'playthrough' }, overlays: [], query: { create: ['true'] } })}>Create or select Playthrough</Button></InlineNotice>
    : destination === 'save-editor' ? <Suspense fallback={<p role="status">Opening Save Editor...</p>}><SaveEditorView onDraftChange={setFormDraftDirty}/></Suspense> : destination === 'map' ? <Suspense fallback={<p role="status">Opening world map...</p>}><WorldMapView localData={localData} catalogs={loadedData.catalogs}/></Suspense> : destination === 'mods' ? <Suspense fallback={<p role="status">Opening Mods...</p>}><ModsView onDraftChange={setFormDraftDirty} onSaveToLibrary={saveModDraft} onConfirmFolder={saveFolderSource} onSetReference={setReferenceMembership} onChooseMods={() => setModSelectorOpen(true)}/></Suspense> : destination === 'teams' ? <BuildInputProvider scope={JSON.stringify(navigation.route.page)}><TeamsView onEditCopiedCheckpoint={saveCopiedCheckpoint} onSaveAsBuild={savePlanningTeamSlotAsBuild} onDraftChange={setFormDraftDirty} localData={localData} catalogs={loadedData.catalogs} onSave={savePlanningTeam} onSaveMember={savePlanningTeamMember} onAdopt={adoptPlanningTeam} onDelete={deletePlanningTeam}/></BuildInputProvider> : destination === 'inventory' ? <InventoryView catalogs={loadedData.catalogs} onAdd={addInventory} onOpenData={openData} onRecordEvent={addInventoryEvent} onUpdate={updateInventory} localData={localData}/> : destination === 'characters' ? <CharactersView hasPendingSave={dirty} onDraftChange={setFormDraftDirty} onRetrySave={retrySave} onImportScreenshots={importCharacterScreenshots} catalogs={loadedData.catalogs} onAdd={addCharacter} onCapture={captureSnapshot} onUpsertClass={upsertCharacterClass} onUpsertLearned={upsertCharacterLearning} localData={localData}/> : destination === 'builds' ? null : destination === 'progress' && navigation.route.page.page === 'progress' && navigation.route.page.view === 'quintar' ? <QuintarBreedingView catalogs={loadedData.catalogs} key={localData.selectedPlaythroughId} localData={localData} onToggle={toggleQuintarProgress}/> : destination === 'progress' ? <ProgressView catalogs={loadedData.catalogs} key={localData.selectedPlaythroughId} localData={localData} onAdd={addProgress} onAdvance={advanceProgress} onToggleSummon={toggleSummon} onSetAcquired={setAcquiredProgress} saveBlocked={dirty && saveState !== 'saved'} onSetStage={setProgressStage} onUpdate={updateProgressRecord}/> : navigation.route.query['library-mod']?.[0] ? <Suspense fallback={<p role="status">Opening mod catalog...</p>}><ModCatalogReference key={navigation.route.query['library-mod'][0]} scopeId={navigation.route.query['library-mod'][0]} catalogs={loadedData.catalogs} onOpenData={openData} onPromoteDefinitions={promoteDefinitions} localData={localData} onAddReference={saveModDraft} onSetReference={setReferenceMembership} onRouteCatalogsChange={setRouteCatalogs}/></Suspense> : <ReferenceView catalogs={loadedData.catalogs} onOpenData={openData} onPromoteDefinitions={promoteDefinitions} localData={localData}/>

  const appNavigation: NavigationController = { ...navigation, navigate: (to, options) => navigation.navigate(buildDraftRouteRef.current && to.page.page === 'builds' && to.page.view === 'library' ? buildDraftRouteRef.current : to, options) }
  const buildRoute = navigation.route.page.page === 'builds' ? navigation.route : buildDraftRouteRef.current
  const buildContent = buildRoute && <WorkspaceHeaderScope active={destination === 'builds'}><div hidden={destination !== 'builds'}><NavigationProvider controller={{ ...appNavigation, route: buildRoute, destination: 'builds' }}><BuildInputProvider scope={JSON.stringify(buildRoute.page)}><BuildsView onEditCopiedCheckpoint={saveCopiedCheckpoint} shareBlocked={dirty || formDirty || saveState === 'saving'} catalogs={loadedData.catalogs} onAssign={assignScenario} onCloneBuild={cloneExistingBuild} onCreateBuild={addBuild} onCreateScenario={addScenario} onDraftChange={setBuildDraftDirty} onRecordCurrent={recordBuildCurrent} onSaveDetails={saveBuildDetails} onSaveRevision={saveRevision} localData={localData} validations={validations}/></BuildInputProvider></NavigationProvider></div></WorkspaceHeaderScope>
  // Conflicts share the content grid so fixed navigation never covers their inspection or choice controls
  const conflicts = workspace.token && <ConflictPanel key={`${workspace.token.accountId}:${workspace.token.generation}`} token={workspace.token} repository={workspace.repository}/>
  const draftReminder = (destination === 'reference' || destination === 'map') && buildDraftRouteRef.current && <div className="build-draft-reminder"><InlineNotice title="Your build draft is kept in this tab">Return to finish your Build. Save before closing or reloading this tab.</InlineNotice><Button onClick={() => { if (buildDraftRouteRef.current) navigation.navigate(buildDraftRouteRef.current) }} tone="secondary">Return to build draft</Button></div>

  return <NavigationProvider controller={appNavigation}><DefinitionProvider catalogs={definitionCatalogs} onLoadBundledMod={loadBuildModSource} onImportMod={importBuildMod} onSaveDefinition={saveDefinition} localData={localData}><Shell catalogs={loadedData.catalogs} developmentRefreshBlocked={developmentRefreshBlocked} onDevelopmentRefresh={refreshDevelopment} contextBusy={importBusy || saveState === 'saving'} destination={destination} onOpenData={openData} onSelectPlaythrough={selectContextPlaythrough} onSelectScenario={selectScenario} localData={localData} pendingLocalChanges={pendingCommitCount > 0} saveState={saveError || saveState === 'error' ? 'error' : formDirty ? 'unsaved' : saveState}>{conflicts}{navigationWarning && <div aria-label="Resolve unsaved edits" className="external-update navigation-warning" ref={navigationWarningRef} role="region" tabIndex={-1}><InlineNotice title="Unsaved edits are still open" tone="warning">Save or discard your edits to continue.</InlineNotice><div className="cluster"><Button disabled={resolvingDraft} onClick={() => void resolveDraftNavigation('discard')} tone="quiet">Discard and continue</Button><Button disabled={resolvingDraft} icon="check" onClick={() => void resolveDraftNavigation('save')}>{resolvingDraft ? 'Saving...' : 'Save and continue'}</Button></div></div>}{externalUpdate && <div className="external-update"><InlineNotice title="Updated data is ready" tone="warning">Save or discard open edits before loading the updated data.</InlineNotice><Button disabled={dirty || formDirty || saveState === 'saving'} onClick={() => void loadExternalUpdate().catch((reason: unknown) => setSaveError(formatAppError(reason, 'The newer local revision could not be loaded.')))} tone="secondary">{dirty || formDirty ? 'Finish editing before loading' : 'Load updated data'}</Button></div>}{saveError && <SaveFailureAlert dirty={dirty} error={saveError} onDismiss={() => setSaveError(undefined)} onExport={exportCurrentLocalData} onRetry={retrySave} saving={saveState === 'saving'}/>}{!modSelectorOpen && BUNDLED_MOD_LIBRARY.length > 0 && localData.modSetup?.state === 'pending' && !sharedPage && destination !== 'mods' && <div className="external-update"><InlineNotice title="Choose the mods you use">Add selected mods to Reference and enable their versions in your starting Game Setup.</InlineNotice><Button disabled={dirty || formDirty || importBusy} onClick={() => setModSelectorOpen(true)} tone="secondary">Choose mods</Button><Button disabled={dirty || formDirty || importBusy} tone="quiet" onClick={() => void skipModSetup().catch(reason => setSaveError(formatAppError(reason, 'Mod selection could not be skipped.')))}>Skip for now</Button></div>}{accountOpen ? <AccountView repository={repository} assertMayRemove={() => { if (dirtyRef.current || formDirtyRef.current || pendingCommitCountRef.current || navigation.hasOpenDraft() || workspace.fileCommandPending() || !workspace.isCurrent()) throw new Error('Finish or recover open edits before removing this device copy') }} localCopy={workspace.localCopy} onBackup={repository.kind === 'account' ? exportCompleteWorkspace : undefined} onOpenWorkspace={workspace.openAccount} onContinueLocal={workspace.continueLocal}/> : <>{buildContent}{draftReminder}{content}</>}</Shell>{modSelectorOpen && <Suspense fallback={<p role="status">Opening mod selection...</p>}><ModSetupSelector setup={localData.planningGameSetupRevisionId ? localData.gameSetups[localData.planningGameSetupRevisionId] : undefined} onApply={applyModSetup} onSkip={skipModSetup} onClose={() => setModSelectorOpen(false)}/></Suspense>}<DataPanel busy={importBusy || saveState === 'saving'} canUndo={loadedData.canUndo} dirty={dirty || formDirty} importError={importError} onClearPreview={() => { setImportPreview(undefined); setImportError(undefined); navigation.navigate({ page: { page: 'settings', section: 'data' }, overlays: [], query: {} }, { replace: true }) }} onClose={closeData} onCommit={handleImport} onCreatePlaythrough={createLocalPlaythrough} onExport={exportCurrentLocalData} onExportWorkspace={exportCompleteWorkspace} onWorkspaceRestoreTarget={repository.kind} onWorkspaceRestorePreview={previewWorkspaceRestore} onWorkspaceRestoreActivate={activateWorkspaceRestore} onWorkspaceRestoreClear={clearWorkspaceRestore} onPreview={handlePreview} onSaveGameSetup={saveGameSetup} onRetrySave={retrySave} onSelectGameSetup={selectGameSetup} onSelectPlaythrough={selectLocalPlaythrough} onUndo={undoLatestChange} open={dataOpen} preview={importPreview} localData={localData} saveError={saveError}/></DefinitionProvider></NavigationProvider>
}
