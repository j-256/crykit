import { describe, expect, it } from 'vitest'
import { mergeDocument } from './merge'
import type { JsonValue } from '../domain/types'
import { memoryBlob } from './blobs'
import type { WorkspaceDocument } from './documents'
const document = (kind: WorkspaceDocument['kind'], value: JsonValue, key = JSON.stringify([kind, 'unit'])): WorkspaceDocument => ({ version: 1, kind, key, value })
describe('typed three-way decisions', () => {
  it('unchangedSideConvergesWithoutChangingOriginalRecords', () => {
    const base = document('build', { id: 'unit', title: 'Original' })
    const local = document('build', { id: 'unit', title: 'Changed' })
    expect(mergeDocument(base, local, base)).toEqual({ kind: 'merged', document: local })
    expect(mergeDocument(base, base, local)).toEqual({ kind: 'merged', document: local })
  })
  it('inventoryEventsConflictDespiteMatchingFinalQuantity', async () => {
    const { createTestLocalData } = await import('../domain/test-helpers')
    const { createPersonalDefinition } = await import('../domain/local-data')
    const { observeInventory, recordInventoryEvent } = await import('../domain/inventory')
    const { NativeLocalDataSchema } = await import('../interchange/native-schema')
    const definitionId = 'item' as import('../domain/types').PersonalDefinitionId
    const initial = createPersonalDefinition(createTestLocalData(), { id: definitionId, kind: 'item', name: 'Observed item' })
    const ref = { kind: 'personal' as const, definitionId }
    const observed = observeInventory(initial, { ref, possession: 'owned', quantity: { kind: 'exact', value: 5 } })
    const left = recordInventoryEvent(observed, { ref, id: 'event-a' as import('../domain/types').InventoryEventId, kind: 'acquired', quantity: { state: 'known', value: 5 } })
    const right = recordInventoryEvent(observed, { ref, id: 'event-b' as import('../domain/types').InventoryEventId, kind: 'acquired', quantity: { state: 'unknown', reason: 'Not recorded' } })
    const unit = (data: typeof initial) => {
      NativeLocalDataSchema.parse(data)
      const play = data.playthroughs[data.selectedPlaythroughId!]
      return document('inventory', { inventory: play.inventory, inventoryEvents: play.inventoryEvents } as unknown as JsonValue, JSON.stringify(['inventory', play.id]))
    }
    expect(left.playthroughs[left.selectedPlaythroughId!].inventory).toEqual(right.playthroughs[right.selectedPlaythroughId!].inventory)
    expect(mergeDocument(unit(observed), unit(left), unit(right))).toEqual({ kind: 'conflict' })
    expect(right.playthroughs[right.selectedPlaythroughId!].inventoryEvents['event-b'].quantity).toEqual({ state: 'unknown', reason: 'Not recorded' })
  })
  it('independentDirectoryKeysConvergeAndCompetingAllocationsConflict', () => {
    const base = document('directory', { version: 1, kind: 'directory', shard: 1, entries: [], children: [] })
    const local = document('directory', { version: 1, kind: 'directory', shard: 1, entries: [{ key: 'a', documentId: 'A' }], children: [] })
    const remote = document('directory', { version: 1, kind: 'directory', shard: 1, entries: [{ key: 'b', documentId: 'B' }], children: [] })
    const result = mergeDocument(base, local, remote)
    expect(result.kind).toBe('merged')
    if (result.kind === 'merged') expect(result.document.value).toEqual({ version: 1, kind: 'directory', shard: 1, entries: [{ key: 'a', documentId: 'A' }, { key: 'b', documentId: 'B' }], children: [] })
    expect(mergeDocument(base, local, document('directory', { version: 1, kind: 'directory', shard: 1, entries: [{ key: 'a', documentId: 'Other' }], children: [] })).kind).toBe('conflict')
  })
  it('sameBuildAndEditDeleteNeedAnExplicitChoice', () => {
    const base = document('build', { title: 'Base' })
    const local = document('build', { title: 'This' })
    expect(mergeDocument(base, local, document('build', { title: 'Other' })).kind).toBe('conflict')
    expect(mergeDocument(base, local, document('tombstone', { version: 1, kind: 'tombstone', privateKey: base.key }, base.key)).kind).toBe('conflict')
  })
  it('playthroughBookkeepingAloneDoesNotCreateAConflict', () => {
    const base = document('playthrough', { metadata: { id: 'unit', name: 'Before', revision: 0, updatedAt: 'one' }, optional: {} })
    const local = document('playthrough', { metadata: { id: 'unit', name: 'Before', revision: 8, updatedAt: 'two' }, optional: {} })
    const remote = document('playthrough', { metadata: { id: 'unit', name: 'Renamed', revision: 1, updatedAt: 'three' }, optional: {} })
    expect(mergeDocument(base, local, remote)).toEqual({ kind: 'merged', document: remote })
  })
  it('unreadBinaryCannotClaimEqualityFromClonabilityOrLength', () => {
    const base: WorkspaceDocument = { version: 1, kind: 'blob', key: '["blob","opaque"]', value: memoryBlob(new Uint8Array([1])) }
    expect(mergeDocument(base, { ...base, value: memoryBlob(new Uint8Array([2])) }, { ...base, value: memoryBlob(new Uint8Array([3])) }).kind).toBe('conflict')
  })
})
