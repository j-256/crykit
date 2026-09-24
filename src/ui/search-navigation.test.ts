import { describe, expect, it } from 'vitest'
import { MAX_ID_LENGTH } from '../domain'
import type { EntityRef } from '../domain/types'
import { destinationForSearchTarget, formatSearchDestination, parseUniversalSearchTarget, type UniversalSearchTarget } from './search-navigation'

describe('universal search navigation', () => {
  it('round-trips exact catalog definition refs', () => {
    const ref = { kind: 'catalog', catalogId: 'catalog', catalogRevisionId: 'r1', entityId: 'entity' } as EntityRef
    const target: UniversalSearchTarget = { kind: 'definition', ref }
    const hash = formatSearchDestination(destinationForSearchTarget(target), target)
    expect(parseUniversalSearchTarget(hash)).toEqual(target)
  })

  it('round-trips planner record targets', () => {
    const target = { kind: 'scenario', scenarioId: 'scenario-1' } as UniversalSearchTarget
    expect(parseUniversalSearchTarget(formatSearchDestination('builds', target))).toEqual(target)
  })

  it('rejects malformed, mismatched, and oversized targets', () => {
    expect(parseUniversalSearchTarget('#/characters?target=%7Bbad')).toBeUndefined()
    expect(parseUniversalSearchTarget(`#/inventory?target=${encodeURIComponent(JSON.stringify({ kind: 'inventory', positionId: 'x'.repeat(MAX_ID_LENGTH + 1) }))}`)).toBeUndefined()
    expect(parseUniversalSearchTarget(`#/builds?target=${encodeURIComponent(JSON.stringify({ kind: 'build', buildId: 'bad\nvalue' }))}`)).toBeUndefined()
    expect(() => formatSearchDestination('builds', { kind: 'build', buildId: 'bad\nvalue' } as UniversalSearchTarget)).toThrow()
    expect(() => formatSearchDestination('inventory', { kind: 'character', characterId: 'c1' } as UniversalSearchTarget)).toThrow()
  })
})
