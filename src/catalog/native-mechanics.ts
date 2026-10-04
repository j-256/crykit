import factsJson from './native-mechanics.json' with { type: 'json' }
import codeEvidence from './game-code-evidence.json' with { type: 'json' }
import { DEFAULT_CATALOG, BUNDLED_SOURCE_ENTITY_IDS } from './bundled'
import { NATIVE_GAME_DATA } from './native-game'
import { sameValue } from '../domain/definition-values'
import type { CatalogEntity, JsonValue, Knowledge, PersonalDefinition } from '../domain/types'

interface NativeMechanicReceipt {
  readonly sourceId: string
  readonly entityId: string
  readonly description: string
  readonly expectedDescription: string
  readonly expectedFields: Readonly<Record<string, Knowledge<JsonValue>>>
  readonly replacedFields: readonly string[]
  readonly evidence: readonly string[]
  readonly calculationLinks?: readonly { readonly label: string; readonly href: string }[]
}

export interface NativeMechanic {
  readonly description: string
  readonly scope: string
  readonly replacedFields: readonly string[]
  readonly originalFields: Readonly<Record<string, Knowledge<JsonValue>>>
  readonly originalDescription: string
  readonly evidence: readonly string[]
  readonly calculationLinks?: readonly { readonly label: string; readonly href: string }[]
}

const facts = factsJson as unknown as { readonly source: typeof codeEvidence.source; readonly files: Readonly<Record<string, string>>; readonly entries: readonly NativeMechanicReceipt[] }
const reviewedFiles: Readonly<Record<string, string>> = codeEvidence.files
const sourceMatches = facts.source.executableSha256 === NATIVE_GAME_DATA.source.executable.sha256 && facts.source.executableSha256 === codeEvidence.source.executableSha256 && facts.source.systemDataSha256 === codeEvidence.source.systemDataSha256 && facts.source.gameVersion === NATIVE_GAME_DATA.source.gameVersion && facts.source.platform === NATIVE_GAME_DATA.source.platform && Object.entries(facts.files).every(([path, digest]) => reviewedFiles[path] === digest)
const receipts = new Map(facts.entries.map(receipt => [receipt.entityId, receipt]))

export function nativeMechanic(entity: CatalogEntity | PersonalDefinition): NativeMechanic | undefined {
  if (!sourceMatches || 'revision' in entity) return undefined
  const receipt = receipts.get(entity.id)
  const baseline = DEFAULT_CATALOG.entities[entity.id]
  if (!receipt || !baseline || BUNDLED_SOURCE_ENTITY_IDS.get(receipt.sourceId) !== entity.id || entity.kind !== baseline.kind || entity.name !== baseline.name || entity.rawDescription !== receipt.expectedDescription || !sameValue(entity.fields, receipt.expectedFields) || !sameValue(entity.fields, baseline.fields) || !sameValue(entity.sources, baseline.sources)) return undefined
  return { description: receipt.description, scope: `Windows ${facts.source.gameVersion}`, replacedFields: receipt.replacedFields, originalFields: Object.fromEntries(receipt.replacedFields.flatMap(field => entity.fields[field] ? [[field, entity.fields[field]!]] : [])), originalDescription: receipt.expectedDescription, evidence: receipt.evidence, ...(receipt.calculationLinks ? { calculationLinks: receipt.calculationLinks } : {}) }
}
