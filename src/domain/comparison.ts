import { entityDefinitionKey } from './core'
import type {
  BuildComparison,
  BuildRevision,
  BuildSelection,
  DescriptiveDifference,
  EntityRef,
  JsonValue,
} from './types'

function refValue(ref: EntityRef | null): JsonValue {
  return ref === null ? null : entityDefinitionKey(ref)
}

function selectionValue(selection: BuildSelection | null | undefined): JsonValue {
  if (!selection) {
    return null
  }
  return {
    ref: entityDefinitionKey(selection.ref),
    allocationId: selection.allocationId ?? null,
  }
}

function pushDifference(
  differences: DescriptiveDifference[],
  path: string,
  label: string,
  left: JsonValue | undefined,
  right: JsonValue | undefined,
): void {
  if (JSON.stringify(left) === JSON.stringify(right)) {
    return
  }
  differences.push({ path, label, left, right })
}

function lockValue(lock: Readonly<Record<string, string>>): JsonValue {
  return Object.fromEntries(Object.entries(lock).sort(([left], [right]) => left.localeCompare(right)))
}

export function compareBuildRevisions(left: BuildRevision, right: BuildRevision): BuildComparison {
  const differences: DescriptiveDifference[] = []
  pushDifference(
    differences,
    'gameSetupRevisionId',
    'Game Setup revision',
    left.gameSetupRevisionId,
    right.gameSetupRevisionId,
  )
  pushDifference(
    differences,
    'catalogLock',
    'Catalog lock',
    lockValue(left.catalogLock),
    lockValue(right.catalogLock),
  )
  pushDifference(
    differences,
    'content.primaryClass',
    'Primary class',
    refValue(left.content.primaryClass),
    refValue(right.content.primaryClass),
  )
  pushDifference(
    differences,
    'content.secondaryClass',
    'Secondary class',
    refValue(left.content.secondaryClass),
    refValue(right.content.secondaryClass),
  )

  const slotIds = new Set([
    ...Object.keys(left.content.equipment),
    ...Object.keys(right.content.equipment),
  ])
  for (const slotId of [...slotIds].sort()) {
    const leftSelection = left.content.equipment[slotId]
    const rightSelection = right.content.equipment[slotId]
    pushDifference(
      differences,
      `content.equipment.${slotId}`,
      `Equipment: ${slotId}`,
      selectionValue(leftSelection),
      selectionValue(rightSelection),
    )
  }
  for (let index = 0; index < Math.max(left.content.passives.length, right.content.passives.length); index += 1) {
    pushDifference(
      differences,
      `content.passives.${index}`,
      `Equipped passive ${index + 1}`,
      selectionValue(left.content.passives[index]),
      selectionValue(right.content.passives[index]),
    )
  }

  pushDifference(
    differences,
    'content.rotationNotes',
    'Rotation notes',
    left.content.rotationNotes,
    right.content.rotationNotes,
  )
  pushDifference(
    differences,
    'content.contextAssumptions',
    'Context assumptions',
    left.content.contextAssumptions,
    right.content.contextAssumptions,
  )

  const calculationValue = (revision: BuildRevision): JsonValue | undefined => revision.content.calculation ? {
    level: revision.content.calculation.level,
    growth: revision.content.calculation.growth.map(row => ({ classRef: refValue(row.classRef), levels: row.levels })),
    bonuses: revision.content.calculation.bonuses,
    statuses: revision.content.calculation.statuses.map(refValue),
    ability: refValue(revision.content.calculation.ability ?? null),
    targetEvasion: revision.content.calculation.targetEvasion ?? null,
  } : undefined
  pushDifference(differences, 'content.calculation', 'Calculation inputs', calculationValue(left), calculationValue(right))

  return {
    leftRevisionId: left.id,
    rightRevisionId: right.id,
    differences,
  }
}
