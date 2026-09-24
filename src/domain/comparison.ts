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
    'rulesetRevisionId',
    'Ruleset revision',
    left.rulesetRevisionId,
    right.rulesetRevisionId,
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
    ...Object.keys(left.content.selections),
    ...Object.keys(right.content.selections),
  ])
  for (const slotId of [...slotIds].sort()) {
    const leftSelection = left.content.selections[slotId]
    const rightSelection = right.content.selections[slotId]
    pushDifference(
      differences,
      `content.selections.${slotId}`,
      `Selection: ${slotId}`,
      selectionValue(leftSelection),
      selectionValue(rightSelection),
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

  return {
    leftRevisionId: left.id,
    rightRevisionId: right.id,
    differences,
  }
}
