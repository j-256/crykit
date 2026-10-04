import evidence from './native-description-evidence.json' with { type: 'json' }
import { DEFAULT_CATALOG } from './bundled'
import { NATIVE_GAME_DATA } from './native-game'
import { nativeMechanic } from './native-mechanics'
import { projectSourceSemantics } from './source-semantics'
import { describeNativeRecord, nativeDescriptionRecord, type NativeDescription } from '../domain/native-description'
import { sameValue } from '../domain/definition-values'
import { nativeDisplayDescription, nativeIdentity, nativeSourceRecord, type NativeGameSnapshot } from '../domain/native-game'
import type { CatalogEntity, PersonalDefinition } from '../domain/types'

type Definition = CatalogEntity | PersonalDefinition
export const NATIVE_DESCRIPTION_EVIDENCE = evidence
const descriptions = new WeakMap<object, NativeDescription>()

export function nativeDescriptionSourceMatches(snapshot: NativeGameSnapshot): boolean {
  return snapshot.source.platform === evidence.source.platform && snapshot.source.gameVersion === evidence.source.gameVersion && snapshot.source.executable.sha256 === evidence.source.executableSha256 && snapshot.source.files.find(file => file.path === 'Database/system.dat')?.sha256 === evidence.source.systemDataSha256 && snapshot.contentDigest === evidence.source.contentDigest
}

export function nativeDescription(entity: Definition): NativeDescription | undefined {
  const baseline = DEFAULT_CATALOG.entities[entity.id]
  const identity = nativeIdentity(entity)
  const record = nativeSourceRecord(entity)
  const version = entity.fields['Game version']
  const expected = identity && nativeDescriptionRecord(NATIVE_GAME_DATA, identity.database, identity.databaseId, identity.mode)
  if ('revision' in entity || !nativeDescriptionSourceMatches(NATIVE_GAME_DATA) || !baseline || !identity || !record || !expected || version?.state !== 'known' || version.value !== NATIVE_GAME_DATA.source.gameVersion || !sameValue(record, expected) || entity !== baseline && !sameValue(entity, baseline) && !sameValue(entity, projectSourceSemantics(baseline))) return undefined
  const cached = descriptions.get(entity)
  if (cached) return cached
  const result = describeNativeRecord(NATIVE_GAME_DATA, identity.database, record, identity.mode)
  descriptions.set(entity, result)
  return result
}

export function referenceDescription(entity: Definition): string | undefined {
  const mechanic = nativeMechanic(entity)
  if (mechanic) return mechanic.description
  const native = nativeDescription(entity)
  return native?.lines.length ? native.lines.join('\n') : nativeDisplayDescription(entity)
}
