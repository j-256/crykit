import { expect, it } from 'vitest'
import * as identity from './identity'

it('hashes the exact domain and ordered membership using independent fixed vectors', async () => {
  expect(identity).toHaveProperty('inheritedSnapshotSetDigest')
  const digest = identity.inheritedSnapshotSetDigest
  expect(await digest([])).toBe('b31b613c1f568466840704190d9a418278ba187123148b5c31c8d0d979840297')
  expect(await digest(['00'.repeat(32)])).toBe('2b3a50dc2c059840aaaad30a413c0a5a90400664c2ce39b6e0b68b27b2c3d4f8')
  expect(await digest(['00'.repeat(32), 'ff'.repeat(32)])).toBe('d979439acf68b8c91e1838f87890bfdc38dd440ca083a6bde8a1e790dd4a9c4a')
})
it('rejects invalid membership without sorting or silently deduplicating', async () => {
  expect(identity).toHaveProperty('inheritedSnapshotSetDigest')
  for (const ids of [['FF'.repeat(32)], ['a'.repeat(63)], ['g'.repeat(64)], ['0'.repeat(64), '0'.repeat(64)], ['f'.repeat(64), '0'.repeat(64)]]) await expect(identity.inheritedSnapshotSetDigest(ids)).rejects.toThrow()
  const broken = { *[Symbol.iterator]() { yield '0'.repeat(64); throw new Error('iteration failed') } }
  await expect(identity.inheritedSnapshotSetDigest(broken)).rejects.toThrow('iteration failed')
})
