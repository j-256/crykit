import { MAX_ID_LENGTH } from '../domain'
import type { BuildId, CharacterId, EntityRef, InventoryPositionId, PersonalDefinitionId, ProgressRecordId, ScenarioId } from '../domain/types'
import type { Destination } from './Shell'

const TARGET_QUERY_KEY = 'target'
const MAX_TARGET_LENGTH = 4_096
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/

export type UniversalSearchTarget =
  | { readonly kind: 'definition'; readonly ref: EntityRef }
  | { readonly kind: 'inventory'; readonly positionId: InventoryPositionId }
  | { readonly kind: 'character'; readonly characterId: CharacterId }
  | { readonly kind: 'build'; readonly buildId: BuildId }
  | { readonly kind: 'scenario'; readonly scenarioId: ScenarioId }
  | { readonly kind: 'progress'; readonly recordId: ProgressRecordId }

export function destinationForSearchTarget(target: UniversalSearchTarget): Destination {
  if (target.kind === 'definition') return 'reference'
  if (target.kind === 'inventory') return 'inventory'
  if (target.kind === 'character') return 'characters'
  if (target.kind === 'progress') return 'progress'
  return 'builds'
}

function boundedId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_ID_LENGTH && !CONTROL_CHARACTER.test(value) ? value : undefined
}

function entityRef(value: unknown): EntityRef | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.kind === 'personal') {
    const definitionId = boundedId(record.definitionId)
    return definitionId ? { kind: 'personal', definitionId: definitionId as PersonalDefinitionId } : undefined
  }
  if (record.kind !== 'catalog') return undefined
  const catalogId = boundedId(record.catalogId)
  const catalogRevisionId = boundedId(record.catalogRevisionId)
  const entityId = boundedId(record.entityId)
  return catalogId && catalogRevisionId && entityId ? { kind: 'catalog', catalogId, catalogRevisionId, entityId } as EntityRef : undefined
}

function targetFromRecord(value: unknown): UniversalSearchTarget | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.kind === 'definition') {
    const ref = entityRef(record.ref)
    return ref ? { kind: 'definition', ref } : undefined
  }
  if (record.kind === 'inventory') {
    const positionId = boundedId(record.positionId)
    return positionId ? { kind: 'inventory', positionId: positionId as InventoryPositionId } : undefined
  }
  if (record.kind === 'character') {
    const characterId = boundedId(record.characterId)
    return characterId ? { kind: 'character', characterId: characterId as CharacterId } : undefined
  }
  if (record.kind === 'build') {
    const buildId = boundedId(record.buildId)
    return buildId ? { kind: 'build', buildId: buildId as BuildId } : undefined
  }
  if (record.kind === 'scenario') {
    const scenarioId = boundedId(record.scenarioId)
    return scenarioId ? { kind: 'scenario', scenarioId: scenarioId as ScenarioId } : undefined
  }
  if (record.kind === 'progress') {
    const recordId = boundedId(record.recordId)
    return recordId ? { kind: 'progress', recordId: recordId as ProgressRecordId } : undefined
  }
  return undefined
}

export function parseUniversalSearchTarget(hash: string): UniversalSearchTarget | undefined {
  const [, query = ''] = hash.replace(/^#/, '').split('?', 2)
  const encoded = new URLSearchParams(query).get(TARGET_QUERY_KEY)
  if (!encoded || encoded.length > MAX_TARGET_LENGTH) return undefined
  try {
    return targetFromRecord(JSON.parse(encoded))
  } catch {
    return undefined
  }
}

export function formatSearchDestination(destination: Destination, target?: UniversalSearchTarget): string {
  if (!target) return `#/${destination}`
  if (destinationForSearchTarget(target) !== destination) throw new Error('Search target does not belong to the requested destination')
  if (!targetFromRecord(target)) throw new Error('Search target contains an invalid identifier')
  const serialized = JSON.stringify(target)
  if (serialized.length > MAX_TARGET_LENGTH) throw new Error('Search target is too large')
  const params = new URLSearchParams({ [TARGET_QUERY_KEY]: serialized })
  return `#/${destination}?${params.toString()}`
}
