import {
  asTimestamp,
  assertExpectedRevision,
  assertFiniteNumber,
  assertNonnegativeInteger,
  assertPersonalDefinitionRef,
  assertPositiveInteger,
  assertTextLength,
  createId,
  DomainError,
  entityDefinitionKey,
  nowTimestamp,
  updateProfile,
} from './core'
import {
  definitionLineageRootRef,
  logicalEntityKey,
  personalDefinitionRef,
  preferredDefinitionRef,
  resolveDefinition,
} from './definitions'
import { MAX_ID_LENGTH, MAX_LONG_TEXT_LENGTH, MAX_SHORT_TEXT_LENGTH } from './limits'
import type {
  CatalogSnapshot,
  CatalogEntityKind,
  EntityRef,
  JsonValue,
  Knowledge,
  PersonalDefinition,
  PersonalDefinitionId,
  PersonalRef,
  Profile,
  ProfileId,
  RulesetId,
  RulesetRevision,
  RulesetRevisionId,
  SlotDefinition,
  SourceRef,
  Timestamp,
} from './types'

export interface CreateBlankProfileInput {
  readonly id?: ProfileId
  readonly label?: string
  readonly now?: Timestamp | string
}

export function createBlankProfile(input: CreateBlankProfileInput = {}): Profile {
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  return {
    schemaVersion: '1.0.0',
    id: input.id ?? createId<ProfileId>('profile'),
    revision: 0,
    label: input.label?.trim() || 'New playthrough',
    createdAt: at,
    updatedAt: at,
    personalDefinitions: {},
    rulesets: {},
    inventory: {},
    inventoryEvents: {},
    characters: {},
    progress: {},
    builds: {},
    buildRevisions: {},
    scenarios: {},
    goals: {},
    importReceipts: {},
    changes: [],
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
  readonly occupiesSlots?: PersonalDefinition['occupiesSlots']
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
  definition: Pick<PersonalDefinition, 'name' | 'aliases' | 'rawDescription' | 'fields' | 'occupiesSlots' | 'ppCost' | 'listedContributions' | 'requirements'>,
  profile: Profile,
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
    if (!key.trim()) throw new DomainError('INVALID_INPUT', 'Personal definition field name must not be empty')
    assertTextLength(key, 'Personal definition field name', MAX_ID_LENGTH)
  }
  for (const value of knowledgeValues(definition.occupiesSlots)) assertPositiveInteger(value, 'Occupied slot count')
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
      if (requirement.kind === 'selected') assertPersonalDefinitionRef(profile, requirement.ref, allowedDefinitionId)
      else if (!requirement.permission.trim()) throw new DomainError('INVALID_INPUT', 'Permission must not be empty')
    }
  }
}

export function createPersonalDefinition(profile: Profile, input: CreatePersonalDefinitionInput): Profile {
  assertExpectedRevision(profile, input.expectedRevision)
  const name = input.name.trim()
  const id = input.id ?? createId<PersonalDefinitionId>('definition')
  if (profile.personalDefinitions[id]) {
    throw new DomainError('DUPLICATE_ID', `Personal definition already exists: ${id}`)
  }
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  const definition: PersonalDefinition = {
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
    ...(input.occupiesSlots === undefined ? {} : { occupiesSlots: input.occupiesSlots }),
    ...(input.ppCost === undefined ? {} : { ppCost: input.ppCost }),
    ...(input.listedContributions === undefined ? {} : { listedContributions: input.listedContributions }),
    ...(input.requirements === undefined ? {} : { requirements: input.requirements }),
    ...(input.grants === undefined ? {} : { grants: input.grants }),
  }
  validateEditableDefinition(definition, profile, id)
  return updateProfile(
    profile,
    { personalDefinitions: { ...profile.personalDefinitions, [id]: definition } },
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
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export interface DefinitionOverrideResult {
  readonly profile: Profile
  readonly ref: PersonalRef
  readonly definition: PersonalDefinition
}

export function createDefinitionOverride(
  profile: Profile,
  catalogs: readonly CatalogSnapshot[],
  input: CreateDefinitionOverrideInput,
): DefinitionOverrideResult {
  assertExpectedRevision(profile, input.expectedRevision)
  const preferred = preferredDefinitionRef(profile, input.sourceRef)
  if (entityDefinitionKey(preferred) !== entityDefinitionKey(input.sourceRef)) {
    throw new DomainError('REVISION_CONFLICT', 'A newer personal definition revision already exists')
  }
  const source = resolveDefinition(profile, catalogs, input.sourceRef)
  if (!source) throw new DomainError('INVALID_INPUT', 'The definition to edit is unavailable')
  for (const category of knowledgeValues(input.category ?? undefined)) {
    if (!category.trim()) throw new DomainError('INVALID_INPUT', 'Personal definition category must be nonempty text')
    assertTextLength(category, 'Personal definition category', MAX_SHORT_TEXT_LENGTH)
  }
  const id = input.id ?? createId<PersonalDefinitionId>('definition')
  if (profile.personalDefinitions[id]) {
    throw new DomainError('DUPLICATE_ID', `Personal definition already exists: ${id}`)
  }
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  const fieldsWithoutCategory = Object.fromEntries(
    Object.entries(source.fields).filter(([key]) => key.trim().toLocaleLowerCase() !== 'category'),
  )
  const fields: Readonly<Record<string, Knowledge<JsonValue>>> = input.category === undefined
    ? source.fields
    : input.category === null
      ? fieldsWithoutCategory
      : { ...fieldsWithoutCategory, category: input.category }
  const previous = input.sourceRef.kind === 'personal'
    ? profile.personalDefinitions[input.sourceRef.definitionId]
    : undefined
  const definition: PersonalDefinition = {
    id,
    revision: previous ? previous.revision + 1 : 1,
    baseRef: definitionLineageRootRef(profile, input.sourceRef),
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
    ...(source.occupiesSlots === undefined ? {} : { occupiesSlots: source.occupiesSlots }),
    ...((input.ppCost === undefined ? source.ppCost : input.ppCost) === undefined || input.ppCost === null
      ? {}
      : { ppCost: input.ppCost === undefined ? source.ppCost : input.ppCost }),
    ...(source.listedContributions === undefined ? {} : { listedContributions: source.listedContributions }),
    ...(source.requirements === undefined ? {} : { requirements: source.requirements }),
    ...(source.grants === undefined ? {} : { grants: source.grants }),
  }
  validateEditableDefinition(definition, profile, id)
  const nextProfile = updateProfile(
    profile,
    { personalDefinitions: { ...profile.personalDefinitions, [id]: definition } },
    'personalDefinition.override',
    [`personalDefinitions.${id}`],
    at,
  )
  return { profile: nextProfile, ref: personalDefinitionRef(definition), definition }
}

export interface AddRulesetRevisionInput {
  readonly id?: RulesetRevisionId
  readonly rulesetId?: RulesetId
  readonly revision?: number
  readonly label: string
  readonly platform?: Knowledge<string>
  readonly gameVersion?: Knowledge<string>
  readonly mode?: Knowledge<string>
  readonly mods?: Knowledge<readonly string[]>
  readonly ppCostsNonNegative?: Knowledge<boolean>
  readonly slots?: readonly SlotDefinition[]
  readonly catalogLock?: RulesetRevision['catalogLock']
  readonly definitionOverrides?: readonly PersonalRef[]
  readonly activate?: boolean
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

const UNKNOWN_STRING: Knowledge<string> = { state: 'unknown' }
const UNKNOWN_STRINGS: Knowledge<readonly string[]> = { state: 'unknown' }

export function addRulesetRevision(profile: Profile, input: AddRulesetRevisionInput): Profile {
  assertExpectedRevision(profile, input.expectedRevision)
  const id = input.id ?? createId<RulesetRevisionId>('rulesetRevision')
  if (profile.rulesets[id]) {
    throw new DomainError('DUPLICATE_ID', `Ruleset revision already exists: ${id}`)
  }
  const revision = input.revision ?? 1
  assertNonnegativeInteger(revision, 'Ruleset revision')
  const slots = input.slots ?? []
  const slotIds = new Set<string>()
  for (const slot of slots) {
    if (!slot.id.trim()) throw new DomainError('INVALID_INPUT', 'Slot ID must not be empty')
    if (slotIds.has(slot.id)) throw new DomainError('INVALID_INPUT', `Duplicate slot ID: ${slot.id}`)
    if (!slot.label.trim()) throw new DomainError('INVALID_INPUT', 'Slot label must not be empty')
    if (!Number.isSafeInteger(slot.order)) throw new DomainError('INVALID_INPUT', 'Slot order must be a safe integer')
    slotIds.add(slot.id)
  }
  const overrideKeys = new Set<string>()
  for (const ref of input.definitionOverrides ?? []) {
    assertPersonalDefinitionRef(profile, ref)
    const key = logicalEntityKey(profile, ref)
    if (overrideKeys.has(key)) {
      throw new DomainError('DUPLICATE_REFERENCE', 'Ruleset definition overrides contain the same logical entity twice')
    }
    const root = definitionLineageRootRef(profile, ref)
    if (root.kind === 'catalog' && (input.catalogLock ?? {})[root.catalogId] !== root.catalogRevisionId) {
      throw new DomainError('INVALID_INPUT', 'A ruleset definition override falls outside the catalog lock')
    }
    overrideKeys.add(key)
  }
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  const ruleset: RulesetRevision = {
    id,
    rulesetId: input.rulesetId ?? createId<RulesetId>('ruleset'),
    revision,
    label: input.label.trim() || 'Untitled ruleset',
    platform: input.platform ?? UNKNOWN_STRING,
    gameVersion: input.gameVersion ?? UNKNOWN_STRING,
    mode: input.mode ?? UNKNOWN_STRING,
    mods: input.mods ?? UNKNOWN_STRINGS,
    ppCostsNonNegative: input.ppCostsNonNegative ?? { state: 'unknown' },
    slots: [...slots].sort((left, right) => left.order - right.order),
    catalogLock: input.catalogLock ?? {},
    ...(input.definitionOverrides === undefined ? {} : { definitionOverrides: input.definitionOverrides }),
    createdAt: at,
  }
  const activate = input.activate ?? profile.activeRulesetRevisionId === undefined
  return updateProfile(
    profile,
    {
      rulesets: { ...profile.rulesets, [id]: ruleset },
      ...(activate ? { activeRulesetRevisionId: id } : {}),
    },
    'ruleset.addRevision',
    [`rulesets.${id}`, ...(activate ? ['activeRulesetRevisionId'] : [])],
    at,
  )
}

export const createRulesetRevision = addRulesetRevision

export interface UpdateRulesetRevisionInput {
  readonly sourceRevisionId: RulesetRevisionId
  readonly id?: RulesetRevisionId
  readonly label?: string
  readonly platform?: Knowledge<string>
  readonly gameVersion?: Knowledge<string>
  readonly mode?: Knowledge<string>
  readonly mods?: Knowledge<readonly string[]>
  readonly ppCostsNonNegative?: Knowledge<boolean>
  readonly slots?: readonly SlotDefinition[]
  readonly catalogLock?: RulesetRevision['catalogLock']
  readonly definitionOverrides?: readonly PersonalRef[]
  readonly activate?: boolean
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export function updateRulesetRevision(profile: Profile, input: UpdateRulesetRevisionInput): Profile {
  const source = profile.rulesets[input.sourceRevisionId]
  if (!source) {
    throw new DomainError('MISSING_RULESET', `Ruleset revision does not exist: ${input.sourceRevisionId}`)
  }
  return addRulesetRevision(profile, {
    id: input.id,
    rulesetId: source.rulesetId,
    revision: source.revision + 1,
    label: input.label ?? source.label,
    platform: input.platform ?? source.platform,
    gameVersion: input.gameVersion ?? source.gameVersion,
    mode: input.mode ?? source.mode,
    mods: input.mods ?? source.mods,
    ppCostsNonNegative: input.ppCostsNonNegative ?? source.ppCostsNonNegative,
    slots: input.slots ?? source.slots,
    catalogLock: input.catalogLock ?? source.catalogLock,
    definitionOverrides: input.definitionOverrides ?? source.definitionOverrides,
    activate: input.activate ?? true,
    now: input.now,
    expectedRevision: input.expectedRevision,
  })
}

export interface CoalesceDefinitionOverridesInput {
  readonly sourceRulesetRevisionId: RulesetRevisionId
  readonly definitionRefs: readonly PersonalRef[]
  readonly id?: RulesetRevisionId
  readonly label?: string
  readonly activate?: boolean
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export function coalesceDefinitionOverrides(
  profile: Profile,
  input: CoalesceDefinitionOverridesInput,
): Profile {
  const source = profile.rulesets[input.sourceRulesetRevisionId]
  if (!source) {
    throw new DomainError('MISSING_RULESET', `Ruleset revision does not exist: ${input.sourceRulesetRevisionId}`)
  }
  const selectedByLogicalKey = new Map<string, PersonalRef>()
  const catalogLock = { ...source.catalogLock }
  for (const ref of input.definitionRefs) {
    assertPersonalDefinitionRef(profile, ref)
    if (entityDefinitionKey(preferredDefinitionRef(profile, ref)) !== entityDefinitionKey(ref)) {
      throw new DomainError('REVISION_CONFLICT', 'Only preferred personal definition revisions can enter a new ruleset layer')
    }
    const key = logicalEntityKey(profile, ref)
    if (selectedByLogicalKey.has(key)) {
      throw new DomainError('DUPLICATE_REFERENCE', 'Definition override selection contains one logical entity twice')
    }
    selectedByLogicalKey.set(key, ref)
    const root = definitionLineageRootRef(profile, ref)
    if (root.kind === 'catalog') {
      const lockedRevision = catalogLock[root.catalogId]
      if (lockedRevision !== undefined && lockedRevision !== root.catalogRevisionId) {
        throw new DomainError('INVALID_INPUT', 'A definition override conflicts with the source ruleset catalog lock')
      }
      catalogLock[root.catalogId] = root.catalogRevisionId
    }
  }
  const definitionOverrides = [
    ...(source.definitionOverrides ?? []).filter((ref) => !selectedByLogicalKey.has(logicalEntityKey(profile, ref))),
    ...selectedByLogicalKey.values(),
  ]
  return updateRulesetRevision(profile, {
    sourceRevisionId: input.sourceRulesetRevisionId,
    id: input.id,
    label: input.label,
    catalogLock,
    definitionOverrides,
    activate: input.activate ?? false,
    now: input.now,
    expectedRevision: input.expectedRevision,
  })
}

export interface ActivateRulesetInput {
  readonly rulesetRevisionId: RulesetRevisionId
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export function activateRuleset(profile: Profile, input: ActivateRulesetInput): Profile {
  assertExpectedRevision(profile, input.expectedRevision)
  if (!profile.rulesets[input.rulesetRevisionId]) {
    throw new DomainError('MISSING_RULESET', `Ruleset revision does not exist: ${input.rulesetRevisionId}`)
  }
  if (profile.activeRulesetRevisionId === input.rulesetRevisionId) {
    return profile
  }
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  return updateProfile(
    profile,
    { activeRulesetRevisionId: input.rulesetRevisionId },
    'ruleset.activate',
    ['activeRulesetRevisionId'],
    at,
  )
}
