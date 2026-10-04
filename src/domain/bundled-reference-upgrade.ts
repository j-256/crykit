import { DomainError } from './core'
import { logicalEntityKey } from './definitions'
import type { CatalogSnapshot, EntityId, EntityRef, LocalData } from './types'

const OPAQUE_FIELDS = new Set(['fields', 'legacy', 'sources', 'changes'])

export function upgradeBundledReferences(data: LocalData, catalog: CatalogSnapshot, sourceIds: ReadonlyMap<string, EntityId>): LocalData {
  const target = (id: string) => sourceIds.get(id) ?? id
  const walk = (value: unknown): unknown => {
    if (!value || typeof value !== 'object') return value
    if (Array.isArray(value)) {
      const next = value.map(walk)
      return next.some((entry, index) => entry !== value[index]) ? next : value
    }
    const record = value as Readonly<Record<string, unknown>>
    if (record.kind === 'catalog' && record.catalogId === catalog.id && record.catalogRevisionId === catalog.revisionId && typeof record.entityId === 'string') {
      const entityId = target(record.entityId)
      return entityId === record.entityId ? value : { ...record, entityId }
    }
    const entries = Object.entries(record).map(([key, entry]) => [key, OPAQUE_FIELDS.has(key) ? entry : walk(entry)] as const)
    return entries.some(([key, entry]) => entry !== record[key]) ? Object.fromEntries(entries) : value
  }
  let next = walk(data) as LocalData
  for (const [id, setup] of Object.entries(next.gameSetups)) {
    const composition = setup.modComposition
    if (!composition || composition.baseline.catalogId !== catalog.id || composition.baseline.catalogRevisionId !== catalog.revisionId) continue
    const links = composition.links.map(link => link.targetEntityId && target(link.targetEntityId) !== link.targetEntityId ? { ...link, targetEntityId: target(link.targetEntityId) as EntityId } : link)
    if (links.some((link, index) => link !== composition.links[index])) next = { ...next, gameSetups: { ...next.gameSetups, [id]: { ...setup, modComposition: { ...composition, links } } } }
  }
  const rekey = <Value,>(entries: Readonly<Record<string, Value>>, ref: (value: Value) => EntityRef): Readonly<Record<string, Value>> => {
    const result: Record<string, Value> = {}
    let changed = false
    for (const [key, value] of Object.entries(entries)) {
      const nextKey = logicalEntityKey(next, ref(value))
      if (Object.hasOwn(result, nextKey)) throw new DomainError('INVALID_INPUT', 'The catalog reference upgrade would merge distinct character records')
      result[nextKey] = value
      if (key !== nextKey) changed = true
    }
    return changed ? result : entries
  }
  for (const [playthroughId, playthrough] of Object.entries(next.playthroughs)) {
    for (const [characterId, character] of Object.entries(playthrough.characters)) {
      const classProgress = rekey(character.classProgress, entry => entry.classRef)
      const learnedNodes = rekey(character.learnedNodes, entry => entry.ref)
      if (classProgress === character.classProgress && learnedNodes === character.learnedNodes) continue
      const current = next.playthroughs[playthroughId]!
      next = { ...next, playthroughs: { ...next.playthroughs, [playthroughId]: { ...current, characters: { ...current.characters, [characterId]: { ...character, classProgress, learnedNodes } } } } }
    }
  }
  return next
}
