import { expect, it } from 'vitest'
import { assertBytePagesEqual } from './byte-pages.test-helpers'

function fixture() {
  const backing = Uint8Array.from([99, 0, 1, 2, 3, 4, 5, 6, 7, 88])
  return [backing.subarray(1, 5), backing.subarray(5, 9)]
}

it('compares exact page views independently of backing offsets and outside bytes', () => {
  const actual = fixture(), expected = actual.map(page => page.slice())
  expect(() => assertBytePagesEqual(actual, expected)).not.toThrow()
  expect(() => assertBytePagesEqual([], [])).not.toThrow()
  expect(() => assertBytePagesEqual([new Uint8Array()], [new Uint8Array()])).not.toThrow()
  expect([...new Uint8Array(actual[0].buffer)]).toEqual([99, 0, 1, 2, 3, 4, 5, 6, 7, 88])
})

it.each([
  { page: 0, offset: 0, before: 0 },
  { page: 0, offset: 2, before: 2 },
  { page: 0, offset: 3, before: 3 },
  { page: 1, offset: 0, before: 4 },
  { page: 1, offset: 3, before: 7 },
])('rejects the exact changed byte at page $page offset $offset', ({ page, offset, before }) => {
  const actual = fixture(), expected = actual.map(page => page.slice())
  actual[page][offset] ^= 1
  expect(() => assertBytePagesEqual(actual, expected)).toThrow(`Byte page ${page} offset ${offset}: ${before ^ 1} !== ${before}`)
})

it('rejects missing, extra, reordered, or regrouped pages and changed lengths', () => {
  const expected = fixture()
  expect(() => assertBytePagesEqual(expected.slice(1), expected)).toThrow('Byte page count: 1 !== 2')
  expect(() => assertBytePagesEqual([...expected, new Uint8Array()], expected)).toThrow('Byte page count: 3 !== 2')
  expect(() => assertBytePagesEqual([...expected].reverse(), expected)).toThrow('Byte page 0 offset 0: 4 !== 0')
  expect(() => assertBytePagesEqual([Uint8Array.from([0, 1, 2]), Uint8Array.from([3, 4, 5, 6, 7])], expected)).toThrow('Byte page 0 length: 3 !== 4')
  expect(() => assertBytePagesEqual([expected[0], expected[1].subarray(0, 3)], expected)).toThrow('Byte page 1 length: 3 !== 4')
})
