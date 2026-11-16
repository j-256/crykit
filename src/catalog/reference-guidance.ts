import data from './reference-guidance.json' with { type: 'json' }
import { CURRENT_CATALOG } from './bundled'
import { NATIVE_GAME_DATA } from './native-game'
import { nativeDescription } from './native-description'
import { sameValue } from '../domain/definition-values'
import { nativeIdentity, type NativeIdentity } from '../domain/native-game'
import { sameCatalogLegacy } from '../interchange/native'
import type { CatalogEntity, CatalogSnapshot, PersonalDefinition, SourceRef } from '../domain/types'

export type ReferenceGuidanceKind = 'description' | 'directions' | 'master-directions'
export interface ReferenceGuidanceRecord {
  readonly entityId: string
  readonly nativeIdentity: NativeIdentity
  readonly kind: ReferenceGuidanceKind
  readonly text: string
  readonly sources: readonly SourceRef[]
}

export const REFERENCE_GUIDANCE_RIGHTS = Object.freeze(data.rights)
const records: readonly ReferenceGuidanceRecord[] = data.records as readonly ReferenceGuidanceRecord[]
const byEntity = new Map<string, readonly ReferenceGuidanceRecord[]>()
for (const record of records) byEntity.set(record.entityId, [...byEntity.get(record.entityId) ?? [], record])
const sourceMatches = data.schemaVersion === 1 && data.nativeSource.platform === NATIVE_GAME_DATA.source.platform && data.nativeSource.gameVersion === NATIVE_GAME_DATA.source.gameVersion && data.nativeSource.executableSha256 === NATIVE_GAME_DATA.source.executable.sha256 && data.nativeSource.contentDigest === NATIVE_GAME_DATA.contentDigest
const normalizedText = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase()

export function referenceGuidance(catalog: CatalogSnapshot, entity: CatalogEntity | PersonalDefinition, kind?: ReferenceGuidanceKind): readonly ReferenceGuidanceRecord[] {
  const candidates = byEntity.get(entity.id)
  const baseline = CURRENT_CATALOG.entities[entity.id]
  // A numeric ID or retained native field cannot attach community text to an edited or imported definition
  // Compare mutable clones each time so a frozen shell cannot retain admission after a nested edit
  if (!candidates || 'revision' in entity || !sourceMatches || catalog.id !== CURRENT_CATALOG.id || catalog.revisionId !== CURRENT_CATALOG.revisionId || catalog.checksum !== CURRENT_CATALOG.checksum || !sameCatalogLegacy(catalog, CURRENT_CATALOG) || !baseline || !sameValue(catalog.entities[entity.id], baseline) || !sameValue(entity, baseline)) return []
  const identity = nativeIdentity(entity)
  const native = nativeDescription(entity)
  const nativeText = normalizedText(native?.lines.join('\n') ?? '')
  return candidates.filter(record => (!kind || record.kind === kind) && sameValue(record.nativeIdentity, identity) && (record.kind !== 'description' || !native?.complete && !nativeText.includes(normalizedText(record.text))))
}
