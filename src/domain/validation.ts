import { sameBuildBehavior } from './build-behavior'
import { DomainError, entityDefinitionKey, requirePlaythrough } from './core'
import { definitionLineageRootRef, logicalEntityKey } from './definitions'
import { effectiveScenarioAssignments } from './scenarios'
import { analyzeBuildEquipment, innateEffects } from './build-mechanics'
import { effectivePpLimit } from './build-validity'
import { jsonRecord } from './crystal-edit'
import { nativeScopeUncertainty, NATIVE_SCOPE_UNVERIFIED } from './native-game'
import { classEquipmentTypes, definitionWithMechanics, equipmentFacts, equipmentPermission, equipmentRole, permissionEffects } from './mechanics-facts'
import { passivePosition, type PassivePosition } from './passive-loadout'
import type {
  BuildRevision,
  CatalogEntity,
  CatalogEntityKind,
  CatalogIndex,
  Character,
  CharacterId,
  EntityRef,
  InventoryPosition,
  Knowledge,
  PersonalDefinition,
  LocalData,
  GameSetupRevision,
  ScenarioId,
  SlotDefinition,
  SlotId,
  SourceRef,
  TeamScenario,
  ValidationDimension,
  ValidationDimensionResult,
  ValidationIssue,
  ValidationReport,
  ValidationStatus,
} from './types'

type ResolvedDefinition = CatalogEntity | PersonalDefinition

interface DefinitionView {
  readonly kind: CatalogEntityKind
  readonly name: string
  readonly ppCost?: Knowledge<number>
  readonly slotKinds?: Knowledge<readonly string[]>
  readonly requirements?: Knowledge<readonly import('./types').EntityRequirement[]>
  readonly grants?: Knowledge<readonly string[]>
  readonly sources: readonly SourceRef[]
}

interface Accumulator {
  readonly touched: Set<ValidationDimension>
  readonly issues: ValidationIssue[]
}

function definitionView(original: ResolvedDefinition, slots: readonly SlotDefinition[]): DefinitionView {
  const definition = definitionWithMechanics(original, slots)
  return {
    kind: definition.kind,
    name: definition.name,
    requirements: definition.requirements,
    grants: definition.grants,
    sources: definition.sources,
    ...(definition.ppCost === undefined ? {} : { ppCost: definition.ppCost }),
    ...(definition.slotKinds === undefined ? {} : { slotKinds: definition.slotKinds }),
  }
}

function resolveDefinition(
  localData: LocalData,
  catalogs: CatalogIndex,
  ref: EntityRef,
): ResolvedDefinition | undefined {
  if (ref.kind === 'personal') {
    return localData.personalDefinitions[ref.definitionId]
  }
  const catalog = catalogs.snapshots[JSON.stringify([ref.catalogId, ref.catalogRevisionId])]
  const identities = jsonRecord(catalog?.legacy) && jsonRecord(catalog.legacy.crystalEditIdentities) ? catalog.legacy.crystalEditIdentities : undefined
  const target = identities?.[ref.entityId]
  return catalogs.entitiesByRef[entityDefinitionKey(typeof target === 'string' ? { ...ref, entityId: target as typeof ref.entityId } : ref)]
}

function issue(accumulator: Accumulator, value: ValidationIssue): void {
  accumulator.touched.add(value.dimension)
  accumulator.issues.push(value)
}

function touch(accumulator: Accumulator, dimension: ValidationDimension): void {
  accumulator.touched.add(dimension)
}

function catalogLocksEqual(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  return [...keys].every((key) => left[key] === right[key])
}

function refMatchesCatalogLock(
  localData: LocalData,
  ref: EntityRef,
  lock: Readonly<Record<string, string>>,
): boolean {
  const rootRef = definitionLineageRootRef(localData, ref)
  return rootRef.kind === 'personal' || lock[rootRef.catalogId] === rootRef.catalogRevisionId
}

function validateCatalogRefLock(
  localData: LocalData,
  ref: EntityRef,
  revision: BuildRevision,
  characterId: CharacterId,
  accumulator: Accumulator,
): void {
  const rootRef = definitionLineageRootRef(localData, ref)
  if (rootRef.kind === 'personal') {
    return
  }
  const lockedRevision = revision.catalogLock[rootRef.catalogId]
  if (lockedRevision === undefined) {
    issue(accumulator, {
      code: 'CATALOG_REFERENCE_NOT_LOCKED',
      dimension: 'gameSetupCertainty',
      status: 'invalid',
      message: 'A catalog selection is not covered by the build catalog lock',
      characterId,
      buildRevisionId: revision.id,
      ref,
    })
  } else if (lockedRevision !== rootRef.catalogRevisionId) {
    issue(accumulator, {
      code: 'CATALOG_REFERENCE_REVISION_MISMATCH',
      dimension: 'gameSetupCertainty',
      status: 'invalid',
      message: 'A catalog selection uses a different revision than the build catalog lock',
      characterId,
      buildRevisionId: revision.id,
      ref,
      inputs: { lockedRevision, selectedRevision: rootRef.catalogRevisionId },
    })
  }
}

function knowledgeUncertain(knowledge: { readonly state: Knowledge<never>['state'] }): boolean {
  return knowledge.state === 'unknown' || knowledge.state === 'conflicting'
}

function effectiveInventoryQuantity(
  position: InventoryPosition,
  includeProtected: boolean,
): { readonly lower: number; readonly upper?: number } {
  if (position.possession === 'notOwned') {
    return { lower: 0, upper: 0 }
  }
  if (position.quantity.kind === 'unknown') {
    const observedLower = position.possession === 'owned' ? 1 : 0
    return { lower: Math.max(0, observedLower - (includeProtected ? 0 : position.protectedQuantity)) }
  }
  const protectedQuantity = includeProtected ? 0 : position.protectedQuantity
  if (position.quantity.kind === 'exact') {
    const available = Math.max(0, position.quantity.value - protectedQuantity)
    return { lower: available, upper: available }
  }
  return { lower: Math.max(0, position.quantity.value - protectedQuantity) }
}

function findInventory(localData: LocalData, ref: EntityRef): InventoryPosition | undefined {
  const key = logicalEntityKey(localData, ref)
  return Object.values(requirePlaythrough(localData).inventory).find((position) => logicalEntityKey(localData, position.ref) === key)
}

interface SelectedEntry {
  readonly characterId: CharacterId
  readonly buildRevision: BuildRevision
  readonly slot: SlotDefinition | PassivePosition
  readonly slotId: SlotId
  readonly ref: EntityRef
  readonly allocationKey: string
  readonly definition?: DefinitionView
}

function collectSelections(
  localData: LocalData,
  catalogs: CatalogIndex,
  scenario: TeamScenario,
  gameSetup: GameSetupRevision,
  accumulator: Accumulator,
): SelectedEntry[] {
  const slots = new Map(gameSetup.slots.map((slot) => [slot.id as string, slot]))
  const selected: SelectedEntry[] = []
  for (const [characterIdValue, revisionId] of Object.entries(effectiveScenarioAssignments(scenario))) {
    const characterId = characterIdValue as CharacterId
    const character = requirePlaythrough(localData).characters[characterId]
    if (!character) {
      issue(accumulator, {
        code: 'CHARACTER_REFERENCE_MISSING',
        dimension: 'structure',
        status: 'invalid',
        message: 'Scenario assignment references a missing character',
        characterId,
      })
      continue
    }
    const revision = localData.buildRevisions[revisionId]
    if (!revision) {
      issue(accumulator, {
        code: 'BUILD_REVISION_REFERENCE_MISSING',
        dimension: 'structure',
        status: 'invalid',
        message: 'Scenario assignment references a missing build revision',
        characterId,
      })
      continue
    }
    const build = localData.builds[revision.buildId]
    if (!build) {
      issue(accumulator, {
        code: 'BUILD_REFERENCE_MISSING',
        dimension: 'structure',
        status: 'invalid',
        message: 'Build revision references a missing build',
        characterId,
        buildRevisionId: revision.id,
      })
    }
    if (!sameBuildBehavior(localData.gameSetups[revision.gameSetupRevisionId], localData.gameSetups[scenario.gameSetupRevisionId])) {
      issue(accumulator, {
        code: 'GAME_SETUP_REVISION_MISMATCH',
        dimension: 'gameSetupCertainty',
        status: 'invalid',
        message: 'Build behavior differs from team behavior',
        characterId,
        buildRevisionId: revision.id,
      })
    }
    if (!catalogLocksEqual(revision.catalogLock, scenario.catalogLock)) {
      issue(accumulator, {
        code: 'CATALOG_LOCK_MISMATCH',
        dimension: 'gameSetupCertainty',
        status: 'invalid',
        message: 'Build and scenario pin different catalog revisions',
        characterId,
        buildRevisionId: revision.id,
      })
    }
    for (const [slotIdValue, selection] of Object.entries(revision.content.equipment)) {
      if (!selection) {
        continue
      }
      validateCatalogRefLock(localData, selection.ref, revision, characterId, accumulator)
      const slot = slots.get(slotIdValue)
      if (!slot) {
        issue(accumulator, {
          code: 'SLOT_REFERENCE_MISSING',
          dimension: 'structure',
          status: 'invalid',
          message: 'Build selection references a slot outside its Game Setup',
          characterId,
          buildRevisionId: revision.id,
          slotId: slotIdValue as SlotId,
          ref: selection.ref,
        })
        continue
      }
      const definition = resolveDefinition(localData, catalogs, selection.ref)
      if (!definition) {
        issue(accumulator, {
          code: 'DEFINITION_UNAVAILABLE',
          dimension: 'equipment',
          status: 'undetermined',
          message: 'Selected definition is unavailable for this pinned catalog revision',
          characterId,
          buildRevisionId: revision.id,
          slotId: slot.id,
          ref: selection.ref,
        })
      }
      selected.push({
        characterId,
        buildRevision: revision,
        slot,
        slotId: slot.id,
        ref: selection.ref,
        allocationKey: selection.allocationId ?? slotIdValue,
        ...(definition === undefined ? {} : { definition: definitionView(definition, gameSetup.slots) }),
      })
    }
    for (const [index, selection] of revision.content.passives.entries()) {
      validateCatalogRefLock(localData, selection.ref, revision, characterId, accumulator)
      const slot = passivePosition(index)
      const definition = resolveDefinition(localData, catalogs, selection.ref)
      if (!definition) {
        issue(accumulator, {
          code: 'DEFINITION_UNAVAILABLE',
          dimension: 'passives',
          status: 'undetermined',
          message: 'Selected definition is unavailable for this pinned catalog revision',
          characterId,
          buildRevisionId: revision.id,
          slotId: slot.id,
          ref: selection.ref,
        })
      }
      selected.push({
        characterId,
        buildRevision: revision,
        slot,
        slotId: slot.id,
        ref: selection.ref,
        allocationKey: `passive:${index}`,
        ...(definition === undefined ? {} : { definition: definitionView(definition, gameSetup.slots) }),
      })
    }
    validateClassReadiness(localData, catalogs, character, revision, accumulator)
  }
  return selected
}

function validateClassReadiness(
  localData: LocalData,
  catalogs: CatalogIndex,
  character: Character,
  revision: BuildRevision,
  accumulator: Accumulator,
): void {
  for (const [label, ref] of [
    ['Primary class', revision.content.primaryClass],
    ['Secondary class', revision.content.secondaryClass],
  ] as const) {
    if (!ref) {
      continue
    }
    touch(accumulator, 'characterReadiness')
    validateCatalogRefLock(localData, ref, revision, character.id, accumulator)
    const progress = character.classProgress[logicalEntityKey(localData, ref)]
    // Party-wide unlock and mastery do not establish this member's readiness to use the class
    const definition = resolveDefinition(localData, catalogs, ref)
    if (!definition) {
      issue(accumulator, {
        code: 'CLASS_DEFINITION_UNAVAILABLE',
        dimension: 'characterReadiness',
        status: 'undetermined',
        message: `${label} definition is unavailable`,
        characterId: character.id,
        buildRevisionId: revision.id,
        ref,
      })
    } else if (definition.kind !== 'class') {
      issue(accumulator, {
        code: 'CLASS_ENTITY_KIND_INVALID',
        dimension: 'characterReadiness',
        status: 'invalid',
        message: `${label} references a definition that is not a class`,
        characterId: character.id,
        buildRevisionId: revision.id,
        ref,
      })
    }
    if (!progress || knowledgeUncertain(progress.unlocked)) {
      issue(accumulator, {
        code: 'CLASS_UNLOCK_UNKNOWN',
        dimension: 'characterReadiness',
        status: 'undetermined',
        message: `${label} unlock state is unknown for this character`,
        characterId: character.id,
        buildRevisionId: revision.id,
        ref,
      })
    } else if (progress.unlocked.state === 'known' && !progress.unlocked.value) {
      issue(accumulator, {
        code: 'CLASS_NOT_UNLOCKED',
        dimension: 'characterReadiness',
        status: 'invalid',
        message: `${label} is not unlocked for this character`,
        characterId: character.id,
        buildRevisionId: revision.id,
        ref,
      })
    }
  }
}

function validateSlotCompatibility(localData: LocalData, selected: readonly SelectedEntry[], accumulator: Accumulator): void {
  for (const entry of selected) {
    const dimension = entry.slot.kind === 'passive' ? 'passives' : 'equipment'
    touch(accumulator, dimension)
    if (!entry.definition) {
      continue
    }
    const accepted = entry.slot.acceptedEntityKinds
    if (accepted?.state === 'known' && !accepted.value.includes(entry.definition.kind)) {
      issue(accumulator, {
        code: 'ENTITY_KIND_NOT_ACCEPTED',
        dimension,
        status: 'invalid',
        message: 'Selected definition kind is not accepted by this slot',
        characterId: entry.characterId,
        buildRevisionId: entry.buildRevision.id,
        slotId: entry.slotId,
        ref: entry.ref,
      })
    } else if (!accepted || knowledgeUncertain(accepted)) {
      issue(accumulator, {
        code: 'SLOT_ACCEPTANCE_UNKNOWN',
        dimension,
        status: 'undetermined',
        message: 'Slot acceptance is unresolved',
        characterId: entry.characterId,
        buildRevisionId: entry.buildRevision.id,
        slotId: entry.slotId,
        ref: entry.ref,
      })
    }
    if (entry.slot.kind === 'passive') {
      continue
    }
    if (entry.definition.slotKinds?.state === 'known') {
      if (!entry.definition.slotKinds.value.includes(entry.slotId)) {
        issue(accumulator, {
          code: 'ENTITY_SLOT_NOT_ALLOWED',
          dimension,
          status: 'invalid',
          message: 'Selected definition does not allow this slot',
          characterId: entry.characterId,
          buildRevisionId: entry.buildRevision.id,
          slotId: entry.slotId,
          ref: entry.ref,
          sources: entry.definition.sources,
        })
      }
    } else if (!entry.definition.slotKinds || knowledgeUncertain(entry.definition.slotKinds)) {
      issue(accumulator, {
        code: 'ENTITY_SLOT_UNKNOWN',
        dimension,
        status: 'undetermined',
        message: 'Selected definition slot compatibility is unresolved',
        characterId: entry.characterId,
        buildRevisionId: entry.buildRevision.id,
        slotId: entry.slotId,
        ref: entry.ref,
        sources: entry.definition.sources,
      })
    }
  }
  validateAllocationGroups(localData, selected, accumulator)
}

function validateAllocationGroups(localData: LocalData, selected: readonly SelectedEntry[], accumulator: Accumulator): void {
  const groups = new Map<string, SelectedEntry[]>()
  for (const entry of selected.filter(value => value.slot.kind === 'equipment')) {
    const key = `${entry.characterId}\u0000${entry.buildRevision.id}\u0000${entry.allocationKey}`
    const group = groups.get(key) ?? []
    group.push(entry)
    groups.set(key, group)
  }
  for (const group of groups.values()) {
    const first = group[0]
    if (!first) {
      continue
    }
    const dimension = 'equipment'
    const refKeys = new Set(group.map((entry) => logicalEntityKey(localData, entry.ref)))
    if (refKeys.size > 1) {
      issue(accumulator, {
        code: 'ALLOCATION_GROUP_MIXED_REFERENCES',
        dimension,
        status: 'invalid',
        message: 'One allocation group cannot represent different definitions',
        characterId: first.characterId,
        buildRevisionId: first.buildRevision.id,
        slotId: first.slotId,
      })
    }
  }
}

function validateInventory(
  localData: LocalData,
  scenario: TeamScenario,
  selected: readonly SelectedEntry[],
  accumulator: Accumulator,
): void {
  const demands = new Map<string, { ref: EntityRef; assignments: Set<string> }>()
  for (const entry of selected.filter((value) => value.slot.kind === 'equipment')) {
    const key = logicalEntityKey(localData, entry.ref)
    const demand = demands.get(key) ?? { ref: entry.ref, assignments: new Set<string>() }
    // Shared slots count one copy within a member, but the same allocation label on another member still needs stock
    demand.assignments.add(`${entry.characterId}\u0000${entry.buildRevision.id}\u0000${entry.allocationKey}`)
    demands.set(key, demand)
  }
  if (demands.size === 0) {
    return
  }
  touch(accumulator, 'inventory')
  for (const { ref, assignments } of demands.values()) {
    const demand = assignments.size
    const position = findInventory(localData, ref)
    if (!position || position.possession === 'unknown') {
      issue(accumulator, {
        code: 'STOCK_UNKNOWN',
        dimension: 'inventory',
        status: 'undetermined',
        message: 'Current stock is unknown',
        ref,
        inputs: { demand },
        suggestion: 'Record a current inventory observation',
      })
      continue
    }
    const available = effectiveInventoryQuantity(position, scenario.inventoryPolicy.includeProtected)
    if (available.lower >= demand) {
      continue
    }
    // A lower bound below demand is not a shortage unless a known upper bound also excludes enough copies
    if (available.upper === undefined) {
      issue(accumulator, {
        code: 'STOCK_UPPER_BOUND_UNKNOWN',
        dimension: 'inventory',
        status: 'undetermined',
        message: 'Confirmed stock lower bound does not cover demand, but more copies may exist',
        ref,
        inputs: { demand, confirmedAvailable: available.lower },
        suggestion: 'Confirm the current count',
      })
      continue
    }
    const includingProtected = effectiveInventoryQuantity(position, true)
    const protectedConflict = !scenario.inventoryPolicy.includeProtected && includingProtected.lower >= demand
    issue(accumulator, {
      code: protectedConflict ? 'PROTECTED_STOCK_CONFLICT' : 'STOCK_SHORTAGE',
      dimension: 'inventory',
      status: 'invalid',
      message: protectedConflict
        ? 'Protected copies would be required by this scenario'
        : 'Confirmed stock cannot cover simultaneous assignments',
      ref,
      inputs: { demand, available: available.upper },
      suggestion: protectedConflict ? 'Allow protected copies explicitly or choose another item' : 'Change an assignment or correct stock',
    })
  }
}

function classPermissionBase(
  localData: LocalData,
  catalogs: CatalogIndex,
  scenario: TeamScenario,
  gameSetup: GameSetupRevision,
  characterId: CharacterId,
  revision: BuildRevision,
): { readonly permissions: Set<string>; readonly unresolved: boolean } {
  const permissions = new Set<string>()
  let unresolved = false
  if (
    !sameBuildBehavior(localData.gameSetups[revision.gameSetupRevisionId], localData.gameSetups[scenario.gameSetupRevisionId]) ||
    !catalogLocksEqual(revision.catalogLock, scenario.catalogLock) ||
    !catalogLocksEqual(scenario.catalogLock, gameSetup.catalogLock)
  ) {
    return { permissions, unresolved }
  }
  const character = requirePlaythrough(localData).characters[characterId]
  for (const ref of [revision.content.primaryClass]) {
    if (!ref || !refMatchesCatalogLock(localData, ref, revision.catalogLock)) {
      continue
    }
    const original = resolveDefinition(localData, catalogs, ref)
    if (!original) {
      unresolved = true
      continue
    }
    const definition = definitionWithMechanics(original, gameSetup.slots)
    if (definition.kind !== 'class') {
      continue
    }
    const unlocked = character?.classProgress[logicalEntityKey(localData, ref)]?.unlocked
    if (!unlocked || knowledgeUncertain(unlocked)) {
      unresolved = true
      continue
    }
    if (unlocked.state !== 'known' || !unlocked.value) {
      continue
    }
    if (!definition.requirements || knowledgeUncertain(definition.requirements)) {
      unresolved = true
      continue
    }
    if (definition.requirements.state === 'known' && definition.requirements.value.length > 0) {
      unresolved = true
      continue
    }
    if (!definition.grants || knowledgeUncertain(definition.grants)) {
      unresolved = true
      continue
    }
    if (definition.grants.state === 'known') {
      for (const permission of definition.grants.value) {
        permissions.add(permission)
      }
      for (const innate of innateEffects(revision.content, ref => resolveDefinition(localData, catalogs, ref))) {
        for (const type of permissionEffects(innate.text).equipment) permissions.add(equipmentPermission(type))
      }
    }
  }
  return { permissions, unresolved }
}

function validateLearning(
  localData: LocalData,
  selected: readonly SelectedEntry[],
  accumulator: Accumulator,
): void {
  for (const entry of selected.filter((value) => value.slot.kind === 'passive')) {
    touch(accumulator, 'characterReadiness')
    const character = requirePlaythrough(localData).characters[entry.characterId]
    const learned = character?.learnedNodes[logicalEntityKey(localData, entry.ref)]?.learned
    if (!learned || knowledgeUncertain(learned)) {
      issue(accumulator, {
        code: 'LEARNING_UNKNOWN',
        dimension: 'characterReadiness',
        status: 'undetermined',
        message: 'Learning state is unknown for this character',
        characterId: entry.characterId,
        buildRevisionId: entry.buildRevision.id,
        slotId: entry.slotId,
        ref: entry.ref,
      })
    } else if (learned.state === 'known' && !learned.value) {
      issue(accumulator, {
        code: 'NOT_LEARNED',
        dimension: 'characterReadiness',
        status: 'invalid',
        message: 'Selected passive is not learned by this character',
        characterId: entry.characterId,
        buildRevisionId: entry.buildRevision.id,
        slotId: entry.slotId,
        ref: entry.ref,
      })
    }
  }
}

function validatePp(
  gameSetup: GameSetupRevision,
  selected: readonly SelectedEntry[],
  accumulator: Accumulator,
): void {
  const byCharacter = new Map<CharacterId, SelectedEntry[]>()
  for (const entry of selected.filter((value) => value.slot.kind === 'passive')) {
    const entries = byCharacter.get(entry.characterId) ?? []
    entries.push(entry)
    byCharacter.set(entry.characterId, entries)
  }
  for (const [characterId, entries] of byCharacter) {
    touch(accumulator, 'passives')
    const limit = effectivePpLimit(gameSetup)
    let knownSubtotal = 0
    let unknownCost = false
    for (const entry of entries) {
      const cost = entry.definition?.ppCost
      if (cost?.state === 'known') {
        knownSubtotal += cost.value
      } else {
        unknownCost = true
      }
    }
    if (knowledgeUncertain(limit)) {
      issue(accumulator, {
        code: 'PP_LIMIT_UNKNOWN',
        dimension: 'passives',
        status: 'undetermined',
        message: 'The passive PP limit is unresolved for this Game Setup',
        characterId,
        inputs: { knownSubtotal },
      })
      continue
    }
    if (limit.state !== 'known') {
      continue
    }
    if (!unknownCost) {
      if (knownSubtotal > limit.value) {
        issue(accumulator, {
          code: 'PP_LIMIT_EXCEEDED',
          dimension: 'passives',
          status: 'invalid',
          message: 'Selected passive costs exceed the Game Setup PP limit',
          characterId,
          inputs: { limit: limit.value, knownSubtotal },
        })
      }
      continue
    }
    if (
      knownSubtotal > limit.value &&
      gameSetup.ppCostsNonNegative.state === 'known' &&
      gameSetup.ppCostsNonNegative.value
    ) {
      issue(accumulator, {
        code: 'PP_LIMIT_EXCEEDED',
        dimension: 'passives',
        status: 'invalid',
        message: 'Known nonnegative passive costs already exceed the Game Setup PP limit',
        characterId,
        inputs: { limit: limit.value, knownSubtotal },
      })
    } else {
      issue(accumulator, {
        code: 'PP_COST_UNKNOWN',
        dimension: 'passives',
        status: 'undetermined',
        message: 'At least one selected PP cost or its sign constraint is unresolved',
        characterId,
        inputs: { limit: limit.value, knownSubtotal },
      })
    }
  }
}

type Eligibility = 'valid' | 'invalid' | 'unknown'

function baseEligibility(
  localData: LocalData,
  gameSetup: GameSetupRevision,
  scenario: TeamScenario,
  entries: readonly SelectedEntry[],
  entry: SelectedEntry,
): Eligibility {
  if (!entry.definition) {
    return 'unknown'
  }
  const build = localData.builds[entry.buildRevision.buildId]
  if (
    !build ||
    !sameBuildBehavior(localData.gameSetups[entry.buildRevision.gameSetupRevisionId], gameSetup) ||
    !catalogLocksEqual(entry.buildRevision.catalogLock, scenario.catalogLock) ||
    !catalogLocksEqual(scenario.catalogLock, gameSetup.catalogLock) ||
    !refMatchesCatalogLock(localData, entry.ref, entry.buildRevision.catalogLock)
  ) {
    return 'invalid'
  }
  const accepted = entry.slot.acceptedEntityKinds
  if (!accepted || knowledgeUncertain(accepted)) {
    return 'unknown'
  }
  if (accepted.state === 'known' && !accepted.value.includes(entry.definition.kind)) {
    return 'invalid'
  }
  if (entry.slot.kind === 'passive') {
    const learned = requirePlaythrough(localData).characters[entry.characterId]?.learnedNodes[logicalEntityKey(localData, entry.ref)]?.learned
    if (!learned || knowledgeUncertain(learned)) {
      return 'unknown'
    }
    if (learned.state === 'known' && !learned.value) {
      return 'invalid'
    }
    return passivePpEligibility(gameSetup, entries, entry.characterId)
  }
  const slotKinds = entry.definition.slotKinds
  if (!slotKinds || knowledgeUncertain(slotKinds)) {
    return 'unknown'
  }
  if (slotKinds.state === 'known' && !slotKinds.value.includes(entry.slotId)) {
    return 'invalid'
  }
  const allocationGroup = entries.filter(
    (candidate) =>
      candidate.characterId === entry.characterId &&
      candidate.buildRevision.id === entry.buildRevision.id &&
      candidate.allocationKey === entry.allocationKey,
  )
  if (allocationGroup.some((candidate) => logicalEntityKey(localData, candidate.ref) !== logicalEntityKey(localData, entry.ref))) {
    return 'invalid'
  }
  return 'valid'
}

function passivePpEligibility(
  gameSetup: GameSetupRevision,
  entries: readonly SelectedEntry[],
  characterId: CharacterId,
): Eligibility {
  const limit = effectivePpLimit(gameSetup)
  if (knowledgeUncertain(limit)) return 'unknown'
  if (limit.state !== 'known') return 'valid'
  let knownSubtotal = 0
  let hasUnknownCost = false
  for (const entry of entries.filter((candidate) => candidate.characterId === characterId && candidate.slot.kind === 'passive')) {
    const cost = entry.definition?.ppCost
    if (cost?.state === 'known') {
      knownSubtotal += cost.value
    } else {
      hasUnknownCost = true
    }
  }
  if (!hasUnknownCost) {
    return knownSubtotal > limit.value ? 'invalid' : 'valid'
  }
  if (
    knownSubtotal > limit.value &&
    gameSetup.ppCostsNonNegative.state === 'known' &&
    gameSetup.ppCostsNonNegative.value
  ) {
    return 'invalid'
  }
  return 'unknown'
}

function validatePermissions(
  localData: LocalData,
  catalogs: CatalogIndex,
  gameSetup: GameSetupRevision,
  scenario: TeamScenario,
  selected: readonly SelectedEntry[],
  accumulator: Accumulator,
): void {
  const entries = selected.filter((entry): entry is SelectedEntry & { readonly definition: DefinitionView } => Boolean(entry.definition))
  const base = new Map(entries.map((entry) => [entry, baseEligibility(localData, gameSetup, scenario, entries, entry)]))
  const byCharacter = new Map<CharacterId, typeof entries>()
  for (const entry of entries) {
    const characterEntries = byCharacter.get(entry.characterId) ?? []
    characterEntries.push(entry)
    byCharacter.set(entry.characterId, characterEntries)
    if (!entry.definition.requirements || knowledgeUncertain(entry.definition.requirements)) {
      const dimension = entry.slot.kind === 'passive' ? 'passives' : 'equipment'
      issue(accumulator, {
        code: 'PERMISSION_REQUIREMENTS_UNKNOWN',
        dimension,
        status: 'undetermined',
        message: 'Permission requirements are unresolved for this selection',
        characterId: entry.characterId,
        buildRevisionId: entry.buildRevision.id,
        slotId: entry.slotId,
        ref: entry.ref,
      })
    }
  }

  for (const [characterId, characterEntries] of byCharacter) {
    const eligible = new Set<SelectedEntry>()
    const revision = characterEntries[0]?.buildRevision
    const classBase = revision
      ? classPermissionBase(localData, catalogs, scenario, gameSetup, characterId, revision)
      : { permissions: new Set<string>(), unresolved: false }
    const permissions = classBase.permissions
    let changed = true
    while (changed) {
      changed = false
      for (const entry of characterEntries) {
        const requirements = entry.definition.requirements
        if (
          eligible.has(entry) ||
          base.get(entry) !== 'valid' ||
          !requirements ||
          knowledgeUncertain(requirements)
        ) {
          continue
        }
        const values = requirements.state === 'known' ? requirements.value : []
        const satisfied = values.every((requirement) => {
          if (requirement.kind === 'permission') {
            return permissions.has(requirement.permission)
          }
          return characterEntries.some(
            (candidate) =>
              logicalEntityKey(localData, candidate.ref) === logicalEntityKey(localData, requirement.ref) && eligible.has(candidate),
          )
        })
        if (!satisfied) {
          continue
        }
        eligible.add(entry)
        if (entry.definition.grants?.state === 'known') {
          for (const permission of entry.definition.grants.value) {
            permissions.add(permission)
          }
        }
        changed = true
      }
    }

    for (const entry of characterEntries) {
      const requirements = entry.definition.requirements
      if (
        eligible.has(entry) ||
        base.get(entry) !== 'valid' ||
        !requirements ||
        knowledgeUncertain(requirements) ||
        requirements.state !== 'known'
      ) {
        continue
      }
      const dimension = entry.slot.kind === 'passive' ? 'passives' : 'equipment'
      for (const requirement of requirements.value) {
        if (requirement.kind === 'selected') {
          const candidates = characterEntries.filter(
            (candidate) => logicalEntityKey(localData, candidate.ref) === logicalEntityKey(localData, requirement.ref),
          )
          if (candidates.some((candidate) => eligible.has(candidate))) {
            continue
          }
          const missing = candidates.length === 0
          const invalid = candidates.length > 0 && candidates.every((candidate) => base.get(candidate) === 'invalid')
          const unresolved = candidates.some((candidate) => base.get(candidate) === 'unknown')
          issue(accumulator, {
            code: missing
              ? 'REQUIRED_SELECTION_MISSING'
              : invalid
                ? 'REQUIRED_SELECTION_INVALID'
                : unresolved
                  ? 'REQUIRED_SELECTION_UNRESOLVED'
                  : 'REQUIRED_SELECTION_CYCLE',
            dimension,
            status: missing || invalid ? 'invalid' : 'undetermined',
            message: missing
              ? 'A required selection is missing'
              : invalid
                ? 'A required selection is not independently valid'
                : unresolved
                  ? 'A required selection has unresolved legality'
                  : 'Selected definitions depend on each other without an independent base',
            characterId,
            buildRevisionId: entry.buildRevision.id,
            slotId: entry.slotId,
            ref: entry.ref,
          })
          continue
        }

        if (permissions.has(requirement.permission)) {
          continue
        }
        const knownCandidates = characterEntries.filter(
          (candidate) =>
            candidate.definition.grants?.state === 'known' &&
            candidate.definition.grants.value.includes(requirement.permission),
        )
        const unknownCandidates = characterEntries.filter(
          (candidate) =>
            base.get(candidate) !== 'invalid' &&
            (!candidate.definition.grants || knowledgeUncertain(candidate.definition.grants)),
        )
        const candidateInvalid = !classBase.unresolved &&
          knownCandidates.length > 0 &&
          unknownCandidates.length === 0 &&
          knownCandidates.every((candidate) => base.get(candidate) === 'invalid')
        const definitelyMissing = knownCandidates.length === 0 && unknownCandidates.length === 0
        const unresolved = classBase.unresolved || unknownCandidates.length > 0 ||
          knownCandidates.some((candidate) => base.get(candidate) === 'unknown')
        issue(accumulator, {
          code: definitelyMissing && !classBase.unresolved
            ? 'REQUIRED_PERMISSION_MISSING'
            : candidateInvalid
              ? 'REQUIRED_PERMISSION_SOURCE_INVALID'
              : unresolved
                ? 'PERMISSION_GRANT_UNKNOWN'
                : 'UNSUPPORTED_PERMISSION_CYCLE',
          dimension,
          status: (definitelyMissing && !classBase.unresolved) || candidateInvalid ? 'invalid' : 'undetermined',
          message: definitelyMissing && !classBase.unresolved
            ? 'No selected definition grants a required permission'
            : candidateInvalid
              ? 'A required permission is granted only by an invalid selection'
              : unresolved
                ? 'A required permission may depend on an unresolved grant'
                : 'A permission dependency cannot be established without a circular grant',
          characterId,
          buildRevisionId: entry.buildRevision.id,
          slotId: entry.slotId,
          ref: entry.ref,
          sources: entry.definition.sources,
        })
      }
    }
  }
}

function validateCatalogLocks(
  gameSetup: GameSetupRevision,
  scenario: TeamScenario,
  catalogs: CatalogIndex,
  accumulator: Accumulator,
): void {
  touch(accumulator, 'gameSetupCertainty')
  if (!catalogLocksEqual(scenario.catalogLock, gameSetup.catalogLock)) {
    issue(accumulator, {
      code: 'SCENARIO_CATALOG_LOCK_MISMATCH',
      dimension: 'gameSetupCertainty',
      status: 'invalid',
      message: 'Scenario and Game Setup pin different catalog revisions',
    })
  }
  for (const [catalogId, revisionId] of Object.entries(scenario.catalogLock)) {
    const snapshot = Object.values(catalogs.snapshots).find(
      (candidate) => candidate.id === catalogId && candidate.revisionId === revisionId,
    )
    if (!snapshot) {
      issue(accumulator, {
        code: 'CATALOG_SNAPSHOT_UNAVAILABLE',
        dimension: 'gameSetupCertainty',
        status: 'undetermined',
        message: 'A catalog snapshot pinned by the scenario is unavailable',
        inputs: { catalogId, revisionId },
      })
      continue
    }
    if (snapshot.applicability.state === 'notApplicable') {
      issue(accumulator, {
        code: 'CATALOG_NOT_APPLICABLE',
        dimension: 'gameSetupCertainty',
        status: 'invalid',
        message: 'A pinned catalog snapshot is marked not applicable',
        inputs: { catalogId, revisionId },
      })
    } else if (knowledgeUncertain(snapshot.applicability)) {
      issue(accumulator, {
        code: 'CATALOG_APPLICABILITY_UNKNOWN',
        dimension: 'gameSetupCertainty',
        status: 'undetermined',
        message: 'Applicability is unresolved for a pinned catalog snapshot',
        inputs: { catalogId, revisionId },
      })
    } else {
      const scopeUncertainty = nativeScopeUncertainty(snapshot, gameSetup)
      if (scopeUncertainty) issue(accumulator, {
        code: NATIVE_SCOPE_UNVERIFIED,
        dimension: 'gameSetupCertainty',
        status: 'undetermined',
        message: scopeUncertainty,
        inputs: { catalogId, revisionId },
      })
    }
  }
}

function validateGameSetupCertainty(gameSetup: GameSetupRevision, accumulator: Accumulator): void {
  touch(accumulator, 'gameSetupCertainty')
  for (const [field, value] of [
    ['platform', gameSetup.platform],
    ['game version', gameSetup.gameVersion],
    ['mode', gameSetup.mode],
    ['mods', gameSetup.mods],
  ] as const) {
    if (knowledgeUncertain(value)) {
      issue(accumulator, {
        code: 'GAME_SETUP_FIELD_UNKNOWN',
        dimension: 'gameSetupCertainty',
        status: 'undetermined',
        message: `Game Setup ${field} is unresolved`,
        inputs: { field },
      })
    }
  }
  for (const slot of gameSetup.slots) {
    if (slot.provenance === 'suggested') {
      issue(accumulator, {
        code: 'SUGGESTED_SLOT_DEFINITION',
        dimension: 'gameSetupCertainty',
        status: 'undetermined',
        message: 'A suggested slot definition is not verified game behavior',
        slotId: slot.id,
      })
    }
  }
}

function dimensionStatus(
  dimension: ValidationDimension,
  accumulator: Accumulator,
): ValidationDimensionResult {
  const issues = accumulator.issues.filter((value) => value.dimension === dimension)
  let status: ValidationStatus = accumulator.touched.has(dimension) ? 'valid' : 'notApplicable'
  if (issues.some((value) => value.status === 'invalid')) {
    status = 'invalid'
  } else if (issues.some((value) => value.status === 'undetermined')) {
    status = 'undetermined'
  }
  return { status, issues }
}

const DIMENSIONS: readonly ValidationDimension[] = [
  'structure',
  'equipment',
  'passives',
  'characterReadiness',
  'inventory',
  'gameSetupCertainty',
  'calculationReadiness',
]

export function validateScenario(
  localData: LocalData,
  scenarioId: ScenarioId,
  catalogs: CatalogIndex = { snapshots: {}, entitiesByRef: {} },
): ValidationReport {
  const scenario = requirePlaythrough(localData).scenarios[scenarioId]
  const playthrough = requirePlaythrough(localData)
  if (!scenario) {
    throw new DomainError('MISSING_SCENARIO', `Scenario does not exist: ${scenarioId}`)
  }
  const gameSetup = localData.gameSetups[scenario.gameSetupRevisionId]
  if (!gameSetup) {
    throw new DomainError('MISSING_GAME_SETUP', `Game Setup revision does not exist: ${scenario.gameSetupRevisionId}`)
  }
  const accumulator: Accumulator = { touched: new Set(['structure']), issues: [] }
  if (
    scenario.baseline.kind === 'recordedParty' &&
    (!Number.isSafeInteger(scenario.baseline.playthroughRevision) ||
      scenario.baseline.playthroughRevision < 0 ||
      scenario.baseline.playthroughRevision > playthrough.revision)
  ) {
    issue(accumulator, {
      code: 'SCENARIO_BASELINE_REVISION_INVALID',
      dimension: 'structure',
      status: 'invalid',
      message: 'Scenario baseline references an invalid playthrough revision',
      inputs: { baselineRevision: scenario.baseline.playthroughRevision, playthroughRevision: playthrough.revision },
    })
  }
  const selected = collectSelections(localData, catalogs, scenario, gameSetup, accumulator)
  for (const [characterId, revisionId] of Object.entries(effectiveScenarioAssignments(scenario))) {
    const revision = localData.buildRevisions[revisionId]
    if (!revision) continue
    const resolve = (ref: EntityRef) => resolveDefinition(localData, catalogs, ref)
    const primary = revision.content.primaryClass ? resolve(revision.content.primaryClass) : undefined
    const modeled = classEquipmentTypes(primary) || gameSetup.slots.some(slot => {
      const selection = revision.content.equipment[slot.id]
      const definition = selection ? resolve(selection.ref) : undefined
      return equipmentRole(slot) && definition && equipmentFacts(definition).type
    })
    if (!modeled) continue
    for (const finding of analyzeBuildEquipment(revision.content, gameSetup.slots, resolve, ref => logicalEntityKey(localData, ref))) issue(accumulator, {
      ...finding, code: `MECHANICS_${finding.code}`, dimension: finding.code.includes('PASSIVE') ? 'passives' : 'equipment', characterId: characterId as CharacterId, buildRevisionId: revision.id, slotId: finding.slotId as SlotId | undefined,
    })
  }
  validateSlotCompatibility(localData, selected, accumulator)
  if (scenario.inventoryPolicy.enforceStock) {
    validateInventory(localData, scenario, selected, accumulator)
  }
  validateLearning(localData, selected, accumulator)
  validatePp(gameSetup, selected, accumulator)
  validatePermissions(localData, catalogs, gameSetup, scenario, selected, accumulator)
  validateCatalogLocks(gameSetup, scenario, catalogs, accumulator)
  validateGameSetupCertainty(gameSetup, accumulator)

  const dimensions = Object.fromEntries(
    DIMENSIONS.map((dimension) => [dimension, dimensionStatus(dimension, accumulator)]),
  ) as Record<ValidationDimension, ValidationDimensionResult>

  return {
    scenarioId,
    playthroughRevision: playthrough.revision,
    gameSetupRevisionId: scenario.gameSetupRevisionId,
    dimensions,
    issues: accumulator.issues,
  }
}
