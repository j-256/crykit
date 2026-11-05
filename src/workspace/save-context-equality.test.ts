import { expect, it } from 'vitest'
import { jsonEqual } from '../persistence/local-data'
import type { JsonValue } from '../domain/types'
import { SavePendingSchema, parseSavePending } from './save-pending'
import { emptySavePending } from './save-input-controller'
import { saveContextsEqual } from './save-context-equality'

it('preserves canonical equality for admitted nested contexts, signed zero and reordered keys', () => {
  const values: (JsonValue | undefined)[] = [undefined, null, true, false, 0, -0, 1, '0', '', [], [null], [1, 2], [2, 1], {}, { a: 1, b: null }, { b: null, a: 1 }, { a: 1 }, { a: '1', b: null }, { values: [0, { revision: 'exact', id: 'native' }] }, { values: [-0, { id: 'native', revision: 'exact' }] }, { values: [0, { revision: 'changed', id: 'native' }] }, JSON.parse('{"__proto__":{"revision":"exact"},"constructor":null}')]
  const admitted = values.map(context => SavePendingSchema.parse({ ...emptySavePending(), ...(context === undefined ? {} : { context }) }).context)
  for (const left of admitted) for (const right of admitted) expect(saveContextsEqual(left, right)).toBe(jsonEqual(left, right))
})

it('leaves non-JSON contexts outside the admitted input fast path', () => {
  for (const context of [new Array(1), [undefined], Infinity, new Date(0)]) {
    const value = { ...emptySavePending(), context } as unknown as JsonValue
    expect(parseSavePending(value)).toEqual({ kind: 'unsupported', value })
  }
})

it('retains canonical ordering when distinct Unicode keys collate equally', () => {
  const left = { '\u00e9': 'composed', 'e\u0301': 'decomposed' }
  const right = { 'e\u0301': 'decomposed', '\u00e9': 'composed' }
  expect(saveContextsEqual(left, right)).toBe(jsonEqual(left, right))
})
