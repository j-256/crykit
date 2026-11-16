import facts from './native-mechanics.json' with { type: 'json' }
import { NATIVE_GAME_DATA } from './native-game'
import { sameValue } from '../domain/definition-values'
import { nativeGameplayScopeLabel } from '../domain/native-game'
import type { CatalogEntity, EntityId, PersonalDefinition, SourceRef } from '../domain/types'

export interface NativeMechanic {
  readonly description: string
  readonly scope: string
  readonly evidence: readonly string[]
  readonly calculationLinks?: readonly { readonly label: string; readonly href: string }[]
}

// A matching modifier name is insufficient: these descriptions belong to the fingerprinted build
const sourceMatches = facts.source.executableSha256 === NATIVE_GAME_DATA.source.executable.sha256 && facts.source.systemDataSha256 === NATIVE_GAME_DATA.source.files.find(file => file.path === 'Database/system.dat')?.sha256 && facts.source.gameVersion === NATIVE_GAME_DATA.source.gameVersion && facts.source.platform === NATIVE_GAME_DATA.source.platform
const scope = nativeGameplayScopeLabel(facts.source.platform, facts.source.gameVersion)
const definitions = Object.fromEntries(facts.entries.map(entry => {
  const source: SourceRef = { sourceId: `native-game:windows:${facts.source.gameVersion}`, locator: entry.evidence.join('; '), snapshot: `executable SHA-256 ${facts.source.executableSha256}`, applicability: scope }
  const entity: CatalogEntity = { id: entry.id as EntityId, kind: 'other', name: entry.name, aliases: [], rawDescription: entry.description, fields: { Description: { state: 'known', value: entry.description, sources: [source] }, Category: { state: 'known', value: ['Mechanics', entry.category], sources: [source] } }, sources: [source] }
  return [entry.id, entity]
}))
const entries = new Map(facts.entries.map(entry => [entry.id, entry]))

export function nativeMechanicDefinitions(): Readonly<Record<string, CatalogEntity>> {
  if (!sourceMatches) throw new Error('Native mechanic evidence does not match the game source')
  return definitions
}

export function nativeMechanic(entity: CatalogEntity | PersonalDefinition): NativeMechanic | undefined {
  const entry = entries.get(entity.id)
  if (!sourceMatches || 'revision' in entity || !entry || !sameValue(entity, definitions[entity.id])) return undefined
  return { description: entry.description, scope, evidence: entry.evidence, ...('calculationLinks' in entry ? { calculationLinks: entry.calculationLinks } : {}) }
}
