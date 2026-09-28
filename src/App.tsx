import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  activateRuleset,
  activateScenario,
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
  createRulesetRevision,
  createScenario,
  effectiveScenarioAssignments,
  entityDefinitionKey,
  linkInventoryPosition,
  observeInventory,
  recordInventoryEvent,
  replaceScenarioBuild,
  saveBuildRevision,
  updateBuild,
  updateRulesetRevision,
  updateScenario,
  upsertCharacterClassProgress,
  upsertLearnedNode,
  upsertProgress,
  validateScenario,
  type BuildId,
  type BuildRevisionId,
  type CatalogIndex,
  type CatalogSnapshot,
  type CharacterId,
  type EntityRef,
  type PersonalDefinitionId,
  type Profile,
  type ProgressRecordId,
  type RulesetRevisionId,
  type ScenarioId,
  type SlotDefinition,
  type SlotId,
  type Timestamp,
  type ValidationReport,
} from './domain'
import type { DraftActions, DraftChangeHandler } from './ui/drafts'
import { DEFAULT_CATALOG } from './catalog/bundled'
import { createBuildPlan, ensureBuildPlanningRuleset } from './domain/build-planning'
import { commitImport, createProfile, exportBackup, listProfiles, loadWorkspace, previewImport, saveProfileWithStatus, selectProfile, subscribeWorkspace, undoProfileWithStatus, validateProfileForStorage } from './persistence'
import type { ImportCommitMode, ImportPreview, ProfileSummary, Workspace } from './interchange/types'
import { BuildsView, type BuildDraft, type RevisionDraft, type ScenarioDraft } from './ui/BuildsView'
import { CharactersView, type CharacterDraft, type ClassProgressDraft, type LearnedNodeDraft, type SnapshotDraft } from './ui/CharactersView'
import { DataPanel, type RulesetDraft } from './ui/DataPanel'
import { InventoryView, type InventoryDraft, type InventoryEventDraft } from './ui/InventoryView'
import { ProgressView, type ProgressDraft } from './ui/ProgressView'
import { CorrectionsContext, useCorrectionStore } from './ui/corrections-context'
import { CorrectionSurfaces } from './ui/Corrections'
import { ReferenceView } from './ui/ReferenceView'
import { Shell } from './ui/Shell'
import { Button, InlineNotice, Spinner } from './ui/components'
import { catalogLocksMatch, formatAppError } from './ui/model'
import { DefinitionProvider, type DefinitionEditorDraft } from './ui/definitions'
import { isReferenceResearchRoute, isRouteWithin, NavigationProvider, routeDestination, routeForDestination, routeWithoutOverlays, useNavigationController, type AppRoute, type NavigationController } from './ui/navigation'

type SaveState = 'saved' | 'saving' | 'unsaved' | 'error'

function currentTimestamp(date?: string): Timestamp | undefined {
  if (!date) return undefined
  return date as Timestamp
}

function nullableTimestamp(date?: string | null): Timestamp | null | undefined {
  return date === null ? null : currentTimestamp(date)
}

function addPersonalRef(profile: Profile, name: string, kind: Parameters<typeof createPersonalDefinition>[1]['kind']) {
  const id = createId<PersonalDefinitionId>('definition')
  const next = createPersonalDefinition(profile, { id, name, kind, expectedRevision: profile.revision })
  return { profile: next, ref: { kind: 'personal', definitionId: id } as const }
}

function catalogIndex(catalogs: readonly CatalogSnapshot[]): CatalogIndex {
  const snapshots = Object.fromEntries(catalogs.map((catalog) => [JSON.stringify([catalog.id, catalog.revisionId]), catalog]))
  const entitiesByRef = Object.fromEntries(catalogs.flatMap((catalog) => Object.values(catalog.entities).map((entity) => [entityDefinitionKey({ kind: 'catalog', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: entity.id }), entity])))
  return { snapshots, entitiesByRef }
}

function LoadingView() {
  return <main className="loading-screen"><div className="loading-screen__content"><span className="brand__mark"><Spinner/></span><h1>Opening Crystal Companion</h1><p>Loading local records from this browser...</p></div></main>
}

export default function App() {
  const [workspace, setWorkspace] = useState<Workspace>()
  const corrections = useCorrectionStore(workspace?.catalogs)
  const workspaceRef = useRef<Workspace | undefined>(undefined)
  const commitQueueRef = useRef<Promise<void>>(Promise.resolve())
  const persistedRevisionRef = useRef(0)
  const dirtyRef = useRef(false)
  const formDirtyRef = useRef(false)
  const draftActionsRef = useRef<DraftActions | undefined>(undefined)
  const pendingNavigationRef = useRef<AppRoute | undefined>(undefined)
  const buildDraftRouteRef = useRef<AppRoute>(undefined)
  const [profiles, setProfiles] = useState<readonly ProfileSummary[]>([])
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
  const navigation = useNavigationController({
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
    void loadWorkspace().then((loaded) => {
      if (!live) return
      workspaceRef.current = loaded
      persistedRevisionRef.current = loaded.profile.revision
      setWorkspace(loaded)
      return listProfiles()
    }).then((summaries) => {
      if (live && summaries) setProfiles(summaries)
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
      const resolved = resolution === 'save' ? await actions.save() : (actions.discard(), true)
      if (resolved) navigation.navigate(destination)
    } finally { setResolvingDraft(false) }
  }, [navigation])

  useEffect(() => {
    if (!dirty && !formDirty) return
    const preventLoss = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', preventLoss)
    return () => window.removeEventListener('beforeunload', preventLoss)
  }, [dirty, formDirty])

  useEffect(() => {
    if (!workspaceRef.current) return
    return subscribeWorkspace((notification) => {
      const current = workspaceRef.current
      if (!current || notification.profileId !== current.profile.id || notification.revision <= current.profile.revision) return
      setExternalUpdate(true)
    })
  }, [workspace?.profile.id])

  const commitProfile = useCallback((transform: (profile: Profile) => Profile) => {
    const run = async () => {
      const current = workspaceRef.current
      if (!current) throw new Error('The local workspace is not ready.')
      if (dirtyRef.current) throw new Error('A previous change is retained after a failed save. Close this form, then use Retry save or export a recovery backup before making another change.')
      let optimistic: Workspace | undefined
      try {
        const nextProfile = transform(current.profile)
        if (nextProfile === current.profile) return
        validateProfileForStorage(nextProfile, current.catalogs)
        optimistic = { ...current, profile: nextProfile, revision: nextProfile.revision }
        workspaceRef.current = optimistic
        setWorkspace(optimistic)
        dirtyRef.current = true
        setDirty(true)
        setSaveState('saving')
        setSaveError(undefined)
        const write = await saveProfileWithStatus(nextProfile, persistedRevisionRef.current)
        const saved = write.profile
        const committed = { ...optimistic, profile: saved, revision: saved.revision, canUndo: write.canUndo }
        workspaceRef.current = committed
        persistedRevisionRef.current = saved.revision
        setWorkspace(committed)
        dirtyRef.current = false
        setDirty(false)
        setSaveState('saved')
        setProfiles((entries) => entries.map((entry) => entry.id === saved.id ? { ...entry, revision: saved.revision, updatedAt: saved.updatedAt } : entry))
      } catch (error) {
        const message = formatAppError(error, 'The local transaction failed.')
        setSaveError(message)
        setSaveState(optimistic ? 'error' : 'saved')
        throw error
      }
    }
    const queued = commitQueueRef.current.then(run, run)
    commitQueueRef.current = queued.catch(() => undefined)
    return queued
  }, [])

  const retrySave = useCallback(() => {
    const run = async () => {
      const current = workspaceRef.current
      if (!current || !dirtyRef.current) return
      setSaveState('saving')
      setSaveError(undefined)
      try {
        const write = await saveProfileWithStatus(current.profile, persistedRevisionRef.current)
        const saved = write.profile
        const committed = { ...current, profile: saved, revision: saved.revision, canUndo: write.canUndo }
        workspaceRef.current = committed
        persistedRevisionRef.current = saved.revision
        dirtyRef.current = false
        setWorkspace(committed)
        setDirty(false)
        setSaveState('saved')
        setProfiles((entries) => entries.map((entry) => entry.id === saved.id ? { ...entry, revision: saved.revision, updatedAt: saved.updatedAt } : entry))
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

  const addInventory = useCallback(async (draft: InventoryDraft) => commitProfile((profile) => {
    let next = profile
    let ref = draft.ref
    if (!ref) {
      const created = addPersonalRef(next, draft.name, 'item')
      next = created.profile
      ref = created.ref
    }
    return observeInventory(next, { ref, observedName: draft.name, possession: draft.possession, quantity: draft.quantity, favorite: draft.favorite, protectedQuantity: draft.protectedQuantity, wishlist: draft.wishlist, note: draft.note, observedAt: nullableTimestamp(draft.observedAt), expectedRevision: next.revision })
  }), [commitProfile])

  const updateInventory = useCallback(async (positionId: string, draft: InventoryDraft) => commitProfile((profile) => {
    const current = profile.inventory[positionId]
    if (!current) throw new Error('This inventory entry no longer exists.')
    let next = profile
    let ref = draft.ref
    if (!ref) {
      const created = addPersonalRef(next, draft.name, 'item')
      next = created.profile
      ref = created.ref
    }
    if (entityDefinitionKey(current.ref) !== entityDefinitionKey(ref)) next = linkInventoryPosition(next, { positionId: current.id, ref, expectedRevision: next.revision })
    return observeInventory(next, { positionId: current.id, ref, observedName: draft.name, possession: draft.possession, quantity: draft.quantity, favorite: draft.favorite, protectedQuantity: draft.protectedQuantity, wishlist: draft.wishlist, note: draft.note ?? '', observedAt: nullableTimestamp(draft.observedAt), expectedRevision: next.revision })
  }), [commitProfile])

  const addInventoryEvent = useCallback(async (draft: InventoryEventDraft) => commitProfile((profile) => {
    const created = draft.ref ? { profile, ref: draft.ref } : addPersonalRef(profile, draft.name, 'item')
    return recordInventoryEvent(created.profile, { ref: created.ref, observedName: draft.name, kind: draft.kind, quantity: draft.quantity, observedAt: currentTimestamp(draft.observedAt), note: draft.note, expectedRevision: created.profile.revision })
  }), [commitProfile])

  const addCharacter = useCallback(async (draft: CharacterDraft) => commitProfile((profile) => createCharacter(profile, { name: draft.name, appearanceLabel: draft.appearanceLabel, expectedRevision: profile.revision })), [commitProfile])

  const captureSnapshot = useCallback(async (characterId: CharacterId, draft: SnapshotDraft) => commitProfile((profile) => captureCharacter(profile, { characterId, rulesetRevisionId: draft.rulesetRevisionId, level: draft.level, primaryClass: draft.primaryClass, secondaryClass: draft.secondaryClass, displayedStats: draft.displayedStats, ppCapacity: draft.ppCapacity, selections: draft.selections, observedAt: currentTimestamp(draft.observedAt), note: draft.note, expectedRevision: profile.revision })), [commitProfile])

  const upsertCharacterClass = useCallback(async (characterId: CharacterId, draft: ClassProgressDraft) => commitProfile((profile) => upsertCharacterClassProgress(profile, { characterId, ...draft, expectedRevision: profile.revision })), [commitProfile])

  const importCharacterScreenshots = useCallback(async (captures: readonly ReviewedSkillTree[], expectedRevision: number) => commitProfile((profile) => importSkillTrees(profile, workspaceRef.current?.catalogs ?? [], captures, expectedRevision)), [commitProfile])

  const upsertCharacterLearning = useCallback(async (characterId: CharacterId, draft: LearnedNodeDraft) => commitProfile((profile) => upsertLearnedNode(profile, { characterId, ...draft, expectedRevision: profile.revision })), [commitProfile])

  const saveDefinition = useCallback(async (draft: DefinitionEditorDraft): Promise<EntityRef> => {
    const definitionId = createId<PersonalDefinitionId>('definition')
    await commitProfile((profile) => {
      if (draft.baseRef) {
        return createDefinitionOverride(profile, workspaceRef.current?.catalogs ?? [], {
          id: definitionId,
          sourceRef: draft.baseRef,
          name: draft.name,
          aliases: draft.aliases,
          rawDescription: draft.rawDescription,
          category: draft.category,
          ppCost: draft.ppCost,
          fieldClaimSelections: draft.fieldClaimSelections,
          expectedRevision: profile.revision,
        }).profile
      }
      return createPersonalDefinition(profile, {
        id: definitionId,
        kind: draft.kind,
        name: draft.name,
        aliases: draft.aliases,
        rawDescription: draft.rawDescription ?? undefined,
        fields: draft.category ? { category: draft.category } : {},
        ppCost: draft.ppCost ?? undefined,
        expectedRevision: profile.revision,
      })
    })
    return { kind: 'personal', definitionId }
  }, [commitProfile])

  const promoteDefinitions = useCallback(async (sourceRulesetRevisionId: RulesetRevisionId, definitionRefs: readonly EntityRef[], label: string): Promise<void> => {
    const personalRefs = definitionRefs.filter((ref) => ref.kind === 'personal')
    if (personalRefs.length !== definitionRefs.length) throw new Error('Only personal definitions can be collected into a ruleset revision')
    await commitProfile((profile) => coalesceDefinitionOverrides(profile, {
      sourceRulesetRevisionId,
      definitionRefs: personalRefs,
      label,
      activate: false,
      expectedRevision: profile.revision,
    }))
  }, [commitProfile])

  const addProgress = useCallback(async (draft: ProgressDraft) => commitProfile((profile) => {
    const created = draft.subject ? { profile, ref: draft.subject } : addPersonalRef(profile, draft.name, 'class')
    return upsertProgress(created.profile, { id: createId<ProgressRecordId>('progress'), subject: created.ref, displayName: draft.name, stage: draft.stage, unlocked: draft.unlocked, partyMastery: draft.partyMastery, collection: draft.collection, masterLocation: draft.masterLocation, observedAt: nullableTimestamp(draft.observedAt), expectedRevision: created.profile.revision })
  }), [commitProfile])

  const updateProgressRecord = useCallback(async (recordId: ProgressRecordId, draft: ProgressDraft) => commitProfile((profile) => {
    const current = profile.progress[recordId]
    if (!current) throw new Error('This progress record no longer exists.')
    return upsertProgress(profile, { id: current.id, subject: current.subject, displayName: draft.name, stage: draft.stage, unlocked: draft.unlocked, partyMastery: draft.partyMastery, collection: draft.collection, masterLocation: draft.masterLocation, observedAt: nullableTimestamp(draft.observedAt), expectedRevision: profile.revision })
  }), [commitProfile])

  const addBuild = useCallback(async (draft: BuildDraft, revision: RevisionDraft) => {
    const buildId = draft.id
    const revisionId = draft.revisionId
    const { note, ...content } = revision
    await commitProfile((profile) => profile.buildRevisions[revisionId]?.buildId === buildId ? profile : createBuildPlan(profile, { id: buildId, revisionId, title: draft.title, kind: draft.kind, characterId: draft.characterId ? asId<CharacterId>(draft.characterId) : undefined, state: draft.state, tags: draft.tags, content, note, catalogLock: { [DEFAULT_CATALOG.id]: DEFAULT_CATALOG.revisionId }, expectedRevision: profile.revision }))
    return { buildId, revisionId }
  }, [commitProfile])

  const cloneExistingBuild = useCallback(async (buildId: string) => {
    const clonedId = createId<BuildId>('build')
    const clonedRevisionId = createId<BuildRevisionId>('buildRevision')
    await commitProfile((profile) => cloneBuild(profile, { sourceBuildId: asId<BuildId>(buildId), id: clonedId, revisionId: clonedRevisionId, expectedRevision: profile.revision }))
    return clonedId
  }, [commitProfile])

  const saveRevision = useCallback(async (buildId: string, draft: RevisionDraft, parentRevisionId?: string): Promise<BuildRevisionId> => {
    const revisionId = createId<BuildRevisionId>('buildRevision')
    await commitProfile((current) => {
      const profile = ensureBuildPlanningRuleset(current, { [DEFAULT_CATALOG.id]: DEFAULT_CATALOG.revisionId })
      const rulesetId = profile.activeRulesetRevisionId
      if (!rulesetId) throw new Error('Configure an active ruleset before saving a build revision.')
      const build = profile.builds[buildId]
      return saveBuildRevision(profile, { buildId: asId<BuildId>(buildId), id: revisionId, parentRevisionId: parentRevisionId ? asId<BuildRevisionId>(parentRevisionId) : build?.latestRevisionId, rulesetRevisionId: rulesetId, content: { primaryClass: draft.primaryClass, secondaryClass: draft.secondaryClass, selections: draft.selections, rotationNotes: draft.rotationNotes, contextAssumptions: draft.contextAssumptions, calculation: draft.calculation }, note: draft.note, expectedRevision: profile.revision })
    })
    return revisionId
  }, [commitProfile])

  const addScenario = useCallback(async (draft: ScenarioDraft) => commitProfile((profile) => {
    const revision = draft.buildRevisionId ? profile.buildRevisions[draft.buildRevisionId] : undefined
    if (draft.buildRevisionId && !revision) throw new Error('The requested build revision is unavailable.')
    const rulesetRevisionId = revision?.rulesetRevisionId ?? profile.activeRulesetRevisionId
    if (!rulesetRevisionId) throw new Error('Configure an active ruleset before creating a team scenario.')
    let baseline: Parameters<typeof createScenario>[1]['baseline'] = { kind: 'empty' }
    if (draft.baseline === 'recordedParty') {
      const recorded = Object.values(profile.scenarios).find((scenario) => scenario.kind === 'recordedCurrent')
      const ruleset = profile.rulesets[rulesetRevisionId]
      const sameLock = recorded && ruleset && catalogLocksMatch(recorded.catalogLock, revision?.catalogLock ?? ruleset.catalogLock)
      const assignments = recorded ? effectiveScenarioAssignments(recorded) : {}
      if (!recorded || recorded.rulesetRevisionId !== rulesetRevisionId || !sameLock || !Object.keys(assignments).length) throw new Error('The recorded current party is no longer compatible with the chosen ruleset and catalog lock.')
      baseline = { kind: 'recordedParty', profileRevision: profile.revision, assignments }
    }
    return createScenario(profile, { label: draft.label, kind: draft.kind, baseline, rulesetRevisionId, catalogLock: revision?.catalogLock, inventoryPolicy: { enforceStock: draft.enforceStock, includeProtected: draft.includeProtected }, activate: true, expectedRevision: profile.revision })
  }), [commitProfile])

  const assignScenario = useCallback(async (scenarioId: string, characterId: string, revisionId: string) => commitProfile((profile) => replaceScenarioBuild(profile, { scenarioId: asId<ScenarioId>(scenarioId), characterId: asId<CharacterId>(characterId), buildRevisionId: revisionId ? asId<BuildRevisionId>(revisionId) : null, expectedRevision: profile.revision })), [commitProfile])

  const recordBuildCurrent = useCallback(async (buildId: string, revisionId: string) => commitProfile((profile) => {
    const build = profile.builds[buildId]
    if (!build?.characterId) throw new Error('Only a pinned character build can be recorded as current.')
    const revision = profile.buildRevisions[revisionId]
    if (!revision || revision.buildId !== build.id) throw new Error('The selected build revision is unavailable for this build.')
    let next = profile
    for (const other of Object.values(next.builds)) {
      if (other.id !== build.id && other.characterId === build.characterId && other.state === 'recordedCurrent') next = updateBuild(next, { buildId: other.id, state: 'draft', expectedRevision: next.revision })
    }
    next = updateBuild(next, { buildId: build.id, state: 'recordedCurrent', expectedRevision: next.revision })
    const recorded = Object.values(next.scenarios).find((scenario) => scenario.kind === 'recordedCurrent')
    if (recorded && recorded.rulesetRevisionId === revision.rulesetRevisionId && catalogLocksMatch(recorded.catalogLock, revision.catalogLock)) next = replaceScenarioBuild(next, { scenarioId: recorded.id, characterId: build.characterId, buildRevisionId: revision.id, expectedRevision: next.revision })
    else {
      if (recorded) next = updateScenario(next, { scenarioId: recorded.id, kind: 'draft', expectedRevision: next.revision })
      next = createScenario(next, { label: 'Recorded current party', kind: 'recordedCurrent', rulesetRevisionId: revision.rulesetRevisionId, catalogLock: revision.catalogLock, assignments: { [build.characterId]: revision.id }, inventoryPolicy: { enforceStock: true, includeProtected: true }, activate: true, expectedRevision: next.revision })
    }
    const character = next.characters[build.characterId]
    const currentSnapshot = character?.currentSnapshotId ? character.snapshots[character.currentSnapshotId] : undefined
    const selections = Object.fromEntries(Object.entries(revision.content.selections).map(([slotId, selection]) => [slotId, selection?.ref ?? null]))
    return captureCharacter(next, { characterId: build.characterId, rulesetRevisionId: revision.rulesetRevisionId, level: currentSnapshot?.level ?? { state: 'unknown' }, primaryClass: revision.content.primaryClass ? { state: 'known', value: revision.content.primaryClass } : { state: 'unknown' }, secondaryClass: revision.content.secondaryClass ? { state: 'known', value: revision.content.secondaryClass } : { state: 'unknown' }, selections, note: 'Build recorded as current; PP capacity and displayed final stats require a new in-game observation', expectedRevision: next.revision })
  }), [commitProfile])

  const saveRuleset = useCallback(async (draft: RulesetDraft) => commitProfile((profile) => {
    const slots: SlotDefinition[] = draft.slots.map((slot, index) => ({ id: slot.id ?? createId<SlotId>('slot'), label: slot.label, kind: slot.kind, order: index, equipmentRole: slot.equipmentRole, acceptedEntityKinds: slot.acceptedEntityKinds, provenance: 'userDefined', sources: [] }))
    const source = profile.activeRulesetRevisionId ? profile.rulesets[profile.activeRulesetRevisionId] : undefined
    const catalogLock = { [DEFAULT_CATALOG.id]: DEFAULT_CATALOG.revisionId, ...source?.catalogLock }
    const values = { label: draft.label, platform: draft.platform, gameVersion: draft.gameVersion, mode: draft.mode, mods: draft.mods, disabledMods: draft.disabledMods, ppCostsNonNegative: draft.ppCostsNonNegative, slots, catalogLock, activate: true, expectedRevision: profile.revision }
    return profile.activeRulesetRevisionId ? updateRulesetRevision(profile, { sourceRevisionId: profile.activeRulesetRevisionId, ...values }) : createRulesetRevision(profile, values)
  }), [commitProfile])

  const installWorkspace = useCallback((loaded: Workspace) => {
    workspaceRef.current = loaded
    persistedRevisionRef.current = loaded.profile.revision
    dirtyRef.current = false
    formDirtyRef.current = false
    buildDraftRouteRef.current = undefined
    setWorkspace(loaded)
    setDirty(false)
    setFormDirty(false)
    setSaveState('saved')
    setSaveError(undefined)
    setExternalUpdate(false)
  }, [])

  const waitForSafeTransition = useCallback(async () => {
    await commitQueueRef.current
    if (dirtyRef.current || formDirtyRef.current || navigation.hasOpenDraft()) throw new Error('Save or discard open form edits, and retry any failed save, before switching profile, ruleset, or scenario.')
  }, [navigation.hasOpenDraft])

  const refreshProfiles = useCallback(async () => setProfiles(await listProfiles()), [])

  const createLocalProfile = useCallback(async (label: string) => {
    await waitForSafeTransition()
    const loaded = await createProfile(label)
    installWorkspace(loaded)
    await refreshProfiles()
  }, [installWorkspace, refreshProfiles, waitForSafeTransition])

  const selectLocalProfile = useCallback(async (profileId: ProfileSummary['id']) => {
    await waitForSafeTransition()
    const current = workspaceRef.current
    if (current?.profile.id === profileId) return
    const loaded = await selectProfile(profileId)
    installWorkspace(loaded)
    await refreshProfiles()
  }, [installWorkspace, refreshProfiles, waitForSafeTransition])

  const selectContextProfile = useCallback(async (profileId: ProfileSummary['id']) => {
    if (workspaceRef.current?.profile.id === profileId) return
    await selectLocalProfile(profileId)
    navigation.navigate(routeForDestination(destination), { replace: true })
  }, [destination, navigation, selectLocalProfile])

  const selectRuleset = useCallback(async (rulesetRevisionId: RulesetRevisionId) => {
    await waitForSafeTransition()
    await commitProfile((profile) => activateRuleset(profile, { rulesetRevisionId, expectedRevision: profile.revision }))
  }, [commitProfile, waitForSafeTransition])

  const selectScenario = useCallback(async (scenarioId: ScenarioId | null) => {
    await waitForSafeTransition()
    await commitProfile((profile) => activateScenario(profile, { scenarioId, expectedRevision: profile.revision }))
  }, [commitProfile, waitForSafeTransition])

  const undoLatestChange = useCallback(async () => {
    await waitForSafeTransition()
    const current = workspaceRef.current
    if (!current) throw new Error('The local workspace is not ready.')
    const write = await undoProfileWithStatus(current.profile.id, persistedRevisionRef.current)
    installWorkspace({ ...current, profile: write.profile, revision: write.profile.revision, canUndo: write.canUndo })
    await refreshProfiles()
  }, [installWorkspace, refreshProfiles, waitForSafeTransition])

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
      const current = workspaceRef.current
      if (!current) throw new Error('The local workspace is not ready.')
      const loaded = await commitImport(preview, { mode, restoreCorrections, ...(mode === 'new-profile' ? {} : { targetProfileId: current.profile.id, expectedRevision: persistedRevisionRef.current }) })
      installWorkspace(loaded); setImportPreview(undefined); closeData(); await refreshProfiles()
    } catch (error) { setImportError(formatAppError(error, 'The import could not be committed.')) } finally { setImportBusy(false) }
  }, [closeData, installWorkspace, refreshProfiles, waitForSafeTransition])

  const validations = useMemo(() => {
    if (!workspace) return {}
    const index = catalogIndex(workspace.catalogs)
    return Object.fromEntries(Object.values(workspace.profile.scenarios).map((scenario) => {
      try { return [scenario.id, validateScenario(workspace.profile, scenario.id, index)] } catch { return [scenario.id, undefined] }
    })) as Readonly<Record<string, ValidationReport | undefined>>
  }, [workspace])

  const loadExternalUpdate = useCallback(async () => {
    await waitForSafeTransition()
    const current = workspaceRef.current
    if (!current) return
    const loaded = await loadWorkspace(current.profile.id)
    installWorkspace(loaded)
    await refreshProfiles()
  }, [installWorkspace, refreshProfiles, waitForSafeTransition])

  const exportCurrentProfile = useCallback(async () => {
    await commitQueueRef.current
    const current = workspaceRef.current
    if (!current) throw new Error('The local workspace is not ready.')
    return exportBackup(current.profile.id, dirtyRef.current ? current.profile : undefined)
  }, [])

  if (loadingError) return <main className="error-screen panel"><div className="panel__body stack"><p className="eyebrow">Local workspace unavailable</p><h1>Your records could not be opened</h1><InlineNotice title="No data was cleared" tone="danger">{loadingError}</InlineNotice><Button icon="history" onClick={() => window.location.reload()}>Reload application</Button></div></main>
  if (!workspace || !corrections.ready) return <LoadingView/>

  const profile = workspace.profile
  const unresolvedPage = navigation.route.page.page === 'unresolved' ? navigation.route.page : undefined
  const content = unresolvedPage
    ? <section className="panel"><div className="panel__body stack"><p className="eyebrow">Page unavailable</p><h1>This link could not be opened</h1><InlineNotice title="No record was selected" tone="warning">The requested address is unknown or contains an invalid identity. Crystal Companion did not substitute another record.</InlineNotice><Button onClick={() => navigation.navigate(routeForDestination(unresolvedPage.recovery), { replace: true })}>Return to {unresolvedPage.recovery}</Button></div></section>
    : destination === 'inventory' ? <InventoryView catalogs={workspace.catalogs} onAdd={addInventory} onOpenData={openData} onRecordEvent={addInventoryEvent} onUpdate={updateInventory} profile={profile}/> : destination === 'characters' ? <CharactersView hasPendingSave={dirty} onDraftChange={setFormDraftDirty} onRetrySave={retrySave} onImportScreenshots={importCharacterScreenshots} catalogs={workspace.catalogs} onAdd={addCharacter} onCapture={captureSnapshot} onUpsertClass={upsertCharacterClass} onUpsertLearned={upsertCharacterLearning} profile={profile}/> : destination === 'builds' ? null : destination === 'progress' ? <ProgressView catalogs={workspace.catalogs} onAdd={addProgress} onUpdate={updateProgressRecord} profile={profile}/> : <ReferenceView catalogs={corrections.catalogs} onOpenData={openData} onPromoteDefinitions={promoteDefinitions} profile={profile}/>

  const appNavigation: NavigationController = { ...navigation, navigate: (to, options) => navigation.navigate(buildDraftRouteRef.current && to.page.page === 'builds' && to.page.view === 'library' ? buildDraftRouteRef.current : to, options) }
  const buildRoute = navigation.route.page.page === 'builds' ? navigation.route : buildDraftRouteRef.current
  const buildContent = buildRoute && <div hidden={destination !== 'builds'}><NavigationProvider controller={{ ...appNavigation, route: buildRoute, destination: 'builds' }}><BuildsView catalogs={workspace.catalogs} onAssign={assignScenario} onCloneBuild={cloneExistingBuild} onCreateBuild={addBuild} onCreateScenario={addScenario} onDraftChange={setBuildDraftDirty} onRecordCurrent={recordBuildCurrent} onSaveRevision={saveRevision} profile={profile} validations={validations}/></NavigationProvider></div>
  const draftReminder = destination === 'reference' && buildDraftRouteRef.current && <div className="build-draft-reminder"><InlineNotice title="Your build draft is kept in this tab">Browse reference records, then return to finish your build. Save before closing or reloading this tab.</InlineNotice><Button onClick={() => { if (buildDraftRouteRef.current) navigation.navigate(buildDraftRouteRef.current) }} tone="secondary">Return to build draft</Button></div>

  return <NavigationProvider controller={appNavigation}><CorrectionsContext.Provider value={corrections}><DefinitionProvider catalogs={corrections.catalogs} onSaveDefinition={saveDefinition} profile={profile}><Shell catalogs={workspace.catalogs} contextBusy={importBusy || saveState === 'saving'} destination={destination} onOpenData={openData} onSelectProfile={selectContextProfile} onSelectRuleset={selectRuleset} onSelectScenario={selectScenario} profile={profile} profiles={profiles} saveState={formDirty ? 'unsaved' : saveState}>{navigationWarning && <div className="external-update"><InlineNotice title="Unsaved edits are still open" tone="warning">Choose how to resolve the open edits, then continue to the page you selected.</InlineNotice><div className="cluster"><Button disabled={resolvingDraft} onClick={() => void resolveDraftNavigation('discard')} tone="quiet">Discard and continue</Button><Button disabled={resolvingDraft} icon="check" onClick={() => void resolveDraftNavigation('save')}>{resolvingDraft ? 'Saving...' : 'Save and continue'}</Button></div></div>}{externalUpdate && <div className="external-update"><InlineNotice title="Another tab changed this profile" tone="warning">Review or finish any open form before loading the newer local revision.</InlineNotice><Button disabled={dirty || formDirty || saveState === 'saving'} onClick={() => void loadExternalUpdate().catch((reason: unknown) => setSaveError(formatAppError(reason, 'The newer profile revision could not be loaded.')))} tone="secondary">{dirty || formDirty ? 'Finish the open draft before loading' : 'Load newer revision'}</Button></div>}{saveError && <div className="external-update"><InlineNotice title={dirty ? 'Local save failed' : 'Change not saved'} tone="danger">{saveError} {dirty ? 'Your draft remains open. Retry this exact revision or export a recovery copy.' : 'Review the open form and try again.'}</InlineNotice>{dirty && <Button disabled={saveState === 'saving'} onClick={() => void retrySave().catch(() => undefined)} tone="secondary">{saveState === 'saving' ? 'Retrying...' : 'Retry save'}</Button>}</div>}{buildContent}{draftReminder}{content}</Shell><DataPanel busy={importBusy || saveState === 'saving'} canUndo={workspace.canUndo} dirty={dirty || formDirty} importError={importError} onClearPreview={() => { setImportPreview(undefined); setImportError(undefined); navigation.navigate({ page: { page: 'settings', section: 'data' }, overlays: [], query: {} }, { replace: true }) }} onClose={closeData} onCommit={handleImport} onCreateProfile={createLocalProfile} onExport={exportCurrentProfile} onPreview={handlePreview} onSaveRuleset={saveRuleset} onSelectProfile={selectLocalProfile} onUndo={undoLatestChange} open={dataOpen} preview={importPreview} profile={profile} profiles={profiles} saveError={saveError}/><CorrectionSurfaces/></DefinitionProvider></CorrectionsContext.Provider></NavigationProvider>
}
