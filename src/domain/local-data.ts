import {
  asTimestamp,
  assertExpectedRevision,
  assertFiniteNumber,
  assertNonnegativeInteger,
  assertPersonalDefinitionRef,
  assertTextLength,
  createId,
  DomainError,
  entityDefinitionKey,
  nowTimestamp,
  updateLocalData,
  updatePlaythrough,
} from './core'
import {
  definitionLineageRootRef,
  logicalEntityKey,
  personalDefinitionRef,
  preferredDefinitionRef,
  resolveDefinition,
} from './definitions'
import { MAX_ID_LENGTH, MAX_LONG_TEXT_LENGTH, MAX_SHORT_TEXT_LENGTH } from './limits'
import { assertModConfiguration } from './mods'
import { assertModComposition, modCatalogRevision } from './mod-layers'
import { sameCorrectionValue, synchronizePlanningField } from './corrections'
import type {
  CatalogSnapshot,
  CatalogRevisionId,
  CatalogEntityKind,
  EntityRef,
  JsonValue,
  Knowledge,
  PersonalDefinition,
  PersonalDefinitionId,
  PersonalRef,
  LocalData,
  LocalDataId,
  Playthrough,
  PlaythroughId,
  GameSetupId,
  GameSetupRevision,
  GameSetupRevisionId,
  SlotDefinition,
  SourceRef,
  Timestamp,
} from './types'

export interface CreateBlankLocalDataInput {
  readonly id?: LocalDataId
  readonly now?: Timestamp | string
}

export function createBlankLocalData(input: CreateBlankLocalDataInput = {}): LocalData {
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  return {
    schemaVersion: '2.0.0',
    id: input.id ?? createId<LocalDataId>('localData'),
    revision: 0,
    createdAt: at,
    updatedAt: at,
    personalDefinitions: {},
    gameSetups: {},
    builds: {},
    buildRevisions: {},
    playthroughs: {},
    importReceipts: {},
    changes: [],
  }
}

export interface CreatePlaythroughInput {
  readonly id?: PlaythroughId
  readonly label: string
  readonly currentGameSetupRevisionId?: GameSetupRevisionId
  readonly select?: boolean
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export function createPlaythrough(localData: LocalData, input: CreatePlaythroughInput): LocalData {
  assertExpectedRevision(localData, input.expectedRevision)
  const label = input.label.trim()
  if (!label) throw new DomainError('INVALID_INPUT', 'Playthrough label must not be empty')
  assertTextLength(label, 'Playthrough label', MAX_SHORT_TEXT_LENGTH)
  if (input.currentGameSetupRevisionId && !localData.gameSetups[input.currentGameSetupRevisionId]) {
    throw new DomainError('MISSING_GAME_SETUP', 'The selected Game Setup revision does not exist')
  }
  const id = input.id ?? createId<PlaythroughId>('playthrough')
  if (localData.playthroughs[id]) throw new DomainError('DUPLICATE_ID', `Playthrough already exists: ${id}`)
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  const playthrough: Playthrough = {
    id,
    revision: 0,
    label,
    createdAt: at,
    updatedAt: at,
    ...(input.currentGameSetupRevisionId ? { currentGameSetupRevisionId: input.currentGameSetupRevisionId } : {}),
    inventory: {},
    inventoryEvents: {},
    characters: {},
    progress: {},
    scenarios: {},
    goals: {},
  }
  const select = input.select ?? localData.selectedPlaythroughId === undefined
  return updateLocalData(
    localData,
    {
      playthroughs: { ...localData.playthroughs, [id]: playthrough },
      ...(select ? { selectedPlaythroughId: id } : {}),
    },
    'playthrough.create',
    [`playthroughs.${id}`, ...(select ? ['selectedPlaythroughId'] : [])],
    at,
  )
}

export interface SelectPlaythroughInput {
  readonly playthroughId: PlaythroughId
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export function selectPlaythrough(localData: LocalData, input: SelectPlaythroughInput): LocalData {
  assertExpectedRevision(localData, input.expectedRevision)
  const playthrough = localData.playthroughs[input.playthroughId]
  if (!playthrough) throw new DomainError('MISSING_PLAYTHROUGH', `Playthrough does not exist: ${input.playthroughId}`)
  if (localData.selectedPlaythroughId === input.playthroughId) return localData
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  return updateLocalData(
    localData,
    {
      selectedPlaythroughId: input.playthroughId,
      ...(playthrough.currentGameSetupRevisionId ? { planningGameSetupRevisionId: playthrough.currentGameSetupRevisionId } : {}),
    },
    'playthrough.select',
    ['selectedPlaythroughId', ...(playthrough.currentGameSetupRevisionId ? ['planningGameSetupRevisionId'] : [])],
    at,
  )
}

export interface SetPlaythroughGameSetupInput {
  readonly playthroughId?: PlaythroughId
  readonly gameSetupRevisionId: GameSetupRevisionId
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export function setPlaythroughGameSetup(localData: LocalData, input: SetPlaythroughGameSetupInput): LocalData {
  assertExpectedRevision(localData, input.expectedRevision)
  if (!localData.gameSetups[input.gameSetupRevisionId]) {
    throw new DomainError('MISSING_GAME_SETUP', `Game Setup revision does not exist: ${input.gameSetupRevisionId}`)
  }
  const playthroughId = input.playthroughId ?? localData.selectedPlaythroughId
  if (!playthroughId) throw new DomainError('MISSING_PLAYTHROUGH', 'Select a playthrough before changing its Game Setup')
  const playthrough = localData.playthroughs[playthroughId]
  if (!playthrough) throw new DomainError('MISSING_PLAYTHROUGH', `Playthrough does not exist: ${playthroughId}`)
  if (playthrough.currentGameSetupRevisionId === input.gameSetupRevisionId) return localData
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  const nextLocalData = updatePlaythrough(
    localData,
    playthroughId,
    { currentGameSetupRevisionId: input.gameSetupRevisionId },
    'playthrough.setGameSetup',
    ['currentGameSetupRevisionId'],
    at,
  )
  if (localData.selectedPlaythroughId !== playthroughId) return nextLocalData
  return {
    ...nextLocalData,
    planningGameSetupRevisionId: input.gameSetupRevisionId,
    changes: nextLocalData.changes.map((change, index) => index === nextLocalData.changes.length - 1
      ? { ...change, changedPaths: [...change.changedPaths, 'planningGameSetupRevisionId'] }
      : change),
  }
}

export interface CreatePersonalDefinitionInput {
  readonly id?: PersonalDefinitionId
  readonly kind: CatalogEntityKind
  readonly name: string
  readonly aliases?: readonly string[]
  readonly rawDescription?: string
  readonly fields?: Readonly<Record<string, Knowledge<JsonValue>>>
  readonly slotKinds?: PersonalDefinition['slotKinds']
  readonly ppCost?: PersonalDefinition['ppCost']
  readonly listedContributions?: PersonalDefinition['listedContributions']
  readonly requirements?: PersonalDefinition['requirements']
  readonly grants?: PersonalDefinition['grants']
  readonly sources?: readonly SourceRef[]
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

function knowledgeValues<Value>(knowledge: Knowledge<Value> | undefined): readonly Value[] {
  if (knowledge?.state === 'known') return [knowledge.value]
  if (knowledge?.state === 'conflicting') return knowledge.claims.map((claim) => claim.value)
  return []
}

function validateEditableDefinition(
  definition: Pick<PersonalDefinition, 'name' | 'aliases' | 'rawDescription' | 'fields' | 'ppCost' | 'listedContributions' | 'requirements'>,
  localData: LocalData,
  allowedDefinitionId?: PersonalDefinitionId,
): void {
  if (!definition.name.trim()) throw new DomainError('INVALID_INPUT', 'Personal definition name must not be empty')
  assertTextLength(definition.name, 'Personal definition name', MAX_SHORT_TEXT_LENGTH)
  for (const alias of definition.aliases) {
    assertTextLength(alias, 'Personal definition alias', MAX_SHORT_TEXT_LENGTH)
  }
  if (definition.rawDescription !== undefined) {
    assertTextLength(definition.rawDescription, 'Personal definition description', MAX_LONG_TEXT_LENGTH)
  }
  for (const key of Object.keys(definition.fields)) {
    if (!key.trim() || ['__proto__', 'prototype', 'constructor'].includes(key) || /[\u0000-\u001f\u007f]/.test(key)) throw new DomainError('INVALID_INPUT', 'Personal definition field name is invalid')
    assertTextLength(key, 'Personal definition field name', MAX_ID_LENGTH)
  }
  for (const value of knowledgeValues(definition.ppCost)) assertFiniteNumber(value, 'PP cost')
  for (const [key, contribution] of Object.entries(definition.listedContributions ?? {})) {
    if (!key.trim()) throw new DomainError('INVALID_INPUT', 'Contribution key must not be empty')
    assertTextLength(key, 'Contribution key', MAX_ID_LENGTH)
    for (const value of knowledgeValues(contribution)) {
      assertFiniteNumber(value.value, `Contribution ${key}`)
      if (!value.unit.trim()) throw new DomainError('INVALID_INPUT', `Contribution ${key} unit must not be empty`)
      assertTextLength(value.unit, `Contribution ${key} unit`, MAX_SHORT_TEXT_LENGTH)
    }
  }
  for (const values of knowledgeValues(definition.requirements)) {
    for (const requirement of values) {
      if (requirement.kind === 'selected') assertPersonalDefinitionRef(localData, requirement.ref, allowedDefinitionId)
      else if (!requirement.permission.trim()) throw new DomainError('INVALID_INPUT', 'Permission must not be empty')
    }
  }
}

export function createPersonalDefinition(localData: LocalData, input: CreatePersonalDefinitionInput): LocalData {
  assertExpectedRevision(localData, input.expectedRevision)
  const name = input.name.trim()
  const id = input.id ?? createId<PersonalDefinitionId>('definition')
  if (localData.personalDefinitions[id]) {
    throw new DomainError('DUPLICATE_ID', `Personal definition already exists: ${id}`)
  }
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  let definition: PersonalDefinition = {
    id,
    revision: 0,
    kind: input.kind,
    name,
    aliases: input.aliases ?? [],
    fields: input.fields ?? {},
    sources: input.sources ?? [],
    createdAt: at,
    updatedAt: at,
    ...(input.rawDescription === undefined ? {} : { rawDescription: input.rawDescription }),
    ...(input.slotKinds === undefined ? {} : { slotKinds: input.slotKinds }),
    ...(input.ppCost === undefined ? {} : { ppCost: input.ppCost }),
    ...(input.listedContributions === undefined ? {} : { listedContributions: input.listedContributions }),
    ...(input.requirements === undefined ? {} : { requirements: input.requirements }),
    ...(input.grants === undefined ? {} : { grants: input.grants }),
  }
  for (const field of Object.keys(definition.fields)) definition = synchronizePlanningField(definition, field)
  validateEditableDefinition(definition, localData, id)
  return updateLocalData(
    localData,
    { personalDefinitions: { ...localData.personalDefinitions, [id]: definition } },
    'personalDefinition.create',
    [`personalDefinitions.${id}`],
    at,
  )
}

export interface CreateDefinitionOverrideInput {
  readonly sourceRef: EntityRef
  readonly id?: PersonalDefinitionId
  readonly name?: string
  readonly aliases?: readonly string[]
  readonly rawDescription?: string | null
  readonly category?: Knowledge<string> | null
  readonly ppCost?: Knowledge<number> | null
  readonly fieldClaimSelections?: Readonly<Record<string, number>>
  readonly fieldUpdates?: Readonly<Record<string, Knowledge<JsonValue> | null>>
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export interface DefinitionOverrideResult {
  readonly localData: LocalData
  readonly ref: PersonalRef
  readonly definition: PersonalDefinition
}

export function createDefinitionOverride(
  localData: LocalData,
  catalogs: readonly CatalogSnapshot[],
  input: CreateDefinitionOverrideInput,
): DefinitionOverrideResult {
  assertExpectedRevision(localData, input.expectedRevision)
  const preferred = preferredDefinitionRef(localData, input.sourceRef)
  if (entityDefinitionKey(preferred) !== entityDefinitionKey(input.sourceRef)) {
    throw new DomainError('REVISION_CONFLICT', 'A newer personal definition revision already exists')
  }
  const source = resolveDefinition(localData, catalogs, input.sourceRef)
  if (!source) throw new DomainError('INVALID_INPUT', 'The definition to edit is unavailable')
  for (const category of knowledgeValues(input.category ?? undefined)) {
    if (!category.trim()) throw new DomainError('INVALID_INPUT', 'Personal definition category must be nonempty text')
    assertTextLength(category, 'Personal definition category', MAX_SHORT_TEXT_LENGTH)
  }
  const id = input.id ?? createId<PersonalDefinitionId>('definition')
  if (localData.personalDefinitions[id]) {
    throw new DomainError('DUPLICATE_ID', `Personal definition already exists: ${id}`)
  }
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  const selectedFields = { ...source.fields }
  for (const [field, value] of Object.entries(input.fieldUpdates ?? {})) {
    if (['__proto__', 'prototype', 'constructor'].includes(field) || !field.trim() || /[\u0000-\u001f\u007f]/.test(field)) throw new DomainError('INVALID_INPUT', 'Personal definition field name is invalid')
    if (Object.hasOwn(input.fieldClaimSelections ?? {}, field)) throw new DomainError('INVALID_INPUT', `Choose a source claim or edit ${field}, not both`)
    if (value === null) delete selectedFields[field]
    else selectedFields[field] = value
  }
  for (const [field, index] of Object.entries(input.fieldClaimSelections ?? {})) {
    const value = Object.hasOwn(source.fields, field) ? source.fields[field] : undefined
    if (value?.state !== 'conflicting' || !Number.isInteger(index) || index < 0 || index >= value.claims.length) {
      throw new DomainError('INVALID_INPUT', `Choose an available source claim for ${field}`)
    }
    if (field.trim().toLocaleLowerCase() === 'category' && input.category !== undefined) {
      throw new DomainError('INVALID_INPUT', 'Choose a category claim or edit the category, not both')
    }
    const claim = value.claims[index]
    selectedFields[field] = { state: 'known', value: claim.value, sources: claim.sources }
  }
  const fieldsWithoutCategory = Object.fromEntries(
    Object.entries(selectedFields).filter(([key]) => key.trim().toLocaleLowerCase() !== 'category'),
  )
  const fields: Readonly<Record<string, Knowledge<JsonValue>>> = input.category === undefined
    ? selectedFields
    : input.category === null
      ? fieldsWithoutCategory
      : { ...fieldsWithoutCategory, category: input.category }
  const previous = input.sourceRef.kind === 'personal'
    ? localData.personalDefinitions[input.sourceRef.definitionId]
    : undefined
  let definition: PersonalDefinition = {
    id,
    revision: previous ? previous.revision + 1 : 1,
    baseRef: definitionLineageRootRef(localData, input.sourceRef),
    ...(input.sourceRef.kind === 'personal' ? { previousRevision: input.sourceRef } : {}),
    kind: source.kind,
    name: input.name === undefined ? source.name : input.name.trim(),
    aliases: input.aliases ?? source.aliases,
    fields,
    sources: source.sources,
    createdAt: at,
    updatedAt: at,
    ...((input.rawDescription === undefined ? source.rawDescription : input.rawDescription) === undefined || input.rawDescription === null
      ? {}
      : { rawDescription: input.rawDescription === undefined ? source.rawDescription : input.rawDescription }),
    ...(source.slotKinds === undefined ? {} : { slotKinds: source.slotKinds }),
    ...((input.ppCost === undefined ? source.ppCost : input.ppCost) === undefined || input.ppCost === null
      ? {}
      : { ppCost: input.ppCost === undefined ? source.ppCost : input.ppCost }),
    ...(source.listedContributions === undefined ? {} : { listedContributions: source.listedContributions }),
    ...(source.requirements === undefined ? {} : { requirements: source.requirements }),
    ...(source.grants === undefined ? {} : { grants: source.grants }),
  }
  for (const field of new Set([...Object.keys(input.fieldUpdates ?? {}), ...Object.keys(input.fieldClaimSelections ?? {})])) definition = synchronizePlanningField(definition, field)
  validateEditableDefinition(definition, localData, id)
  const nextLocalData = updateLocalData(
    localData,
    { personalDefinitions: { ...localData.personalDefinitions, [id]: definition } },
    'personalDefinition.override',
    [`personalDefinitions.${id}`],
    at,
  )
  return { localData: nextLocalData, ref: personalDefinitionRef(definition), definition }
}

export interface AddGameSetupRevisionInput {
  readonly id?: GameSetupRevisionId
  readonly gameSetupId?: GameSetupId
  readonly revision?: number
  readonly label: string
  readonly platform?: Knowledge<string>
  readonly gameVersion?: Knowledge<string>
  readonly mode?: Knowledge<string>
  readonly mods?: Knowledge<readonly string[]>
  readonly disabledMods?: Knowledge<readonly string[]>
  readonly ppLimit?: Knowledge<number>
  readonly ppCostsNonNegative?: Knowledge<boolean>
  readonly slots?: readonly SlotDefinition[]
  readonly catalogLock?: GameSetupRevision['catalogLock']
  readonly definitionOverrides?: readonly PersonalRef[]
  readonly modComposition?: GameSetupRevision['modComposition']
  readonly modCatalogRevisionId?: CatalogRevisionId
  readonly activate?: boolean
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

const UNKNOWN_STRING: Knowledge<string> = { state: 'unknown' }
const UNKNOWN_STRINGS: Knowledge<readonly string[]> = { state: 'unknown' }
export const DEFAULT_PP_LIMIT = 10
export const DEFAULT_PP_COSTS_NONNEGATIVE = true
export const DEFAULT_GAME_VERSION = '1.6.6'

export function addGameSetupRevision(localData: LocalData, input: AddGameSetupRevisionInput): LocalData {
  assertExpectedRevision(localData, input.expectedRevision)
  assertModConfiguration({ mods: input.mods ?? UNKNOWN_STRINGS, disabledMods: input.disabledMods })
  const id = input.id ?? createId<GameSetupRevisionId>('gameSetupRevision')
  if (localData.gameSetups[id]) {
    throw new DomainError('DUPLICATE_ID', `Game Setup revision already exists: ${id}`)
  }
  if (input.modComposition) assertModComposition(input.modComposition)
  const effectiveRevision = input.modComposition ? input.modCatalogRevisionId ?? modCatalogRevision(id) : undefined
  for (const ref of input.definitionOverrides ?? []) {
    const root = definitionLineageRootRef(localData, ref)
    if (input.modComposition && root.kind === 'catalog' && root.catalogId === input.modComposition.baseline.catalogId && root.catalogRevisionId !== effectiveRevision) throw new DomainError('INVALID_INPUT', 'Review personal overrides before changing imported layers; their exact source revisions cannot be carried into the new effective catalog')
  }
  const revision = input.revision ?? 1
  assertNonnegativeInteger(revision, 'Game Setup revision')
  for (const value of knowledgeValues(input.ppLimit)) assertNonnegativeInteger(value, 'PP limit')
  const slots = input.slots ?? []
  const slotIds = new Set<string>()
  for (const slot of slots) {
    if (!slot.id.trim()) throw new DomainError('INVALID_INPUT', 'Slot ID must not be empty')
    if (slotIds.has(slot.id)) throw new DomainError('INVALID_INPUT', `Duplicate slot ID: ${slot.id}`)
    if (!slot.label.trim()) throw new DomainError('INVALID_INPUT', 'Slot label must not be empty')
    if (!Number.isSafeInteger(slot.order)) throw new DomainError('INVALID_INPUT', 'Slot order must be a safe integer')
    if (slot.kind !== 'equipment') throw new DomainError('INVALID_INPUT', 'Game Setup slots describe equipment only; passives use the shared PP budget')
    slotIds.add(slot.id)
  }
  const overrideKeys = new Set<string>()
  for (const ref of input.definitionOverrides ?? []) {
    assertPersonalDefinitionRef(localData, ref)
    const key = logicalEntityKey(localData, ref)
    if (overrideKeys.has(key)) {
      throw new DomainError('DUPLICATE_REFERENCE', 'Game Setup definition overrides contain the same logical entity twice')
    }
    const root = definitionLineageRootRef(localData, ref)
    if (root.kind === 'catalog' && (input.catalogLock ?? {})[root.catalogId] !== root.catalogRevisionId) {
      throw new DomainError('INVALID_INPUT', 'A Game Setup definition override falls outside the catalog lock')
    }
    overrideKeys.add(key)
  }
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  const gameSetup: GameSetupRevision = {
    id,
    gameSetupId: input.gameSetupId ?? createId<GameSetupId>('gameSetup'),
    revision,
    label: input.label.trim() || 'Untitled Game Setup',
    platform: input.platform ?? UNKNOWN_STRING,
    gameVersion: input.gameVersion ?? { state: 'known', value: DEFAULT_GAME_VERSION },
    mode: input.mode ?? UNKNOWN_STRING,
    mods: input.mods ?? UNKNOWN_STRINGS,
    ...(input.disabledMods === undefined ? {} : { disabledMods: input.disabledMods }),
    ppLimit: input.ppLimit ?? { state: 'known', value: DEFAULT_PP_LIMIT },
    ppCostsNonNegative: input.ppCostsNonNegative ?? { state: 'known', value: DEFAULT_PP_COSTS_NONNEGATIVE },
    slots: [...slots].sort((left, right) => left.order - right.order),
    catalogLock: { ...input.catalogLock, ...(input.modComposition ? { [input.modComposition.baseline.catalogId]: effectiveRevision! } : {}) },
    ...(input.modComposition ? { modComposition: input.modComposition } : {}),
    ...(input.definitionOverrides === undefined ? {} : { definitionOverrides: input.definitionOverrides }),
    createdAt: at,
  }
  const activate = input.activate ?? localData.planningGameSetupRevisionId === undefined
  return updateLocalData(
    localData,
    {
      gameSetups: { ...localData.gameSetups, [id]: gameSetup },
      ...(activate ? { planningGameSetupRevisionId: id } : {}),
    },
    'gameSetup.addRevision',
    [`gameSetups.${id}`, ...(activate ? ['planningGameSetupRevisionId'] : [])],
    at,
  )
}

export const createGameSetupRevision = addGameSetupRevision

export interface UpdateGameSetupRevisionInput {
  readonly sourceRevisionId: GameSetupRevisionId
  readonly id?: GameSetupRevisionId
  readonly label?: string
  readonly platform?: Knowledge<string>
  readonly gameVersion?: Knowledge<string>
  readonly mode?: Knowledge<string>
  readonly mods?: Knowledge<readonly string[]>
  readonly disabledMods?: Knowledge<readonly string[]>
  readonly ppLimit?: Knowledge<number>
  readonly ppCostsNonNegative?: Knowledge<boolean>
  readonly slots?: readonly SlotDefinition[]
  readonly catalogLock?: GameSetupRevision['catalogLock']
  readonly definitionOverrides?: readonly PersonalRef[]
  readonly modComposition?: GameSetupRevision['modComposition']
  readonly activate?: boolean
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export function updateGameSetupRevision(localData: LocalData, input: UpdateGameSetupRevisionInput): LocalData {
  const source = localData.gameSetups[input.sourceRevisionId]
  if (!source) {
    throw new DomainError('MISSING_GAME_SETUP', `Game Setup revision does not exist: ${input.sourceRevisionId}`)
  }
  const modComposition = input.modComposition ?? source.modComposition
  const sameComposition = modComposition && sameCorrectionValue(modComposition, source.modComposition)
  return addGameSetupRevision(localData, {
    id: input.id,
    gameSetupId: source.gameSetupId,
    revision: source.revision + 1,
    label: input.label ?? source.label,
    platform: input.platform ?? source.platform,
    gameVersion: input.gameVersion ?? source.gameVersion,
    mode: input.mode ?? source.mode,
    mods: input.mods ?? source.mods,
    disabledMods: input.disabledMods ?? source.disabledMods,
    ppLimit: input.ppLimit ?? source.ppLimit ?? { state: 'known', value: DEFAULT_PP_LIMIT },
    ppCostsNonNegative: input.ppCostsNonNegative ?? source.ppCostsNonNegative,
    slots: input.slots ?? source.slots,
    catalogLock: input.catalogLock ?? source.catalogLock,
    definitionOverrides: input.definitionOverrides ?? source.definitionOverrides,
    modComposition,
    modCatalogRevisionId: sameComposition ? source.catalogLock[modComposition.baseline.catalogId] : undefined,
    activate: input.activate ?? true,
    now: input.now,
    expectedRevision: input.expectedRevision,
  })
}

export interface CoalesceDefinitionOverridesInput {
  readonly sourceGameSetupRevisionId: GameSetupRevisionId
  readonly definitionRefs: readonly PersonalRef[]
  readonly id?: GameSetupRevisionId
  readonly label?: string
  readonly activate?: boolean
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export function coalesceDefinitionOverrides(
  localData: LocalData,
  input: CoalesceDefinitionOverridesInput,
): LocalData {
  const source = localData.gameSetups[input.sourceGameSetupRevisionId]
  if (!source) {
    throw new DomainError('MISSING_GAME_SETUP', `Game Setup revision does not exist: ${input.sourceGameSetupRevisionId}`)
  }
  const selectedByLogicalKey = new Map<string, PersonalRef>()
  const catalogLock = { ...source.catalogLock }
  for (const ref of input.definitionRefs) {
    assertPersonalDefinitionRef(localData, ref)
    if (entityDefinitionKey(preferredDefinitionRef(localData, ref)) !== entityDefinitionKey(ref)) {
      throw new DomainError('REVISION_CONFLICT', 'Only preferred personal definition revisions can enter a new Game Setup layer')
    }
    const key = logicalEntityKey(localData, ref)
    if (selectedByLogicalKey.has(key)) {
      throw new DomainError('DUPLICATE_REFERENCE', 'Definition override selection contains one logical entity twice')
    }
    selectedByLogicalKey.set(key, ref)
    const root = definitionLineageRootRef(localData, ref)
    if (root.kind === 'catalog') {
      const lockedRevision = catalogLock[root.catalogId]
      if (lockedRevision !== undefined && lockedRevision !== root.catalogRevisionId) {
        throw new DomainError('INVALID_INPUT', 'A definition override conflicts with the source Game Setup catalog lock')
      }
      catalogLock[root.catalogId] = root.catalogRevisionId
    }
  }
  const definitionOverrides = [
    ...(source.definitionOverrides ?? []).filter((ref) => !selectedByLogicalKey.has(logicalEntityKey(localData, ref))),
    ...selectedByLogicalKey.values(),
  ]
  return updateGameSetupRevision(localData, {
    sourceRevisionId: input.sourceGameSetupRevisionId,
    id: input.id,
    label: input.label,
    catalogLock,
    definitionOverrides,
    activate: input.activate ?? false,
    now: input.now,
    expectedRevision: input.expectedRevision,
  })
}

export interface ActivateGameSetupInput {
  readonly gameSetupRevisionId: GameSetupRevisionId
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export function activateGameSetup(localData: LocalData, input: ActivateGameSetupInput): LocalData {
  assertExpectedRevision(localData, input.expectedRevision)
  if (!localData.gameSetups[input.gameSetupRevisionId]) {
    throw new DomainError('MISSING_GAME_SETUP', `Game Setup revision does not exist: ${input.gameSetupRevisionId}`)
  }
  if (localData.planningGameSetupRevisionId === input.gameSetupRevisionId) {
    return localData
  }
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  return updateLocalData(
    localData,
    { planningGameSetupRevisionId: input.gameSetupRevisionId },
    'gameSetup.activate',
    ['planningGameSetupRevisionId'],
    at,
  )
}
