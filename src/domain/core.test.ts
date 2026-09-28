import { describe, expect, it } from 'vitest'

import {
  asId,
  asTimestamp,
  addRulesetRevision,
  createBlankProfile,
  createPersonalDefinition,
  entityDefinitionKey,
  entityRefKey,
  normalizePossessionQuantity,
} from './index'
import { TEST_NOW } from './test-helpers'
import type { CatalogId, CatalogRevisionId, EntityId, ProfileId } from './types'
import type { SlotId } from './types'

function catalogRef(catalogId: string, revisionId: string, entityId: string) {
  return {
    kind: 'catalog' as const,
    catalogId: asId<CatalogId>(catalogId),
    catalogRevisionId: asId<CatalogRevisionId>(revisionId),
    entityId: asId<EntityId>(entityId),
  }
}

describe('domain identity and bounds', () => {
  it('encodes identity components without delimiter collisions', () => {
    const first = catalogRef('source:branch', 'revision', 'entity')
    const second = catalogRef('source', 'revision', 'branch:entity')

    expect(entityRefKey(first)).not.toBe(entityRefKey(second))
  })

  it('uses stable entity identity for stock and versioned identity for definitions', () => {
    const first = catalogRef('source', 'revision-1', 'entity')
    const second = catalogRef('source', 'revision-2', 'entity')

    expect(entityRefKey(first)).toBe(entityRefKey(second))
    expect(entityDefinitionKey(first)).not.toBe(entityDefinitionKey(second))
  })

  it('rejects unsafe integer quantities', () => {
    expect(() =>
      normalizePossessionQuantity('owned', { kind: 'exact', value: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
  })

  it('accepts valid observation dates and UTC timestamps without normalizing them', () => {
    expect(asTimestamp('2026-02-28')).toBe('2026-02-28')
    expect(asTimestamp('2026-01-02T03:04:05Z')).toBe('2026-01-02T03:04:05Z')
    expect(asTimestamp('2026-01-02T03:04:05.1Z')).toBe('2026-01-02T03:04:05.1Z')
  })

  it('rejects normalized calendar dates, offsets, and loose date strings', () => {
    expect(() => asTimestamp('2025-02-30')).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    expect(() => asTimestamp('2025-02-30T00:00:00.000Z')).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    expect(() => asTimestamp('2026-01-02T03:04:05+00:00')).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    expect(() => asTimestamp('January 2, 2026')).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
  })

  it('rejects IDs with control characters or native-incompatible lengths', () => {
    expect(() => asId('line\nbreak')).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    expect(() => asId('x'.repeat(1_025))).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
  })

  it('does not raise an observed ownership bound from protected policy', () => {
    expect(normalizePossessionQuantity('owned', { kind: 'unknown' }, 4)).toEqual({
      possession: 'owned',
      quantity: { kind: 'atLeast', value: 1 },
      protectedQuantity: 4,
    })
  })

  it('keeps the profile change journal bounded', () => {
    let profile = createBlankProfile({ id: asId<ProfileId>('profile'), now: TEST_NOW })
    for (let index = 0; index < 210; index += 1) {
      profile = createPersonalDefinition(profile, {
        id: asId(`definition-${index}`),
        kind: 'other',
        name: `Definition ${index}`,
        now: TEST_NOW,
      })
    }

    expect(profile.changes.length).toBeLessThan(profile.revision)
    expect(profile.changes.at(-1)?.nextRevision).toBe(profile.revision)
  })

  it('rejects duplicate slot identities before saving a ruleset', () => {
    const profile = createBlankProfile({ id: asId<ProfileId>('profile'), now: TEST_NOW })
    const slotId = asId<SlotId>('slot')
    expect(() => addRulesetRevision(profile, {
      label: 'Invalid slots',
      slots: [
        { id: slotId, kind: 'equipment', label: 'First', order: 0, provenance: 'userDefined', sources: [] },
        { id: slotId, kind: 'passive', label: 'Second', order: 1, provenance: 'userDefined', sources: [] },
      ],
      now: TEST_NOW,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
  })

  it('rejects an invalid ruleset PP limit', () => {
    const profile = createBlankProfile({ id: asId<ProfileId>('profile'), now: TEST_NOW })
    expect(() => addRulesetRevision(profile, { label: 'Invalid PP limit', ppLimit: { state: 'known', value: -1 }, now: TEST_NOW })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
  })

  it('rejects personal numeric fields that native backup cannot preserve', () => {
    const profile = createBlankProfile({ id: asId<ProfileId>('profile'), now: TEST_NOW })
    expect(() => createPersonalDefinition(profile, {
      kind: 'item',
      name: 'Invalid occupancy',
      occupiesSlots: { state: 'known', value: 0 },
      now: TEST_NOW,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    expect(() => createPersonalDefinition(profile, {
      kind: 'passive',
      name: 'Invalid PP',
      ppCost: { state: 'known', value: Number.NaN },
      now: TEST_NOW,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
  })
})
