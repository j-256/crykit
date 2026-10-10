import { analyzeBuildEquipment, unavailableClassCommand, type DefinitionResolver, type MechanicsIssue } from './build-mechanics'
import { entityDefinitionKey } from './core'
import { passivePointCost } from './mechanics-facts'
import { passivePosition } from './passive-loadout'
import { DEFAULT_PP_LIMIT } from './local-data'
import type { BuildRevisionContent, EntityRef, Knowledge, GameSetupRevision, SlotDefinition } from './types'

export type BuildValidityStatus = 'valid' | 'invalid' | 'undetermined'

export interface BuildPpValidity {
  readonly knownSubtotal: number
  readonly unresolvedCosts: number
  readonly limit: Knowledge<number>
  readonly status: BuildValidityStatus
}

export interface BuildValidityReport {
  readonly status: BuildValidityStatus
  readonly pp: BuildPpValidity
  readonly issues: readonly MechanicsIssue[]
}

export function effectivePpLimit(gameSetup?: Pick<GameSetupRevision, 'ppLimit'>): Knowledge<number> {
  return gameSetup?.ppLimit ?? { state: 'known', value: DEFAULT_PP_LIMIT }
}

export function validateBuildContent(
  content: BuildRevisionContent,
  gameSetup: Pick<GameSetupRevision, 'catalogLock' | 'ppCostsNonNegative' | 'ppLimit' | 'modSourceReceipts'> | undefined,
  slots: readonly SlotDefinition[],
  resolve: DefinitionResolver,
  identity: (ref: EntityRef) => string = entityDefinitionKey,
): BuildValidityReport {
  const issues: MechanicsIssue[] = []
  const add = (code: string, status: MechanicsIssue['status'], message: string, slotId?: string) => issues.push({ code, status, message, ...(slotId ? { slotId } : {}) })
  const slotMap = new Map(slots.map(slot => [slot.id as string, slot]))
  const checkCatalogLock = (ref: EntityRef, label: string, slotId?: string) => {
    if (ref.kind !== 'catalog' || !gameSetup) return
    const lockedRevision = gameSetup.catalogLock[ref.catalogId]
    if (lockedRevision !== ref.catalogRevisionId) add('CATALOG_REFERENCE_MISMATCH', 'invalid', `${label} is outside the build's pinned catalog revision`, slotId)
  }

  for (const [label, ref] of [['Primary class', content.primaryClass], ['Sub-command', content.secondaryClass]] as const) {
    if (!ref) continue
    const field = label === 'Primary class' ? 'primary-class' : 'secondary-class'
    checkCatalogLock(ref, label, field)
    const definition = resolve(ref)
    if (!definition) {
      const display = content.referenceNames?.find(entry => entityDefinitionKey(entry.ref) === entityDefinitionKey(ref))
      const source = display?.projectId && gameSetup?.modSourceReceipts?.find(receipt => receipt.catalogId === display.projectId)
      // Saved names explain a missing pinned definition without resolving a base-game namesake
      const savedSource = source ? ` ${source.title}` : display?.projectId ? ' mod' : ''
      add('CLASS_DEFINITION_UNAVAILABLE', 'undetermined', display ? `${label}: ${display.name}'s saved${savedSource} definition is unavailable` : `${label} definition is unavailable`, field)
    } else if (definition.kind !== 'class') add('CLASS_KIND', 'invalid', `${label} must use a class definition`, field)
    else if (unavailableClassCommand(ref, resolve)) add('CLASS_COMMAND_DEFINITION', 'undetermined', `${label}: ${definition.name}'s command or an included ability definition is unavailable`, field)
  }

  let knownSubtotal = 0
  let unresolvedCosts = 0
  let selectedPassives = 0
  for (const [slotId, selection] of Object.entries(content.equipment)) {
    if (!selection) continue
    const slot = slotMap.get(slotId)
    if (!slot) {
      add('SLOT_REFERENCE_MISSING', 'invalid', 'A selection uses a slot missing from this Game Setup', slotId)
      continue
    }
    checkCatalogLock(selection.ref, slot.label, slotId)
    const definition = resolve(selection.ref)
    if (!definition) continue
    if (slot.acceptedEntityKinds?.state === 'known' && !slot.acceptedEntityKinds.value.includes(definition.kind)) {
      add('ENTITY_KIND_NOT_ACCEPTED', 'invalid', `${slot.label} does not accept ${definition.kind} definitions`, slotId)
    } else if (!slot.acceptedEntityKinds || slot.acceptedEntityKinds.state === 'unknown' || slot.acceptedEntityKinds.state === 'conflicting') {
      add('SLOT_ACCEPTANCE_UNKNOWN', 'undetermined', `${slot.label}: CryKit doesn't know what can go in this slot`, slotId)
    }
  }

  for (const [index, selection] of content.passives.entries()) {
    const slot = passivePosition(index)
    checkCatalogLock(selection.ref, slot.label, slot.id)
    const definition = resolve(selection.ref)
    selectedPassives += 1
    if (definition && !['passive', 'innate'].includes(definition.kind)) add('ENTITY_KIND_NOT_ACCEPTED', 'invalid', `${slot.label} does not accept ${definition.kind} definitions`, slot.id)
    const cost = definition ? passivePointCost(definition) : undefined
    if (cost?.state === 'known') knownSubtotal += cost.value
    else if (cost?.state === 'notApplicable') add('PASSIVE_NOT_EQUIPPABLE', 'invalid', `${definition?.name ?? 'This innate'} is not available as an equippable passive`, slot.id)
    else unresolvedCosts += 1
  }

  // Mechanics owns unavailable passive/equipment findings so each position warns once
  // Missing passive definitions still contribute unresolved costs to the PP accounting above
  issues.push(...analyzeBuildEquipment(content, slots, resolve, identity))
  const limit = effectivePpLimit(gameSetup)
  let ppStatus: BuildValidityStatus = 'valid'
  if (selectedPassives > 0 && limit.state !== 'notApplicable') {
    if (limit.state !== 'known') {
      ppStatus = 'undetermined'
      add('PP_LIMIT_UNKNOWN', 'undetermined', 'The PP limit is unknown for this Game Setup')
    } else if (unresolvedCosts === 0) {
      if (knownSubtotal > limit.value) {
        ppStatus = 'invalid'
        add('PP_LIMIT_EXCEEDED', 'invalid', `Selected passives cost ${knownSubtotal} PP, above the ${limit.value} PP limit`)
      }
    } else if (knownSubtotal > limit.value && gameSetup?.ppCostsNonNegative.state === 'known' && gameSetup.ppCostsNonNegative.value) {
      // Only the nonnegative-cost constraint proves unknown costs cannot bring an excessive subtotal back under budget
      ppStatus = 'invalid'
      add('PP_LIMIT_EXCEEDED', 'invalid', `Known passive costs already exceed the ${limit.value} PP limit`)
    } else {
      ppStatus = 'undetermined'
      add('PP_COST_UNKNOWN', 'undetermined', `${unresolvedCosts} selected passive ${unresolvedCosts === 1 ? 'cost is' : 'costs are'} unresolved`)
    }
  }

  const uniqueIssues = [...new Map(issues.map(value => [JSON.stringify([value.code, value.status, value.message, value.slotId]), value])).values()]
  const status = uniqueIssues.some(issue => issue.status === 'invalid')
    ? 'invalid'
    : uniqueIssues.some(issue => issue.status === 'undetermined')
      ? 'undetermined'
      : 'valid'
  return { status, pp: { knownSubtotal, unresolvedCosts, limit, status: ppStatus }, issues: uniqueIssues }
}
