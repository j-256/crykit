import {
  asTimestamp,
  assertExpectedRevision,
  assertFiniteNumber,
  assertNonnegativeInteger,
  assertPersonalDefinitionRef,
  assertPositiveInteger,
  createId,
  DomainError,
  nowTimestamp,
  updateProfile,
} from './core'
import type {
  CatalogEntityKind,
  JsonValue,
  Knowledge,
  PersonalDefinition,
  PersonalDefinitionId,
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

export function createPersonalDefinition(profile: Profile, input: CreatePersonalDefinitionInput): Profile {
  assertExpectedRevision(profile, input.expectedRevision)
  const name = input.name.trim()
  if (!name) {
    throw new DomainError('INVALID_INPUT', 'Personal definition name must not be empty')
  }
  const id = input.id ?? createId<PersonalDefinitionId>('definition')
  if (profile.personalDefinitions[id]) {
    throw new DomainError('DUPLICATE_ID', `Personal definition already exists: ${id}`)
  }
  const validateNumber = (knowledge: Knowledge<number> | undefined, label: string, positive = false) => {
    if (!knowledge) return
    const values = knowledge.state === 'known'
      ? [knowledge.value]
      : knowledge.state === 'conflicting'
        ? knowledge.claims.map((claim) => claim.value)
        : []
    for (const value of values) {
      if (positive) assertPositiveInteger(value, label)
      else assertFiniteNumber(value, label)
    }
  }
  validateNumber(input.occupiesSlots, 'Occupied slot count', true)
  validateNumber(input.ppCost, 'PP cost')
  for (const [key, contribution] of Object.entries(input.listedContributions ?? {})) {
    if (!key.trim()) throw new DomainError('INVALID_INPUT', 'Contribution key must not be empty')
    const values = contribution.state === 'known'
      ? [contribution.value]
      : contribution.state === 'conflicting'
        ? contribution.claims.map((claim) => claim.value)
        : []
    for (const value of values) {
      assertFiniteNumber(value.value, `Contribution ${key}`)
      if (!value.unit.trim()) throw new DomainError('INVALID_INPUT', `Contribution ${key} unit must not be empty`)
    }
  }
  const requirements = input.requirements?.state === 'known'
    ? [input.requirements.value]
    : input.requirements?.state === 'conflicting'
      ? input.requirements.claims.map((claim) => claim.value)
      : []
  for (const values of requirements) {
    for (const requirement of values) {
      if (requirement.kind === 'selected') assertPersonalDefinitionRef(profile, requirement.ref, id)
      else if (!requirement.permission.trim()) throw new DomainError('INVALID_INPUT', 'Permission must not be empty')
    }
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
  return updateProfile(
    profile,
    { personalDefinitions: { ...profile.personalDefinitions, [id]: definition } },
    'personalDefinition.create',
    [`personalDefinitions.${id}`],
    at,
  )
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
    activate: input.activate ?? true,
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
