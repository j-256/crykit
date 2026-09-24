import { describe, expect, it } from 'vitest'

import { evaluateQuery, partitionQuery } from './query'
import type { QueryNode, QueryRecord } from './types'

describe('three-valued query evaluation', () => {
  it('does not treat a missing numeric value as zero', () => {
    const query: QueryNode = { kind: 'predicate', field: 'power', operator: 'gt', value: 0 }
    const record: QueryRecord = { power: { state: 'unknown', reason: 'not recorded' } }

    expect(evaluateQuery(query, record)).toBe('unknown')
  })

  it('keeps NOT unknown unknown', () => {
    const query: QueryNode = {
      kind: 'not',
      child: { kind: 'predicate', field: 'counter', operator: 'eq', value: true },
    }

    expect(evaluateQuery(query, { counter: { state: 'unknown' } })).toBe('unknown')
  })

  it('uses OR for alternatives and AND across facets without erasing unknowns', () => {
    const query: QueryNode = {
      kind: 'and',
      children: [
        {
          kind: 'or',
          children: [
            { kind: 'predicate', field: 'kind', operator: 'eq', value: 'shield' },
            { kind: 'predicate', field: 'kind', operator: 'eq', value: 'armor' },
          ],
        },
        { kind: 'predicate', field: 'owned', operator: 'eq', value: true },
      ],
    }

    expect(
      evaluateQuery(query, {
        kind: { state: 'known', value: 'armor' },
        owned: { state: 'known', value: true },
      }),
    ).toBe('true')
    expect(
      evaluateQuery(query, {
        kind: { state: 'known', value: 'weapon' },
        owned: { state: 'unknown' },
      }),
    ).toBe('false')
    expect(
      evaluateQuery(query, {
        kind: { state: 'known', value: 'shield' },
        owned: { state: 'unknown' },
      }),
    ).toBe('unknown')
  })

  it('partitions confirmed, possible, and excluded matches', () => {
    const items = [
      { name: 'known', value: { state: 'known', value: 2 } as const },
      { name: 'possible', value: { state: 'unknown' } as const },
      { name: 'excluded', value: { state: 'known', value: -1 } as const },
    ]
    const result = partitionQuery(
      items,
      { kind: 'predicate', field: 'value', operator: 'gt', value: 0 },
      (item) => ({ value: item.value }),
    )

    expect(result.confirmed.map((item) => item.name)).toEqual(['known'])
    expect(result.possible.map((item) => item.name)).toEqual(['possible'])
    expect(result.excluded.map((item) => item.name)).toEqual(['excluded'])
  })
})
