import { buildModReferences } from './build-references'
import { DomainError, entityDefinitionKey } from './core'
import { definitionLineageRootRef } from './definitions'
import type { BuildRevisionContent, CatalogRevisionId, EntityRef, GameSetupRevision, LocalData, SlotId } from './types'

// These receipts preserve selected identities outside a checkpoint's context without granting mechanics
export function retainedSelectionRefs(content: BuildRevisionContent): ReadonlySet<string> {
  return new Set(content.retainedSelections?.refs.map(entityDefinitionKey) ?? [])
}

export function retainOutOfContextSelections<Content extends BuildRevisionContent>(localData: LocalData, content: Content, setup: Pick<GameSetupRevision, 'slots'>, lock: Readonly<Record<string, CatalogRevisionId>>): Content {
  const refs = [...new Map(buildModReferences(content).filter(ref => {
    const root = definitionLineageRootRef(localData, ref)
    return root.kind === 'catalog' && lock[root.catalogId] !== root.catalogRevisionId
  }).map(ref => [entityDefinitionKey(ref), ref])).values()]
  const slotIds = Object.entries(content.equipment).filter(([id, selection]) => selection && !setup.slots.some(slot => slot.id === id)).map(([id]) => id as SlotId)
  const { retainedSelections: _previous, ...rest } = content
  return { ...rest, ...(refs.length || slotIds.length ? { retainedSelections: { refs, slotIds } } : {}) } as Content
}

export function assertRetainedSelections(localData: LocalData, content: BuildRevisionContent, setup: Pick<GameSetupRevision, 'slots'>, lock: Readonly<Record<string, CatalogRevisionId>>): void {
  const retained = content.retainedSelections
  if (!retained) return
  const expected = retainOutOfContextSelections(localData, content, setup, lock).retainedSelections
  const keys = retained.refs.map(entityDefinitionKey)
  const expectedKeys = new Set(expected?.refs.map(entityDefinitionKey) ?? [])
  const expectedSlots = new Set(expected?.slotIds ?? [])
  if (!expected || new Set(keys).size !== keys.length || keys.length !== expectedKeys.size || keys.some(key => !expectedKeys.has(key)) || new Set(retained.slotIds).size !== retained.slotIds.length || retained.slotIds.length !== expectedSlots.size || retained.slotIds.some(id => !expectedSlots.has(id))) throw new DomainError('INVALID_INPUT', 'Retained selections must exactly identify selected references and occupied slots outside this checkpoint context')
}

export function withoutRetainedMechanics<Definition>(content: BuildRevisionContent, resolve: (ref: EntityRef) => Definition | undefined): (ref: EntityRef) => Definition | undefined {
  const retained = retainedSelectionRefs(content)
  return ref => retained.has(entityDefinitionKey(ref)) ? undefined : resolve(ref)
}
