import { CRYSTAL_EDIT_FORMAT } from './interchange/crystal-edit'
import { modRevision } from './domain/mod-library'
import { adoptTeam, recordBuildForCharacter, saveTeam, type SaveTeamInput } from './domain/teams'
import type { TeamId } from './domain/types'
import { TeamsView } from './ui/TeamsView'
import { createPlaythroughWithSetup } from './domain/game-setups'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  createDefinitionOverride,
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
import { DEFAULT_CATALOG } from './catalog/bundled'
import { commitImport, exportBackup, loadLocalData, previewImport, prepareModCatalogs, saveLocalDataWithStatus, subscribeLocalData, undoLocalDataWithStatus, validateLocalDataForStorage } from './persistence'
import type { ImportCommitMode, ImportPreview, LoadedLocalData } from './interchange/types'
import { BuildsView, type BuildDraft, type RevisionDraft, type ScenarioDraft } from './ui/BuildsView'
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
import { CorrectionsContext, useCorrectionStore } from './ui/corrections-context'
import { CorrectionSurfaces } from './ui/Corrections'
import { ReferenceView } from './ui/ReferenceView'
import { Shell } from './ui/Shell'
import { Button, InlineNotice, Spinner } from './ui/components'
import { catalogLocksMatch, formatAppError } from './ui/model'
import { DefinitionProvider, type DefinitionEditorDraft } from './ui/definitions'
import { isReferenceResearchRoute, isRouteWithin, NavigationProvider, routeDestination, routeForDestination, routeWithoutOverlays, useNavigationController, type AppRoute, type NavigationController } from './ui/navigation'

const ModsView = lazy(() => import('./ui/ModsView').then(module => ({ default: module.ModsView })))

type SaveState = 'saved' | 'saving' | 'unsaved' | 'error'
const PAINT_WAIT_FALLBACK_MS = 250
const INTERACTIVE_PROGRESS_COMMIT = Object.freeze({ showSavingState: false, deferUntilPaint: true })

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

function LoadingView() {
  return <main className="loading-screen"><div className="loading-screen__content"><span className="brand__mark"><Spinner/></span><h1>Opening Crystal Kit</h1><p>Loading local records from this browser...</p></div></main>
}

export default function App() {
  const [loadedData, setLoadedData] = useState<LoadedLocalData>()
  const corrections = useCorrectionStore(loadedData?.catalogs)
  const loadedDataRef = useRef<LoadedLocalData | undefined>(undefined)
  const commitQueueRef = useRef<Promise<void>>(Promise.resolve())
  const pendingCommitCountRef = useRef(0)
  const persistedRevisionRef = useRef(0)
  const dirtyRef = useRef(false)
  const formDirtyRef = useRef(false)
  const draftActionsRef = useRef<DraftActions | undefined>(undefined)
  const pendingNavigationRef = useRef<AppRoute | undefined>(undefined)
  const buildDraftRouteRef = useRef<AppRoute>(undefined)
  const [loadingError, setLoadingError] = useState<string>()
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [dirty, setDirty] = useState(false)
  const [formDirty, setFormDirty] = useState(false)
  const [navigationWarning, setNavigationWarning] = useState(false)
  const [resolvingDraft, setResolvingDraft] = useState(false)
  const [saveError, setSaveError] = useState<string>()
  const [importPreview, setImportPreview] = useState<ImportPreview>()
  const [importError, setImportError] = useState<string>()
  const [importBusy, setImportBusy] = useState(false)
  const [externalUpdate, setExternalUpdate] = useState(false)
  const resolveEntityName = useMemo(() => createEntityRouteNameResolver(corrections.catalogs), [corrections.catalogs])
  const navigation = useNavigationController({
    resolveEntityName,
    shouldBlock: (from, to) => {
      if (!formDirtyRef.current) return false
      if (buildDraftRouteRef.current && !dirtyRef.current) return !isReferenceResearchRoute(to) && !isRouteWithin(to, buildDraftRouteRef.current)
      return !isRouteWithin(to, routeWithoutOverlays(from))
    },
    onBlocked: (to) => { pendingNavigationRef.current = to; setNavigationWarning(true) },
  })
  const destination = routeDestination(navigation.route)
  const dataOpen = navigation.route.page.page === 'settings'
  const openData = useCallback(() => {
    navigation.navigate({ page: { page: 'settings', section: 'data' }, overlays: [], query: {} })
  }, [navigation])
  const closeData = useCallback(() => { navigation.close() }, [navigation])

  useEffect(() => {
    let live = true
    void loadLocalData().then((loaded) => {
      if (!live) return
      loadedDataRef.current = loaded
      persistedRevisionRef.current = loaded.localData.revision
      setLoadedData(loaded)
    }).catch((error: unknown) => { if (live) setLoadingError(formatAppError(error, 'Local records could not be opened.')) })
    return () => { live = false }
  }, [])

  const setFormDraftDirty = useCallback<DraftChangeHandler>((value, actions) => {
    formDirtyRef.current = value
    draftActionsRef.current = value ? actions : undefined
    setFormDirty(value)
    if (!value) { pendingNavigationRef.current = undefined; setNavigationWarning(false) }
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
      const resolved = resolution === 'save' ? await actions.save() : (await actions.discard()) !== false
      if (resolved) navigation.navigate(destination)
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

  useEffect(() => {
    if (!loadedDataRef.current) return
    return subscribeLocalData((notification) => {
      const current = loadedDataRef.current
      if (!current || notification.localDataId !== current.localData.id || notification.revision <= current.localData.revision) return
      setExternalUpdate(true)
    })
  }, [loadedData?.localData.id])

  const commitLocalData = useCallback((transform: (localData: LocalData) => LocalData, options: { rollbackOnFailure?: boolean; showSavingState?: boolean; deferUntilPaint?: boolean } = {}) => {
    pendingCommitCountRef.current += 1
    const run = async () => {
      if (options.deferUntilPaint) await waitForNextPaint()
      const current = loadedDataRef.current
      if (!current) throw new Error('The local planner data is not ready.')
      if (dirtyRef.current) throw new Error('A previous change is retained after a failed save. Close this form, then use Retry save or export a recovery backup before making another change.')
      let optimistic: LoadedLocalData | undefined
      try {
        const nextLocalData = transform(current.localData)
        if (nextLocalData === current.localData) return
        const catalogs = await prepareModCatalogs(nextLocalData, current.catalogs)
        validateLocalDataForStorage(nextLocalData, catalogs)
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
        const message = formatAppError(error, 'The local transaction failed.')
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
    const queued = commitQueueRef.current.then(run, run)
    commitQueueRef.current = queued.catch(() => undefined)
    const settle = () => { pendingCommitCountRef.current = Math.max(0, pendingCommitCountRef.current - 1) }
    void queued.then(settle, settle)
    return queued
  }, [])

  const retrySave = useCallback(() => {
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
        setSaveError(formatAppError(reason, 'The local retry failed.'))
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
        return createDefinitionOverride(localData, loadedDataRef.current?.catalogs ?? [], {
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
    await commitLocalData(localData => toggleQuintarStep(localData, { stepId, playthroughId, expectedRevision: localData.revision }), { rollbackOnFailure: true, showSavingState: false })
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
      return saveBuildRevision(created, { buildId, id: revisionId, content, note, gameSetupRevisionId: configured.setup.id, expectedRevision: created.revision })
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
      return saveBuildRevision(localData, { buildId: asId<BuildId>(buildId), id: revisionId, parentRevisionId: parentRevisionId ? asId<BuildRevisionId>(parentRevisionId) : build.latestRevisionId, gameSetupRevisionId, content: { primaryClass: draft.primaryClass, secondaryClass: draft.secondaryClass, equipment: draft.equipment, passives: draft.passives, rotationNotes: draft.rotationNotes, contextAssumptions: draft.contextAssumptions, calculation: draft.calculation }, note: draft.note, expectedRevision: localData.revision })
    })
    return revisionId
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
      if (!recorded || !sameBuildBehavior(localData.gameSetups[recorded.gameSetupRevisionId], gameSetup) || !sameLock || !Object.keys(assignments).length) throw new Error('The recorded current party is no longer compatible with the chosen Game Setup and catalog lock.')
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

  const adoptPlanningTeam = useCallback(async (teamId: TeamId, characterIds: readonly CharacterId[]) => {
    await commitLocalData(localData => adoptTeam(localData, { teamId, characterIds, expectedRevision: localData.revision }), { rollbackOnFailure: true })
  }, [commitLocalData])

  const saveGameSetup = useCallback(async (draft: GameSetupDraft, options: GameSetupSaveOptions) => commitLocalData((localData) => {
    const slots: SlotDefinition[] = draft.slots.map((slot, index) => ({ id: slot.id ?? createId<SlotId>('slot'), label: slot.label, kind: 'equipment', order: index, equipmentRole: slot.equipmentRole, acceptedEntityKinds: slot.acceptedEntityKinds, provenance: slot.provenance, sources: slot.sources }))
    const sourceRevisionId = draft.sourceGameSetupRevisionId
    const source = sourceRevisionId ? localData.gameSetups[sourceRevisionId] : undefined
    const catalogLock = { [DEFAULT_CATALOG.id]: DEFAULT_CATALOG.revisionId, ...source?.catalogLock }
    const values = { label: draft.label, platform: draft.platform, gameVersion: draft.gameVersion, mode: draft.mode, difficulty: draft.difficulty, mods: draft.mods, disabledMods: draft.disabledMods, customMods: draft.customMods, ppLimit: draft.ppLimit, ppCostsNonNegative: draft.ppCostsNonNegative, slots, catalogLock, modComposition: draft.modComposition, definitionOverrides: draft.definitionOverrides, id: options.id, activate: false, expectedRevision: localData.revision }
    const next = sourceRevisionId ? updateGameSetupRevision(localData, { sourceRevisionId, ...values }) : createGameSetupRevision(localData, values)
    return next
  }), [commitLocalData])

  const installLoadedData = useCallback((loaded: LoadedLocalData) => {
    loadedDataRef.current = loaded
    persistedRevisionRef.current = loaded.localData.revision
    dirtyRef.current = false
    formDirtyRef.current = false
    buildDraftRouteRef.current = undefined
    setLoadedData(loaded)
    setDirty(false)
    setFormDirty(false)
    setSaveState('saved')
    setSaveError(undefined)
    setExternalUpdate(false)
  }, [])

  const waitForSafeTransition = useCallback(async () => {
    await commitQueueRef.current
    if (dirtyRef.current || formDirtyRef.current || navigation.hasOpenDraft()) throw new Error('Save or discard open form edits, and retry any failed save, before switching Playthrough, Game Setup, or party plan.')
  }, [navigation.hasOpenDraft])

  const createLocalPlaythrough = useCallback(async (label: string, setupId?: GameSetupRevisionId) => {
    await waitForSafeTransition()
    await commitLocalData((localData) => createPlaythroughWithSetup(localData, { label, currentGameSetupRevisionId: setupId, catalogLock: { [DEFAULT_CATALOG.id]: DEFAULT_CATALOG.revisionId }, select: true, expectedRevision: localData.revision }))
  }, [commitLocalData, waitForSafeTransition])

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

  const handleImport = useCallback(async (preview: ImportPreview, mode: ImportCommitMode, restoreCorrections = false) => {
    setImportBusy(true); setImportError(undefined)
    try {
      await waitForSafeTransition()
      const current = loadedDataRef.current
      if (!current) throw new Error('The local planner data is not ready.')
      const loaded = await commitImport(preview, { mode, restoreCorrections, targetLocalDataId: current.localData.id, expectedRevision: persistedRevisionRef.current })
      installLoadedData(loaded); setImportPreview(undefined); closeData()
    } catch (error) { setImportError(formatAppError(error, 'The import could not be committed.')) } finally { setImportBusy(false) }
  }, [closeData, installLoadedData, waitForSafeTransition])

  const saveModDraft = useCallback(async (text: string, filename: string) => {
    setImportBusy(true)
    try {
      const preview = await previewImport(new TextEncoder().encode(text), filename)
      const revision = preview.proposed.catalogs[0] && modRevision(preview.proposed.catalogs[0])
      if (preview.detectedFormat !== CRYSTAL_EDIT_FORMAT || !revision) throw new Error('This draft needs a Crystal Edit project ID, editor version, and supported records or game settings before it can be used for planning.')
      await waitForSafeTransition()
      const current = loadedDataRef.current
      if (!current) throw new Error('The local planner data is not ready.')
      const unchanged = current.catalogs.some(catalog => catalog.id === revision.catalogId && catalog.revisionId === revision.catalogRevisionId)
      const loaded = await commitImport(preview, { mode: 'add-reference', targetLocalDataId: current.localData.id, expectedRevision: persistedRevisionRef.current })
      installLoadedData(loaded)
      return { title: revision.title, unchanged, warnings: preview.warnings.map(warning => warning.message) }
    } finally { setImportBusy(false) }
  }, [installLoadedData, waitForSafeTransition])

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
    if (!loadedData) return {}
    const index = catalogIndex(loadedData.catalogs)
    return Object.fromEntries(Object.values(requirePlaythrough(loadedData.localData).scenarios).map((scenario) => {
      try { return [scenario.id, validateScenario(loadedData.localData, scenario.id, index)] } catch { return [scenario.id, undefined] }
    })) as Readonly<Record<string, ValidationReport | undefined>>
  }, [loadedData])

  const loadExternalUpdate = useCallback(async () => {
    await waitForSafeTransition()
    const loaded = await loadLocalData()
    installLoadedData(loaded)
  }, [installLoadedData, waitForSafeTransition])

  const exportCurrentLocalData = useCallback(async () => {
    await commitQueueRef.current
    const current = loadedDataRef.current
    if (!current) throw new Error('The local planner data is not ready.')
    return exportBackup(dirtyRef.current ? current.localData : undefined)
  }, [])

  if (loadingError) return <main className="error-screen panel"><div className="panel__body stack"><p className="eyebrow">Local planner data unavailable</p><h1>Your records could not be opened</h1><InlineNotice title="No data was cleared" tone="danger">{loadingError}</InlineNotice><Button icon="history" onClick={() => window.location.reload()}>Reload application</Button></div></main>
  if (!loadedData || !corrections.ready) return <LoadingView/>

  const localData = loadedData.localData
  const unresolvedPage = navigation.route.page.page === 'unresolved' ? navigation.route.page : undefined
  const sharedPage = navigation.route.page.page === 'share' ? navigation.route.page : undefined
  const content = sharedPage ? <SharedView catalogs={loadedData.catalogs} encoded={sharedPage.encoded} key={sharedPage.encoded} localData={localData} onSave={saveShare}/> : unresolvedPage
    ? <section className="panel"><div className="panel__body stack"><p className="eyebrow">Page unavailable</p><h1>This link could not be opened</h1><InlineNotice title="No record was selected" tone="warning">The requested address is unknown or contains an invalid identity. Crystal Kit did not substitute another record.</InlineNotice><Button onClick={() => navigation.navigate(routeForDestination(unresolvedPage.recovery), { replace: true })}>Return to {unresolvedPage.recovery}</Button></div></section>
    : destination === 'mods' ? <Suspense fallback={<p role="status">Opening Mods...</p>}><ModsView onDraftChange={setFormDraftDirty} onSaveToLibrary={saveModDraft}/></Suspense> : destination === 'teams' ? <TeamsView onDraftChange={setFormDraftDirty} localData={localData} catalogs={loadedData.catalogs} onSave={savePlanningTeam} onAdopt={adoptPlanningTeam}/> : destination === 'inventory' ? <InventoryView catalogs={loadedData.catalogs} onAdd={addInventory} onOpenData={openData} onRecordEvent={addInventoryEvent} onUpdate={updateInventory} localData={localData}/> : destination === 'characters' ? <CharactersView hasPendingSave={dirty} onDraftChange={setFormDraftDirty} onRetrySave={retrySave} onImportScreenshots={importCharacterScreenshots} catalogs={loadedData.catalogs} onAdd={addCharacter} onCapture={captureSnapshot} onUpsertClass={upsertCharacterClass} onUpsertLearned={upsertCharacterLearning} localData={localData}/> : destination === 'builds' ? null : destination === 'progress' && navigation.route.page.page === 'progress' && navigation.route.page.view === 'quintar' ? <QuintarBreedingView catalogs={loadedData.catalogs} key={localData.selectedPlaythroughId} localData={localData} onToggle={toggleQuintarProgress}/> : destination === 'progress' ? <ProgressView catalogs={loadedData.catalogs} key={localData.selectedPlaythroughId} localData={localData} onAdd={addProgress} onAdvance={advanceProgress} onToggleSummon={toggleSummon} onSetAcquired={setAcquiredProgress} saveBlocked={dirty && saveState !== 'saved'} onSetStage={setProgressStage} onUpdate={updateProgressRecord}/> : <ReferenceView catalogs={corrections.catalogs} onOpenData={openData} onPromoteDefinitions={promoteDefinitions} localData={localData}/>

  const appNavigation: NavigationController = { ...navigation, navigate: (to, options) => navigation.navigate(buildDraftRouteRef.current && to.page.page === 'builds' && to.page.view === 'library' ? buildDraftRouteRef.current : to, options) }
  const buildRoute = navigation.route.page.page === 'builds' ? navigation.route : buildDraftRouteRef.current
  const buildContent = buildRoute && <div hidden={destination !== 'builds'}><NavigationProvider controller={{ ...appNavigation, route: buildRoute, destination: 'builds' }}><BuildsView shareBlocked={dirty || formDirty || saveState === 'saving'} catalogs={loadedData.catalogs} onAssign={assignScenario} onCloneBuild={cloneExistingBuild} onCreateBuild={addBuild} onCreateScenario={addScenario} onDraftChange={setBuildDraftDirty} onRecordCurrent={recordBuildCurrent} onSaveDetails={saveBuildDetails} onSaveRevision={saveRevision} localData={localData} validations={validations}/></NavigationProvider></div>
  const draftReminder = destination === 'reference' && buildDraftRouteRef.current && <div className="build-draft-reminder"><InlineNotice title="Your build draft is kept in this tab">Browse reference records, then return to finish your build. Save before closing or reloading this tab.</InlineNotice><Button onClick={() => { if (buildDraftRouteRef.current) navigation.navigate(buildDraftRouteRef.current) }} tone="secondary">Return to build draft</Button></div>

  return <NavigationProvider controller={appNavigation}><CorrectionsContext.Provider value={corrections}><DefinitionProvider catalogs={corrections.catalogs} onSaveDefinition={saveDefinition} localData={localData}><Shell catalogs={loadedData.catalogs} contextBusy={importBusy || saveState === 'saving'} destination={destination} onOpenData={openData} onSelectPlaythrough={selectContextPlaythrough} onSelectScenario={selectScenario} localData={localData} saveState={formDirty ? 'unsaved' : saveState}>{navigationWarning && <div className="external-update"><InlineNotice title="Unsaved edits are still open" tone="warning">Choose how to resolve the open edits, then continue to the page you selected.</InlineNotice><div className="cluster"><Button disabled={resolvingDraft} onClick={() => void resolveDraftNavigation('discard')} tone="quiet">Discard and continue</Button><Button disabled={resolvingDraft} icon="check" onClick={() => void resolveDraftNavigation('save')}>{resolvingDraft ? 'Saving...' : 'Save and continue'}</Button></div></div>}{externalUpdate && <div className="external-update"><InlineNotice title="Another tab changed the planner data" tone="warning">Review or finish any open form before loading the newer local revision.</InlineNotice><Button disabled={dirty || formDirty || saveState === 'saving'} onClick={() => void loadExternalUpdate().catch((reason: unknown) => setSaveError(formatAppError(reason, 'The newer local revision could not be loaded.')))} tone="secondary">{dirty || formDirty ? 'Finish the open draft before loading' : 'Load newer revision'}</Button></div>}{saveError && <div className="external-update"><InlineNotice title={dirty ? 'Local save failed' : 'Change not saved'} tone="danger">{saveError} {dirty ? 'Your draft remains open. Retry this exact revision or export a recovery copy.' : 'Review the open form and try again.'}</InlineNotice>{dirty && <Button disabled={saveState === 'saving'} onClick={() => void retrySave().catch(() => undefined)} tone="secondary">{saveState === 'saving' ? 'Retrying...' : 'Retry save'}</Button>}</div>}{buildContent}{draftReminder}{content}</Shell><DataPanel busy={importBusy || saveState === 'saving'} canUndo={loadedData.canUndo} dirty={dirty || formDirty} importError={importError} onClearPreview={() => { setImportPreview(undefined); setImportError(undefined); navigation.navigate({ page: { page: 'settings', section: 'data' }, overlays: [], query: {} }, { replace: true }) }} onClose={closeData} onCommit={handleImport} onCreatePlaythrough={createLocalPlaythrough} onExport={exportCurrentLocalData} onPreview={handlePreview} onSaveGameSetup={saveGameSetup} onRetrySave={retrySave} onSelectGameSetup={selectGameSetup} onSelectPlaythrough={selectLocalPlaythrough} onUndo={undoLatestChange} open={dataOpen} preview={importPreview} localData={localData} saveError={saveError}/><CorrectionSurfaces/></DefinitionProvider></CorrectionsContext.Provider></NavigationProvider>
}
