import {
  asTimestamp,
  assertExpectedRevision,
  assertPersonalDefinitionRef,
  assertTextLength,
  createId,
  DomainError,
  nowTimestamp,
  updateLocalData,
} from './core'
import { MAX_SHORT_TEXT_LENGTH } from './limits'
import { normalizeBuildTags } from './build-tags'
import { validateCalculationPlan } from './calculation-plan'
import { definitionLineageRootRef } from './definitions'
import type {
  Build,
  BuildId,
  BuildRevision,
  BuildRevisionContent,
  BuildRevisionId,
  CatalogRevisionId,
  GameSetupId,
  LocalData,
  GameSetupRevisionId,
  Timestamp,
} from './types'

export interface CreateBuildInput {
  readonly id?: BuildId
  readonly gameSetupId: GameSetupId
  readonly title: string
  readonly archived?: boolean
  readonly tags?: readonly string[]
  readonly favorite?: boolean
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export function createBuild(localData: LocalData, input: CreateBuildInput): LocalData {
  assertExpectedRevision(localData, input.expectedRevision)
  const title = input.title.trim()
  if (!title) {
    throw new DomainError('INVALID_INPUT', 'Build title must not be empty')
  }
  assertTextLength(title, 'Build title', MAX_SHORT_TEXT_LENGTH)
  if (!Object.values(localData.gameSetups).some(revision => revision.gameSetupId === input.gameSetupId)) {
    throw new DomainError('MISSING_GAME_SETUP', `Game Setup does not exist: ${input.gameSetupId}`)
  }
  const id = input.id ?? createId<BuildId>('build')
  if (localData.builds[id]) {
    throw new DomainError('DUPLICATE_ID', `Build already exists: ${id}`)
  }
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  const build: Build = {
    id,
    gameSetupId: input.gameSetupId,
    revision: 0,
    title,
    archived: input.archived ?? false,
    tags: normalizeBuildTags(input.tags ?? []),
    favorite: input.favorite ?? false,
    createdAt: at,
    updatedAt: at,
  }
  return updateLocalData(
    localData,
    { builds: { ...localData.builds, [id]: build } },
    'build.create',
    [`builds.${id}`],
    at,
  )
}

export interface UpdateBuildInput {
  readonly buildId: BuildId
  readonly title?: string
  readonly archived?: boolean
  readonly tags?: readonly string[]
  readonly favorite?: boolean
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export function updateBuild(localData: LocalData, input: UpdateBuildInput): LocalData {
  assertExpectedRevision(localData, input.expectedRevision)
  const current = localData.builds[input.buildId]
  if (!current) {
    throw new DomainError('MISSING_BUILD', `Build does not exist: ${input.buildId}`)
  }
  const title = input.title?.trim() ?? current.title
  if (!title) {
    throw new DomainError('INVALID_INPUT', 'Build title must not be empty')
  }
  assertTextLength(title, 'Build title', MAX_SHORT_TEXT_LENGTH)
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  const build: Build = {
    ...current,
    title,
    archived: input.archived ?? current.archived,
    tags: input.tags === undefined ? current.tags : normalizeBuildTags(input.tags),
    favorite: input.favorite ?? current.favorite,
    revision: current.revision + 1,
    updatedAt: at,
  }
  return updateLocalData(
    localData,
    { builds: { ...localData.builds, [build.id]: build } },
    'build.update',
    [`builds.${build.id}`],
    at,
  )
}

export interface CloneBuildInput {
  readonly sourceBuildId: BuildId
  readonly id?: BuildId
  readonly revisionId?: BuildRevisionId
  readonly title?: string
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export function cloneBuild(localData: LocalData, input: CloneBuildInput): LocalData {
  assertExpectedRevision(localData, input.expectedRevision)
  const source = localData.builds[input.sourceBuildId]
  if (!source) {
    throw new DomainError('MISSING_BUILD', `Build does not exist: ${input.sourceBuildId}`)
  }
  const sourceRevision = source.latestRevisionId
    ? localData.buildRevisions[source.latestRevisionId]
    : undefined
  if (!sourceRevision || sourceRevision.buildId !== source.id) {
    throw new DomainError('MISSING_BUILD_REVISION', 'Build must have a latest revision before it can be cloned')
  }
  const title = input.title === undefined ? `${source.title} (copy)` : input.title.trim()
  if (!title) {
    throw new DomainError('INVALID_INPUT', 'Build title must not be empty')
  }
  assertTextLength(title, 'Build title', MAX_SHORT_TEXT_LENGTH)
  const id = input.id ?? createId<BuildId>('build')
  if (localData.builds[id]) {
    throw new DomainError('DUPLICATE_ID', `Build already exists: ${id}`)
  }
  const revisionId = input.revisionId ?? createId<BuildRevisionId>('buildRevision')
  if (localData.buildRevisions[revisionId]) {
    throw new DomainError('DUPLICATE_ID', `Build revision already exists: ${revisionId}`)
  }
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  const content: BuildRevisionContent = {
    primaryClass: sourceRevision.content.primaryClass,
    secondaryClass: sourceRevision.content.secondaryClass,
    equipment: Object.fromEntries(Object.entries(sourceRevision.content.equipment).map(([slotId, selection]) => [
      slotId,
      selection === null ? null : { ...selection },
    ])),
    passives: sourceRevision.content.passives.map(selection => ({ ...selection })),
    ...(sourceRevision.content.rotationNotes === undefined ? {} : { rotationNotes: sourceRevision.content.rotationNotes }),
    contextAssumptions: [...sourceRevision.content.contextAssumptions],
    ...(sourceRevision.content.calculation ? { calculation: structuredClone(sourceRevision.content.calculation) } : {}),
  }
  const revision: BuildRevision = {
    id: revisionId,
    buildId: id,
    revision: 1,
    gameSetupRevisionId: sourceRevision.gameSetupRevisionId,
    catalogLock: { ...sourceRevision.catalogLock },
    content,
    createdAt: at,
    ...(sourceRevision.note === undefined ? {} : { note: sourceRevision.note }),
  }
  const build: Build = {
    id,
    gameSetupId: source.gameSetupId,
    revision: 1,
    title,
    archived: false,
    tags: [...source.tags],
    favorite: source.favorite,
    latestRevisionId: revisionId,
    createdAt: at,
    updatedAt: at,
  }
  return updateLocalData(
    localData,
    {
      builds: { ...localData.builds, [id]: build },
      buildRevisions: { ...localData.buildRevisions, [revisionId]: revision },
    },
    'build.clone',
    [`builds.${id}`, `buildRevisions.${revisionId}`],
    at,
  )
}

export interface ForkBuildToGameSetupInput {
  readonly sourceBuildId: BuildId
  readonly targetGameSetupRevisionId: GameSetupRevisionId
  readonly id?: BuildId
  readonly revisionId?: BuildRevisionId
  readonly title?: string
  readonly content?: BuildRevisionContent
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

function forkContentForGameSetup(
  content: BuildRevisionContent,
  sourceSetupLabel: string,
  targetSetup: LocalData['gameSetups'][string],
): BuildRevisionContent {
  const targetSlotIds = new Set(targetSetup.slots.map((slot) => slot.id as string))
  const omittedSlotIds = Object.entries(content.equipment)
    .filter(([slotId, selection]) => !targetSlotIds.has(slotId) && selection !== null)
    .map(([slotId]) => slotId)
  const equipment = Object.fromEntries(
    Object.entries(content.equipment)
      .filter(([slotId]) => targetSlotIds.has(slotId))
      .map(([slotId, selection]) => [slotId, selection === null ? null : { ...selection }]),
  )
  const omission = omittedSlotIds.length > 0
    ? [`Fork omitted ${omittedSlotIds.length} equipped selection${omittedSlotIds.length === 1 ? '' : 's'} from slots that ${targetSetup.label} does not define. Inspect the original Build under ${sourceSetupLabel} for the retained source values.`]
    : []
  return {
    primaryClass: content.primaryClass,
    secondaryClass: content.secondaryClass,
    equipment,
    passives: content.passives.map((selection) => ({ ...selection })),
    ...(content.rotationNotes === undefined ? {} : { rotationNotes: content.rotationNotes }),
    contextAssumptions: [...content.contextAssumptions, ...omission],
    ...(content.calculation ? { calculation: structuredClone(content.calculation) } : {}),
  }
}

export function forkBuildToGameSetup(localData: LocalData, input: ForkBuildToGameSetupInput): LocalData {
  assertExpectedRevision(localData, input.expectedRevision)
  const source = localData.builds[input.sourceBuildId]
  if (!source) throw new DomainError('MISSING_BUILD', `Build does not exist: ${input.sourceBuildId}`)
  const sourceRevision = source.latestRevisionId ? localData.buildRevisions[source.latestRevisionId] : undefined
  if (!sourceRevision || sourceRevision.buildId !== source.id) {
    throw new DomainError('MISSING_BUILD_REVISION', 'Build must have a latest revision before it can be forked')
  }
  const targetSetup = localData.gameSetups[input.targetGameSetupRevisionId]
  if (!targetSetup) {
    throw new DomainError('MISSING_GAME_SETUP', `Game Setup revision does not exist: ${input.targetGameSetupRevisionId}`)
  }
  if (targetSetup.gameSetupId === source.gameSetupId) {
    throw new DomainError('INVALID_INPUT', 'Save a new Build revision when moving within the same Game Setup')
  }
  const sourceSetup = localData.gameSetups[sourceRevision.gameSetupRevisionId]
  if (!sourceSetup) {
    throw new DomainError('MISSING_GAME_SETUP', `Source Game Setup revision does not exist: ${sourceRevision.gameSetupRevisionId}`)
  }
  const title = input.title === undefined ? `${source.title} (${targetSetup.label})` : input.title.trim()
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  const id = input.id ?? createId<BuildId>('build')
  const revisionId = input.revisionId ?? createId<BuildRevisionId>('buildRevision')
  let next = createBuild(localData, {
    id,
    gameSetupId: targetSetup.gameSetupId,
    title,
    archived: false,
    tags: [...source.tags],
    favorite: source.favorite,
    now: at,
    expectedRevision: localData.revision,
  })
  next = saveBuildRevision(next, {
    buildId: id,
    id: revisionId,
    gameSetupRevisionId: input.targetGameSetupRevisionId,
    content: input.content ?? forkContentForGameSetup(sourceRevision.content, sourceSetup.label, targetSetup),
    note: `Forked from ${source.title}`,
    now: at,
    expectedRevision: next.revision,
  })
  return next
}

export interface SaveBuildRevisionInput {
  readonly buildId: BuildId
  readonly id?: BuildRevisionId
  readonly parentRevisionId?: BuildRevisionId
  readonly gameSetupRevisionId: GameSetupRevisionId
  readonly catalogLock?: Readonly<Record<string, CatalogRevisionId>>
  readonly content: BuildRevisionContent
  readonly note?: string
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export function saveBuildRevision(localData: LocalData, input: SaveBuildRevisionInput): LocalData {
  assertExpectedRevision(localData, input.expectedRevision)
  const current = localData.builds[input.buildId]
  if (!current) {
    throw new DomainError('MISSING_BUILD', `Build does not exist: ${input.buildId}`)
  }
  const gameSetup = localData.gameSetups[input.gameSetupRevisionId]
  if (!gameSetup) {
    throw new DomainError('MISSING_GAME_SETUP', `Game Setup revision does not exist: ${input.gameSetupRevisionId}`)
  }
  if (input.parentRevisionId) {
    const parent = localData.buildRevisions[input.parentRevisionId]
    if (!parent || parent.buildId !== input.buildId) {
      throw new DomainError('MISSING_BUILD_REVISION', 'Parent build revision does not belong to this build')
    }
  }
  const id = input.id ?? createId<BuildRevisionId>('buildRevision')
  if (localData.buildRevisions[id]) {
    throw new DomainError('DUPLICATE_ID', `Build revision already exists: ${id}`)
  }
  const catalogLock = input.catalogLock ?? gameSetup.catalogLock
  const slotIds = new Set(gameSetup.slots.map((slot) => slot.id as string))
  const assertBuildRef = (ref: import('./types').EntityRef, label: string) => {
    assertPersonalDefinitionRef(localData, ref)
    const rootRef = definitionLineageRootRef(localData, ref)
    if (rootRef.kind === 'catalog' && catalogLock[rootRef.catalogId] !== rootRef.catalogRevisionId) {
      throw new DomainError('INVALID_INPUT', `${label} falls outside the build catalog lock`)
    }
  }
  if (input.content.primaryClass) assertBuildRef(input.content.primaryClass, 'Primary class')
  if (input.content.secondaryClass) assertBuildRef(input.content.secondaryClass, 'Secondary class')
  if (input.content.calculation) {
    const plan = input.content.calculation
    validateCalculationPlan(plan, assertBuildRef)
  }
  for (const [slotId, selection] of Object.entries(input.content.equipment)) {
    if (!slotId.trim() || !slotIds.has(slotId)) {
      throw new DomainError('INVALID_INPUT', `Build selection references an unknown Game Setup slot: ${slotId}`)
    }
    if (!selection) continue
    assertBuildRef(selection.ref, `Selection ${slotId}`)
    if (selection.allocationId !== undefined && !selection.allocationId.trim()) {
      throw new DomainError('INVALID_INPUT', 'Allocation ID must not be empty')
    }
  }
  for (const [index, selection] of input.content.passives.entries()) assertBuildRef(selection.ref, `Equipped passive ${index + 1}`)
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  const revision: BuildRevision = {
    id,
    buildId: input.buildId,
    revision: current.revision + 1,
    gameSetupRevisionId: input.gameSetupRevisionId,
    catalogLock,
    content: input.content,
    createdAt: at,
    ...(input.parentRevisionId === undefined ? {} : { parentRevisionId: input.parentRevisionId }),
    ...(input.note === undefined ? {} : { note: input.note }),
  }
  const build: Build = {
    ...current,
    gameSetupId: gameSetup.gameSetupId,
    revision: current.revision + 1,
    latestRevisionId: id,
    updatedAt: at,
  }
  return updateLocalData(
    localData,
    {
      builds: { ...localData.builds, [build.id]: build },
      buildRevisions: { ...localData.buildRevisions, [id]: revision },
    },
    'build.saveRevision',
    [`builds.${build.id}`, `buildRevisions.${id}`],
    at,
  )
}
